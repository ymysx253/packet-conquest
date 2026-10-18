'use strict';
// Cosmos DB のデータベースとコンテナーを作り(あれば使う)、拠点マスターと地域マスターを流し込む。
//
// 使い方(接続文字列は .env か環境変数 COSMOS_CONNECTION_STRING に。Git には入れない):
//   node tools/db-setup.js                 # COSMOS_DATABASE(既定 packet-conquest)に対して
//   node tools/db-setup.js --db pc-dev     # 手元の確認用
//   node tools/db-setup.js --db pc-dev --force   # 拠点マスターを上書き(ゲーム状態 owner/defense/progress は保つ)。adj を入れ直すときもこれ
//
// 2026-10-19: 全国(約 9,000 拠点・2,000 地域)向けに、既存の状態を 1 回の問い合わせでまとめて読み、10 件ずつ並列で書くようにした。
// マスターから消えた固定拠点(取り込み直しで統合された駅など)は、誰も持っていなければ削除する。持ち主がいるものは残して一覧を出す。
const path = require('path');
const { loadEnv } = require('../server/env');
loadEnv(path.join(__dirname, '..', '.env'));
const { CosmosStore } = require('../server/store-cosmos');
const { nodeDocs, regionDocs } = require('../server/map/load');
const all = require('../server/map/all');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const dbName = flag('--db') || process.env.COSMOS_DATABASE || 'packet-conquest';
const force = !!flag('--force');
const PARALLEL = 10; // 無料枠の 1000 RU/s に収める(SDK が 429 を自動で再試行する)

async function inChunks(items, fn) {
  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(items.slice(i, i + PARALLEL).map(fn));
    if ((i / PARALLEL) % 50 === 0 && i) process.stdout.write(`  … ${i}/${items.length}\n`);
  }
}

(async () => {
  const store = new CosmosStore({ connectionString: process.env.COSMOS_CONNECTION_STRING, database: dbName });
  console.log(`データベース ${dbName} を準備します(無ければ作成。共有 1000 RU/s)…`);
  await store.ensure();

  // 地域: マスター項目はいつも上書き(派生値が変わるため)。支配の集計(control)は保つ
  const regions = regionDocs(all.NODES);
  const curRegions = new Map((await store.loadRegions()).map((r) => [r.id, r]));
  for (const d of regions) { const cur = curRegions.get(d.id); if (cur && cur.control) d.control = cur.control; }
  await inChunks(regions, (d) => store.c.regions.items.upsert(d));
  console.log(`regions: ${regions.length} 件を保存(支配の集計は維持)`);

  // 拠点: 空なら全部入れる。--force のときはマスター項目だけ上書きし、ゲーム状態は保つ
  const count = await store.countNodes();
  const docs = nodeDocs(all.NODES);
  if (count === 0) {
    await inChunks(docs, (d) => store.c.nodes.items.upsert(d));
    console.log(`nodes: ${docs.length} 件を保存(初回)`);
  } else if (force) {
    const existing = new Map();
    const it = store.c.nodes.items.query('SELECT c.id, c.country, c.region, c.isPlayerNode, c.owner, c.defense, c.fortifiedAt, c.progress, c.protectedUntil, c.createdAt, c.sponsorId FROM c');
    for (const { resources } of [await it.fetchAll()]) for (const r of resources) existing.set(r.id, r);
    const merged = docs.map((d) => {
      const cur = existing.get(d.id);
      return cur ? { ...d, owner: cur.owner || null, defense: cur.defense || 0, fortifiedAt: cur.fortifiedAt || null, progress: cur.progress || {}, protectedUntil: cur.protectedUntil || 0, createdAt: cur.createdAt || d.createdAt, sponsorId: cur.sponsorId || null } : d;
    });
    await inChunks(merged, (d) => store.c.nodes.items.upsert(d));
    const added = docs.filter((d) => !existing.has(d.id)).length;
    // マスターから消えた固定拠点(プレイヤーの拠点は対象外)
    const ids = new Set(docs.map((d) => d.id));
    const stale = [...existing.values()].filter((r) => !r.isPlayerNode && !ids.has(r.id));
    const removable = stale.filter((r) => !r.owner);
    const kept = stale.filter((r) => r.owner);
    await inChunks(removable, (r) => store.c.nodes.item(r.id, [r.country, r.region]).delete().catch((e) => { if (e.code !== 404) throw e; }));
    console.log(`nodes: ${merged.length} 件のマスター項目を保存(新規 ${added}、ゲーム状態は維持)。マスターから消えた拠点 ${stale.length} 件のうち ${removable.length} 件を削除`);
    if (kept.length) console.log(`  持ち主がいるため残した拠点: ${kept.map((r) => `${r.id}(${r.owner})`).join(', ')}`);
  } else {
    console.log(`nodes: すでに ${count} 件あるので何もしません(--force でマスター項目を更新)`);
  }
  console.log('完了');
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
