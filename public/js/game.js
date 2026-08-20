/*
 * Le Marché Noir des Gages — logique de jeu pure.
 *
 * Ce fichier ne touche ni au DOM ni au réseau : il ne contient que les règles.
 * Il tourne à l'identique dans le navigateur (window.MNG) et dans Node (module.exports),
 * ce qui permet de le tester unitairement.
 *
 * Modèle d'autorité : l'écran central est le seul à muter l'état. Les téléphones
 * envoient des commandes idempotentes (identifiées par `id`) et reçoivent des
 * instantanés d'état complets.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MNG = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL = 1;

  // Nombre d'identifiants de commandes mémorisés pour la déduplication.
  // Large devant le débit maximal réaliste (9 joueurs x ~5 taps/s x 10 s de fenêtre).
  var MAX_ACKS = 400;

  // Nombre d'acquittements réellement diffusés dans chaque instantané. On garde
  // une mémoire large côté central (déduplication) mais on n'envoie qu'une
  // fenêtre récente sur le réseau, pour ne pas gonfler chaque message.
  var SNAP_ACKS = 150;

  // Marge de tolérance après la fin du minuteur : une mise partie à temps mais
  // ralentie par le réseau est quand même acceptée. Personne ne doit perdre une
  // mise à cause de la latence.
  var GRACE_MS = 600;

  var MAX_BID_STEP = 50;
  var MAX_HISTORY = 30;
  var DURATIONS = [20, 30, 45, 60];

  var DEFAULT_LOTS = [
    "Désigner qui porte le chapeau le plus ridicule de la maison jusqu'à la fin de la soirée",
    "Désigner qui raconte sa pire honte amoureuse, version intégrale non censurée",
    'Désigner qui doit danser seul au milieu du groupe pendant une chanson entière',
    "Désigner qui parle avec un accent imposé par le groupe pendant 30 minutes",
    'Désigner qui lit à voix haute son dernier message envoyé… et celui juste avant',
    'Désigner qui répond en chantant à toutes les questions pendant 15 minutes',
    "Désigner deux personnes siamoises : jamais à plus d'un mètre l'une de l'autre pendant une heure",
    'Désigner qui devient le majordome du groupe pendant 20 minutes',
    "Désigner qui fait une déclaration d'amour enflammée à un objet de la pièce",
    "Désigner qui imite quelqu'un du groupe jusqu'à ce qu'on devine de qui il s'agit",
    "Désigner qui n'a plus le droit de dire « je » pendant 20 minutes",
    'DROIT : être exempté du prochain gage, quel qu’il soit',
    'DROIT : imposer le prochain gage à la personne de son choix, sans enchère',
  ];

  var CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ2346789'; // sans I/O/0/1/S/5/B/8 ambigus

  function makeCode(rnd) {
    var r = rnd || Math.random;
    var out = '';
    for (var i = 0; i < 5; i++) out += CODE_ALPHABET[Math.floor(r() * CODE_ALPHABET.length)];
    return out;
  }

  function makeId(rnd) {
    var r = rnd || Math.random;
    return Date.now().toString(36) + '-' + Math.floor(r() * 1e9).toString(36);
  }

  function slugId(name, index) {
    return 'p' + (index + 1);
  }

  /* ---------------------------------------------------------------- état ---- */

  function createState(code, names, now) {
    var players = [];
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i] || '').trim();
      if (!n) continue;
      players.push({ id: slugId(n, players.length), name: n, tab: 0, seen: 0 });
    }
    return {
      v: PROTOCOL,
      code: code,
      rev: 0,
      now: now || Date.now(),
      players: players,
      phase: 'lobby', // lobby | open | closed
      lot: null, // { title }
      duration: 30,
      endsAt: null,
      bids: {}, // playerId -> total de gorgées misées sur le lot en cours
      order: {}, // playerId -> numéro de séquence du dernier changement (départage)
      seq: 0,
      result: null, // { title, winnerId, winnerName, amount }
      history: [],
      acks: [],
    };
  }

  function player(state, id) {
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].id === id) return state.players[i];
    }
    return null;
  }

  /**
   * Meneur actuel : le plus offrant. À égalité, celui qui a atteint le montant
   * en premier (numéro de séquence le plus bas).
   */
  function leader(state) {
    var best = null;
    for (var id in state.bids) {
      if (!Object.prototype.hasOwnProperty.call(state.bids, id)) continue;
      var amount = state.bids[id];
      if (!amount) continue;
      var p = player(state, id);
      if (!p) continue;
      var cand = { id: id, name: p.name, amount: amount, order: state.order[id] || 0 };
      if (!best || cand.amount > best.amount || (cand.amount === best.amount && cand.order < best.order)) {
        best = cand;
      }
    }
    return best;
  }

  function ranking(state) {
    return state.players
      .slice()
      .sort(function (a, b) {
        return b.tab - a.tab || a.name.localeCompare(b.name, 'fr');
      });
  }

  function remainingMs(state, now) {
    if (state.phase !== 'open' || !state.endsAt) return 0;
    return Math.max(0, state.endsAt - now);
  }

  /* ------------------------------------------------------- actions centrales -- */

  function openLot(state, title, duration, now) {
    var t = String(title || '').trim();
    if (!t) return false;
    if (state.phase === 'open') return false;
    var d = DURATIONS.indexOf(Number(duration)) !== -1 ? Number(duration) : state.duration;
    state.phase = 'open';
    state.lot = { title: t };
    state.duration = d;
    state.endsAt = now + d * 1000;
    state.bids = {};
    state.order = {};
    state.seq = 0;
    state.result = null;
    return true;
  }

  /** Clôture (automatique à l'expiration du minuteur, ou manuelle). */
  function closeLot(state, now) {
    if (state.phase !== 'open') return false;
    var win = leader(state);
    state.phase = 'closed';
    state.endsAt = now;
    state.result = win
      ? { title: state.lot.title, winnerId: win.id, winnerName: win.name, amount: win.amount }
      : { title: state.lot.title, winnerId: null, winnerName: null, amount: 0 };
    return true;
  }

  /** Validation par l'organisatrice : le gagnant encaisse sa dette sur l'ardoise. */
  function settle(state, now) {
    if (state.phase !== 'closed' || !state.result) return false;
    var r = state.result;
    if (r.winnerId) {
      var p = player(state, r.winnerId);
      if (p) p.tab += r.amount;
    }
    state.history.unshift({
      title: r.title,
      winnerName: r.winnerName,
      amount: r.amount,
      at: now,
    });
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    resetToLobby(state);
    return true;
  }

  /** Annulation d'un lot : rien n'est encaissé, rien n'entre dans l'historique. */
  function cancelLot(state) {
    if (state.phase === 'lobby') return false;
    resetToLobby(state);
    return true;
  }

  function resetToLobby(state) {
    state.phase = 'lobby';
    state.lot = null;
    state.endsAt = null;
    state.bids = {};
    state.order = {};
    state.seq = 0;
    state.result = null;
  }

  function adjustTab(state, playerId, delta) {
    var p = player(state, playerId);
    if (!p) return false;
    p.tab = Math.max(0, p.tab + delta);
    return true;
  }

  /* ---------------------------------------------------- commandes téléphones -- */

  function isAcked(state, cmdId) {
    return state.acks.indexOf(cmdId) !== -1;
  }

  function ack(state, cmdId) {
    state.acks.push(cmdId);
    if (state.acks.length > MAX_ACKS) state.acks.splice(0, state.acks.length - MAX_ACKS);
  }

  /**
   * Applique une commande venue d'un téléphone.
   * Retourne { applied, changed } — `applied` vaut false si la commande est un
   * doublon déjà traité (ré-émission), auquel cas elle est ignorée silencieusement.
   *
   * Toute commande reçue est acquittée, même si elle est refusée (enchère fermée,
   * joueur inconnu) : le téléphone doit arrêter de la ré-émettre. L'écran du
   * joueur se recale ensuite sur le montant faisant autorité.
   */
  function applyCommand(state, cmd, now) {
    if (!cmd || typeof cmd.id !== 'string' || !cmd.id) return { applied: false, changed: false };
    if (isAcked(state, cmd.id)) return { applied: false, changed: false };

    var changed = false;
    var p;

    if (cmd.t === 'bid') {
      p = player(state, cmd.p);
      var n = Math.floor(Number(cmd.n));
      var open = state.phase === 'open' && state.endsAt !== null && now <= state.endsAt + GRACE_MS;
      if (p && open && n > 0 && n <= MAX_BID_STEP) {
        state.seq += 1;
        state.bids[p.id] = (state.bids[p.id] || 0) + n;
        state.order[p.id] = state.seq;
        p.seen = now;
        changed = true;
      }
    } else if (cmd.t === 'join') {
      p = player(state, cmd.p);
      if (p) {
        p.seen = now;
        changed = true;
      }
    }
    // 'hello' : aucune mutation, sert juste à réclamer un instantané.

    ack(state, cmd.id);
    return { applied: true, changed: changed };
  }

  /* ------------------------------------------------- instantané réseau (état) -- */

  /**
   * Version allégée de l'état publiée sur le réseau. On évite d'envoyer
   * l'historique complet et la totalité des acquittements à chaque tap.
   */
  function snapshot(state, now) {
    return {
      v: PROTOCOL,
      code: state.code,
      rev: state.rev,
      now: now,
      players: state.players.map(function (p) {
        return { id: p.id, name: p.name, tab: p.tab, seen: p.seen };
      }),
      phase: state.phase,
      lot: state.lot,
      duration: state.duration,
      endsAt: state.endsAt,
      bids: state.bids,
      leader: leader(state),
      result: state.result,
      history: state.history.slice(0, 12),
      acks: state.acks.slice(-SNAP_ACKS),
    };
  }

  return {
    PROTOCOL: PROTOCOL,
    GRACE_MS: GRACE_MS,
    MAX_BID_STEP: MAX_BID_STEP,
    DURATIONS: DURATIONS,
    DEFAULT_LOTS: DEFAULT_LOTS,
    makeCode: makeCode,
    makeId: makeId,
    createState: createState,
    player: player,
    leader: leader,
    ranking: ranking,
    remainingMs: remainingMs,
    openLot: openLot,
    closeLot: closeLot,
    settle: settle,
    cancelLot: cancelLot,
    resetToLobby: resetToLobby,
    adjustTab: adjustTab,
    applyCommand: applyCommand,
    isAcked: isAcked,
    snapshot: snapshot,
  };
});
