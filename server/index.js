'use strict';
// パケット陣取り(Packet Conquest): HTTP で画面を配信し、WebSocket で永続ワールドを中継するサーバー。
// Azure App Service では PORT 環境変数が渡される。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { World } = require('./world');
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const world = new World({ store: createStore() });

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok players=${world.players.size} nodes=${world.nodes.size}`);
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('見つかりません'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
let broadcastTimer = null;
// 変更が立て続いても配信は 1 回にまとめる
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const snap = JSON.stringify(world.snapshot());
    for (const ws of wss.clients) if (ws.readyState === 1 && ws.player) ws.send(snap);
  }, 30);
}
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || 'プレイヤー';

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(ws, msg); } catch (e) { send(ws, { t: 'error', message: e.message || 'エラーが発生しました' }); }
  });
  ws.on('close', () => {
    if (ws.player && ws.player.ws === ws) { world.disconnect(ws.player); broadcast(); }
  });
});

function handle(ws, msg) {
  if (msg.t === 'join') {
    const player = world.join(ws, cleanName(msg.name), typeof msg.token === 'string' ? msg.token.trim() : null);
    ws.player = player;
    send(ws, { t: 'welcome', id: player.id, token: player.token, name: player.name, home: player.homeNodeId });
    send(ws, world.snapshot());
    broadcast();
    return;
  }
  const { player } = ws;
  if (!player) throw new Error('先に参加してください');
  switch (msg.t) {
    case 'ask': send(ws, world.ask(player, String(msg.nodeId))); break;
    case 'answer': send(ws, world.answer(player, String(msg.qid), Number(msg.choice))); broadcast(); break;
    default: break;
  }
}

// Azure のロードバランサーは無通信の接続を約4分で切るので、定期的に ping する
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

world.init().then(() => {
  server.listen(PORT, () => console.log(`パケット陣取り / Packet Conquest: http://localhost:${PORT} (拠点 ${world.nodes.size})`));
}).catch((e) => { console.error('起動に失敗:', e); process.exit(1); });
