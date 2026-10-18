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
const { RateLimiter, clientIp } = require('./limits');

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
const limiter = new RateLimiter(); // 接続元ごとの新規作成・復帰の回数制限(SECURITY.md F2)
// F1: WebSocket の Origin 検査。ブラウザからの接続は Origin が自サイト(同じ Host)か ALLOWED_ORIGINS(カンマ区切り)のものだけ通す。
// Origin が無い接続(ブラウザ以外)は通す(なりすましは防げないが、別サイトのページから被害者のブラウザ経由でつながる経路は塞げる)
const ALLOWED_ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  if (ALLOWED_ORIGINS.has(origin.toLowerCase())) return true;
  const reqHost = String(req.headers.host || '').toLowerCase();
  return !!reqHost && host === reqHost;
}
// F3: 1 接続あたりのメッセージ数の上限(1 秒に 20 まで。超えたら切断)と、種別ごとの形の検査
const MSG_PER_SEC = 20;
const MSG_TYPES = new Set(['join', 'view', 'ask', 'answer', 'search', 'rekey', 'move', 'team']);
// F5: セキュリティヘッダ。スクリプトは自サイトのファイルだけ(インラインは禁止)、スタイルとフォントは Google Fonts を許可
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // HTTPS で来たとき(Azure の前段が X-Forwarded-Proto を付ける)は HSTS も返す
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    return res.end(`ok players=${world.players.size} tiles=${world.tiles.size} nodes=${world.nodes.size}`);
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }); return res.end('見つかりません'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }); return res.end('見つかりません'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 16384,
  verifyClient: ({ req }, done) => (originAllowed(req) ? done(true) : done(false, 403, 'Forbidden origin')),
});
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || 'プレイヤー';

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ip = clientIp(req);
  ws.on('pong', () => { ws.isAlive = true; });
  // 1 接続のメッセージは順番に処理する(view と ask が入れ違わないように)
  let chain = Promise.resolve();
  // F3: 1 秒あたりのメッセージ数(トークン バケット)。超えたら切る
  let tokens = MSG_PER_SEC, lastRefill = Date.now();
  ws.on('message', (raw) => {
    const t = Date.now();
    tokens = Math.min(MSG_PER_SEC, tokens + ((t - lastRefill) / 1000) * MSG_PER_SEC); lastRefill = t;
    if (tokens < 1) { try { ws.close(1008, 'too many messages'); } catch { /* 閉じるだけ */ } return; }
    tokens -= 1;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !MSG_TYPES.has(msg.t)) return;
    chain = chain.then(() => handle(ws, msg)).catch((e) => send(ws, { t: 'error', message: e.message || 'エラーが発生しました' }));
  });
  ws.on('close', () => {
    if (ws.player && ws.player.ws === ws) world.disconnect(ws.player).then(() => world.emitPlayers()).catch(() => {});
  });
});

async function handle(ws, msg) {
  // 参加前でも使えるもの: 開始地点の検索と、地図から選ぶための範囲の読み込み
  if (msg.t === 'search') {
    const q = typeof msg.q === 'string' ? msg.q : '';
    send(ws, { t: 'search', q, results: await world.search('japan', q) });
    return;
  }
  if (msg.t === 'view' && !ws.player) {
    await world.setView(world.guest(ws), Array.isArray(msg.tiles) ? msg.tiles.slice(0, 120).filter((x) => typeof x === 'string' && x.length <= 24) : [], msg.z);
    return;
  }
  if (msg.t === 'join') {
    if (ws.player) throw new Error('この接続はすでに参加しています');
    const token = typeof msg.token === 'string' && msg.token.trim() ? msg.token.trim() : null;
    // 接続元ごとの回数制限: 復帰の試行は 1 分 5 回、新規作成は 1 時間 3 回・1 日 10 回
    const over = limiter.take(token ? 'resume' : 'create', ws.ip);
    if (over) throw new Error(over);
    const player = await world.join(ws, cleanName(msg.name), token,
      typeof msg.startNodeId === 'string' && msg.startNodeId ? msg.startNodeId.slice(0, 40) : null);
    ws.player = player;
    send(ws, world.welcome(player));
    await world.emitPlayers();
    return;
  }
  const { player } = ws;
  if (!player) throw new Error('先に参加してください');
  switch (msg.t) {
    case 'rekey': send(ws, { t: 'rekey', token: await world.rekey(player) }); break;
    case 'team': {
      if (msg.action === 'create') { const t = await world.createTeam(player, msg.name, msg.max); send(ws, { t: 'team', team: world.pubTeam(t) }); }
      else if (msg.action === 'join') { const t = await world.joinTeam(player, msg.teamId); send(ws, { t: 'team', team: world.pubTeam(t) }); }
      else if (msg.action === 'leave') { await world.leaveTeam(player); send(ws, { t: 'team', team: null }); }
      else if (msg.action === 'style') { const t = await world.styleTeam(player, { frame: msg.frame, fill: msg.fill, text: msg.text, icon: msg.icon }); send(ws, { t: 'team', team: world.pubTeam(t) }); }
      else if (msg.action === 'info') { const t = player.team ? await world.teamInfo(player.team) : null; send(ws, { t: 'team', team: world.pubTeam(t) }); }
      break;
    }
    case 'move': {
      const home = await world.move(player, typeof msg.startNodeId === 'string' ? msg.startNodeId.slice(0, 40) : null);
      send(ws, { t: 'moved', home: { id: home.id, lat: home.lat, lon: home.lon }, startNodeId: player.startNodeId, movedAt: player.movedAt });
      break;
    }
    case 'view': await world.setView(player, Array.isArray(msg.tiles) ? msg.tiles.slice(0, 120).filter((x) => typeof x === 'string' && x.length <= 24) : [], msg.z); break;
    case 'ask': if (typeof msg.nodeId !== 'string' || msg.nodeId.length > 40) return; send(ws, await world.ask(player, msg.nodeId)); break;
    case 'answer': {
      if (typeof msg.qid !== 'string' || msg.qid.length > 40 || !Number.isInteger(msg.choice) || msg.choice < 0 || msg.choice > 3) return;
      send(ws, await world.answer(player, msg.qid, msg.choice)); break;
    }
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
// 稼働時計は 1 分ごとに進める(止まっていた時間は数えない)。休眠アカウントの回収は 1 時間ごと(起動時にも 1 回)
setInterval(() => { world.tick().catch(() => {}); }, 60 * 1000);
setInterval(() => { limiter.sweep(); world.reclaimIdle().catch((e) => console.error('休眠の回収に失敗:', e.message)); }, 60 * 60 * 1000);

world.init().then(async () => {
  const n = await world.reclaimIdle().catch((e) => { console.error('休眠の回収に失敗:', e.message); return 0; });
  if (n) console.log(`休眠アカウントを ${n} 件回収`);
  server.listen(PORT, () => console.log(`パケット陣取り / Packet Conquest: http://localhost:${PORT}(保存: ${process.env.STORE !== 'memory' && process.env.COSMOS_CONNECTION_STRING ? 'Cosmos DB ' + (process.env.COSMOS_DATABASE || 'packet-conquest') : 'メモリ'})`));
}).catch((e) => { console.error('起動に失敗:', e); process.exit(1); });
