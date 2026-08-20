/*
 * Couche temps réel — MQTT sur WebSocket.
 *
 * Pourquoi MQTT sur broker public : aucun compte à créer, ça traverse les NAT
 * mobiles et les réseaux d'appartement, ça tient en TLS sur un port standard,
 * et le flag « retain » offre gratuitement la reprise d'état pour un retardataire
 * qui scanne le QR code en cours de partie.
 *
 * Deux topics par session :
 *   mng1/<code>/s  état complet, publié par l'écran central, RETENU
 *   mng1/<code>/c  commandes, publiées par les téléphones
 *
 * Découverte de broker : les deux extrémités doivent être sur le même broker,
 * sinon elles ne se voient pas. L'écran central choisit le premier broker
 * joignable ; les téléphones commencent par celui indiqué dans l'URL du QR code
 * puis, s'ils ne reçoivent aucun état, essaient les suivants en boucle. Recevoir
 * l'état retenu est la preuve qu'on est sur le bon broker.
 */
(function (root) {
  'use strict';

  var BROKERS = [
    { url: 'wss://broker.emqx.io:8084/mqtt', label: 'EMQX' },
    { url: 'wss://broker.hivemq.com:8884/mqtt', label: 'HiveMQ' },
    { url: 'wss://test.mosquitto.org:8081/', label: 'Mosquitto' },
  ];

  // Un téléphone qui n'a rien reçu au bout de ce délai suppose s'être trompé de
  // broker et passe au suivant.
  var DISCOVERY_MS = 7000;
  var CONNECT_TIMEOUT_MS = 8000;

  // Périodicité de ré-émission d'une commande non acquittée.
  var RETRY_MS = 1200;
  var RETRY_MAX = 25; // ~30 s d'insistance avant d'abandonner

  function topics(code) {
    return { state: 'mng1/' + code + '/s', cmd: 'mng1/' + code + '/c' };
  }

  function brokerList() {
    return BROKERS.slice();
  }

  function clientId(role) {
    return 'mng-' + role + '-' + Math.random().toString(16).slice(2, 10);
  }

  /**
   * Ouvre un lien temps réel.
   *
   * opts = {
   *   role: 'central' | 'player',
   *   code: 'ABCDE',
   *   brokerIndex: 0,
   *   onMessage(obj),          // état reçu (joueur) ou commande reçue (central)
   *   onStatus({state, brokerLabel, detail}),
   * }
   */
  function open(opts) {
    var code = opts.code;
    var role = opts.role;
    var t = topics(code);
    var subTopic = role === 'central' ? t.cmd : t.state;
    var pubTopic = role === 'central' ? t.state : t.cmd;

    var idx = typeof opts.brokerIndex === 'number' ? opts.brokerIndex : 0;
    var client = null;
    var closed = false;
    var discoveryTimer = null;
    var gotMessage = false;
    var attemptsOnCycle = 0;
    var essaisMemeBroker = 0;
    // Une fois qu'un broker a effectivement porté du trafic, on s'y accroche plus
    // longtemps : une micro-coupure de wifi ne doit pas déplacer toute la partie
    // sur un autre serveur, ce qui obligerait chacun à se resynchroniser.
    var brokerEprouve = false;

    function status(state, detail) {
      if (opts.onStatus) {
        opts.onStatus({
          state: state,
          brokerLabel: BROKERS[idx % BROKERS.length].label,
          brokerIndex: idx % BROKERS.length,
          detail: detail || '',
        });
      }
    }

    function clearDiscovery() {
      if (discoveryTimer) {
        clearTimeout(discoveryTimer);
        discoveryTimer = null;
      }
    }

    /**
     * Replanifie une tentative : d'abord sur le même broker (une coupure est le
     * plus souvent locale et passagère), puis sur le suivant si ça persiste.
     */
    function replanifier(why) {
      if (closed) return;
      clearDiscovery();
      var plafond = brokerEprouve ? 4 : 1;
      if (essaisMemeBroker < plafond) {
        essaisMemeBroker++;
        teardown();
        setTimeout(connect, 800 * essaisMemeBroker);
        return;
      }
      essaisMemeBroker = 0;
      brokerEprouve = false;
      nextBroker(why);
    }

    function nextBroker(why) {
      if (closed) return;
      clearDiscovery();
      attemptsOnCycle++;
      idx = (idx + 1) % BROKERS.length;
      teardown();
      // Après un tour complet sans succès, on souffle un peu pour ne pas
      // marteler des serveurs injoignables (ex. wifi coupé).
      var wait = attemptsOnCycle >= BROKERS.length ? 4000 : 250;
      if (attemptsOnCycle >= BROKERS.length) {
        status('error', why || 'Aucun serveur ne répond');
        attemptsOnCycle = 0;
      }
      setTimeout(connect, wait);
    }

    function teardown() {
      if (client) {
        try {
          client.removeAllListeners();
          client.end(true);
        } catch (e) {
          /* le client est déjà mort, rien à faire */
        }
        client = null;
      }
    }

    function connect() {
      if (closed) return;
      var broker = BROKERS[idx % BROKERS.length];
      gotMessage = false;
      status('connecting');

      try {
        client = root.mqtt.connect(broker.url, {
          clientId: clientId(role),
          clean: true,
          keepalive: 30,
          reconnectPeriod: 0, // on pilote nous-mêmes la reprise, pour pouvoir changer de broker
          connectTimeout: CONNECT_TIMEOUT_MS,
          protocolVersion: 4,
        });
      } catch (e) {
        replanifier('Connexion impossible');
        return;
      }

      client.on('connect', function () {
        if (closed) return;
        attemptsOnCycle = 0;
        client.subscribe(subTopic, { qos: 0 }, function (err) {
          if (err) {
            replanifier('Abonnement refusé');
            return;
          }
          essaisMemeBroker = 0;
          status('online');
          if (opts.onReady) opts.onReady();
          // Un joueur doit recevoir l'état retenu très vite. Sinon, mauvais broker.
          if (role === 'player') {
            clearDiscovery();
            discoveryTimer = setTimeout(function () {
              if (!gotMessage && !closed) {
                // Silence complet : ce n'est pas une coupure, c'est le mauvais
                // broker. On passe directement au suivant.
                essaisMemeBroker = 0;
                nextBroker('Partie introuvable sur ce serveur');
              }
            }, DISCOVERY_MS);
          }
        });
      });

      client.on('message', function (topic, payload) {
        if (closed) return;
        gotMessage = true;
        brokerEprouve = true;
        clearDiscovery();
        var obj;
        try {
          obj = JSON.parse(payload.toString());
        } catch (e) {
          return; // message d'un autre usage du broker public : on ignore
        }
        if (!obj || obj.code !== code) return; // topic partagé par erreur : on ignore
        if (opts.onMessage) opts.onMessage(obj);
      });

      client.on('error', function () {
        if (closed) return;
        replanifier('Erreur de connexion');
      });

      client.on('close', function () {
        if (closed) return;
        status('offline', 'Connexion perdue');
        replanifier('Connexion fermée');
      });
    }

    connect();

    return {
      publish: function (obj, retain) {
        if (!client || !client.connected) return false;
        try {
          client.publish(pubTopic, JSON.stringify(obj), { qos: 0, retain: !!retain });
          return true;
        } catch (e) {
          return false;
        }
      },
      /** Efface l'état retenu du broker (fin de soirée). */
      clearRetained: function () {
        if (!client || !client.connected || role !== 'central') return;
        try {
          client.publish(t.state, '', { qos: 0, retain: true });
        } catch (e) {
          /* sans importance */
        }
      },
      isConnected: function () {
        return !!(client && client.connected);
      },
      /**
       * Force une reconnexion immédiate. Utile quand la socket est toujours
       * ouverte mais que plus rien n'arrive : le lien est mort sans l'avoir dit,
       * et seul un appelant qui attend des données peut s'en rendre compte.
       */
      reveiller: function () {
        if (closed) return;
        essaisMemeBroker = 0;
        teardown();
        connect();
      },
      brokerIndex: function () {
        return idx % BROKERS.length;
      },
      close: function () {
        closed = true;
        clearDiscovery();
        teardown();
      },
    };
  }

  /**
   * File de commandes fiable côté téléphone.
   *
   * Chaque commande est ré-émise tant que son identifiant n'apparaît pas dans les
   * acquittements de l'état. C'est ce qui garantit qu'aucune mise n'est perdue,
   * même si le wifi hoquette au moment du tap.
   */
  function createOutbox(link) {
    var pending = []; // { cmd, tries, firstAt, lastAt, snapAt }
    var timer = null;
    var snapshots = 0; // nombre d'états reçus depuis l'ouverture du lien

    function flush() {
      var nowTs = Date.now();
      for (var i = 0; i < pending.length; i++) {
        var item = pending[i];
        if (item.tries === 0 || nowTs - item.lastAt >= RETRY_MS) {
          if (link.publish(item.cmd)) {
            item.tries++;
            item.lastAt = nowTs;
          }
        }
      }
      // Abandon des commandes désespérées, pour ne pas boucler indéfiniment.
      pending = pending.filter(function (it) {
        return it.tries < RETRY_MAX;
      });
    }

    function start() {
      if (timer) return;
      timer = setInterval(flush, 300);
    }

    return {
      send: function (cmd) {
        pending.push({ cmd: cmd, tries: 0, lastAt: 0, firstAt: Date.now(), snapAt: snapshots });
        start();
        flush();
      },
      /**
       * Retire de la file tout ce que l'écran central a acquitté.
       *
       * La fenêtre d'acquittements diffusée est volontairement courte. Une
       * commande peut donc avoir été appliquée sans que son identifiant y figure
       * encore. On l'abandonne alors au bout de plusieurs allers-retours réussis :
       * à ce stade, soit elle est arrivée (l'écran central dédoublonne, aucun
       * risque de double comptage), soit le lien est sain et les ré-émissions
       * l'auraient forcément fait passer.
       */
      reconcile: function (acks) {
        snapshots++;
        var set = {};
        if (acks) {
          for (var i = 0; i < acks.length; i++) set[acks[i]] = true;
        }
        var nowTs = Date.now();
        pending = pending.filter(function (it) {
          if (set[it.cmd.id]) return false;
          var perime = snapshots - it.snapAt >= 4 && nowTs - it.firstAt > 6000;
          return !perime;
        });
      },
      pendingCount: function () {
        return pending.length;
      },
      /** Somme des gorgées encore en vol (affichage optimiste). */
      pendingBid: function () {
        var n = 0;
        for (var i = 0; i < pending.length; i++) {
          if (pending[i].cmd.t === 'bid') n += pending[i].cmd.n;
        }
        return n;
      },
      /** Âge de la commande la plus ancienne encore en attente, en ms. */
      oldestAge: function () {
        if (!pending.length) return 0;
        var oldest = pending[0].firstAt;
        for (var i = 1; i < pending.length; i++) {
          if (pending[i].firstAt < oldest) oldest = pending[i].firstAt;
        }
        return Date.now() - oldest;
      },
      stop: function () {
        if (timer) clearInterval(timer);
        timer = null;
        pending = [];
      },
    };
  }

  root.MNGNet = {
    BROKERS: BROKERS,
    brokerList: brokerList,
    topics: topics,
    open: open,
    createOutbox: createOutbox,
    DISCOVERY_MS: DISCOVERY_MS,
  };
})(typeof self !== 'undefined' ? self : this);
