/*
 * Écran joueur (téléphone).
 *
 * Client mince : il n'invente rien, il affiche l'état reçu de l'écran central et
 * lui envoie des commandes. Un tap sur « +1 » est affiché immédiatement (mise
 * optimiste) puis confirmé par l'état faisant autorité — si le lien hoquette, la
 * commande est ré-émise jusqu'à son acquittement.
 */
(function (root) {
  'use strict';

  var UI = root.MNGUI;
  var $ = UI.$;

  var CLE_IDENTITE = 'mng.joueur.v1';
  // Au-delà de ce silence, on considère que l'écran central ne parle plus.
  var SILENCE_MS = 12000;

  var code = null;
  var link = null;
  var outbox = null;
  var etat = null; // dernier instantané reçu
  var moi = null; // identifiant du joueur
  var offset = 0; // décalage d'horloge avec l'écran central
  var dernierEtatA = 0;
  var tickTimer = null;
  var cableFait = false;

  /* ------------------------------------------------------------ persistance -- */

  function sauverIdentite(id) {
    try {
      localStorage.setItem(CLE_IDENTITE, JSON.stringify({ code: code, id: id }));
    } catch (e) {
      /* mode privé : on jouera sans mémoire */
    }
  }

  function lireIdentite() {
    try {
      var o = JSON.parse(localStorage.getItem(CLE_IDENTITE) || 'null');
      return o && o.code === code ? o.id : null;
    } catch (e) {
      return null;
    }
  }

  /* --------------------------------------------------------------- utilitaires */

  function maintenantCentral() {
    return Date.now() + offset;
  }

  function joueur(id) {
    if (!etat) return null;
    for (var i = 0; i < etat.players.length; i++) {
      if (etat.players[i].id === id) return etat.players[i];
    }
    return null;
  }

  function resteMs() {
    if (!etat || etat.phase !== 'open' || !etat.endsAt) return 0;
    return Math.max(0, etat.endsAt - maintenantCentral());
  }

  function enchereOuverte() {
    return !!etat && etat.phase === 'open' && resteMs() > 0;
  }

  /* ------------------------------------------------------------------- rendu -- */

  function rendreIdentites() {
    var el = $('liste-identites');
    if (!etat) {
      el.innerHTML = '';
      return;
    }
    var html = '';
    // `seen` est daté par l'horloge de l'écran central : on le compare donc à
    // l'heure de l'écran central, pas à celle du téléphone.
    var maintenant = maintenantCentral();
    for (var i = 0; i < etat.players.length; i++) {
      var p = etat.players[i];
      // Un prénom déjà actif reste choisissable (téléphone rechargé, batterie
      // changée…), mais on le signale pour éviter les doublons involontaires.
      var pris = p.seen && maintenant - p.seen < 60000;
      html +=
        '<button class="nom-bouton" data-id="' + UI.esc(p.id) + '">' +
        UI.esc(p.name) +
        (pris ? '<br><small style="font-family:var(--mono);font-size:0.6rem;opacity:0.6">déjà connecté</small>' : '') +
        '</button>';
    }
    el.innerHTML = html;
  }

  function rendreMinuteur() {
    var reste = resteMs();
    var sec = Math.ceil(reste / 1000);
    var urgent = reste <= 5000;
    var m = $('joueur-minuteur');
    m.textContent = sec < 10 ? '0' + sec : String(sec);
    m.classList.toggle('urgence', urgent);
    var jauge = $('joueur-jauge');
    jauge.classList.toggle('urgence', urgent);
    jauge.firstElementChild.style.width =
      Math.max(0, Math.min(100, (reste / ((etat.duration || 30) * 1000)) * 100)) + '%';
  }

  function rendreJeu() {
    if (!etat) return;
    var p = joueur(moi);
    $('joueur-nom').textContent = p ? p.name : '—';
    $('joueur-ardoise').textContent = p ? p.tab : 0;

    UI.show($('jv-attente'), etat.phase === 'lobby');
    UI.show($('jv-enchere'), etat.phase === 'open');
    UI.show($('jv-resultat'), etat.phase === 'closed');

    if (etat.phase === 'open') {
      $('joueur-lot').textContent = etat.lot ? etat.lot.title : '';
      rendreMinuteur();

      var meneur = etat.leader;
      var elMeneur = $('joueur-meneur');
      if (!meneur) {
        elMeneur.innerHTML = 'Aucune offre. <b>Lance-toi.</b>';
        elMeneur.classList.remove('cest-moi');
      } else if (meneur.id === moi) {
        elMeneur.innerHTML = 'Tu mènes à <b>' + meneur.amount + '</b> gorgées';
        elMeneur.classList.add('cest-moi');
      } else {
        elMeneur.innerHTML = '<b>' + UI.esc(meneur.name) + '</b> mène à ' + meneur.amount + ' gorgées';
        elMeneur.classList.remove('cest-moi');
      }

      var confirmee = (etat.bids && etat.bids[moi]) || 0;
      var enVol = outbox ? outbox.pendingBid() : 0;
      $('joueur-ma-mise').innerHTML =
        'Ma mise : <b>' + (confirmee + enVol) + '</b>' +
        (enVol ? ' <span class="vol">(' + enVol + ' en cours d’envoi…)</span>' : '');

      var ouvert = enchereOuverte();
      $('btn-plus-un').disabled = !ouvert;
      $('btn-plus-cinq').disabled = !ouvert;
    } else if (etat.phase === 'closed' && etat.result) {
      var r = etat.result;
      $('joueur-res-lot').textContent = r.title;
      if (!r.winnerId) {
        $('joueur-res-qui').innerHTML = '<p class="tel-meneur">Invendu. Personne n’a misé.</p>';
      } else if (r.winnerId === moi) {
        $('joueur-res-qui').innerHTML =
          '<div class="tampon">Adjugé</div>' +
          '<p class="tel-meneur mt">C’est toi. <b>' + r.amount + ' gorgées</b> pour toi.<br>' +
          'À toi d’annoncer qui exécute le gage.</p>';
      } else {
        $('joueur-res-qui').innerHTML =
          '<p class="tel-meneur"><b>' + UI.esc(r.winnerName) + '</b> remporte le lot pour ' +
          r.amount + ' gorgées.</p>';
      }
    }
  }

  function rendreAlerteLien() {
    var el = $('joueur-alerte');
    if (!dernierEtatA) return;
    var silence = Date.now() - dernierEtatA;
    if (silence > SILENCE_MS) {
      UI.alerte(el, 'Contact perdu avec l’écran central. On réessaie… Vérifie ta connexion.');
    } else if (outbox && outbox.pendingCount() > 0 && outbox.oldestAge() > 2500) {
      UI.alerte(el, 'Tes dernières mises n’ont pas encore été confirmées. On insiste, ne re-tape pas.', true);
    } else {
      UI.alerte(el, '');
    }
  }

  function tick() {
    if (etat && etat.phase === 'open') rendreMinuteur();
    if (etat && moi) {
      var confirmee = (etat.bids && etat.bids[moi]) || 0;
      var enVol = outbox ? outbox.pendingBid() : 0;
      var el = $('joueur-ma-mise');
      if (el && etat.phase === 'open') {
        el.innerHTML =
          'Ma mise : <b>' + (confirmee + enVol) + '</b>' +
          (enVol ? ' <span class="vol">(' + enVol + ' en cours d’envoi…)</span>' : '');
      }
      var ouvert = enchereOuverte();
      if ($('btn-plus-un')) $('btn-plus-un').disabled = !ouvert;
      if ($('btn-plus-cinq')) $('btn-plus-cinq').disabled = !ouvert;
    }
    rendreAlerteLien();
  }

  /* ---------------------------------------------------------------- réception -- */

  function surEtat(st) {
    etat = st;
    offset = st.now - Date.now();
    dernierEtatA = Date.now();
    if (outbox) outbox.reconcile(st.acks);

    if (!moi) {
      // Pas encore identifié : soit on retrouve le choix précédent, soit on demande.
      var memorise = lireIdentite();
      if (memorise && joueur(memorise)) {
        choisir(memorise);
        return;
      }
      $('identite-code').textContent = st.code;
      UI.alerte($('identite-alerte'), '');
      rendreIdentites();
      return;
    }
    rendreJeu();
  }

  /* ------------------------------------------------------------------ actions -- */

  function envoyer(cmd) {
    cmd.id = root.MNG.makeId();
    // Le code de salle voyage avec chaque commande : sur un broker public, il
    // permet à l'écran central d'ignorer ce qui ne vient pas de sa partie.
    cmd.code = code;
    outbox.send(cmd);
  }

  function encherir(n) {
    if (!enchereOuverte()) return;
    envoyer({ t: 'bid', p: moi, n: n });
    if (navigator.vibrate) {
      try {
        navigator.vibrate(12);
      } catch (e) {
        /* pas de vibreur : sans importance */
      }
    }
    rendreJeu();
  }

  function choisir(id) {
    moi = id;
    sauverIdentite(id);
    envoyer({ t: 'join', p: id });
    UI.showScreen('ecr-joueur');
    rendreJeu();
  }

  function cabler() {
    if (cableFait) return;
    cableFait = true;

    $('liste-identites').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-id]') : null;
      if (b) choisir(b.getAttribute('data-id'));
    });

    // pointerdown plutôt que click : sur iOS, le retour visuel est nettement plus
    // vif, et une rafale de taps rapides n'est pas avalée par la détection de
    // double-tap de Safari.
    var bind = function (el, n) {
      el.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        encherir(n);
      });
      // Repli pour les navigateurs sans pointer events.
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (!('PointerEvent' in root)) encherir(n);
      });
    };
    bind($('btn-plus-un'), 1);
    bind($('btn-plus-cinq'), 5);
  }

  /**
   * Rejoint une salle.
   * opts = { code, brokerIndex }
   */
  function rejoindre(opts) {
    code = opts.code;
    cabler();
    UI.showScreen('ecr-identite');
    $('identite-code').textContent = code;
    $('liste-identites').innerHTML = '';

    link = root.MNGNet.open({
      role: 'player',
      code: code,
      brokerIndex: opts.brokerIndex || 0,
      onMessage: surEtat,
      onStatus: function (st) {
        UI.setStatut($('statut-identite'), $('statut-identite-txt'), st);
        UI.setStatut($('statut-joueur'), $('statut-joueur-txt'), st);
        if (st.state === 'error') {
          var msg =
            'Impossible de trouver la salle « ' + code + ' ». Vérifie ta connexion, ' +
            'et que l’écran central est bien allumé sur la partie.';
          UI.alerte($('identite-alerte'), msg);
          if (moi) UI.alerte($('joueur-alerte'), msg);
        }
      },
    });

    outbox = root.MNGNet.createOutbox(link);

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 150);

    // Si rien n'arrive du tout, on le dit clairement plutôt que de laisser
    // tourner un écran muet.
    setTimeout(function () {
      if (!etat) {
        UI.alerte(
          $('identite-alerte'),
          'Toujours pas de réponse de la salle. On continue de chercher — ' +
            'demande à l’organisatrice si l’écran central est bien connecté.'
        );
      }
    }, root.MNGNet.DISCOVERY_MS * 3);
  }

  root.MNGPlayer = {
    rejoindre: rejoindre,
    /* exposé pour les tests automatisés */
    _etat: function () {
      return { etat: etat, moi: moi, pending: outbox ? outbox.pendingCount() : 0 };
    },
  };
})(typeof self !== 'undefined' ? self : this);
