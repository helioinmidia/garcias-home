// Acompanhamento Médico: uma aba por pessoa com o dia de hoje (tomadas, pesagem, proteína), próxima consulta,
// pendências, peso, medicamentos, exames, consultas e plano alimentar. Tudo fica gravado no servidor da casa
// (api/saude.py, publicada em /saude/api), nunca no navegador.
'use strict';

(function () {
  var API = 'api';
  var SINCRONIZA_MS = 15000;
  var VERSAO_MS = 5 * 60000;
  var DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  var DIAS_PLURAL = ['aos domingos', 'às segundas', 'às terças', 'às quartas', 'às quintas', 'às sextas', 'aos sábados'];
  var DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  var pessoas = [];
  var pessoaId = null;
  var doc = null; // documento da pessoa na tela
  var geracao = 0;
  var filtro = 'todas'; // modalidade escolhida na barra de filtro (ou 'todas')

  // ---------- utilidades ----------
  function $(id) { return document.getElementById(id); }
  // h('div', {class: 'x', onclick: fn}, filho, 'texto', [filhos]) cria elementos sem innerHTML (textos ficam escapados).
  function h(tag, attrs) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v; // só para SVG fixo deste arquivo
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) junta(n, arguments[i]);
    return n;
  }
  // Acrescenta filhos ignorando null/false (o append nativo escreveria "null" na tela).
  function add(n) { for (var i = 1; i < arguments.length; i++) junta(n, arguments[i]); return n; }
  function junta(n, filho) {
    if (filho == null || filho === false) return;
    if (Array.isArray(filho)) filho.forEach(function (f) { junta(n, f); });
    else n.append(filho.nodeType ? filho : String(filho));
  }
  function chave(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function hoje() { return chave(new Date()); }
  function deChave(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function somaDias(k, n) { var d = deChave(k); d.setDate(d.getDate() + n); return chave(d); }
  function diasEntre(a, b) { return Math.round((deChave(b) - deChave(a)) / 86400000); }
  function dataCurta(k) { if (!k) return ''; var p = k.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function dataDM(k) { var p = k.split('-'); return p[2] + '/' + p[1]; }
  function dataLonga(k) { var d = deChave(k); return DIAS[d.getDay()] + ', ' + d.getDate() + ' de ' + MESES[d.getMonth()]; }
  function kg(n) { return n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' kg'; }
  function novoId(base) {
    var s = (base || 'item').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
    return s + '-' + Date.now().toString(36);
  }
  function toast(msg) { var t = $('toast'); t.textContent = msg || ''; t.hidden = !msg; if (msg) setTimeout(function () { if (t.textContent === msg) t.hidden = true; }, 5000); }
  var ICONE_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  // ---------- servidor ----------
  function pede(metodo, caminho, corpo) {
    return fetch(API + caminho, {
      method: metodo, cache: 'no-store',
      headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.erro || 'HTTP ' + r.status);
        return j;
      });
    });
  }
  // Grava e redesenha com o documento que o servidor devolve.
  function grava(metodo, caminho, corpo) {
    geracao++;
    return pede(metodo, '/pessoa/' + pessoaId + caminho, corpo).then(function (novo) {
      if (novo.id === pessoaId) { doc = novo; desenha(); }
      return novo;
    }).catch(function (e) { toast('Não consegui salvar: ' + e.message); throw e; });
  }
  function sincroniza() {
    if (!pessoaId || document.hidden || $('dialogo').open) return;
    var gen = geracao, alvo = pessoaId;
    pede('GET', '/pessoa/' + alvo).then(function (novo) {
      if (alvo === pessoaId && gen === geracao && (!doc || novo.revisao !== doc.revisao)) { doc = novo; desenha(); }
    }).catch(function () { toast('Sem conexão com o servidor da casa.'); });
  }

  // ---------- regras ----------
  var FREQ = { diario: 'Todos os dias', semanal: 'Dias da semana', 'se-necessario': 'Quando necessário', 'a-definir': 'Frequência a definir' };
  function ativoEm(m, k) { return (!m.inicio || m.inicio <= k) && (!m.fim || m.fim >= k); }
  function tomaEm(m, k) {
    if (!ativoEm(m, k)) return false;
    if (m.frequencia === 'diario') return true;
    if (m.frequencia === 'semanal') return (m.diasDaSemana || []).indexOf(deChave(k).getDay()) >= 0;
    return false;
  }
  function tomou(m, k) { return !!((doc.tomadas || {})[k] || {})[m.id]; }
  function situacaoMed(m) {
    var k = hoje();
    if (m.fim && m.fim < k) return ['Encerrado', ''];
    if (m.inicio && m.inicio > k) return ['Começa em ' + dataCurta(m.inicio), 'info'];
    if (m.frequencia === 'a-definir') return ['Defina a frequência', 'aviso'];
    return ['Em uso', 'ok'];
  }
  function registrosPeso() {
    var r = doc.peso.registros || {};
    return Object.keys(r).sort().map(function (k) { return { data: k, kg: r[k].kg, nota: r[k].nota }; });
  }
  function proximaPesagem() {
    var dias = doc.peso.dias || [];
    if (!dias.length) return null;
    for (var i = 0; i < 8; i++) { var k = somaDias(hoje(), i); if (dias.indexOf(deChave(k).getDay()) >= 0) return k; }
    return null;
  }

  // ---------- modalidades (especialidades) ----------
  // Ordem fixa da paleta validada (azul, laranja, verde-água…); a cor segue a modalidade, nunca a posição no filtro.
  var CORES_MOD = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
  function modalidades() { return doc.modalidades || []; }
  function modalidade(id) { return modalidades().filter(function (m) { return m.id === id; })[0] || null; }
  function corMod(id) {
    var i = modalidades().map(function (m) { return m.id; }).indexOf(id);
    return i < 0 ? 'var(--muted)' : CORES_MOD[i % CORES_MOD.length];
  }
  // Itens das listas: só os da modalidade escolhida. Peso, proteína e plano sem modalidade aparecem sempre.
  function passa(item) { return filtro === 'todas' || (!!item && item.modalidade === filtro); }
  function passaOuSem(obj) { return filtro === 'todas' || !obj || !obj.modalidade || obj.modalidade === filtro; }
  function chipMod(id) {
    var m = filtro === 'todas' && modalidade(id);
    return m ? h('span', { class: 'chip mod', style: '--mod:' + corMod(id) }, m.nome) : null;
  }
  function nomeFiltro() { var m = modalidade(filtro); return m ? ' em ' + m.nome : ''; }

  // ---------- desenho ----------
  var CORES_PESSOA = ['var(--s5)', 'var(--s3)', 'var(--s1)', 'var(--s2)', 'var(--s6)', 'var(--s4)'];
  function iniciais(nome) {
    var p = String(nome).trim().split(/\s+/);
    return ((p[0] || '')[0] + (p.length > 1 ? p[p.length - 1][0] : (p[0] || '')[1] || '')).toUpperCase();
  }
  function desenhaPessoas() {
    var nav = $('pessoas');
    nav.textContent = '';
    pessoas.forEach(function (p, i) {
      add(nav, h('button', { type: 'button', role: 'tab', 'aria-selected': String(p.id === pessoaId), onclick: function () { escolhe(p.id); } },
        h('span', { class: 'avatar', style: '--av:' + CORES_PESSOA[i % CORES_PESSOA.length], 'aria-hidden': 'true' }, iniciais(p.nome)), p.nome));
    });
  }

  function desenha() {
    if (!doc) return;
    if (filtro !== 'todas' && !modalidade(filtro)) filtro = 'todas';
    var mostraPeso = doc.peso.ativo && passaOuSem(doc.peso);
    var mostraPlano = doc.plano && passaOuSem(doc.plano);
    var secoes = [['hoje-sec', 'Hoje'], ['prox-sec', 'Próximas consultas'], ['mod-sec', 'Modalidades']];
    if (mostraPeso) secoes.push(['peso-sec', 'Peso']);
    secoes.push(['meds-sec', 'Medicamentos'], ['exames-sec', 'Exames'], ['consultas-sec', 'Consultas'], ['pend-sec', 'Pendências'], ['docs-sec', 'Documentos']);
    if (mostraPlano) secoes.push(['plano-sec', 'Plano alimentar']);
    var nav = $('secoes');
    nav.textContent = '';
    secoes.forEach(function (s) { add(nav, h('a', { href: '#' + pessoaId + '/' + s[0] }, s[1])); });

    var pag = $('pagina');
    var rolagem = window.pageYOffset;
    pag.textContent = '';
    add(pag,
      barraFiltro(),
      h('div', { class: 'grade' }, cartaoHoje(), h('div', { class: 'coluna' }, cartaoConsulta(), cartaoModalidades())),
      mostraPeso ? cartaoPeso() : null,
      h('div', { class: 'grade' }, cartaoMedicamentos(), cartaoExames()),
      h('div', { class: 'grade' }, cartaoConsultas(), h('div', { class: 'coluna' }, cartaoPendencias(), cartaoDocumentos())),
      mostraPlano ? cartaoPlano() : null
    );
    window.scrollTo(0, rolagem);
  }

  // Barra de filtro: Todas · Medicina Esportiva · Urologia… (só aparece com duas modalidades ou mais).
  function barraFiltro() {
    if (modalidades().length < 2) return null;
    function botao(id, nome, cor) {
      return h('button', { type: 'button', 'aria-pressed': String(filtro === id), onclick: function () { filtro = id; desenha(); } },
        cor ? h('span', { class: 'ponto-mod', style: 'background:' + cor }) : null, nome);
    }
    return h('nav', { class: 'filtro', 'aria-label': 'Filtrar por modalidade' },
      botao('todas', 'Todas', null),
      modalidades().map(function (m) { return botao(m.id, m.nome, corMod(m.id)); }));
  }

  // Ícone e cor de cada cartão (decorativos: identificam a seção, não carregam dado).
  var ICONES = {
    'hoje-titulo': ['var(--s2)', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
    'prox-consulta': ['var(--s1)', '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h2M14 14h2M8 18h2"/>'],
    'mod-titulo': ['var(--s6)', '<path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15v1a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>'],
    'peso-titulo': ['var(--s3)', '<circle cx="12" cy="5" r="3"/><path d="M6.5 8a2 2 0 0 0-1.9 1.5L2.1 18.5A2 2 0 0 0 4 21h16a2 2 0 0 0 1.9-2.5L19.4 9.5A2 2 0 0 0 17.5 8Z"/>'],
    'meds-titulo': ['var(--s5)', '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>'],
    'exames-titulo': ['var(--s4)', '<path d="M14.5 2v17.5a2.5 2.5 0 0 1-5 0V2"/><path d="M8.5 2h7M14.5 16h-5"/>'],
    'consultas-titulo': ['var(--s1)', '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>'],
    'pend-titulo': ['var(--s3)', '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'],
    'docs-titulo': ['var(--s6)', '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>'],
    'plano-titulo': ['var(--s3)', '<path d="M12 21c1.5 0 2.7 1 4 1 3 0 6-8 6-12.2A4.9 4.9 0 0 0 17 5c-2.2 0-4 1.4-5 2-1-.6-2.8-2-5-2a4.9 4.9 0 0 0-5 4.8C2 14 5 22 8 22c1.3 0 2.5-1 4-1Z"/><path d="M10 2c1 .5 2 2 2 5"/>'],
  };
  function cabecalho(titulo, id, botao) {
    var ic = ICONES[id];
    return h('header', null,
      h('div', { class: 'tit' },
        ic ? h('span', { class: 'ico', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ic[1] + '</svg>' }) : null,
        h('h2', { id: id }, titulo)),
      botao || null);
  }
  // Cartão com a cor da seção na faixa do topo e no ícone.
  function cartao(id, tituloId, attrs) {
    var ic = ICONES[tituloId];
    return h('section', Object.assign({ class: 'cartao', id: id, style: ic ? '--cor:' + ic[0] : null }, attrs || {}));
  }

  // Hoje: o que tomar, pesagem do dia e proteína.
  function cartaoHoje() {
    var k = hoje();
    var meds = doc.medicamentos.filter(function (m) { return tomaEm(m, k); });
    var c = add(cartao('hoje-sec', 'hoje-titulo'), cabecalho('Hoje', 'hoje-titulo', h('span', { class: 'mudo' }, dataLonga(k))));
    if (meds.length) {
      var feitos = meds.filter(function (m) { return tomou(m, k); }).length;
      add(c, h('div', { class: 'resumo-dia' }, h('span', null, h('b', null, feitos + ' de ' + meds.length), ' tomados'),
        h('div', { class: 'barra' + (feitos === meds.length ? ' ok' : ''), role: 'progressbar', 'aria-valuenow': Math.round(feitos / meds.length * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('i', { style: 'width:' + Math.round(feitos / meds.length * 100) + '%' }))));
      meds.forEach(function (m) {
        var sim = tomou(m, k);
        var semana = h('div', { class: 'dias7', title: 'Últimos 7 dias' });
        for (var i = 6; i >= 0; i--) {
          var d = somaDias(k, -i);
          add(semana, h('i', { class: tomaEm(m, d) ? (tomou(m, d) ? 'sim' : '') : 'fora', title: dataDM(d) }));
        }
        add(c, h('div', { class: 'tomada' + (sim ? ' feito' : ''), style: modalidade(m.modalidade) ? '--mod:' + corMod(m.modalidade) : null },
          h('button', { type: 'button', class: 'check', role: 'checkbox', 'aria-checked': String(sim), 'aria-label': m.nome, html: ICONE_CHECK,
            onclick: function () { grava('PUT', '/tomada/' + k + '/' + m.id, { tomado: !sim }); } }),
          h('div', { class: 'txt' },
            h('div', { class: 'nome' }, h('b', null, m.nome), m.dose ? ' · ' + m.dose : ''),
            h('div', { class: 'item-linha' }, [m.quando || FREQ[m.frequencia], (modalidade(m.modalidade) || {}).nome].filter(Boolean).join(' · ')),
            semana)));
      });
    } else {
      add(c, h('p', { class: 'vazio' }, 'Nenhum medicamento com horário para hoje.'));
    }
    var aDefinir = doc.medicamentos.filter(function (m) { return m.frequencia === 'a-definir' && ativoEm(m, k); });
    if (aDefinir.length) {
      add(c, h('div', { class: 'alerta' }, h('b', null, 'Falta definir: '), aDefinir.map(function (m) { return m.nome; }).join(', '),
        '. Abra o item em Medicamentos e informe a dose e a frequência da receita.'));
    }
    if (doc.peso.ativo && passaOuSem(doc.peso) && (doc.peso.dias || []).indexOf(new Date().getDay()) >= 0 && !(doc.peso.registros || {})[k]) {
      add(c, h('div', { class: 'alerta' }, h('b', null, 'Dia de pesagem. '), doc.peso.instrucoes || '', ' ',
        h('a', { href: '#' + pessoaId + '/peso-sec' }, 'Registrar o peso')));
    }
    if (doc.proteina.ativo && passaOuSem(doc.proteina)) add(c, blocoProteina());
    return c;
  }

  function blocoProteina() {
    var k = hoje();
    var meta = doc.proteina.metaG || 0;
    var g = (doc.proteina.dias || {})[k] || 0;
    var pct = meta ? Math.min(100, Math.round((g / meta) * 100)) : 0;
    function soma(n) { grava('PUT', '/proteina/' + k, { g: Math.max(0, Math.min(1000, g + n)) }); }
    var semana = h('div', { class: 'prot-semana', 'aria-label': 'Proteína nos últimos 7 dias' });
    for (var i = 6; i >= 0; i--) {
      var d = somaDias(k, -i), v = (doc.proteina.dias || {})[d] || 0;
      add(semana, h('div', { title: dataDM(d) + ': ' + v + ' g' },
        h('span', { class: !v ? 'zero' : meta && v >= meta ? 'ok' : '', style: 'height:' + Math.max(2, Math.min(40, meta ? (v / meta) * 40 : 0)) + 'px' }),
        DIAS_CURTOS[deChave(d).getDay()]));
    }
    var R = 48, C = 2 * Math.PI * R, arco = (pct / 100) * C;
    var anel = '<svg class="anel' + (pct >= 100 ? ' ok' : '') + '" viewBox="0 0 120 120" role="img" aria-label="Proteína: ' + g + ' de ' + meta + ' gramas">' +
      '<defs><linearGradient id="grad-prot" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--s2)"/><stop offset="1" style="stop-color:var(--s5)"/></linearGradient></defs>' +
      '<circle class="trilho" cx="60" cy="60" r="' + R + '" fill="none" stroke-width="12"/>' +
      '<circle class="arco" cx="60" cy="60" r="' + R + '" fill="none" stroke-width="12" stroke-linecap="round" transform="rotate(-90 60 60)" stroke-dasharray="' + arco.toFixed(1) + ' ' + C.toFixed(1) + '"' + (pct ? '' : ' style="display:none"') + '/>' +
      '<text class="valor" x="60" y="62" text-anchor="middle">' + g + ' g</text>' +
      '<text class="de" x="60" y="80" text-anchor="middle">de ' + meta + ' g · ' + pct + '%</text></svg>';
    return h('div', { class: 'proteina' },
      h('div', { html: anel }),
      h('div', null,
        h('h3', null, 'Proteína de hoje'),
        h('div', { class: 'mudo' }, pct >= 100 ? 'Meta do dia atingida.' : 'Faltam ' + Math.max(0, meta - g) + ' g para a meta.'),
        h('div', { class: 'botoes' },
          [10, 20, 25, 30, 40].map(function (n) { return h('button', { type: 'button', class: 'btn mini', onclick: function () { soma(n); } }, '+' + n + ' g'); }),
          h('button', { type: 'button', class: 'btn mini', onclick: function () { soma(-10); } }, '−10 g'),
          h('button', { type: 'button', class: 'btn mini', onclick: function () { configProteina(); } }, 'Meta')),
        h('p', { class: 'mudo', style: 'margin:8px 0 0' }, 'Referência: 3 ovos ≈ 18 g · 100 g de frango ≈ 30 g · 1 dose de whey ≈ 20–25 g. Confira o rótulo.')),
      semana);
  }

  // Próximas consultas: um bloco por modalidade, com o retorno marcado e a última consulta realizada
  // (resumo e condutas), para ter à mão no retorno. Sem retorno, "Agendar retorno" copia os dados da última.
  function proximaDe(lista) {
    var k = hoje();
    return lista.filter(function (c) { return (c.status === 'agendada' || c.status === 'a-agendar') && (!c.data || c.data >= k); })
      .sort(function (a, b) { return (a.data || '9999') < (b.data || '9999') ? -1 : 1; })[0];
  }
  function ultimaRealizada(lista) {
    return lista.filter(function (c) { return c.status === 'realizada'; })
      .sort(function (a, b) { return (a.data || '') < (b.data || '') ? 1 : -1; })[0];
  }
  function retornoDe(ultima, mod) {
    return {
      modalidade: mod ? mod.id : (ultima && ultima.modalidade) || '',
      profissional: (ultima && ultima.profissional) || (mod && mod.profissional) || '',
      especialidade: (ultima && ultima.especialidade) || (mod && mod.nome) || '',
      local: (ultima && ultima.local) || (mod && mod.local) || '',
      status: 'a-agendar', data: '', hora: '',
      resumo: ultima && ultima.data ? 'Retorno da consulta de ' + dataCurta(ultima.data) + '.' : '',
    };
  }

  function cartaoConsulta() {
    var c = add(cartao('prox-sec', 'prox-consulta'), cabecalho('Próximas consultas', 'prox-consulta'));
    var grupos;
    if (filtro === 'todas' && modalidades().length) {
      grupos = modalidades().map(function (m) { return { mod: m, lista: doc.consultas.filter(function (x) { return x.modalidade === m.id; }) }; });
      var sem = doc.consultas.filter(function (x) { return !modalidade(x.modalidade); });
      if (sem.length) grupos.push({ mod: null, lista: sem });
    } else {
      grupos = [{ mod: modalidade(filtro), lista: doc.consultas.filter(passa) }];
    }
    grupos.forEach(function (g) { add(c, blocoProxima(g.mod, g.lista, grupos.length > 1)); });
    var pend = doc.pendencias.filter(function (x) { return passa(x) && !x.feito; }).length;
    var exames = doc.exames.filter(function (x) { return passa(x) && x.status !== 'feito'; }).length;
    if (pend || exames) add(c, h('p', { class: 'mudo', style: 'margin:12px 0 0' }, 'Em aberto: ', [pend ? pend + (pend === 1 ? ' pendência' : ' pendências') : null, exames ? exames + (exames === 1 ? ' exame por fazer' : ' exames por fazer') : null].filter(Boolean).join(' e '), '.'));
    return c;
  }

  function blocoProxima(mod, lista, comTitulo) {
    var p = proximaDe(lista), u = ultimaRealizada(lista);
    var b = h('div', { class: 'prox', style: mod ? '--mod:' + corMod(mod.id) : null });
    if (comTitulo) add(b, h('h3', null, h('span', { class: 'ponto-mod', style: 'background:' + (mod ? corMod(mod.id) : 'var(--muted)') }), mod ? mod.nome : 'Sem modalidade'));
    if (p) {
      var faltam = p.data ? diasEntre(hoje(), p.data) : null;
      add(b,
        h('div', { class: 'contagem' + (comTitulo ? ' menor' : '') }, faltam == null ? 'Sem data' : faltam === 0 ? 'Hoje' : faltam === 1 ? 'Amanhã' : faltam + ' dias', faltam != null && faltam > 1 ? h('small', null, ' para a consulta') : null),
        h('p', { style: 'margin:6px 0 0' }, h('b', null, p.profissional), p.especialidade ? ' · ' + p.especialidade : (modalidade(p.modalidade) ? ' · ' + modalidade(p.modalidade).nome : '')),
        h('p', { class: 'mudo', style: 'margin:2px 0 0' }, p.data ? dataLonga(p.data) + (p.hora ? ' às ' + p.hora : '') : 'Data a definir', p.local ? ' · ' + p.local : ''),
        h('p', { style: 'margin:8px 0 0' }, h('span', { class: 'chip ' + (p.status === 'agendada' ? 'ok' : 'aviso') }, p.status === 'agendada' ? 'Agendada' : p.data ? 'A agendar: data aproximada' : 'A agendar')),
        p.resumo ? h('p', { class: 'item-obs' }, p.resumo) : null,
        h('div', { class: 'botoes' }, h('button', { type: 'button', class: 'btn', onclick: function () { editaItem('consultas', p); } }, p.status === 'a-agendar' ? 'Marcar data e hora' : 'Editar')));
    } else {
      add(b, h('p', { class: 'vazio' }, 'Nenhum retorno marcado.'),
        h('div', { class: 'botoes' }, h('button', { type: 'button', class: 'btn', onclick: function () {
          editaItem('consultas', null, retornoDe(u, mod), 'Agendar retorno');
        } }, u ? 'Agendar retorno' : 'Adicionar consulta')));
    }
    if (u) {
      add(b, h('details', { class: 'resumo' },
        h('summary', null, 'Última consulta: ' + (u.data ? dataCurta(u.data) : 'sem data') + ' · ' + u.profissional),
        h('div', null, u.resumo || 'Sem resumo registrado.')));
    }
    return b;
  }

  // Peso: números, gráfico com as metas e registro.
  function cartaoPeso() {
    var cfg = doc.peso, regs = registrosPeso();
    var c = add(cartao('peso-sec', 'peso-titulo'), cabecalho('Peso', 'peso-titulo', h('button', { type: 'button', class: 'btn', onclick: configPeso }, 'Metas e dias')));
    var inicial = regs[0], atual = regs[regs.length - 1];
    var perda = inicial && atual ? inicial.kg - atual.kg : 0;
    var prox = proximaPesagem();
    add(c, h('div', { class: 'peso-topo' },
      h('div', { class: 'num', style: '--t:var(--s1)' }, h('small', null, 'Inicial'), h('b', null, inicial ? kg(inicial.kg) : '—'), inicial ? h('div', { class: 'mudo' }, dataCurta(inicial.data)) : null),
      h('div', { class: 'num', style: '--t:var(--s6)' }, h('small', null, 'Atual'), h('b', null, atual ? kg(atual.kg) : '—'), atual ? h('div', { class: 'mudo' }, dataCurta(atual.data)) : null),
      h('div', { class: 'num', style: '--t:' + (perda > 0 ? 'var(--ok)' : perda < 0 ? 'var(--bad)' : 'var(--line)') }, h('small', null, 'Variação'), h('b', { style: 'color:var(' + (perda > 0 ? '--ok' : perda < 0 ? '--bad' : '--text') + ')' }, regs.length > 1 ? (perda > 0 ? '−' : perda < 0 ? '+' : '') + kg(Math.abs(perda)) : '—')),
      h('div', { class: 'num', style: '--t:var(--s2)' }, h('small', null, 'Meta até ' + (cfg.prazo ? dataDM(cfg.prazo) : '—')),
        h('b', null, cfg.metaMinimaKg ? '−' + cfg.metaMinimaKg + ' a −' + (cfg.metaIdealKg || cfg.metaMinimaKg) + ' kg' : '—'),
        inicial && cfg.metaMinimaKg ? h('div', { class: 'mudo' }, perda >= cfg.metaIdealKg ? 'Meta ideal atingida' : perda >= cfg.metaMinimaKg ? 'Meta mínima atingida' : 'Faltam ' + kg(cfg.metaMinimaKg - perda) + ' para a mínima') : null)));
    add(c, grafico(regs, cfg));
    add(c, h('p', { class: 'mudo', style: 'margin:8px 0 0' },
      (cfg.dias || []).length ? 'Pesar ' + cfg.dias.map(function (d) { return DIAS_PLURAL[d]; }).join(' e ') + (prox ? ' (próxima: ' + (prox === hoje() ? 'hoje' : dataLonga(prox)) + ')' : '') + '. ' : '',
      cfg.instrucoes || ''));
    var dataIn = h('input', { type: 'date', value: hoje(), max: hoje(), 'aria-label': 'Data' });
    var kgIn = h('input', { type: 'text', class: 'kg', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,0', 'aria-label': 'Peso em kg' });
    var notaIn = h('input', { type: 'text', class: 'nota', maxlength: '300', placeholder: 'Observação (opcional)' });
    add(c, h('form', { class: 'form-linha', onsubmit: function (ev) {
      ev.preventDefault();
      var v = parseFloat(String(kgIn.value).replace(',', '.'));
      if (!(v >= 20 && v <= 400)) { toast('Informe o peso em kg, por exemplo 82,4.'); kgIn.focus(); return; }
      grava('PUT', '/peso/' + dataIn.value, { kg: v, nota: notaIn.value }).then(function () { toast('Peso registrado.'); });
    } },
      h('label', null, 'Data', dataIn), h('label', null, 'Peso (kg)', kgIn), h('label', null, 'Observação', notaIn),
      h('button', { type: 'submit', class: 'btn primario' }, 'Registrar')));
    if (regs.length) {
      var lista = h('ul', { class: 'lista', style: 'margin-top:12px' });
      regs.slice().reverse().forEach(function (r, i, arr) {
        var anterior = arr[i + 1];
        var dif = anterior ? r.kg - anterior.kg : null;
        add(lista, h('li', null,
          h('div', null, h('div', { class: 'item-titulo' }, kg(r.kg), dif != null ? h('span', { class: 'chip ' + (dif < 0 ? 'ok' : dif > 0 ? 'ruim' : '') }, (dif > 0 ? '+' : dif < 0 ? '−' : '') + kg(Math.abs(dif))) : null),
            h('div', { class: 'item-linha' }, dataLonga(r.data)), r.nota ? h('div', { class: 'item-obs' }, r.nota) : null),
          h('div', { class: 'acoes' }, h('button', { type: 'button', class: 'btn mini perigo', onclick: function () {
            if (confirm('Apagar o registro de ' + dataCurta(r.data) + '?')) grava('DELETE', '/peso/' + r.data);
          } }, 'Apagar'))));
      });
      add(c, lista);
    }
    return c;
  }

  function grafico(regs, cfg) {
    var W = 640, H = 220, E = 44, D = 12, T = 14, B = 26;
    var ini = cfg.inicio || (regs[0] && regs[0].data) || hoje();
    var fim = cfg.prazo || hoje();
    if (regs.length && regs[regs.length - 1].data > fim) fim = regs[regs.length - 1].data;
    if (regs.length && regs[0].data < ini) ini = regs[0].data;
    if (fim <= ini) fim = somaDias(ini, 28);
    var base = regs[0] ? regs[0].kg : null;
    var valores = regs.map(function (r) { return r.kg; });
    if (base != null) { valores.push(base - (cfg.metaIdealKg || 0), base - (cfg.metaMinimaKg || 0)); }
    var svg = '<svg class="grafico" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Gráfico do peso">' +
      '<defs><linearGradient id="grad-peso" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--s1);stop-opacity:0.28"/><stop offset="1" style="stop-color:var(--s1);stop-opacity:0"/></linearGradient></defs>';
    if (!regs.length) {
      svg += '<rect x="' + E + '" y="' + T + '" width="' + (W - E - D) + '" height="' + (H - T - B) + '" fill="none" class="eixo"/>';
      svg += '<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">Registre a primeira pesagem para ver o gráfico</text></svg>';
      return h('div', { html: svg });
    }
    var min = Math.floor(Math.min.apply(null, valores) - 0.5), max = Math.ceil(Math.max.apply(null, valores) + 0.5);
    var total = diasEntre(ini, fim);
    function x(k) { return E + (diasEntre(ini, k) / total) * (W - E - D); }
    function y(v) { return T + ((max - v) / (max - min)) * (H - T - B); }
    var passo = Math.max(1, Math.round((max - min) / 4));
    for (var v = min; v <= max; v += passo) {
      svg += '<line class="eixo" x1="' + E + '" x2="' + (W - D) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      svg += '<text x="' + (E - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    }
    svg += '<text x="' + E + '" y="' + (H - 6) + '">' + dataDM(ini) + '</text><text x="' + (W - D) + '" y="' + (H - 6) + '" text-anchor="end">' + dataDM(fim) + '</text>';
    if (hoje() > ini && hoje() < fim) svg += '<line class="hoje" x1="' + x(hoje()) + '" x2="' + x(hoje()) + '" y1="' + T + '" y2="' + (H - B) + '"/><text x="' + x(hoje()) + '" y="' + (H - 6) + '" text-anchor="middle">hoje</text>';
    if (cfg.metaMinimaKg) svg += '<line class="ref" x1="' + E + '" x2="' + (W - D) + '" y1="' + y(base - cfg.metaMinimaKg) + '" y2="' + y(base - cfg.metaMinimaKg) + '"/><text x="' + (W - D - 4) + '" y="' + (y(base - cfg.metaMinimaKg) - 5) + '" text-anchor="end">meta mínima −' + cfg.metaMinimaKg + ' kg</text>';
    if (cfg.metaIdealKg && cfg.metaIdealKg !== cfg.metaMinimaKg) svg += '<line class="ref-ideal" x1="' + E + '" x2="' + (W - D) + '" y1="' + y(base - cfg.metaIdealKg) + '" y2="' + y(base - cfg.metaIdealKg) + '"/><text x="' + (W - D - 4) + '" y="' + (y(base - cfg.metaIdealKg) - 5) + '" text-anchor="end">meta ideal −' + cfg.metaIdealKg + ' kg</text>';
    var pts = regs.map(function (r) { return x(r.data).toFixed(1) + ',' + y(r.kg).toFixed(1); });
    if (regs.length > 1) svg += '<path class="area" d="M' + pts[0].split(',')[0] + ',' + (H - B) + ' L' + pts.join(' L') + ' L' + pts[pts.length - 1].split(',')[0] + ',' + (H - B) + ' Z"/>';
    svg += '<polyline class="linha" points="' + pts.join(' ') + '"/>';
    regs.forEach(function (r, i) {
      var ultimo = i === regs.length - 1;
      svg += '<circle class="ponto" r="' + (ultimo ? 6 : 4.5) + '" cx="' + x(r.data).toFixed(1) + '" cy="' + y(r.kg).toFixed(1) + '"/>';
      if (ultimo) svg += '<text x="' + x(r.data).toFixed(1) + '" y="' + (y(r.kg) - 12).toFixed(1) + '" text-anchor="middle" style="fill:var(--text);font-weight:700">' + kg(r.kg) + '</text>';
      // Alvo de toque maior que o ponto, com a dica (data e peso).
      svg += '<circle class="alvo" r="14" cx="' + x(r.data).toFixed(1) + '" cy="' + y(r.kg).toFixed(1) + '"><title>' + dataCurta(r.data) + ': ' + kg(r.kg) + '</title></circle>';
    });
    return h('div', { html: svg + '</svg>' });
  }

  function botaoAdd(colecao, rotulo) {
    return h('button', { type: 'button', class: 'btn', onclick: function () { editaItem(colecao, null); } }, rotulo);
  }
  function botoesItem(colecao, item) {
    return h('div', { class: 'acoes' },
      h('button', { type: 'button', class: 'btn mini', onclick: function () { editaItem(colecao, item); } }, 'Editar'));
  }

  function cartaoMedicamentos() {
    var c = add(cartao('meds-sec', 'meds-titulo'), cabecalho('Medicamentos e suplementos', 'meds-titulo', botaoAdd('medicamentos', 'Adicionar')));
    var meds = doc.medicamentos.filter(passa);
    if (!meds.length) { add(c, h('p', { class: 'vazio' }, 'Nenhum medicamento cadastrado' + nomeFiltro() + '.')); return c; }
    var ordem = { 'Em uso': 0, 'Defina a frequência': 1 };
    var lista = h('ul', { class: 'lista' });
    meds.sort(function (a, b) {
      var sa = situacaoMed(a)[0], sb = situacaoMed(b)[0];
      return (ordem[sa] != null ? ordem[sa] : sa === 'Encerrado' ? 9 : 5) - (ordem[sb] != null ? ordem[sb] : sb === 'Encerrado' ? 9 : 5);
    }).forEach(function (m) {
      var sit = situacaoMed(m);
      var periodo = '';
      if (m.inicio && m.fim) {
        var total = diasEntre(m.inicio, m.fim) + 1, dia = diasEntre(m.inicio, hoje()) + 1;
        periodo = dataCurta(m.inicio) + ' a ' + dataCurta(m.fim) + (dia >= 1 && dia <= total ? ' · dia ' + dia + ' de ' + total : '');
      } else if (m.inicio) periodo = 'Desde ' + dataCurta(m.inicio);
      var freq = m.frequencia === 'semanal' && (m.diasDaSemana || []).length ? m.diasDaSemana.map(function (d) { return DIAS_CURTOS[d]; }).join(', ') : FREQ[m.frequencia];
      add(lista, h('li', null,
        h('div', null,
          h('div', { class: 'item-titulo' }, m.nome, h('span', { class: 'chip ' + sit[1] }, sit[0]), m.tipo === 'suplemento' ? h('span', { class: 'chip' }, 'Suplemento') : null, chipMod(m.modalidade)),
          h('div', { class: 'item-linha' }, [m.dose, m.quando, freq].filter(Boolean).join(' · ')),
          periodo ? h('div', { class: 'item-linha' }, periodo) : null,
          m.observacao ? h('div', { class: 'item-obs' }, m.observacao) : null),
        botoesItem('medicamentos', m)));
    });
    add(c, lista);
    return c;
  }

  var STATUS_EXAME = { pendente: ['Por fazer', 'aviso'], agendado: ['Agendado', 'info'], feito: ['Feito', 'ok'] };
  function cartaoExames() {
    var c = add(cartao('exames-sec', 'exames-titulo'), cabecalho('Exames', 'exames-titulo', botaoAdd('exames', 'Adicionar')));
    var exames = doc.exames.filter(passa);
    if (!exames.length) { add(c, h('p', { class: 'vazio' }, 'Nenhum exame cadastrado' + nomeFiltro() + '.')); return c; }
    var ordem = { pendente: 0, agendado: 1, feito: 2 };
    var lista = h('ul', { class: 'lista' });
    exames.sort(function (a, b) { return ordem[a.status] - ordem[b.status]; }).forEach(function (e) {
      var st = STATUS_EXAME[e.status] || STATUS_EXAME.pendente;
      add(lista, h('li', null,
        h('div', null,
          h('div', { class: 'item-titulo' }, e.nome, h('span', { class: 'chip ' + st[1] }, st[0]), chipMod(e.modalidade)),
          e.data || e.local ? h('div', { class: 'item-linha' }, [e.data ? dataCurta(e.data) : '', e.local].filter(Boolean).join(' · ')) : null,
          e.observacao ? h('div', { class: 'item-obs' }, e.observacao) : null),
        botoesItem('exames', e)));
    });
    add(c, lista);
    return c;
  }

  var STATUS_CONSULTA = { 'a-agendar': ['A agendar', 'aviso'], agendada: ['Agendada', 'info'], realizada: ['Realizada', 'ok'], cancelada: ['Cancelada', ''] };
  function cartaoConsultas() {
    var c = add(cartao('consultas-sec', 'consultas-titulo'), cabecalho('Consultas', 'consultas-titulo', botaoAdd('consultas', 'Adicionar')));
    var consultas = doc.consultas.filter(passa);
    if (!consultas.length) { add(c, h('p', { class: 'vazio' }, 'Nenhuma consulta registrada' + nomeFiltro() + '.')); return c; }
    var lista = h('ul', { class: 'lista' });
    consultas.sort(function (a, b) { return (b.data || '9999') < (a.data || '9999') ? -1 : 1; }).forEach(function (q) {
      var st = STATUS_CONSULTA[q.status] || STATUS_CONSULTA.agendada;
      add(lista, h('li', null,
        h('div', null,
          h('div', { class: 'item-titulo' }, q.profissional, h('span', { class: 'chip ' + st[1] }, st[0]), chipMod(q.modalidade)),
          h('div', { class: 'item-linha' }, [q.data ? dataCurta(q.data) + (q.hora ? ' ' + q.hora : '') : 'Sem data', q.especialidade, q.local].filter(Boolean).join(' · ')),
          q.resumo ? h('details', { class: 'resumo' }, h('summary', null, q.status === 'realizada' ? 'Resumo e condutas' : 'Observações'), h('div', null, q.resumo)) : null),
        botoesItem('consultas', q)));
    });
    add(c, lista);
    return c;
  }

  function cartaoPendencias() {
    var c = add(cartao('pend-sec', 'pend-titulo'), cabecalho('Pendências', 'pend-titulo'));
    var k = hoje();
    var itens = doc.pendencias.filter(passa).sort(function (a, b) {
      if (a.feito !== b.feito) return a.feito ? 1 : -1;
      return (a.prazo || '9999') < (b.prazo || '9999') ? -1 : 1;
    });
    if (!itens.length) add(c, h('p', { class: 'vazio' }, 'Nada pendente' + nomeFiltro() + '.'));
    itens.forEach(function (p) {
      var atrasada = !p.feito && p.prazo && p.prazo < k;
      add(c, h('div', { class: 'pend' + (p.feito ? ' feito' : '') },
        h('input', { type: 'checkbox', checked: p.feito, 'aria-label': p.texto, onchange: function (ev) {
          grava('PUT', '/pendencias/' + p.id, Object.assign({}, p, { feito: ev.target.checked }));
        } }),
        h('div', { class: 'txt' }, h('span', null, p.texto),
          p.prazo || chipMod(p.modalidade) ? h('div', { class: 'item-linha' }, p.prazo ? h('span', { class: 'chip ' + (atrasada ? 'ruim' : p.feito ? '' : 'info') }, (atrasada ? 'Atrasada · ' : 'Até ') + dataCurta(p.prazo)) : null, ' ', chipMod(p.modalidade)) : null),
        h('button', { type: 'button', class: 'btn mini', onclick: function () { editaItem('pendencias', p); } }, 'Editar')));
    });
    var novo = h('input', { type: 'text', maxlength: '300', placeholder: 'Nova pendência', 'aria-label': 'Nova pendência' });
    add(c, h('form', { class: 'form-linha', onsubmit: function (ev) {
      ev.preventDefault();
      var t = novo.value.trim();
      if (!t) return;
      grava('PUT', '/pendencias/' + novoId(t), { texto: t, prazo: '', feito: false, modalidade: filtro !== 'todas' ? filtro : '' });
    } }, h('div', { style: 'flex:1;min-width:200px' }, novo), h('button', { type: 'submit', class: 'btn primario' }, 'Adicionar')));
    return c;
  }

  function cartaoModalidades() {
    var c = add(cartao('mod-sec', 'mod-titulo'), cabecalho('Modalidades', 'mod-titulo', botaoAdd('modalidades', 'Adicionar')));
    if (!modalidades().length) {
      add(c, h('p', { class: 'vazio' }, 'Nenhuma modalidade. Cadastre as especialidades que acompanham esta pessoa, por exemplo Urologia, com o médico e o contato.'));
      return c;
    }
    var k = hoje();
    var lista = h('ul', { class: 'lista' });
    modalidades().forEach(function (m) {
      var meds = doc.medicamentos.filter(function (x) { return x.modalidade === m.id && ativoEm(x, k); }).length;
      var exames = doc.exames.filter(function (x) { return x.modalidade === m.id && x.status !== 'feito'; }).length;
      var pend = doc.pendencias.filter(function (x) { return x.modalidade === m.id && !x.feito; }).length;
      var resumo = [meds ? meds + (meds === 1 ? ' medicamento em uso' : ' medicamentos em uso') : null,
        exames ? exames + (exames === 1 ? ' exame por fazer' : ' exames por fazer') : null,
        pend ? pend + (pend === 1 ? ' pendência' : ' pendências') : null].filter(Boolean).join(' · ');
      add(lista, h('li', null,
        h('div', null,
          h('div', { class: 'item-titulo' }, h('span', { class: 'ponto-mod', style: 'background:' + corMod(m.id) }), m.nome),
          m.profissional || m.registro ? h('div', { class: 'item-linha' }, [m.profissional, m.registro].filter(Boolean).join(' · ')) : null,
          m.local ? h('div', { class: 'item-linha' }, m.local) : null,
          m.telefone ? h('div', { class: 'item-linha' }, h('a', { href: 'tel:' + m.telefone.replace(/[^\d+]/g, '') }, m.telefone)) : null,
          resumo ? h('div', { class: 'item-linha' }, resumo) : null,
          m.observacao ? h('div', { class: 'item-obs' }, m.observacao) : null),
        botoesItem('modalidades', m)));
    });
    add(c, lista);
    return c;
  }

  var TIPOS_DOC = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/heic': 'HEIC', 'image/webp': 'WEBP' };
  function tamanho(n) { return n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function cartaoDocumentos() {
    var c = add(cartao('docs-sec', 'docs-titulo'), cabecalho('Documentos', 'docs-titulo'));
    var docs = (doc.documentos || []).filter(passa).sort(function (a, b) { return (b.data || b.enviadoEm || '') < (a.data || a.enviadoEm || '') ? -1 : 1; });
    if (!docs.length) add(c, h('p', { class: 'vazio' }, 'Nenhum documento' + nomeFiltro() + '. Guarde aqui receitas, pedidos e resultados de exames (PDF ou foto).'));
    else {
      var lista = h('ul', { class: 'lista' });
      docs.forEach(function (d) {
        add(lista, h('li', null,
          h('div', null,
            h('div', { class: 'item-titulo' }, h('a', { href: API + '/pessoa/' + pessoaId + '/documento/' + d.id, target: '_blank', rel: 'noopener' }, d.nome), chipMod(d.modalidade)),
            h('div', { class: 'item-linha' }, [d.data ? dataCurta(d.data) : '', TIPOS_DOC[d.tipo] || '', tamanho(d.tamanho || 0)].filter(Boolean).join(' · '))),
          h('div', { class: 'acoes' }, h('button', { type: 'button', class: 'btn mini perigo', onclick: function () {
            if (confirm('Apagar o documento "' + d.nome + '"?')) grava('DELETE', '/documento/' + d.id);
          } }, 'Apagar'))));
      });
      add(c, lista);
    }
    var arq = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,image/heic,image/webp', 'aria-label': 'Arquivo' });
    var nome = h('input', { type: 'text', maxlength: '160', placeholder: 'Nome do documento', 'aria-label': 'Nome do documento' });
    var data = h('input', { type: 'date', 'aria-label': 'Data do documento' });
    var mod = seletorModalidade('modalidade', filtro !== 'todas' ? filtro : '');
    arq.onchange = function () { if (arq.files[0] && !nome.value) nome.value = arq.files[0].name.replace(/\.[^.]+$/, ''); };
    add(c, h('form', { class: 'form-doc', onsubmit: function (ev) {
      ev.preventDefault();
      var f = arq.files[0];
      if (!f) { toast('Escolha o arquivo.'); return; }
      if (!TIPOS_DOC[f.type]) { toast('Envie um PDF ou uma foto (JPG, PNG, HEIC ou WEBP).'); return; }
      if (f.size > 15 * 1048576) { toast('O arquivo passa de 15 MB.'); return; }
      geracao++;
      fetch(API + '/pessoa/' + pessoaId + '/documento/' + novoId(nome.value || f.name), {
        method: 'PUT', body: f,
        headers: { 'Content-Type': f.type, 'X-Nome': encodeURIComponent(nome.value.trim() || f.name), 'X-Modalidade': mod.value, 'X-Data': data.value },
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.erro || 'HTTP ' + r.status); return j; }); })
        .then(function (novo) { if (novo.id === pessoaId) { doc = novo; desenha(); } toast('Documento guardado.'); })
        .catch(function (e) { toast('Não consegui enviar: ' + e.message); });
    } },
      h('label', { class: 'campo' }, 'Arquivo (PDF ou foto)', arq),
      h('div', { class: 'duas' }, h('label', { class: 'campo' }, 'Nome', nome), h('label', { class: 'campo' }, 'Data', data)),
      modalidades().length ? h('label', { class: 'campo' }, 'Modalidade', mod) : null,
      h('div', null, h('button', { type: 'submit', class: 'btn primario' }, 'Guardar documento'))));
    return c;
  }

  function seletorModalidade(nome, valor) {
    return h('select', { name: nome },
      h('option', { value: '', selected: !valor }, 'Sem modalidade'),
      modalidades().map(function (m) { return h('option', { value: m.id, selected: m.id === valor }, m.nome); }));
  }

  // Prato: verde-água, laranja e azul (os três primeiros slots da paleta, validados em todos os pares).
  var CORES_PRATO = [['var(--s3)', true], ['var(--s2)', false], ['var(--s1)', false]];
  var TINTAS_REFEICAO = ['var(--s4)', 'var(--s2)', 'var(--s3)', 'var(--s5)', 'var(--s6)', 'var(--s1)'];
  function cartaoPlano() {
    var p = doc.plano;
    var c = add(cartao('plano-sec', 'plano-titulo'),
      cabecalho(p.titulo || 'Plano alimentar', 'plano-titulo', h('span', { class: 'mudo' }, [(modalidade(p.modalidade) || {}).nome, p.autor, p.data ? dataCurta(p.data) : ''].filter(Boolean).join(' · '))));
    if (p.objetivo) add(c, h('p', { class: 'objetivo' }, h('b', null, 'Objetivo: '), p.objetivo));
    var grade = h('div', { class: 'plano-grade' });
    (p.secoes || []).forEach(function (s, n) {
      var ul = h('ul');
      (s.itens || []).forEach(function (it) {
        if (typeof it === 'string') add(ul, h('li', null, it));
        else add(ul, h('li', null, it.texto, it.subitens ? h('ul', null, it.subitens.map(function (x) { return h('li', null, x); })) : null));
      });
      add(grade, h('div', { class: 'refeicao', style: '--tint:' + TINTAS_REFEICAO[n % TINTAS_REFEICAO.length] },
        h('h3', null, s.icone ? h('span', { class: 'emoji', 'aria-hidden': 'true' }, s.icone) : null, s.titulo),
        s.nota ? h('p', { class: 'nota' }, s.nota) : null,
        s.prato ? h('div', { class: 'prato', role: 'img', 'aria-label': s.prato.map(function (x) { return x.pct + '% ' + x.parte; }).join(', ') },
          s.prato.map(function (x, i) { var cor = CORES_PRATO[i % 3]; return h('span', { class: cor[1] ? 'escuro' : null, style: 'width:' + x.pct + '%;background:' + cor[0], title: x.parte }, x.pct + '%'); })) : null,
        s.prato ? h('div', { class: 'legenda-prato' }, s.prato.map(function (x, i) { return h('span', null, h('span', { class: 'ponto-mod', style: 'background:' + CORES_PRATO[i % 3][0] }), x.pct + '% ' + x.parte.toLowerCase()); })) : null,
        ul));
    });
    add(c, grade);
    if (p.fechamento) add(c, h('p', { class: 'item-obs', style: 'margin-top:14px' }, p.fechamento));
    return c;
  }

  // ---------- diálogo de edição ----------
  var CAMPOS = {
    medicamentos: { titulo: 'medicamento ou suplemento', campos: [
      ['modalidade', 'Modalidade', 'modalidade'],
      ['nome', 'Nome', 'texto', { obrigatorio: true }],
      ['tipo', 'Tipo', 'opcoes', { opcoes: [['medicamento', 'Medicamento'], ['suplemento', 'Suplemento']] }],
      ['dose', 'Dose', 'texto', { dica: 'Ex.: 40 mg, 5 g, 50.000 UI' }],
      ['quando', 'Quando tomar', 'texto', { dica: 'Ex.: pela manhã, em jejum' }],
      ['frequencia', 'Frequência', 'opcoes', { opcoes: [['diario', 'Todos os dias'], ['semanal', 'Em dias da semana'], ['se-necessario', 'Quando necessário'], ['a-definir', 'A definir']] }],
      ['diasDaSemana', 'Dias da semana', 'dias', { soSe: ['frequencia', 'semanal'] }],
      ['inicio', 'Início', 'data', { par: true }], ['fim', 'Fim', 'data', { par: true, dica: 'Vazio = uso contínuo' }],
      ['observacao', 'Observações', 'textoLongo'] ] },
    exames: { titulo: 'exame', campos: [
      ['modalidade', 'Modalidade', 'modalidade'],
      ['nome', 'Exame', 'texto', { obrigatorio: true }],
      ['status', 'Situação', 'opcoes', { opcoes: [['pendente', 'Por fazer'], ['agendado', 'Agendado'], ['feito', 'Feito']] }],
      ['data', 'Data', 'data', { par: true }], ['local', 'Local', 'texto', { par: true }],
      ['observacao', 'Observações e resultados', 'textoLongo'] ] },
    consultas: { titulo: 'consulta', campos: [
      ['modalidade', 'Modalidade', 'modalidade'],
      ['profissional', 'Profissional', 'texto', { obrigatorio: true }],
      ['especialidade', 'Especialidade', 'texto'],
      ['data', 'Data', 'data', { par: true }], ['hora', 'Hora', 'hora', { par: true }],
      ['local', 'Local', 'texto'],
      ['status', 'Situação', 'opcoes', { opcoes: [['a-agendar', 'A agendar'], ['agendada', 'Agendada'], ['realizada', 'Realizada'], ['cancelada', 'Cancelada']] }],
      ['resumo', 'Resumo, condutas e observações', 'textoLongo', { linhas: 8 }] ] },
    pendencias: { titulo: 'pendência', campos: [
      ['modalidade', 'Modalidade', 'modalidade'],
      ['texto', 'Pendência', 'texto', { obrigatorio: true }],
      ['prazo', 'Prazo', 'data'],
      ['feito', 'Feita', 'check'] ] },
    modalidades: { titulo: 'modalidade', campos: [
      ['nome', 'Modalidade', 'texto', { obrigatorio: true, dica: 'Ex.: Urologia, Medicina Esportiva, Pediatria' }],
      ['profissional', 'Médico ou profissional', 'texto'],
      ['registro', 'Registro', 'texto', { dica: 'Ex.: CRM 12345-PR · RQE 678' }],
      ['local', 'Local', 'texto'],
      ['telefone', 'Telefone', 'texto'],
      ['observacao', 'Observações', 'textoLongo'] ] },
  };

  function campoDe(nome, rotulo, tipo, op, valor) {
    op = op || {};
    var input;
    if (tipo === 'opcoes') {
      input = h('select', { name: nome }, op.opcoes.map(function (o) { return h('option', { value: o[0], selected: o[0] === valor }, o[1]); }));
    } else if (tipo === 'textoLongo') {
      input = h('textarea', { name: nome, rows: op.linhas || 4, maxlength: '6000' });
      input.value = valor || '';
    } else if (tipo === 'check') {
      return h('label', { class: 'campo campo-check' }, h('input', { type: 'checkbox', name: nome, checked: !!valor }), rotulo);
    } else if (tipo === 'dias') {
      var sel = valor || [];
      return h('div', { class: 'campo', 'data-campo': nome }, rotulo, h('div', { class: 'dias-semana' }, DIAS_CURTOS.map(function (d, i) {
        return h('label', null, h('input', { type: 'checkbox', name: nome, value: i, checked: sel.indexOf(i) >= 0 }), d);
      })));
    } else if (tipo === 'modalidade') {
      input = seletorModalidade(nome, valor);
      if (!modalidades().length) op = { dica: 'Cadastre as modalidades no cartão Modalidades.' };
    } else if (tipo === 'numero') {
      input = h('input', { name: nome, type: 'text', inputmode: 'decimal', autocomplete: 'off' });
      input.value = valor != null ? String(valor).replace('.', ',') : '';
    } else {
      input = h('input', { name: nome, type: tipo === 'data' ? 'date' : tipo === 'hora' ? 'time' : 'text', maxlength: '300', required: op.obrigatorio });
      input.value = valor || '';
    }
    return h('label', { class: 'campo', 'data-campo': nome }, rotulo + (op.obrigatorio ? ' *' : ''), input, op.dica ? h('small', null, op.dica) : null);
  }

  function abreDialogo(titulo, campos, valores, aoSalvar, aoApagar) {
    var form = $('dialogo-form');
    form.textContent = '';
    add(form, h('h2', null, titulo));
    var erro = h('p', { class: 'erro-form', hidden: true });
    var i = 0;
    while (i < campos.length) {
      var c = campos[i];
      if (c[3] && c[3].par && campos[i + 1]) {
        add(form, h('div', { class: 'duas' }, campoDe(c[0], c[1], c[2], c[3], valores[c[0]]), campoDe(campos[i + 1][0], campos[i + 1][1], campos[i + 1][2], campos[i + 1][3], valores[campos[i + 1][0]])));
        i += 2;
      } else { add(form, campoDe(c[0], c[1], c[2], c[3], valores[c[0]])); i++; }
    }
    function visibilidade() {
      campos.forEach(function (c) {
        var soSe = c[3] && c[3].soSe;
        if (!soSe) return;
        var alvo = form.querySelector('[data-campo="' + c[0] + '"]');
        var ctrl = form.elements[soSe[0]];
        if (alvo && ctrl) alvo.hidden = ctrl.value !== soSe[1];
      });
    }
    form.onchange = visibilidade;
    visibilidade();
    add(form, erro, h('div', { class: 'dialogo-acoes' },
      aoApagar ? h('button', { type: 'button', class: 'btn perigo', onclick: function () { if (confirm('Apagar este item?')) { aoApagar(); $('dialogo').close(); } } }, 'Apagar') : h('span'),
      h('span', { class: 'acoes' },
        h('button', { type: 'button', class: 'btn', onclick: function () { $('dialogo').close(); } }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn primario' }, 'Salvar'))));
    form.onsubmit = function (ev) {
      ev.preventDefault();
      var dados = {};
      campos.forEach(function (c) {
        if (c[2] === 'dias') dados[c[0]] = Array.prototype.filter.call(form.querySelectorAll('input[name="' + c[0] + '"]'), function (x) { return x.checked; }).map(function (x) { return +x.value; });
        else if (c[2] === 'check') dados[c[0]] = form.elements[c[0]].checked;
        else if (c[2] === 'numero') dados[c[0]] = parseFloat(String(form.elements[c[0]].value).replace(',', '.')) || 0;
        else dados[c[0]] = form.elements[c[0]].value;
      });
      var faltando = campos.filter(function (c) { return c[3] && c[3].obrigatorio && !String(dados[c[0]]).trim(); });
      if (faltando.length) { erro.textContent = 'Preencha: ' + faltando.map(function (c) { return c[1]; }).join(', '); erro.hidden = false; return; }
      erro.hidden = true;
      aoSalvar(dados).then(function () { $('dialogo').close(); }).catch(function (e) { erro.textContent = e.message; erro.hidden = false; });
    };
    $('dialogo').showModal();
    var primeiro = form.querySelector('input, select, textarea');
    if (primeiro && !('ontouchstart' in window)) primeiro.focus();
  }

  var NOVOS = {
    medicamentos: { tipo: 'medicamento', frequencia: 'diario' },
    exames: { status: 'pendente' },
    consultas: { status: 'agendada' },
    pendencias: { feito: false },
    modalidades: {},
  };
  // modelo: valores iniciais de um item novo (ex.: retorno copiado da última consulta).
  function editaItem(colecao, item, modelo, titulo) {
    var def = CAMPOS[colecao];
    var id = item ? item.id : null;
    var valores = item || Object.assign({ modalidade: filtro !== 'todas' ? filtro : '' }, NOVOS[colecao], modelo || {});
    abreDialogo(titulo || (item ? 'Editar ' : 'Adicionar ') + def.titulo, def.campos, valores, function (dados) {
      var nome = dados.nome || dados.texto || dados.profissional;
      return grava('PUT', '/' + colecao + '/' + (id || novoId(nome)), dados);
    }, item ? function () { grava('DELETE', '/' + colecao + '/' + id); } : null);
  }

  function configPeso() {
    var cfg = doc.peso;
    abreDialogo('Acompanhamento do peso', [
      ['ativo', 'Acompanhar o peso desta pessoa', 'check'],
      ['dias', 'Dias de pesagem', 'dias'],
      ['instrucoes', 'Como pesar', 'texto'],
      ['inicio', 'Início do período', 'data', { par: true }], ['prazo', 'Prazo da meta', 'data', { par: true }],
      ['metaMinimaKg', 'Meta mínima (kg a perder)', 'numero', { par: true }], ['metaIdealKg', 'Meta ideal (kg a perder)', 'numero', { par: true }],
      ['modalidade', 'Modalidade', 'modalidade'],
    ], cfg, function (d) { return grava('PUT', '/config/peso', d); });
  }
  function configProteina() {
    abreDialogo('Proteína diária', [
      ['ativo', 'Acompanhar a proteína desta pessoa', 'check'],
      ['metaG', 'Meta diária (g)', 'numero'],
      ['modalidade', 'Modalidade', 'modalidade'],
    ], doc.proteina, function (d) { return grava('PUT', '/config/proteina', d); });
  }

  // ---------- navegação ----------
  function escolhe(id) {
    if (id === pessoaId) return;
    pessoaId = id;
    doc = null;
    filtro = 'todas';
    try { localStorage.setItem('saude.pessoa', id); } catch (e) { /* só conveniência */ }
    if (location.hash.split('/')[0] !== '#' + id) history.replaceState(null, '', '#' + id);
    desenhaPessoas();
    $('pagina').textContent = '';
    $('pagina').append(h('p', { class: 'vazio' }, 'Carregando…'));
    geracao++;
    pede('GET', '/pessoa/' + id).then(function (novo) { if (id === pessoaId) { doc = novo; desenha(); vaiParaSecao(); } })
      .catch(function (e) { $('pagina').textContent = ''; $('pagina').append(h('p', { class: 'vazio' }, 'Não consegui carregar: ' + e.message)); });
  }
  function vaiParaSecao() {
    var partes = location.hash.slice(1).split('/');
    if (partes[1]) { var alvo = $(partes[1]); if (alvo) alvo.scrollIntoView({ behavior: 'smooth' }); }
  }

  var versoes = {};
  function confereVersao() {
    ['index.html', 'app.js', 'saude.css'].forEach(function (arq) {
      fetch(arq, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
        var tag = r.ok && (r.headers.get('ETag') || r.headers.get('Last-Modified'));
        if (!tag) return;
        if (versoes[arq] && versoes[arq] !== tag && !$('dialogo').open) location.reload();
        versoes[arq] = tag;
      }).catch(function () {});
    });
  }

  function inicia() {
    $('hoje').textContent = dataLonga(hoje());
    window.addEventListener('hashchange', function () {
      var id = location.hash.slice(1).split('/')[0];
      if (id && id !== pessoaId && pessoas.some(function (p) { return p.id === id; })) escolhe(id);
      else vaiParaSecao();
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sincroniza(); });
    pede('GET', '/pessoas').then(function (r) {
      pessoas = r.pessoas || [];
      if (!pessoas.length) { $('pagina').textContent = 'Nenhuma pessoa cadastrada.'; return; }
      var pedido = location.hash.slice(1).split('/')[0], salvo = null;
      try { salvo = localStorage.getItem('saude.pessoa'); } catch (e) { /* sem armazenamento */ }
      var existe = function (id) { return id && pessoas.some(function (p) { return p.id === id; }); };
      escolhe(existe(pedido) ? pedido : existe(salvo) ? salvo : pessoas[0].id);
      setInterval(sincroniza, SINCRONIZA_MS);
      setInterval(confereVersao, VERSAO_MS);
      confereVersao();
      // Virada do dia: o "Hoje" muda sozinho.
      var dia = hoje();
      setInterval(function () { if (hoje() !== dia) { dia = hoje(); $('hoje').textContent = dataLonga(dia); desenha(); } }, 30000);
    }).catch(function () {
      $('pagina').textContent = '';
      $('pagina').append(h('p', { class: 'vazio' }, 'Não consegui falar com o servidor da casa. Recarregue a página em instantes.'));
      setTimeout(function () { location.reload(); }, 30000);
    });
  }

  inicia();
})();
