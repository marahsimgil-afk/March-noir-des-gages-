/*
 * Écran central (la TV) — arbitre de la partie.
 *
 * Il est le seul à muter l'état : il reçoit les commandes des téléphones,
 * les applique, et rediffuse un instantané complet. Cette centralisation évite
 * tout conflit d'écriture quand neuf personnes tapent en même temps.
 *
 * L'état est sauvegardé dans localStorage à chaque changement : si la tablette
 * se verrouille, si Safari recharge l'onglet ou si quelqu'un débranche le HDMI,
 * la soirée reprend là où elle s'était arrêtée.
 */
(function (root) {
  'use strict';

  var UI = root.MNGUI;
  var $ = UI.$;

  var CLE_SAUVEGARDE = 'mng.central.v1';

  // Fréquence maximale de diffusion. En rafale, les changements sont regroupés :
  // ~8 messages/seconde suffisent à donner une impression d'instantanéité tout en
  // restant très raisonnable pour un broker public.
  var PUBLI_MIN_MS = 120;
  // Rediffusion périodique même sans changement : rafraîchit le message retenu et
  // sert de battement de cœur aux téléphones.
  var BATTEMENT_MS = 3000;

  var state = null;
  var link = null;
  var publiTimer = null;
  var dernierePubli = 0;
  var tickTimer = null;
  var battementTimer = null;
  var lotChoisi = null;
  var derniersMontants = {}; // pour animer les pions qui bougent
  var onQuit = null;

  /* ------------------------------------------------------------ persistance -- */

  function sauver() {
    try {
      localStorage.setItem(
        CLE_SAUVEGARDE,
        JSON.stringify({ state: state, brokerIndex: link ? link.brokerIndex() : 0 })
      );
    } catch (e) {
      /* mode privé Safari : on continue sans sauvegarde */
    }
  }

  function chargerSauvegarde() {
    try {
      var raw = localStorage.getItem(CLE_SAUVEGARDE);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.state || !obj.state.code || !obj.state.players) return null;
      if (obj.state.v !== root.MNG.PROTOCOL) return null;
      return obj.state;
    } catch (e) {
      return null;
    }
  }

  function effacerSauvegarde() {
    try {
      localStorage.removeItem(CLE_SAUVEGARDE);
    } catch (e) {
      /* rien à faire */
    }
  }

  /* --------------------------------------------------------------- diffusion -- */

  function publier(immediat) {
    if (!link) return;
    var maintenant = Date.now();
    var depuis = maintenant - dernierePubli;
    if (!immediat && depuis < PUBLI_MIN_MS) {
      if (!publiTimer) {
        publiTimer = setTimeout(function () {
          publiTimer = null;
          publier(true);
        }, PUBLI_MIN_MS - depuis);
      }
      return;
    }
    if (publiTimer) {
      clearTimeout(publiTimer);
      publiTimer = null;
    }
    dernierePubli = maintenant;
    state.rev++;
    link.publish(root.MNG.snapshot(state, maintenant), true);
  }

  /* ------------------------------------------------------------------- rendu -- */

  function rendreArdoises() {
    var classement = root.MNG.ranking(state);
    var maintenant = Date.now();
    var html = '';
    for (var i = 0; i < classement.length; i++) {
      var p = classement[i];
      var enLigne = p.seen && maintenant - p.seen < 90000;
      html +=
        '<div class="ardoise-ligne' + (i === 0 && p.tab > 0 ? ' tete' : '') + '">' +
        '<span class="ardoise-rang mono">' + (i + 1) + '</span>' +
        '<span class="ardoise-nom">' +
        (enLigne ? '<i class="pastille-co"></i>' : '') +
        UI.esc(p.name) +
        '</span>' +
        '<span class="ardoise-total mono">' + p.tab + '</span>' +
        '</div>';
    }
    $('central-ardoises').innerHTML = html;
  }

  function rendreHisto() {
    var el = $('central-histo');
    if (!state.history.length) {
      el.innerHTML = '<p class="discret">Aucune vente pour l’instant.</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < state.history.length; i++) {
      var h = state.history[i];
      html +=
        '<div class="histo-ligne">' +
        (h.winnerName
          ? '<span class="qui">' + UI.esc(h.winnerName) + '</span> — <span class="combien">' + h.amount + ' gorgées</span>'
          : '<span class="discret">Invendu</span>') +
        '<span class="qoi">' + UI.esc(h.title) + '</span>' +
        '</div>';
    }
    el.innerHTML = html;
  }

  function rendreEncheres() {
    var el = $('central-encheres');
    var meneur = root.MNG.leader(state);
    var html = '';
    var liste = state.players.slice().sort(function (a, b) {
      return (state.bids[b.id] || 0) - (state.bids[a.id] || 0);
    });
    for (var i = 0; i < liste.length; i++) {
      var p = liste[i];
      var montant = state.bids[p.id] || 0;
      if (!montant) continue;
      var bouge = derniersMontants[p.id] !== undefined && derniersMontants[p.id] !== montant;
      html +=
        '<span class="enchere-pion' +
        (meneur && meneur.id === p.id ? ' chef' : '') +
        (bouge ? ' bouge' : '') +
        '">' + UI.esc(p.name) + ' <b>' + montant + '</b></span>';
      derniersMontants[p.id] = montant;
    }
    el.innerHTML = html || '<span class="meneur-vide">Aucune offre pour le moment…</span>';
  }

  function rendreMeneur() {
    var meneur = root.MNG.leader(state);
    $('central-meneur').innerHTML = meneur
      ? '<div class="meneur-nom">' + UI.esc(meneur.name) + '</div>' +
        '<div class="meneur-montant">mène à <b>' + meneur.amount + '</b> gorgées</div>'
      : '<div class="meneur-vide">Personne n’a encore osé.</div>';
  }

  function rendreMinuteur() {
    if (state.phase !== 'open') return;
    var reste = root.MNG.remainingMs(state, Date.now());
    var sec = Math.ceil(reste / 1000);
    var urgent = reste <= 5000;
    var m = $('central-minuteur');
    m.textContent = sec < 10 ? '0' + sec : String(sec);
    m.classList.toggle('urgence', urgent);
    var jauge = $('central-jauge');
    jauge.classList.toggle('urgence', urgent);
    jauge.firstElementChild.style.width =
      Math.max(0, Math.min(100, (reste / (state.duration * 1000)) * 100)) + '%';
  }

  function rendreVues() {
    UI.show($('vue-repos'), state.phase === 'lobby');
    UI.show($('vue-enchere'), state.phase === 'open');
    UI.show($('vue-adjuge'), state.phase === 'closed');

    if (state.phase === 'open') {
      $('central-lot').textContent = state.lot.title;
      rendreMinuteur();
      rendreMeneur();
      rendreEncheres();
    } else if (state.phase === 'closed') {
      var r = state.result;
      $('adjuge-lot').textContent = r.title;
      if (r.winnerId) {
        $('adjuge-qui').innerHTML =
          '<div class="meneur-nom">' + UI.esc(r.winnerName) + '</div>' +
          '<div class="meneur-montant">emporte le lot pour <b>' + r.amount + '</b> gorgées</div>';
        // textContent échappe déjà : pas de UI.esc ici, sinon un « & » s’afficherait tel quel.
        $('adjuge-consigne').textContent =
          r.winnerName + ' annonce à voix haute qui exécute le gage, et comment.';
      } else {
        $('adjuge-qui').innerHTML = '<div class="meneur-vide">Aucune offre. Le lot reste invendu.</div>';
        $('adjuge-consigne').textContent = '';
      }
      $('btn-encaisser').textContent = r.winnerId
        ? 'Valider — porter ' + r.amount + ' gorgées à l’ardoise'
        : 'Passer au lot suivant';
    }
  }

  function rendre() {
    rendreVues();
    rendreArdoises();
    rendreHisto();
  }

  /* ----------------------------------------------------------------- horloge -- */

  function tick() {
    if (state.phase !== 'open') return;
    rendreMinuteur();
    // Clôture automatique : on laisse passer la marge de tolérance pour que les
    // mises parties juste avant le gong soient comptées.
    if (Date.now() > state.endsAt + root.MNG.GRACE_MS) {
      root.MNG.closeLot(state, state.endsAt);
      sauver();
      rendre();
      publier(true);
    }
  }

  /* ---------------------------------------------------------------- commandes -- */

  function surCommande(cmd) {
    var res = root.MNG.applyCommand(state, cmd, Date.now());
    if (!res.applied) return; // doublon : déjà traité
    if (res.changed) {
      sauver();
      if (state.phase === 'open') {
        rendreMeneur();
        rendreEncheres();
      } else {
        rendreArdoises();
      }
    }
    // Même une commande sans effet doit provoquer une diffusion : c'est ainsi que
    // le téléphone reçoit son acquittement et arrête de ré-émettre.
    publier(false);
  }

  /* ------------------------------------------------------------------ actions -- */

  function urlJoueur() {
    var base = location.href.split('#')[0];
    return base + '#/j/' + state.code + '/' + (link ? link.brokerIndex() : 0);
  }

  function afficherQR() {
    var url = urlJoueur();
    try {
      UI.dessinerQR($('qr-cible'), url);
    } catch (e) {
      $('qr-cible').innerHTML =
        '<p style="color:#000;font-size:0.8rem;padding:10px">QR indisponible — utilisez le code ci-dessous.</p>';
    }
    $('qr-url-txt').textContent = location.host + location.pathname;
    $('qr-code-txt').textContent = state.code;
    $('modale-qr').classList.add('on');
  }

  function fermerQR() {
    $('modale-qr').classList.remove('on');
  }

  function remplirListeGages() {
    var el = $('liste-gages');
    var html = '';
    for (var i = 0; i < root.MNG.DEFAULT_LOTS.length; i++) {
      html +=
        '<button class="gage-choix" data-gage="' + i + '">' +
        UI.esc(root.MNG.DEFAULT_LOTS[i]) +
        '</button>';
    }
    el.innerHTML = html;
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-gage]') : null;
      if (!b) return;
      var idx = Number(b.getAttribute('data-gage'));
      $('champ-gage').value = root.MNG.DEFAULT_LOTS[idx];
      var tous = el.querySelectorAll('.gage-choix');
      for (var i = 0; i < tous.length; i++) tous[i].classList.remove('actif');
      b.classList.add('actif');
      lotChoisi = idx;
    });
  }

  function lancerEnchere() {
    var titre = $('champ-gage').value.trim();
    if (!titre) {
      UI.alerte($('central-alerte'), 'Choisissez ou tapez un gage avant d’ouvrir les enchères.', true);
      return;
    }
    UI.alerte($('central-alerte'), '');
    derniersMontants = {};
    root.MNG.openLot(state, titre, state.duration, Date.now());
    sauver();
    rendre();
    publier(true);
  }

  function encaisser() {
    root.MNG.settle(state, Date.now());
    $('champ-gage').value = '';
    lotChoisi = null;
    var actifs = $('liste-gages').querySelectorAll('.gage-choix.actif');
    for (var i = 0; i < actifs.length; i++) actifs[i].classList.remove('actif');
    sauver();
    rendre();
    publier(true);
  }

  function annuler() {
    root.MNG.cancelLot(state);
    sauver();
    rendre();
    publier(true);
  }

  function terminer() {
    if (!confirm('Terminer la soirée ? Les ardoises et l’historique seront effacés.')) return;
    if (link) {
      link.clearRetained();
      setTimeout(function () {
        link.close();
        link = null;
      }, 250);
    }
    effacerSauvegarde();
    arreterTimers();
    if (onQuit) onQuit();
  }

  function arreterTimers() {
    if (tickTimer) clearInterval(tickTimer);
    if (battementTimer) clearInterval(battementTimer);
    if (publiTimer) clearTimeout(publiTimer);
    tickTimer = battementTimer = publiTimer = null;
  }

  /* ------------------------------------------------------------------ câblage -- */

  var cableFait = false;

  function cabler() {
    if (cableFait) return;
    cableFait = true;
    remplirListeGages();

    $('btn-qr').addEventListener('click', afficherQR);
    $('btn-fermer-qr').addEventListener('click', fermerQR);
    $('modale-qr').addEventListener('click', function (ev) {
      if (ev.target === $('modale-qr')) fermerQR();
    });
    $('btn-lancer-enchere').addEventListener('click', lancerEnchere);
    $('btn-tirer-gage').addEventListener('click', function () {
      var i = Math.floor(Math.random() * root.MNG.DEFAULT_LOTS.length);
      $('champ-gage').value = root.MNG.DEFAULT_LOTS[i];
    });
    $('btn-clore').addEventListener('click', function () {
      root.MNG.closeLot(state, Date.now());
      sauver();
      rendre();
      publier(true);
    });
    $('btn-annuler-lot').addEventListener('click', annuler);
    $('btn-annuler-vente').addEventListener('click', annuler);
    $('btn-encaisser').addEventListener('click', encaisser);
    $('btn-fin').addEventListener('click', terminer);
  }

  /**
   * Démarre l'écran central.
   * opts = { state, quit }
   */
  function demarrer(opts) {
    state = opts.state;
    onQuit = opts.quit;
    cabler();
    UI.showScreen('ecr-central');
    UI.garderEveille();
    rendre();

    link = root.MNGNet.open({
      role: 'central',
      code: state.code,
      brokerIndex: 0,
      onMessage: surCommande,
      onStatus: function (st) {
        UI.setStatut($('statut-central'), $('statut-central-txt'), st);
        if (st.state === 'error') {
          UI.alerte(
            $('central-alerte'),
            'Aucun serveur de synchronisation ne répond. Vérifiez le wifi ou la 4G de cette tablette : ' +
              'les téléphones ne peuvent pas enchérir tant que ce voyant est rouge.'
          );
        } else if (st.state === 'online') {
          UI.alerte($('central-alerte'), '');
        }
      },
      onReady: function () {
        publier(true);
        sauver();
      },
    });

    arreterTimers();
    tickTimer = setInterval(tick, 100);
    battementTimer = setInterval(function () {
      publier(true);
    }, BATTEMENT_MS);

    // Si la tablette se réveille après une mise en veille, on se resynchronise.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state) {
        rendre();
        publier(true);
      }
    });

    // Le QR ne s'ouvre de lui-même qu'à la création de la salle : c'est l'action
    // suivante attendue. Sur une reprise (onglet rechargé en pleine soirée), il
    // viendrait se mettre en travers de l'écran alors que tout le monde a déjà
    // rejoint ; le bouton reste là pour les retardataires.
    if (opts.nouvelle) setTimeout(afficherQR, 400);
  }

  root.MNGCentral = {
    demarrer: demarrer,
    chargerSauvegarde: chargerSauvegarde,
    effacerSauvegarde: effacerSauvegarde,
    /* exposé pour les tests automatisés */
    _etat: function () {
      return state;
    },
  };
})(typeof self !== 'undefined' ? self : this);
