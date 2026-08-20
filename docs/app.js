/* =========================================================================
   LE MARCHÉ NOIR DES GAGES
   Enchères clandestines payées en gorgées — écran central + téléphones.

   Transport : MQTT over WebSocket sur brokers publics (aucun compte requis),
   avec bascule automatique d'un broker à l'autre.
   L'écran central est l'unique autorité sur l'état ; les téléphones publient
   leur mise CUMULÉE (idempotente) et la rejouent tant qu'elle n'est pas
   acquittée — aucune mise ne peut donc être perdue par un message égaré.
   ========================================================================= */
(function () {
  'use strict';

  // ----------------------------------------------------------------- outils
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var now = function () { return Date.now(); };

  function text(el, v) { if (el) el.textContent = v; }
  function show(el, on) { if (el) el.hidden = !on; }
  function store(k, v) {
    try {
      if (v === undefined) { var raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; }
      if (v === null) { localStorage.removeItem(k); return null; }
      localStorage.setItem(k, JSON.stringify(v)); return v;
    } catch (e) { return null; }
  }

  var ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function randCode(n) {
    var out = '', a = new Uint32Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < n; i++) out += ALPHA[a[i] % ALPHA.length];
    return out;
  }
  function deviceId() {
    var d = store('mng.device');
    if (!d) { d = randCode(10).toLowerCase(); store('mng.device', d); }
    return d;
  }

  // ------------------------------------------------------------- transport
  var DEFAULT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081'
  ];
  function brokerList() {
    var p = new URLSearchParams(location.search).get('broker');
    if (p) return p.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return DEFAULT_BROKERS.slice();
  }

  function Bus(code, role) {
    var self = this;
    this.code = code;
    this.role = role;
    this.root = 'mng/' + code + '/';
    this.brokers = brokerList();
    this.idx = 0;
    this.tries = 0;
    this.subs = [];       // {filter, re, cb}
    this.status = 'connecting';
    this.onStatus = function () {};
    this.onOpen = function () {};
    this.client = null;
    this.dead = false;
    this.pending = false;
    this.lastError = '';
    this._connect();
    // Reconnexion volontaire quand le téléphone sort de veille / revient en ligne
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) self.kick();
    });
    window.addEventListener('online', function () { self.kick(); });
  }
  Bus.prototype._set = function (s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s, this.lastError);
  };
  Bus.prototype._connect = function () {
    if (this.dead) return;
    var self = this;
    this.pending = false;
    var url = this.brokers[this.idx % this.brokers.length];
    this.url = url;
    this._set(this.tries === 0 ? 'connecting' : (this.tries > 2 ? 'offline' : 'reconnecting'));
    var c;
    try {
      c = window.mqtt.connect(url, {
        clientId: 'mng_' + this.role + '_' + deviceId() + '_' + randCode(4).toLowerCase(),
        keepalive: 25,
        reconnectPeriod: 0,       // on gère nous-mêmes pour pouvoir changer de broker
        connectTimeout: 7000,
        clean: true,
        protocolVersion: 4,
        resubscribe: false
      });
    } catch (e) { this.lastError = String(e && e.message || e); return this._retry(); }
    this.client = c;
    c.on('connect', function () {
      self.tries = 0;
      self._set('online');
      self.subs.forEach(function (s) { c.subscribe(s.filter, { qos: 0 }); });
      self.onOpen();
    });
    c.on('message', function (topic, payload) {
      var msg = null;
      try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
      self.subs.forEach(function (s) { if (s.re.test(topic)) s.cb(msg, topic); });
    });
    c.on('error', function (e) { self.lastError = String(e && e.message || e); });
    c.on('close', function () { self._retry(); });
    c.on('offline', function () { self._retry(); });
  };
  Bus.prototype._retry = function () {
    if (this.dead || this.pending) return;
    this.pending = true;
    var self = this;
    if (this.client) {
      try { this.client.removeAllListeners(); this.client.end(true); } catch (e) {}
      this.client = null;
    }
    this.tries++;
    this.idx++;                                   // broker suivant à chaque échec
    this._set(this.tries > 2 ? 'offline' : 'reconnecting');
    var delay = Math.min(700 * Math.pow(1.7, Math.min(this.tries, 5)), 8000);
    setTimeout(function () { self._connect(); }, delay);
  };
  Bus.prototype.kick = function () {
    if (this.dead || this.status === 'online' || this.pending) return;
    this.tries = 0; this._retry();
  };
  // Reconnexion forcée : la socket peut se croire ouverte alors que plus rien
  // ne passe (tunnel, Wi-Fi qui décroche, téléphone en veille prolongée).
  Bus.prototype.reset = function () {
    if (this.dead || this.pending) return;
    this.tries = 0; this._set('reconnecting'); this._retry();
  };
  Bus.prototype.sub = function (filter, cb) {
    var re = new RegExp('^' + filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\+/g, '[^/]+').replace(/#$/, '.*') + '$');
    this.subs.push({ filter: filter, re: re, cb: cb });
    if (this.client && this.status === 'online') this.client.subscribe(filter, { qos: 0 });
  };
  Bus.prototype.pub = function (topic, obj, retain) {
    if (!this.client || this.status !== 'online') return false;
    try { this.client.publish(topic, JSON.stringify(obj), { qos: 0, retain: !!retain }); return true; }
    catch (e) { return false; }
  };
  Bus.prototype.close = function () {
    this.dead = true;
    if (this.client) { try { this.client.removeAllListeners(); this.client.end(true); } catch (e) {} }
    this.client = null;
  };

  var STATUS_LABEL = {
    connecting: ['CONNEXION…', 'is-warn'],
    online: ['EN LIGNE', 'is-on'],
    reconnecting: ['RECONNEXION…', 'is-warn'],
    offline: ['HORS LIGNE', 'is-off']
  };
  function paintStatus(el, s) {
    if (!el) return;
    var v = STATUS_LABEL[s] || STATUS_LABEL.connecting;
    el.textContent = v[0];
    el.className = 'pill status ' + v[1];
  }

  // ------------------------------------------------------------------ gages
  var GAGES = [
    "Désigner qui porte le truc le plus ridicule de la maison jusqu'à demain matin",
    "Désigner qui raconte sa pire honte amoureuse, en détail, sans rien couper",
    "Désigner qui doit danser seul·e au milieu du groupe sur une chanson entière",
    "Désigner qui doit parler avec un accent imposé pendant 30 minutes",
    "Désigner qui lit à voix haute le dernier message qu'il a envoyé",
    "Désigner qui doit appeler quelqu'un de son répertoire et lui chanter la chanson qui passe",
    "Désigner qui doit répondre « oui chef » à tout ce qu'on lui dit pendant 20 minutes",
    "Désigner qui doit imiter quelqu'un du groupe jusqu'à ce qu'on devine de qui il s'agit",
    "Désigner qui fait un discours de remerciement larmoyant d'une minute, debout",
    "Désigner qui doit refaire toute la vaisselle du repas de ce soir",
    "Le droit d'imposer une règle absurde à toute la table pour les 15 prochaines minutes",
    "Le droit de désigner un binôme : deux personnes liées, tout ce que l'un boit, l'autre aussi"
  ];

  // ------------------------------------------------------------------ router
  var SCREENS = ['home', 'code', 'setup', 'tv', 'who', 'player', 'diag'];
  var current = null, tv = null, player = null;

  function goto(name) {
    SCREENS.forEach(function (s) {
      var el = $('#screen-' + s);
      if (el) el.classList.toggle('is-active', s === name);
    });
    current = name;
    window.scrollTo(0, 0);
  }

  function route() {
    var h = location.hash.replace(/^#/, '');
    if (tv && h.indexOf('tv') !== 0) { tv.stop(); tv = null; }
    if (player && h.indexOf('j/') !== 0) { player.stop(); player = null; }

    if (h === 'diag') { goto('diag'); return; }
    if (h === 'code') { goto('code'); setTimeout(function () { $('#code-input').focus(); }, 60); return; }
    if (h === 'setup') { openSetup(); return; }
    if (h === 'tv') { if (!tv) tv = startTV(); goto('tv'); return; }
    if (h.indexOf('j/') === 0) {
      var code = h.slice(2).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) { location.hash = 'code'; return; }
      if (!player) player = startPlayer(code);
      goto(player.screen());
      return;
    }
    goto('home');
  }
  window.addEventListener('hashchange', route);

  $('#btn-role-tv').addEventListener('click', function () { location.hash = 'setup'; });
  $('#btn-role-player').addEventListener('click', function () { location.hash = 'code'; });
  $('#btn-code-go').addEventListener('click', function () {
    var v = ($('#code-input').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length < 4) { text($('#code-err'), 'Code incomplet — il fait 5 caractères.'); return; }
    text($('#code-err'), '');
    location.hash = 'j/' + v;
  });
  $('#code-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btn-code-go').click(); });

  // =========================================================== CONFIGURATION
  function nameRow(value) {
    var row = document.createElement('div');
    row.className = 'name-row';
    var idx = document.createElement('span'); idx.className = 'idx';
    var inp = document.createElement('input');
    inp.className = 'name-input'; inp.type = 'text'; inp.maxLength = 18;
    inp.placeholder = 'Prénom'; inp.value = value || '';
    inp.setAttribute('autocomplete', 'off');
    var del = document.createElement('button');
    del.className = 'del'; del.type = 'button'; del.textContent = '×';
    del.setAttribute('aria-label', 'Retirer');
    del.addEventListener('click', function () { row.remove(); renumber(); });
    row.appendChild(idx); row.appendChild(inp); row.appendChild(del);
    return row;
  }
  function renumber() {
    var rows = $$('#names-list .name-row');
    rows.forEach(function (r, i) { text($('.idx', r), (i + 1) + '.'); });
    text($('#names-count'), rows.length + ' participant' + (rows.length > 1 ? 's' : ''));
  }
  function openSetup() {
    if (!$$('#names-list .name-row').length) {
      var list = $('#names-list');
      for (var i = 0; i < 9; i++) list.appendChild(nameRow(''));
      renumber();
    }
    var saved = store('mng.tv');
    if (saved && saved.state && saved.state.players) {
      var s = saved.state;
      var line = $('#resume-line');
      line.innerHTML = '';
      var a = document.createElement('a');
      a.href = '#'; a.className = 'lnk';
      a.textContent = 'Reprendre la vente ' + s.code + ' (' + s.players.length + ' joueurs, '
        + (s.history ? s.history.length : 0) + ' lots vendus)';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        location.hash = 'tv';
      });
      line.appendChild(a);
      show(line, true);
    }
    goto('setup');
  }
  $('#btn-add-name').addEventListener('click', function () {
    $('#names-list').appendChild(nameRow('')); renumber();
    var rows = $$('#names-list .name-input'); rows[rows.length - 1].focus();
  });
  $('#btn-open-room').addEventListener('click', function () {
    var names = $$('#names-list .name-input').map(function (i) { return i.value.trim(); })
      .filter(function (v) { return v.length; });
    var lower = names.map(function (n) { return n.toLowerCase(); });
    if (names.length < 2) { text($('#setup-err'), 'Il faut au moins 2 participants.'); return; }
    if (new Set(lower).size !== names.length) { text($('#setup-err'), 'Deux participants portent le même prénom — ajoute une initiale.'); return; }
    text($('#setup-err'), '');
    store('mng.tv', { state: freshState(names) });
    location.hash = 'tv';
  });

  function freshState(names) {
    return {
      v: 1,
      code: randCode(5),
      players: names.map(function (n, i) { return { id: 'p' + (i + 1), name: n, tab: 0 }; }),
      lot: null,
      last: null,
      history: [],
      online: [],
      seq: 0,
      now: now()
    };
  }

  // ============================================================ ÉCRAN CENTRAL
  function startTV() {
    var saved = store('mng.tv');
    if (!saved || !saved.state) { location.hash = 'setup'; return null; }
    var S = saved.state;
    if (!S.online) S.online = [];
    var bus = new Bus(S.code, 'tv');
    var seen = {};                 // slot -> dernier ping
    var bidAt = {};                // slot -> instant de la meilleure mise (départage)
    var pubTimer = null, lastPub = 0, ticker = null, stampTimer = null;
    var duration = 30, tick = 0;
    var lotCounter = S.history ? S.history.length : 0;
    if (S.lot && S.lot.id > lotCounter) lotCounter = S.lot.id;

    text($('#tv-code'), S.code);
    paintStatus($('#tv-status'), bus.status);
    bus.onStatus = function (s) { paintStatus($('#tv-status'), s); };
    bus.onOpen = function () { publish(true); };

    // ---- publication de l'état (débit limité, mais jamais retardée > 120 ms)
    function publish(force) {
      var t = now();
      if (!force && t - lastPub < 120) {
        if (!pubTimer) pubTimer = setTimeout(function () { pubTimer = null; publish(true); }, 120);
        return;
      }
      if (pubTimer) { clearTimeout(pubTimer); pubTimer = null; }
      lastPub = t;
      S.seq++;
      S.now = t;
      S.online = Object.keys(seen).filter(function (k) { return t - seen[k] < 25000; });
      bus.pub(bus.root + 'state', S, true);
      store('mng.tv', { state: S });
    }

    bus.sub(bus.root + 'bid/+', function (m) {
      if (!m || !S.lot || m.lotId !== S.lot.id) return;
      if (S.lot.phase !== 'open' && S.lot.phase !== 'closing') return;
      var p = playerById(m.slot); if (!p) return;
      seen[m.slot] = now();
      var cur = S.lot.bids[m.slot] || 0;
      var total = Math.floor(Number(m.total));
      if (!isFinite(total) || total <= cur || total > 100000) return;
      S.lot.bids[m.slot] = total;
      bidAt[m.slot] = now();
      flash(m.slot);
      publish();
    });
    bus.sub(bus.root + 'join/+', function (m) {
      if (!m || !m.slot) return;
      seen[m.slot] = now();
      publish();
    });

    function playerById(id) {
      for (var i = 0; i < S.players.length; i++) if (S.players[i].id === id) return S.players[i];
      return null;
    }
    function nameOf(id) { var p = playerById(id); return p ? p.name : '—'; }

    // ---- rendu
    function leader() {
      var best = null;
      Object.keys(S.lot ? S.lot.bids : {}).forEach(function (k) {
        var v = S.lot.bids[k];
        if (!best || v > best.amount || (v === best.amount && (bidAt[k] || 0) < (bidAt[best.id] || 0))) {
          best = { id: k, amount: v };
        }
      });
      return best;
    }
    function remaining() {
      if (!S.lot) return 0;
      return Math.max(0, S.lot.endsAt - now());
    }
    function flash(slot) {
      var el = $('#bidders [data-slot="' + slot + '"]');
      if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    }

    function renderBoard() {
      var ol = $('#board');
      var sorted = S.players.slice().sort(function (a, b) { return b.tab - a.tab || a.name.localeCompare(b.name); });
      ol.innerHTML = '';
      sorted.forEach(function (p, i) {
        var li = document.createElement('li');
        if (i === 0 && p.tab > 0) li.className = 'is-top';
        if (S.lot && S.lot.bids[p.id]) li.className += ' is-live';
        var r = document.createElement('span'); r.className = 'rank'; r.textContent = (i + 1) + '.';
        var n = document.createElement('span'); n.className = 'nm';
        n.textContent = (S.online.indexOf(p.id) >= 0 ? '● ' : '○ ') + p.name;
        var a = document.createElement('span'); a.className = 'amt mono';
        a.textContent = p.tab;
        var s = document.createElement('small'); s.textContent = 'gorgées';
        a.appendChild(s);
        li.appendChild(r); li.appendChild(n); li.appendChild(a);
        ol.appendChild(li);
      });
      var sel = $('#manual-player');
      if (sel.options.length !== S.players.length) {
        sel.innerHTML = '';
        S.players.forEach(function (p) {
          var o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
        });
      }
    }
    function renderHistory() {
      var ul = $('#history');
      ul.innerHTML = '';
      if (!S.history.length) {
        var li = document.createElement('li'); li.className = 'empty';
        li.textContent = "Rien n'a encore été adjugé."; ul.appendChild(li); return;
      }
      S.history.slice().reverse().forEach(function (h) {
        var li = document.createElement('li');
        var t = document.createElement('span'); t.className = 'h-title';
        t.textContent = 'Lot n°' + h.lotId + ' — ' + h.title;
        var b = document.createElement('span');
        b.innerHTML = '';
        var strong = document.createElement('b'); strong.textContent = h.winnerName;
        b.appendChild(document.createTextNode('Adjugé à '));
        b.appendChild(strong);
        b.appendChild(document.createTextNode(' pour ' + h.amount + ' gorgées'));
        li.appendChild(t); li.appendChild(b);
        ul.appendChild(li);
      });
    }
    function renderLast(el) {
      if (!S.last) { show(el, false); return; }
      el.innerHTML = '';
      var p = document.createElement('p'); p.className = 'lr-title';
      p.textContent = 'Dernier lot — ' + S.last.title;
      var m = document.createElement('p'); m.className = 'lr-main';
      m.textContent = S.last.winnerName + ' · ' + S.last.amount + ' gorgées';
      el.appendChild(p); el.appendChild(m);
      show(el, true);
    }

    var CIRC = 2 * Math.PI * 52;
    function renderLive() {
      var L = S.lot;
      show($('#tv-idle'), !L);
      show($('#tv-live'), !!L);
      if (!L) { renderLast($('#tv-last-result')); return; }
      text($('#lot-num'), L.id);
      text($('#lot-phase'), L.phase === 'closed' ? 'adjugé' : (L.phase === 'closing' ? 'clôture…' : 'en vente'));
      text($('#lot-title'), L.title);

      var rem = remaining();
      var secs = Math.ceil(rem / 1000);
      var closed = L.phase === 'closed';
      text($('#timer-num'), closed ? '0' : secs);
      text($('#timer-cap'), closed ? 'terminé' : (L.phase === 'closing' ? 'clôture…' : 'secondes'));
      $('#ring-fg').style.strokeDasharray = CIRC;
      $('#ring-fg').style.strokeDashoffset = CIRC * (1 - (closed ? 0 : rem / (L.duration * 1000)));
      $('.timer-wrap').classList.toggle('is-urgent', !closed && rem <= 10000);

      var b = leader();
      text($('#best-amount'), b ? b.amount : 0);
      text($('#leader-name'), b ? nameOf(b.id) : '— aucune offre —');

      var box = $('#bidders');
      var ids = Object.keys(L.bids).sort(function (x, y) { return L.bids[y] - L.bids[x]; });
      if (box.dataset.sig !== ids.join(',')) {
        box.innerHTML = '';
        box.dataset.sig = ids.join(',');
      }
      ids.forEach(function (id) {
        var el = $('#bidders [data-slot="' + id + '"]');
        if (!el) {
          el = document.createElement('span'); el.className = 'bidder'; el.dataset.slot = id;
          box.appendChild(el);
        }
        el.textContent = nameOf(id) + ' · ' + L.bids[id];
        el.classList.toggle('is-lead', !!(b && b.id === id));
      });

      show($('#btn-close-lot'), L.phase === 'open');
      show($('#btn-cancel-lot'), L.phase !== 'closed');
      show($('#btn-adjuge'), closed && !!b);
      if (closed && !b) {
        show($('#btn-cancel-lot'), true);
        $('#btn-cancel-lot').textContent = 'Aucune offre — retirer le lot';
      } else {
        $('#btn-cancel-lot').textContent = 'Annuler le lot';
      }
      show($('#stamp'), closed && !!b);
    }
    function renderAll() { renderLive(); renderBoard(); renderHistory(); }

    // ---- boucle
    ticker = setInterval(function () {
      var L = S.lot;
      if (L) {
        var rem = remaining();
        if (L.phase === 'open' && rem <= 0) { L.phase = 'closing'; publish(true); }
        else if (L.phase === 'closing' && now() - L.endsAt > 1500) { L.phase = 'closed'; publish(true); }
      }
      renderLive();
      if (++tick % 4 === 0) { renderBoard(); renderHistory(); }
      if (now() - lastPub > (S.lot && S.lot.phase !== 'closed' ? 1000 : 3000)) publish(true);
    }, 120);

    // ---- commandes
    $('#duration-group').addEventListener('click', function (e) {
      var c = e.target.closest('.chip'); if (!c) return;
      $$('#duration-group .chip').forEach(function (x) { x.classList.remove('is-on'); });
      c.classList.add('is-on');
      duration = parseInt(c.dataset.dur, 10);
    });
    function openLot() {
      var custom = $('#lot-custom').value.trim();
      var title = custom || $('#lot-select').value;
      if (!title) return;
      lotCounter++;
      bidAt = {};
      S.lot = { id: lotCounter, title: title, duration: duration, endsAt: now() + duration * 1000, phase: 'open', bids: {} };
      $('#lot-custom').value = '';
      $('#bidders').innerHTML = ''; $('#bidders').dataset.sig = '';
      publish(true); renderAll();
    }
    $('#btn-open-lot').addEventListener('click', openLot);
    $('#btn-close-lot').addEventListener('click', function () {
      if (!S.lot || S.lot.phase !== 'open') return;
      S.lot.endsAt = now(); S.lot.phase = 'closing'; publish(true); renderAll();
    });
    $('#btn-cancel-lot').addEventListener('click', function () {
      S.lot = null; publish(true); renderAll();
    });
    $('#btn-adjuge').addEventListener('click', function () {
      var b = leader(); if (!b || !S.lot) return;
      var p = playerById(b.id); if (!p) return;
      p.tab += b.amount;
      var rec = { lotId: S.lot.id, title: S.lot.title, winnerId: b.id, winnerName: p.name, amount: b.amount, ts: now() };
      S.history.push(rec);
      if (S.history.length > 40) S.history = S.history.slice(-40);
      S.last = rec;
      S.lot = null;
      publish(true); renderAll();
    });
    $('#btn-manual-bid').addEventListener('click', function () {
      if (!S.lot || S.lot.phase === 'closed') return;
      var slot = $('#manual-player').value;
      var amt = Math.max(1, Math.floor(Number($('#manual-amount').value) || 1));
      S.lot.bids[slot] = (S.lot.bids[slot] || 0) + amt;
      bidAt[slot] = now();
      publish(true); renderAll();
    });

    // ---- QR
    function qrURL() {
      var u = location.origin + location.pathname + location.search + '#j/' + S.code;
      return u;
    }
    function openQR() {
      text($('#qr-code'), S.code);
      text($('#qr-url'), qrURL());
      show($('#modal-qr'), true);
      try {
        window.QRCodeLib.toCanvas($('#qr-canvas'), qrURL(), {
          width: 420, margin: 1, errorCorrectionLevel: 'M',
          color: { dark: '#0a0a0c', light: '#ffffff' }
        }, function (err) { if (err) text($('#qr-url'), qrURL() + '  (QR indisponible — tape l\'adresse)'); });
      } catch (e) {}
    }
    $('#tv-code-btn').onclick = openQR;
    $('#btn-qr-close').onclick = function () { show($('#modal-qr'), false); };

    // gages par défaut
    var sel = $('#lot-select');
    if (!sel.options.length) {
      GAGES.forEach(function (g) {
        var o = document.createElement('option'); o.value = g; o.textContent = g; sel.appendChild(o);
      });
    }

    renderAll();
    if (!S.history.length && !S.lot) setTimeout(openQR, 400);

    return {
      stop: function () { clearInterval(ticker); clearTimeout(pubTimer); clearTimeout(stampTimer); bus.close(); },
      state: function () { return S; }
    };
  }

  // ================================================================= JOUEUR
  function startPlayer(code) {
    var bus = new Bus(code, 'pl');
    var key = 'mng.p.' + code;
    var mine = store(key) || { slot: null, lotId: null, total: 0 };
    var S = null, skew = 0, ticker = null, lastSeen = 0, offlineSince = 0, lastReset = 0;
    var STALE_MS = 6000;   // l'écran central publie au moins toutes les 3 s
    var stage = 'who';

    text($('#who-code'), code);
    paintStatus($('#pl-status'), bus.status);
    bus.onStatus = function (s) {
      paintStatus($('#pl-status'), s);
      if (s !== 'online') { if (!offlineSince) offlineSince = now(); }
      else { offlineSince = 0; }
      renderBanner();
    };
    bus.onOpen = function () { sendJoin(); sendBid(); };

    bus.sub('mng/' + code + '/state', function (m) {
      if (!m || !m.players) return;
      S = m;
      skew = m.now - now();
      lastSeen = now();
      // resynchronise ma mise si l'écran central en connaît une plus haute
      if (S.lot && mine.lotId === S.lot.id) {
        var known = S.lot.bids[mine.slot] || 0;
        if (known > mine.total) { mine.total = known; store(key, mine); }
      }
      if (S.lot && mine.lotId !== S.lot.id) { mine.lotId = S.lot.id; mine.total = 0; store(key, mine); }
      render();
    });

    function sendJoin() { if (mine.slot) bus.pub('mng/' + code + '/join/' + deviceId(), { slot: mine.slot }); }
    function sendBid() {
      if (!mine.slot || !S || !S.lot || mine.lotId !== S.lot.id || !mine.total) return;
      if (S.lot.phase === 'closed') return;
      bus.pub('mng/' + code + '/bid/' + deviceId(), { slot: mine.slot, lotId: mine.lotId, total: mine.total, ts: now() });
    }

    function remaining() {
      if (!S || !S.lot) return 0;
      return Math.max(0, S.lot.endsAt - (now() + skew));
    }
    function acked() { return S && S.lot && (S.lot.bids[mine.slot] || 0) >= mine.total; }

    function stale() { return lastSeen > 0 && now() - lastSeen > STALE_MS; }

    function renderBanner() {
      var b = $('#pl-banner');
      var healthy = bus.status === 'online' && !stale();
      paintStatus($('#pl-status'), healthy ? 'online'
        : (bus.status === 'online' ? 'reconnecting' : bus.status));
      if (healthy) { show(b, false); return; }
      if (!lastSeen && bus.status !== 'offline') {
        text(b, 'Connexion en cours…');
      } else if (lastSeen && now() - lastSeen > 25000) {
        text(b, "Plus de nouvelles de l'écran central depuis un moment. "
              + "Vérifie qu'il est toujours allumé, ou préviens l'organisatrice.");
      } else {
        text(b, "Connexion perdue. On réessaie tout seul — garde l'écran ouvert, "
              + 'tes mises sont conservées et repartiront dès le retour du réseau.');
      }
      show(b, true);
    }

    function renderWho() {
      var list = $('#who-list');
      if (!S) { show($('#who-wait'), true); return; }
      show($('#who-wait'), false);
      var sig = S.players.map(function (p) { return p.id + (S.online.indexOf(p.id) >= 0 ? '*' : ''); }).join(',');
      if (list.dataset.sig === sig) return;
      list.dataset.sig = sig;
      list.innerHTML = '';
      S.players.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'who-btn' + (S.online.indexOf(p.id) >= 0 ? ' is-taken' : '');
        b.type = 'button';
        b.textContent = p.name;
        b.addEventListener('click', function () {
          mine.slot = p.id; mine.total = 0; mine.lotId = S.lot ? S.lot.id : null;
          store(key, mine);
          stage = 'play'; sendJoin(); goto('player'); render();
        });
        list.appendChild(b);
      });
    }

    function meRec() {
      if (!S || !mine.slot) return null;
      for (var i = 0; i < S.players.length; i++) if (S.players[i].id === mine.slot) return S.players[i];
      return null;
    }
    function nameOf(id) {
      if (!S) return '—';
      for (var i = 0; i < S.players.length; i++) if (S.players[i].id === id) return S.players[i].name;
      return '—';
    }
    function leader() {
      if (!S || !S.lot) return null;
      var best = null;
      Object.keys(S.lot.bids).forEach(function (k) {
        if (!best || S.lot.bids[k] > best.amount) best = { id: k, amount: S.lot.bids[k] };
      });
      return best;
    }

    function renderPlay() {
      var me = meRec();
      text($('#me-name'), me ? me.name : '');
      text($('#me-tab'), me ? me.tab : 0);
      var L = S && S.lot;
      var live = !!L && L.phase !== 'closed';
      show($('#pl-waiting'), !L);
      show($('#pl-live'), !!L);

      if (!L) {
        if (S && S.last) {
          var el = $('#pl-last');
          el.innerHTML = '';
          var p1 = document.createElement('p'); p1.className = 'lr-title'; p1.textContent = S.last.title;
          var p2 = document.createElement('p'); p2.className = 'lr-main';
          p2.textContent = 'Adjugé à ' + S.last.winnerName + ' · ' + S.last.amount + ' gorgées';
          el.appendChild(p1); el.appendChild(p2);
          show(el, true);
        }
        return;
      }

      text($('#pl-lot-num'), L.id);
      text($('#pl-lot-title'), L.title);
      var secs = Math.ceil(remaining() / 1000);
      text($('#pl-timer'), L.phase === 'closed' ? '0' : secs);
      $$('.pl-meta-cell')[0].classList.toggle('is-urgent', live && remaining() <= 10000);
      var b = leader();
      text($('#pl-best'), b ? b.amount : 0);
      text($('#pl-leader'), b ? (b.id === mine.slot ? 'toi' : nameOf(b.id)) : '—');
      text($('#pl-mine'), mine.total);

      $('#btn-bid1').disabled = !live;
      $('#btn-bid5').disabled = !live;
      text($('#pl-hint'), !live ? 'Enchères closes.'
        : (acked() ? 'Chaque gorgée misée, tu la bois si tu remportes le lot.' : 'Envoi de ta mise…'));

      var res = $('#pl-result');
      if (L.phase === 'closed') {
        var win = b && b.id === mine.slot;
        res.className = 'pl-result' + (win ? ' is-win' : '');
        res.innerHTML = '';
        var h = document.createElement('p'); h.className = 'pr-head'; h.textContent = 'Adjugé';
        var bd = document.createElement('p'); bd.className = 'pr-body';
        bd.textContent = b
          ? (win ? 'Tu remportes le lot. Tu dois ' + b.amount + ' gorgées — et c\'est toi qui désignes.'
                 : nameOf(b.id) + ' remporte le lot pour ' + b.amount + ' gorgées.')
          : 'Aucune offre. Le lot est retiré.';
        res.appendChild(h); res.appendChild(bd);
        show(res, true);
      } else show(res, false);
    }

    function render() {
      renderBanner();
      if (!mine.slot) { stage = 'who'; renderWho(); if (current !== 'who') goto('who'); }
      else { stage = 'play'; renderPlay(); if (current !== 'player') goto('player'); }
    }

    function bid(n) {
      if (!S || !S.lot || S.lot.phase === 'closed') return;
      if (remaining() <= 0 && S.lot.phase === 'open') return;
      if (mine.lotId !== S.lot.id) { mine.lotId = S.lot.id; mine.total = 0; }
      mine.total += n;
      store(key, mine);
      text($('#pl-mine'), mine.total);
      var el = $('#btn-bid1');
      el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
      sendBid();
    }
    function tap(el, n) {
      el.addEventListener('pointerdown', function (e) { e.preventDefault(); bid(n); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bid(n); }
      });
    }
    tap($('#btn-bid1'), 1);
    tap($('#btn-bid5'), 5);

    // rejoue la mise tant qu'elle n'est pas acquittée ; ping de présence
    var pings = 0;
    ticker = setInterval(function () {
      if (mine.slot && !acked()) sendBid();
      if (++pings % 8 === 0) sendJoin();
      // plus rien ne descend de l'écran central : on relance la connexion
      if (stale() && now() - lastReset > 7000) { lastReset = now(); bus.reset(); }
      if (S && S.lot) renderPlay();
      renderBanner();
    }, 700);

    render();
    return {
      stop: function () { clearInterval(ticker); bus.close(); },
      screen: function () { return mine.slot ? 'player' : 'who'; }
    };
  }

  // ============================================================= DIAGNOSTIC
  $('#btn-diag-run').addEventListener('click', function () {
    var ul = $('#diag-list'); ul.innerHTML = '';
    var btn = $('#btn-diag-run'); btn.disabled = true;
    var list = brokerList(), done = 0, okCount = 0;
    function line(txt, cls) {
      var li = document.createElement('li'); li.textContent = txt; if (cls) li.className = cls;
      ul.appendChild(li); return li;
    }
    line('Appareil : ' + (navigator.userAgent.length > 60 ? navigator.userAgent.slice(0, 60) + '…' : navigator.userAgent));
    line('Réseau : ' + (navigator.onLine ? 'en ligne' : 'hors ligne'), navigator.onLine ? 'ok' : 'ko');
    list.forEach(function (url) {
      var li = line('… ' + url);
      var t0 = now(), settled = false;
      var c = window.mqtt.connect(url, { connectTimeout: 8000, reconnectPeriod: 0, clean: true, clientId: 'mng_diag_' + randCode(6).toLowerCase() });
      function finish(ok, why) {
        if (settled) return; settled = true;
        li.textContent = (ok ? '✓ ' : '✗ ') + url + (ok ? ' — ' + (now() - t0) + ' ms' : ' — ' + why);
        li.className = ok ? 'ok' : 'ko';
        if (ok) okCount++;
        try { c.removeAllListeners(); c.end(true); } catch (e) {}
        if (++done === list.length) {
          btn.disabled = false;
          line(okCount ? 'Résultat : ce téléphone peut jouer (' + okCount + '/' + list.length + ' relais joignables).'
                       : 'Résultat : aucun relais joignable. Change de réseau (Wi-Fi ↔ 4G) et réessaie.',
               okCount ? 'ok' : 'ko');
        }
      }
      c.on('connect', function () { finish(true); });
      c.on('error', function (e) { finish(false, String(e && e.message || e).slice(0, 40)); });
      c.on('close', function () { finish(false, 'connexion refusée'); });
      setTimeout(function () { finish(false, 'délai dépassé'); }, 9000);
    });
  });

  route();
})();
