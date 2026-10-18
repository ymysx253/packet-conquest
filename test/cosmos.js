'use strict';
// Cosmos 版の保存口の検証。接続文字列があるときだけ実行し、無ければ何もせず通す。
// 本番のデータベースに書かないよう、必ず別のデータベース(既定 pc-test)を使い、終わったら消す。
const assert = require('assert');
const path = require('path');
const { loadEnv } = require('../server/env');
loadEnv(path.join(__dirname, '..', '.env'));

if (!process.env.COSMOS_CONNECTION_STRING) {
  console.log('cosmos skipped: COSMOS_CONNECTION_STRING が無いので実行しません');
  process.exit(0);
}

const { CosmosStore } = require('../server/store-cosmos');
const { World } = require('../server/world');
const { nodeDocs, regionDocs } = require('../server/map/load');
const tokyo = require('../server/map/tokyo');
const { tilesAround } = require('../server/map/geo');

const fakeWs = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} });
const dbName = process.env.COSMOS_TEST_DATABASE || 'pc-test';

(async () => {
  const store = new CosmosStore({ connectionString: process.env.COSMOS_CONNECTION_STRING, database: dbName });
  await store.ensure();
  try {
    // シード(空なら)
    if ((await store.countNodes()) === 0) await store.seedNodes(nodeDocs(tokyo.NODES));
    await store.seedRegions(regionDocs(tokyo.NODES));
    assert.strictEqual(await store.countNodes(), tokyo.NODES.length, '全拠点が入る');

    // タイルの読み込み
    const home = tokyo.NODES.find((n) => n.name === '東京駅');
    const around = await store.loadTiles('japan', tilesAround(home.t0, 1), 1);
    assert.ok(around.length > 20 && around.some((n) => n.id === home.id), '周辺のタイルから東京駅が読める');
    const lv4 = await store.loadTiles('japan', [home.t2], 4);
    assert.ok(lv4.length > 0 && lv4.every((n) => n.level >= 4), '粗いタイルで Lv4 以上だけ');
    assert.strictEqual((await store.loadTiles('nowhere', [home.t0], 1)).length, 0, '別の国では読めない');

    // ワールドを通した参加・奪取・復元
    const w = await new World({ store }).init();
    const ws = fakeWs();
    const a = await w.join(ws, 'テスト', null);
    assert.ok(a.homeNodeId && (await store.loadNode(a.homeNodeId)), 'プレイヤーの拠点が保存される');
    assert.ok((await store.findPlayerByToken(a.token)).id === a.id, '復帰コードで引ける');
    const [nb] = [...w.adj.get(a.homeNodeId)];
    const hits = w.nodes.get(nb).hits;
    for (let i = 0; i < hits; i++) { const q = await w.ask(a, nb); await w.answer(a, q.qid, a.pending.answerIndex); }
    const saved = await store.loadNode(nb);
    assert.strictEqual(saved.owner, a.id, `奪取が保存される(${hits} 回)`);
    const reg = await store.loadRegion(saved.region);
    assert.ok(reg && reg.control && reg.control.total > 0, '地域の支配の集計が保存される');
    assert.ok((await store.countOwners('japan', saved.region)).byOwner[a.id] >= 1, '所有者の集計(GROUP BY)が動く');
    // 休眠の回収(Cosmos のクエリと削除が動くこと)
    const idle = await w.join(fakeWs(), 'きゅうみん', null);
    await w.disconnect(idle);
    await w.tick(); w.uptime += 8 * 24 * 3600 * 1000; await w.tick();
    assert.ok((await store.loadMeta('clock')).uptimeMs >= 8 * 24 * 3600 * 1000, '稼働時計が保存される');
    await w.touch(a); await w.persistPlayer(a);
    assert.strictEqual(await w.reclaimIdle(), 1, '休眠を回収');
    assert.ok(!(await store.loadPlayer(idle.id)) && !(await store.loadNode(idle.homeNodeId)), 'アカウントと拠点が消える');
    assert.ok(await store.loadPlayer(a.id), '接続中の人は残る');
    // ランキングとチーム(Cosmos のクエリが動くこと)
    const t = await w.createTeam(a, 'テストチーム', 5);
    const rk = await w.rankings();
    assert.ok(rk.score.some((x) => x.id === a.id) && rk.teams.some((x) => x.id === t.id && x.members === 1), 'ランキングとチーム集計(GROUP BY SUM)');
    await w.leaveTeam(a);
    // 検索と人数
    const hits2 = await store.searchNodes('japan', '東京', 5);
    assert.ok(hits2.length > 0 && hits2[0].level >= hits2[hits2.length - 1].level, '検索はレベル順');
    assert.ok((await store.countStarters([a.startNodeId]))[a.startNodeId] >= 1, 'ここから始めた人数');
    const top = await store.topPlayers(3);
    assert.ok(top.some((p) => p.id === a.id), 'ランキングに出る');
    // 別のワールド(再起動相当)で復元
    const w2 = await new World({ store }).init();
    const b = await w2.join(fakeWs(), 'テスト', a.token);
    assert.strictEqual(b.id, a.id); assert.strictEqual(b.nodesOwned, 2);
    console.log(`cosmos ok: database ${dbName}, ${await store.countNodes()} nodes`);
  } finally {
    // テスト用データベースは消す(本番 packet-conquest には触らない)
    if (dbName !== 'packet-conquest') { await store.db.delete(); console.log(`cosmos: テスト用データベース ${dbName} を削除`); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
