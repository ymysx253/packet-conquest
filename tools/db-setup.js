'use strict';
// Cosmos DB のデータベースとコンテナーを作り(あれば使う)、拠点マスターと地域マスターを流し込む。
//
// 使い方(接続文字列は .env か環境変数 COSMOS_CONNECTION_STRING に。Git には入れない):
//   node tools/db-setup.js                 # COSMOS_DATABASE(既定 packet-conquest)に対して
//   node tools/db-setup.js --db pc-dev     # 手元の確認用
//   node tools/db-setup.js --db pc-dev --force   # 拠点マスターを上書き(ゲーム状態 owner/defense は保つ)
const path = require('path');
const { loadEnv } = require('../server/env');
loadEnv(path.join(__dirname, '..', '.env'));
const { CosmosStore } = require('../server/store-cosmos');
const { nodeDocs, regionDocs } = require('../server/map/load');
const tokyo = require('../server/map/tokyo');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const dbName = flag('--db') || process.env.COSMOS_DATABASE || 'packet-conquest';
const force = !!flag('--force');

(async () => {
  const store = new CosmosStore({ connectionString: process.env.COSMOS_CONNECTION_STRING, database: dbName });
  console.log(`データベース ${dbName} を準備します(無ければ作成。共有 1000 RU/s)…`);
  await store.ensure();
  console.log('コンテナー: nodes(/country,/region) regions(/parent) players(/id) questions(/nodeId)');

  // 地域: いつも上書き(派生値が変わるため)
  const regions = regionDocs(tokyo.NODES);
  await store.seedRegions(regions);
  console.log(`regions: ${regions.length} 件を保存`);

  // 拠点: 空なら全部入れる。--force のときはマスター項目だけ上書きし、ゲーム状態は保つ
  const count = await store.countNodes();
  const docs = nodeDocs(tokyo.NODES);
  if (count === 0) {
    await store.seedNodes(docs);
    console.log(`nodes: ${docs.length} 件を保存(初回)`);
  } else if (force) {
    let updated = 0;
    for (const d of docs) {
      const cur = await store.loadNode(d.id);
      const merged = cur ? { ...d, owner: cur.owner, defense: cur.defense, protectedUntil: cur.protectedUntil, createdAt: cur.createdAt, sponsorId: cur.sponsorId || null } : d;
      await store.saveNode(merged); updated++;
    }
    console.log(`nodes: ${updated} 件のマスター項目を更新(ゲーム状態は維持)。既存 ${count} 件`);
  } else {
    console.log(`nodes: すでに ${count} 件あるので何もしません(--force でマスター項目を更新)`);
  }
  console.log('完了');
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
