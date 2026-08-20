/*
 * Diagnostic des brokers MQTT publics utilisés en production.
 *
 * Pour chaque broker de la liste : connexion, abonnement, publication retenue,
 * réception, et mesure de l'aller-retour. Sert à savoir, avant la soirée, lesquels
 * répondent réellement — l'application bascule automatiquement, mais autant le
 * constater plutôt que le supposer.
 *
 * Sortie en échec seulement si AUCUN broker ne répond : un seul suffit à jouer.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mqtt = require('mqtt');

// net.js est écrit pour le navigateur : on lui fabrique un `self`.
const bacASable = { console };
bacASable.self = bacASable;
vm.createContext(bacASable);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'net.js'), 'utf8'), bacASable);
const BROKERS = bacASable.MNGNet.BROKERS;

const DELAI_MS = 15000;

function essayer(broker) {
  return new Promise((resolve) => {
    const sujet = 'mng1/DIAG' + Math.random().toString(36).slice(2, 7) + '/s';
    const t0 = Date.now();
    let fini = false;

    const terminer = (ok, detail, ms) => {
      if (fini) return;
      fini = true;
      try {
        client.end(true);
      } catch (e) {
        /* déjà fermé */
      }
      resolve({ broker, ok, detail, ms });
    };

    const client = mqtt.connect(broker.url, {
      clientId: 'mng-diag-' + Math.random().toString(16).slice(2, 10),
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: DELAI_MS,
      protocolVersion: 4,
    });

    const minuterie = setTimeout(() => terminer(false, 'délai dépassé'), DELAI_MS);

    client.on('connect', () => {
      const tConnect = Date.now() - t0;
      client.subscribe(sujet, { qos: 0 }, (err) => {
        if (err) return terminer(false, 'abonnement refusé : ' + err.message);
        // Le flag `retain` est indispensable au jeu : c'est lui qui permet à un
        // retardataire de récupérer l'état en cours dès qu'il scanne le QR code.
        client.publish(sujet, JSON.stringify({ ping: t0 }), { qos: 0, retain: true });
        client.once('message', (sujetRecu, charge) => {
          clearTimeout(minuterie);
          let bon = false;
          try {
            bon = JSON.parse(charge.toString()).ping === t0;
          } catch (e) {
            /* charge illisible */
          }
          // On nettoie le message retenu de diagnostic derrière nous.
          client.publish(sujet, '', { qos: 0, retain: true });
          setTimeout(
            () =>
              terminer(
                bon,
                bon ? 'connexion ' + tConnect + ' ms' : 'écho incohérent',
                Date.now() - t0
              ),
            150
          );
        });
      });
    });

    client.on('error', (e) => {
      clearTimeout(minuterie);
      terminer(false, e.message);
    });
  });
}

(async () => {
  console.log('Diagnostic des brokers MQTT publics\n');
  const resultats = [];
  for (const b of BROKERS) resultats.push(await essayer(b));

  for (const r of resultats) {
    const etat = r.ok ? 'OK  ' : 'HS  ';
    const temps = r.ok ? String(r.ms).padStart(5) + ' ms' : '      -';
    console.log(`  ${etat} ${r.broker.label.padEnd(11)} ${temps}   ${r.broker.url}`);
    if (!r.ok) console.log(`       ↳ ${r.detail}`);
  }

  const vivants = resultats.filter((r) => r.ok);
  console.log('\n' + vivants.length + ' broker(s) sur ' + resultats.length + ' opérationnel(s).');

  if (!vivants.length) {
    console.error('\nAucun broker ne répond : la synchronisation temps réel est impossible.');
    process.exit(1);
  }
  if (!resultats[0].ok) {
    console.log(
      '\nAttention : le broker prioritaire est indisponible. L’application bascule\n' +
        'automatiquement sur le suivant, mais pensez à réordonner la liste dans\n' +
        'public/js/net.js si la situation dure.'
    );
  }
})();
