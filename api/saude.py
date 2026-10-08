#!/usr/bin/env python3
"""
API do Acompanhamento Médico da casa. Só biblioteca padrão.

Um arquivo por pessoa em DADOS_DIR (<id>.json) com as modalidades (especialidades e seus médicos),
medicamentos, exames, consultas, pendências, documentos, plano alimentar, peso, proteína e as tomadas de
cada dia. Cada item aponta para uma modalidade ("modalidade": id). Na primeira vez, cada arquivo nasce de
api/saude-inicial/<id>.json; depois disso só a API grava (os dados ficam no Pi, fora do git).

Atualizações: cada arquivo em api/saude-inicial/atualizacoes/*.json é aplicado uma única vez a cada
pessoa (fica anotado em "migracoes"), sem apagar nada do que foi registrado na tela. Uma atualização
pode criar modalidades, acrescentar itens, lançar pesagens em datas ainda vazias e completar o resumo
de uma consulta.

  GET    /status                                   -> {"ok": true}
  GET    /pessoas                                  -> {"pessoas": [{id, nome}]}
  GET    /pessoa/<p>                               -> documento inteiro da pessoa (com "revisao")
  PUT    /pessoa/<p>/<colecao>/<item>              <- item (modalidades, medicamentos, exames, consultas, pendencias,
                                                     composicao = avaliações de composição corporal, ex.: InBody)
  DELETE /pessoa/<p>/<colecao>/<item>
  PUT    /pessoa/<p>/tomada/AAAA-MM-DD/<med>       <- {"tomado": bool}
  PUT    /pessoa/<p>/peso/AAAA-MM-DD               <- {"kg": 82.4, "nota": "..."}
  DELETE /pessoa/<p>/peso/AAAA-MM-DD
  PUT    /pessoa/<p>/proteina/AAAA-MM-DD           <- {"g": 120}
  PUT    /pessoa/<p>/config/peso                   <- {ativo, dias, instrucoes, inicio, prazo, metaMinimaKg, metaIdealKg,
                                                     modalidade}
  PUT    /pessoa/<p>/config/proteina               <- {ativo, metaG, modalidade}
  PUT    /pessoa/<p>/documento/<id>                <- o arquivo (PDF ou imagem, até 15 MB) no corpo; cabeçalhos
                                                     X-Nome, X-Modalidade e X-Data (opcionais, nome em %-encoding)
  GET    /pessoa/<p>/documento/<id>                -> o arquivo
  DELETE /pessoa/<p>/documento/<id>

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
from urllib.parse import quote, unquote

AQUI = os.path.dirname(os.path.abspath(__file__))
DADOS_DIR = os.environ.get("DADOS_DIR") or os.path.join(os.path.dirname(AQUI), "dados", "saude")
INICIAL_DIR = os.environ.get("INICIAL_DIR") or os.path.join(AQUI, "saude-inicial")
PORT = int(os.environ.get("PORT", "8082"))
BIND = os.environ.get("BIND", "127.0.0.1")
MAX_BODY = 64 * 1024
MAX_ARQUIVO = 15 * 1024 * 1024
TIPOS_ARQUIVO = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp"}

ID = r"[a-z0-9][a-z0-9-]{0,63}"
DATA = r"\d{4}-\d{2}-\d{2}"
ROTA_PESSOA = re.compile(rf"^/pessoa/({ID})$")
ROTA_ITEM = re.compile(rf"^/pessoa/({ID})/(modalidades|medicamentos|exames|consultas|pendencias|composicao)/({ID})$")
ROTA_DOCUMENTO = re.compile(rf"^/pessoa/({ID})/documento/({ID})$")
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


def id_ou_vazio(nome, valor):
    if valor in (None, ""):
        return ""
    if not isinstance(valor, str) or not re.match(rf"^{ID}$", valor):
        raise ErroPedido(f'"{nome}" deve ser o id de uma modalidade')
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


def numero(minimo, maximo, casas=1):
    def v(nome, valor):
        if isinstance(valor, bool) or not isinstance(valor, (int, float)) or not (minimo <= valor <= maximo):
            raise ErroPedido(f'"{nome}" deve ser um número entre {minimo} e {maximo}')
        return round(float(valor), casas)
    return v


# Composição corporal (bioimpedância): medidas conhecidas, com a unidade de cada uma.
MEDIDAS = {
    "peso": "kg", "agua": "L", "proteina": "kg", "minerais": "kg", "gordura": "kg", "mme": "kg", "mlg": "kg",
    "imc": "kg/m²", "pgc": "%", "tmb": "kcal", "rcq": "", "visceral": "", "obesidade": "%", "pontuacao": "pontos",
    "pesoIdeal": "kg", "controlePeso": "kg", "controleGordura": "kg", "controleMuscular": "kg",
}
SEGMENTOS = ("bracoEsquerdo", "bracoDireito", "tronco", "pernaEsquerda", "pernaDireita")


def medidas(nome, valor):
    if valor is None:
        return {}
    if not isinstance(valor, dict):
        raise ErroPedido(f'"{nome}" deve ser um objeto')
    saida = {}
    for chave, v in valor.items():
        if chave not in MEDIDAS:
            raise ErroPedido(f'"{nome}.{chave}" não é uma medida conhecida')
        if v in (None, ""):
            continue
        saida[chave] = numero(-1000, 10000, 3)(f"{nome}.{chave}", v)
    return saida


def faixas(nome, valor):
    if valor is None:
        return {}
    if not isinstance(valor, dict):
        raise ErroPedido(f'"{nome}" deve ser um objeto')
    saida = {}
    for chave, par in valor.items():
        if chave not in MEDIDAS:
            raise ErroPedido(f'"{nome}.{chave}" não é uma medida conhecida')
        if not (isinstance(par, list) and len(par) == 2):
            raise ErroPedido(f'"{nome}.{chave}" deve ser [mínimo, máximo]')
        saida[chave] = [numero(-1000, 10000, 3)(f"{nome}.{chave}", par[0]), numero(-1000, 10000, 3)(f"{nome}.{chave}", par[1])]
    return saida


def segmentar(nome, valor):
    """{"magra"|"gordura": {segmento: {"kg": n, "pct": n}}} (porcentagem em relação ao ideal)."""
    if valor is None:
        return {}
    if not isinstance(valor, dict):
        raise ErroPedido(f'"{nome}" deve ser um objeto')
    saida = {}
    for tipo, partes in valor.items():
        if tipo not in ("magra", "gordura") or not isinstance(partes, dict):
            raise ErroPedido(f'"{nome}.{tipo}" deve ser "magra" ou "gordura", com os segmentos')
        saida[tipo] = {}
        for seg, med in partes.items():
            if seg not in SEGMENTOS or not isinstance(med, dict):
                raise ErroPedido(f'"{nome}.{tipo}.{seg}" não é um segmento conhecido')
            saida[tipo][seg] = {k: numero(0, 1000, 3)(f"{nome}.{tipo}.{seg}.{k}", med.get(k)) for k in ("kg", "pct")}
    return saida


ESQUEMAS = {
    "modalidades": {
        "nome": texto(80, True),
        "profissional": texto(120),
        "registro": texto(120),
        "local": texto(240),
        "telefone": texto(60),
        "observacao": texto(1000),
    },
    "medicamentos": {
        "modalidade": id_ou_vazio,
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
        "modalidade": id_ou_vazio,
        "nome": texto(160, True),
        "status": opcao("pendente", "agendado", "feito"),
        "data": data_ou_vazio,
        "local": texto(160),
        "observacao": texto(1000),
    },
    "consultas": {
        "modalidade": id_ou_vazio,
        "data": data_ou_vazio,
        "hora": hora_ou_vazio,
        "profissional": texto(120, True),
        "especialidade": texto(120),
        "local": texto(160),
        "status": opcao("a-agendar", "agendada", "realizada", "cancelada"),
        "resumo": texto(6000),
    },
    "composicao": {
        "modalidade": id_ou_vazio,
        "data": data_ou_vazio,
        "hora": hora_ou_vazio,
        "aparelho": texto(80),
        "local": texto(160),
        "medidas": medidas,
        "faixas": faixas,
        "segmentar": segmentar,
        "observacao": texto(2000),
    },
    "pendencias": {
        "modalidade": id_ou_vazio,
        "texto": texto(300, True),
        "prazo": data_ou_vazio,
        "feito": booleano,
    },
}
PADROES = {
    "modalidades": {},
    "medicamentos": {"tipo": "medicamento", "frequencia": "diario"},
    "exames": {"status": "pendente"},
    "consultas": {"status": "agendada"},
    "pendencias": {},
    "composicao": {},
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
        "modalidade": id_ou_vazio,
    },
    "proteina": {"ativo": booleano, "metaG": numero(0, 1000), "modalidade": id_ou_vazio},
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
    for lista in ("documentos", "migracoes"):
        if not isinstance(doc.get(lista), list):
            doc[lista] = []
    doc.setdefault("plano", None)
    if not isinstance(doc.get("revisao"), int):
        doc["revisao"] = 0
    return doc


def aplica_atualizacoes():
    """Aplica uma vez cada api/saude-inicial/atualizacoes/*.json às pessoas que ela cita."""
    pasta = os.path.join(INICIAL_DIR, "atualizacoes")
    if not os.path.isdir(pasta):
        return
    for nome in sorted(os.listdir(pasta)):
        if not nome.endswith(".json"):
            continue
        with open(os.path.join(pasta, nome), encoding="utf-8") as fh:
            atualizacao = json.load(fh)
        uid, pessoa = atualizacao["id"], atualizacao["pessoa"]
        if not os.path.exists(caminho(pessoa)):
            continue
        with trava:
            doc = le(pessoa)
            if uid in doc["migracoes"]:
                continue
            for modalidade in atualizacao.get("modalidades", []):
                item = valida(ESQUEMAS["modalidades"], modalidade)
                item["id"] = modalidade["id"]
                doc["modalidades"] = [m for m in doc["modalidades"] if m.get("id") != item["id"]] + [item]
            padrao = atualizacao.get("semModalidade")
            if padrao:
                for colecao in ("medicamentos", "exames", "consultas", "pendencias"):
                    for item in doc[colecao]:
                        if not item.get("modalidade"):
                            item["modalidade"] = padrao
                for chave in ("peso", "proteina"):
                    if not doc[chave].get("modalidade"):
                        doc[chave]["modalidade"] = padrao
                if doc.get("plano") and not doc["plano"].get("modalidade"):
                    doc["plano"]["modalidade"] = padrao
            # Pesagens: entram só nas datas ainda sem registro (nunca sobrescrevem o que foi lançado na tela).
            for data, reg in atualizacao.get("peso", {}).items():
                data_ou_vazio("peso", data)
                if data not in doc["peso"]["registros"]:
                    doc["peso"]["registros"][data] = {"kg": numero(20, 400)("kg", reg.get("kg")), "nota": texto(300)("nota", reg.get("nota"))}
            # Texto acrescentado ao resumo de uma consulta existente (uma vez; não repete se já estiver lá).
            for cid, extra in atualizacao.get("acrescentarResumo", {}).items():
                for consulta in doc["consultas"]:
                    if consulta.get("id") == cid and extra.strip() not in (consulta.get("resumo") or ""):
                        consulta["resumo"] = ((consulta.get("resumo") or "").rstrip() + "\n\n" + extra.strip()).strip()[:6000]
            for colecao, itens in atualizacao.get("itens", {}).items():
                existentes = {i.get("id") for i in doc[colecao]}
                for bruto in itens:
                    if bruto["id"] in existentes:
                        continue
                    item = valida(ESQUEMAS[colecao], bruto, PADROES[colecao])
                    item["id"] = bruto["id"]
                    doc[colecao].append(item)
            doc["migracoes"].append(uid)
            grava(doc)
            print(f"atualização {uid} aplicada a {pessoa}", file=sys.stderr)


def pasta_arquivos(pessoa):
    return os.path.join(DADOS_DIR, "arquivos", pessoa)


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
        m = ROTA_DOCUMENTO.match(rota)
        if m:
            return self._envia_documento(*m.groups())
        self._envia(404, {"erro": "rota inexistente"})

    def _envia_documento(self, pessoa, doc_id):
        try:
            meta = next((d for d in le(pessoa)["documentos"] if d.get("id") == doc_id), None)
        except NaoEncontrado as e:
            return self._envia(404, {"erro": str(e)})
        arquivo = meta and os.path.join(pasta_arquivos(pessoa), meta["arquivo"])
        if not arquivo or not os.path.exists(arquivo):
            return self._envia(404, {"erro": "documento inexistente"})
        with open(arquivo, "rb") as fh:
            dados = fh.read()
        nome = meta["nome"] + "." + TIPOS_ARQUIVO.get(meta["tipo"], "bin")
        self.send_response(200)
        self.send_header("Content-Type", meta["tipo"])
        self.send_header("Content-Length", str(len(dados)))
        self.send_header("Content-Disposition", "inline; filename*=UTF-8''" + quote(nome))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(dados)

    def _recebe_documento(self, pessoa, doc_id):
        tipo = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if tipo not in TIPOS_ARQUIVO:
            raise ErroPedido("envie um PDF ou uma imagem (JPG, PNG, HEIC ou WEBP)")
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho <= 0:
            raise ErroPedido("arquivo vazio")
        if tamanho > MAX_ARQUIVO:
            raise ErroPedido("arquivo com mais de 15 MB")
        dados = self.rfile.read(tamanho)
        meta = {
            "id": doc_id,
            "nome": texto(160, True)("nome", unquote(self.headers.get("X-Nome") or "")),
            "modalidade": id_ou_vazio("modalidade", self.headers.get("X-Modalidade") or ""),
            "data": data_ou_vazio("data", self.headers.get("X-Data") or ""),
            "tipo": tipo,
            "tamanho": tamanho,
            "arquivo": f"{doc_id}.{TIPOS_ARQUIVO[tipo]}",
            "enviadoEm": agora(),
        }
        le(pessoa)  # 404 antes de gravar o arquivo
        pasta = pasta_arquivos(pessoa)
        os.makedirs(pasta, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".doc-", dir=pasta)
        with os.fdopen(fd, "wb") as fh:
            fh.write(dados)
        os.replace(tmp, os.path.join(pasta, meta["arquivo"]))

        def muda(doc):
            doc["documentos"] = [d for d in doc["documentos"] if d.get("id") != doc_id] + [meta]
        return altera(pessoa, muda)

    def do_PUT(self):
        rota = self.path.split("?", 1)[0]

        m = ROTA_DOCUMENTO.match(rota)
        if m:
            return self._trata(lambda: self._recebe_documento(*m.groups()))

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
        m = ROTA_DOCUMENTO.match(rota)
        if m:
            pessoa, doc_id = m.groups()

            def muda(doc):
                for d in doc["documentos"]:
                    if d.get("id") == doc_id:
                        arquivo = os.path.join(pasta_arquivos(pessoa), d["arquivo"])
                        if os.path.exists(arquivo):
                            os.unlink(arquivo)
                doc["documentos"] = [d for d in doc["documentos"] if d.get("id") != doc_id]
            return self._trata(lambda: altera(pessoa, muda))
        self._envia(404, {"erro": "rota inexistente"})


def main():
    semeia()
    aplica_atualizacoes()
    servidor = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"API de saúde em http://{BIND}:{PORT}, dados em {DADOS_DIR}", file=sys.stderr)
    servidor.serve_forever()


if __name__ == "__main__":
    main()
