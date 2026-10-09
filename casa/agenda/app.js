// Agenda: compromissos (com data e hora) e tarefas (com prazo), pessoais e profissionais, uma agenda por
// pessoa da casa. Junta os calendários do iPhone/Google (lidos pelo link privado, só leitura) e publica os
// da página num link que o iPhone assina. Tudo fica no servidor da casa (api/agenda.py, em /agenda/api).
'use strict';

(function () {
  var API = 'api';
  var SINCRONIZA_MS = 15000;
  var VERSAO_MS = 5 * 60000;
  var DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  var DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var CONTEXTOS = { pessoal: ['Pessoal', 'var(--pessoal)'], profissional: ['Profissional', 'var(--profissional)'] };
  var CORES_PESSOA = ['var(--s5)', 'var(--s3)', 'var(--s1)', 'var(--s2)', 'var(--s6)', 'var(--s4)'];

  var pessoas = [];
  var pessoaId = null;
  var doc = null;
  var geracao = 0;
  var vista = 'hoje';
  var contexto = 'todos'; // filtro: todos, pessoal ou profissional
  var semanaIni = null; // primeiro dia da semana na tela (Semana)
  var mesVisto = null; // 'AAAA-MM' (Mês)
  var diaEscolhido = null; // dia tocado no Mês

  // ---------- utilidades ----------
  function $(id) { return document.getElementById(id); }
  // h('div', {class: 'x', onclick: fn}, filho, 'texto', [filhos]): elementos sem innerHTML (textos escapados).
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
  function add(n) { for (var i = 1; i < arguments.length; i++) junta(n, arguments[i]); return n; }
  function junta(n, filho) {
    if (filho == null || filho === false) return;
    if (Array.isArray(filho)) { filho.forEach(function (f) { junta(n, f); }); return; }
    n.append(filho);
  }
  function chave(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function hoje() { return chave(new Date()); }
  function deChave(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function somaDias(k, n) { var d = deChave(k); d.setDate(d.getDate() + n); return chave(d); }
  function diasEntre(a, b) { return Math.round((deChave(b) - deChave(a)) / 86400000); }
  function dataCurta(k) { var p = k.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function dataDM(k) { var p = k.split('-'); return p[2] + '/' + p[1]; }
  function dataLonga(k) { var d = deChave(k); return DIAS[d.getDay()] + ', ' + d.getDate() + ' de ' + MESES[d.getMonth()]; }
  function nomeDia(k) {
    var n = diasEntre(hoje(), k);
    if (n === 0) return 'Hoje';
    if (n === 1) return 'Amanhã';
    if (n === -1) return 'Ontem';
    var d = deChave(k);
    return DIAS[d.getDay()].charAt(0).toUpperCase() + DIAS[d.getDay()].slice(1) + ', ' + d.getDate() + ' de ' + MESES[d.getMonth()];
  }
  function inicioSemana(k) { return somaDias(k, -((deChave(k).getDay() + 6) % 7)); } // semana começa na segunda
  function novoId(base) {
    var s = String(base || 'item').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
    return s + '-' + Date.now().toString(36);
  }
  function toast(msg) { var t = $('toast'); t.textContent = msg || ''; t.hidden = !msg; if (msg) setTimeout(function () { if (t.textContent === msg) t.hidden = true; }, 5000); }
  var ICONE_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICONE_IPHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>';

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
  function passaContexto(x) { return contexto === 'todos' || x.contexto === contexto; }
  function nomeCalendario(id) { var c = (doc.calendarios || []).filter(function (x) { return x.id === id; })[0]; return c ? c.nome : 'Calendário'; }

  // Datas em que um compromisso da página acontece entre 'de' e 'ate' (repetições incluídas).
  function datasDoEvento(e, de, ate) {
    var saida = [];
    if (!e.data) return saida;
    var dur = e.dataFim && e.dataFim > e.data ? diasEntre(e.data, e.dataFim) : 0;
    var limite = e.repeteAte && e.repeteAte < ate ? e.repeteAte : ate;
    if (!e.repete || e.repete === 'nao') {
      if (e.data <= ate && somaDias(e.data, dur) >= de) saida.push(e.data);
      return saida;
    }
    var d0 = deChave(e.data), n = 0, k = e.data;
    // Pula para perto da janela nas repetições diárias e semanais.
    if (e.repete === 'diario' && de > e.data) n = Math.max(0, diasEntre(e.data, de) - dur - 1);
    if (e.repete === 'semanal' && de > e.data) n = Math.max(0, Math.floor((diasEntre(e.data, de) - dur) / 7) - 1);
    for (var i = 0; i < 1500; i++, n++) {
      if (e.repete === 'diario') k = somaDias(e.data, n);
      else if (e.repete === 'semanal') k = somaDias(e.data, n * 7);
      else if (e.repete === 'mensal') {
        var m = new Date(d0.getFullYear(), d0.getMonth() + n, 1);
        if (d0.getDate() > new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()) continue; // dia 31 em mês curto
        m.setDate(d0.getDate()); k = chave(m);
      } else if (e.repete === 'anual') {
        var a = new Date(d0.getFullYear() + n, d0.getMonth(), d0.getDate());
        if (a.getMonth() !== d0.getMonth()) continue; // 29/02
        k = chave(a);
      }
      if (k > limite) break;
      if (somaDias(k, dur) >= de) saida.push(k);
    }
    return saida;
  }

  // Tudo o que acontece em cada dia de [de, ate]: {dia: [itens]} já ordenados (dia inteiro primeiro, depois pela hora).
  function porDia(de, ate) {
    var mapa = {};
    function poe(k, item) { if (k >= de && k <= ate) (mapa[k] = mapa[k] || []).push(item); }
    doc.eventos.filter(passaContexto).forEach(function (e) {
      datasDoEvento(e, de, ate).forEach(function (k) {
        var dur = e.dataFim && e.dataFim > e.data ? diasEntre(e.data, e.dataFim) : 0;
        for (var i = 0; i <= dur; i++) poe(somaDias(k, i), { tipo: 'evento', ev: e, inicio: k, fim: somaDias(k, dur), dia: i, total: dur + 1 });
      });
    });
    (doc.externos || []).filter(passaContexto).forEach(function (e) {
      var fim = e.dataFim || e.data, dur = diasEntre(e.data, fim);
      if (e.data > ate || fim < de) return;
      for (var i = 0; i <= dur; i++) poe(somaDias(e.data, i), { tipo: 'externo', ev: e, inicio: e.data, fim: fim, dia: i, total: dur + 1 });
    });
    doc.tarefas.filter(passaContexto).forEach(function (t) {
      if (t.prazo && !t.feito) poe(t.prazo, { tipo: 'tarefa', t: t });
    });
    Object.keys(mapa).forEach(function (k) { mapa[k].sort(ordemItens); });
    return mapa;
  }
  function ordemItens(a, b) {
    var ha = a.tipo === 'tarefa' ? (a.t.hora || '99:98') : (a.ev.diaInteiro || !a.ev.hora || a.dia > 0 ? '00:00' : a.ev.hora);
    var hb = b.tipo === 'tarefa' ? (b.t.hora || '99:98') : (b.ev.diaInteiro || !b.ev.hora || b.dia > 0 ? '00:00' : b.ev.hora);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  }
  function atrasadas() { return doc.tarefas.filter(function (t) { return passaContexto(t) && !t.feito && t.prazo && t.prazo < hoje(); }); }

  // ---------- desenho ----------
  function iniciais(nome) {
    var p = String(nome).trim().split(/\s+/);
    return ((p[0] || '')[0] + (p.length > 1 ? p[p.length - 1][0] : (p[0] || '')[1] || '')).toUpperCase();
  }
  function desenhaPessoas() {
    var nav = $('pessoas');
    nav.textContent = '';
    pessoas.forEach(function (p, i) {
      add(nav, h('button', { type: 'button', role: 'tab', 'aria-selected': String(p.id === pessoaId), onclick: function () { escolhe(p.id); } },
        h('span', { class: 'avatar', style: '--av:' + CORES_PESSOA[i % CORES_PESSOA.length], 'aria-hidden': 'true' }, iniciais(p.nome)),
        h('span', { class: 'nome-longo' }, p.nome), h('span', { class: 'nome-curto', 'aria-hidden': 'true' }, p.nome.length <= 8 ? p.nome : p.nome.split(' ')[0])));
    });
  }

  var ICONES = {
    hoje: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    semana: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M7 14h10M7 18h6"/>',
    mes: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
    tarefas: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    calendarios: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  };
  function icone(id) { return h('span', { class: 'ico', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONES[id] + '</svg>' }); }

  function vistas() {
    var k = hoje(), mapa = porDia(k, k);
    var hojeN = (mapa[k] || []).length + atrasadas().length;
    var pend = doc.tarefas.filter(function (t) { return passaContexto(t) && !t.feito && t.prazo && t.prazo <= k; }).length;
    var erros = Object.keys(doc.situacaoCalendarios || {}).filter(function (id) { return doc.situacaoCalendarios[id].erro; }).length;
    return [
      ['hoje', 'Hoje', cartaoHoje, hojeN, 'info'],
      ['semana', 'Semana', cartaoSemana, 0],
      ['mes', 'Mês', cartaoMes, 0],
      ['tarefas', 'Tarefas', cartaoTarefas, pend, 'ruim'],
      ['calendarios', 'Calendários', cartaoCalendarios, erros, 'ruim'],
    ];
  }

  function desenha() {
    if (!doc) return;
    var lista = vistas();
    var atual = lista.filter(function (v) { return v[0] === vista; })[0] || lista[0];
    vista = atual[0];
    function contador(v) { return v[3] ? h('span', { class: 'aba-n ' + (v[4] || '') }, v[3]) : null; }
    var menu = $('menu');
    menu.textContent = '';
    add(menu, h('section', { class: 'bloco' }, h('ul', null, lista.map(function (v) {
      return h('li', null, h('button', { type: 'button', 'aria-current': v[0] === vista ? 'page' : null, onclick: function () { trocaVista(v[0]); } },
        h('span', null, icone(v[0]), v[1]), contador(v)));
    }))), botoesNovo('menu-novo'));
    var nav = $('secoes');
    nav.textContent = '';
    add(nav, h('div', { class: 'secoes-linha' }, lista.map(function (v) {
      return h('button', { type: 'button', class: 'aba', 'aria-selected': String(v[0] === vista), onclick: function () { trocaVista(v[0]); } },
        v[0] === 'calendarios' ? [h('span', { class: 'sr' }, v[1]), icone('calendarios')] : v[1], contador(v));
    })));
    var pag = $('pagina');
    var rolagem = window.pageYOffset;
    pag.textContent = '';
    add(pag, vista !== 'calendarios' ? barraContexto() : null, atual[2]());
    window.scrollTo(0, rolagem);
  }
  function trocaVista(nova) {
    if (nova === vista) return;
    vista = nova;
    history.replaceState(null, '', '#' + pessoaId + '/' + vista);
    desenha();
    window.scrollTo(0, 0);
  }
  function botoesNovo(classe) {
    return h('div', { class: 'novo ' + (classe || '') },
      h('button', { type: 'button', class: 'btn primario', onclick: function () { editaEvento(null); } }, '+ Compromisso'),
      h('button', { type: 'button', class: 'btn', onclick: function () { editaTarefa(null); } }, '+ Tarefa'));
  }
  function barraContexto() {
    function botao(id, nome, cor) {
      return h('button', { type: 'button', 'aria-pressed': String(contexto === id), onclick: function () {
        contexto = id;
        try { localStorage.setItem('agenda.contexto', id); } catch (e) { /* só conveniência */ }
        desenha();
      } }, cor ? h('span', { class: 'ponto', style: 'background:' + cor }) : null, nome);
    }
    return h('div', { class: 'topo-pagina' },
      h('nav', { class: 'filtro', 'aria-label': 'Pessoal ou profissional' },
        botao('todos', 'Tudo', null), botao('pessoal', 'Pessoal', CONTEXTOS.pessoal[1]), botao('profissional', 'Profissional', CONTEXTOS.profissional[1])),
      botoesNovo('so-estreito'));
  }

  function cartao(titulo, extra) {
    return h('section', { class: 'cartao' }, h('header', null, h('h2', null, titulo), extra || null));
  }

  // Uma linha de compromisso ou tarefa. k: o dia em que ela aparece.
  function linhaItem(it, k, opcoes) {
    opcoes = opcoes || {};
    if (it.tipo === 'tarefa') return linhaTarefa(it.t, opcoes);
    var e = it.ev, externo = it.tipo === 'externo';
    var quando;
    if (e.diaInteiro || !e.hora) quando = it.total > 1 ? 'dia ' + (it.dia + 1) + ' de ' + it.total : 'dia todo';
    else if (it.total > 1 && it.dia > 0) quando = k === it.fim ? 'até ' + (e.horaFim || '') : 'continua';
    else quando = e.hora + (e.horaFim && e.horaFim !== e.hora && it.total === 1 ? '–' + e.horaFim : '');
    var detalhes = [e.local, externo ? nomeCalendario(e.calendario) : (e.repete && e.repete !== 'nao' ? REPETE[e.repete] : '')].filter(Boolean).join(' · ');
    return h('li', { class: 'item' + (externo ? ' externo' : ''), style: '--ctx:' + CONTEXTOS[e.contexto || 'pessoal'][1] },
      h('button', { type: 'button', class: 'item-btn', onclick: function () { externo ? mostraExterno(e) : editaEvento(e); } },
        h('span', { class: 'item-hora' }, quando),
        h('span', { class: 'item-txt' },
          h('b', null, e.titulo),
          detalhes ? h('small', null, externo ? h('span', { class: 'ico-ext', 'aria-label': 'do calendário do iPhone', html: ICONE_IPHONE }) : null, detalhes) : null)));
  }
  var PRIORIDADE = { alta: ['Alta', 'ruim'], normal: null, baixa: ['Baixa', ''] };
  function linhaTarefa(t, opcoes) {
    opcoes = opcoes || {};
    var atrasada = !t.feito && t.prazo && t.prazo < hoje();
    var prazo = !t.prazo ? '' : atrasada ? 'atrasada · ' + dataDM(t.prazo) : opcoes.comData ? nomeDia(t.prazo) + (t.hora ? ' · ' + t.hora : '') : (t.hora ? 'até ' + t.hora : '');
    var pr = PRIORIDADE[t.prioridade];
    return h('li', { class: 'item tarefa' + (t.feito ? ' feita' : '') + (atrasada ? ' atrasada' : ''), style: '--ctx:' + CONTEXTOS[t.contexto || 'pessoal'][1] },
      h('button', { type: 'button', class: 'check', role: 'checkbox', 'aria-checked': String(!!t.feito), 'aria-label': (t.feito ? 'Desmarcar ' : 'Concluir ') + t.titulo,
        html: ICONE_CHECK, onclick: function () { grava('PUT', '/tarefas/' + t.id, Object.assign({}, t, { feito: !t.feito, feitoEm: '' })); } }),
      h('button', { type: 'button', class: 'item-btn', onclick: function () { editaTarefa(t); } },
        h('span', { class: 'item-txt' },
          h('b', null, t.titulo, pr ? h('span', { class: 'chip ' + pr[1] }, pr[0]) : null),
          prazo || t.observacao ? h('small', { class: atrasada ? 'atraso' : null }, [prazo, t.observacao ? t.observacao.split('\n')[0] : ''].filter(Boolean).join(' · ')) : null)));
  }

  // Hoje: compromissos do dia, tarefas para hoje (e atrasadas) e uma prévia de amanhã.
  function cartaoHoje() {
    var k = hoje(), amanha = somaDias(k, 1);
    var mapa = porDia(k, amanha);
    var c = cartao(nomeDia(k) + ', ' + deChave(k).getDate() + ' de ' + MESES[deChave(k).getMonth()]);
    var doDia = (mapa[k] || []).filter(function (it) { return it.tipo !== 'tarefa'; });
    var tarefas = atrasadas().map(function (t) { return { tipo: 'tarefa', t: t }; }).concat((mapa[k] || []).filter(function (it) { return it.tipo === 'tarefa'; }));
    add(c, h('h3', null, 'Compromissos'));
    add(c, doDia.length ? h('ul', { class: 'itens' }, doDia.map(function (it) { return linhaItem(it, k); })) : h('p', { class: 'vazio' }, 'Nenhum compromisso hoje.'));
    add(c, h('h3', null, 'Tarefas para hoje'));
    add(c, tarefas.length ? h('ul', { class: 'itens' }, tarefas.map(function (it) { return linhaItem(it, k); })) : h('p', { class: 'vazio' }, 'Nada com prazo para hoje.'));
    var semPrazo = doc.tarefas.filter(function (t) { return passaContexto(t) && !t.feito && !t.prazo; }).length;
    if (semPrazo) add(c, h('p', { class: 'mudo' }, h('a', { href: '#' + pessoaId + '/tarefas' }, semPrazo + (semPrazo === 1 ? ' tarefa sem prazo' : ' tarefas sem prazo')), ' na lista de tarefas.'));
    var deAmanha = mapa[amanha] || [];
    if (deAmanha.length) {
      add(c, h('h3', null, 'Amanhã'), h('ul', { class: 'itens compacto' }, deAmanha.map(function (it) { return linhaItem(it, amanha); })));
    }
    return c;
  }

  // Semana: segunda a domingo, dia a dia.
  function cartaoSemana() {
    var ini = semanaIni || inicioSemana(hoje()), fim = somaDias(ini, 6);
    var mapa = porDia(ini, fim);
    var c = cartao('Semana de ' + dataDM(ini) + ' a ' + dataDM(fim), navegacao(
      function () { semanaIni = somaDias(ini, -7); desenha(); },
      function () { semanaIni = null; desenha(); },
      function () { semanaIni = somaDias(ini, 7); desenha(); }, ini === inicioSemana(hoje()) ? null : 'Esta semana'));
    var grade = h('div', { class: 'semana' });
    for (var i = 0; i < 7; i++) {
      var k = somaDias(ini, i), itens = mapa[k] || [];
      add(grade, h('section', { class: 'dia' + (k === hoje() ? ' hoje' : '') + (k < hoje() ? ' passado' : '') },
        h('h3', null, h('span', null, DIAS_CURTOS[deChave(k).getDay()]), h('b', null, String(deChave(k).getDate()))),
        itens.length ? h('ul', { class: 'itens compacto' }, itens.map((function (dia) { return function (it) { return linhaItem(it, dia); }; })(k))) : h('p', { class: 'vazio' }, '—')));
    }
    add(c, grade);
    return c;
  }
  function navegacao(antes, atual, depois, rotuloAtual) {
    return h('div', { class: 'nav-datas' },
      h('button', { type: 'button', class: 'btn mini', 'aria-label': 'Anterior', onclick: antes }, '‹'),
      rotuloAtual ? h('button', { type: 'button', class: 'btn mini', onclick: atual }, rotuloAtual) : null,
      h('button', { type: 'button', class: 'btn mini', 'aria-label': 'Próxima', onclick: depois }, '›'));
  }

  // Mês: grade com os compromissos de cada dia; tocar num dia mostra a lista dele embaixo.
  function cartaoMes() {
    var mes = mesVisto || hoje().slice(0, 7);
    var primeiro = mes + '-01', ini = inicioSemana(primeiro);
    var d1 = deChave(primeiro), ultimo = chave(new Date(d1.getFullYear(), d1.getMonth() + 1, 0));
    var fim = somaDias(inicioSemana(ultimo), 6);
    var mapa = porDia(ini, fim);
    function mudaMes(n) { var d = new Date(d1.getFullYear(), d1.getMonth() + n, 1); mesVisto = chave(d).slice(0, 7); diaEscolhido = null; desenha(); }
    var titulo = MESES[d1.getMonth()].charAt(0).toUpperCase() + MESES[d1.getMonth()].slice(1) + ' de ' + d1.getFullYear();
    var c = cartao(titulo, navegacao(function () { mudaMes(-1); }, function () { mesVisto = null; diaEscolhido = null; desenha(); }, function () { mudaMes(1); },
      mes === hoje().slice(0, 7) ? null : 'Este mês'));
    var grade = h('div', { class: 'mes', role: 'grid' }, ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map(function (d) { return h('div', { class: 'mes-cab' }, d); }));
    var escolhido = diaEscolhido || (mes === hoje().slice(0, 7) ? hoje() : primeiro);
    for (var k = ini; k <= fim; k = somaDias(k, 1)) {
      var itens = mapa[k] || [];
      add(grade, h('button', { type: 'button', class: 'mes-dia' + (k.slice(0, 7) !== mes ? ' fora' : '') + (k === hoje() ? ' hoje' : '') + (k === escolhido ? ' escolhido' : ''),
        'aria-label': dataLonga(k) + (itens.length ? ', ' + itens.length + (itens.length === 1 ? ' item' : ' itens') : ''),
        onclick: (function (dia) { return function () { diaEscolhido = dia; desenha(); }; })(k) },
        h('span', { class: 'mes-n' }, String(deChave(k).getDate())),
        h('span', { class: 'mes-itens' }, itens.slice(0, 3).map(function (it) {
          var e = it.ev || it.t;
          return h('span', { class: 'mes-item' + (it.tipo === 'tarefa' ? ' tarefa' : ''), style: '--ctx:' + CONTEXTOS[e.contexto || 'pessoal'][1] },
            it.tipo === 'tarefa' ? '☐ ' + e.titulo : (e.hora && !e.diaInteiro && it.dia === 0 ? e.hora + ' ' : '') + e.titulo);
        }), itens.length > 3 ? h('span', { class: 'mes-mais' }, '+' + (itens.length - 3)) : null),
        h('span', { class: 'mes-pontos', 'aria-hidden': 'true' }, itens.slice(0, 4).map(function (it) {
          var e = it.ev || it.t;
          return h('i', { style: 'background:' + CONTEXTOS[e.contexto || 'pessoal'][1] });
        }))));
    }
    add(c, grade);
    var doDia = mapa[escolhido] || [];
    add(c, h('h3', null, nomeDia(escolhido)),
      doDia.length ? h('ul', { class: 'itens' }, doDia.map(function (it) { return linhaItem(it, escolhido); })) : h('p', { class: 'vazio' }, 'Nada neste dia.'),
      h('div', { class: 'botoes' }, h('button', { type: 'button', class: 'btn mini', onclick: function () { editaEvento(null, { data: escolhido }); } }, '+ Compromisso neste dia')));
    return c;
  }

  // Tarefas: atrasadas, hoje, próximos 7 dias, depois e sem prazo; as feitas ficam recolhidas.
  function cartaoTarefas() {
    var k = hoje(), semana = somaDias(k, 7);
    var abertas = doc.tarefas.filter(function (t) { return passaContexto(t) && !t.feito; });
    var ordem = { alta: 0, normal: 1, baixa: 2 };
    abertas.sort(function (a, b) { return (a.prazo || '9999') < (b.prazo || '9999') ? -1 : (a.prazo || '9999') > (b.prazo || '9999') ? 1 : ordem[a.prioridade] - ordem[b.prioridade]; });
    var grupos = [
      ['Atrasadas', abertas.filter(function (t) { return t.prazo && t.prazo < k; })],
      ['Hoje', abertas.filter(function (t) { return t.prazo === k; })],
      ['Próximos 7 dias', abertas.filter(function (t) { return t.prazo > k && t.prazo <= semana; })],
      ['Depois', abertas.filter(function (t) { return t.prazo > semana; })],
      ['Sem prazo', abertas.filter(function (t) { return !t.prazo; })],
    ];
    var c = cartao('Tarefas', h('button', { type: 'button', class: 'btn', onclick: function () { editaTarefa(null); } }, '+ Tarefa'));
    if (!abertas.length) add(c, h('p', { class: 'vazio' }, 'Nenhuma tarefa em aberto.'));
    grupos.forEach(function (g) {
      if (!g[1].length) return;
      add(c, h('h3', { class: g[0] === 'Atrasadas' ? 'atraso' : null }, g[0] + ' · ' + g[1].length),
        h('ul', { class: 'itens' }, g[1].map(function (t) { return linhaTarefa(t, { comData: g[0] !== 'Hoje' }); })));
    });
    var feitas = doc.tarefas.filter(function (t) { return passaContexto(t) && t.feito; })
      .sort(function (a, b) { return (a.feitoEm || '') < (b.feitoEm || '') ? 1 : -1; });
    if (feitas.length) {
      add(c, h('details', { class: 'feitas' }, h('summary', null, 'Feitas · ' + feitas.length),
        h('ul', { class: 'itens' }, feitas.slice(0, 50).map(function (t) { return linhaTarefa(t, { comData: true }); }))));
    }
    return c;
  }

  // iPhone e Google: calendários lidos pelo link privado e o link para o iPhone assinar a agenda da página.
  function cartaoCalendarios() {
    var c = cartao('Calendários do iPhone e do Google', h('button', { type: 'button', class: 'btn', onclick: function () { editaCalendario(null); } }, '+ Calendário'));
    add(c, h('p', { class: 'mudo' }, 'Os compromissos destes calendários aparecem na agenda (só leitura; edite no app Calendário). A página baixa cada um a cada 15 minutos.'));
    var cals = doc.calendarios || [];
    if (!cals.length) add(c, h('p', { class: 'vazio' }, 'Nenhum calendário ligado.'));
    else add(c, h('ul', { class: 'cals' }, cals.map(function (cal) {
      var sit = (doc.situacaoCalendarios || {})[cal.id];
      var estado = !cal.ativo ? ['Pausado', ''] : !sit ? ['Baixando…', 'info'] : sit.erro ? ['Erro', 'ruim'] : ['Ligado', 'ok'];
      return h('li', { style: '--ctx:' + CONTEXTOS[cal.contexto][1] },
        h('div', null,
          h('b', null, cal.nome, h('span', { class: 'chip ' + estado[1] }, estado[0])),
          h('small', null, CONTEXTOS[cal.contexto][0] + (sit && sit.atualizadoEm ? ' · ' + sit.total + (sit.total === 1 ? ' compromisso' : ' compromissos') + ' · atualizado ' + sit.atualizadoEm.slice(11, 16) + ' de ' + dataDM(sit.atualizadoEm.slice(0, 10)) : '')),
          sit && sit.erro ? h('small', { class: 'atraso' }, sit.erro) : null),
        h('div', { class: 'acoes' },
          h('button', { type: 'button', class: 'btn mini', onclick: function (ev) {
            ev.target.disabled = true;
            grava('POST', '/calendarios/' + cal.id + '/atualizar').then(function () { toast('Calendário atualizado.'); }, function () {});
          } }, 'Atualizar'),
          h('button', { type: 'button', class: 'btn mini', onclick: function () { editaCalendario(cal); } }, 'Editar')));
    })));
    add(c, h('details', { class: 'ajuda' }, h('summary', null, 'Como pegar o link do calendário'),
      h('ul', null,
        h('li', null, h('b', null, 'iPhone (iCloud): '), 'app Calendário → Calendários → ⓘ ao lado do calendário → ative "Calendário Público" → "Compartilhar Link" → Copiar. O link começa com webcal://.'),
        h('li', null, h('b', null, 'Google: '), 'calendar.google.com no computador → Configurações → escolha o calendário → "Endereço secreto no formato iCal" → copiar.'),
        h('li', null, h('b', null, 'Outlook: '), 'Configurações → Calendário → Calendários compartilhados → Publicar um calendário → link ICS.'),
        h('li', null, 'Quem tem o link vê os compromissos: guarde-o só aqui.'))));
    // Assinatura: o iPhone mostra os compromissos e tarefas criados na página.
    var link = location.protocol + '//' + location.host + '/agenda/api/pessoa/' + pessoaId + '/feed/' + doc.token + '.ics';
    var campo = h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Link de assinatura', onclick: function (ev) { ev.target.select(); } });
    var d = cartao('Ver esta agenda no iPhone');
    add(d,
      h('p', { class: 'mudo' }, 'Os compromissos e as tarefas com prazo criados aqui aparecem no app Calendário do iPhone, num calendário separado ("Agenda da casa").'),
      h('div', { class: 'copia' }, campo, h('button', { type: 'button', class: 'btn', onclick: function () {
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { toast('Link copiado.'); }, function () { campo.select(); document.execCommand('copy'); toast('Link copiado.'); });
      } }, 'Copiar')),
      h('ol', { class: 'passos' },
        h('li', null, 'No iPhone: Ajustes → Apps → Calendário → Contas de Calendário → Adicionar Conta → Outra → ', h('b', null, 'Adicionar Calendário Assinado'), '.'),
        h('li', null, 'Cole o link e toque em Seguinte. Em "Remover Alarmes", deixe desligado para receber os lembretes.'),
        h('li', null, 'Em Contas → Obter Dados, escolha "A cada 15 minutos" para as mudanças chegarem logo.')),
      h('p', { class: 'mudo' }, 'O iPhone só atualiza este calendário no Wi-Fi de casa (o servidor não fica na internet); fora de casa ele mostra o que já tinha baixado.'),
      h('div', { class: 'botoes' }, h('button', { type: 'button', class: 'btn mini perigo', onclick: function () {
        if (confirm('Trocar o link? Quem assinou o link antigo deixa de receber a agenda e precisa assinar o novo.')) grava('POST', '/token');
      } }, 'Trocar o link')));
    return [c, d];
  }

  function mostraExterno(e) {
    var form = $('dialogo-form');
    form.textContent = '';
    var quando = e.diaInteiro ? (e.dataFim ? dataCurta(e.data) + ' a ' + dataCurta(e.dataFim) : dataLonga(e.data) + ' · dia todo')
      : dataLonga(e.data) + ' · ' + e.hora + (e.horaFim ? '–' + e.horaFim : '') + (e.dataFim ? ' (até ' + dataCurta(e.dataFim) + ')' : '');
    add(form, h('h2', null, e.titulo),
      h('p', null, quando),
      e.local ? h('p', { class: 'mudo' }, e.local) : null,
      e.observacao ? h('p', { class: 'obs' }, e.observacao) : null,
      h('p', { class: 'mudo' }, h('span', { class: 'ico-ext', html: ICONE_IPHONE }), ' Do calendário "' + nomeCalendario(e.calendario) + '": para mudar, edite no app Calendário.'),
      h('div', { class: 'dialogo-acoes' }, h('span'), h('button', { type: 'button', class: 'btn primario', onclick: function () { $('dialogo').close(); } }, 'Fechar')));
    form.onsubmit = function (ev) { ev.preventDefault(); };
    $('dialogo').showModal();
  }

  // ---------- diálogo de edição ----------
  var REPETE = { nao: 'Não repete', diario: 'Todo dia', semanal: 'Toda semana', mensal: 'Todo mês', anual: 'Todo ano' };
  var LEMBRETES = [[0, 'Sem lembrete'], [10, '10 minutos antes'], [30, '30 minutos antes'], [60, '1 hora antes'], [120, '2 horas antes'], [1440, '1 dia antes'], [2880, '2 dias antes'], [10080, '1 semana antes']];

  function campoDe(c, valor) {
    var nome = c[0], rotulo = c[1], tipo = c[2], op = c[3] || {}, input;
    if (tipo === 'opcoes') {
      input = h('select', { name: nome }, op.opcoes.map(function (o) { return h('option', { value: String(o[0]), selected: String(o[0]) === String(valor) }, o[1]); }));
    } else if (tipo === 'textoLongo') {
      input = h('textarea', { name: nome, rows: op.linhas || 3, maxlength: '3000' });
      input.value = valor || '';
    } else if (tipo === 'check') {
      return h('label', { class: 'campo campo-check', 'data-campo': nome }, h('input', { type: 'checkbox', name: nome, checked: !!valor }), rotulo);
    } else {
      input = h('input', { name: nome, type: tipo === 'data' ? 'date' : tipo === 'hora' ? 'time' : tipo === 'url' ? 'url' : 'text', maxlength: tipo === 'url' ? '2000' : '300', autocomplete: 'off' });
      input.value = valor || '';
    }
    return h('label', { class: 'campo', 'data-campo': nome }, rotulo + (op.obrigatorio ? ' *' : ''), input, op.dica ? h('small', null, op.dica) : null);
  }

  function abreDialogo(titulo, campos, valores, aoSalvar, aoApagar) {
    var form = $('dialogo-form');
    form.textContent = '';
    add(form, h('h2', null, titulo));
    var i = 0;
    while (i < campos.length) {
      var c = campos[i];
      if (c[3] && c[3].par && campos[i + 1]) { add(form, h('div', { class: 'duas' }, campoDe(c, valores[c[0]]), campoDe(campos[i + 1], valores[campos[i + 1][0]]))); i += 2; }
      else { add(form, campoDe(c, valores[c[0]])); i++; }
    }
    var erro = h('p', { class: 'erro-form', hidden: true });
    function dados() {
      var d = {};
      campos.forEach(function (c) { d[c[0]] = c[2] === 'check' ? form.elements[c[0]].checked : form.elements[c[0]].value; });
      return d;
    }
    // Campos que só aparecem em certas condições (ex.: hora some no dia inteiro).
    function visibilidade() {
      var d = dados();
      campos.forEach(function (c) {
        var soSe = c[3] && c[3].soSe;
        var alvo = form.querySelector('[data-campo="' + c[0] + '"]');
        if (soSe && alvo) alvo.hidden = !soSe(d);
      });
    }
    form.onchange = visibilidade;
    visibilidade();
    add(form, erro, h('div', { class: 'dialogo-acoes' },
      aoApagar ? h('button', { type: 'button', class: 'btn perigo', onclick: function () { if (confirm('Apagar?')) { aoApagar(); $('dialogo').close(); } } }, 'Apagar') : h('span'),
      h('span', { class: 'acoes' },
        h('button', { type: 'button', class: 'btn', onclick: function () { $('dialogo').close(); } }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn primario' }, 'Salvar'))));
    form.onsubmit = function (ev) {
      ev.preventDefault();
      var d = dados();
      var falta = campos.filter(function (c) { return c[3] && c[3].obrigatorio && !String(d[c[0]]).trim(); });
      if (falta.length) { erro.textContent = 'Preencha: ' + falta.map(function (c) { return c[1]; }).join(', '); erro.hidden = false; return; }
      var r;
      try { r = aoSalvar(d); } catch (e) { erro.textContent = e.message; erro.hidden = false; return; }
      erro.hidden = true;
      r.then(function () { $('dialogo').close(); }).catch(function (e) { erro.textContent = e.message; erro.hidden = false; });
    };
    $('dialogo').showModal();
    var primeiro = form.querySelector('input, select, textarea');
    if (primeiro && !('ontouchstart' in window)) primeiro.focus();
  }
  var OPCOES_CONTEXTO = [['pessoal', 'Pessoal'], ['profissional', 'Profissional']];
  function contextoNovo() { return contexto === 'todos' ? 'pessoal' : contexto; }

  function editaEvento(e, modelo) {
    var v = e || Object.assign({ contexto: contextoNovo(), data: hoje(), hora: '', repete: 'nao', lembreteMin: 30, diaInteiro: false }, modelo || {});
    abreDialogo(e ? 'Editar compromisso' : 'Novo compromisso', [
      ['titulo', 'O quê', 'texto', { obrigatorio: true, dica: 'Ex.: Reunião com cliente, Aniversário da Erika' }],
      ['contexto', 'Tipo', 'opcoes', { opcoes: OPCOES_CONTEXTO }],
      ['diaInteiro', 'Dia inteiro', 'check'],
      ['data', 'Data', 'data', { par: true, obrigatorio: true }], ['hora', 'Hora', 'hora', { par: true, soSe: function (d) { return !d.diaInteiro; } }],
      ['dataFim', 'Até o dia', 'data', { par: true, dica: 'Só se durar mais de um dia' }], ['horaFim', 'Até a hora', 'hora', { par: true, soSe: function (d) { return !d.diaInteiro; } }],
      ['repete', 'Repete', 'opcoes', { opcoes: Object.keys(REPETE).map(function (k) { return [k, REPETE[k]]; }), par: true }],
      ['repeteAte', 'Repete até', 'data', { par: true, soSe: function (d) { return d.repete !== 'nao'; }, dica: 'Vazio = sem fim' }],
      ['lembreteMin', 'Lembrete no iPhone', 'opcoes', { opcoes: LEMBRETES }],
      ['local', 'Onde', 'texto'],
      ['observacao', 'Observações', 'textoLongo'],
    ], v, function (d) {
      if (!d.diaInteiro && !d.hora) throw new Error('Informe a hora ou marque "Dia inteiro".');
      if (d.dataFim && d.dataFim < d.data) throw new Error('"Até o dia" é antes do início.');
      var corpo = {
        titulo: d.titulo, contexto: d.contexto, data: d.data, hora: d.diaInteiro ? '' : d.hora,
        dataFim: d.dataFim && d.dataFim !== d.data ? d.dataFim : '', horaFim: d.diaInteiro ? '' : d.horaFim, diaInteiro: !!d.diaInteiro,
        repete: d.repete, repeteAte: d.repete === 'nao' ? '' : d.repeteAte, lembreteMin: +d.lembreteMin || 0, local: d.local, observacao: d.observacao,
      };
      return grava('PUT', '/eventos/' + (e ? e.id : novoId(d.titulo)), corpo);
    }, e ? function () { grava('DELETE', '/eventos/' + e.id); } : null);
  }

  function editaTarefa(t) {
    var v = t || { contexto: contextoNovo(), prioridade: 'normal', prazo: '' };
    abreDialogo(t ? 'Editar tarefa' : 'Nova tarefa', [
      ['titulo', 'O quê', 'texto', { obrigatorio: true, dica: 'Ex.: Pagar IPVA, Enviar proposta' }],
      ['contexto', 'Tipo', 'opcoes', { opcoes: OPCOES_CONTEXTO, par: true }],
      ['prioridade', 'Prioridade', 'opcoes', { opcoes: [['alta', 'Alta'], ['normal', 'Normal'], ['baixa', 'Baixa']], par: true }],
      ['prazo', 'Prazo', 'data', { par: true, dica: 'Vazio = sem prazo' }], ['hora', 'Até a hora', 'hora', { par: true }],
      ['observacao', 'Observações', 'textoLongo'],
      ['feito', 'Feita', 'check'],
    ], v, function (d) {
      return grava('PUT', '/tarefas/' + (t ? t.id : novoId(d.titulo)), {
        titulo: d.titulo, contexto: d.contexto, prioridade: d.prioridade, prazo: d.prazo, hora: d.prazo ? d.hora : '',
        observacao: d.observacao, feito: !!d.feito, feitoEm: t && t.feito && d.feito ? t.feitoEm : '',
      });
    }, t ? function () { grava('DELETE', '/tarefas/' + t.id); } : null);
  }

  function editaCalendario(cal) {
    var v = cal || { contexto: contextoNovo(), ativo: true };
    abreDialogo(cal ? 'Editar calendário' : 'Ligar um calendário', [
      ['nome', 'Nome', 'texto', { obrigatorio: true, dica: 'Ex.: iCloud pessoal, Google do trabalho' }],
      ['url', 'Link (iCal)', 'url', { obrigatorio: true, dica: 'Começa com webcal:// ou https:// (veja "Como pegar o link")' }],
      ['contexto', 'Os compromissos dele são', 'opcoes', { opcoes: OPCOES_CONTEXTO }],
      ['ativo', 'Mostrar na agenda', 'check'],
    ], v, function (d) {
      return grava('PUT', '/calendarios/' + (cal ? cal.id : novoId(d.nome)), { nome: d.nome, url: d.url.trim(), contexto: d.contexto, ativo: !!d.ativo })
        .then(function (r) { if (!cal) toast('Calendário ligado. Os compromissos aparecem em alguns segundos.'); return r; });
    }, cal ? function () { grava('DELETE', '/calendarios/' + cal.id); } : null);
  }

  // ---------- navegação ----------
  function escolhe(id) {
    if (id === pessoaId) return;
    pessoaId = id;
    doc = null;
    try { localStorage.setItem('agenda.pessoa', id); } catch (e) { /* só conveniência */ }
    history.replaceState(null, '', '#' + id + '/' + vista);
    desenhaPessoas();
    $('pagina').textContent = '';
    $('pagina').append(h('p', { class: 'vazio' }, 'Carregando…'));
    geracao++;
    pede('GET', '/pessoa/' + id).then(function (novo) { if (id === pessoaId) { doc = novo; desenha(); } })
      .catch(function (e) { $('pagina').textContent = ''; $('pagina').append(h('p', { class: 'vazio' }, 'Não consegui carregar: ' + e.message)); });
  }
  function vaiParaSecao() {
    var pedida = location.hash.slice(1).split('/')[1];
    if (pedida && pedida !== vista && ['hoje', 'semana', 'mes', 'tarefas', 'calendarios'].indexOf(pedida) >= 0) { vista = pedida; desenha(); window.scrollTo(0, 0); }
  }

  var versoes = {};
  function confereVersao() {
    ['index.html', 'app.js', 'agenda.css'].forEach(function (arq) {
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
    try { contexto = localStorage.getItem('agenda.contexto') || 'todos'; } catch (e) { /* sem armazenamento */ }
    if (!CONTEXTOS[contexto]) contexto = 'todos';
    var secao = location.hash.slice(1).split('/')[1];
    if (secao) vista = secao;
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
      try { salvo = localStorage.getItem('agenda.pessoa'); } catch (e) { /* sem armazenamento */ }
      var existe = function (id) { return id && pessoas.some(function (p) { return p.id === id; }); };
      escolhe(existe(pedido) ? pedido : existe(salvo) ? salvo : pessoas[0].id);
      setInterval(sincroniza, SINCRONIZA_MS);
      setInterval(confereVersao, VERSAO_MS);
      confereVersao();
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
