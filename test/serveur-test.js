/* Bac à sable pour les tests : un broker MQTT local (WebSocket) + un serveur
   statique qui sert l'application. Aucun accès Internet requis.

   Usage : node test/serveur-test.js [portHttp] [portMqtt]
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const Aedes = require('aedes');
const { createServer } = require('aedes-server-factory');

const PORT_HTTP = Number(process.argv[2] || 9100);
const PORT_MQTT = Number(process.argv[3] || 9101);
const RACINE = path.resolve(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

const serveurHttp = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const fichier = path.join(RACINE, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!fichier.startsWith(RACINE)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fichier, (err, data) => {
    if (err) { res.writeHead(404); res.end('introuvable'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(fichier)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

const broker = new Aedes();
const serveurMqtt = createServer(broker, { ws: true });

// Le port 0 laisse le système choisir : deux exécutions ne peuvent pas se
// gêner, et un serveur oublié d'un run précédent ne bloque plus rien.
serveurHttp.listen(PORT_HTTP, '127.0.0.1', () => {
  serveurMqtt.listen(PORT_MQTT, '127.0.0.1', () => {
    const http = serveurHttp.address().port;
    const mqttp = serveurMqtt.address().port;
    console.log(`http  : http://127.0.0.1:${http}/`);
    console.log(`mqtt  : ws://127.0.0.1:${mqttp}/mqtt`);
    console.log(`PRET http=${http} mqtt=${mqttp}`);
  });
});

process.on('SIGTERM', () => process.exit(0));
