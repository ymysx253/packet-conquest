'use strict';
// 永続ワールドの検証: シード、参加で拠点が生まれる、隣だけ攻撃できる、初心者保護、奪取、全滅時の再生成、復帰コード
const assert = require('assert');
const { World, PROTECT_MS } = require('../server/world');
const { MemoryStore } = require('../server/store');

const fakeWs = () => ({ readyState: 1, close() { this.readyState = 3; } });

// 正解がわからないので、サーバーの pending を読んで答える(テスト専用)
function solve(world, p, nodeId) {
  const q = world.ask(p, nodeId);
  const r = world.answer(p, q.qid, p.pending ? p.pending.answerIndex : -1);
  assert.ok(r.correct, 'テストは正解を選ぶ');
  return r;
}

(async () => {
  const store = new MemoryStore();
  const w = await new World({ store }).init();
  assert.strictEqual(w.nodes.size, require('../server/map/tokyo').NODES.length, 'シードで全拠点');
  assert.strictEqual(store.nodes.size, w.nodes.size, 'シードは保存される');

  // 参加: 自分の拠点が東京駅の近くに生まれ、近い2拠点とつながる
  const a = w.join(fakeWs(), 'あき', null);
  const home = w.nodes.get(a.homeNodeId);
  assert.ok(home && home.owner === a.id && home.isPlayerNode, '自分の拠点が生まれる');
  assert.strictEqual(w.adj[home.id].length, 2, '近い2拠点とつながる');
  assert.ok(home.protectedUntil > Date.now() + PROTECT_MS - 5000, '24時間の保護');
  assert.match(home.subnet, /^172\.16\.0\.0\/24$/);
  assert.ok(store.players.has(a.id) && store.nodes.has(home.id), 'プレイヤーと拠点が保存される');

  // 隣だけ攻撃できる
  const [nb] = w.adj[home.id];
  assert.ok(w.canAttack(a.id, nb), '隣の拠点は攻撃できる');
  assert.ok(!w.canAttack(a.id, 'haneda'), '離れた拠点は攻撃できない');
  assert.throws(() => w.ask(a, 'haneda'), /つながっている拠点だけ/);

  // 問題: 中立は拠点の Lv、答えはクライアントに送らない
  const q = w.ask(a, nb);
  assert.strictEqual(q.level, w.nodes.get(nb).level);
  assert.ok(!('answerIndex' in q) && q.options.length === 4);
  const wrong = w.answer(a, q.qid, (a.pending.answerIndex + 1) % 4);
  assert.ok(!wrong.correct && a.cooldownUntil > Date.now(), '不正解で待ち時間');
  a.cooldownUntil = 0;

  // 防御を削ってから奪取。点数が入る
  const target = w.nodes.get(nb);
  const need = target.defense + 1;
  for (let i = 0; i < need; i++) solve(w, a, nb);
  assert.strictEqual(target.owner, a.id, '奪取');
  assert.strictEqual(a.points, target.value, '累計点が増える');
  assert.strictEqual(w.score(a.id), home.value + target.value);

  // 初心者保護: 拠点が3つ以下の相手は攻撃できない。保護期間中の拠点も攻撃できない
  const b = w.join(fakeWs(), 'ベン', null);
  const bHome = w.nodes.get(b.homeNodeId);
  // 隣接させるため、b の拠点を a の拠点とつなげた形にする
  w.edges.push({ a: home.id, b: bHome.id }); w.adj[home.id].push(bHome.id); w.adj[bHome.id].push(home.id);
  assert.ok(!w.canAttack(a.id, bHome.id), '保護中は攻撃できない');
  assert.throws(() => w.ask(a, bHome.id), /守られています/);
  bHome.protectedUntil = 0;
  assert.ok(!w.canAttack(a.id, bHome.id), '拠点3つ以下の人は攻撃できない');
  // b が4拠点持てば攻撃できる
  for (const id of ['tokyo-dome', 'ueno', 'asakusa']) w.nodes.get(id).owner = b.id;
  assert.ok(w.canAttack(a.id, bHome.id), '拠点が4つ以上なら攻撃できる');

  // 4拠点以上なら奪える。奪われて3拠点以下になると再び守られる
  bHome.defense = 0;
  solve(w, a, bHome.id);
  assert.strictEqual(bHome.owner, a.id, '奪取できる');
  assert.strictEqual(w.ownedCount(b.id), 3);
  assert.ok(!w.canAttack(a.id, 'tokyo-dome') || !w.adj[home.id].includes('tokyo-dome'), '3拠点以下になった相手は守られる');

  // 全滅時の再生成(暫定): 拠点をすべて失った人は東京に新しい拠点をもらい、累計点などの記録は残る
  // ※ いまの初心者保護(3拠点以下は攻撃不可)では攻撃で全滅することはないが、仕組みは用意しておく
  for (const id of ['tokyo-dome', 'ueno', 'asakusa']) w.nodes.get(id).owner = null;
  b.points = 7;
  const before = w.nodes.size;
  w.respawn(b);
  assert.strictEqual(w.nodes.size, before + 1, '新しい拠点が生まれる');
  assert.ok(b.homeNodeId !== bHome.id && w.nodes.get(b.homeNodeId).owner === b.id, '再生成された拠点を持つ');
  assert.strictEqual(w.ownedCount(b.id), 1);
  assert.strictEqual(b.points, 7, '記録は残る');

  // 強化: 自分の拠点の防御を上げる。上限3
  home.defense = 2;
  solve(w, a, home.id);
  assert.strictEqual(home.defense, 3);
  assert.throws(() => w.ask(a, home.id), /最大/);

  // 復帰コード: 同じトークンで同じプレイヤーに戻る。切断中も拠点は残る
  w.disconnect(a);
  assert.ok(!a.online && w.nodes.get(home.id).owner === a.id);
  const a2 = w.join(fakeWs(), 'あき', a.token);
  assert.strictEqual(a2.id, a.id, '同じプレイヤー');
  assert.ok(a2.online);
  assert.strictEqual(w.join(fakeWs(), 'だれか', 'wrong-token').id === a.id, false, '違うコードは新規');

  // 再起動: 保存した内容から復元できる
  const w2 = await new World({ store }).init();
  assert.strictEqual(w2.nodes.size, w.nodes.size);
  assert.strictEqual(w2.players.size, w.players.size);
  assert.strictEqual(w2.nodes.get(nb).owner, a.id, '所有者が復元される');
  assert.ok(w2.players.get(a.id).points === a.points && !w2.players.get(a.id).online);

  // 配信内容に答えや復帰コードが含まれない
  const snap = JSON.stringify(w.snapshot());
  assert.ok(!snap.includes(a.token) && !snap.includes('answerIndex'));

  console.log(`world ok: ${w.nodes.size} nodes, ${w.players.size} players`);
})().catch((e) => { console.error(e); process.exit(1); });
