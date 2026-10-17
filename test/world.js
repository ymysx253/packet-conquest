'use strict';
// 永続ワールドの検証(タイル方式): シード、範囲の読み込み、参加で拠点が生まれる、隣だけ攻撃できる、初心者保護、
// 回数制の奪取(回数 = つながりの本数)、強化とその減衰、地域の支配(3/4)、集計値、復帰コード、再起動後の復元、配信に答えが含まれないこと
const assert = require('assert');
const { World, PROTECT_MS, DECAY_MS } = require('../server/world');
const { MemoryStore } = require('../server/store');
const { tilesAround, tileOf } = require('../server/map/geo');
const { NODES } = require('../server/map/tokyo');

const fakeWs = () => { const ws = { readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() { this.readyState = 3; } }; return ws; };
const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);

// 正解がわからないので、サーバーの pending を読んで答える(テスト専用)
async function solve(world, p, nodeId) {
  const q = await world.ask(p, nodeId);
  const r = await world.answer(p, q.qid, p.pending ? p.pending.answerIndex : -1);
  assert.ok(r.correct, 'テストは正解を選ぶ');
  return r;
}

(async () => {
  const store = new MemoryStore();
  const w = await new World({ store }).init();
  assert.strictEqual(await store.countNodes(), NODES.length, 'シードで全拠点が保存される');
  assert.strictEqual(w.nodes.size, 0, '起動時にはまとめて読まない');

  // 参加: 自分の拠点が東京駅の近くに生まれ、近い 2 拠点とつながる。周辺のタイルだけ読まれる
  const wsA = fakeWs();
  const a = await w.join(wsA, 'あき', null);
  const home = w.nodes.get(a.homeNodeId);
  assert.ok(home && home.owner === a.id && home.isPlayerNode, '自分の拠点が生まれる');
  assert.strictEqual((w.adj.get(home.id) || new Set()).size, 2, '近い 2 拠点とつながる');
  assert.ok(home.protectedUntil > Date.now() + PROTECT_MS - 5000, '24 時間の保護');
  assert.ok(w.nodes.size > 0 && w.nodes.size < NODES.length, '周辺だけ読み込む');
  assert.strictEqual(a.nodesOwned, 1); assert.strictEqual(a.score, 1);
  assert.ok(store.players.has(a.id) && store.nodes.has(home.id), 'プレイヤーと拠点が保存される');

  // 見ている範囲: タイルを送ると、その拠点とリンクが届く
  const view = tilesAround(home.t0, 1);
  await w.setView(a, view, 0);
  const tiles = last(wsA, 'tiles');
  assert.ok(tiles && tiles.added.length === 9 && tiles.nodes.length > 0 && tiles.edges.length > 0, 'タイルの拠点とリンクが届く');
  assert.ok(tiles.nodes.some((n) => n.id === home.id), '自分の拠点が含まれる');
  const js = JSON.stringify(tiles);
  assert.ok(!js.includes(a.token) && !js.includes('answerIndex') && !js.includes('"base"'), '配信に秘密が含まれない');
  // 同じ範囲をもう一度送っても追加はない。範囲を外すと dropped
  await w.setView(a, view, 0);
  assert.strictEqual(last(wsA, 'tiles').added.length, 0);
  await w.setView(a, view.slice(0, 1), 0);
  assert.strictEqual(last(wsA, 'tiles').dropped.length, 8);
  await w.setView(a, view, 0);

  // 広域表示: 粗いタイルで高いレベルだけ
  await w.setView(a, [tileOf(home.lat, home.lon, 2)], 2);
  const ov = last(wsA, 'tiles');
  assert.ok(ov.overview && ov.minLevel === 4 && ov.nodes.every((n) => n.level >= 4), '広域は Lv4 以上だけ');
  assert.ok(Array.isArray(ov.regions) && ov.regions.length > 0 && ov.regions.every((g) => g.tier === 6 && typeof g.lat === 'number'), '広域には区・市の支配状況が付く');
  assert.ok(ov.regions.some((g) => g.name === '千代田区') && ov.regions.every((g) => g.controller === null), 'まだ誰も支配していない');
  await w.setView(a, view, 0);

  // 隣だけ攻撃できる
  const [nb] = [...w.adj.get(home.id)];
  assert.ok(await w.canAttack(a.id, nb), '隣の拠点は攻撃できる');
  const far = [...w.nodes.values()].find((n) => !n.isPlayerNode && !(w.adj.get(home.id).has(n.id)) && n.hackable !== false);
  assert.ok(!(await w.canAttack(a.id, far.id)), '隣でない拠点は攻撃できない');
  await assert.rejects(() => w.ask(a, far.id), /つながっている拠点だけ/);
  await assert.rejects(() => w.ask(a, 'st-nope'), /表示されていません/);

  // 問題: 中立は拠点の Lv、答えはクライアントに送らない。同じ拠点では引き直せない
  const q = await w.ask(a, nb);
  assert.strictEqual(q.level, w.nodes.get(nb).level);
  assert.ok(!('answerIndex' in q) && q.options.length === 4);
  assert.strictEqual((await w.ask(a, nb)).qid, q.qid, '同じ拠点では問題が変わらない');
  const wrong = await w.answer(a, q.qid, (a.pending.answerIndex + 1) % 4);
  assert.ok(!wrong.correct && a.cooldownUntil > Date.now(), '不正解で待ち時間');
  a.cooldownUntil = 0;

  // 回数制: つながりの本数(hits)だけ正解すると奪取。途中は侵入の進捗が配信される。集計値が増え、見ている人に差分が届く
  const target = w.nodes.get(nb);
  assert.strictEqual(target.hits, target.adj.length, '必要回数 = つながりの本数');
  assert.ok(q.options && target.hits >= 1);
  const before = wsA.sent.length;
  for (let i = 1; i < target.hits; i++) {
    const r = await solve(w, a, nb);
    assert.match(r.outcome, /あと/); assert.strictEqual(target.owner, null, '回数に達するまで奪えない');
    assert.strictEqual(target.progress[a.id], i, '自分の回数が進む');
    const d = [...wsA.sent].reverse().find((m) => m.t === 'nodes');
    assert.strictEqual(d.nodes[0].progress[a.id], i, '進捗が配信される');
  }
  await solve(w, a, nb);
  assert.strictEqual(target.owner, a.id, 'つながりの本数ぶん正解して奪取');
  assert.deepStrictEqual(target.progress, {}, '奪取で進捗は消える');
  assert.ok(target.fortifiedAt > 0);
  assert.strictEqual(a.nodesOwned, 2); assert.strictEqual(a.points, target.value); assert.strictEqual(a.score, 1 + target.value);
  const diff = [...wsA.sent.slice(before)].reverse().find((m) => m.t === 'nodes' && m.nodes[0].owner === a.id);
  assert.ok(diff && diff.nodes[0].id === nb && diff.nodes[0].owner === a.id, '拠点の差分が届く');
  assert.ok(wsA.sent.slice(before).some((m) => m.t === 'players'), 'プレイヤー一覧が届く');

  // 強化: 回数ではなく出題レベルと点数が上がる。上限は出題レベル 999
  const lvBefore = w.levelFor(home, 'fortify');
  await solve(w, a, home.id);
  assert.strictEqual(home.defense, 1);
  assert.strictEqual(w.levelFor(home, 'fortify'), lvBefore + 1);
  assert.strictEqual(w.valueOf(home), 2, '点数は強化後のレベルに連動');
  assert.strictEqual(a.score, 2 + target.value);
  home.defense = 998;
  await assert.rejects(() => w.ask(a, home.id), /最大/);
  home.defense = 1;
  // 減衰: 24 時間ごとに 1 下がり、基礎レベルより下にはならない
  home.defense = 3; home.fortifiedAt = Date.now() - 2 * DECAY_MS - 1000;
  assert.strictEqual(w.levelFor(home, 'fortify'), home.level + 1, '2 日で 2 下がる');
  assert.strictEqual(home.defense, 1);
  home.fortifiedAt = Date.now() - 30 * DECAY_MS;
  assert.strictEqual(w.levelFor(home, 'fortify'), home.level, '0 より下にはならない');
  assert.strictEqual(w.pub(home).defense, 0);
  home.defense = 1; home.fortifiedAt = Date.now();

  // プレイヤー自身の拠点は占領禁止(保護が切れていても、相手が何拠点持っていても)
  const wsB = fakeWs();
  const b = await w.join(wsB, 'ベン', null);
  const bHome = w.nodes.get(b.homeNodeId);
  w.addEdge(home.id, bHome.id, home.t0);
  bHome.protectedUntil = 0; b.nodesOwned = 10;
  assert.ok(!(await w.canAttack(a.id, bHome.id)), '自分の拠点は占領できない');
  await assert.rejects(() => w.ask(a, bHome.id), /占領できません/);
  b.nodesOwned = 1;
  // 初心者保護: 相手が持つ固定拠点は、保護中・3 拠点以下なら攻撃できない。4 拠点以上なら奪える
  const bNode = [...w.adj.get(nb)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false);
  assert.ok(bNode, '隣に中立の固定拠点がある');
  bNode.owner = b.id; bNode.protectedUntil = Date.now() + 3600000; b.nodesOwned = 2;
  assert.ok(!(await w.canAttack(a.id, bNode.id)), '保護中は攻撃できない');
  await assert.rejects(() => w.ask(a, bNode.id), /守られています/);
  bNode.protectedUntil = 0;
  assert.ok(!(await w.canAttack(a.id, bNode.id)), '拠点 3 つ以下の人は攻撃できない');
  b.nodesOwned = 4;
  assert.ok(await w.canAttack(a.id, bNode.id), '拠点が 4 つ以上なら攻撃できる');
  for (let i = 0; i < bNode.hits; i++) await solve(w, a, bNode.id);
  assert.strictEqual(bNode.owner, a.id); assert.strictEqual(b.nodesOwned, 3);

  // 地域の支配: 配下(ハック可の固定拠点)の 3/4 以上で支配。上の段(東京都)は配下の区・市の 3/4 が要る
  const regionId = target.region;
  const inRegion = [...store.nodes.values()].filter((n) => n.region === regionId && !n.isPlayerNode && n.hackable !== false);
  const need = Math.ceil((inRegion.length * 3) / 4);
  for (const n of inRegion) n.owner = null;
  const picked = [inRegion.find((n) => n.id === nb), ...inRegion.filter((n) => n.id !== nb)].slice(0, need - 1);
  for (const n of picked) n.owner = a.id;
  await w.updateControl(target);
  assert.strictEqual((await store.loadRegion(regionId)).control.controller, null, '3/4 未満では支配しない');
  inRegion.find((n) => !n.owner).owner = a.id;
  assert.ok(await w.updateControl(target), '支配が変わった');
  const reg = await store.loadRegion(regionId);
  assert.strictEqual(reg.control.controller, a.id, '3/4 以上で支配');
  assert.strictEqual(reg.control.total, inRegion.length);
  assert.ok(w.log.some((l) => l.text.includes('を支配しました')), 'ログに出る');
  assert.strictEqual((await store.loadRegion('tokyo')).control.controller, null, '東京都は区・市の 3/4 が要る');
  await w.setView(a, [tileOf(home.lat, home.lon, 2)], 2);
  const ov2 = last(wsA, 'tiles');
  assert.ok(ov2.regions.some((g) => g.id === regionId && g.controller && g.controller.id === a.id && g.controller.color), '広域に支配者が付く');
  await w.setView(a, view, 0);
  for (const n of inRegion) if (n.id !== nb) n.owner = null;
  await w.updateControl(target);

  // 全滅時の再生成(暫定): 仕組みだけ
  b.nodesOwned = 0;
  const cnt = w.nodes.size;
  await w.respawn(b);
  assert.strictEqual(w.nodes.size, cnt + 1); assert.strictEqual(b.nodesOwned, 1);

  // 復帰コード: 同じトークンで同じプレイヤーに戻る。切断中も拠点は残る
  await w.disconnect(a);
  assert.ok(!a.online && w.nodes.get(home.id).owner === a.id);
  const a2 = await w.join(fakeWs(), 'あき', a.token);
  assert.strictEqual(a2.id, a.id, '同じプレイヤー');
  assert.notStrictEqual((await w.join(fakeWs(), 'だれか', 'wrong-token')).id, a.id, '違うコードは新規');

  // 再起動: 保存した内容から復元できる(まとめて読まず、必要なタイルだけ)
  const w2 = await new World({ store }).init();
  assert.strictEqual(w2.nodes.size, 0);
  await w2.ensureTiles([home.t0]);
  assert.strictEqual(w2.nodes.get(nb).owner, a.id, '所有者が復元される');
  const pa = await w2.getPlayer(a.id);
  assert.strictEqual(pa.score, a.score); assert.strictEqual(pa.nodesOwned, a.nodesOwned);
  const c = await w2.join(fakeWs(), 'あき', a.token);
  assert.strictEqual(c.id, a.id, '再起動後も復帰コードで戻れる');

  // ランキング
  const top = await store.topPlayers(5);
  assert.strictEqual(top[0].id, a.id);

  console.log(`world ok: ${w.nodes.size} nodes loaded of ${await store.countNodes()}, ${w.players.size} players, ${w.tiles.size} tiles`);
})().catch((e) => { console.error(e); process.exit(1); });
