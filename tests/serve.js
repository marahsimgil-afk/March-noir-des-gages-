/*
 * Bac à sable local : sert le site statique et fait tourner un vrai broker MQTT
 * sur WebSocket. Les tests exercent ainsi exactement le même chemin de code que
 * la production — seule l'adresse du broker change (paramètre ?ws=).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Aedes } = require('aedes');
const WebSocket = require('ws');

const RACINE = path.join(__dirname, '..', 'public');
const PORT_HTTP = Number(process.env.PORT_HTTP || 8080);
const PORT_MQTT = Number(process.env.PORT_MQTT || 9001);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const serveurStatique = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  let rel = url === '/' ? '/index.html' : url;
  const cible = path.join(RACINE, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!cible.startsWith(RACINE)) {
    res.writeHead(403).end('Interdit');
    return;
  }
  fs.readFile(cible, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Introuvable');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(cible)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

// Broker MQTT exposé en WebSocket. Le câblage est fait à la main plutôt qu'avec
// aedes-server-factory, pour pouvoir négocier le sous-protocole « mqtt » : sans
// lui, les navigateurs refusent la connexion WebSocket.
const serveurMqtt = http.createServer();
let aedes;

const arreter = () => {
  serveurStatique.close();
  serveurMqtt.close();
  if (aedes) aedes.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGTERM', arreter);
process.on('SIGINT', arreter);

Aedes.createBroker().then((broker) => {
  aedes = broker;
  const ws = new WebSocket.Server({
    server: serveurMqtt,
    handleProtocols: (protocoles) =>
      protocoles.has('mqtt') ? 'mqtt' : protocoles.values().next().value || false,
  });
  ws.on('connection', (conn) => {
    const stream = WebSocket.createWebSocketStream(conn);
    stream.on('error', () => {});
    aedes.handle(stream, { connDetails: {} });
  });

  serveurStatique.listen(PORT_HTTP, () => {
    serveurMqtt.listen(PORT_MQTT, () => {
      console.log(`static  http://localhost:${PORT_HTTP}`);
      console.log(`mqtt-ws ws://localhost:${PORT_MQTT}`);
      console.log('PRÊT');
    });
  });
});
