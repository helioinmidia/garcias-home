// Projetos da manhã: um projeto por dia da semana, lidos de rotina.json (chave "projetos").
// A página abre no projeto de hoje; #seg, #ter… abrem outro dia. Sem ninguém mexer, volta à rotina.
'use strict';

(function () {
  var VOLTA_MS = 5 * 60000; // tela do iPad: depois de 5 min parada, volta para a rotina
  var DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  var CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  var SLUGS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab']; // para o #hash, sem acento

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, texto) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (texto != null) n.textContent = texto;
    return n;
  };

  var rotina = null, projetos = null, diaVisto = null;
  var ultimaInteracao = Date.now();

  function hojeDow() { return new Date().getDay(); }
  function dowDoHash() {
    var h = '';
    try { h = decodeURIComponent(location.hash || '').replace('#', '').toLowerCase(); } catch (e) { h = ''; }
    var i = SLUGS.indexOf(h);
    if (i < 0) i = CURTOS.indexOf(h);
    return i >= 0 && projetos.dias[String(i)] ? i : null;
  }
  function diaPadrao() {
    var hoje = hojeDow();
    if (projetos.dias[String(hoje)]) return hoje;
    // Domingo (sem projeto) abre o de segunda, que é o próximo.
    for (var i = 1; i <= 7; i++) { var d = (hoje + i) % 7; if (projetos.dias[String(d)]) return d; }
    return null;
  }

  function chip(id) {
    var p = (rotina.pessoas || {})[id];
    if (!p) return null;
    var c = el('span', 'chip', p.nome);
    c.style.setProperty('--fundo', p.fundo);
    c.style.setProperty('--texto-chip', p.texto);
    c.style.setProperty('--contorno', p.contorno);
    return c;
  }

  function desenhaNav() {
    var nav = $('dias');
    nav.textContent = '';
    var hoje = hojeDow();
    [1, 2, 3, 4, 5, 6, 0].forEach(function (d) {
      var p = projetos.dias[String(d)];
      var b = el('button', 'dia-btn' + (d === hoje ? ' hoje' : '') + (d === diaVisto ? ' visto' : '') + (p ? '' : ' vazio'));
      b.type = 'button';
      b.disabled = !p;
      b.append(el('span', 'abrev', CURTOS[d]), el('span', 'num emoji', p ? p.emoji || '·' : '—'), el('span', 'cont', p ? p.nome : 'livre'));
      b.setAttribute('aria-label', DIAS[d] + (p ? ': ' + p.nome : ': sem projeto'));
      b.setAttribute('aria-current', d === diaVisto ? 'true' : 'false');
      if (p) b.onclick = function () { vaiPara(d, true); };
      nav.append(b);
    });
  }

  function lista(titulo, itens, cls) {
    if (!itens || !itens.length) return null;
    var sec = el('div', 'proj-lista ' + (cls || ''));
    sec.append(el('h3', null, titulo));
    var ul = el('ul');
    itens.forEach(function (i) { ul.append(el('li', null, i)); });
    sec.append(ul);
    return sec;
  }

  function desenhaProjeto() {
    var main = $('lista');
    main.textContent = '';
    var p = projetos.dias[String(diaVisto)];
    if (!p) { main.append(el('p', 'carregando', 'Nenhum projeto neste dia.')); return; }
    var hoje = diaVisto === hojeDow();

    var card = el('section', 'bloco projeto' + (hoje ? ' hoje' : ''));
    var cab = el('div', 'proj-cab');
    var emoji = el('div', 'proj-emoji', p.emoji || '✎');
    var textos = el('div');
    textos.append(el('p', 'bs', DIAS[diaVisto] + (hoje ? ' · hoje' : '')));
    var h2 = el('h2');
    h2.append(p.nome);
    textos.append(h2);
    if (p.resumo) textos.append(el('p', 'proj-resumo', p.resumo));
    cab.append(emoji, textos);
    card.append(cab);
    if (p.descricao) card.append(el('p', 'proj-desc', p.descricao));

    var quem = el('div', 'quem');
    (p.com || []).forEach(function (id) { var c = chip(id); if (c) quem.append(c); });
    if (quem.childElementCount) {
      var q = el('div', 'proj-quem');
      q.append(el('span', 'proj-quem-rotulo', 'Com quem:'), quem);
      card.append(q);
    }

    var colunas = el('div', 'proj-colunas');
    var ideias = lista('Ideias para começar', p.ideias, 'ideias');
    var materiais = lista('O que precisa', p.materiais, 'materiais');
    if (ideias) colunas.append(ideias);
    if (materiais) colunas.append(materiais);
    if (colunas.childElementCount) card.append(colunas);

    if (hoje) {
      var ir = el('a', 'proj-voltar', 'Marcar o projeto na rotina →');
      ir.href = './#t-projeto';
      card.append(ir);
    }
    main.append(card);
    document.title = p.nome + ' · Projetos da manhã';
  }

  function vaiPara(d, mudaHash) {
    ultimaInteracao = Date.now();
    diaVisto = d;
    if (mudaHash) history.replaceState(null, '', '#' + SLUGS[d]);
    desenhaNav();
    desenhaProjeto();
    window.scrollTo({ top: 0 });
  }

  function inicia() {
    fetch('rotina.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        rotina = json;
        projetos = json.projetos || { dias: {} };
        $('eyebrow').textContent = rotina.titulo || 'Rotina';
        $('titulo').textContent = projetos.titulo || 'Projetos da manhã';
        $('intro').textContent = projetos.intro || '';
        var d = dowDoHash();
        vaiPara(d != null ? d : diaPadrao(), false);
        window.addEventListener('hashchange', function () { var h = dowDoHash(); if (h != null) vaiPara(h, false); });
        ['pointerdown', 'keydown', 'scroll'].forEach(function (ev) {
          window.addEventListener(ev, function () { ultimaInteracao = Date.now(); }, { passive: true });
        });
        setInterval(function () { if (Date.now() - ultimaInteracao > VOLTA_MS) location.href = './'; }, 15000);
      })
      .catch(function () {
        $('lista').textContent = '';
        $('lista').append(el('p', 'carregando', 'Não consegui carregar os projetos. Recarregue a página.'));
      });
  }

  inicia();
})();
