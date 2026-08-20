/* Sonde une liste élargie de brokers MQTT publics, pour décider lesquels
   méritent d'entrer dans la liste de secours de app.js.
   Ne fait échouer personne : c'est un outil de décision, pas un test.

     node test/sonde-candidats.js
*/
'use strict';

const mqtt = require('mqtt');

const CANDIDATS = [
  ['EMQX',            'wss://broker.emqx.io:8084/mqtt'],
  ['HiveMQ',          'wss://broker.hivemq.com:8884/mqtt'],
  ['Mosquitto /mqtt', 'wss://test.mosquitto.org:8081/mqtt'],
  ['Mosquitto /',     'wss://test.mosquitto.org:8081/'],
  ['Mosquitto 8091',  'wss://test.mosquitto.org:8091/mqtt'],
  ['Eclipse /mqtt',   'wss://mqtt.eclipseprojects.io:443/mqtt'],
  ['Eclipse /ws',     'wss://mqtt.eclipseprojects.io:443/ws'],
  ['EMQX v5',         'wss://broker-cn.emqx.io:8084/mqtt'],
  ['Mqtt Dashboard',  'wss://mqtt-dashboard.com:8884/mqtt'],
  ['HiveMQ /ws',      'wss://broker.hivemq.com:8884/ws']
];

const DELAI = 15000;

function sonder([nom, url]) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sujet = 'mng/candidat/' + Math.random().toString(36).slice(2, 10);
    let client, fini = false;
    const res = { nom, url, connexion: false, retained: false, ms: null, erreur: null };

    const terminer = (err) => {
      if (fini) return;
      fini = true;
      if (err) res.erreur = err;
      try { client && client.end(true); } catch (e) {}
      resolve(res);
    };
    const minuteur = setTimeout(() => terminer('délai dépassé'), DELAI);

    try {
      client = mqtt.connect(url, {
        clientId: 'mng_c_' + Math.random().toString(16).slice(2, 10),
        clean: true, protocolVersion: 4, keepalive: 20,
        reconnectPeriod: 0, connectTimeout: DELAI - 2000
      });
    } catch (e) { clearTimeout(minuteur); return terminer(e.message); }

    client.on('connect', () => {
      res.connexion = true;
      client.publish(sujet, JSON.stringify({ t: t0 }), { qos: 1, retain: true }, () => {
        client.subscribe(sujet, { qos: 1 });
      });
    });
    client.on('message', (topic, payload) => {
      try {
        if (JSON.parse(payload.toString()).t === t0) {
          res.retained = true;
          res.ms = Date.now() - t0;
          client.publish(sujet, '', { qos: 0, retain: true });
          clearTimeout(minuteur);
          setTimeout(() => terminer(null), 150);
        }
      } catch (e) {}
    });
    client.on('error', (e) => { clearTimeout(minuteur); terminer(e.message); });
  });
}

(async () => {
  const res = [];
  for (const c of CANDIDATS) {
    const r = await sonder(c);
    res.push(r);
    const etat = r.retained ? `✓ OK (${r.ms} ms)`
      : r.connexion ? `~ connecté, pas de retained — ${r.erreur || 'silence'}`
      : `✗ ${r.erreur}`;
    console.log(`  ${r.nom.padEnd(18)} ${r.url.padEnd(46)} ${etat}`);
  }
  console.log('\nRetenables : ' + (res.filter((r) => r.retained).map((r) => r.nom).join(', ') || 'aucun'));
})();
