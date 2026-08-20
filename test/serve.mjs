/* Banc de test local : broker MQTT-over-WebSocket (aedes) + serveur statique.
   Sert exactement les fichiers de docs/ et parle le même protocole que les
   brokers publics, pour tester le vrai code client. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { Aedes } from 'aedes';

const HTTP_PORT = Number(process.env.HTTP_PORT || 8787);
const MQTT_PORT = Number(process.env.MQTT_PORT || 9001);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(HTTP_PORT, () => console.log('http  → http://127.0.0.1:' + HTTP_PORT));

const aedes = await Aedes.createBroker();
const brokerHttp = http.createServer();
const wss = new WebSocketServer({ server: brokerHttp, handleProtocols: () => 'mqtt' });
wss.on('connection', (conn, req) => aedes.handle(createWebSocketStream(conn), req));
if (process.env.MQTT_VERBOSE) {
  aedes.on('client', c => console.log('  + client', c.id));
  aedes.on('clientDisconnect', c => console.log('  - client', c.id));
  aedes.on('publish', (pkt, c) => { if (c) console.log('  →', pkt.topic, String(pkt.payload).slice(0, 90)); });
}
brokerHttp.listen(MQTT_PORT, () => console.log('mqtt  → ws://127.0.0.1:' + MQTT_PORT));
