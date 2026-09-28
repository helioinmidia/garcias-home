#!/usr/bin/env python3
"""
API da Rotina da Ana Liz. Só biblioteca padrão.

Guarda, por dia, o que foi feito e os comentários de cada atividade. A definição da rotina (horários,
atividades, agendas, exceções) fica em casa/rotina/rotina.json, servida como arquivo estático; esta API
guarda o estado e, para o Home Assistant, resume o dia de hoje lendo o mesmo rotina.json.

  GET /dia/AAAA-MM-DD                  -> {"data", "tarefas": {id: {feito, feitoEm, comentario, comentadoEm}},
                                            "agenda" (só se alguém trocou a agenda do dia na tela),
                                            "revisao", "atualizadoEm"}  (revisao sobe a cada gravação)
  GET /dias?de=AAAA-MM-DD&ate=AAAA-MM-DD -> {"dias": {data: dia}} para cada dia do intervalo (até 31 dias);
                                            é o que a faixa da semana usa, numa só leitura
  PUT /dia/AAAA-MM-DD/tarefa/<id>      <- {"feito": bool} e/ou {"comentario": "texto"}; devolve o dia inteiro
  PUT /dia/AAAA-MM-DD/agenda           <- {"agenda": "folga"} troca a agenda desse dia; {"agenda": null} volta
                                            ao normal (dia da semana ou exceção do rotina.json)
  GET /resumo[?data=AAAA-MM-DD]        -> o dia resumido para o Home Assistant: agenda, total, feitas, pct,
                                            atual, proxima, atrasadas (começaram e não foram feitas), completo
  GET /saude                           -> {"ok": true}

O Caddy publica em casa.blizzard.net/rotina/api/* (tira o prefixo antes de repassar).
Variáveis: DADOS_DIR (padrão ./dados/rotina), ROTINA_JSON (padrão ./casa/rotina/rotina.json),
PORT (8081), BIND (127.0.0.1).
"""
import datetime
import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DADOS_DIR = os.environ.get("DADOS_DIR") or os.path.join(RAIZ, "dados", "rotina")
ROTINA_JSON = os.environ.get("ROTINA_JSON") or os.path.join(RAIZ, "casa", "rotina", "rotina.json")
PORT = int(os.environ.get("PORT", "8081"))
BIND = os.environ.get("BIND", "127.0.0.1")
MAX_BODY = 16 * 1024
MAX_COMENTARIO = 2000
MAX_DIAS = 31

ROTA_DIA = re.compile(r"^/dia/(\d{4}-\d{2}-\d{2})$")
ROTA_TAREFA = re.compile(r"^/dia/(\d{4}-\d{2}-\d{2})/tarefa/([a-z0-9][a-z0-9-]{0,63})$")
ROTA_AGENDA = re.compile(r"^/dia/(\d{4}-\d{2}-\d{2})/agenda$")
ID_AGENDA = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

# Um PUT lê, altera e grava o arquivo do dia; a trava evita que dois aparelhos se atropelem.
trava = threading.Lock()


class ErroPedido(ValueError):
    pass


def agora():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def valida_data(texto):
    if not texto or not re.match(r"^\d{4}-\d{2}-\d{2}$", texto):
        raise ErroPedido(f"data inválida: {texto!r}")
    try:
        datetime.date.fromisoformat(texto)
    except ValueError:
        raise ErroPedido(f"data inválida: {texto}")
    return texto


def datas_entre(de, ate):
    """Lista de AAAA-MM-DD de `de` até `ate`, inclusive; no máximo MAX_DIAS."""
    d0, d1 = datetime.date.fromisoformat(de), datetime.date.fromisoformat(ate)
    if d1 < d0:
        raise ErroPedido('"ate" vem antes de "de"')
    if (d1 - d0).days >= MAX_DIAS:
        raise ErroPedido(f"intervalo de no máximo {MAX_DIAS} dias")
    return [(d0 + datetime.timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]


# ---------- estado por dia ----------
def caminho(data):
    return os.path.join(DADOS_DIR, f"{data}.json")


def dia_vazio(data):
    return {"data": data, "tarefas": {}, "revisao": 0, "atualizadoEm": None}


def le_dia(data):
    try:
        with open(caminho(data), encoding="utf-8") as fh:
            dia = json.load(fh)
    except FileNotFoundError:
        return dia_vazio(data)
    except (OSError, ValueError) as e:
        # Arquivo ilegível ou corrompido: não derruba a tela; a próxima gravação o substitui.
        print(f"aviso: {caminho(data)} ilegível ({e}); tratando como vazio", file=sys.stderr)
        return dia_vazio(data)
    if not isinstance(dia, dict) or not isinstance(dia.get("tarefas"), dict):
        dia = dia_vazio(data)
    if not isinstance(dia.get("revisao"), int):
        dia["revisao"] = 0
    if not isinstance(dia.get("agenda"), str):
        dia.pop("agenda", None)
    dia["data"] = data
    return dia


def grava_dia(dia):
    os.makedirs(DADOS_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".rotina-", suffix=".json", dir=DADOS_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(dia, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, caminho(dia["data"]))
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def altera_tarefa(data, tarefa_id, pedido):
    if not isinstance(pedido, dict) or not ({"feito", "comentario"} & pedido.keys()):
        raise ErroPedido('envie "feito" e/ou "comentario"')
    if "feito" in pedido and not isinstance(pedido["feito"], bool):
        raise ErroPedido('"feito" deve ser true ou false')
    if "comentario" in pedido:
        if not isinstance(pedido["comentario"], str):
            raise ErroPedido('"comentario" deve ser texto')
        if len(pedido["comentario"]) > MAX_COMENTARIO:
            raise ErroPedido(f"comentário com mais de {MAX_COMENTARIO} caracteres")
    with trava:
        dia = le_dia(data)
        tarefa = dia["tarefas"].setdefault(tarefa_id, {})
        momento = agora()
        if "feito" in pedido:
            tarefa["feito"] = pedido["feito"]
            tarefa["feitoEm"] = momento if pedido["feito"] else None
        if "comentario" in pedido:
            texto = pedido["comentario"].strip()
            tarefa["comentario"] = texto
            tarefa["comentadoEm"] = momento if texto else None
        if not tarefa.get("feito") and not tarefa.get("comentario"):
            del dia["tarefas"][tarefa_id]
        dia["revisao"] += 1
        dia["atualizadoEm"] = momento
        grava_dia(dia)
        return dia


def altera_agenda(data, pedido):
    if not isinstance(pedido, dict) or "agenda" not in pedido:
        raise ErroPedido('envie {"agenda": "<id>"} ou {"agenda": null}')
    agenda = pedido["agenda"]
    if agenda is not None:
        if not isinstance(agenda, str) or not ID_AGENDA.match(agenda):
            raise ErroPedido("id de agenda inválido")
        rotina = le_rotina()
        if rotina and agenda not in {a.get("id") for a in rotina.get("agendas", [])}:
            raise ErroPedido(f'agenda "{agenda}" não existe no rotina.json')
    with trava:
        dia = le_dia(data)
        if agenda is None:
            dia.pop("agenda", None)
        else:
            dia["agenda"] = agenda
        dia["revisao"] += 1
        dia["atualizadoEm"] = agora()
        grava_dia(dia)
        return dia


# ---------- rotina.json e resumo do dia ----------
_rotina_cache = {"mtime": None, "dados": None}


def le_rotina():
    """rotina.json, relido quando o arquivo muda. None se não existir ou estiver inválido."""
    try:
        mtime = os.stat(ROTINA_JSON).st_mtime_ns
        if _rotina_cache["mtime"] != mtime:
            with open(ROTINA_JSON, encoding="utf-8") as fh:
                _rotina_cache["dados"] = json.load(fh)
            _rotina_cache["mtime"] = mtime
    except (OSError, ValueError) as e:
        print(f"aviso: {ROTINA_JSON} ilegível ({e})", file=sys.stderr)
        return _rotina_cache["dados"]
    return _rotina_cache["dados"]


def agenda_do_dia(rotina, data, dia):
    """Mesma regra do app.js: agenda trocada na tela > exceção do rotina.json > dia da semana."""
    agendas = {a.get("id"): a for a in rotina.get("agendas", [])}
    if dia.get("agenda") in agendas:
        return agendas[dia["agenda"]], "tela"
    for exc in rotina.get("excecoes", []) or []:
        if exc.get("de", "") <= data <= exc.get("ate", exc.get("de", "")) and exc.get("agenda") in agendas:
            return agendas[exc["agenda"]], exc.get("motivo") or "exceção"
    dow = (datetime.date.fromisoformat(data).weekday() + 1) % 7  # 0 = domingo, como no JavaScript
    for a in rotina.get("agendas", []):
        if dow in (a.get("diasDaSemana") or []):
            return a, "semana"
    return None, None


def minutos(hhmm):
    try:
        h, m = hhmm.split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def tarefas_do_dia(rotina, data, dia):
    agenda, origem = agenda_do_dia(rotina, data, dia)
    if not agenda:
        return None, origem, []
    dow = str((datetime.date.fromisoformat(data).weekday() + 1) % 7)
    lista = []
    for bloco in agenda.get("blocos", []):
        for t in bloco.get("tarefas", []):
            if t.get("diasDaSemana") and int(dow) not in t["diasDaSemana"]:
                continue
            hora = (t.get("horaPorDia") or {}).get(dow) or t.get("hora")
            lista.append({"id": t.get("id"), "titulo": t.get("titulo"), "hora": hora, "bloco": bloco.get("titulo"),
                          "duracao": t.get("duracao"), "minutos": minutos(hora)})
    lista.sort(key=lambda t: (t["minutos"] is None, t["minutos"] or 0))
    return agenda, origem, lista


def resumo(data):
    rotina = le_rotina()
    if not rotina:
        raise ErroPedido("rotina.json indisponível para a API (ROTINA_JSON)")
    with trava:
        dia = le_dia(data)
    agenda, origem, lista = tarefas_do_dia(rotina, data, dia)
    feitos = {tid: t for tid, t in dia["tarefas"].items() if t.get("feito")}
    hoje = data == datetime.date.today().isoformat()
    agora_min = None
    if hoje:
        n = datetime.datetime.now()
        agora_min = n.hour * 60 + n.minute
    atual = proxima = None
    atrasadas = []
    for t in lista:
        t["feito"] = t["id"] in feitos
        if agora_min is None or t["minutos"] is None:
            continue
        if t["minutos"] <= agora_min:
            atual = t
            if not t["feito"]:
                atrasadas.append(t)
        elif proxima is None:
            proxima = t
    # A atividade em curso ainda não está atrasada: só as anteriores a ela.
    if atual and not atual["feito"] and atual in atrasadas:
        atrasadas.remove(atual)
    total = len(lista)
    n_feitas = sum(1 for t in lista if t["feito"])

    def curto(t):
        return None if not t else {"id": t["id"], "titulo": t["titulo"], "hora": t["hora"], "bloco": t["bloco"],
                                   "duracao": t["duracao"], "feito": t["feito"]}

    return {
        "data": data,
        "hoje": hoje,
        "agenda": agenda.get("id") if agenda else None,
        "agendaNome": (agenda.get("nome") or agenda.get("id")) if agenda else "Sem agenda",
        "agendaOrigem": origem,
        "total": total,
        "feitas": n_feitas,
        "pendentes": total - n_feitas,
        "pct": round(n_feitas * 100 / total) if total else 0,
        "completo": total > 0 and n_feitas == total,
        "atual": curto(atual),
        "proxima": curto(proxima),
        "atrasadas": len(atrasadas),
        "atrasadasLista": [t["titulo"] for t in atrasadas],
        "comentarios": sum(1 for t in dia["tarefas"].values() if t.get("comentario")),
        "revisao": dia["revisao"],
        "atualizadoEm": dia.get("atualizadoEm"),
        "geradoEm": agora(),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "casa-rotina/2"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _envia(self, codigo, corpo):
        dados = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(dados)

    def _erro(self, codigo, mensagem):
        self._envia(codigo, {"erro": mensagem})

    def _corpo(self):
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho <= 0 or tamanho > MAX_BODY:
            raise ErroPedido("corpo vazio ou grande demais")
        return json.loads(self.rfile.read(tamanho).decode("utf-8"))

    def do_GET(self):
        rota, _, consulta = self.path.partition("?")
        if rota == "/saude":
            return self._envia(200, {"ok": True})
        try:
            q = parse_qs(consulta)
            if rota == "/dias":
                de = valida_data((q.get("de") or [""])[0])
                ate = valida_data((q.get("ate") or [""])[0])
                with trava:
                    dias = {data: le_dia(data) for data in datas_entre(de, ate)}
                return self._envia(200, {"dias": dias})
            if rota == "/resumo":
                data = (q.get("data") or [datetime.date.today().isoformat()])[0]
                return self._envia(200, resumo(valida_data(data)))
            m = ROTA_DIA.match(rota)
            if not m:
                return self._erro(404, "rota inexistente")
            with trava:
                return self._envia(200, le_dia(valida_data(m.group(1))))
        except ErroPedido as e:
            return self._erro(400, str(e))

    def do_PUT(self):
        rota = self.path.split("?", 1)[0]
        try:
            m = ROTA_TAREFA.match(rota)
            if m:
                return self._envia(200, altera_tarefa(valida_data(m.group(1)), m.group(2), self._corpo()))
            m = ROTA_AGENDA.match(rota)
            if m:
                return self._envia(200, altera_agenda(valida_data(m.group(1)), self._corpo()))
            return self._erro(404, "rota inexistente")
        except (ErroPedido, json.JSONDecodeError, UnicodeDecodeError) as e:
            return self._erro(400, str(e))


def main():
    os.makedirs(DADOS_DIR, exist_ok=True)
    servidor = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"API da rotina em http://{BIND}:{PORT}, dados em {DADOS_DIR}, rotina em {ROTINA_JSON}", file=sys.stderr)
    servidor.serve_forever()


if __name__ == "__main__":
    main()
