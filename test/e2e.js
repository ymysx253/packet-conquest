'use strict';
// 実サーバーに2人で接続し、参加→拠点が生まれる→出題→解答→状態更新→復帰コードで戻る、まで通す
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
  a.send({ t: 'join', name: 'あき' }); await wait(150);
  b.send({ t: 'join', name: 'ベン' }); await wait(150);
  const wa = last(a, 'welcome');
  let st = last(a, 'state');
  console.log('welcome home:', wa.home, '| nodes:', st.nodes.length, 'edges:', st.edges.length, 'players:', st.players.map((p) => `${p.name}:${p.score}`).join(' '));
  const home = st.nodes.find((n) => n.id === wa.home);
  console.log('home owner is me:', home.owner === wa.id, '| protected:', home.protectedUntil > st.now);
  const neighbors = st.edges.filter((e) => e.a === wa.home || e.b === wa.home).map((e) => (e.a === wa.home ? e.b : e.a));
  console.log('home links:', neighbors.map((id) => st.nodes.find((n) => n.id === id).name).join(', '));
  // 離れた拠点を攻撃 → エラー
  a.send({ t: 'ask', nodeId: 'haneda' }); await wait(100); console.log('far attack ->', last(a, 'error').message);
  // 隣の拠点を攻撃して獲得するまで(サーバーが答えを持つので総当たりで検証)
  const target = neighbors[0];
  let captured = false;
  for (let tries = 0; tries < 16 && !captured; tries++) {
    a.inbox.length = 0;
    a.send({ t: 'ask', nodeId: target }); await wait(80);
    const q = last(a, 'question');
    if (!q) { await wait(4100); continue; }
    a.send({ t: 'answer', qid: q.qid, choice: tries % 4 }); await wait(120);
    const r = last(a, 'result'); console.log(`  Lv${q.level}`, q.text, '->', r.correct ? '正解' : '不正解', '|', r.outcome);
    st = last(a, 'state') || st; captured = st.nodes.find((n) => n.id === target).owner === wa.id;
    if (!r.correct) await wait(4100);
  }
  console.log('captured:', captured, '| score', st.players.find((p) => p.id === wa.id).score, '| points', st.players.find((p) => p.id === wa.id).points);
  // 復帰コードで同じプレイヤーに戻る。切断中も拠点は残る
  const tok = wa.token; a.ws.close(); await wait(150);
  const a2 = await client('A2'); a2.send({ t: 'join', name: 'あき', token: tok }); await wait(150);
  const w2 = last(a2, 'welcome'); const st2 = last(a2, 'state');
  console.log('rejoin same id:', w2.id === wa.id, '| still owns', st2.nodes.filter((n) => n.owner === wa.id).length, 'nodes');
  a2.ws.close(); b.ws.close(); process.exit(0);
})();
