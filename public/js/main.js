/* Aiguillage entre les écrans + installation de la salle. */
(function (root) {
  'use strict';

  var UI = root.MNGUI;
  var $ = UI.$;

  var NB_PLACES_DEFAUT = 9;
  var etatInstall = { noms: [], duree: 30 };

  /* ------------------------------------------------------ réglage de test --- */
  // Permet aux tests automatisés de viser un broker local (?ws=ws://…) plutôt que
  // les brokers publics. Sans effet en usage normal.
  (function surchargeBroker() {
    var m = /[?&]ws=([^&]+)/.exec(location.search);
    if (!m) return;
    var url = decodeURIComponent(m[1]);
    root.MNGNet.BROKERS.length = 0;
    root.MNGNet.BROKERS.push({ url: url, label: 'Local' });
  })();

  /* --------------------------------------------------------- installation --- */

  function rendreGrilleNoms() {
    var el = $('grille-noms');
    var html = '';
    for (var i = 0; i < etatInstall.noms.length; i++) {
      html +=
        '<input type="text" class="champ-nom" data-i="' + i + '" maxlength="14" ' +
        'autocomplete="off" spellcheck="false" placeholder="Prénom ' + (i + 1) + '" ' +
        'value="' + UI.esc(etatInstall.noms[i]) + '">';
    }
    el.innerHTML = html;
  }

  function lireNoms() {
    var champs = $('grille-noms').querySelectorAll('.champ-nom');
    var out = [];
    for (var i = 0; i < champs.length; i++) out.push(champs[i].value.trim());
    etatInstall.noms = out;
    return out.filter(function (n) {
      return n.length > 0;
    });
  }

  function rendreChoixDuree() {
    var el = $('choix-duree');
    var html = '';
    for (var i = 0; i < root.MNG.DURATIONS.length; i++) {
      var d = root.MNG.DURATIONS[i];
      html +=
        '<button class="' + (d === etatInstall.duree ? 'primaire' : 'fantome') + '" data-duree="' + d + '">' +
        d + ' s</button>';
    }
    el.innerHTML = html;
  }

  function ouvrirInstallation() {
    if (!etatInstall.noms.length) {
      etatInstall.noms = [];
      for (var i = 0; i < NB_PLACES_DEFAUT; i++) etatInstall.noms.push('');
    }
    rendreGrilleNoms();
    rendreChoixDuree();
    UI.alerte($('install-erreur'), '');
    UI.showScreen('ecr-install');
  }

  function lancerSalle() {
    var noms = lireNoms();
    if (noms.length < 2) {
      UI.alerte($('install-erreur'), 'Il faut au moins deux enchérisseurs pour ouvrir une vente.');
      return;
    }
    var vus = {};
    for (var i = 0; i < noms.length; i++) {
      var k = noms[i].toLowerCase();
      if (vus[k]) {
        UI.alerte($('install-erreur'), 'Deux personnes portent le prénom « ' + noms[i] + ' ». Ajoutez une initiale pour les distinguer.');
        return;
      }
      vus[k] = true;
    }
    var st = root.MNG.createState(root.MNG.makeCode(), noms, Date.now());
    st.duration = etatInstall.duree;
    demarrerCentral(st, true);
  }

  function demarrerCentral(st, nouvelle) {
    // Marqué avant de toucher au hash : sinon l'événement `hashchange` relance le
    // routeur, qui ne trouve pas encore de sauvegarde et renvoie vers l'accueil.
    demarre = true;
    location.hash = '#/tv';
    root.MNGCentral.demarrer({
      state: st,
      nouvelle: !!nouvelle,
      quit: function () {
        demarre = false;
        location.hash = '#/';
        UI.showScreen('ecr-accueil');
      },
    });
  }

  /* -------------------------------------------------------------- aiguillage - */

  var demarre = false;

  function router() {
    var h = location.hash || '#/';

    var mJoueur = /^#\/j\/([A-Z0-9]+)(?:\/(\d+))?/i.exec(h);
    if (mJoueur) {
      if (demarre) return;
      demarre = true;
      root.MNGPlayer.rejoindre({
        code: mJoueur[1].toUpperCase(),
        brokerIndex: mJoueur[2] ? Number(mJoueur[2]) : 0,
      });
      return;
    }

    if (h.indexOf('#/tv') === 0) {
      if (demarre) return;
      // Un rechargement de l'onglet TV doit retrouver la partie en cours.
      var sauve = root.MNGCentral.chargerSauvegarde();
      if (sauve) {
        demarre = true;
        demarrerCentral(sauve);
      } else {
        location.hash = '#/';
        UI.showScreen('ecr-accueil');
      }
      return;
    }

    if (h.indexOf('#/install') === 0) {
      ouvrirInstallation();
      return;
    }

    UI.showScreen('ecr-accueil');
  }

  /* ----------------------------------------------------------------- câblage - */

  function cabler() {
    $('btn-ouvrir-salle').addEventListener('click', function () {
      var sauve = root.MNGCentral.chargerSauvegarde();
      if (sauve) {
        var quand = sauve.history.length
          ? sauve.history.length + ' lot(s) déjà vendus'
          : 'aucun lot vendu';
        if (confirm('Une soirée est déjà en cours (' + quand + '). Reprendre là où vous en étiez ?')) {
          demarre = true;
          demarrerCentral(sauve);
          return;
        }
        root.MNGCentral.effacerSauvegarde();
      }
      location.hash = '#/install';
      ouvrirInstallation();
    });

    $('btn-retour-accueil').addEventListener('click', function () {
      location.hash = '#/';
      UI.showScreen('ecr-accueil');
    });

    $('btn-ajouter-nom').addEventListener('click', function () {
      lireNoms();
      etatInstall.noms.push('');
      rendreGrilleNoms();
    });

    $('choix-duree').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-duree]') : null;
      if (!b) return;
      etatInstall.duree = Number(b.getAttribute('data-duree'));
      rendreChoixDuree();
    });

    $('btn-lancer-salle').addEventListener('click', lancerSalle);

    function rejoindreDepuisCode() {
      var c = $('champ-code').value.trim().toUpperCase();
      if (c.length < 4) {
        alert('Entre le code affiché sur la TV (5 caractères).');
        return;
      }
      location.hash = '#/j/' + c;
      router();
    }
    $('btn-rejoindre').addEventListener('click', rejoindreDepuisCode);
    $('champ-code').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') rejoindreDepuisCode();
    });

    window.addEventListener('hashchange', router);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      cabler();
      router();
    });
  } else {
    cabler();
    router();
  }
})(typeof self !== 'undefined' ? self : this);
