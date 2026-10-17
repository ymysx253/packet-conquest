'use strict';
// 実サーバーに 2 人で接続し、参加 → 範囲の読み込み → 出題 → 解答 → 差分 → 復帰コードで戻る、まで通す
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 3000) + '/ws';
const client = (name) => new Promise((res) => {
  const ws = new WebSocket(URL); const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d)));
  ws.on('open', () => res({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)), name }));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (c, t) => [...c.inbox].reverse().find((m) => m.t === t);
const TILE_LAT = 0.025, TILE_LON = 0.03;
const tilesAround = (lat, lon) => { const y = Math.floor(lat / TILE_LAT), x = Math.floor(lon / TILE_LON); const out = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(`t0:${y + dy}:${x + dx}`); return out; };
(async () => {
  const a = await client('A'), b = await client('B');
  a.send({ t: 'join', name: 'あき' }); await wait(200);
  b.send({ t: 'join', name: 'ベン' }); await wait(200);
  const wa = last(a, 'welcome');
  console.log('welcome home:', wa.home && wa.home.id, '| players:', (last(a, 'players') || { players: [] }).players.map((p) => `${p.name}:${p.score}`).join(' '));
  // 見ている範囲を送って、拠点とリンクを受け取る
  a.send({ t: 'view', z: 0, tiles: tilesAround(wa.home.lat, wa.home.lon) }); await wait(300);
  const tiles = last(a, 'tiles');
  console.log('tiles:', tiles.added.length, '| nodes:', tiles.nodes.length, '| edges:', tiles.edges.length);
  const home = tiles.nodes.find((n) => n.id === wa.home.id);
  console.log('home owner is me:', home.owner === wa.id, '| protected:', home.protectedUntil > Date.now());
  const neighbors = tiles.edges.filter((e) => e.a === wa.home.id || e.b === wa.home.id).map((e) => (e.a === wa.home.id ? e.b : e.a));
  console.log('home links:', neighbors.map((id) => (tiles.nodes.find((n) => n.id === id) || {}).name).join(', '));
  // 隣でない拠点を攻撃 → エラー
  const far = tiles.nodes.find((n) => !n.isPlayerNode && !neighbors.includes(n.id) && n.hackable);
  a.send({ t: 'ask', nodeId: far.id }); await wait(150); console.log('far attack ->', last(a, 'error').message);
  // 隣の拠点を攻撃して獲得するまで(サーバーが答えを持つので総当たりで検証)
  const target = neighbors[0];
  let captured = false;
  for (let tries = 0; tries < 16 && !captured; tries++) {
    a.inbox.length = 0;
    a.send({ t: 'ask', nodeId: target }); await wait(120);
    const q = last(a, 'question');
    if (!q) { await wait(4100); continue; }
    a.send({ t: 'answer', qid: q.qid, choice: tries % 4 }); await wait(200);
    const r = last(a, 'result'); console.log(`  Lv${q.level}`, q.text.split('\n')[0], '->', r.correct ? '正解' : '不正解', '|', r.outcome);
    const diff = last(a, 'nodes');
    captured = !!(diff && diff.nodes.some((n) => n.id === target && n.owner === wa.id));
    if (!r.correct) await wait(4100);
  }
  const me = (last(a, 'players') || { players: [] }).players.find((p) => p.id === wa.id) || {};
  console.log('captured:', captured, '| score', me.score, '| points', me.points, '| nodes', me.nodes);
  // 復帰コードで同じプレイヤーに戻る
  const tok = wa.token; a.ws.close(); await wait(200);
  const a2 = await client('A2'); a2.send({ t: 'join', name: 'あき', token: tok }); await wait(200);
  const w2 = last(a2, 'welcome');
  console.log('rejoin same id:', w2.id === wa.id);
  a2.ws.close(); b.ws.close(); process.exit(0);
})();
