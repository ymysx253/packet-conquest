'use strict';
// パケット陣取り(Packet Conquest): HTTP で画面を配信し、WebSocket で対戦を中継するサーバー。
// Azure App Service では PORT 環境変数が渡される。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');
const { NODES, EDGES, WIDTH, HEIGHT } = require('./map/japan');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_ROOMS = 300;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const rooms = new Map();
const MAP_PAYLOAD = {
  width: WIDTH, height: HEIGHT, edges: EDGES,
  nodes: NODES.map(({ id, name, kind, x, y, value, subnet }) => ({ id, name, kind, x, y, value, subnet })),
};

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok rooms=${rooms.size}`);
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
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
const broadcast = (room) => {
  const snap = JSON.stringify(room.snapshot());
  for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(snap);
};
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || 'プレイヤー';

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (e) {
      send(ws, { t: 'error', message: e.message || 'エラーが発生しました' });
    }
  });

  ws.on('close', () => {
    if (ws.room && ws.player) {
      ws.room.disconnect(ws.player);
      broadcast(ws.room);
    }
  });
});

function handle(ws, msg) {
  if (msg.t === 'join') {
    const code = String(msg.room || '').toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(code)) throw new Error('部屋コードは英数字4〜6文字です');
    let room = rooms.get(code);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) throw new Error('サーバーが混み合っています。しばらくしてから試してください');
      room = new Room(code);
      rooms.set(code, room);
    }
    const player = room.join(ws, cleanName(msg.name), typeof msg.token === 'string' ? msg.token : null);
    ws.room = room; ws.player = player;
    send(ws, { t: 'welcome', id: player.id, token: player.token, room: code, map: MAP_PAYLOAD });
    broadcast(room);
    return;
  }
  const { room, player } = ws;
  if (!room || !player) throw new Error('先に部屋に参加してください');
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'start': room.start(player); broadcast(room); break;
    case 'addBot': room.addBot(player); broadcast(room); break;
    case 'ask': send(ws, room.ask(player, String(msg.nodeId))); break;
    case 'answer': {
      const result = room.answer(player, String(msg.qid), Number(msg.choice));
      send(ws, result);
      broadcast(room);
      break;
    }
    default: break;
  }
}

// ---------- 定期処理 ----------
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.tick(now)) broadcast(room);
    if (!room.humansOnline() && now - room.lastActive > 5 * 60 * 1000) rooms.delete(code);
  }
}, 1000);

// Azure のロードバランサーは無通信の接続を約4分で切るので、定期的に ping する
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`パケット陣取り / Packet Conquest: http://localhost:${PORT}`));
