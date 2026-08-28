/* =========================================================
   LE MARCHÉ NOIR DES GAGES
   Enchères clandestines en gorgées — écran central + téléphones.

   Architecture :
   - Transport : MQTT sur WebSocket sécurisé (brokers publics, aucun compte).
   - L'écran central est l'unique autorité : il détient l'état, applique les
     mises et republie l'état complet en "retained" (les retardataires
     reçoivent donc l'état courant dès qu'ils s'abonnent).
   - Les téléphones n'envoient que des intentions ("monte de +1"), jamais un
     montant absolu : aucune course entre deux joueurs qui tapent en même temps.
   ========================================================= */
(function () {
'use strict';

/* ---------------------------------------------------------
   1. Constantes
   --------------------------------------------------------- */

// L'identifiant (1re lettre du code de salle) désigne le broker : un joueur
// qui scanne le QR sait donc sur quel serveur rejoindre l'écran central.
// Liste établie à la mesure (test/sonde-brokers.js) : connexion + messages
// « retained » vérifiés depuis Internet. Mosquitto et Eclipse ont été retirés,
// ils ne répondent plus.
var BROKERS = [
  { id: 'A', nom: 'EMQX',      url: 'wss://broker.emqx.io:8084/mqtt' },
  { id: 'B', nom: 'HiveMQ',    url: 'wss://broker.hivemq.com:8884/mqtt' },
  { id: 'C', nom: 'Dashboard', url: 'wss://mqtt-dashboard.com:8884/mqtt' },
  { id: 'D', nom: 'EMQX bis',  url: 'wss://broker-cn.emqx.io:8084/mqtt' }
];

var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1
var DUREES = [20, 30, 45, 60];
var PROLONGATION_MS = 3000;   // anti-snipe : toute mise dans les 3 dernières secondes relance à 3 s

var GAGES = [
  "Désigner qui porte un chapeau ridicule toute la soirée",
  "Désigner qui doit raconter sa pire honte amoureuse",
  "Désigner qui doit danser seul au milieu du groupe",
  "Désigner qui parle avec un accent imposé pendant 20 minutes",
  "Désigner qui lit à voix haute son dernier message envoyé",
  "Désigner qui devient le serveur du groupe pendant 15 minutes",
  "Le droit d'imposer un surnom à quelqu'un pour le reste des vacances",
  "Désigner qui doit faire un discours d'une minute sur un sujet imposé",
  "Désigner qui n'a plus le droit de dire « non » pendant 30 minutes",
  "Désigner qui imite quelqu'un du groupe jusqu'à ce qu'on devine",
  "Le droit de faire boire 3 gorgées à qui tu veux",
  "Désigner qui range la cuisine demain matin",
  "Le droit d'échanger de tenue avec quelqu'un pendant 30 minutes",
  "Désigner qui doit répondre à toutes les questions en chantant pendant 10 minutes"
];

/* ---------------------------------------------------------
   2. Utilitaires
   --------------------------------------------------------- */

function h(tag, attrs, enfants) {
  var e = document.createElement(tag);
  if (attrs) {
    for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  if (enfants) {
    if (!Array.isArray(enfants)) enfants = [enfants];
    for (var i = 0; i < enfants.length; i++) {
      var c = enfants[i];
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return e;
}

function vider(n) { while (n.firstChild) n.removeChild(n.firstChild); }

function alea(n) {
  var s = '';
  var buf = new Uint8Array(n);
  (window.crypto || window.msCrypto).getRandomValues(buf);
  for (var i = 0; i < n; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

function idUnique() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function slug(nom) {
  return nom.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'j';
}

function gorgees(n) { return n + (n > 1 ? ' gorgées' : ' gorgée'); }

function lire(cle) {
  try { var v = localStorage.getItem(cle); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function ecrire(cle, val) {
  try { localStorage.setItem(cle, JSON.stringify(val)); } catch (e) { /* mode privé Safari */ }
}
function effacer(cle) {
  try { localStorage.removeItem(cle); } catch (e) {}
}

function params() {
  var p = {};
  var q = location.search.replace(/^\?/, '').split('&');
  for (var i = 0; i < q.length; i++) {
    if (!q[i]) continue;
    var kv = q[i].split('=');
    p[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
  }
  return p;
}
var P = params();

function brokerParId(id) {
  for (var i = 0; i < BROKERS.length; i++) if (BROKERS[i].id === id) return BROKERS[i];
  return null;
}

// Permet aux tests automatisés (et à un dépannage sur place) de forcer un serveur.
function brokersDisponibles() {
  if (P.bu && /^wss:\/\//.test(P.bu)) return [{ id: 'Z', nom: 'Perso', url: P.bu }];
  if (P.bu && /^ws:\/\/(localhost|127\.0\.0\.1)/.test(P.bu)) return [{ id: 'Z', nom: 'Local', url: P.bu }];
  if (P.b) { var b = brokerParId(P.b.toUpperCase()); if (b) return [b]; }
  return BROKERS;
}

function urlSalle(code) {
  var base = location.origin + location.pathname;
  var u = base + '?s=' + code;
  if (P.bu) u += '&bu=' + encodeURIComponent(P.bu);
  return u;
}

/* Petit son d'enchère (écran central uniquement) — sans fichier externe. */
var Son = (function () {
  var ctx = null, actif = true;
  function ouvrir() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    return ctx;
  }
  return {
    reveiller: function () { var c = ouvrir(); if (c && c.state === 'suspended') c.resume(); },
    basculer: function () { actif = !actif; return actif; },
    estActif: function () { return actif; },
    coup: function (aigu) {
      if (!actif) return;
      var c = ouvrir(); if (!c || c.state !== 'running') return;
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = aigu ? 880 : 440;
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.14, c.currentTime + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.16);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.18);
    }
  };
})();

/* Empêche l'écran central de s'éteindre. */
var veille = null;
function garderEveille() {
  if (!('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').then(function (v) {
    veille = v;
    v.addEventListener('release', function () { veille = null; });
  }).catch(function () {});
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && !veille && App.mode === 'hote') garderEveille();
});

/* ---------------------------------------------------------
   3. Transport MQTT
   --------------------------------------------------------- */

function creerLien(opts) {
  var abonnes = { etat: [], message: [] };
  var client = null;
  var ferme = false;

  // Trois signaux distincts peuvent dégrader la ligne :
  //  - ce que dit MQTT (etatMqtt),
  //  - ce que dit le système (navigator.onLine),
  //  - le silence applicatif : plus rien ne nous parvient alors que la
  //    connexion se croit vivante (typique d'un WiFi qui a lâché sans
  //    prévenir — MQTT ne s'en aperçoit qu'au bout du keepalive).
  var etatMqtt = 'attente';
  var reseauKo = (typeof navigator.onLine === 'boolean') ? !navigator.onLine : false;
  var perime = false;
  var dernierVisible = null;
  var derniereRaison = '';

  function emettre(nom, a, b) {
    var l = abonnes[nom];
    for (var i = 0; i < l.length; i++) { try { l[i](a, b); } catch (e) { console.error(e); } }
  }
  function visible() {
    if (reseauKo) return 'attente';
    if (etatMqtt === 'ok' && perime) return 'attente';
    return etatMqtt;
  }
  function notifier(raison) {
    var v = visible();
    if (raison !== undefined) derniereRaison = raison || '';
    if (v === dernierVisible && v !== 'ko') return;
    dernierVisible = v;
    emettre('etat', v, derniereRaison);
  }
  function majEtat(e, info) {
    etatMqtt = e;
    notifier(info);
  }

  function surHorsLigne() { reseauKo = true; notifier('réseau coupé'); }
  function surEnLigne() { reseauKo = false; notifier(''); }
  window.addEventListener('offline', surHorsLigne);
  window.addEventListener('online', surEnLigne);

  var options = {
    clientId: 'mng_' + idUnique(),
    clean: true,
    protocolVersion: 4,
    // Volontairement court : c'est ce qui borne le temps que met MQTT à
    // constater qu'une connexion est morte.
    keepalive: 15,
    reconnectPeriod: 2500,
    connectTimeout: 9000,
    resubscribe: true
  };
  if (opts.will) options.will = {
    topic: opts.will.topic,
    payload: JSON.stringify(opts.will.payload),
    qos: 1,
    retain: true
  };

  client = mqtt.connect(opts.url, options);

  var jamaisConnecte = true;
  var echecs = 0;

  client.on('connect', function () {
    jamaisConnecte = false;
    echecs = 0;
    majEtat('ok');
  });
  client.on('reconnect', function () { if (!ferme) majEtat('attente'); });
  client.on('close', function () { if (!ferme && !jamaisConnecte) majEtat('attente'); });
  client.on('offline', function () { if (!ferme) majEtat('attente'); });
  client.on('error', function (err) {
    echecs++;
    if (ferme) return;
    // Après plusieurs échecs consécutifs sans jamais avoir été connecté,
    // on considère le serveur comme injoignable et on prévient l'utilisateur.
    if (jamaisConnecte && echecs >= 2) majEtat('ko', err && err.message ? err.message : 'connexion impossible');
    else majEtat('attente');
  });
  client.on('message', function (topic, payload) {
    var obj;
    try { obj = JSON.parse(payload.toString()); }
    catch (e) { return; }
    emettre('message', topic, obj);
  });

  // Filet : si rien n'a abouti au bout de 12 s, on bascule en erreur visible.
  setTimeout(function () {
    if (!ferme && jamaisConnecte) majEtat('ko', 'délai dépassé');
  }, 12000);

  return {
    on: function (nom, fn) { abonnes[nom].push(fn); return this; },
    etat: function () { return visible(); },
    connecte: function () { return !!(client && client.connected) && !reseauKo; },
    // Déclaré par la couche applicative quand plus rien n'arrive.
    marquerPerime: function (p, raison) {
      if (perime === p) return;
      perime = p;
      notifier(p ? (raison || 'signal perdu') : '');
    },
    abonner: function (topic) { client.subscribe(topic, { qos: 1 }); },
    publier: function (topic, obj, o) {
      if (!client) return;
      o = o || {};
      client.publish(topic, JSON.stringify(obj), { qos: o.qos === 0 ? 0 : 1, retain: !!o.retain });
    },
    fermer: function () {
      ferme = true;
      window.removeEventListener('offline', surHorsLigne);
      window.removeEventListener('online', surEnLigne);
      try { client.end(true); } catch (e) {}
    }
  };
}

function topics(code) {
  return {
    etat: 'mng/' + code + '/etat',
    cmd:  'mng/' + code + '/cmd',
    hote: 'mng/' + code + '/hote'
  };
}

/* ---------------------------------------------------------
   4. Bandeau d'état de connexion
   --------------------------------------------------------- */

function creerBandeau() {
  var pastille = h('span', { class: 'pastille' });
  var texte = h('span', { text: 'Connexion au marché…' });
  var extra = h('span', { class: 'pousse' });
  var root = h('div', { class: 'lien-etat', 'data-etat': 'attente' }, [pastille, texte, extra]);
  return {
    root: root,
    maj: function (etat, msg, suffixe) {
      root.setAttribute('data-etat', etat);
      texte.textContent =
        etat === 'ok' ? 'Ligne sécurisée' :
        etat === 'attente' ? (msg ? 'Reconnexion — ' + msg : 'Connexion au marché…') :
        ('Hors ligne — ' + (msg || 'serveur injoignable'));
      extra.textContent = suffixe || '';
    }
  };
}

/* ---------------------------------------------------------
   5. Écran central (hôte) — logique
   --------------------------------------------------------- */

function creerHote(code, broker, joueursInitiaux, programmeInitial, etatRepris) {
  var t = topics(code);
  var nonces = [];       // anti-doublon des mises (QoS 1 peut redélivrer)
  var noncesSet = {};
  var vus = {};          // pid -> timestamp de dernière activité

  // Le programme est la colonne vertébrale de la soirée : tous les gages sont
  // saisis d'avance, on les vend dans l'ordre, et chaque entrée garde son
  // résultat. L'historique et le récapitulatif final s'en déduisent.
  var etat = etatRepris || {
    v: 2,
    code: code,
    rev: 0,
    hostNow: Date.now(),
    joueurs: joueursInitiaux.map(function (n) { return { id: slug(n), nom: n }; }),
    ardoise: {},
    enLigne: [],
    programme: (programmeInitial || []).map(function (titre) {
      return { id: idUnique(), titre: titre, statut: 'attente', pid: null, montant: 0, ts: 0 };
    }),
    lot: null,
    recap: false
  };
  etat.code = code;
  if (!etat.programme) etat.programme = [];

  var lien = creerLien({
    url: broker.url,
    will: { topic: t.hote, payload: { online: false, ts: Date.now() } }
  });

  var minuteurPublication = null;
  var dernierePublication = 0;

  function publier(immediat) {
    var maintenant = Date.now();
    if (!immediat && maintenant - dernierePublication < 120) {
      if (!minuteurPublication) {
        minuteurPublication = setTimeout(function () {
          minuteurPublication = null;
          publier(true);
        }, 120 - (maintenant - dernierePublication));
      }
      return;
    }
    if (minuteurPublication) { clearTimeout(minuteurPublication); minuteurPublication = null; }
    dernierePublication = maintenant;
    etat.rev++;
    etat.hostNow = maintenant;
    etat.enLigne = Object.keys(vus).filter(function (pid) { return maintenant - vus[pid] < 25000; });
    lien.publier(t.etat, etat, { retain: true });
    sauver(!etat.lot || etat.lot.statut !== 'ouvert');
    if (api.onEtat) api.onEtat(etat);
  }

  var derniereSauvegarde = 0;
  function sauver(force) {
    // Écriture disque synchrone : inutile de la faire à chaque mise.
    if (!force && Date.now() - derniereSauvegarde < 2000) return;
    derniereSauvegarde = Date.now();
    ecrire('mng.hote', {
      code: code, brokerId: broker.id, ts: Date.now(),
      etat: { v: etat.v, code: etat.code, rev: etat.rev, joueurs: etat.joueurs,
              ardoise: etat.ardoise, lot: etat.lot, programme: etat.programme,
              recap: etat.recap, enLigne: [] }
    });
  }

  function joueurConnu(pid) {
    for (var i = 0; i < etat.joueurs.length; i++) if (etat.joueurs[i].id === pid) return etat.joueurs[i];
    return null;
  }

  function entreeProgramme(id) {
    for (var i = 0; i < etat.programme.length; i++) {
      if (etat.programme[i].id === id) return etat.programme[i];
    }
    return null;
  }

  function traiterCmd(m) {
    if (!m || !m.t) return;
    var j = joueurConnu(m.pid);

    if (m.t === 'ici' || m.t === 'join') {
      if (!j) return;
      vus[m.pid] = Date.now();
      publier(m.t === 'join');
      return;
    }

    if (m.t === 'mise') {
      if (!j) return;
      if (!etat.lot || etat.lot.statut !== 'ouvert') return;
      if (m.n) {
        if (noncesSet[m.n]) return;         // déjà pris en compte
        noncesSet[m.n] = 1;
        nonces.push(m.n);
        if (nonces.length > 300) delete noncesSet[nonces.shift()];
      }
      var de = Math.round(Number(m.de));
      if (!isFinite(de) || de < 1) return;
      if (de > 500) de = 500;               // garde-fou anti-erreur
      vus[m.pid] = Date.now();

      // Aucune mise n'est jamais ignorée : l'interface empêche déjà de
      // surenchérir sur soi-même, mais si un tap part sur un état légèrement
      // périmé, il vaut mieux l'appliquer que le perdre en silence.
      var nouveau = (etat.lot.montant || 0) + de;
      etat.lot.offres[m.pid] = nouveau;
      etat.lot.meneur = m.pid;
      etat.lot.montant = nouveau;

      var restant = etat.lot.fin - Date.now();
      if (restant > 0 && restant < PROLONGATION_MS) {
        etat.lot.fin = Date.now() + PROLONGATION_MS;
        etat.lot.prolonge = true;
      }
      publier();
      if (api.onMise) api.onMise(m.pid, nouveau);
    }
  }

  lien.on('etat', function (e, info) {
    if (e === 'ok') {
      lien.abonner(t.cmd);
      lien.publier(t.hote, { online: true, ts: Date.now() }, { retain: true });
      publier(true);
    }
    if (api.onLien) api.onLien(e, info);
  });
  lien.on('message', function (topic, obj) {
    if (topic === t.cmd) traiterCmd(obj);
  });

  // Horloge : clôture automatique + rafraîchissement de la présence.
  var tic = setInterval(function () {
    if (etat.lot && etat.lot.statut === 'ouvert' && Date.now() >= etat.lot.fin) {
      etat.lot.statut = 'adjuge';
      publier(true);
      if (api.onCloture) api.onCloture(etat.lot);
    }
    if (api.onTic) api.onTic();
  }, 200);

  var battement = setInterval(function () {
    if (lien.connecte()) publier(true);
  }, 6000);

  var api = {
    code: code,
    broker: broker,
    lien: lien,
    etat: function () { return etat; },

    // Le prochain lot à vendre : la première entrée encore en attente.
    prochain: function () {
      for (var i = 0; i < etat.programme.length; i++) {
        if (etat.programme[i].statut === 'attente') return etat.programme[i];
      }
      return null;
    },

    position: function () {
      var vendus = 0, total = etat.programme.length;
      for (var i = 0; i < etat.programme.length; i++) {
        if (etat.programme[i].statut !== 'attente') vendus++;
      }
      return { faits: vendus, total: total, restants: total - vendus };
    },

    demarrerProchain: function (dureeSec) {
      var p = api.prochain();
      if (!p || etat.lot) return;
      etat.recap = false;
      etat.lot = {
        id: p.id,
        titre: p.titre,
        statut: 'ouvert',
        duree: dureeSec * 1000,
        debut: Date.now(),
        fin: Date.now() + dureeSec * 1000,
        offres: {},
        meneur: null,
        montant: 0,
        prolonge: false
      };
      publier(true);
    },

    // Sauter un gage sans le vendre (il ne reviendra pas).
    passerProchain: function () {
      var p = api.prochain();
      if (!p || etat.lot) return;
      p.statut = 'retire';
      publier(true);
    },

    ajouterGages: function (titres) {
      titres.forEach(function (titre) {
        var t = String(titre).trim();
        if (!t) return;
        etat.programme.push({ id: idUnique(), titre: t, statut: 'attente', pid: null, montant: 0, ts: 0 });
      });
      etat.recap = false;
      publier(true);
    },

    montrerRecap: function (oui) { etat.recap = !!oui; publier(true); },

    cloturer: function () {
      if (etat.lot && etat.lot.statut === 'ouvert') {
        etat.lot.statut = 'adjuge';
        publier(true);
        if (api.onCloture) api.onCloture(etat.lot);
      }
    },

    valider: function () {
      var lot = etat.lot;
      if (!lot || lot.statut !== 'adjuge') return;
      var entree = entreeProgramme(lot.id);
      if (lot.meneur) {
        etat.ardoise[lot.meneur] = (etat.ardoise[lot.meneur] || 0) + lot.montant;
        if (entree) {
          entree.statut = 'vendu';
          entree.pid = lot.meneur;
          entree.montant = lot.montant;
          entree.ts = Date.now();
        }
      } else if (entree) {
        entree.statut = 'retire';
        entree.ts = Date.now();
      }
      etat.lot = null;
      // Dernier gage vendu : le récapitulatif s'ouvre tout seul sur la TV.
      if (!api.prochain()) etat.recap = true;
      publier(true);
    },

    // Le lot ne compte pas : il retourne dans le programme, à vendre plus tard.
    annulerLot: function () { etat.lot = null; publier(true); },

    ajusterArdoise: function (pid, delta) {
      var v = (etat.ardoise[pid] || 0) + delta;
      etat.ardoise[pid] = v < 0 ? 0 : v;
      publier(true);
    },

    ajouterJoueur: function (nom) {
      var id = slug(nom), n = 2, base = id;
      while (joueurConnu(id)) { id = base + '-' + n; n++; }
      etat.joueurs.push({ id: id, nom: nom.trim() });
      publier(true);
    },

    retirerJoueur: function (pid) {
      etat.joueurs = etat.joueurs.filter(function (j) { return j.id !== pid; });
      delete etat.ardoise[pid];
      publier(true);
    },

    fermer: function () {
      clearInterval(tic); clearInterval(battement);
      lien.publier(t.hote, { online: false, ts: Date.now() }, { retain: true });
      lien.fermer();
    }
  };
  return api;
}

/* ---------------------------------------------------------
   6. Téléphone joueur — logique
   --------------------------------------------------------- */

function creerJoueur(code, broker, pid) {
  var t = topics(code);
  var lien = creerLien({ url: broker.url });
  var etat = null;
  var hoteEnLigne = null;
  var decalage = 0;       // horloge hôte - horloge locale
  var enAttente = 0;      // taps pas encore envoyés
  var minuteurFlush = null;
  var dernierEtatRecu = 0;

  // L'écran central republie son état au moins toutes les 6 secondes. Au-delà
  // de 14 secondes de silence, la ligne est morte même si MQTT l'ignore encore.
  var SILENCE_MAX = 14000;
  var surveillance = setInterval(function () {
    if (!dernierEtatRecu) return;
    lien.marquerPerime(Date.now() - dernierEtatRecu > SILENCE_MAX, 'signal perdu');
  }, 1500);

  function envoyer(obj) {
    obj.pid = pid;
    lien.publier(t.cmd, obj);
  }

  function flush() {
    minuteurFlush = null;
    if (enAttente <= 0) return;
    var de = enAttente;
    enAttente = 0;
    envoyer({ t: 'mise', de: de, n: idUnique() });
  }

  lien.on('etat', function (e, info) {
    if (e === 'ok') {
      lien.abonner(t.etat);
      lien.abonner(t.hote);
      envoyer({ t: 'join' });
    }
    if (api.onLien) api.onLien(e, info);
  });

  lien.on('message', function (topic, obj) {
    if (topic === t.etat) {
      etat = obj;
      dernierEtatRecu = Date.now();
      lien.marquerPerime(false);
      if (typeof obj.hostNow === 'number') {
        var d = obj.hostNow - Date.now();
        if (Math.abs(d - decalage) > 750) decalage = d;
      }
      if (api.onEtat) api.onEtat(etat);
    } else if (topic === t.hote) {
      hoteEnLigne = !!(obj && obj.online);
      if (api.onEtat) api.onEtat(etat);
    }
  });

  var battement = setInterval(function () {
    if (lien.connecte()) envoyer({ t: 'ici' });
  }, 8000);

  var api = {
    pid: pid,
    lien: lien,
    etat: function () { return etat; },
    hoteEnLigne: function () { return hoteEnLigne; },
    maintenantHote: function () { return Date.now() + decalage; },
    enAttente: function () { return enAttente; },
    miser: function (de) {
      enAttente += de;
      if (!minuteurFlush) minuteurFlush = setTimeout(flush, 90);
    },
    fermer: function () { clearInterval(battement); clearInterval(surveillance); lien.fermer(); }
  };
  return api;
}

/* ---------------------------------------------------------
   7. Fragments d'interface partagés
   --------------------------------------------------------- */

function enseigne(petit) {
  return h('div', { class: 'enseigne' }, [
    h('span', { class: 'petit', text: petit || 'Vente aux enchères clandestine' }),
    h('span', { class: 'gros', text: 'Le Marché Noir' }),
    h('span', { class: 'gros', text: 'des Gages' }),
    h('span', { class: 'filet' })
  ]);
}

function qrSvg(texte, taille) {
  // Le QR est un confort, pas une condition de fonctionnement : si la petite
  // bibliothèque n'a pas pu être chargée, on affiche l'adresse à recopier.
  if (typeof qrcode === 'undefined') {
    var repli = h('div', { class: 'carton', style: 'text-align:center' }, [
      h('div', { class: 'etiquette', style: 'margin-bottom:8px' }, 'QR indisponible'),
      h('div', { class: 'discret', style: 'word-break:break-all' }, texte)
    ]);
    if (taille) repli.style.width = taille;
    return repli;
  }
  var qr = qrcode(0, 'M');
  qr.addData(texte);
  qr.make();
  var n = qr.getModuleCount();
  var marge = 2;
  var total = n + marge * 2;
  var chemins = [];
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (qr.isDark(r, c)) chemins.push('M' + (c + marge) + ',' + (r + marge) + 'h1v1h-1z');
    }
  }
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" ' +
    'shape-rendering="crispEdges" role="img" aria-label="QR code pour rejoindre la partie">' +
    '<rect width="' + total + '" height="' + total + '" fill="#f4efe4"/>' +
    '<path d="' + chemins.join('') + '" fill="#12100b"/></svg>';
  var w = h('div', { class: 'qr-panneau', html: svg });
  if (taille) w.style.width = taille;
  return w;
}

function modale(contenu) {
  var voile = h('div', { class: 'voile' });
  var boite = h('div', { class: 'modale' }, contenu);
  voile.appendChild(boite);
  voile.addEventListener('click', function (ev) { if (ev.target === voile) fermer(); });
  function fermer() { if (voile.parentNode) voile.parentNode.removeChild(voile); }
  document.body.appendChild(voile);
  return { fermer: fermer, boite: boite };
}

function ligneArdoise(rang, nom, valeur, opts) {
  opts = opts || {};
  return h('div', { class: 'ligne' + (opts.moi ? ' moi' : '') + (opts.meneur ? ' meneur' : '') }, [
    rang !== null ? h('span', { class: 'rang', text: rang }) : null,
    opts.presence !== undefined ? h('span', { class: 'pastille-x' + (opts.presence ? ' on' : '') }) : null,
    h('span', { class: 'nom', text: nom }),
    h('span', { class: 'val chiffre', text: valeur })
  ]);
}

/* ---------------------------------------------------------
   8. Écran d'accueil
   --------------------------------------------------------- */

function ecranAccueil() {
  // Si la tablette a rechargé la page en pleine soirée, on propose de
  // reprendre la salle en un tap plutôt que de tout ressaisir.
  var repris = lire('mng.hote');
  var recent = repris && repris.ts && (Date.now() - repris.ts < 12 * 3600 * 1000);
  var reprise = null;
  if (recent) {
    var zoneEtat = h('div', { class: 'tres-discret' });
    reprise = h('div', { class: 'pile g8', style: 'width:min(360px,100%)' }, [
      h('button', {
        class: 'btn or large',
        onclick: function () { Son.reveiller(); reprendreSalle(repris, zoneEtat); }
      }, 'Reprendre la salle ' + repris.code),
      zoneEtat
    ]);
  }

  var root = h('div', { class: 'vue' }, [
    h('div', { class: 'centre' }, [
      enseigne(),
      h('p', { class: 'discret', style: 'max-width:34ch', text:
        "Un gage est mis aux enchères. On mise en gorgées. Le plus offrant l'emporte… et boit ce qu'il a misé." }),
      reprise,
      h('div', { class: 'pile g12', style: 'width:min(360px,100%)' }, [
        h('button', {
          class: (recent ? 'btn fantome large' : 'btn or large'),
          onclick: function () { Son.reveiller(); App.allerHoteConfig(); }
        }, recent ? 'Nouvelle partie (écran central)' : 'Écran central'),
        h('button', {
          class: 'btn fantome large',
          onclick: function () { App.allerRejoindre(); }
        }, 'Rejoindre une partie'),
        h('a', { class: 'tres-discret', href: 'solo.html', style: 'margin-top:10px;color:inherit',
                 text: 'Mode secours : tout sur un seul écran →' })
      ])
    ])
  ]);
  return { root: root };
}

/* Saisie manuelle d'un code (si le QR ne passe pas). */
function ecranRejoindre() {
  var champ = h('input', {
    class: 'champ centrer chiffre',
    style: 'text-transform:uppercase;letter-spacing:.3em;font-size:22px',
    maxlength: '5', autocapitalize: 'characters', autocomplete: 'off',
    placeholder: 'A1B2C'
  });
  var err = h('div', { class: 'tres-discret rouge-t' });
  function valider() {
    var code = (champ.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5 || !brokerParId(code[0])) {
      err.textContent = "Ce code ne ressemble à rien. Vérifie les 5 caractères affichés sur la TV.";
      return;
    }
    location.href = urlSalle(code);
  }
  var root = h('div', { class: 'vue' }, [
    h('div', { class: 'centre' }, [
      enseigne('Entrée des marchandises'),
      h('p', { class: 'discret', text: 'Tape le code affiché sur l’écran central.' }),
      h('div', { class: 'pile g12', style: 'width:min(340px,100%)' }, [
        champ, err,
        h('button', { class: 'btn or large', onclick: valider }, 'Entrer'),
        h('button', { class: 'btn fantome large', onclick: function () { App.allerAccueil(); } }, 'Retour')
      ])
    ])
  ]);
  champ.addEventListener('keydown', function (e) { if (e.key === 'Enter') valider(); });
  return { root: root };
}

/* ---------------------------------------------------------
   9. Écran central — configuration
   --------------------------------------------------------- */

function ecranHoteConfig() {
  var repris = lire('mng.hote');
  var champs = [];
  var zoneNoms = h('div', { class: 'pile g8' });
  var err = h('div', { class: 'tres-discret rouge-t' });

  function ajouterChamp(valeur) {
    var i = champs.length;
    var input = h('input', {
      class: 'champ', placeholder: 'Prénom ' + (i + 1),
      autocomplete: 'off', maxlength: '18', value: valeur || ''
    });
    champs.push(input);
    zoneNoms.appendChild(input);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var suivant = champs[champs.indexOf(input) + 1];
        if (suivant) suivant.focus(); else ajouterChamp('').focus();
      }
    });
    return input;
  }

  var sauve = lire('mng.noms');
  var depart = (sauve && sauve.length) ? sauve : ['', '', '', '', '', '', '', '', ''];
  for (var i = 0; i < depart.length; i++) ajouterChamp(depart[i]);

  // Tous les gages d'un coup : une ligne = un lot. C'est le programme de la
  // vente, et il ne sera plus à retaper de la soirée.
  var gagesSauves = lire('mng.programme');
  var zoneGages = h('textarea', {
    class: 'champ', rows: '10', spellcheck: 'false',
    placeholder: 'Un gage par ligne…'
  });
  zoneGages.value = (gagesSauves && gagesSauves.length ? gagesSauves : GAGES).join('\n');
  var compteur = h('div', { class: 'tres-discret compte-programme', style: 'margin-top:8px' });

  function lireProgramme() {
    return zoneGages.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  }
  function majCompteur() {
    var n = lireProgramme().length;
    compteur.textContent = n + (n > 1 ? ' lots au programme' : ' lot au programme');
  }
  zoneGages.addEventListener('input', majCompteur);
  majCompteur();

  var boutonLancer = h('button', { class: 'btn or large' }, 'Ouvrir la salle des ventes');
  var etatConnexion = h('div', { class: 'tres-discret centrer' });

  boutonLancer.addEventListener('click', function () {
    var noms = champs.map(function (c) { return c.value.trim(); }).filter(Boolean);
    var vus = {};
    for (var k = 0; k < noms.length; k++) {
      var s = slug(noms[k]);
      if (vus[s]) { err.textContent = 'Deux joueurs portent le même prénom : ajoute une initiale.'; return; }
      vus[s] = 1;
    }
    if (noms.length < 2) { err.textContent = 'Il faut au moins 2 joueurs.'; return; }
    var programme = lireProgramme();
    if (!programme.length) { err.textContent = 'Il faut au moins un gage au programme.'; return; }
    err.textContent = '';
    ecrire('mng.noms', noms);
    ecrire('mng.programme', programme);
    boutonLancer.disabled = true;
    boutonLancer.textContent = 'Ouverture…';
    Son.reveiller();
    ouvrirSalle(noms, programme, etatConnexion, function () {
      boutonLancer.disabled = false;
      boutonLancer.textContent = 'Réessayer';
    });
  });

  var contenu = [
    enseigne('Poste du commissaire-priseur'),
    h('div', { class: 'carton dore', style: 'width:min(520px,100%);text-align:left' }, [
      h('div', { class: 'etiquette', style: 'margin-bottom:12px' }, 'Les participants'),
      zoneNoms,
      h('button', {
        class: 'btn fantome mini', style: 'margin-top:10px',
        onclick: function () { ajouterChamp('').focus(); }
      }, '+ Ajouter un joueur'),
      err
    ]),
    h('div', { class: 'carton dore', style: 'width:min(520px,100%);text-align:left' }, [
      h('div', { class: 'rangee', style: 'margin-bottom:12px' }, [
        h('div', { class: 'etiquette' }, 'Le programme de la vente'),
        h('button', {
          class: 'btn fantome mini pousse',
          onclick: function () { zoneGages.value = GAGES.join('\n'); majCompteur(); }
        }, 'Liste par défaut')
      ]),
      zoneGages,
      compteur,
      h('p', { class: 'tres-discret', style: 'margin:8px 0 0' },
        'Un gage par ligne. Ils seront vendus dans cet ordre — plus rien à taper de la soirée. ' +
        'Tu pourras toujours en ajouter en cours de route.')
    ]),
    h('div', { class: 'pile g12', style: 'width:min(520px,100%)' }, [
      boutonLancer,
      etatConnexion,
      repris ? h('button', {
        class: 'btn fantome large',
        onclick: function () { reprendreSalle(repris, etatConnexion); }
      }, 'Reprendre la partie de tout à l’heure') : null,
      h('button', { class: 'btn fantome large', onclick: function () { App.allerAccueil(); } }, 'Retour')
    ]),
    h('p', { class: 'tres-discret centrer', style: 'max-width:44ch' },
      'Gardez cet écran allumé et branché à la TV : c’est lui qui tient les comptes. ' +
      'De l’eau à côté de la bière, ça n’a jamais gâché une enchère.')
  ];

  return { root: h('div', { class: 'vue' }, [h('div', { class: 'centre' }, contenu)]) };
}

/* Choisit le premier broker qui répond, puis ouvre la salle. */
function ouvrirSalle(noms, programme, zoneEtat, onEchec) {
  var liste = brokersDisponibles();
  zoneEtat.textContent = 'Recherche d’une ligne sécurisée…';
  courseBrokers(liste, function (broker) {
    if (!broker) {
      zoneEtat.innerHTML = '';
      zoneEtat.appendChild(h('div', { class: 'alerte' }, [
        h('b', {}, 'Aucun serveur joignable. '),
        document.createTextNode('Vérifie que ce téléphone/tablette a bien Internet (WiFi ou 4G), puis réessaie. ' +
          'Si rien n’y fait, utilise le mode secours sur un seul écran.')
      ]));
      if (onEchec) onEchec();
      return;
    }
    var code = broker.id + alea(4);
    var hote = creerHote(code, broker, noms, programme, null);
    App.demarrerHote(hote);
  });
}

function reprendreSalle(repris, zoneEtat) {
  var broker = brokerParId(repris.brokerId) || brokersDisponibles()[0];
  zoneEtat.textContent = 'Reprise de la salle ' + repris.code + '…';
  var hote = creerHote(repris.code, broker, [], [], repris.etat);
  App.demarrerHote(hote);
}

/* Teste les brokers en parallèle et retient le premier qui accepte. */
function courseBrokers(liste, fini) {
  var termine = false;
  var restants = liste.length;
  var clients = [];

  liste.forEach(function (b) {
    var c;
    try {
      c = mqtt.connect(b.url, {
        clientId: 'mng_probe_' + idUnique(),
        clean: true, protocolVersion: 4, keepalive: 20,
        reconnectPeriod: 0, connectTimeout: 8000
      });
    } catch (e) { fin(null); return; }
    clients.push(c);
    c.on('connect', function () { fin(b); });
    c.on('error', function () { fin(null); });
    c.on('close', function () { fin(null); });
  });

  setTimeout(function () { if (!termine) { termine = true; nettoyer(); fini(null); } }, 9000);

  function nettoyer() {
    clients.forEach(function (c) { try { c.end(true); } catch (e) {} });
  }
  function fin(b) {
    if (termine) return;
    if (b) {
      termine = true;
      nettoyer();
      fini(b);
      return;
    }
    restants--;
    if (restants <= 0) { termine = true; nettoyer(); fini(null); }
  }
}

/* ---------------------------------------------------------
   10. Écran central — plateau
   --------------------------------------------------------- */

function ecranHote(hote) {
  var bandeau = creerBandeau();
  var lotZone = h('div', { class: 'colonne' });
  var coteZone = h('div', { class: 'colonne' });
  var plateau = h('div', { class: 'plateau' }, [lotZone, coteZone]);
  var recapZone = h('div', { class: 'vue masque', style: 'overflow-y:auto;-webkit-overflow-scrolling:touch' });
  var root = h('div', { class: 'vue' }, [bandeau.root, plateau, recapZone]);

  var choixGage = { texte: '', index: -1 };
  var duree = lire('mng.duree') || 30;
  var dernierStatut = '';
  var dernierMontant = 0;

  bandeau.maj(hote.lien.etat(), '', 'Salle ' + hote.code + ' · ' + hote.broker.nom);
  hote.onLien = function (e, info) { bandeau.maj(e, info, 'Salle ' + hote.code + ' · ' + hote.broker.nom); };
  hote.onEtat = function () { dessiner(); };
  hote.onTic = function () { rafraichirMinuteur(); };
  hote.onMise = function () { Son.coup(false); };
  hote.onCloture = function () { Son.coup(true); };

  /* --- panneau QR --- */
  function panneauQR() {
    var url = urlSalle(hote.code);
    return h('div', { class: 'carton dore' }, [
      h('div', { class: 'etiquette', style: 'margin-bottom:12px' }, 'Entrée des enchérisseurs'),
      h('div', { class: 'rangee g16', style: 'flex-wrap:wrap;align-items:center' }, [
        qrSvg(url, '176px'),
        h('div', { class: 'pile g8', style: 'flex:1;min-width:150px' }, [
          h('div', { class: 'tres-discret' }, 'Scannez, ou tapez ce code sur'),
          h('div', { class: 'tres-discret or', style: 'word-break:break-all' }, location.host + location.pathname),
          h('div', { class: 'code-salle', text: hote.code }),
          h('div', { class: 'tres-discret' }, 'Aucun compte, aucune appli à installer.')
        ])
      ])
    ]);
  }

  /* --- lot suivant, tiré du programme --- */
  function panneauProchain(etat) {
    var pos = hote.position();
    var p = hote.prochain();

    if (!p) {
      return h('div', { class: 'carton dore', style: 'text-align:center' }, [
        h('div', { class: 'etiquette' }, 'Programme terminé'),
        h('p', { class: 'discret', style: 'margin:14px auto' }, 'Tous les lots sont passés.'),
        h('button', {
          class: 'btn or large',
          onclick: function () { hote.montrerRecap(true); }
        }, 'Voir le récapitulatif'),
        h('button', {
          class: 'btn fantome large', style: 'margin-top:8px',
          onclick: ouvrirAjoutGages
        }, '+ Ajouter des gages')
      ]);
    }

    var segments = h('div', { class: 'segmente', style: 'margin-top:10px' });
    DUREES.forEach(function (d) {
      var b = h('button', { 'aria-pressed': String(d === duree), text: d + ' s' });
      b.addEventListener('click', function () {
        duree = d; ecrire('mng.duree', d);
        Array.prototype.forEach.call(segments.children, function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
      });
      segments.appendChild(b);
    });

    return h('div', { class: 'carton dore', style: 'text-align:center' }, [
      h('div', { class: 'etiquette' }, 'Lot ' + (pos.faits + 1) + ' sur ' + pos.total),
      h('div', { class: 'gage-titre', style: 'margin:16px 0 20px' }, p.titre),
      h('div', { class: 'etiquette' }, 'Durée du marteau'),
      segments,
      h('button', {
        class: 'btn or large', style: 'margin-top:16px;padding:22px;font-size:18px',
        onclick: function () { Son.reveiller(); hote.demarrerProchain(duree); }
      }, 'Démarrer l’enchère'),
      h('div', { class: 'rangee g8', style: 'margin-top:10px;justify-content:center' }, [
        h('button', {
          class: 'btn fantome mini',
          onclick: function () { hote.passerProchain(); }
        }, 'Passer ce lot'),
        h('button', { class: 'btn fantome mini', onclick: ouvrirAjoutGages }, '+ Ajouter des gages'),
        h('button', {
          class: 'btn fantome mini',
          onclick: function () { hote.montrerRecap(true); }
        }, 'Récapitulatif')
      ])
    ]);
  }

  function ouvrirAjoutGages() {
    var zone = h('textarea', { class: 'champ', rows: '6', placeholder: 'Un gage par ligne…' });
    var m = modale([
      h('div', { class: 'etiquette', style: 'margin-bottom:12px' }, 'Ajouter au programme'),
      zone,
      h('div', { class: 'pile g8', style: 'margin-top:14px' }, [
        h('button', {
          class: 'btn or large',
          onclick: function () {
            var l = zone.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
            if (l.length) hote.ajouterGages(l);
            m.fermer();
          }
        }, 'Ajouter'),
        h('button', { class: 'btn fantome large', onclick: function () { m.fermer(); } }, 'Annuler')
      ])
    ]);
    setTimeout(function () { zone.focus(); }, 50);
  }

  /* --- enchère en cours --- */
  var refMinuteur = null, refJauge = null, refFin = 0, refDuree = 1;

  function rafraichirMinuteur() {
    if (!refMinuteur) return;
    var reste = Math.max(0, refFin - Date.now());
    var s = Math.ceil(reste / 1000);
    refMinuteur.textContent = s < 10 ? '0' + s : String(s);
    var urgent = reste <= 5000;
    refMinuteur.classList.toggle('urgent', urgent);
    if (refJauge) {
      refJauge.firstChild.style.width = Math.max(0, Math.min(100, (reste / refDuree) * 100)) + '%';
      refJauge.classList.toggle('urgent', urgent);
    }
  }

  function panneauLotOuvert(etat) {
    var lot = etat.lot;
    refFin = lot.fin; refDuree = lot.duree;
    refMinuteur = h('div', { class: 'minuteur', style: 'font-size:clamp(56px,16vw,150px)' }, '--');
    refJauge = h('div', { class: 'jauge' }, [h('i')]);

    var meneur = lot.meneur ? nomDe(etat, lot.meneur) : null;

    return h('div', { class: 'carton dore', style: 'text-align:center' }, [
      h('div', { class: 'etiquette' }, lot.prolonge ? 'Prolongation !' : 'Enchère ouverte'),
      h('div', { class: 'gage-titre', style: 'margin:14px 0 18px' }, lot.titre),
      refMinuteur,
      h('div', { class: 'etiquette', style: 'margin:6px 0 14px' }, 'secondes'),
      refJauge,
      h('hr', { class: 'filet-or' }),
      h('div', { class: 'etiquette' }, meneur ? 'Meilleure offre' : 'Aucune offre pour l’instant'),
      h('div', { class: 'montant-geant', style: 'margin:6px 0' }, meneur ? String(lot.montant) : '—'),
      h('div', { class: 'etiquette' }, meneur ? 'gorgées' : ''),
      h('div', { class: 'meneur-nom', style: 'margin-top:10px' }, meneur || ' '),
      h('button', {
        class: 'btn fantome mini', style: 'margin-top:18px',
        onclick: function () { hote.cloturer(); }
      }, 'Adjuger maintenant')
    ]);
  }

  function panneauLotAdjuge(etat) {
    var lot = etat.lot;
    var meneur = lot.meneur ? nomDe(etat, lot.meneur) : null;
    refMinuteur = null; refJauge = null;

    return h('div', { class: 'carton dore', style: 'text-align:center' }, [
      h('div', { style: 'margin:6px 0 18px' }, [h('span', { class: 'tampon' }, meneur ? 'Adjugé' : 'Invendu')]),
      h('div', { class: 'gage-titre', style: 'margin-bottom:18px' }, lot.titre),
      meneur ? h('div', {}, [
        h('div', { class: 'etiquette' }, 'Remporté par'),
        h('div', { class: 'meneur-nom', style: 'margin:8px 0 4px;font-size:clamp(24px,6vw,44px)' }, meneur),
        h('div', { class: 'montant-geant', style: 'font-size:clamp(36px,10vw,80px)' }, String(lot.montant)),
        h('div', { class: 'etiquette' }, 'gorgées ajoutées à son ardoise'),
        h('p', { class: 'discret', style: 'margin:16px auto 0;max-width:36ch' },
          meneur + ' annonce à voix haute qui fait le gage, et comment.')
      ]) : h('p', { class: 'discret' }, 'Personne n’a misé. Le lot repart au marchand.'),
      h('div', { class: 'pile g8', style: 'margin-top:22px' }, [
        h('button', {
          class: 'btn or large',
          onclick: function () { hote.valider(); }
        }, meneur ? 'Valider et inscrire à l’ardoise' : 'Retirer le lot'),
        meneur ? h('button', {
          class: 'btn fantome mini',
          onclick: function () { hote.annulerLot(); }
        }, 'Annuler ce lot (ne rien compter)') : null
      ])
    ]);
  }

  function panneauOffres(etat) {
    var lot = etat.lot;
    if (!lot) return null;
    var pids = Object.keys(lot.offres).sort(function (a, b) { return lot.offres[b] - lot.offres[a]; });
    if (!pids.length) return null;
    return h('div', { class: 'carton' }, [
      h('div', { class: 'etiquette', style: 'margin-bottom:10px' }, 'Offres sur ce lot'),
      h('div', {}, pids.map(function (pid, i) {
        return ligneArdoise(String(i + 1), nomDe(etat, pid), gorgees(lot.offres[pid]),
          { meneur: pid === lot.meneur });
      }))
    ]);
  }

  function panneauArdoise(etat) {
    var enLigne = {};
    (etat.enLigne || []).forEach(function (p) { enLigne[p] = 1; });
    var classement = etat.joueurs.slice().sort(function (a, b) {
      return (etat.ardoise[b.id] || 0) - (etat.ardoise[a.id] || 0);
    });
    var total = 0;
    etat.joueurs.forEach(function (j) { total += (etat.ardoise[j.id] || 0); });

    return h('div', { class: 'carton dore' }, [
      h('div', { class: 'rangee', style: 'margin-bottom:12px' }, [
        h('div', { class: 'etiquette' }, 'L’ardoise'),
        h('div', { class: 'etiquette pousse' }, total + ' gorgées au total')
      ]),
      h('div', {}, classement.map(function (j, i) {
        var l = ligneArdoise(String(i + 1), j.nom, String(etat.ardoise[j.id] || 0),
          { presence: !!enLigne[j.id] });
        l.style.cursor = 'pointer';
        l.addEventListener('click', function () { ouvrirReglage(j); });
        return l;
      })),
      h('div', { class: 'rangee g8', style: 'margin-top:12px' }, [
        h('button', { class: 'btn fantome mini', onclick: ouvrirAjout }, '+ Joueur'),
        h('button', { class: 'btn fantome mini', onclick: ouvrirQR }, 'Afficher le QR'),
        h('button', {
          class: 'btn fantome mini',
          onclick: function () { var a = Son.basculer(); this.textContent = a ? '🔔 Son' : '🔕 Muet'; }
        }, Son.estActif() ? '🔔 Son' : '🔕 Muet')
      ]),
      h('div', { class: 'tres-discret', style: 'margin-top:8px' },
        'Touchez un nom pour rayer des gorgées bues.')
    ]);
  }

  /* Le programme complet : ce qui est vendu, ce qui vient, ce qui a été passé. */
  function panneauProgramme(etat) {
    if (!etat.programme.length) return null;
    var enCours = etat.lot ? etat.lot.id : null;
    return h('div', { class: 'carton' }, [
      h('div', { class: 'rangee', style: 'margin-bottom:10px' }, [
        h('div', { class: 'etiquette' }, 'Le programme'),
        h('div', { class: 'etiquette pousse' }, hote.position().faits + ' / ' + etat.programme.length)
      ]),
      h('div', { class: 'scroll-zone' }, etat.programme.map(function (x, i) {
        var vendu = x.statut === 'vendu';
        var retire = x.statut === 'retire';
        return h('div', {
          class: 'ligne' + (x.id === enCours ? ' meneur' : ''),
          style: 'align-items:flex-start' + (retire ? ';opacity:.4' : '')
        }, [
          h('span', { class: 'rang' }, String(i + 1)),
          h('span', { class: 'pile', style: 'flex:1;min-width:0' }, [
            h('span', {
              class: 'tres-discret',
              style: 'margin-bottom:2px' + (retire ? ';text-decoration:line-through' : '')
            }, x.titre),
            h('span', { class: 'nom', style: 'font-size:14px' },
              vendu ? nomDe(etat, x.pid) : (retire ? 'passé' : (x.id === enCours ? 'en vente' : 'à venir')))
          ]),
          h('span', { class: 'val chiffre' + (vendu ? ' or' : '') }, vendu ? String(x.montant) : '·')
        ]);
      }))
    ]);
  }

  /* Le grand tableau de fin de soirée. */
  function ecranRecap(etat) {
    var vendus = etat.programme.filter(function (x) { return x.statut === 'vendu'; });
    var parJoueur = {};
    etat.joueurs.forEach(function (j) { parJoueur[j.id] = { j: j, lots: [], total: 0 }; });
    vendus.forEach(function (x) {
      if (!parJoueur[x.pid]) return;
      parJoueur[x.pid].lots.push(x);
      parJoueur[x.pid].total += x.montant;
    });
    var classement = etat.joueurs.slice().sort(function (a, b) {
      return (etat.ardoise[b.id] || 0) - (etat.ardoise[a.id] || 0);
    });
    var total = 0;
    etat.joueurs.forEach(function (j) { total += (etat.ardoise[j.id] || 0); });

    var ardoise = h('div', { class: 'carton dore' }, [
      h('div', { class: 'etiquette', style: 'margin-bottom:14px' }, 'L’ardoise finale — gorgées dues'),
      h('div', {}, classement.map(function (j, i) {
        var d = parJoueur[j.id] || { lots: [] };
        return h('div', { class: 'ligne recap-ligne' + (i === 0 ? ' meneur' : '') }, [
          h('span', { class: 'rang recap-rang' }, String(i + 1)),
          h('span', { class: 'pile', style: 'flex:1;min-width:0' }, [
            h('span', { class: 'recap-nom' }, j.nom),
            h('span', { class: 'tres-discret' },
              d.lots.length ? (d.lots.length + (d.lots.length > 1 ? ' lots remportés' : ' lot remporté')) : 'aucun lot')
          ]),
          h('span', { class: 'recap-montant chiffre' }, String(etat.ardoise[j.id] || 0))
        ]);
      })),
      h('div', { class: 'rangee', style: 'margin-top:14px' }, [
        h('div', { class: 'etiquette' }, 'Total de la soirée'),
        h('div', { class: 'etiquette pousse or' }, total + ' gorgées')
      ])
    ]);

    var registre = h('div', { class: 'carton' }, [
      h('div', { class: 'etiquette', style: 'margin-bottom:14px' }, 'Qui a acheté quoi'),
      vendus.length
        ? h('div', {}, vendus.map(function (x, i) {
            return h('div', { class: 'ligne', style: 'align-items:flex-start' }, [
              h('span', { class: 'rang' }, String(i + 1)),
              h('span', { class: 'pile', style: 'flex:1;min-width:0' }, [
                h('span', { class: 'nom', style: 'font-size:17px' }, nomDe(etat, x.pid)),
                h('span', { class: 'tres-discret', style: 'margin-top:3px' }, x.titre)
              ]),
              h('span', { class: 'val chiffre or', style: 'font-size:20px' }, String(x.montant))
            ]);
          }))
        : h('p', { class: 'discret' }, 'Aucun lot vendu.')
    ]);

    return h('div', { class: 'pile recap', style: 'padding:var(--pad)' }, [
      h('div', { class: 'enseigne', style: 'margin-bottom:var(--pad)' }, [
        h('span', { class: 'petit' }, 'Clôture de la vente'),
        h('span', { class: 'gros' }, 'Le Registre'),
        h('span', { class: 'filet' })
      ]),
      h('div', { class: 'plateau', style: 'padding:0' }, [
        h('div', { class: 'colonne' }, [ardoise]),
        h('div', { class: 'colonne' }, [registre])
      ]),
      h('div', { class: 'rangee g8', style: 'justify-content:center;margin-top:var(--pad);flex-wrap:wrap' }, [
        h('button', {
          class: 'btn or',
          onclick: function () { hote.montrerRecap(false); }
        }, 'Revenir à la vente'),
        h('button', { class: 'btn fantome', onclick: ouvrirAjoutGages }, '+ Ajouter des gages'),
        h('button', { class: 'btn fantome', onclick: ouvrirQR }, 'Afficher le QR')
      ])
    ]);
  }

  function ouvrirReglage(j) {
    var etat = hote.etat();
    var m;
    function ligne(n) {
      return h('button', {
        class: 'btn fantome large',
        onclick: function () { hote.ajusterArdoise(j.id, -n); m.fermer(); }
      }, 'Il/elle a bu ' + gorgees(n));
    }
    m = modale([
      h('div', { class: 'etiquette' }, 'Ardoise de'),
      h('div', { class: 'meneur-nom', style: 'margin:6px 0 4px' }, j.nom),
      h('div', { class: 'montant-geant', style: 'font-size:56px' }, String(etat.ardoise[j.id] || 0)),
      h('div', { class: 'etiquette', style: 'margin-bottom:16px' }, 'gorgées dues'),
      h('div', { class: 'pile g8' }, [
        ligne(1), ligne(3), ligne(5),
        h('button', {
          class: 'btn fantome large',
          onclick: function () { hote.ajusterArdoise(j.id, -(etat.ardoise[j.id] || 0)); m.fermer(); }
        }, 'Ardoise soldée (tout bu)'),
        h('hr', { class: 'filet-or' }),
        h('button', {
          class: 'btn fantome large',
          onclick: function () {
            if (confirm('Retirer ' + j.nom + ' de la partie ?')) { hote.retirerJoueur(j.id); m.fermer(); }
          }
        }, 'Retirer ce joueur'),
        h('button', { class: 'btn large', onclick: function () { m.fermer(); } }, 'Fermer')
      ])
    ]);
  }

  function ouvrirAjout() {
    var champ = h('input', { class: 'champ', placeholder: 'Prénom', maxlength: '18', autocomplete: 'off' });
    var m = modale([
      h('div', { class: 'etiquette', style: 'margin-bottom:12px' }, 'Ajouter un retardataire'),
      champ,
      h('div', { class: 'pile g8', style: 'margin-top:14px' }, [
        h('button', {
          class: 'btn or large',
          onclick: function () {
            if (champ.value.trim()) { hote.ajouterJoueur(champ.value); m.fermer(); }
          }
        }, 'Ajouter'),
        h('button', { class: 'btn fantome large', onclick: function () { m.fermer(); } }, 'Annuler')
      ])
    ]);
    setTimeout(function () { champ.focus(); }, 50);
  }

  function ouvrirQR() {
    var url = urlSalle(hote.code);
    modale([
      h('div', { class: 'etiquette centrer', style: 'margin-bottom:14px' }, 'Rejoindre la vente'),
      qrSvg(url, '100%'),
      h('div', { class: 'code-salle centrer', style: 'margin:16px 0 6px' }, hote.code),
      h('div', { class: 'tres-discret centrer', style: 'word-break:break-all;margin-bottom:16px' }, url),
      h('button', { class: 'btn large', onclick: function () { document.querySelector('.voile').remove(); } }, 'Fermer')
    ]);
  }

  function nomDe(etat, pid) {
    for (var i = 0; i < etat.joueurs.length; i++) if (etat.joueurs[i].id === pid) return etat.joueurs[i].nom;
    return '???';
  }

  // Ce que l'écran montre réellement. Le battement de l'écran central republie
  // l'état toutes les 6 secondes sans que rien n'ait bougé : sans cette
  // signature, on redessinerait tout pour rien.
  function signature(etat) {
    var l = etat.lot;
    return [
      l ? l.id + ':' + l.statut + ':' + l.montant + ':' + (l.meneur || '') + ':' + (l.prolonge ? 1 : 0) + ':' + l.fin : 'vide',
      etat.joueurs.map(function (j) { return j.id + '=' + (etat.ardoise[j.id] || 0); }).join(','),
      (etat.enLigne || []).join(','),
      etat.programme.map(function (x) { return x.statut + (x.pid || '') + x.montant; }).join('~'),
      etat.recap ? 'R' : '-',
      l ? Object.keys(l.offres).sort().join(',') : ''
    ].join('|');
  }
  var derniereSignature = null;

  function dessiner() {
    var etat = hote.etat();
    var sig = signature(etat);
    if (sig === derniereSignature && lotZone.firstChild) return;
    derniereSignature = sig;

    var statut = etat.lot ? etat.lot.statut : (etat.recap ? 'recap' : 'vide');
    var doitRedessinerLot = true;

    // Le récapitulatif prend tout l'écran : c'est le moment où l'on regarde
    // les comptes, pas la salle des ventes.
    if (etat.recap && !etat.lot) {
      plateau.classList.add('masque');
      vider(recapZone);
      recapZone.classList.remove('masque');
      recapZone.appendChild(ecranRecap(etat));
      dernierStatut = statut;
      return;
    }
    plateau.classList.remove('masque');
    recapZone.classList.add('masque');
    vider(recapZone);

    // Pendant une enchère ouverte, on ne recrée pas tout le panneau à chaque mise :
    // seuls le montant et le meneur changent (le minuteur a son propre rafraîchissement).
    if (statut === 'ouvert' && dernierStatut === 'ouvert' && lotZone.firstChild) {
      var lot = etat.lot;
      refFin = lot.fin; refDuree = lot.duree;
      var mg = lotZone.querySelector('.montant-geant');
      var mn = lotZone.querySelector('.meneur-nom');
      var et = lotZone.querySelectorAll('.etiquette');
      if (mg && mn) {
        mg.textContent = lot.meneur ? String(lot.montant) : '—';
        mn.textContent = lot.meneur ? nomDe(etat, lot.meneur) : ' ';
        if (et[0]) et[0].textContent = lot.prolonge ? 'Prolongation !' : 'Enchère ouverte';
        if (et[2]) et[2].textContent = lot.meneur ? 'Meilleure offre' : 'Aucune offre pour l’instant';
        if (et[3]) et[3].textContent = lot.meneur ? 'gorgées' : '';
        doitRedessinerLot = false;
      }
    }

    if (doitRedessinerLot) {
      vider(lotZone);
      if (!etat.lot) {
        lotZone.appendChild(panneauProchain(etat));
        lotZone.appendChild(panneauQR());
      } else if (etat.lot.statut === 'ouvert') {
        lotZone.appendChild(panneauLotOuvert(etat));
      } else {
        lotZone.appendChild(panneauLotAdjuge(etat));
      }
      var off = panneauOffres(etat);
      if (off) lotZone.appendChild(off);
      rafraichirMinuteur();
    } else {
      // Le classement des offres, lui, doit suivre chaque mise.
      var ancien = lotZone.querySelector('.carton:not(.dore)');
      var neuf = panneauOffres(etat);
      if (ancien && neuf) lotZone.replaceChild(neuf, ancien);
      else if (neuf) lotZone.appendChild(neuf);
      else if (ancien) lotZone.removeChild(ancien);
    }

    // Pendant une enchère, l'ardoise et l'historique ne bougent pas : inutile
    // de reconstruire toute la colonne à chaque mise (jusqu'à 8 fois/seconde).
    if (doitRedessinerLot || !coteZone.firstChild) {
      vider(coteZone);
      coteZone.appendChild(panneauArdoise(etat));
      var prog = panneauProgramme(etat);
      if (prog) coteZone.appendChild(prog);
    }

    dernierStatut = statut;
    dernierMontant = etat.lot ? etat.lot.montant : 0;
  }

  dessiner();
  garderEveille();
  return { root: root, dessiner: dessiner };
}

/* ---------------------------------------------------------
   11. Téléphone joueur — écrans
   --------------------------------------------------------- */

function ecranChoixNom(code, broker) {
  var bandeau = creerBandeau();
  var zone = h('div', { class: 'centre' });
  var root = h('div', { class: 'vue' }, [bandeau.root, zone]);
  var lien = creerLien({ url: broker.url });
  var t = topics(code);
  var recu = false;

  lien.on('etat', function (e, info) {
    bandeau.maj(e, info, 'Salle ' + code);
    if (e === 'ok') { lien.abonner(t.etat); attendre(); }
    if (e === 'ko') erreurConnexion(info);
  });
  lien.on('message', function (topic, etat) {
    if (topic !== t.etat || recu) return;
    recu = true;
    afficherNoms(etat);
  });

  setTimeout(function () {
    if (!recu && lien.etat() === 'ok') salleIntrouvable();
  }, 9000);

  function attendre() {
    vider(zone);
    zone.appendChild(enseigne('Salle ' + code));
    zone.appendChild(h('p', { class: 'discret' }, 'Ouverture de la porte…'));
  }

  function erreurConnexion(msg) {
    vider(zone);
    zone.appendChild(enseigne('Salle ' + code));
    zone.appendChild(h('div', { class: 'alerte' }, [
      h('b', {}, 'Connexion impossible. '),
      document.createTextNode('Vérifie ta connexion Internet (WiFi ou données mobiles) puis recharge la page. ' +
        (msg ? '(' + msg + ')' : ''))
    ]));
    zone.appendChild(h('button', { class: 'btn or', onclick: function () { location.reload(); } }, 'Réessayer'));
  }

  function salleIntrouvable() {
    vider(zone);
    zone.appendChild(enseigne('Salle ' + code));
    zone.appendChild(h('div', { class: 'alerte' }, [
      h('b', {}, 'Salle introuvable. '),
      document.createTextNode('Le code est peut-être erroné, ou l’écran central n’a pas encore ouvert la salle. ' +
        'Demande à l’organisatrice de réafficher le QR code.')
    ]));
    zone.appendChild(h('button', { class: 'btn or', onclick: function () { location.reload(); } }, 'Réessayer'));
    zone.appendChild(h('button', { class: 'btn fantome', onclick: function () { App.allerRejoindre(); } }, 'Saisir un autre code'));
  }

  function afficherNoms(etat) {
    var enLigne = {};
    (etat.enLigne || []).forEach(function (p) { enLigne[p] = 1; });
    vider(zone);
    zone.appendChild(enseigne('Qui es-tu ?'));
    var grille = h('div', { class: 'grille-noms' }, etat.joueurs.map(function (j) {
      var pris = !!enLigne[j.id];
      var b = h('button', { class: 'btn' + (pris ? ' fantome' : ' or') }, j.nom);
      b.addEventListener('click', function () {
        if (pris && !confirm(j.nom + ' est déjà connecté sur un autre téléphone. C’est bien toi ?')) return;
        lien.fermer();
        ecrire('mng.joueur.' + code, { pid: j.id, nom: j.nom });
        App.demarrerJoueur(code, broker, j.id, j.nom);
      });
      return b;
    }));
    zone.appendChild(grille);
    zone.appendChild(h('p', { class: 'tres-discret' }, 'Ton prénom n’est pas là ? Demande à l’organisatrice de l’ajouter.'));
  }

  attendre();
  return { root: root, fermer: function () { lien.fermer(); } };
}

function ecranJoueur(joueur, code, monNom) {
  var bandeau = creerBandeau();
  var etatLien = joueur.lien.etat();
  bandeau.maj(etatLien, '', monNom);
  joueur.onLien = function (e, info) {
    var avant = etatLien;
    etatLien = e;
    bandeau.maj(e, info, monNom);
    if ((avant === 'ok') !== (e === 'ok')) peindre();
  };

  var haut = h('div', { class: 'vue', style: 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch' });
  var basZone = h('div', { class: 'enchere-zone masque' });
  var root = h('div', { class: 'vue' }, [bandeau.root, haut, basZone]);

  // Bouton d'enchère : créé une seule fois pour ne perdre aucun tap.
  var btn1 = h('button', { class: 'btn-encherir' }, [
    h('span', { class: 'lib' }, '+1 ENCHÉRIR'),
    h('small', { class: 'sous' }, ' ')
  ]);
  var btn5 = h('button', { class: 'btn-encherir5' }, '+5 d’un coup');
  basZone.appendChild(btn1);
  basZone.appendChild(btn5);

  btn1.addEventListener('click', function () { taper(1); });
  btn5.addEventListener('click', function () { taper(5); });

  var optimiste = 0, optimisteTs = 0, optimisteMene = false;

  function taper(n) {
    var etat = joueur.etat();
    if (!etat || !etat.lot || etat.lot.statut !== 'ouvert') return;
    var base = Math.max(etat.lot.montant || 0, optimisteFrais() ? optimiste : 0);
    optimiste = base + n;
    optimisteTs = Date.now();
    optimisteMene = true;
    joueur.miser(n);
    peindre();
  }
  function optimisteFrais() { return Date.now() - optimisteTs < 2500; }

  var refMin = null, refJauge = null;

  function peindre() {
    var etat = joueur.etat();
    vider(haut);

    if (!etat) {
      haut.appendChild(h('div', { class: 'centre' }, [
        enseigne('Salle ' + code),
        h('p', { class: 'discret' }, 'En attente de l’écran central…')
      ]));
      basZone.classList.add('masque');
      refMin = null; refJauge = null;
      return;
    }

    var ardoise = etat.ardoise[joueur.pid] || 0;
    var lot = etat.lot;
    var hoteKO = joueur.hoteEnLigne() === false;

    if (lot && lot.statut === 'ouvert') {
      var frais = optimisteFrais();
      var monOffre = Math.max(lot.offres[joueur.pid] || 0, frais ? optimiste : 0);
      var meilleure = Math.max(lot.montant || 0, frais ? optimiste : 0);
      var jeMene = (lot.meneur === joueur.pid) || (frais && optimisteMene && optimiste >= (lot.montant || 0));
      var nomMeneur = jeMene ? 'Toi' : (lot.meneur ? nomDe(etat, lot.meneur) : '—');

      refMin = h('div', { class: 'minuteur', style: 'font-size:clamp(44px,13vw,76px)' }, '--');
      refJauge = h('div', { class: 'jauge' }, [h('i')]);

      haut.appendChild(h('div', { class: 'bande pile g16' }, [
        h('div', { class: 'carton dore centrer' }, [
          h('div', { class: 'etiquette' }, lot.prolonge ? 'Prolongation !' : 'Lot en vente'),
          h('div', { class: 'gage-titre', style: 'margin:12px 0 16px;font-size:clamp(18px,5vw,26px)' }, lot.titre),
          refMin,
          h('div', { class: 'etiquette', style: 'margin:2px 0 12px' }, 'secondes'),
          refJauge
        ]),
        h('div', { class: 'carton centrer' }, [
          h('div', { class: 'etiquette' }, 'Meilleure offre'),
          h('div', { class: 'montant-geant', style: 'font-size:clamp(44px,14vw,84px);margin:4px 0' },
            meilleure ? String(meilleure) : '—'),
          h('div', { class: 'meneur-nom', style: 'font-size:18px' + (jeMene ? ';color:var(--laiton-vif)' : '') }, nomMeneur)
        ]),
        h('div', { class: 'rangee g8' }, [
          h('div', { class: 'ligne', style: 'flex:1' }, [
            h('span', { class: 'etiquette' }, 'Ton offre'),
            h('span', { class: 'val chiffre or' }, String(monOffre))
          ]),
          h('div', { class: 'ligne', style: 'flex:1' }, [
            h('span', { class: 'etiquette' }, 'Ton ardoise'),
            h('span', { class: 'val chiffre' }, String(ardoise))
          ])
        ]),
        etatLien !== 'ok' ? h('div', { class: 'alerte' }, [
          h('b', {}, 'Connexion perdue. '),
          document.createTextNode('Tes mises ne partent plus. Rapproche-toi de la box ou reprends le WiFi — ça repart tout seul.')
        ]) : null,
        hoteKO ? h('div', { class: 'alerte' }, 'L’écran central est déconnecté. Les mises ne seront pas comptées tant qu’il n’est pas revenu.') : null
      ]));

      basZone.classList.remove('masque');
      btn1.disabled = jeMene;
      btn1.classList.toggle('mene', jeMene);
      btn1.querySelector('.lib').textContent = jeMene ? 'TU MÈNES' : '+1 ENCHÉRIR';
      btn1.querySelector('.sous').textContent = jeMene
        ? 'Tu dois ' + gorgees(monOffre) + ' si ça tombe'
        : 'Passe à ' + (meilleure + 1) + ' gorgées';
      btn5.textContent = jeMene ? 'Tu mènes déjà' : ('+5 d’un coup → ' + (meilleure + 5));
      btn5.disabled = jeMene;
      rafraichirMin(lot);
      return;
    }

    basZone.classList.add('masque');
    refMin = null; refJauge = null;

    if (lot && lot.statut === 'adjuge') {
      var gagnant = lot.meneur;
      var moi = gagnant === joueur.pid;
      haut.appendChild(h('div', { class: 'centre' }, [
        h('span', { class: 'tampon' }, gagnant ? 'Adjugé' : 'Invendu'),
        h('div', { class: 'gage-titre', style: 'font-size:clamp(17px,4.6vw,24px);max-width:32ch' }, lot.titre),
        gagnant ? h('div', { class: 'pile g4 centrer' }, [
          h('div', { class: 'etiquette' }, 'Remporté par'),
          h('div', { class: 'meneur-nom', style: 'font-size:26px' }, moi ? 'TOI' : nomDe(etat, gagnant)),
          h('div', { class: 'montant-geant', style: 'font-size:56px' }, String(lot.montant)),
          h('div', { class: 'etiquette' }, 'gorgées')
        ]) : h('p', { class: 'discret' }, 'Personne n’a misé.'),
        moi ? h('p', { class: 'or', style: 'max-width:30ch' }, 'À toi d’annoncer à voix haute qui fait le gage.') : null,
        h('div', { class: 'ligne', style: 'width:min(320px,100%)' }, [
          h('span', { class: 'etiquette' }, 'Ton ardoise'),
          h('span', { class: 'val chiffre or' }, String(ardoise))
        ])
      ]));
      return;
    }

    var programme = etat.programme || [];
    var vendus = programme.filter(function (x) { return x.statut === 'vendu'; });
    var mesLots = vendus.filter(function (x) { return x.pid === joueur.pid; });
    var restants = programme.filter(function (x) { return x.statut === 'attente'; }).length;
    var termine = programme.length > 0 && restants === 0;

    // Fin de la vente : chacun voit son propre relevé sur son téléphone,
    // pendant que le grand tableau s'affiche sur la TV.
    if (termine || etat.recap) {
      haut.appendChild(h('div', { class: 'centre' }, [
        h('div', { class: 'enseigne' }, [
          h('span', { class: 'petit' }, 'Clôture de la vente'),
          h('span', { class: 'gros' }, 'Ton relevé'),
          h('span', { class: 'filet' })
        ]),
        h('div', { class: 'carton dore centrer', style: 'width:min(340px,100%)' }, [
          h('div', { class: 'etiquette' }, monNom + ' doit'),
          h('div', { class: 'montant-geant', style: 'font-size:clamp(56px,18vw,96px);margin:6px 0' }, String(ardoise)),
          h('div', { class: 'etiquette' }, 'gorgées')
        ]),
        mesLots.length
          ? h('div', { class: 'carton', style: 'width:min(340px,100%);text-align:left' }, [
              h('div', { class: 'etiquette', style: 'margin-bottom:10px' }, 'Ce que tu as remporté'),
              h('div', {}, mesLots.map(function (x) {
                return h('div', { class: 'ligne', style: 'align-items:flex-start' }, [
                  h('span', { class: 'tres-discret', style: 'flex:1;min-width:0' }, x.titre),
                  h('span', { class: 'val chiffre or' }, String(x.montant))
                ]);
              }))
            ])
          : h('p', { class: 'discret' }, 'Tu n’as rien remporté. Sobre et malin.'),
        h('p', { class: 'tres-discret' }, 'Le détail complet est sur l’écran central.')
      ]));
      return;
    }

    haut.appendChild(h('div', { class: 'centre' }, [
      enseigne('Bonsoir ' + monNom),
      h('p', { class: 'discret' },
        restants ? ('Prochain lot en préparation — il en reste ' + restants + '.')
                 : 'Le prochain lot est en préparation. Reste à l’écoute.'),
      h('div', { class: 'ligne', style: 'width:min(320px,100%)' }, [
        h('span', { class: 'etiquette' }, 'Ton ardoise'),
        h('span', { class: 'val chiffre or' }, String(ardoise))
      ]),
      vendus.length ? h('div', { class: 'carton', style: 'width:min(340px,100%);text-align:left' }, [
        h('div', { class: 'etiquette', style: 'margin-bottom:8px' }, 'Derniers lots'),
        h('div', {}, vendus.slice(-4).reverse().map(function (x) {
          return h('div', { class: 'ligne' }, [
            h('span', { class: 'nom', style: 'font-size:14px' }, nomDe(etat, x.pid)),
            h('span', { class: 'val chiffre or' }, String(x.montant))
          ]);
        }))
      ]) : null,
      hoteKO ? h('div', { class: 'alerte' }, 'L’écran central est déconnecté.') : null
    ]));
  }

  function nomDe(etat, pid) {
    for (var i = 0; i < etat.joueurs.length; i++) if (etat.joueurs[i].id === pid) return etat.joueurs[i].nom;
    return '???';
  }

  function rafraichirMin(lot) {
    if (!refMin) return;
    var reste = Math.max(0, lot.fin - joueur.maintenantHote());
    var s = Math.ceil(reste / 1000);
    refMin.textContent = s < 10 ? '0' + s : String(s);
    var urgent = reste <= 5000;
    refMin.classList.toggle('urgent', urgent);
    if (refJauge) {
      refJauge.firstChild.style.width = Math.max(0, Math.min(100, (reste / lot.duree) * 100)) + '%';
      refJauge.classList.toggle('urgent', urgent);
    }
  }

  joueur.onEtat = function () { peindre(); };
  var tic = setInterval(function () {
    var etat = joueur.etat();
    if (etat && etat.lot && etat.lot.statut === 'ouvert') rafraichirMin(etat.lot);
  }, 200);

  peindre();
  return { root: root, fermer: function () { clearInterval(tic); } };
}

/* ---------------------------------------------------------
   12. Contrôleur
   --------------------------------------------------------- */

var App = {
  mode: null,
  ecran: null,

  monter: function (ecran) {
    var app = document.getElementById('app');
    if (this.ecran && this.ecran.fermer) this.ecran.fermer();
    vider(app);
    this.ecran = ecran;
    app.appendChild(ecran.root);
  },

  allerAccueil: function () { this.mode = 'accueil'; this.monter(ecranAccueil()); },
  allerRejoindre: function () { this.mode = 'accueil'; this.monter(ecranRejoindre()); },
  allerHoteConfig: function () { this.mode = 'accueil'; this.monter(ecranHoteConfig()); },

  demarrerHote: function (hote) {
    this.mode = 'hote';
    this.hote = hote;
    this.monter(ecranHote(hote));
  },

  demarrerJoueur: function (code, broker, pid, nom) {
    this.mode = 'joueur';
    var joueur = creerJoueur(code, broker, pid);
    this.joueur = joueur;
    this.monter(ecranJoueur(joueur, code, nom));
  },

  demarrer: function () {
    if (typeof mqtt === 'undefined') {
      document.getElementById('app').appendChild(h('div', { class: 'alerte' }, [
        h('b', {}, 'Le chargement de l’application a échoué. '),
        document.createTextNode('Recharge la page (tire vers le bas). Si ça recommence, ' +
          'vérifie ta connexion Internet.')
      ]));
      return;
    }
    var code = (P.s || '').toUpperCase();
    if (code) {
      var broker = brokersDisponibles().length === 1 ? brokersDisponibles()[0] : brokerParId(code[0]);
      if (!broker) { this.allerRejoindre(); return; }
      var memo = lire('mng.joueur.' + code);
      if (memo && memo.pid) {
        this.demarrerJoueur(code, broker, memo.pid, memo.nom);
      } else {
        this.mode = 'joueur';
        this.monter(ecranChoixNom(code, broker));
      }
      return;
    }
    this.allerAccueil();
  }
};

window.MNG = { App: App, BROKERS: BROKERS, GAGES: GAGES }; // utile aux tests

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { App.demarrer(); });
} else {
  App.demarrer();
}

})();
