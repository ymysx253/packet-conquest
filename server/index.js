'use strict';
// パケット陣取り(Packet Conquest): HTTP で画面を配信し、WebSocket で永続ワールドを中継するサーバー。
// Azure App Service では PORT 環境変数が渡される。拠点は画面に見えている範囲だけ読み込む(設計書 第 13 章)。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { loadEnv } = require('./env');
loadEnv();
const { World } = require('./world');
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const world = new World({ store: createStore() });

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok players=${world.players.size} tiles=${world.tiles.size} nodes=${world.nodes.size}`);
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('見つかりません'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || 'プレイヤー';

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // 1 接続のメッセージは順番に処理する(view と ask が入れ違わないように)
  let chain = Promise.resolve();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    chain = chain.then(() => handle(ws, msg)).catch((e) => send(ws, { t: 'error', message: e.message || 'エラーが発生しました' }));
  });
  ws.on('close', () => {
    if (ws.player && ws.player.ws === ws) world.disconnect(ws.player).then(() => world.emitPlayers()).catch(() => {});
  });
});

async function handle(ws, msg) {
  if (msg.t === 'join') {
    const player = await world.join(ws, cleanName(msg.name), typeof msg.token === 'string' ? msg.token.trim() : null);
    ws.player = player;
    send(ws, world.welcome(player));
    await world.emitPlayers();
    return;
  }
  const { player } = ws;
  if (!player) throw new Error('先に参加してください');
  switch (msg.t) {
    case 'view': await world.setView(player, Array.isArray(msg.tiles) ? msg.tiles : [], msg.z); break;
    case 'ask': send(ws, await world.ask(player, String(msg.nodeId))); break;
    case 'answer': send(ws, await world.answer(player, String(msg.qid), Number(msg.choice))); break;
    default: break;
  }
}

// Azure のロードバランサーは無通信の接続を約 4 分で切るので、定期的に ping する。あわせて古いタイルを落とす
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  world.evict();
}, 25000);

world.init().then(() => {
  server.listen(PORT, () => console.log(`パケット陣取り / Packet Conquest: http://localhost:${PORT}`));
}).catch((e) => { console.error('起動に失敗:', e); process.exit(1); });
