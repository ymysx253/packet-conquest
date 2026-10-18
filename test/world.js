'use strict';
// 永続ワールドの検証(タイル方式): シード、範囲の読み込み、参加で拠点が生まれる、隣だけ攻撃できる、初心者保護、
// 回数制の奪取(回数 = つながりの本数)、強化とその減衰、地域の支配(3/4)、集計値、復帰コード、再起動後の復元、配信に答えが含まれないこと
const assert = require('assert');
const { World, PROTECT_MS, DECAY_MS, NEWBIE_MS, MOVE_INTERVAL_MS, COOLDOWN_MS, COOLDOWN_MAX_MS, weekKeyOf } = require('../server/world');
const { MemoryStore } = require('../server/store');
const { EventLog, dayOf } = require('../server/events');
const { tilesAround, tileOf, distanceKm } = require('../server/map/geo');
const { NODES } = require('../server/map/all');

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
  const events = new EventLog(store, { flushMs: 100000 }); // 出来事の記録(docs/LOGS.md)。最後にまとめて flush して検査する
  const w = await new World({ store, minAnswerMs: 0, events }).init();
  assert.strictEqual(await store.countNodes(), NODES.length, 'シードで全拠点が保存される');
  assert.strictEqual(w.nodes.size, 0, '起動時にはまとめて読まない');

  // 参加: 自分の拠点が東京駅の近くに生まれ、近い 2 拠点とつながる。周辺のタイルだけ読まれる
  const wsA = fakeWs(); wsA.ip = '203.0.113.5'; // 接続元(出来事の記録ではハッシュになる)
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
  // F6 最短解答時間: 出題から 1 秒未満は拒み、問題は残る
  w.minAnswerMs = 1000;
  await assert.rejects(() => w.answer(a, q.qid, a.pending.answerIndex), /速すぎ/);
  assert.ok(a.pending && a.pending.qid === q.qid, '拒んでも問題は残る');
  w.minAnswerMs = 0;
  const wrong = await w.answer(a, q.qid, (a.pending.answerIndex + 1) % 4);
  assert.ok(!wrong.correct && a.cooldownUntil > Date.now() && wrong.cooldownMs === COOLDOWN_MS, '不正解で待ち時間 4 秒');
  assert.strictEqual((await store.loadPlayer(a.id)).cooldownUntil, a.cooldownUntil, '待ち時間は保存される(再接続で消せない)');
  // 連続不正解で倍増(4 → 8 → 16 …、上限 60 秒)。正解で戻る
  a.cooldownUntil = 0;
  const q2 = await w.ask(a, nb); const wrong2 = await w.answer(a, q2.qid, (a.pending.answerIndex + 1) % 4);
  assert.strictEqual(wrong2.cooldownMs, COOLDOWN_MS * 2, '2 回目は 8 秒');
  a.cooldownUntil = 0; a.wrongStreak = 10;
  const q3 = await w.ask(a, nb); const wrong3 = await w.answer(a, q3.qid, (a.pending.answerIndex + 1) % 4);
  assert.strictEqual(wrong3.cooldownMs, COOLDOWN_MAX_MS, '上限 60 秒');
  a.cooldownUntil = 0;
  await assert.rejects(async () => { a.cooldownUntil = Date.now() + 5000; await w.ask(a, nb); }, /待って/, '待ち時間中は出題しない');
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
  assert.strictEqual(a.wrongStreak, 0, '正解で連続不正解は戻る');
  assert.strictEqual(a.weekKey, weekKeyOf(Date.now())); assert.strictEqual(a.weekPoints, target.value, '今週の獲得点');
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
  b.createdAt = Date.now() - NEWBIE_MS - 1000;
  assert.ok(await w.canAttack(a.id, bNode.id), '作成から 7 日たてば 3 つ以下でも攻撃できる(別アカウントで永久に守る穴をふさぐ)');
  b.createdAt = Date.now(); b.nodesOwned = 2;
  assert.ok(!(await w.canAttack(a.id, bNode.id)));
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
  const w2 = await new World({ store, minAnswerMs: 0 }).init();
  assert.strictEqual(w2.nodes.size, 0);
  await w2.ensureTiles([home.t0]);
  assert.strictEqual(w2.nodes.get(nb).owner, a.id, '所有者が復元される');
  const pa = await w2.getPlayer(a.id);
  assert.strictEqual(pa.score, a.score); assert.strictEqual(pa.nodesOwned, a.nodesOwned);
  const c = await w2.join(fakeWs(), 'あき', a.token);
  assert.strictEqual(c.id, a.id, '再起動後も復帰コードで戻れる');

  // ランキング: 総合(現在の点数・累計点・拠点数)、週間、チーム
  const top = await store.topPlayers(5);
  assert.strictEqual(top[0].id, a.id);
  const rk = await w.rankings();
  assert.ok(rk.score[0].id === a.id && rk.points.length > 0 && rk.nodes.length > 0 && rk.week === weekKeyOf(Date.now()), 'ランキングがそろう');
  assert.ok(rk.weekPoints.some((x) => x.id === a.id && x.weekPoints > 0), '週間ランキングに今週の獲得点');
  assert.strictEqual(weekKeyOf(Date.UTC(2026, 9, 14, 3)), '2026-10-12', '週の鍵は日本時間の月曜(2026-10-14 水 → 10-12)');
  assert.strictEqual(weekKeyOf(Date.UTC(2026, 9, 11, 16)), '2026-10-12', '日曜 16 時 UTC は日本時間の月曜 1 時 → 10-12');
  const tokyoSt0 = NODES.find((n) => n.name === '東京駅');
  // チーム: 作成 / 参加 / 脱退、所属中は作れない、回数はチームで合算、チームランキング
  const team1 = await w.createTeam(a, 'あかチーム', 3);
  assert.ok(a.team === team1.id && team1.maxMembers === 3);
  await assert.rejects(() => w.createTeam(a, 'もう一つ', 5), /所属している間/);
  const cee = await w.join(fakeWs(), 'シー', null, tokyoSt0.id);
  await w.joinTeam(cee, team1.id);
  assert.strictEqual((await store.loadTeam(team1.id)).memberCount, 2);
  await assert.rejects(() => w.joinTeam(cee, team1.id), /すでにチーム/);
  const dee = await w.join(fakeWs(), 'ディー', null, tokyoSt0.id); const eee = await w.join(fakeWs(), 'イー', null, tokyoSt0.id);
  await w.joinTeam(dee, team1.id);
  await assert.rejects(() => w.joinTeam(eee, team1.id), /満員/);
  // 合算: a と cee が同じ拠点を攻める(cee の拠点は a の陣地の隣に生まれたとは限らないので、cee に a の隣の所有拠点を与える)
  const shared = [...w.adj.get(nb)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false && n.hits >= 2);
  const c1Launch = w.nodes.get(nb); // a の所有拠点 nb を cee にも隣接させるため、cee の拠点と nb をつなぐ
  w.addEdge(cee.homeNodeId, c1Launch.id, w.nodes.get(cee.homeNodeId).t0);
  // cee は nb を持っていないので、nb から先は攻められない。合算を確かめるには cee が shared に隣接する所有拠点を持つ必要がある
  const c1Own = [...w.adj.get(shared.id)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false && n.id !== nb);
  if (c1Own) {
    c1Own.owner = cee.id; await w.persistNode(c1Own); w.addEdge(cee.homeNodeId, c1Own.id, w.nodes.get(cee.homeNodeId).t0); cee.reach = null;
    const qa = await w.ask(a, shared.id); await w.answer(a, qa.qid, a.pending.answerIndex);
    assert.strictEqual(shared.progress[team1.id], 1, '進捗はチームの鍵で数える');
    const qc = await w.ask(cee, shared.id); await w.answer(cee, qc.qid, cee.pending.answerIndex);
    assert.strictEqual(shared.owner === cee.id ? 2 : shared.progress[team1.id], 2, '仲間の正解が合算される');
  }
  const rk2 = await w.rankings();
  assert.ok(rk2.teams.some((t) => t.id === team1.id && t.name === 'あかチーム' && t.members === 3 && t.icon === '★' && t.style.fill), 'チームランキング(見た目つき)');
  // 見た目: リーダーだけ変えられる。色は #RRGGBB、アイコンは用意した記号
  await assert.rejects(() => w.styleTeam(cee, { fill: '#FF0000' }), /リーダーだけ/);
  await assert.rejects(() => w.styleTeam(a, { fill: 'red' }), /#RRGGBB/);
  await assert.rejects(() => w.styleTeam(a, { icon: '🐱' }), /用意された記号/);
  const styled = await w.styleTeam(a, { frame: '#112233', fill: '#ffcc00', text: '#000000', icon: '⚡' });
  assert.ok(styled.style.fill === '#FFCC00' && styled.icon === '⚡');
  assert.strictEqual(w.pubPlayer(a).teamStyle.fill, '#FFCC00', '所属者の配信にチームの色が付く(拠点の色に使う)');
  assert.strictEqual(w.pubPlayer(a).teamIcon, '⚡');
  // 地域をチームが支配したら、支配者の表示にチームの見た目が付く
  const regionDoc = await store.loadRegion(regionId);
  regionDoc.control = { total: 10, counts: { [team1.id]: 9 }, controller: team1.id, updatedAt: Date.now() }; await store.saveRegion(regionDoc); w.invalidateRegions();
  await w.setView(a, [tileOf(home.lat, home.lon, 2)], 2);
  const ov3 = last(a.ws, 'tiles');
  const g3 = ov3.regions.find((g) => g.id === regionId);
  assert.ok(g3 && g3.controller && g3.controller.kind === 'team' && g3.controller.style.fill === '#FFCC00' && g3.controller.icon === '⚡', '地域の支配者がチームなら見た目つき');
  regionDoc.control = null; await store.saveRegion(regionDoc); w.invalidateRegions();
  await w.setView(a, view, 0);
  // リーダーが抜けたら、いちばん古い人にリーダーが移る
  await w.leaveTeam(a);
  const after = await store.loadTeam(team1.id);
  assert.ok(after && after.ownerId === cee.id, 'リーダーの引き継ぎ');
  await w.joinTeam(a, team1.id); await w.leaveTeam(cee); await w.leaveTeam(dee);
  assert.strictEqual((await store.loadTeam(team1.id)).memberCount, 1);
  await w.leaveTeam(a);
  assert.strictEqual(await store.loadTeam(team1.id), null, '最後の 1 人が抜けるとチームは消える');
  assert.strictEqual(a.team, null);

  // 開始地点(第 3.1 節): 名前で検索でき、選んだ駅のまわりに拠点が生まれ、その駅とつながる。指定が無ければ東京駅
  const tokyoSt = NODES.find((n) => n.name === '東京駅');
  assert.strictEqual(a.startNodeId, tokyoSt.id, '指定が無ければ東京駅');
  assert.ok(distanceKm(home, tokyoSt) <= 1.05 && w.adj.get(home.id).has(tokyoSt.id), '東京駅のまわりに生まれ、東京駅とつながる');
  const found = await w.search('japan', '高尾');
  assert.ok(found.some((r) => r.name === '高尾駅') && found.every((r) => typeof r.starters === 'number'), '名前の一部で検索できる');
  assert.strictEqual((await w.search('japan', '浅草寺')).length, 0, 'ハック不可の寺社は開始地点にできない');
  const takao = NODES.find((n) => n.name === '高尾駅' && n.region.startsWith('tokyo-'));
  const t1 = await w.join(fakeWs(), 'たかお', null, takao.id);
  const tHome = w.nodes.get(t1.homeNodeId);
  assert.ok(distanceKm(tHome, takao) <= 1.05, '選んだ駅のまわりに生まれる');
  assert.ok(w.adj.get(tHome.id).has(takao.id), '選んだ駅とつながる');
  assert.strictEqual((await w.search('japan', '高尾駅')).find((r) => r.id === takao.id).starters, 1, 'ここから始めた人数が付く(全国に同名の駅があるので id で引く)');
  const temple = NODES.find((n) => n.hackable === false);
  await assert.rejects(() => w.join(fakeWs(), 'だめ', null, temple.id), /選べません/);
  await assert.rejects(() => w.join(fakeWs(), 'だめ', null, 'st-nope'), /選べません/);
  const before2 = w.players.size;
  await assert.rejects(() => w.join(fakeWs(), 'だめ', null, tHome.id), /選べません/, 'プレイヤーの拠点からは始められない');
  assert.strictEqual(w.players.size, before2, '失敗した参加はプレイヤーを残さない');
  // 自然に広がる: 同じ駅から大勢が始めても、間隔を守って半径が広がる(1 km まで)
  const okutama = NODES.find((n) => n.name === '奥多摩駅');
  const homes = [];
  for (let i = 0; i < 25; i++) homes.push(w.nodes.get((await w.join(fakeWs(), `人${i}`, null, okutama.id)).homeNodeId));
  assert.ok(homes.every((h) => distanceKm(h, okutama) <= 1.05), '全員 1 km 以内');
  for (let i = 0; i < homes.length; i++) for (let j = i + 1; j < homes.length; j++) assert.ok(distanceKm(homes[i], homes[j]) >= 0.15 - 1e-6, '間隔 150 m を守る');
  assert.ok(Math.max(...homes.map((h) => distanceKm(h, okutama))) > 0.3, '混むと半径が広がる');
  assert.strictEqual((await w.search('japan', '奥多摩')).find((r) => r.name === '奥多摩駅').starters, 25);
  // 復帰コードの再発行: 新しいコードで戻れ、古いコードでは戻れない
  const oldToken = a.token;
  const newToken = await w.rekey(a);
  assert.notStrictEqual(newToken, oldToken);
  assert.strictEqual((await w.join(fakeWs(), 'あき', newToken)).id, a.id, '新しいコードで戻れる');
  assert.notStrictEqual((await w.join(fakeWs(), 'だれか', oldToken)).id, a.id, '古いコードは新規扱い');

  // 休眠の回収: 7 日間接続が無い無料アカウントは、奪った拠点も自分の拠点も中立に戻してアカウントを削除。サブスクと接続中は対象外
  const idle = await w.join(fakeWs(), 'きゅうみん', null, tokyoSt.id);
  const idleHome = w.nodes.get(idle.homeNodeId);
  const victim = [...w.adj.get(idle.homeNodeId)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false);
  victim.owner = idle.id; victim.defense = 2; idle.nodesOwned = 2; await w.persistNode(victim);
  const sub = await w.join(fakeWs(), 'かいいん', null, tokyoSt.id);
  sub.plan = 'sub';
  await w.disconnect(idle); await w.disconnect(sub);
  // 休眠は稼働時計で数える: 実時刻だけ進んでも(メンテナンスで止まっていた間は)回収しない
  idle.lastSeen = Date.now() - 8 * 24 * 3600 * 1000; sub.lastSeen = idle.lastSeen; await w.persistPlayer(idle); await w.persistPlayer(sub);
  assert.strictEqual(await w.reclaimIdle(), 0, '稼働時計が進んでいなければ回収しない');
  const upBefore = w.uptime;
  w.lastTick = Date.now() - 24 * 3600 * 1000; await w.tick();
  assert.ok(w.uptime - upBefore <= 5 * 60 * 1000, '止まっていた時間は 1 回の刻みで 5 分までしか進まない');
  w.uptime += 8 * 24 * 3600 * 1000; // 稼働 8 日ぶん進んだことにする
  await w.touch(a); await w.persistPlayer(a); // 接続中の a は最近見た扱い
  assert.strictEqual(await w.reclaimIdle(), 1, '稼働時計で 7 日たてば休眠 1 件を回収(会員は残る)');
  assert.ok(!(await store.loadPlayer(idle.id)) && !(await store.loadNode(idleHome.id)) && !w.nodes.has(idleHome.id), 'アカウントと自分の拠点が消える');
  assert.strictEqual((await store.loadNode(victim.id)).owner, null, '奪っていた拠点は中立に戻る');
  assert.strictEqual(victim.defense, 0);
  assert.ok(await store.loadPlayer(sub.id) && (await store.loadNode(sub.homeNodeId)), 'サブスク会員は残る');
  assert.ok(await store.loadPlayer(a.id), '接続中の人は残る');
  assert.ok(w.log.some((l) => l.text.includes('きゅうみん') && l.text.includes('中立')));
  // 稼働時計は保存され、再起動後に続きから数える
  const w3 = await new World({ store, minAnswerMs: 0 }).init();
  assert.ok(w3.uptime >= upBefore, '稼働時計が保存から復元される');

  // 引っ越し(1 日 1 回): 自分の拠点が新しい場所に移り、所有拠点は残るが線が切れた所有拠点からは広げられない
  const mover = await w.join(fakeWs(), 'ひっこし', null, tokyoSt.id);
  const mHome0 = w.nodes.get(mover.homeNodeId);
  const mTarget = [...w.adj.get(mHome0.id)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false);
  for (let i = 0; i < mTarget.hits; i++) await solve(w, mover, mTarget.id);
  assert.strictEqual(mTarget.owner, mover.id); assert.strictEqual(mover.nodesOwned, 2);
  const beyond = [...w.adj.get(mTarget.id)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false);
  assert.ok(await w.canAttack(mover.id, beyond.id), '線がつながっている所有拠点からは広げられる');
  await assert.rejects(() => w.move(mover, tokyoSt.id), /違う開始地点/);
  const newHome = await w.move(mover, takao.id);
  assert.ok(!w.nodes.has(mHome0.id) && !(await store.loadNode(mHome0.id)), '古い自分の拠点は消える');
  assert.ok(distanceKm(newHome, takao) <= 1.05 && mover.homeNodeId === newHome.id, '新しい拠点は引っ越し先のそば');
  assert.strictEqual(mover.nodesOwned, 2, '所有拠点は残る(自分の拠点 1 + 固定 1)');
  assert.strictEqual((await store.loadNode(mTarget.id)).owner, mover.id);
  await w.ensureTiles(tilesAround(mTarget.t0, 1));
  assert.ok(!(await w.canAttack(mover.id, beyond.id)), '線が切れた所有拠点からは広げられない');
  await assert.rejects(() => w.ask(mover, beyond.id), /つなぎ直して/);
  await assert.rejects(() => w.move(mover, tokyoSt.id), /1 日に 1 回/);
  mover.movedAt = Date.now() - MOVE_INTERVAL_MS - 1000;
  await w.move(mover, tokyoSt.id);
  assert.ok(distanceKm(w.nodes.get(mover.homeNodeId), tokyoSt) <= 1.05, '1 日たてばまた引っ越せる');

  // 入力式の問題(COMMON.md): 欄の配信に accept は含まれない。inputs で答え、正規化して判定。結果に正解(正規形)と defenseNote
  const tq = { answerKind: 'text', fields: [{ name: 'net', label: 'ネットワーク', format: 'ipv4cidr', hint: '例: 10.0.0.0/24', accept: ['10.1.2.0/23'] }, { name: 'n', label: '台数', format: 'number', accept: ['510'] }], explanation: 'テスト', defenseNote: '守る側の一文' };
  const tp = await w.join(fakeWs(), 'にゅうりょく', null, tokyoSt.id);
  let tTarget = [...w.adj.get(tp.homeNodeId)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false);
  if (!tTarget) { tTarget = [...w.nodes.values()].find((n) => !n.isPlayerNode && !n.owner && n.hackable !== false); w.addEdge(tp.homeNodeId, tTarget.id, w.nodes.get(tp.homeNodeId).t0); tp.reach = null; }
  tp.pending = { qid: 'tq1', nodeId: tTarget.id, mode: 'attack', level: 20, askedAt: 0, payload: { t: 'question', qid: 'tq1', answerKind: 'text', fields: tq.fields.map((f) => ({ name: f.name, label: f.label, format: f.format, hint: f.hint })) }, answerKind: 'text', answerIndex: undefined, fields: tq.fields, compare: null, verifier: null, explanation: tq.explanation, defenseNote: tq.defenseNote };
  assert.ok(!JSON.stringify(tp.pending.payload).includes('accept'), '配信に accept が無い');
  const pend1 = { ...tp.pending };
  await assert.rejects(() => w.answer(tp, 'tq1', 2), /選択肢|欄の数/, '入力式に choice は使えない');
  await assert.rejects(() => w.answer(tp, 'tq1', ['10.1.2.0/23']), /欄の数/);
  const r1 = await w.answer(tp, 'tq1', ['１０.1.2.0／23', '510台']);
  assert.ok(r1.correct && r1.answers[0] === '10.1.2.0/23' && r1.defenseNote === '守る側の一文' && r1.answerIndex === null, '正規化して正解。正解の表示と defenseNote');
  assert.strictEqual(tTarget.progress[tp.id], 1, '正解として扱われ進捗が進む');
  tp.pending = { ...pend1, qid: 'tq2' };
  const r2 = await w.answer(tp, 'tq2', ['10.1.2.5/23', '510']);
  assert.ok(!r2.correct && r2.answers[1] === '510', '切り詰めないので不正解。正解は返す');
  tp.cooldownUntil = 0;

  // 参加前の人も地図を読める(開始地点を地図から選ぶため)。配信先にはならない
  const gws = fakeWs();
  await w.setView(w.guest(gws), tilesAround(tokyoSt.t0, 1), 0);
  assert.ok(last(gws, 'tiles').nodes.some((n) => n.id === tokyoSt.id), '参加前でも範囲を読める');
  assert.ok(!JSON.stringify(gws.sent).includes('answerIndex'));

  // 出来事の記録(docs/LOGS.md): 参加・復帰・切断・解答・侵入・奪取・強化・チーム・支配・引っ越し・再発行・回収が積まれ、答えや復帰コード・生の IP を含まない。
  // players.stats は解答のたびに増え、persistPlayer で保存される。control.daily は同じ日に 2 回書いても地域ごとに 1 件
  await events.flush();
  const today = dayOf(Date.now());
  const kinds = await store.countEventsByKind(today);
  for (const k of ['join', 'resume', 'leave', 'answer', 'intrude', 'capture', 'fortify', 'team.create', 'team.join', 'team.leave', 'team.style', 'control', 'move', 'rekey', 'reclaim', 'limit']) assert.ok(kinds[k] >= 1, `出来事 ${k} が記録される(${JSON.stringify(kinds)})`);
  const allEvents = [...store.events.values()];
  const dump = JSON.stringify(allEvents);
  assert.ok(!dump.includes('answerIndex') && !dump.includes('"options"') && !dump.includes('explanation') && !dump.includes('"accept"') && !dump.includes('203.0.113.5') && !dump.includes(a.token) && !dump.includes(oldToken) && !dump.includes(newToken), '答え・復帰コード・生の IP を含まない');
  assert.ok(allEvents.every((e) => e.type === 'event' && e.day === today && typeof e.at === 'number' && (e.kind === 'control.daily' || e.ttl > 0)), '共通項目と ttl');
  const joinA = allEvents.find((e) => e.kind === 'join' && e.playerId === a.id);
  assert.ok(joinA && joinA.nodeId === home.id && joinA.regionId === home.region && joinA.detail.startNodeId === tokyoSt.id && joinA.detail.name === 'あき', 'join に自分の拠点と開始地点');
  assert.match(joinA.src, /^[0-9a-f]{16}$/, '接続元は 16 桁のハッシュ');
  assert.ok(allEvents.some((e) => e.kind === 'resume' && e.playerId === a.id && e.detail.renamed === false), '復帰');
  assert.ok(allEvents.some((e) => e.kind === 'leave' && e.playerId === a.id && typeof e.detail.sec === 'number'), '切断に接続秒数');
  const wrongEv = allEvents.filter((e) => e.kind === 'answer' && e.playerId === a.id && e.ok === false);
  assert.ok(wrongEv.length >= 3 && wrongEv[0].detail.cooldownMs === COOLDOWN_MS && wrongEv[1].detail.cooldownMs === COOLDOWN_MS * 2 && wrongEv.every((e) => e.level >= 1 && typeof e.sec === 'number' && e.detail.mode === 'attack' && !('qid' in e)), '不正解の answer(待ち時間の倍増。qid は書かない)');
  assert.ok(allEvents.some((e) => e.kind === 'limit' && e.playerId === a.id && e.detail.rule === 'fast' && e.detail.ms >= 0), '速すぎる解答は limit(fast)');
  const cap = allEvents.find((e) => e.kind === 'capture' && e.playerId === a.id && e.nodeId === nb);
  assert.ok(cap && cap.detail.gained === target.value && cap.detail.prevOwner === null && cap.detail.hits === target.hits && cap.level >= 1 && cap.regionId === target.region, 'capture に得点と前の所有者');
  assert.strictEqual(allEvents.filter((e) => e.kind === 'intrude' && e.nodeId === nb && e.playerId === a.id).length, target.hits - 1, '回数未達は intrude');
  assert.ok(allEvents.some((e) => e.kind === 'capture' && e.nodeId === bNode.id && e.detail.prevOwner === b.id), '奪取は前の所有者つき');
  assert.ok(allEvents.some((e) => e.kind === 'fortify' && e.nodeId === home.id && e.detail.defense === 1 && e.level === Math.max(4, home.level + 1)), '強化は強化後の攻め手の出題レベル(所有拠点は Lv4 以上)');
  assert.ok(allEvents.some((e) => e.kind === 'control' && e.regionId === regionId && e.detail.after === a.id && e.detail.before === null), '支配の変化');
  assert.ok(allEvents.some((e) => e.kind === 'team.create' && e.teamId === team1.id && e.detail.name === 'あかチーム') && allEvents.some((e) => e.kind === 'team.leave' && e.detail.deleted === true), 'チームの作成と消滅');
  assert.ok(allEvents.some((e) => e.kind === 'team.style' && e.detail.icon === '⚡') && allEvents.some((e) => e.kind === 'reclaim' && e.detail.name === 'きゅうみん' && e.detail.homeDeleted === true && e.detail.nodesFreed === 1), '見た目の変更と休眠の回収');
  assert.ok(allEvents.some((e) => e.kind === 'move' && e.playerId === mover.id && e.detail.to === takao.id) && allEvents.some((e) => e.kind === 'rekey' && e.playerId === a.id), '引っ越しと再発行');
  // 学習記録の集計値
  assert.ok(a.stats && a.stats.answers >= 5 && a.stats.correct >= 3 && a.stats.answers > a.stats.correct && typeof a.stats.minSec === 'number', 'stats が増える');
  const lvKey = String(target.level);
  assert.ok(a.stats.byLevel[lvKey] && a.stats.byLevel[lvKey].n >= target.hits && a.stats.byLevel[lvKey].ok >= target.hits - 1 && a.stats.byLevel['0'] === undefined, 'レベルごとの n / ok');
  assert.ok(a.stats.byBand['0'] && a.stats.byBand['0'].n === a.stats.answers, '領域(100 ごと)の集計');
  const savedA = await store.loadPlayer(a.id);
  assert.deepStrictEqual(savedA.stats, a.stats, 'stats は persistPlayer で保存される');
  assert.ok(!('connectedAt' in savedA), 'connectedAt は保存しない');
  // 支配の断面: 同じ日に 2 回呼んでも地域ごとに 1 件。tick で日付が変わったときだけ走る
  const n1 = await w.snapshotControl(); const n2 = await w.snapshotControl(); await events.flush();
  assert.ok(n1 >= 50 && n1 === n2, '区・市 + 東京都 + 日本');
  const daily = await store.eventsByDay(today, { kind: 'control.daily', limit: 5000 });
  assert.strictEqual(daily.length, n1, '上書きなので地域ごとに 1 件');
  assert.ok(daily.every((e) => e.id === `ctl-${today}-${e.regionId}` && e.ttl === -1 && [3, 5, 6].includes(e.detail.tier) && !('playerId' in e)), 'id は ctl-日付-地域、無期限');
  const ctlCount = daily.length;
  w.lastDay = today; await w.tick(); await events.flush();
  assert.strictEqual((await store.eventsByDay(today, { kind: 'control.daily', limit: 5000 })).length, ctlCount, '日付が変わらなければ書かない');
  w.lastDay = '2000-01-01'; await w.tick(); await events.flush();
  assert.strictEqual(w.lastDay, today); assert.strictEqual((await store.loadMeta('clock')).day, today, '日付は稼働時計と一緒に保存される');
  assert.strictEqual((await store.eventsByDay(today, { kind: 'control.daily', limit: 5000 })).length, ctlCount, '日付が変わっていれば断面を書く(同じ id で上書き)');

  console.log(`world ok: ${w.nodes.size} nodes loaded of ${await store.countNodes()}, ${w.players.size} players, ${w.tiles.size} tiles, ${allEvents.length} events`);
})().catch((e) => { console.error(e); process.exit(1); });
