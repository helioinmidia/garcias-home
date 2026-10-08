#!/usr/bin/env python3
"""
API do Acompanhamento Médico da casa. Só biblioteca padrão.

Um arquivo por pessoa em DADOS_DIR (<id>.json) com medicamentos, exames, consultas, pendências, plano
alimentar, peso, proteína e as tomadas de cada dia. Na primeira vez, cada arquivo nasce de
api/saude-inicial/<id>.json; depois disso só a API grava (os dados ficam no Pi, fora do git).

  GET    /status                                   -> {"ok": true}
  GET    /pessoas                                  -> {"pessoas": [{id, nome}]}
  GET    /pessoa/<p>                               -> documento inteiro da pessoa (com "revisao")
  PUT    /pessoa/<p>/<colecao>/<item>              <- item (medicamentos, exames, consultas, pendencias)
  DELETE /pessoa/<p>/<colecao>/<item>
  PUT    /pessoa/<p>/tomada/AAAA-MM-DD/<med>       <- {"tomado": bool}
  PUT    /pessoa/<p>/peso/AAAA-MM-DD               <- {"kg": 82.4, "nota": "..."}
  DELETE /pessoa/<p>/peso/AAAA-MM-DD
  PUT    /pessoa/<p>/proteina/AAAA-MM-DD           <- {"g": 120}
  PUT    /pessoa/<p>/config/peso                   <- {ativo, dias, instrucoes, inicio, prazo, metaMinimaKg, metaIdealKg}
  PUT    /pessoa/<p>/config/proteina               <- {ativo, metaG}

Toda gravação devolve o documento inteiro da pessoa. O Caddy publica em casa.blizzard.net/saude/api/*.
Variáveis: DADOS_DIR (padrão ./dados/saude), INICIAL_DIR (padrão ./api/saude-inicial), PORT (8082), BIND.
"""
import datetime
import json
import os
import re
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AQUI = os.path.dirname(os.path.abspath(__file__))
DADOS_DIR = os.environ.get("DADOS_DIR") or os.path.join(os.path.dirname(AQUI), "dados", "saude")
INICIAL_DIR = os.environ.get("INICIAL_DIR") or os.path.join(AQUI, "saude-inicial")
PORT = int(os.environ.get("PORT", "8082"))
BIND = os.environ.get("BIND", "127.0.0.1")
MAX_BODY = 64 * 1024

ID = r"[a-z0-9][a-z0-9-]{0,63}"
DATA = r"\d{4}-\d{2}-\d{2}"
ROTA_PESSOA = re.compile(rf"^/pessoa/({ID})$")
ROTA_ITEM = re.compile(rf"^/pessoa/({ID})/(medicamentos|exames|consultas|pendencias)/({ID})$")
ROTA_TOMADA = re.compile(rf"^/pessoa/({ID})/tomada/({DATA})/({ID})$")
ROTA_PESO = re.compile(rf"^/pessoa/({ID})/peso/({DATA})$")
ROTA_PROTEINA = re.compile(rf"^/pessoa/({ID})/proteina/({DATA})$")
ROTA_CONFIG = re.compile(rf"^/pessoa/({ID})/config/(peso|proteina)$")
HORA = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

trava = threading.Lock()


class ErroPedido(ValueError):
    pass


class NaoEncontrado(LookupError):
    pass


def agora():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


# ---------- validação ----------
def texto(limite, obrigatorio=False):
    def v(nome, valor):
        if valor is None:
            valor = ""
        if not isinstance(valor, str):
            raise ErroPedido(f'"{nome}" deve ser texto')
        valor = valor.strip()
        if obrigatorio and not valor:
            raise ErroPedido(f'"{nome}" é obrigatório')
        if len(valor) > limite:
            raise ErroPedido(f'"{nome}" passa de {limite} caracteres')
        return valor
    return v


def data_ou_vazio(nome, valor):
    if valor in (None, ""):
        return ""
    if not isinstance(valor, str) or not re.match(rf"^{DATA}$", valor):
        raise ErroPedido(f'"{nome}" deve ser uma data AAAA-MM-DD')
    try:
        datetime.date.fromisoformat(valor)
    except ValueError:
        raise ErroPedido(f'"{nome}" não é uma data válida')
    return valor


def hora_ou_vazio(nome, valor):
    if valor in (None, ""):
        return ""
    if not isinstance(valor, str) or not HORA.match(valor):
        raise ErroPedido(f'"{nome}" deve ser HH:MM')
    return valor


def opcao(*validas):
    def v(nome, valor):
        if valor not in validas:
            raise ErroPedido(f'"{nome}" deve ser um de: {", ".join(validas)}')
        return valor
    return v


def booleano(nome, valor):
    if valor is None:
        return False
    if not isinstance(valor, bool):
        raise ErroPedido(f'"{nome}" deve ser true ou false')
    return valor


def dias_semana(nome, valor):
    if valor is None:
        return []
    if not isinstance(valor, list) or not all(isinstance(d, int) and 0 <= d <= 6 for d in valor):
        raise ErroPedido(f'"{nome}" deve ser uma lista de 0 (domingo) a 6 (sábado)')
    return sorted(set(valor))


def numero(minimo, maximo):
    def v(nome, valor):
        if isinstance(valor, bool) or not isinstance(valor, (int, float)) or not (minimo <= valor <= maximo):
            raise ErroPedido(f'"{nome}" deve ser um número entre {minimo} e {maximo}')
        return round(float(valor), 1)
    return v


ESQUEMAS = {
    "medicamentos": {
        "nome": texto(120, True),
        "tipo": opcao("medicamento", "suplemento"),
        "dose": texto(120),
        "quando": texto(160),
        "frequencia": opcao("diario", "semanal", "se-necessario", "a-definir"),
        "diasDaSemana": dias_semana,
        "inicio": data_ou_vazio,
        "fim": data_ou_vazio,
        "observacao": texto(1000),
    },
    "exames": {
        "nome": texto(160, True),
        "status": opcao("pendente", "agendado", "feito"),
        "data": data_ou_vazio,
        "local": texto(160),
        "observacao": texto(1000),
    },
    "consultas": {
        "data": data_ou_vazio,
        "hora": hora_ou_vazio,
        "profissional": texto(120, True),
        "especialidade": texto(120),
        "local": texto(160),
        "status": opcao("a-agendar", "agendada", "realizada", "cancelada"),
        "resumo": texto(6000),
    },
    "pendencias": {
        "texto": texto(300, True),
        "prazo": data_ou_vazio,
        "feito": booleano,
    },
}
PADROES = {
    "medicamentos": {"tipo": "medicamento", "frequencia": "diario"},
    "exames": {"status": "pendente"},
    "consultas": {"status": "agendada"},
    "pendencias": {},
}
CONFIG = {
    "peso": {
        "ativo": booleano,
        "dias": dias_semana,
        "instrucoes": texto(500),
        "inicio": data_ou_vazio,
        "prazo": data_ou_vazio,
        "metaMinimaKg": numero(0, 100),
        "metaIdealKg": numero(0, 100),
    },
    "proteina": {"ativo": booleano, "metaG": numero(0, 1000)},
}


def valida(esquema, pedido, padroes=None):
    if not isinstance(pedido, dict):
        raise ErroPedido("envie um objeto JSON")
    item = {}
    for campo, validador in esquema.items():
        valor = pedido.get(campo, (padroes or {}).get(campo))
        item[campo] = validador(campo, valor)
    return item


# ---------- armazenamento ----------
def caminho(pessoa):
    return os.path.join(DADOS_DIR, f"{pessoa}.json")


def semeia():
    """Cria os arquivos que faltam a partir de saude-inicial/ (nunca sobrescreve dados existentes)."""
    os.makedirs(DADOS_DIR, exist_ok=True)
    if not os.path.isdir(INICIAL_DIR):
        return
    for nome in sorted(os.listdir(INICIAL_DIR)):
        if nome.endswith(".json") and not os.path.exists(os.path.join(DADOS_DIR, nome)):
            shutil.copyfile(os.path.join(INICIAL_DIR, nome), os.path.join(DADOS_DIR, nome))


def normaliza(doc, pessoa):
    doc["id"] = pessoa
    doc.setdefault("nome", pessoa)
    for colecao in ESQUEMAS:
        if not isinstance(doc.get(colecao), list):
            doc[colecao] = []
    peso = doc.setdefault("peso", {})
    peso.setdefault("ativo", False)
    peso.setdefault("dias", [])
    if not isinstance(peso.get("registros"), dict):
        peso["registros"] = {}
    proteina = doc.setdefault("proteina", {})
    proteina.setdefault("ativo", False)
    proteina.setdefault("metaG", 0)
    if not isinstance(proteina.get("dias"), dict):
        proteina["dias"] = {}
    if not isinstance(doc.get("tomadas"), dict):
        doc["tomadas"] = {}
    doc.setdefault("plano", None)
    if not isinstance(doc.get("revisao"), int):
        doc["revisao"] = 0
    return doc


def le(pessoa):
    try:
        with open(caminho(pessoa), encoding="utf-8") as fh:
            return normaliza(json.load(fh), pessoa)
    except FileNotFoundError:
        raise NaoEncontrado(f"pessoa inexistente: {pessoa}")


def grava(doc):
    doc["revisao"] += 1
    doc["atualizadoEm"] = agora()
    fd, tmp = tempfile.mkstemp(prefix=".saude-", suffix=".json", dir=DADOS_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, caminho(doc["id"]))
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return doc


def pessoas():
    lista = []
    for nome in sorted(os.listdir(DADOS_DIR)):
        if nome.endswith(".json") and not nome.startswith("."):
            pid = nome[:-5]
            try:
                doc = le(pid)
            except (ValueError, NaoEncontrado):
                continue
            lista.append({"id": pid, "nome": doc["nome"], "ordem": doc.get("ordem", 99)})
    lista.sort(key=lambda p: (p["ordem"], p["nome"]))
    return [{"id": p["id"], "nome": p["nome"]} for p in lista]


def altera(pessoa, funcao):
    with trava:
        doc = le(pessoa)
        funcao(doc)
        return grava(doc)


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "casa-saude/1"

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

    def _corpo(self):
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho <= 0:
            raise ErroPedido("corpo vazio")
        if tamanho > MAX_BODY:
            raise ErroPedido("corpo grande demais")
        try:
            return json.loads(self.rfile.read(tamanho).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ErroPedido("JSON inválido")

    def _trata(self, acao):
        try:
            self._envia(200, acao())
        except ErroPedido as e:
            self._envia(400, {"erro": str(e)})
        except NaoEncontrado as e:
            self._envia(404, {"erro": str(e)})

    def do_GET(self):
        rota = self.path.split("?", 1)[0]
        if rota == "/status":
            return self._envia(200, {"ok": True})
        if rota == "/pessoas":
            return self._trata(lambda: {"pessoas": pessoas()})
        m = ROTA_PESSOA.match(rota)
        if m:
            return self._trata(lambda: le(m.group(1)))
        self._envia(404, {"erro": "rota inexistente"})

    def do_PUT(self):
        rota = self.path.split("?", 1)[0]

        m = ROTA_ITEM.match(rota)
        if m:
            pessoa, colecao, item_id = m.groups()

            def acao():
                item = valida(ESQUEMAS[colecao], self._corpo(), PADROES[colecao])
                item["id"] = item_id

                def muda(doc):
                    lista = doc[colecao]
                    for i, existente in enumerate(lista):
                        if existente.get("id") == item_id:
                            lista[i] = item
                            return
                    lista.append(item)
                return altera(pessoa, muda)
            return self._trata(acao)

        m = ROTA_TOMADA.match(rota)
        if m:
            pessoa, data, med = m.groups()

            def acao():
                pedido = self._corpo()
                tomado = booleano("tomado", pedido.get("tomado") if isinstance(pedido, dict) else None)
                data_ou_vazio("data", data)

                def muda(doc):
                    dia = doc["tomadas"].setdefault(data, {})
                    if tomado:
                        dia[med] = agora()
                    else:
                        dia.pop(med, None)
                        if not dia:
                            del doc["tomadas"][data]
                return altera(pessoa, muda)
            return self._trata(acao)

        m = ROTA_PESO.match(rota)
        if m:
            pessoa, data = m.groups()

            def acao():
                pedido = self._corpo()
                if not isinstance(pedido, dict):
                    raise ErroPedido("envie um objeto JSON")
                data_ou_vazio("data", data)
                registro = {"kg": numero(20, 400)("kg", pedido.get("kg")), "nota": texto(300)("nota", pedido.get("nota"))}
                return altera(pessoa, lambda doc: doc["peso"]["registros"].__setitem__(data, registro))
            return self._trata(acao)

        m = ROTA_PROTEINA.match(rota)
        if m:
            pessoa, data = m.groups()

            def acao():
                pedido = self._corpo()
                data_ou_vazio("data", data)
                gramas = numero(0, 1000)("g", pedido.get("g") if isinstance(pedido, dict) else None)

                def muda(doc):
                    if gramas:
                        doc["proteina"]["dias"][data] = gramas
                    else:
                        doc["proteina"]["dias"].pop(data, None)
                return altera(pessoa, muda)
            return self._trata(acao)

        m = ROTA_CONFIG.match(rota)
        if m:
            pessoa, chave = m.groups()

            def acao():
                config = valida(CONFIG[chave], self._corpo(), {"metaMinimaKg": 0, "metaIdealKg": 0, "metaG": 0})
                return altera(pessoa, lambda doc: doc[chave].update(config))
            return self._trata(acao)

        self._envia(404, {"erro": "rota inexistente"})

    def do_DELETE(self):
        rota = self.path.split("?", 1)[0]
        m = ROTA_ITEM.match(rota)
        if m:
            pessoa, colecao, item_id = m.groups()

            def muda(doc):
                doc[colecao] = [i for i in doc[colecao] if i.get("id") != item_id]
            return self._trata(lambda: altera(pessoa, muda))
        m = ROTA_PESO.match(rota)
        if m:
            pessoa, data = m.groups()
            return self._trata(lambda: altera(pessoa, lambda doc: doc["peso"]["registros"].pop(data, None)))
        self._envia(404, {"erro": "rota inexistente"})


def main():
    semeia()
    servidor = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"API de saúde em http://{BIND}:{PORT}, dados em {DADOS_DIR}", file=sys.stderr)
    servidor.serve_forever()


if __name__ == "__main__":
    main()
