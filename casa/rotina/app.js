// Rotina da Ana Liz: dia da semana, relógio, atividade atual, progresso, marcação de feito e comentários.
// A definição da rotina vem de rotina.json; o que foi feito e os comentários ficam no servidor
// (api/rotina.py, publicada em /rotina/api), para iPad, celulares e laptop verem o mesmo estado.
'use strict';

(function () {
  var API = 'api';
  var SINCRONIZA_MS = 10000; // confere o servidor (marcações feitas em outro aparelho)
  var VERSAO_MS = 5 * 60000; // confere se a página foi atualizada no servidor (git pull no Pi)
  var VOLTA_HOJE_MS = 3 * 60000; // olhando outro dia e sem ninguém mexer: volta para hoje
  var SALVA_COMENTARIO_MS = 900;

  var DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  var DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, texto) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (texto != null) n.textContent = texto;
    return n;
  };

  var rotina = null; // rotina.json
  var dataVista = hojeChave(); // AAAA-MM-DD do dia na tela
  var tarefas = []; // tarefas do dia na tela, já resolvidas (hora, descrição do dia)
  var estado = { tarefas: {}, revisao: -1, agenda: null }; // vindo do servidor
  var agendaVista = null; // id da agenda desenhada na tela (para redesenhar se ela mudar)
  var semana = {}; // AAAA-MM-DD -> dia vindo do servidor (para a faixa da semana)
  var linhas = {}; // id -> elementos da linha
  var editando = {}; // id -> timer do comentário em edição
  var ultimaInteracao = Date.now();
  var geracao = 0; // sobe a cada alteração local; uma leitura iniciada antes dela é descartada
  var enviando = {}; // id -> comentário sendo gravado agora

  // ---------- datas ----------
  function chave(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function hojeChave() { return chave(new Date()); }
  function deChave(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function somaDias(k, n) { var d = deChave(k); d.setDate(d.getDate() + n); return chave(d); }
  function segundaDe(k) { var d = deChave(k); return somaDias(k, -((d.getDay() + 6) % 7)); }
  function minutos(hhmm) { var p = hhmm.split(':'); return +p[0] * 60 + +p[1]; }
  function horaCurta(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ---------- rotina do dia ----------
  function agendaPorId(id) {
    return (rotina.agendas || []).filter(function (a) { return a.id === id; })[0] || null;
  }

  // Agenda de um dia: a trocada na tela (gravada no dia) > exceção do rotina.json (feriado, férias) > dia da semana.
  function agendaDoDia(k) {
    var dia = k === dataVista ? estado : semana[k];
    if (dia && dia.agenda && agendaPorId(dia.agenda)) return { agenda: agendaPorId(dia.agenda), origem: 'tela', motivo: null };
    var exc = (rotina.excecoes || []).filter(function (e) { return e.de <= k && k <= (e.ate || e.de) && agendaPorId(e.agenda); })[0];
    if (exc) return { agenda: agendaPorId(exc.agenda), origem: 'excecao', motivo: exc.motivo || null };
    var dow = deChave(k).getDay();
    var padrao = (rotina.agendas || []).filter(function (a) { return (a.diasDaSemana || []).indexOf(dow) >= 0; })[0] || null;
    return { agenda: padrao, origem: 'semana', motivo: null };
  }

  function tarefasDoDia(k) {
    var dow = deChave(k).getDay();
    var agenda = agendaDoDia(k).agenda;
    if (!agenda) return [];
    var lista = [];
    agenda.blocos.forEach(function (bloco, b) {
      bloco.tarefas.forEach(function (t) {
        if (t.diasDaSemana && t.diasDaSemana.indexOf(dow) < 0) return;
        lista.push({
          id: t.id,
          bloco: b,
          hora: (t.horaPorDia && t.horaPorDia[dow]) || t.hora,
          rotulo: t.rotulo || null,
          ate: t.ate || null,
          titulo: t.titulo,
          duracao: t.duracao > 0 ? t.duracao : null,
          projeto: !!t.projeto,
          descricao: (t.descricaoPorDia && t.descricaoPorDia[dow]) || t.descricao || '',
          quem: t.quem || [],
          podem: t.podem || [],
        });
      });
    });
    lista.blocos = agenda.blocos;
    return lista;
  }

  // Atividade de agora: a última que já começou (só no dia de hoje).
  function atualEProxima() {
    if (dataVista !== hojeChave()) return { atual: null, proxima: null };
    var agora = new Date();
    var m = agora.getHours() * 60 + agora.getMinutes();
    var ordenadas = tarefas.slice().sort(function (a, b) { return minutos(a.hora) - minutos(b.hora); });
    var atual = null, proxima = null;
    ordenadas.forEach(function (t) {
      if (minutos(t.hora) <= m) atual = t;
      else if (!proxima) proxima = t;
    });
    return { atual: atual, proxima: proxima };
  }

  // ---------- desenho ----------
  var ICONE_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICONE_COMENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';

  function chip(id, pode) {
    var p = (rotina.pessoas || {})[id];
    if (!p) return null;
    var c = el('span', 'chip' + (pode ? ' pode' : ''), p.nome);
    c.style.setProperty('--fundo', p.fundo);
    c.style.setProperty('--texto-chip', p.texto);
    c.style.setProperty('--contorno', p.contorno);
    return c;
  }

  function desenhaLista() {
    var lista = $('lista');
    lista.textContent = '';
    linhas = {};
    tarefas = tarefasDoDia(dataVista);
    agendaVista = (agendaDoDia(dataVista).agenda || {}).id || null;

    if (dataVista !== hojeChave()) {
      var aviso = el('p', 'aviso-dia');
      aviso.append('Você está vendo ' + DIAS[deChave(dataVista).getDay()].toLowerCase() + ', ' + dataLonga(dataVista) + '. ');
      var volta = el('button', null, 'Voltar para hoje');
      volta.type = 'button';
      volta.onclick = function () { vaiPara(hojeChave()); };
      aviso.append(volta);
      lista.append(aviso);
    }
    if (!tarefas.length) {
      lista.append(el('p', 'carregando', 'Nada marcado para este dia.'));
      return;
    }
    tarefas.blocos.forEach(function (bloco, b) {
      var doBloco = tarefas.filter(function (t) { return t.bloco === b; });
      if (!doBloco.length) return;
      var sec = el('section', 'bloco');
      var h2 = el('h2');
      h2.append(bloco.titulo);
      if (bloco.subtitulo) { h2.append(' '); h2.append(el('small', null, '· ' + bloco.subtitulo)); }
      var cont = el('span', 'bloco-cont');
      cont.dataset.bloco = b;
      sec.append(cont, h2);
      doBloco.forEach(function (t) { sec.append(linhaTarefa(t)); });
      lista.append(sec);
    });
    if (cron && cron.data === dataVista && linhas[cron.id]) desenhaCronometro(linhas[cron.id], cron);
  }

  function linhaTarefa(t) {
    var linha = el('article', 'tarefa');
    linha.id = 't-' + t.id;

    var hora = el('div', 't-hora', t.rotulo || t.hora);
    if (t.ate) hora.append(el('small', null, 'até ' + t.ate));
    else if (t.rotulo) hora.append(el('small', null, 'a partir das ' + t.hora));
    var cronBtn = null, cronBarra = null;
    if (t.duracao) {
      cronBtn = el('button', 'cron-btn', '▶ ' + t.duracao + ' min');
      cronBtn.type = 'button';
      cronBtn.setAttribute('aria-label', 'Cronômetro de ' + t.duracao + ' minutos para "' + t.titulo + '"');
      cronBtn.onclick = function () { toqueCronometro(t); };
      hora.append(cronBtn);
      cronBarra = el('div', 'cron-barra');
      cronBarra.append(el('i'));
      cronBarra.hidden = true;
    }

    var corpo = el('div', 't-corpo');
    var tag = el('span', 'tag-agora', 'Agora');
    tag.hidden = true;
    var titulo = el('p', 't-titulo', t.titulo);
    var desc = el('p', 't-desc', t.descricao);
    var quem = el('div', 'quem');
    t.quem.forEach(function (p) { var c = chip(p, false); if (c) quem.append(c); });
    t.podem.forEach(function (p) { var c = chip(p, true); if (c) quem.append(c); });
    var feitoEm = el('div', 'feito-em');
    var previa = el('p', 'coment-previa');
    previa.hidden = true;
    corpo.append(tag, titulo, desc, quem);
    var proj = projetoDoDia(t);
    if (proj) corpo.append(proj);
    corpo.append(feitoEm, previa);

    var acoes = el('div', 'acoes');
    var bc = el('button', 'btn-coment');
    bc.type = 'button';
    bc.innerHTML = ICONE_COMENT;
    bc.setAttribute('aria-label', 'Comentário sobre "' + t.titulo + '"');
    var check = el('button', 'check');
    check.type = 'button';
    check.innerHTML = ICONE_CHECK;
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-label', t.titulo);
    acoes.append(bc, check);

    var edicao = el('div', 'coment-edit');
    edicao.hidden = true;
    var area = el('textarea');
    area.placeholder = 'Comentário sobre esta atividade…';
    area.maxLength = 2000;
    var rod = el('div', 'coment-rodape');
    var situacao = el('span');
    var fechar = el('button', null, 'Fechar');
    fechar.type = 'button';
    rod.append(situacao, fechar);
    edicao.append(area, rod);

    linha.append(hora, corpo, acoes, edicao);
    if (cronBarra) linha.append(cronBarra);

    check.onclick = function () { alternaFeito(t.id); };
    bc.onclick = function () {
      edicao.hidden = !edicao.hidden;
      if (!edicao.hidden) { area.value = comentarioDe(t.id); situacao.textContent = ''; area.focus(); }
      else salvaComentarioAgora(t.id);
      atualizaLinha(t.id);
    };
    fechar.onclick = function () { salvaComentarioAgora(t.id); edicao.hidden = true; atualizaLinha(t.id); };
    area.oninput = function () {
      situacao.textContent = 'Escrevendo…';
      clearTimeout(editando[t.id]);
      editando[t.id] = setTimeout(function () { salvaComentarioAgora(t.id); }, SALVA_COMENTARIO_MS);
    };
    area.onblur = function () { salvaComentarioAgora(t.id); };

    linhas[t.id] = { linha: linha, tag: tag, check: check, feitoEm: feitoEm, previa: previa, bc: bc, edicao: edicao, area: area, situacao: situacao, cronBtn: cronBtn, cronBarra: cronBarra, tarefa: t };
    return linha;
  }

  function comentarioDe(id) { return ((estado.tarefas[id] || {}).comentario) || ''; }

  // Nas atividades marcadas com "projeto": o projeto do dia (rotina.json → projetos.dias[dia da semana]).
  var SLUGS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  function projetoDoDia(t) {
    if (!t.projeto || !rotina.projetos || !rotina.projetos.dias) return null;
    var dow = deChave(dataVista).getDay();
    var p = rotina.projetos.dias[String(dow)];
    var caixa = el('div', 'proj-hoje');
    caixa.append(el('span', 'proj-rotulo', dataVista === hojeChave() ? 'Projeto de hoje' : 'Projeto do dia'));
    if (p) {
      caixa.append(el('b', null, (p.emoji ? p.emoji + ' ' : '') + p.nome));
      if (p.resumo) caixa.append(el('span', 'proj-res', p.resumo));
    } else {
      caixa.append(el('span', 'proj-res', 'Escolha livre: veja as ideias da semana.'));
    }
    var link = el('a', null, 'Ver ideias →');
    link.href = 'projetos.html#' + SLUGS[dow];
    caixa.append(link);
    return caixa;
  }

  function atualizaLinha(id) {
    var l = linhas[id];
    if (!l) return;
    var e = estado.tarefas[id] || {};
    l.linha.classList.toggle('feito', !!e.feito);
    l.check.setAttribute('aria-checked', e.feito ? 'true' : 'false');
    l.feitoEm.textContent = e.feito && e.feitoEm ? 'Feito às ' + horaCurta(e.feitoEm) : '';
    l.feitoEm.hidden = !l.feitoEm.textContent;
    var texto = e.comentario || '';
    l.bc.classList.toggle('tem', !!texto);
    l.previa.hidden = !texto || !l.edicao.hidden;
    if (texto) {
      l.previa.textContent = '';
      if (e.comentadoEm) l.previa.append(el('small', null, 'Comentário · ' + horaCurta(e.comentadoEm)));
      l.previa.append(texto);
    }
    // Não mexe no texto de quem está digitando.
    if (!l.edicao.hidden && document.activeElement !== l.area && !editando[id]) l.area.value = texto;
  }

  function atualizaTudo() {
    Object.keys(linhas).forEach(atualizaLinha);
    var feitas = tarefas.filter(function (t) { return (estado.tarefas[t.id] || {}).feito; }).length;
    var total = tarefas.length;
    var pct = total ? Math.round((feitas / total) * 100) : 0;
    $('contagem').innerHTML = '<span>' + feitas + '</span> de ' + total + (total === 1 ? ' feita' : ' feitas');
    $('barra').firstElementChild.style.width = pct + '%';
    $('barra').setAttribute('aria-valuenow', pct);
    $('pct').textContent = pct + '%';
    var completo = total > 0 && feitas === total;
    $('progresso').classList.toggle('completo', completo);
    $('parabens').hidden = !completo;
    Array.prototype.forEach.call(document.querySelectorAll('.bloco-cont'), function (c) {
      var doBloco = tarefas.filter(function (t) { return String(t.bloco) === c.dataset.bloco; });
      var f = doBloco.filter(function (t) { return (estado.tarefas[t.id] || {}).feito; }).length;
      c.textContent = f + ' de ' + doBloco.length;
    });
    desenhaSemana();
    atualizaAgora();
  }

  function dataLonga(k) { var d = deChave(k); return d.getDate() + ' de ' + MESES[d.getMonth()]; }

  // Progresso de um dia: quantas atividades daquele dia estão feitas.
  function progressoDe(k) {
    var lista = k === dataVista ? tarefas : tarefasDoDia(k);
    var dia = k === dataVista ? estado : semana[k];
    var feitas = dia ? lista.filter(function (t) { return (dia.tarefas[t.id] || {}).feito; }).length : 0;
    return { feitas: feitas, total: lista.length };
  }

  // Faixa da semana do dia na tela: segunda a domingo, cada dia com o próprio progresso.
  function desenhaSemana() {
    var faixa = $('semana');
    faixa.textContent = '';
    var hoje = hojeChave(), inicio = segundaDe(dataVista);
    for (var i = 0; i < 7; i++) {
      (function (k) {
        var d = deChave(k), p = progressoDe(k), pct = p.total ? Math.round((p.feitas / p.total) * 100) : 0;
        var b = el('button', 'dia-btn');
        b.type = 'button';
        if (k === hoje) b.classList.add('hoje');
        if (k === dataVista) b.classList.add('visto');
        if (k > hoje) b.classList.add('futuro');
        if (!p.total) b.classList.add('vazio');
        if (p.total && p.feitas === p.total) b.classList.add('completo');
        var mini = el('span', 'mini');
        mini.append(el('i'));
        mini.firstElementChild.style.width = pct + '%';
        b.append(el('span', 'abrev', DIAS_CURTOS[d.getDay()]), el('span', 'num', String(d.getDate())), mini,
          el('span', 'cont', p.total ? p.feitas + ' de ' + p.total : '—'));
        b.setAttribute('aria-label', DIAS[d.getDay()] + ', ' + dataLonga(k) + ': ' + p.feitas + ' de ' + p.total + ' feitas');
        b.setAttribute('aria-current', k === dataVista ? 'date' : 'false');
        b.onclick = function () { if (k !== dataVista) vaiPara(k); };
        faixa.append(b);
      })(somaDias(inicio, i));
    }
  }

  function atualizaCabecalho() {
    var d = deChave(dataVista);
    $('dia-nome').textContent = DIAS[d.getDay()];
    $('dia-data').textContent = dataLonga(dataVista) + ' de ' + d.getFullYear();
    $('dia-hoje').hidden = dataVista === hojeChave();
    document.title = DIAS[d.getDay()] + ' · ' + (rotina ? rotina.titulo : 'Rotina');
    atualizaAgendaBtn();
  }

  // Botão da agenda do dia ("Dia de escola", "Dia sem escola · Feriado…"); toque abre o menu para trocar.
  function atualizaAgendaBtn() {
    var btn = $('agenda-btn');
    if (!rotina || !(rotina.agendas || []).length) { btn.hidden = true; return; }
    var r = agendaDoDia(dataVista);
    btn.textContent = '';
    btn.append(r.agenda ? (r.agenda.nome || r.agenda.id) : 'Sem agenda');
    if (r.origem === 'excecao' && r.motivo) btn.append(el('small', null, '· ' + r.motivo));
    if (r.origem === 'tela') btn.append(el('small', null, '· trocada'));
    btn.classList.toggle('trocada', r.origem !== 'semana');
    btn.hidden = false;
  }

  function abreMenuAgenda() {
    var menu = $('agenda-menu'), btn = $('agenda-btn');
    if (!menu.hidden) { fechaMenuAgenda(); return; }
    menu.textContent = '';
    var r = agendaDoDia(dataVista);
    (rotina.agendas || []).forEach(function (a) {
      var b = el('button', r.agenda && r.agenda.id === a.id ? 'ativa' : null);
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', r.agenda && r.agenda.id === a.id ? 'true' : 'false');
      b.append(a.nome || a.id);
      if (r.agenda && r.agenda.id === a.id) b.append(el('small', null, 'hoje'));
      b.onclick = function () { trocaAgenda(a.id); };
      menu.append(b);
    });
    if (r.origem === 'tela') {
      menu.append(el('div', 'sep'));
      var auto = el('button', null, 'Voltar ao automático');
      auto.type = 'button';
      auto.append(el('small', null, 'pelo calendário'));
      auto.onclick = function () { trocaAgenda(null); };
      menu.append(auto);
    }
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }
  function fechaMenuAgenda() {
    $('agenda-menu').hidden = true;
    $('agenda-btn').setAttribute('aria-expanded', 'false');
  }

  function trocaAgenda(id) {
    fechaMenuAgenda();
    ultimaInteracao = Date.now();
    geracao++;
    var anterior = estado.agenda;
    estado.agenda = id;
    var novaId = (agendaDoDia(dataVista).agenda || {}).id || null;
    if (novaId !== agendaVista) { desenhaLista(); }
    atualizaCabecalho();
    atualizaTudo();
    pede('PUT', '/dia/' + dataVista + '/agenda', { agenda: id })
      .then(function (dia) { aplica(dia); toast(''); })
      .catch(function () {
        estado.agenda = anterior;
        desenhaLista(); atualizaCabecalho(); atualizaTudo();
        toast('Não consegui trocar a agenda. Confira a conexão e tente de novo.');
      });
  }

  var atualAnterior = null;
  function atualizaAgora() {
    var r = atualEProxima();
    Object.keys(linhas).forEach(function (id) {
      var ehAtual = r.atual && r.atual.id === id;
      linhas[id].linha.classList.toggle('atual', !!ehAtual);
      linhas[id].tag.hidden = !ehAtual;
    });
    var txt = $('agora-txt');
    txt.textContent = '';
    if (dataVista !== hojeChave()) return;
    if (r.atual) {
      txt.append(el('b', null, 'Agora: '), r.atual.titulo);
      if (r.atual.ate) txt.append(' (até ' + r.atual.ate + ')');
    }
    if (r.proxima) {
      if (r.atual) txt.append(el('br'));
      txt.append(el('b', null, 'Depois: '), r.proxima.titulo + ' às ' + r.proxima.hora);
    }
    var novo = r.atual ? r.atual.id : null;
    if (novo && novo !== atualAnterior && Date.now() - ultimaInteracao > 60000) rolaPara(novo);
    atualAnterior = novo;
  }

  function rolaPara(id) {
    var l = linhas[id];
    if (!l) return;
    var topo = $('topo').getBoundingClientRect().height;
    var y = l.linha.getBoundingClientRect().top + window.pageYOffset - topo - 16;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  function relogio() {
    var agora = new Date();
    var h = String(agora.getHours()).padStart(2, '0');
    var m = String(agora.getMinutes()).padStart(2, '0');
    var s = String(agora.getSeconds()).padStart(2, '0');
    $('hora').innerHTML = h + ':' + m + '<small>' + s + '</small>';
    if (agora.getSeconds() === 0) atualizaAgora();
    tiqueCronometro();
  }

  // ---------- cronômetro ----------
  // Um por aparelho, guardado no navegador para sobreviver a um recarregamento; não vai para o servidor.
  var CRON_CHAVE = 'rotina.cronometro';
  var cron = null; // { id, data, inicio, fim, minutos, avisou }
  var somCtx = null;

  function carregaCronometro() {
    try {
      var c = JSON.parse(localStorage.getItem(CRON_CHAVE) || 'null');
      if (c && c.id && c.data === hojeChave() && Date.now() - c.fim < 6 * 3600000) cron = c;
      else localStorage.removeItem(CRON_CHAVE);
    } catch (e) { cron = null; }
  }
  function guardaCronometro() {
    try { if (cron) localStorage.setItem(CRON_CHAVE, JSON.stringify(cron)); else localStorage.removeItem(CRON_CHAVE); } catch (e) {}
  }

  function preparaSom() {
    try {
      somCtx = somCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (somCtx.state === 'suspended') somCtx.resume();
    } catch (e) { somCtx = null; }
  }
  function tocaSino() {
    if (!somCtx) return;
    var t0 = somCtx.currentTime;
    [0, 1.4].forEach(function (rep) {
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        var t = t0 + rep + i * 0.16, o = somCtx.createOscillator(), g = somCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.connect(g); g.connect(somCtx.destination);
        o.start(t); o.stop(t + 0.65);
      });
    });
  }

  function toqueCronometro(t) {
    ultimaInteracao = Date.now();
    preparaSom(); // o toque libera o áudio no iPad; o sino toca sozinho no fim
    if (cron && cron.id === t.id) { paraCronometro(); return; }
    var agora = Date.now();
    cron = { id: t.id, data: dataVista, inicio: agora, fim: agora + t.duracao * 60000, minutos: t.duracao, avisou: false };
    guardaCronometro();
    tiqueCronometro();
  }
  function paraCronometro() {
    var antigo = cron;
    cron = null;
    guardaCronometro();
    if (antigo && linhas[antigo.id]) desenhaCronometro(linhas[antigo.id], null);
    $('cron-topo').hidden = true;
  }

  function mmss(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function desenhaCronometro(l, c) {
    if (!l.cronBtn) return;
    l.linha.classList.toggle('cronometrando', !!c);
    l.cronBarra.hidden = !c;
    l.cronBtn.classList.toggle('rodando', !!c && !c.acabou);
    l.cronBtn.classList.toggle('acabou', !!c && c.acabou);
    if (!c) { l.cronBtn.textContent = '▶ ' + l.tarefa.duracao + ' min'; return; }
    l.cronBarra.firstElementChild.style.width = Math.min(100, ((Date.now() - c.inicio) / (c.fim - c.inicio)) * 100) + '%';
    l.cronBtn.textContent = c.acabou ? 'Tempo esgotado · toque para fechar' : '■ ' + mmss(c.fim - Date.now());
  }

  function tiqueCronometro() {
    var topo = $('cron-topo');
    if (!cron) { topo.hidden = true; return; }
    var acabou = Date.now() >= cron.fim;
    cron.acabou = acabou;
    if (acabou && !cron.avisou) { cron.avisou = true; guardaCronometro(); tocaSino(); }
    var l = linhas[cron.id];
    if (l && cron.data === dataVista) desenhaCronometro(l, cron);
    if (acabou) {
      topo.textContent = '';
      topo.append('Tempo esgotado', el('small', null, l ? l.tarefa.titulo : ''));
    } else {
      topo.textContent = '';
      topo.append('⏱ ' + mmss(cron.fim - Date.now()), el('small', null, l ? l.tarefa.titulo : ''));
    }
    topo.hidden = false;
    // Passou muito do fim sem ninguém fechar: limpa sozinho.
    if (Date.now() - cron.fim > 30 * 60000) paraCronometro();
  }

  // ---------- servidor ----------
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = !msg;
  }

  function pede(metodo, caminho, corpo) {
    return fetch(API + caminho, {
      method: metodo,
      cache: 'no-store',
      headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.erro || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function aplica(dia) {
    if (!dia) return;
    semana[dia.data] = dia;
    if (dia.data !== dataVista) { desenhaSemana(); return; }
    estado = { tarefas: dia.tarefas || {}, revisao: dia.revisao, agenda: dia.agenda || null };
    var novaId = (agendaDoDia(dataVista).agenda || {}).id || null;
    if (novaId !== agendaVista) { desenhaLista(); atualizaCabecalho(); }
    atualizaTudo();
  }

  // Uma leitura só traz a semana inteira do dia na tela: o dia em si e o progresso dos outros seis.
  var sincronizando = false;
  function sincroniza() {
    if (sincronizando || document.hidden) return;
    sincronizando = true;
    var alvo = dataVista, gen = geracao, inicio = segundaDe(alvo);
    pede('GET', '/dias?de=' + inicio + '&ate=' + somaDias(inicio, 6))
      .then(function (r) {
        var dias = r.dias || {};
        Object.keys(dias).forEach(function (k) { if (k !== alvo) semana[k] = dias[k]; });
        var dia = dias[alvo];
        if (alvo === dataVista && gen === geracao && dia && dia.revisao !== estado.revisao) aplica(dia);
        else desenhaSemana();
        toast('');
      })
      .catch(function () { toast('Sem conexão com o servidor da casa. Tentando de novo…'); })
      .then(function () { sincronizando = false; });
  }

  function alternaFeito(id) {
    ultimaInteracao = Date.now();
    geracao++;
    var antes = estado.tarefas[id] ? Object.assign({}, estado.tarefas[id]) : null;
    var feito = !(antes && antes.feito);
    estado.tarefas[id] = Object.assign({}, antes, { feito: feito, feitoEm: feito ? new Date().toISOString() : null });
    atualizaTudo();
    pede('PUT', '/dia/' + dataVista + '/tarefa/' + id, { feito: feito })
      .then(function (dia) { aplica(dia); toast(''); })
      .catch(function () {
        if (antes) estado.tarefas[id] = antes; else delete estado.tarefas[id];
        atualizaTudo();
        toast('Não consegui salvar. Confira a conexão e toque de novo.');
      });
  }

  function salvaComentarioAgora(id) {
    clearTimeout(editando[id]);
    delete editando[id];
    var l = linhas[id];
    if (!l) return;
    var texto = l.area.value.trim();
    if (texto === comentarioDe(id) || texto === enviando[id]) {
      if (l.situacao.textContent === 'Escrevendo…') l.situacao.textContent = '';
      return;
    }
    l.situacao.textContent = 'Salvando…';
    geracao++;
    enviando[id] = texto;
    pede('PUT', '/dia/' + dataVista + '/tarefa/' + id, { comentario: texto })
      .then(function (dia) {
        delete enviando[id];
        aplica(dia);
        if (linhas[id]) linhas[id].situacao.textContent = texto ? 'Salvo' : 'Comentário apagado';
        toast('');
      })
      .catch(function () {
        delete enviando[id];
        if (linhas[id]) linhas[id].situacao.textContent = 'Não salvou: sem conexão';
        toast('Não consegui salvar o comentário. Ele continua na caixa; tente de novo.');
      });
  }

  function vaiPara(k) {
    Object.keys(editando).forEach(salvaComentarioAgora);
    dataVista = k;
    estado = semana[k] ? { tarefas: semana[k].tarefas || {}, revisao: semana[k].revisao, agenda: semana[k].agenda || null } : { tarefas: {}, revisao: -1, agenda: null };
    atualizaCabecalho();
    desenhaLista();
    atualizaTudo();
    window.scrollTo({ top: 0 });
    sincroniza();
    if (k === hojeChave()) {
      var r = atualEProxima();
      if (r.atual) setTimeout(function () { rolaPara(r.atual.id); }, 60);
    }
  }

  // Recarrega a página quando algum arquivo dela muda no servidor (tela que fica sempre aberta no iPad).
  var versoes = {};
  function confereVersao() {
    ['index.html', 'app.js', 'rotina.css', 'rotina.json'].forEach(function (arq) {
      fetch(arq, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
        var tag = r.ok && (r.headers.get('ETag') || r.headers.get('Last-Modified'));
        if (!tag) return;
        if (versoes[arq] && versoes[arq] !== tag && !Object.keys(editando).length) location.reload();
        versoes[arq] = tag;
      }).catch(function () {});
    });
  }

  function legenda() {
    var leg = $('legenda');
    var exemplo = Object.keys(rotina.pessoas || {})[1] || Object.keys(rotina.pessoas || {})[0];
    if (!exemplo) return;
    var deve = chip(exemplo, false), pode = chip(exemplo, true);
    deve.textContent = 'Deve estar';
    pode.textContent = 'Pode estar';
    leg.append(deve, pode);
  }

  // ---------- início ----------
  function inicia() {
    $('dia-anterior').onclick = function () { vaiPara(somaDias(dataVista, -1)); };
    $('dia-seguinte').onclick = function () { vaiPara(somaDias(dataVista, 1)); };
    $('dia-hoje').onclick = function () { vaiPara(hojeChave()); };
    $('agenda-btn').onclick = function (ev) { ev.stopPropagation(); ultimaInteracao = Date.now(); abreMenuAgenda(); };
    document.addEventListener('pointerdown', function (ev) {
      if (!$('agenda-menu').hidden && !$('agenda-menu').contains(ev.target) && ev.target !== $('agenda-btn')) fechaMenuAgenda();
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') fechaMenuAgenda(); });
    carregaCronometro();
    ['pointerdown', 'keydown', 'scroll'].forEach(function (ev) {
      window.addEventListener(ev, function () { ultimaInteracao = Date.now(); }, { passive: true });
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sincroniza(); });

    fetch('rotina.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        rotina = json;
        $('eyebrow').textContent = rotina.titulo + (rotina.subtitulo ? ' · ' + rotina.subtitulo : '');
        legenda();
        vaiPara(hojeChave());
        relogio();
        setInterval(relogio, 1000);
        setInterval(sincroniza, SINCRONIZA_MS);
        confereVersao();
        setInterval(confereVersao, VERSAO_MS);
        // Virada do dia e retorno automático para hoje.
        var hojeVisto = hojeChave();
        setInterval(function () {
          var h = hojeChave();
          if (h !== hojeVisto) {
            var estavaEmHoje = dataVista === hojeVisto;
            hojeVisto = h;
            if (estavaEmHoje) vaiPara(h);
          } else if (dataVista !== h && Date.now() - ultimaInteracao > VOLTA_HOJE_MS && !Object.keys(editando).length) {
            vaiPara(h);
          }
        }, 15000);
      })
      .catch(function () {
        $('lista').innerHTML = '';
        $('lista').append(el('p', 'carregando', 'Não consegui carregar a rotina. Recarregue a página.'));
        setTimeout(function () { location.reload(); }, 30000);
      });
  }

  inicia();
})();
