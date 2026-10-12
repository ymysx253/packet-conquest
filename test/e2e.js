'use strict';
// 実サーバーに2人で接続し、開始→出題→解答→状態更新まで通す
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 3000) + '/ws';
const client = (name) => new Promise((res) => {
  const ws = new WebSocket(URL); const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d)));
  ws.on('open', () => res({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)), name }));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (c, t) => [...c.inbox].reverse().find((m) => m.t === t);
(async () => {
  const a = await client('A'), b = await client('B');
  a.send({ t: 'join', room: 'TEST1', name: 'あき' }); await wait(150);
  b.send({ t: 'join', room: 'test1', name: 'ベン' }); await wait(150);
  const wa = last(a, 'welcome'); console.log('welcome nodes:', wa.map.nodes.length, 'edges:', wa.map.edges.length);
  b.send({ t: 'start' }); await wait(100); console.log('non-host start ->', last(b, 'error').message);
  a.send({ t: 'addBot' }); await wait(100);
  a.send({ t: 'start' }); await wait(150);
  let st = last(a, 'state'); console.log('phase', st.phase, 'players', st.players.map((p) => `${p.name}:${p.score}`).join(' '));
  const mine = st.nodes.find((n) => n.owner === wa.id); console.log('A start node', mine.id);
  // 隣でない拠点を攻撃 → エラー
  a.send({ t: 'ask', nodeId: 'singapore' }); await wait(100); console.log('far attack ->', last(a, 'error').message);
  // 隣(仙台)を攻撃して正解するまで(サーバーが答えを持つので総当たりで検証)
  let captured = false;
  for (let tries = 0; tries < 12 && !captured; tries++) {
    a.inbox.length = 0;
    a.send({ t: 'ask', nodeId: 'sendai' }); await wait(80);
    const q = last(a, 'question');
    if (!q) { await wait(4100); continue; }
    a.send({ t: 'answer', qid: q.qid, choice: tries % 4 }); await wait(100);
    const r = last(a, 'result'); console.log(' ', q.text, '->', r.correct ? '正解' : '不正解', '|', r.outcome);
    st = last(a, 'state'); captured = st.nodes.find((n) => n.id === 'sendai').owner === wa.id;
    if (!r.correct) await wait(4100);
  }
  console.log('captured sendai:', captured, 'score', st.players.find((p) => p.id === wa.id).score);
  // 再接続でトークン復帰
  const tok = wa.token; b.ws.close(); a.ws.close(); await wait(150);
  const a2 = await client('A2'); a2.send({ t: 'join', room: 'TEST1', name: 'あき', token: tok }); await wait(150);
  console.log('rejoin same id:', last(a2, 'welcome').id === wa.id);
  a2.ws.close(); process.exit(0);
})();
