#!/usr/bin/env python3
"""
API da Rotina da Ana Liz. Só biblioteca padrão.

Guarda, por dia, o que foi feito e os comentários de cada atividade. A definição da rotina (horários,
atividades) fica em casa/rotina/rotina.json, servida como arquivo estático; esta API só guarda o estado.

  GET /dia/AAAA-MM-DD                  -> {"data", "tarefas": {id: {feito, feitoEm, comentario, comentadoEm}},
                                            "revisao", "atualizadoEm"}  (revisao sobe a cada gravação)
  GET /dias?de=AAAA-MM-DD&ate=AAAA-MM-DD -> {"dias": {data: dia}} para cada dia do intervalo (até 31 dias);
                                            é o que a faixa da semana usa, numa só leitura
  PUT /dia/AAAA-MM-DD/tarefa/<id>      <- {"feito": bool} e/ou {"comentario": "texto"}; devolve o dia inteiro
  GET /saude                           -> {"ok": true}

O Caddy publica em casa.blizzard.net/rotina/api/* (tira o prefixo antes de repassar).
Variáveis: DADOS_DIR (padrão ./dados/rotina), PORT (8081), BIND (127.0.0.1).
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

DADOS_DIR = os.environ.get("DADOS_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dados", "rotina"
)
PORT = int(os.environ.get("PORT", "8081"))
BIND = os.environ.get("BIND", "127.0.0.1")
MAX_BODY = 16 * 1024
MAX_COMENTARIO = 2000
MAX_DIAS = 31

ROTA_DIA = re.compile(r"^/dia/(\d{4}-\d{2}-\d{2})$")
ROTA_TAREFA = re.compile(r"^/dia/(\d{4}-\d{2}-\d{2})/tarefa/([a-z0-9][a-z0-9-]{0,63})$")

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


def caminho(data):
    return os.path.join(DADOS_DIR, f"{data}.json")


def le_dia(data):
    try:
        with open(caminho(data), encoding="utf-8") as fh:
            dia = json.load(fh)
    except FileNotFoundError:
        return {"data": data, "tarefas": {}, "revisao": 0, "atualizadoEm": None}
    except (OSError, ValueError) as e:
        # Arquivo ilegível ou corrompido: não derruba a tela; a próxima gravação o substitui.
        print(f"aviso: {caminho(data)} ilegível ({e}); tratando como vazio", file=sys.stderr)
        return {"data": data, "tarefas": {}, "revisao": 0, "atualizadoEm": None}
    if not isinstance(dia, dict) or not isinstance(dia.get("tarefas"), dict):
        dia["tarefas"] = {}
    if not isinstance(dia.get("revisao"), int):
        dia["revisao"] = 0
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


class Handler(BaseHTTPRequestHandler):
    server_version = "casa-rotina/1"

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

    def do_GET(self):
        rota, _, consulta = self.path.partition("?")
        if rota == "/saude":
            return self._envia(200, {"ok": True})
        try:
            if rota == "/dias":
                q = parse_qs(consulta)
                de = valida_data((q.get("de") or [""])[0])
                ate = valida_data((q.get("ate") or [""])[0])
                with trava:
                    dias = {data: le_dia(data) for data in datas_entre(de, ate)}
                return self._envia(200, {"dias": dias})
            m = ROTA_DIA.match(rota)
            if not m:
                return self._erro(404, "rota inexistente")
            with trava:
                return self._envia(200, le_dia(valida_data(m.group(1))))
        except ErroPedido as e:
            return self._erro(400, str(e))

    def do_PUT(self):
        m = ROTA_TAREFA.match(self.path.split("?", 1)[0])
        if not m:
            return self._erro(404, "rota inexistente")
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho <= 0 or tamanho > MAX_BODY:
            return self._erro(413 if tamanho > MAX_BODY else 400, "corpo vazio ou grande demais")
        try:
            pedido = json.loads(self.rfile.read(tamanho).decode("utf-8"))
            return self._envia(200, altera_tarefa(valida_data(m.group(1)), m.group(2), pedido))
        except (ErroPedido, json.JSONDecodeError, UnicodeDecodeError) as e:
            return self._erro(400, str(e))


def main():
    os.makedirs(DADOS_DIR, exist_ok=True)
    servidor = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"API da rotina em http://{BIND}:{PORT}, dados em {DADOS_DIR}", file=sys.stderr)
    servidor.serve_forever()


if __name__ == "__main__":
    main()
