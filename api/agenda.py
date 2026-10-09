#!/usr/bin/env python3
"""
API da Agenda da casa (compromissos pessoais e profissionais). Só biblioteca padrão.

Um arquivo por pessoa em DADOS_DIR (<id>.json) com:
  - eventos: compromissos com data e hora (ou dia inteiro), repetição e lembrete;
  - tarefas: compromissos a cumprir até um prazo, com prioridade e feito/não feito;
  - calendarios: calendários do iPhone/Google lidos pelo link privado (iCal), com o contexto
    (pessoal ou profissional) de cada um;
  - token: chave do link que o iPhone assina para ver os eventos e tarefas da página no app Calendário.
Na primeira vez cada arquivo nasce de api/agenda-inicial/<id>.json.

Os calendários externos são baixados a cada 15 minutos (e logo depois de cadastrados), expandidos
(repetições, exceções) de 60 dias para trás até 400 dias à frente e guardados em DADOS_DIR/externos/.

  GET    /status                                   -> {"ok": true}
  GET    /pessoas                                  -> {"pessoas": [{id, nome}]}
  GET    /pessoa/<p>                               -> documento da pessoa + "externos" (eventos dos calendários lidos)
  PUT    /pessoa/<p>/<colecao>/<item>              <- item (eventos, tarefas, calendarios)
  DELETE /pessoa/<p>/<colecao>/<item>
  POST   /pessoa/<p>/calendarios/<item>/atualizar  -> baixa o calendário de novo agora
  POST   /pessoa/<p>/token                         -> troca a chave do link de assinatura
  GET    /pessoa/<p>/feed/<token>.ics              -> eventos e tarefas da página em iCalendar (assinatura)

Toda gravação devolve o documento inteiro. O Caddy publica em casa.blizzard.net/agenda/api/*.
Variáveis: DADOS_DIR (padrão ./dados/agenda), INICIAL_DIR (padrão ./api/agenda-inicial), PORT (8083), BIND.
"""
import datetime
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

AQUI = os.path.dirname(os.path.abspath(__file__))
DADOS_DIR = os.environ.get("DADOS_DIR") or os.path.join(os.path.dirname(AQUI), "dados", "agenda")
INICIAL_DIR = os.environ.get("INICIAL_DIR") or os.path.join(AQUI, "agenda-inicial")
PORT = int(os.environ.get("PORT", "8083"))
BIND = os.environ.get("BIND", "127.0.0.1")
MAX_BODY = 64 * 1024
MAX_ICS = 8 * 1024 * 1024
ATUALIZA_S = 15 * 60
JANELA_ANTES, JANELA_DEPOIS = 60, 400

ID = r"[a-z0-9][a-z0-9-]{0,63}"
ROTA_PESSOA = re.compile(rf"^/pessoa/({ID})$")
ROTA_ITEM = re.compile(rf"^/pessoa/({ID})/(eventos|tarefas|calendarios)/({ID})$")
ROTA_ATUALIZAR = re.compile(rf"^/pessoa/({ID})/calendarios/({ID})/atualizar$")
ROTA_TOKEN = re.compile(rf"^/pessoa/({ID})/token$")
ROTA_FEED = re.compile(rf"^/pessoa/({ID})/feed/([A-Za-z0-9_-]{{8,64}})\.ics$")
DATA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HORA = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

trava = threading.Lock()


class ErroPedido(ValueError):
    pass


class NaoEncontrado(LookupError):
    pass


def agora():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def fuso_local():
    nome = os.environ.get("TZ")
    if nome and ZoneInfo:
        try:
            return ZoneInfo(nome)
        except Exception:  # noqa: BLE001
            pass
    return datetime.datetime.now().astimezone().tzinfo


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
    if not isinstance(valor, str) or not DATA.match(valor):
        raise ErroPedido(f'"{nome}" deve ser uma data AAAA-MM-DD')
    try:
        datetime.date.fromisoformat(valor)
    except ValueError:
        raise ErroPedido(f'"{nome}" não é uma data válida')
    return valor


def data_obrigatoria(nome, valor):
    v = data_ou_vazio(nome, valor)
    if not v:
        raise ErroPedido(f'"{nome}" é obrigatória')
    return v


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


def inteiro(minimo, maximo):
    def v(nome, valor):
        if valor in (None, ""):
            return 0
        if isinstance(valor, bool) or not isinstance(valor, int) or not (minimo <= valor <= maximo):
            raise ErroPedido(f'"{nome}" deve ser um número inteiro entre {minimo} e {maximo}')
        return valor
    return v


def endereco_ics(nome, valor):
    valor = texto(2000, True)(nome, valor)
    if valor.lower().startswith("webcal://"):
        valor = "https://" + valor[len("webcal://"):]
    if not re.match(r"^https?://[^\s]+$", valor, re.I):
        raise ErroPedido(f'"{nome}" deve ser um link http(s):// ou webcal://')
    return valor


ESQUEMAS = {
    "eventos": {
        "titulo": texto(200, True),
        "contexto": opcao("pessoal", "profissional"),
        "data": data_obrigatoria,
        "hora": hora_ou_vazio,
        "dataFim": data_ou_vazio,
        "horaFim": hora_ou_vazio,
        "diaInteiro": booleano,
        "repete": opcao("nao", "diario", "semanal", "mensal", "anual"),
        "repeteAte": data_ou_vazio,
        "lembreteMin": inteiro(0, 40320),
        "local": texto(300),
        "observacao": texto(3000),
    },
    "tarefas": {
        "titulo": texto(200, True),
        "contexto": opcao("pessoal", "profissional"),
        "prazo": data_ou_vazio,
        "hora": hora_ou_vazio,
        "prioridade": opcao("alta", "normal", "baixa"),
        "feito": booleano,
        "feitoEm": data_ou_vazio,
        "observacao": texto(3000),
    },
    "calendarios": {
        "nome": texto(80, True),
        "url": endereco_ics,
        "contexto": opcao("pessoal", "profissional"),
        "ativo": booleano,
    },
}
PADROES = {
    "eventos": {"contexto": "pessoal", "repete": "nao"},
    "tarefas": {"contexto": "pessoal", "prioridade": "normal"},
    "calendarios": {"contexto": "pessoal", "ativo": True},
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


def caminho_externos(pessoa):
    return os.path.join(DADOS_DIR, "externos", f"{pessoa}.json")


def semeia():
    os.makedirs(os.path.join(DADOS_DIR, "externos"), exist_ok=True)
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
    if not isinstance(doc.get("revisao"), int):
        doc["revisao"] = 0
    return doc


def grava_json(arquivo, dados):
    fd, tmp = tempfile.mkstemp(prefix=".agenda-", suffix=".json", dir=os.path.dirname(arquivo))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(dados, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, arquivo)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def le(pessoa):
    try:
        with open(caminho(pessoa), encoding="utf-8") as fh:
            doc = normaliza(json.load(fh), pessoa)
    except FileNotFoundError:
        raise NaoEncontrado(f"pessoa inexistente: {pessoa}")
    if not doc.get("token"):  # chave do link de assinatura, criada na primeira leitura
        doc["token"] = secrets.token_urlsafe(18)
        grava_json(caminho(pessoa), doc)
    return doc


def grava(doc):
    doc["revisao"] += 1
    doc["atualizadoEm"] = agora()
    grava_json(caminho(doc["id"]), doc)
    return doc


def le_externos(pessoa):
    try:
        with open(caminho_externos(pessoa), encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return {}


def completo(doc):
    """Documento com os eventos dos calendários lidos e a situação de cada um."""
    ext = le_externos(doc["id"])
    saida = dict(doc)
    saida["externos"] = []
    saida["situacaoCalendarios"] = {}
    ativos = {c["id"]: c for c in doc["calendarios"] if c.get("ativo")}
    for cid, info in ext.items():
        if cid not in {c["id"] for c in doc["calendarios"]}:
            continue
        saida["situacaoCalendarios"][cid] = {"atualizadoEm": info.get("atualizadoEm", ""), "erro": info.get("erro", ""), "total": len(info.get("eventos", []))}
        if cid in ativos:
            saida["externos"] += [dict(e, calendario=cid, contexto=ativos[cid]["contexto"]) for e in info.get("eventos", [])]
    return saida


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
        return completo(grava(doc))


# ---------- iCalendar: leitura ----------
def desdobra(texto_ics):
    """Linhas do .ics com as continuações (linhas que começam com espaço) juntadas."""
    linhas = []
    for linha in texto_ics.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if linha[:1] in (" ", "\t") and linhas:
            linhas[-1] += linha[1:]
        elif linha:
            linhas.append(linha)
    return linhas


def separa(linha):
    """'DTSTART;TZID=America/Sao_Paulo:20261010T090000' -> ('DTSTART', {'TZID': ...}, '20261010T090000')."""
    dentro, i = False, 0
    for i, ch in enumerate(linha):
        if ch == '"':
            dentro = not dentro
        elif ch == ":" and not dentro:
            break
    cab, valor = linha[:i], linha[i + 1:]
    partes = cab.split(";")
    params = {}
    for p in partes[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
    return partes[0].upper(), params, valor


def sem_escape(v):
    return v.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


# Nomes de fuso do Windows (Outlook) mais comuns por aqui.
FUSOS_WINDOWS = {
    "E. South America Standard Time": "America/Sao_Paulo",
    "SA Eastern Standard Time": "America/Fortaleza",
    "Central Brazilian Standard Time": "America/Cuiaba",
    "UTC": "UTC",
    "Eastern Standard Time": "America/New_York",
    "Pacific Standard Time": "America/Los_Angeles",
    "GMT Standard Time": "Europe/London",
    "W. Europe Standard Time": "Europe/Berlin",
}


def fuso(nome):
    if not nome or not ZoneInfo:
        return None
    nome = FUSOS_WINDOWS.get(nome, nome)
    try:
        return ZoneInfo(nome)
    except Exception:  # noqa: BLE001
        m = re.search(r"([A-Za-z]+/[A-Za-z_]+(?:/[A-Za-z_]+)?)$", nome)  # "/mozilla.org/.../America/Sao_Paulo"
        if m:
            try:
                return ZoneInfo(m.group(1))
            except Exception:  # noqa: BLE001
                return None
        return None


def le_data(valor, params):
    """Data (dia inteiro) ou datetime com fuso; None se não der para ler."""
    valor = valor.strip()
    try:
        if params.get("VALUE") == "DATE" or re.match(r"^\d{8}$", valor):
            return datetime.date(int(valor[:4]), int(valor[4:6]), int(valor[6:8]))
        m = re.match(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$", valor)
        if not m:
            return None
        d = datetime.datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6] or 0))
        if m[7]:
            return d.replace(tzinfo=datetime.timezone.utc)
        return d.replace(tzinfo=fuso(params.get("TZID")) or fuso_local())
    except ValueError:
        return None


def le_duracao(v):
    m = re.match(r"^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$", v.strip())
    if not m:
        return None
    d = datetime.timedelta(weeks=int(m[2] or 0), days=int(m[3] or 0), hours=int(m[4] or 0), minutes=int(m[5] or 0), seconds=int(m[6] or 0))
    return -d if m[1] == "-" else d


DIAS_ICS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


def soma_meses(d, n):
    m = d.month - 1 + n
    ano, mes = d.year + m // 12, m % 12 + 1
    return ano, mes


def dias_do_mes(ano, mes):
    return (datetime.date(ano + (mes == 12), mes % 12 + 1, 1) - datetime.date(ano, mes, 1)).days


def nesimo_dia_semana(ano, mes, dia_semana, n):
    """n-ésima (1..5, ou -1..-5) ocorrência do dia da semana no mês; None se não existir."""
    total = dias_do_mes(ano, mes)
    dias = [d for d in range(1, total + 1) if datetime.date(ano, mes, d).weekday() == dia_semana]
    try:
        return dias[n - 1] if n > 0 else dias[n]
    except IndexError:
        return None


def ocorrencias(inicio, regra, ate, de=None):
    """Inícios gerados por uma RRULE (as frequências e partes mais usadas), até a data 'ate'."""
    partes = dict(p.split("=", 1) for p in regra.split(";") if "=" in p)
    freq = partes.get("FREQ", "")
    intervalo = max(1, int(partes.get("INTERVAL", "1") or 1))
    contagem = int(partes["COUNT"]) if partes.get("COUNT", "").isdigit() else None
    limite = None
    if partes.get("UNTIL"):
        limite = le_data(partes["UNTIL"], {})
        if isinstance(limite, datetime.datetime) and isinstance(inicio, datetime.datetime):
            limite = limite.astimezone(inicio.tzinfo)
    porDia = [b for b in partes.get("BYDAY", "").split(",") if b]
    porDiaMes = [int(x) for x in partes.get("BYMONTHDAY", "").split(",") if x.lstrip("-").isdigit()]
    porMes = [int(x) for x in partes.get("BYMONTH", "").split(",") if x.isdigit()]
    eh_data = not isinstance(inicio, datetime.datetime)
    dia0 = inicio if eh_data else inicio.date()

    def monta(dia):
        if eh_data:
            return dia
        return datetime.datetime.combine(dia, inicio.timetz()).replace(tzinfo=inicio.tzinfo)

    def passou(x):
        if limite is None:
            return False
        a, b = x, limite
        if isinstance(a, datetime.datetime) != isinstance(b, datetime.datetime):
            a = a.date() if isinstance(a, datetime.datetime) else a
            b = b.date() if isinstance(b, datetime.datetime) else b
        return a > b

    saida, n, passo = [], 0, 0
    # Séries diárias/semanais antigas e sem COUNT: pula direto para perto da janela.
    if contagem is None and de is not None and freq in ("DAILY", "WEEKLY"):
        periodo = intervalo * (1 if freq == "DAILY" else 7)
        passo = max(0, (de - dia0).days // periodo - 1)
    limite_passos = passo + 5000
    while passo < limite_passos:
        if freq == "DAILY":
            candidatos = [dia0 + datetime.timedelta(days=passo * intervalo)]
        elif freq == "WEEKLY":
            semana0 = dia0 - datetime.timedelta(days=dia0.weekday())
            semana = semana0 + datetime.timedelta(weeks=passo * intervalo)
            dias = [DIAS_ICS.index(b[-2:]) for b in porDia if b[-2:] in DIAS_ICS] or [dia0.weekday()]
            candidatos = [semana + datetime.timedelta(days=d) for d in sorted(set(dias))]
        elif freq == "MONTHLY":
            ano, mes = soma_meses(dia0, passo * intervalo)
            candidatos = []
            if porDia:
                for b in porDia:
                    m = re.match(r"^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$", b)
                    if not m:
                        continue
                    if m[1]:
                        d = nesimo_dia_semana(ano, mes, DIAS_ICS.index(m[2]), int(m[1]))
                        if d:
                            candidatos.append(datetime.date(ano, mes, d))
                    else:
                        candidatos += [datetime.date(ano, mes, d) for d in range(1, dias_do_mes(ano, mes) + 1) if datetime.date(ano, mes, d).weekday() == DIAS_ICS.index(m[2])]
            else:
                for d in porDiaMes or [dia0.day]:
                    total = dias_do_mes(ano, mes)
                    d = d if d > 0 else total + d + 1
                    if 1 <= d <= total:
                        candidatos.append(datetime.date(ano, mes, d))
            candidatos.sort()
        elif freq == "YEARLY":
            ano = dia0.year + passo * intervalo
            candidatos = []
            for mes in porMes or [dia0.month]:
                if porDia:
                    for b in porDia:
                        m = re.match(r"^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$", b)
                        if m and m[1]:
                            d = nesimo_dia_semana(ano, mes, DIAS_ICS.index(m[2]), int(m[1]))
                            if d:
                                candidatos.append(datetime.date(ano, mes, d))
                else:
                    d = dia0.day
                    if d <= dias_do_mes(ano, mes):
                        candidatos.append(datetime.date(ano, mes, d))
            candidatos.sort()
        else:
            return [inicio]
        passo += 1
        for dia in candidatos:
            if dia < dia0:
                continue
            x = monta(dia)
            if passou(x) or (contagem is not None and n >= contagem):
                return saida
            if dia > ate:
                return saida
            saida.append(x)
            n += 1
    return saida


def chave_instancia(x):
    if isinstance(x, datetime.datetime):
        return x.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S")
    return x.strftime("%Y%m%d")


def para_local(x):
    """(data 'AAAA-MM-DD', hora 'HH:MM' ou '') no fuso da casa."""
    if isinstance(x, datetime.datetime):
        x = x.astimezone(fuso_local())
        return x.date().isoformat(), x.strftime("%H:%M")
    return x.isoformat(), ""


def le_ics(conteudo, hoje=None):
    """Eventos do .ics expandidos na janela [hoje-60, hoje+400], no fuso da casa."""
    hoje = hoje or datetime.date.today()
    de, ate = hoje - datetime.timedelta(days=JANELA_ANTES), hoje + datetime.timedelta(days=JANELA_DEPOIS)
    eventos, atual, profundidade = [], None, 0
    for linha in desdobra(conteudo):
        nome, params, valor = separa(linha)
        if nome == "BEGIN":
            if valor.upper() == "VEVENT" and profundidade == 0:
                atual = {"exdates": []}
            elif atual is not None:
                profundidade += 1
            continue
        if nome == "END":
            if atual is not None and profundidade:
                profundidade -= 1
            elif atual is not None and valor.upper() == "VEVENT":
                eventos.append(atual)
                atual = None
            continue
        if atual is None or profundidade:
            continue
        if nome in ("DTSTART", "DTEND", "RECURRENCE-ID"):
            atual[nome] = le_data(valor, params)
        elif nome == "EXDATE":
            atual["exdates"] += [le_data(v, params) for v in valor.split(",")]
        elif nome in ("SUMMARY", "LOCATION", "DESCRIPTION", "UID", "RRULE", "STATUS", "DURATION"):
            atual[nome] = sem_escape(valor) if nome in ("SUMMARY", "LOCATION", "DESCRIPTION") else valor
    # Instâncias alteradas (RECURRENCE-ID) substituem a original da série.
    trocadas = {(e.get("UID"), chave_instancia(e["RECURRENCE-ID"])) for e in eventos if e.get("RECURRENCE-ID")}
    saida = []
    for e in eventos:
        ini = e.get("DTSTART")
        if ini is None or (e.get("STATUS") or "").upper() == "CANCELLED":
            continue
        fim = e.get("DTEND")
        if fim is None and e.get("DURATION"):
            dur = le_duracao(e["DURATION"])
            fim = ini + dur if dur else None
        if fim is None:
            fim = ini + datetime.timedelta(days=1) if not isinstance(ini, datetime.datetime) else ini
        duracao = fim - ini
        if e.get("RRULE") and not e.get("RECURRENCE-ID"):
            inicios = ocorrencias(ini, e["RRULE"], ate, de)
        else:
            inicios = [ini]
        excluidas = {chave_instancia(x) for x in e["exdates"] if x is not None}
        for x in inicios:
            k = chave_instancia(x)
            if k in excluidas or (not e.get("RECURRENCE-ID") and e.get("RRULE") and (e.get("UID"), k) in trocadas):
                continue
            y = x + duracao
            dia_inteiro = not isinstance(x, datetime.datetime)
            data, hora = para_local(x)
            if dia_inteiro:
                y = y - datetime.timedelta(days=1)  # o fim de dia inteiro no .ics é exclusivo
            data_fim, hora_fim = para_local(y)
            if data_fim < de.isoformat() or data > ate.isoformat():
                continue
            saida.append({
                "id": re.sub(r"[^A-Za-z0-9]", "", (e.get("UID") or "")[-40:]) + "-" + k,
                "titulo": (e.get("SUMMARY") or "(sem título)")[:200],
                "data": data, "hora": "" if dia_inteiro else hora,
                "dataFim": data_fim if data_fim != data else "", "horaFim": "" if dia_inteiro else hora_fim,
                "diaInteiro": dia_inteiro,
                "local": (e.get("LOCATION") or "")[:300],
                "observacao": (e.get("DESCRIPTION") or "")[:1000],
            })
    saida.sort(key=lambda x: (x["data"], x["hora"]))
    return saida


def baixa(url):
    pedido = urllib.request.Request(url, headers={"User-Agent": "casa-agenda/1"})
    with urllib.request.urlopen(pedido, timeout=25) as r:
        dados = r.read(MAX_ICS + 1)
    if len(dados) > MAX_ICS:
        raise ValueError("calendário com mais de 8 MB")
    texto_ics = dados.decode("utf-8", errors="replace")
    if "BEGIN:VCALENDAR" not in texto_ics[:2000].upper():
        raise ValueError("o link não devolveu um calendário (.ics)")
    return texto_ics


trava_externos = threading.Lock()


def atualiza_calendario(pessoa, cal):
    info = {"atualizadoEm": agora(), "erro": "", "eventos": []}
    try:
        info["eventos"] = le_ics(baixa(cal["url"]))
    except urllib.error.HTTPError as e:
        info["erro"] = f"o servidor do calendário respondeu {e.code}" + (": o link não existe mais ou é privado" if e.code in (401, 403, 404) else "")
    except urllib.error.URLError as e:
        info["erro"] = f"não consegui acessar o link ({e.reason})"
    except Exception as e:  # noqa: BLE001
        info["erro"] = str(e)[:300] or e.__class__.__name__
    if info["erro"]:
        anterior = le_externos(pessoa).get(cal["id"], {})
        info["eventos"] = anterior.get("eventos", [])  # mantém o que já tinha
        print(f"calendário {pessoa}/{cal['id']}: {info['erro']}", file=sys.stderr)
    with trava_externos:
        ext = le_externos(pessoa)
        ext[cal["id"]] = info
        grava_json(caminho_externos(pessoa), ext)
    # Avisa as telas abertas (elas acompanham a "revisao").
    try:
        altera(pessoa, lambda doc: None)
    except NaoEncontrado:
        pass


def atualiza_em_segundo_plano(pessoa, cal):
    threading.Thread(target=atualiza_calendario, args=(pessoa, cal), daemon=True).start()


def atualiza_todos():
    while True:
        for p in pessoas():
            try:
                doc = le(p["id"])
            except NaoEncontrado:
                continue
            ext = le_externos(p["id"])
            ids = {c["id"] for c in doc["calendarios"]}
            if set(ext) - ids:  # calendário apagado: some do arquivo de externos
                with trava_externos:
                    ext = {k: v for k, v in le_externos(p["id"]).items() if k in ids}
                    grava_json(caminho_externos(p["id"]), ext)
            for cal in doc["calendarios"]:
                if cal.get("ativo"):
                    atualiza_calendario(p["id"], cal)
        threading.Event().wait(ATUALIZA_S)


# ---------- iCalendar: assinatura (o iPhone lê os eventos e tarefas da página) ----------
def escape_ics(v):
    return (v or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def dobra(linha):
    saida, b = [], linha.encode("utf-8")
    while len(b) > 74:
        corte = 74
        while corte > 0 and (b[corte] & 0xC0) == 0x80:  # não corta no meio de um caractere
            corte -= 1
        saida.append(b[:corte].decode("utf-8"))
        b = b" " + b[corte:]
    saida.append(b.decode("utf-8"))
    return "\r\n".join(saida)


def feed(doc):
    tz = os.environ.get("TZ") or "America/Sao_Paulo"
    carimbo = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    linhas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//casa.blizzard.net//Agenda//PT", "CALSCALE:GREGORIAN",
              "METHOD:PUBLISH", f"X-WR-CALNAME:Agenda da casa · {doc['nome']}", f"X-WR-TIMEZONE:{tz}",
              "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"]
    if tz == "America/Sao_Paulo":  # sem horário de verão desde 2019
        linhas += ["BEGIN:VTIMEZONE", "TZID:America/Sao_Paulo", "BEGIN:STANDARD", "DTSTART:19700101T000000",
                   "TZOFFSETFROM:-0300", "TZOFFSETTO:-0300", "TZNAME:-03", "END:STANDARD", "END:VTIMEZONE"]
    regras = {"diario": "DAILY", "semanal": "WEEKLY", "mensal": "MONTHLY", "anual": "YEARLY"}

    def quando(prefixo, data, hora, dia_inteiro):
        d = data.replace("-", "")
        if dia_inteiro or not hora:
            return f"{prefixo};VALUE=DATE:{d}"
        return f"{prefixo};TZID={tz}:{d}T{hora.replace(':', '')}00"

    for e in doc["eventos"]:
        dia_inteiro = e.get("diaInteiro") or not e.get("hora")
        fim_data = e.get("dataFim") or e["data"]
        if dia_inteiro:
            fim = (datetime.date.fromisoformat(fim_data) + datetime.timedelta(days=1)).isoformat()
            fim_linha = quando("DTEND", fim, "", True)
        else:
            hora_fim = e.get("horaFim")
            if not hora_fim:  # sem hora de fim: uma hora de duração
                h = datetime.datetime.strptime(e["data"] + e["hora"], "%Y-%m-%d%H:%M") + datetime.timedelta(hours=1)
                fim_data, hora_fim = h.date().isoformat(), h.strftime("%H:%M")
            fim_linha = quando("DTEND", fim_data, hora_fim, False)
        linhas += ["BEGIN:VEVENT", f"UID:{e['id']}@agenda.{doc['id']}.casa", f"DTSTAMP:{carimbo}",
                   quando("DTSTART", e["data"], e.get("hora"), dia_inteiro), fim_linha,
                   "SUMMARY:" + escape_ics(e["titulo"]),
                   "CATEGORIES:" + ("Profissional" if e.get("contexto") == "profissional" else "Pessoal")]
        if e.get("local"):
            linhas.append("LOCATION:" + escape_ics(e["local"]))
        if e.get("observacao"):
            linhas.append("DESCRIPTION:" + escape_ics(e["observacao"]))
        if e.get("repete") in regras:
            r = "RRULE:FREQ=" + regras[e["repete"]]
            if e.get("repeteAte"):
                r += ";UNTIL=" + e["repeteAte"].replace("-", "") + ("" if dia_inteiro else "T235959Z")
            linhas.append(r)
        if e.get("lembreteMin"):
            linhas += ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + escape_ics(e["titulo"]),
                       f"TRIGGER:-PT{int(e['lembreteMin'])}M", "END:VALARM"]
        linhas.append("END:VEVENT")
    # Tarefas por fazer com prazo: aparecem no Calendário como lembrete de dia inteiro (ou na hora do prazo).
    for t in doc["tarefas"]:
        if t.get("feito") or not t.get("prazo"):
            continue
        if t.get("hora"):
            ini = quando("DTSTART", t["prazo"], t["hora"], False)
            fim = quando("DTEND", t["prazo"], t["hora"], False)
        else:
            ini = quando("DTSTART", t["prazo"], "", True)
            fim = quando("DTEND", (datetime.date.fromisoformat(t["prazo"]) + datetime.timedelta(days=1)).isoformat(), "", True)
        linhas += ["BEGIN:VEVENT", f"UID:tarefa-{t['id']}@agenda.{doc['id']}.casa", f"DTSTAMP:{carimbo}", ini, fim,
                   "SUMMARY:" + escape_ics("☐ " + t["titulo"]), "TRANSP:TRANSPARENT",
                   "CATEGORIES:Tarefa," + ("Profissional" if t.get("contexto") == "profissional" else "Pessoal")]
        if t.get("observacao"):
            linhas.append("DESCRIPTION:" + escape_ics(t["observacao"]))
        linhas.append("END:VEVENT")
    linhas.append("END:VCALENDAR")
    return "\r\n".join(dobra(l) for l in linhas) + "\r\n"


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "casa-agenda/1"

    def log_message(self, fmt, *args):
        # Não registra o token do link de assinatura.
        linha = fmt % args
        sys.stderr.write("%s %s\n" % (self.address_string(), re.sub(r"/feed/[^ ]+\.ics", "/feed/***.ics", linha)))

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
            return self._trata(lambda: completo(le(m.group(1))))
        m = ROTA_FEED.match(rota)
        if m:
            pessoa, token = m.groups()
            try:
                doc = le(pessoa)
            except NaoEncontrado:
                return self._envia(404, {"erro": "inexistente"})
            if not secrets.compare_digest(token, doc["token"]):
                return self._envia(404, {"erro": "inexistente"})
            dados = feed(doc).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/calendar; charset=utf-8")
            self.send_header("Content-Length", str(len(dados)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(dados)
            return
        self._envia(404, {"erro": "rota inexistente"})

    def do_PUT(self):
        rota = self.path.split("?", 1)[0]
        m = ROTA_ITEM.match(rota)
        if not m:
            return self._envia(404, {"erro": "rota inexistente"})
        pessoa, colecao, item_id = m.groups()

        def acao():
            item = valida(ESQUEMAS[colecao], self._corpo(), PADROES[colecao])
            item["id"] = item_id
            if colecao == "tarefas":
                if item["feito"] and not item["feitoEm"]:
                    item["feitoEm"] = datetime.date.today().isoformat()
                if not item["feito"]:
                    item["feitoEm"] = ""
            anterior = {}

            def muda(doc):
                lista = doc[colecao]
                for i, existente in enumerate(lista):
                    if existente.get("id") == item_id:
                        anterior.update(existente)
                        lista[i] = item
                        return
                lista.append(item)
            saida = altera(pessoa, muda)
            if colecao == "calendarios" and item["ativo"] and anterior.get("url") != item["url"]:
                atualiza_em_segundo_plano(pessoa, item)
            return saida
        return self._trata(acao)

    def do_POST(self):
        rota = self.path.split("?", 1)[0]
        m = ROTA_ATUALIZAR.match(rota)
        if m:
            pessoa, cid = m.groups()

            def acao():
                cal = next((c for c in le(pessoa)["calendarios"] if c["id"] == cid), None)
                if not cal:
                    raise NaoEncontrado("calendário inexistente")
                atualiza_calendario(pessoa, cal)
                return completo(le(pessoa))
            return self._trata(acao)
        m = ROTA_TOKEN.match(rota)
        if m:
            return self._trata(lambda: altera(m.group(1), lambda doc: doc.update(token=secrets.token_urlsafe(18))))
        self._envia(404, {"erro": "rota inexistente"})

    def do_DELETE(self):
        rota = self.path.split("?", 1)[0]
        m = ROTA_ITEM.match(rota)
        if not m:
            return self._envia(404, {"erro": "rota inexistente"})
        pessoa, colecao, item_id = m.groups()

        def muda(doc):
            doc[colecao] = [i for i in doc[colecao] if i.get("id") != item_id]
        saida = self._trata(lambda: altera(pessoa, muda))
        if colecao == "calendarios":
            with trava_externos:
                ext = le_externos(pessoa)
                if ext.pop(item_id, None) is not None:
                    grava_json(caminho_externos(pessoa), ext)
        return saida


# ---------- recarga automática (como na API de saúde) ----------
VIGIA_S = 15


def assinatura():
    arquivos = [os.path.abspath(__file__)]
    if os.path.isdir(INICIAL_DIR):
        arquivos += [os.path.join(INICIAL_DIR, n) for n in sorted(os.listdir(INICIAL_DIR)) if n.endswith(".json")]
    saida = []
    for arq in arquivos:
        try:
            st = os.stat(arq)
            saida.append((arq, st.st_mtime_ns, st.st_size))
        except OSError:
            pass
    return tuple(saida)


def pronto_para_recarregar(sig):
    try:
        with open(os.path.abspath(__file__), encoding="utf-8") as fh:
            compile(fh.read(), __file__, "exec")
        for arq, _, _ in sig[1:]:
            with open(arq, encoding="utf-8") as fh:
                json.load(fh)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"recarga adiada: {e!r}", file=sys.stderr)
        return False


def vigia():
    atual, pendente = assinatura(), None
    while True:
        threading.Event().wait(VIGIA_S)
        nova = assinatura()
        if nova == atual:
            pendente = None
        elif nova != pendente:
            pendente = nova
        elif pronto_para_recarregar(nova):
            print("arquivos da API mudaram: reiniciando", file=sys.stderr)
            sys.stderr.flush()
            with trava, trava_externos:
                os.execv(sys.executable, [sys.executable] + sys.argv)


def main():
    semeia()
    servidor = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"API da agenda em http://{BIND}:{PORT}, dados em {DADOS_DIR}", file=sys.stderr)
    threading.Thread(target=vigia, daemon=True).start()
    threading.Thread(target=atualiza_todos, daemon=True).start()
    servidor.serve_forever()


if __name__ == "__main__":
    main()
