/* Petites aides d'affichage partagées par les deux écrans. */
(function (root) {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function show(el, on) {
    if (el) el.style.display = on ? '' : 'none';
  }

  function showScreen(id) {
    var all = document.querySelectorAll('.screen');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('on');
    var target = $(id);
    if (target) target.classList.add('on');
    window.scrollTo(0, 0);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var ETATS = {
    connecting: 'Connexion…',
    online: 'En ligne',
    offline: 'Connexion perdue',
    error: 'Hors ligne',
  };

  function setStatut(rootEl, txtEl, st) {
    if (!rootEl) return;
    rootEl.setAttribute('data-etat', st.state);
    if (txtEl) {
      var base = ETATS[st.state] || st.state;
      if (st.state === 'online') base += ' · ' + st.brokerLabel;
      else if (st.detail) base = st.detail;
      txtEl.textContent = base;
    }
  }

  /** Affiche (ou efface) un bandeau d'erreur lisible par un non-technicien. */
  function alerte(container, message, douce) {
    if (!container) return;
    if (!message) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML =
      '<div class="alerte' + (douce ? ' douce' : '') + '">' + esc(message) + '</div>';
  }

  function gorgees(n) {
    return n + ' gorgée' + (n > 1 ? 's' : '');
  }

  /** Rend un QR code dans un conteneur, sans dépendance réseau. */
  function dessinerQR(container, texte) {
    container.innerHTML = '';
    // Type 0 = choix automatique de la version selon la longueur du texte.
    var qr = root.qrcode(0, 'M');
    qr.addData(texte);
    qr.make();
    container.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
    var svg = container.querySelector('svg');
    if (svg) {
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.style.display = 'block';
    }
  }

  /** Empêche l'écran de la TV de s'éteindre pendant la soirée. */
  function garderEveille() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    var lock = null;
    function acquire() {
      navigator.wakeLock
        .request('screen')
        .then(function (l) {
          lock = l;
          l.addEventListener('release', function () {
            lock = null;
          });
        })
        .catch(function () {
          /* refusé par le navigateur : sans conséquence */
        });
    }
    acquire();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !lock) acquire();
    });
  }

  root.MNGUI = {
    $: $,
    show: show,
    showScreen: showScreen,
    esc: esc,
    setStatut: setStatut,
    alerte: alerte,
    gorgees: gorgees,
    dessinerQR: dessinerQR,
    garderEveille: garderEveille,
  };
})(typeof self !== 'undefined' ? self : this);
