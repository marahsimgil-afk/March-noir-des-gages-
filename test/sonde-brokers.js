/* Sonde les brokers MQTT publics utilisés par l'application et vérifie, pour
   chacun : connexion, publication en "retained", abonnement, réception.
   C'est ce test qui dit si la liste de brokers de app.js tient encore la route.

     node test/sonde-brokers.js
*/
'use strict';

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

/* On lit la liste directement dans app.js : impossible qu'elle diverge. */
function brokersDeLApp() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');
  const bloc = src.slice(src.indexOf('var BROKERS = ['), src.indexOf('];', src.indexOf('var BROKERS = [')));
  const out = [];
  const re = /\{\s*id:\s*'([A-Z])'\s*,\s*nom:\s*'([^']+)'\s*,\s*url:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = re.exec(bloc))) out.push({ id: m[1], nom: m[2], url: m[3] });
  return out;
}

const DELAI = 20000;

function sonder(b) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sujet = 'mng/sonde/' + Math.random().toString(36).slice(2, 10);
    const resultat = { ...b, connexion: false, retained: false, msAller: null, erreur: null };
    let client;
    let fini = false;

    const terminer = (err) => {
      if (fini) return;
      fini = true;
      if (err) resultat.erreur = err;
      try { client && client.end(true); } catch (e) {}
      resolve(resultat);
    };

    const minuteur = setTimeout(() => terminer('délai dépassé (' + DELAI + ' ms)'), DELAI);

    try {
      client = mqtt.connect(b.url, {
        clientId: 'mng_sonde_' + Math.random().toString(16).slice(2, 10),
        clean: true, protocolVersion: 4, keepalive: 20,
        reconnectPeriod: 0, connectTimeout: DELAI - 2000
      });
    } catch (e) { clearTimeout(minuteur); return terminer(e.message); }

    client.on('connect', () => {
      resultat.connexion = true;
      // On publie AVANT de s'abonner : seul un vrai "retained" fera arriver le message.
      client.publish(sujet, JSON.stringify({ t: t0 }), { qos: 1, retain: true }, () => {
        client.subscribe(sujet, { qos: 1 });
      });
    });

    client.on('message', (topic, payload) => {
      try {
        const obj = JSON.parse(payload.toString());
        if (obj.t === t0) {
          resultat.retained = true;
          resultat.msAller = Date.now() - t0;
          // On nettoie le message retenu derrière nous.
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
  const brokers = brokersDeLApp();
  console.log(`Sonde de ${brokers.length} brokers publics déclarés dans app.js\n`);
  const res = [];
  for (const b of brokers) {
    process.stdout.write(`  ${b.id} · ${b.nom.padEnd(11)} ${b.url}\n`);
    const r = await sonder(b);
    res.push(r);
    if (r.retained) console.log(`      ✓ connexion + retained OK (${r.msAller} ms)\n`);
    else if (r.connexion) console.log(`      ~ connecté mais "retained" non confirmé — ${r.erreur || 'silence'}\n`);
    else console.log(`      ✗ injoignable — ${r.erreur}\n`);
  }

  const bons = res.filter((r) => r.retained);
  console.log('---');
  console.log(`${bons.length}/${res.length} brokers pleinement fonctionnels : ${bons.map((b) => b.id + '=' + b.nom).join(', ') || 'aucun'}`);
  console.log('JSON_RESULTAT=' + JSON.stringify(res));

  // Un seul broker valide suffit à faire tourner la soirée, mais on veut du rab.
  process.exit(bons.length >= 1 ? 0 : 1);
})();
