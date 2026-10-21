'use strict';
// 永続ワールドの検証(タイル方式): シード、範囲の読み込み、参加で拠点が生まれる、隣だけ攻撃できる、初心者保護、
// 回数制の奪取(回数 = つながりの本数)、強化とその減衰、地域の支配(3/4)、集計値、復帰コード、再起動後の復元、配信に答えが含まれないこと
const assert = require('assert');
const { World, DEFAULT_START_ID, PROTECT_MS, GATEWAY_GUARD_MS, DECAY_MS, NEWBIE_MS, MOVE_INTERVAL_MS, COOLDOWN_MS, COOLDOWN_MAX_MS, weekKeyOf } = require('../server/world');
const { MemoryStore } = require('../server/store');
const { hasGenerator } = require('../server/questions');
const { EventLog, dayOf } = require('../server/events');
const { tilesAround, tileOf, distanceKm } = require('../server/map/geo');
const { NODES } = require('../server/map/all');

const fakeWs = () => { const ws = { readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() { this.readyState = 3; } }; return ws; };
const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);

// 正解がわからないので、サーバーの pending を読んで答える(テスト専用)
async function solve(world, p, nodeId) {
  const q = await world.ask(p, nodeId);
  const pend = p.pending;
  const ans = pend && pend.answerKind === 'text' ? (pend.fields || []).map((f) => (f.accept && f.accept[0]) || '') : pend ? pend.answerIndex : -1; // 書き込み式は受け付ける答えの 1 つ目
  const r = await world.answer(p, q.qid, ans);
  assert.ok(r.correct, 'テストは正解を選ぶ');
  return r;
}

(async () => {
  const store = new MemoryStore();
  const events = new EventLog(store, { flushMs: 100000 }); // 出来事の記録(docs/LOGS.md)。最後にまとめて flush して検査する
  const w = await new World({ store, minAnswerMs: 0, events }).init();
  assert.strictEqual(await store.countNodes(), NODES.length, 'シードで全拠点が保存される');
  assert.strictEqual(w.nodes.size, 0, '起動時にはまとめて読まない');

  // 参加: 自分の拠点が既定の開始地点(丸の内)の近くに生まれ、近い 2 拠点とつながる。周辺のタイルだけ読まれる
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
  assert.ok(ov.overview && ov.minLevel === 100 && ov.nodes.every((n) => n.level >= 100 || n.owner === a.id), '広域(段 2)は Lv100 以上だけ(2026-10-19 の物差し)。自分の拠点は低くても届く');
  assert.ok(ov.nodes.some((n) => n.id === home.id), '縮小表示にも自分の拠点が届く');
  assert.ok(Array.isArray(ov.regions) && ov.regions.length > 0 && ov.regions.every((g) => g.tier === 6 && typeof g.lat === 'number'), '広域には区・市の支配状況が付く');
  assert.ok(ov.regions.some((g) => g.name === '千代田区') && ov.regions.every((g) => g.controller === null), 'まだ誰も支配していない');
  await w.setView(a, view, 0);

  // 選んだ拠点のつながり先(名前と位置。縮小していても線を出すため。2026-10-19)
  { const tw = NODES.find((n) => n.id === DEFAULT_START_ID); const nb = await w.neighbors(tw.id);
    assert.ok(nb.t === 'neighbors' && nb.list.length >= tw.adj.length && tw.adj.every((id) => nb.list.some((x) => x.id === id && typeof x.lat === 'number' && x.name)), 'つながり先が名前と位置つきで届く');
    assert.ok(nb.list.some((x) => x.id === home.id), '自分の拠点とのつながりも入る');
    assert.deepStrictEqual((await w.neighbors('st-nope')).list, [], '無い拠点は空'); }
  // 航路(空路・海路)だけでつながる先には route が付く(画面は黒い直線を引かない。2026-10-21 ユーザー指摘)
  // 航路の行き先は、その空港・港を自分かチームが押さえているときだけ教える(2026-10-22 ユーザー指摘: たどり着くまで分からない)
  { const port = NODES.find((n) => n.id === 'pt-s1c9bff7558');
    await w.ensureTiles([tileOf(port.lat, port.lon, 0)]);
    const nb0 = await w.neighbors(port.id, a);
    assert.ok(port.routes.every((r) => !nb0.list.some((x) => x.id === r.to)) && port.adj.every((id) => nb0.list.some((x) => x.id === id && !x.route)), '利島港: 押さえていなければ航路の先は出ない');
    const g = await w.neighbors(port.id);
    assert.ok(port.routes.every((r) => !g.list.some((x) => x.id === r.to)), '利島港: 参加前(だれでもない)にも航路の先は出ない');
    const pn = w.nodes.get(port.id); pn.owner = a.id;
    const nb = await w.neighbors(port.id, a);
    pn.owner = null;
    assert.ok(port.routes.every((r) => nb.list.some((x) => x.id === r.to && x.route)) && port.adj.every((id) => nb.list.some((x) => x.id === id && !x.route)), '利島港: 押さえていれば航路の先も出る(route 付き)'); }

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
  assert.ok(!wrong.correct && a.cooldownUntil > Date.now() && wrong.cooldownMs === COOLDOWN_MS, '不正解で待ち時間 5 秒');
  assert.strictEqual((await store.loadPlayer(a.id)).cooldownUntil, a.cooldownUntil, '待ち時間は保存される(再接続で消せない)');
  // 連続不正解で倍増(4 → 8 → 16 …、上限 60 秒)。正解で戻る
  a.cooldownUntil = 0;
  const q2 = await w.ask(a, nb); const wrong2 = await w.answer(a, q2.qid, (a.pending.answerIndex + 1) % 4);
  assert.strictEqual(wrong2.cooldownMs, COOLDOWN_MS, '続けて間違えても 5 秒(2026-10-20 から延ばさない)');
  a.cooldownUntil = 0; a.wrongStreak = 10;
  const q3 = await w.ask(a, nb); const wrong3 = await w.answer(a, q3.qid, (a.pending.answerIndex + 1) % 4);
  assert.strictEqual(wrong3.cooldownMs, COOLDOWN_MAX_MS, '何回続けても 5 秒');
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
  // 点数の数え直し(2026-10-21): 点数は今持っている拠点の今の点数(基礎 + 下がったあとの強化)の合計。強化が下がった分は数え直しで減る
  {
    await w.recountScores();
    const base = a.score;
    home.defense = 5; home.fortifiedAt = Date.now(); a.score = base + 5; await w.persistNode(home);
    await w.recountScores();
    assert.strictEqual(a.score, base + 5, '強化した分は点数に入る');
    home.fortifiedAt = Date.now() - 3 * DECAY_MS - 1000; await w.persistNode(home);
    await w.recountScores();
    assert.strictEqual(a.score, base + 2, '強化が 3 段下がると、数え直しで点数も 3 減る');
    a.score = 9999; await w.recountScores();
    assert.strictEqual(a.score, base + 2, 'ずれていても、数え直すと今持っている拠点の点数の合計にそろう');
  }
  home.defense = 1; home.fortifiedAt = Date.now(); await w.persistNode(home); // 書き換えた強化を保存(数え直しは保存した拠点を数える)

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
  const inRegion = [...store.nodes.values()].filter((n) => n.region === regionId && !n.isPlayerNode && n.hackable !== false && n.status === 'public'); // 非公開の拠点(皇居など)は支配の数に入らない
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

  // 再起動: 保存した内容から復元できる(まとめて読まず、必要なタイルだけ)。テストで強化の段を直接書き換えた分は、数え直してそろえておく(起動したときも数え直す)
  await w.recountScores();
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
  const tokyoSt0 = NODES.find((n) => n.id === DEFAULT_START_ID); // 既定の開始地点(丸の内)
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
  const shared = [...w.adj.get(nb)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false && n.hits >= 2 && hasGenerator(w.levelFor(n, 'attack'))); // 問題のあるレベルの拠点
  const c1Launch = w.nodes.get(nb); // a の所有拠点 nb を cee にも隣接させるため、cee の拠点と nb をつなぐ
  w.addEdge(cee.homeNodeId, c1Launch.id, w.nodes.get(cee.homeNodeId).t0);
  // cee は nb を持っていないので、nb から先は攻められない。合算を確かめるには cee が shared に隣接する所有拠点を持つ必要がある
  const c1Own = shared && [...w.adj.get(shared.id)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false && n.id !== nb);
  if (shared && c1Own) {
    c1Own.owner = cee.id; await w.persistNode(c1Own); w.addEdge(cee.homeNodeId, c1Own.id, w.nodes.get(cee.homeNodeId).t0); cee.reach = null;
    await solve(w, a, shared.id);
    assert.strictEqual(shared.progress[team1.id], 1, '進捗はチームの鍵で数える');
    await solve(w, cee, shared.id);
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
  // 縮小表示でも、自分とチームの仲間の拠点はレベルが低くても届く。ほかの人の低い拠点は届かない。持ち主のチームと色が付く(2026-10-19)
  {
    const T2 = tileOf(home.lat, home.lon, 2);
    const lows = [...w.nodes.values()].filter((n) => !n.isPlayerNode && !n.owner && n.status === 'public' && n.level < 100 && tileOf(n.lat, n.lon, 2) === T2).slice(0, 2);
    assert.strictEqual(lows.length, 2);
    lows[0].owner = cee.id; lows[1].owner = eee.id;
    for (const n of lows) await w.persistNode(n);
    w.ownedCache.clear();
    await w.setView(a, [T2], 2);
    const ov4 = last(a.ws, 'tiles');
    const mate = ov4.nodes.find((n) => n.id === lows[0].id);
    assert.ok(mate && mate.ownerTeam === team1.id && mate.ownerColor === '#FFCC00', '仲間の低い拠点が縮小表示に届き、チームと色が付く');
    assert.ok(!ov4.nodes.some((n) => n.id === lows[1].id), 'ほかの人の低い拠点は縮小表示に足さない');
    for (const n of lows) { n.owner = null; await w.persistNode(n); }
    w.ownedCache.clear();
  }
  await w.setView(a, view, 0);
  // チームにいる間に取った拠点は、抜けた時点でチームの持ち物になる(2026-10-20 ユーザー決定)。チームに入る前に取った拠点はその人に残る
  const heldNode = w.nodes.get(nb);
  heldNode.capturedTeam = team1.id; // チームにいる間に取ったことにする
  const keptNode = [...w.nodes.values()].find((n) => n.owner === a.id && !n.isPlayerNode && n.id !== nb);
  if (keptNode) keptNode.capturedTeam = null;
  const ownedBefore = a.nodesOwned;
  // リーダーが抜けたら、いちばん古い人にリーダーが移る
  await w.leaveTeam(a);
  const after = await store.loadTeam(team1.id);
  assert.ok(after && after.ownerId === cee.id, 'リーダーの引き継ぎ');
  assert.ok(heldNode.owner === team1.id && heldNode.ownerIsTeam, 'チームにいる間に取った拠点はチームの持ち物になる');
  assert.strictEqual(a.nodesOwned, ownedBefore - 1, '抜けた人の拠点の数から減る');
  assert.ok(after.heldNodes === 1 && after.heldScore > 0, 'チームの持ち物の数と点');
  if (keptNode) assert.strictEqual(keptNode.owner, a.id, 'チームに入る前に取った拠点はその人に残る');
  assert.ok(w.pub(heldNode).ownerIsTeam && w.pub(heldNode).ownerTeam === team1.id && w.pub(heldNode).ownerTeamName === 'あかチーム', 'チームの見た目と名前で配信');
  assert.strictEqual(await w.canAttack(cee.id, heldNode.id), false, '自分のチームの持ち物は攻撃できない');
  assert.ok((await w.rankings()).teams.find((t) => t.id === team1.id).nodes >= 1, 'チームの順位に持ち物の拠点を数える');
  await w.joinTeam(a, team1.id); await w.leaveTeam(cee); await w.leaveTeam(dee);
  assert.strictEqual((await store.loadTeam(team1.id)).memberCount, 1);
  await w.leaveTeam(a);
  assert.strictEqual(await store.loadTeam(team1.id), null, '最後の 1 人が抜けるとチームは消える');
  assert.strictEqual(a.team, null);
  assert.ok(!heldNode.owner && !heldNode.ownerIsTeam, 'チームが消えると、チームの持ち物は中立に戻る');

  // 囲み(2026-10-21 ユーザー決定): 必要な回数 = つながりの本数 −(自分かチームが押さえている隣の数 − 1)。最低 1。チームの仲間・チームの持ち物も数える
  {
    const t = [...w.nodes.values()].find((n) => !n.isPlayerNode && !n.owner && n.hackable !== false && n.status === 'public' && (n.hits || 1) >= 3
      && w.neighborIds(n).filter((id) => w.nodes.has(id) && !w.nodes.get(id).owner && !w.nodes.get(id).isPlayerNode).length >= 3);
    assert.ok(t, '囲みを試す拠点(つながり 3 本以上で、空いている隣が 3 つ)');
    const nb3 = w.neighborIds(t).filter((id) => w.nodes.has(id) && !w.nodes.get(id).owner && !w.nodes.get(id).isPlayerNode).slice(0, 3).map((id) => w.nodes.get(id));
    const base = await w.siege(t, a);
    const expect = (held) => Math.max(1, t.hits - Math.max(0, held - 1));
    assert.strictEqual(base.need, expect(base.held), '囲みの式');
    nb3[0].owner = a.id;
    assert.strictEqual((await w.siege(t, a)).need, expect(base.held + 1), '隣を 1 つ押さえる');
    nb3[1].owner = a.id;
    const two = await w.siege(t, a);
    assert.strictEqual(two.held, base.held + 2); assert.strictEqual(two.need, expect(base.held + 2), '隣を 2 つ押さえると 1 回減る(最初の 1 つ以降)');
    // チーム: 仲間の拠点とチームの持ち物も数える
    const tm = await w.createTeam(a, '囲みチーム', 3);
    const mate = await w.join(fakeWs(), 'なかま', null, tokyoSt0.id); await w.joinTeam(mate, tm.id);
    nb3[2].owner = mate.id;
    assert.strictEqual((await w.siege(t, a)).held, base.held + 3, 'チームの仲間が押さえた隣も数える');
    nb3[2].owner = tm.id; nb3[2].ownerIsTeam = true;
    assert.strictEqual((await w.siege(t, a)).held, base.held + 3, 'チームの持ち物の隣も数える');
    const all = w.neighborIds(t).map((id) => w.nodes.get(id)).filter(Boolean);
    const saved = all.map((m) => [m, m.owner, m.ownerIsTeam]);
    for (const m of all) if (!m.isPlayerNode) { m.owner = a.id; delete m.ownerIsTeam; }
    assert.ok((await w.siege(t, a)).need >= 1, 'どんなに囲んでも 1 回は正解が要る');
    for (const [m, o, it] of saved) { m.owner = o; if (it) m.ownerIsTeam = it; else delete m.ownerIsTeam; }
    for (const m of nb3) { m.owner = null; delete m.ownerIsTeam; }
    await w.leaveTeam(mate); await w.leaveTeam(a);
  }

  // 開始地点(第 3.1 節): 名前で検索でき、選んだ駅のまわりに拠点が生まれ、その駅とつながる。指定が無ければ東京駅
  const tokyoSt = NODES.find((n) => n.id === DEFAULT_START_ID); // 既定の開始地点: 東京駅の隣の町・字「丸の内」(2026-10-19)
  assert.ok(tokyoSt.name === '丸の内' && tokyoSt.genre === 'town' && tokyoSt.level <= 9, '既定の開始地点は丸の内(町・字)');
  assert.strictEqual(a.startNodeId, tokyoSt.id, '指定が無ければ丸の内');
  assert.ok(distanceKm(home, tokyoSt) <= 1.05 && w.adj.get(home.id).has(tokyoSt.id), '丸の内のまわりに生まれ、丸の内とつながる');
  const found = await w.search('japan', '高尾山口'); // 町・字が入って「高尾」だけでは同じ名前の町が多い
  assert.ok(found.some((r) => r.name === '高尾山口駅') && found.every((r) => typeof r.starters === 'number'), '名前の一部で検索できる');
  assert.strictEqual((await w.search('japan', '浅草寺')).length, 0, 'ハック不可の寺社は開始地点にできない');
  const takao = NODES.find((n) => n.name === '高尾山口駅' && n.region.startsWith('tokyo-')); // Lv1 の駅(開始地点にできる)
  const t1 = await w.join(fakeWs(), 'たかお', null, takao.id);
  const tHome = w.nodes.get(t1.homeNodeId);
  assert.ok(distanceKm(tHome, takao) <= 1.05, '選んだ駅のまわりに生まれる');
  assert.ok(w.adj.get(tHome.id).has(takao.id), '選んだ駅とつながる');
  assert.strictEqual((await w.search('japan', '高尾山口駅')).find((r) => r.id === takao.id).starters, 1, 'ここから始めた人数が付く(全国に同名の駅があるので id で引く)');
  const temple = NODES.find((n) => n.hackable === false);
  await assert.rejects(() => w.join(fakeWs(), 'だめ', null, temple.id), /選べません/);
  await assert.rejects(() => w.join(fakeWs(), 'だめ', null, 'st-nope'), /選べません/);
  // 開始地点にできるのは Lv1 の駅と町・字だけ(2026-10-19)。大きな駅(東京駅 Lv4)からは始められず、検索では近くの候補が付く
  const bigSt = NODES.find((n) => n.name === '東京駅');
  assert.ok(bigSt.level > 1);
  await assert.rejects(() => w.join(fakeWs(), 'おおきい', null, bigSt.id), /始められません/, 'Lv1 でない駅からは始められない');
  const sr = (await w.search('japan', '東京駅')).find((r) => r.id === bigSt.id);
  assert.ok(sr && sr.startable === false && sr.near.length >= 1 && sr.near.every((x) => x.genre === 'town' || (x.genre === 'station' && x.level <= 10)), '検索では選べない理由と近くの候補');
  assert.ok((await w.search('japan', '丸の内')).some((r) => r.id === DEFAULT_START_ID && r.startable), '丸の内は選べる');
  const before2 = w.players.size;
  await assert.rejects(() => w.join(fakeWs(), 'だめ', null, tHome.id), /選べません/, 'プレイヤーの拠点からは始められない');
  assert.strictEqual(w.players.size, before2, '失敗した参加はプレイヤーを残さない');
  // 自然に広がる: 同じ駅から大勢が始めても、間隔を守って半径が広がる(1 km まで)
  const okutama = NODES.find((n) => n.name === '白丸駅' && n.region.startsWith('tokyo-')); // 奥多摩の Lv1 の駅
  const homes = [];
  for (let i = 0; i < 25; i++) homes.push(w.nodes.get((await w.join(fakeWs(), `人${i}`, null, okutama.id)).homeNodeId));
  assert.ok(homes.every((h) => distanceKm(h, okutama) <= 1.05), '全員 1 km 以内');
  for (let i = 0; i < homes.length; i++) for (let j = i + 1; j < homes.length; j++) assert.ok(distanceKm(homes[i], homes[j]) >= 0.15 - 1e-6, '間隔 150 m を守る');
  assert.ok(Math.max(...homes.map((h) => distanceKm(h, okutama))) > 0.3, '混むと半径が広がる');
  assert.strictEqual((await w.search('japan', '白丸駅')).find((r) => r.id === okutama.id).starters, 25);
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
  const wsM = fakeWs();
  const mover = await w.join(wsM, 'ひっこし', null, tokyoSt.id);
  const mHome0 = w.nodes.get(mover.homeNodeId);
  const freeQ = (n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false && n.status === 'public' && hasGenerator(w.levelFor(n, 'attack')); // 問題のあるレベルの空き拠点(2026-10-19 から問題の無い拠点は占領できない)
  let mTarget = [...w.adj.get(mHome0.id)].map((id) => w.nodes.get(id)).find(freeQ);
  if (!mTarget) { // 隣が先の検証で取られていたら、近くの空き拠点とつなぐ
    mTarget = [...w.nodes.values()].filter(freeQ).sort((x, y) => distanceKm(x, mHome0) - distanceKm(y, mHome0))[0];
    w.addEdge(mHome0.id, mTarget.id, mHome0.t0); mover.reach = null;
  }
  for (let i = 0; i < mTarget.hits; i++) await solve(w, mover, mTarget.id);
  assert.strictEqual(mTarget.owner, mover.id); assert.strictEqual(mover.nodesOwned, 2);
  const beyond = [...w.adj.get(mTarget.id)].map((id) => w.nodes.get(id)).find((n) => n && !n.isPlayerNode && !n.owner && n.hackable !== false);
  assert.ok(await w.canAttack(mover.id, beyond.id), '線がつながっている所有拠点からは広げられる');
  await assert.rejects(() => w.move(mover, tokyoSt.id), /違う開始地点/);
  await assert.rejects(() => w.move(mover, bigSt.id), /始められません/, '引っ越し先も Lv1 の駅か町・字だけ');
  await w.setView(mover, tilesAround(takao.t0, 1), 0); // 画面で行き先の駅を選んだ(そのタイルは送り済み)
  const newHome = await w.move(mover, takao.id);
  // 画面は引っ越しで拠点を全部消して取り直す。選んだ駅と新しい拠点がもう一度届くこと(2026-10-19 の不具合)
  wsM.sent = [];
  await w.setView(mover, tilesAround(newHome.t0, 1), 0);
  { const m = last(wsM, 'tiles'); assert.ok(m.nodes.some((n) => n.id === takao.id) && m.nodes.some((n) => n.id === newHome.id), '引っ越し後、選んだ駅と新しい拠点が届く'); }
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
  // 引っ越し後に再起動しても(メモリに自分の拠点が無くても)、welcome は新しい拠点を返す。ホームボタンと最初の表示はこれを使う
  mover.movedAt = Date.now() - MOVE_INTERVAL_MS - 1000;
  const home3 = await w.move(mover, takao.id);
  const wFresh = await new World({ store, minAnswerMs: 0 }).init();
  const back = await wFresh.join(fakeWs(), null, mover.token);
  const wel = await wFresh.welcome(back);
  assert.ok(wel.home && wel.home.id === home3.id && wel.home.lat === home3.lat, '再起動後の welcome も引っ越し先の拠点を返す');
  assert.ok(distanceKm(wel.home, takao) <= 1.05, 'ホームは引っ越し先(高尾)のそば');

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

  // 航路(2026-10-19): 自分の拠点からたどれる空港を占領していれば、航路の先の空港(遠くてよい)を攻撃できる。占領していなければできない
  const hnd = NODES.find((n) => n.id === 'haneda');
  const cts = NODES.find((n) => n.name === '新千歳空港');
  const rp = await w.join(fakeWs(), 'こうろ', null, tokyoSt.id);
  await w.ensureTiles(tilesAround(hnd.t0, 1)); await w.ensureTiles(tilesAround(cts.t0, 1));
  const H = w.nodes.get(hnd.id), C2 = w.nodes.get(cts.id);
  assert.ok(H && C2 && H.level === 500, '羽田空港は国際線の拠点 Lv500');
  // 実際の航路(国土交通省 航空輸送統計 2025 年。server/map/data/routes/)に羽田–新千歳がある
  assert.ok(H.routes.some((r) => r.to === C2.id && r.mode === 'air' && r.metrics && r.metrics.passengers > 1000000), '羽田–新千歳の空路(年間の旅客数つき)');
  assert.ok(C2.routes.some((r) => r.to === H.id), '航路は接続なので両向き');
  assert.ok(!(await w.canAttack(rp.id, C2.id)), '空港を占領していなければ航路の先は攻撃できない');
  H.owner = rp.id; w.addEdge(rp.homeNodeId, H.id, w.nodes.get(rp.homeNodeId).t0); rp.reach = null;
  assert.ok(await w.canAttack(rp.id, C2.id), '占領した空港から空路の先を攻撃できる');
  assert.ok(!('routes' in w.pub(C2)) && !('routes' in w.pub(H)), '航路は全員には配らない(2026-10-22: 押さえてからでないと分からない)');
  { const mr = await w.myRoutes(rp); assert.ok(mr.t === 'myRoutes' && mr.ports.some((o) => o.id === H.id && o.routes.some((r) => r.to === C2.id && r.mode === 'air')), '押さえた空港の航路は持ち主に届く(myRoutes)'); }
  { const mr = await w.myRoutes(rp); assert.ok(!mr.ports.some((o) => o.id === C2.id), '押さえていない空港の航路は届かない'); }
  assert.strictEqual(C2.hits, Math.max(1, C2.adj.length + new Set(C2.routes.map((x) => x.to).filter((t) => !C2.adj.includes(t))).size), '航路も突破回数に数える(2026-10-19 ユーザー決定)');
  assert.ok(H.hits > H.adj.length + 30, '羽田は航路が多いので突破に要る回数も多い');
  const saved = [H.routes, C2.routes];
  H.routes = []; C2.routes = []; rp.reach = null;
  assert.ok(!(await w.canAttack(rp.id, C2.id)), '航路が無ければ遠くの空港は攻撃できない');
  [H.routes, C2.routes] = saved;
  H.owner = null; rp.reach = null;
  assert.ok(!(await w.canAttack(rp.id, C2.id)), '空港を手放すと航路の先は攻撃できない');

  // 季節航路(使える時間 UTC 3〜10 時。2026-10-19 ユーザー決定): 時間の中だけ航路の先を攻撃できる。伊東港 → 元町港(大島)で確かめる
  {
    const { routeOpen } = require('../server/map/routes');
    const ito = NODES.find((n) => n.name === '伊東港' && n.genre === 'port'), mot = NODES.find((n) => n.name === '元町港' && n.genre === 'port');
    const r = ito.routes.find((x) => x.to === mot.id);
    assert.ok(r && r.hours && r.hours[0].from === '03:00' && r.hours[0].to === '10:00', '伊東–大島は季節航路(UTC 3〜10 時)');
    await w.ensureTiles(tilesAround(ito.t0, 1)); await w.ensureTiles(tilesAround(mot.t0, 1));
    const sp = await w.join(fakeWs(), 'きせつ', null, tokyoSt.id);
    const I = w.nodes.get(ito.id);
    I.owner = sp.id; w.addEdge(sp.homeNodeId, I.id, w.nodes.get(sp.homeNodeId).t0); sp.reach = null;
    assert.strictEqual(await w.canAttack(sp.id, mot.id), routeOpen(r, Date.now()), '季節航路はサーバーの時計で使える時間の中だけ攻撃に使える');
    { const mr = await w.myRoutes(sp); const x = mr.ports.find((o) => o.id === I.id).routes.find((y) => y.to === mot.id); assert.ok(x.open === routeOpen(r, Date.now()) && x.hours, '持ち主に届く航路に、いま使えるか(open)と時間が付く'); }
    { const nb = await w.neighbors(I.id, sp); const x = nb.list.find((y) => y.id === mot.id); assert.ok(x && x.route && x.mode === 'sea' && x.open === routeOpen(r, Date.now()), '選んだ空港・港のつながり先にも航路の種類と open が付く'); }
    I.owner = null; sp.reach = null;
  }

  // 拠点の開いている時間(2026-10-19 ユーザー決定): 既定は 1 日中。時間の外は攻撃できない
  {
    const [nb0] = [...w.adj.get(home.id)].map((id) => w.nodes.get(id)).filter((n) => n && !n.owner && n.hackable !== false);
    if (nb0) {
      assert.deepStrictEqual(nb0.hours, [{ from: '00:00', to: '00:00' }], 'DB の拠点には開いている時間が入っている(既定は 1 日中)');
      assert.ok(await w.canAttack(a.id, nb0.id), '1 日中開いている拠点は攻撃できる');
      const h = new Date().getUTCHours(); const closed = (x) => String((h + x) % 24).padStart(2, '0') + ':00';
      const saved = nb0.hours; nb0.hours = [{ from: closed(2), to: closed(3) }]; // いまから 2〜3 時間後だけ開く
      assert.ok(!(await w.canAttack(a.id, nb0.id)), '開いている時間の外は攻撃できない');
      await assert.rejects(() => w.ask(a, nb0.id), /閉じています/);
      assert.ok(w.pub(nb0).hours && w.pub(nb0).open === false, '1 日中でない拠点は、時間といま開いているかを配信する');
      nb0.hours = saved;
      assert.ok(!('hours' in w.pub(nb0)), '1 日中の拠点は時間を配信しない');
    }
  }

  // 空港・港は占領されてから 5 分間は奪えない(2026-10-19 ユーザー決定)。問題のある Lv30 の港で確かめる
  {
    const portM = NODES.find((n) => n.genre === 'port' && n.level === 30 && n.hackable && n.status === 'public');
    await w.ensureTiles(tilesAround(portM.t0, 1));
    const P = w.nodes.get(portM.id);
    const gp = await w.join(fakeWs(), 'みなと', null, tokyoSt.id), gq = await w.join(fakeWs(), 'よこどり', null, tokyoSt.id);
    for (const x of [gp, gq]) { w.addEdge(x.homeNodeId, P.id, w.nodes.get(x.homeNodeId).t0); x.reach = null; x.cooldownUntil = 0; }
    P.progress = { [w.attackKey(gp)]: P.hits - 1 };
    await solve(w, gp, P.id);
    assert.strictEqual(P.owner, gp.id, '港を占領');
    assert.ok(P.protectedUntil > Date.now() + GATEWAY_GUARD_MS - 5000 && P.protectedUntil <= Date.now() + GATEWAY_GUARD_MS, '空港・港は占領から 5 分間守られる');
    assert.ok(!(await w.canAttack(gq.id, P.id)), '5 分間はほかの人が奪えない');
    P.protectedUntil = Date.now() - 1; gp.createdAt = Date.now() - NEWBIE_MS - 1000; // 初心者保護(3 拠点以下・7 日以内)とは別に確かめる
    assert.ok(await w.canAttack(gq.id, P.id), '5 分たてば奪える');
    P.owner = null; P.progress = {}; P.protectedUntil = 0; gp.reach = null; gq.reach = null;
  }

  // 問題の無いレベルの拠点は、線がつながっていても占領できない(2026-10-19)。羽田(Lv500)を航路で攻められる状態にして確かめる
  {
    const { hasGenerator } = require('../server/questions');
    assert.ok(!hasGenerator(500) && hasGenerator(10) && hasGenerator(30) && !hasGenerator(31));
    const qp = await w.join(fakeWs(), 'もんだい', null, tokyoSt.id);
    const Hn = w.nodes.get(hnd.id), Cn = w.nodes.get(cts.id);
    Hn.owner = qp.id; w.addEdge(qp.homeNodeId, Hn.id, w.nodes.get(qp.homeNodeId).t0); qp.reach = null;
    assert.ok(await w.canAttack(qp.id, Cn.id), '線(航路)はつながっている');
    await assert.rejects(() => w.ask(qp, Cn.id), /問題はまだありません/, 'Lv250 以上の問題は無いので占領できない');
    // 強化は、上げた先のレベルに問題があるときだけ(Lv30 → 31 は問題が無い)
    const lv30 = [...w.nodes.values()].find((n) => !n.isPlayerNode && n.hackable !== false && n.status === 'public' && n.level === 30);
    if (lv30) {
      const prevOwner = lv30.owner, prevDef = lv30.defense; lv30.owner = qp.id; lv30.defense = 0;
      await assert.rejects(() => w.ask(qp, lv30.id), /これ以上強化できません/, 'Lv31 の問題が無いので Lv30 からは強化できない');
      lv30.owner = prevOwner; lv30.defense = prevDef;
    }
    Hn.owner = null; qp.reach = null;
  }

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
  assert.ok(wrongEv.length >= 3 && wrongEv[0].detail.cooldownMs === COOLDOWN_MS && wrongEv[1].detail.cooldownMs === COOLDOWN_MS && wrongEv[1].detail.wrongStreak === 2 && wrongEv.every((e) => e.level >= 1 && typeof e.sec === 'number' && e.detail.mode === 'attack' && !('qid' in e)), '不正解の answer(待ち時間はいつも同じ。連続回数は記録する。qid は書かない)');
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
