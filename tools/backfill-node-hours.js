'use strict';
// 一度だけの移し替え(2026-10-19): DB の拠点に「開いている時間」(hours)を足す。既定は 1 日中(00:00-00:00)。
// すでに hours を持っている拠点(設定画面で変えたものなど)には触らない。何度実行しても同じ結果になる。
//
// 使い方:
//   node tools/backfill-node-hours.js                # COSMOS_DATABASE(既定 packet-conquest)
//   node tools/backfill-node-hours.js --db pc-dev
// 文書を丸ごと書き直すと全国 11 万件で 1 時間半かかるので、項目を足すだけの部分更新(patch)で行う。
const path = require('path');
const { loadEnv } = require('../server/env');
loadEnv(path.join(__dirname, '..', '.env'));
const { CosmosStore } = require('../server/store-cosmos');
const { ALWAYS_OPEN } = require('../server/map/routes');

const args = process.argv.slice(2);
const i = args.indexOf('--db');
const dbName = (i >= 0 && args[i + 1]) || process.env.COSMOS_DATABASE || 'packet-conquest';
const PARALLEL = 10; // 無料枠の 1000 RU/s に収める(SDK が 429 を自動で再試行する)

(async () => {
  const store = new CosmosStore({ connectionString: process.env.COSMOS_CONNECTION_STRING, database: dbName });
  await store.ensure();
  const { resources: todo } = await store.c.nodes.items.query('SELECT c.id, c.country, c.region FROM c WHERE NOT IS_DEFINED(c.hours)').fetchAll();
  console.log(`データベース ${dbName}: 開いている時間の無い拠点 ${todo.length} 件に 00:00-00:00 を足します`);
  const value = ALWAYS_OPEN.map((h) => ({ ...h }));
  let done = 0;
  for (let k = 0; k < todo.length; k += PARALLEL) {
    await Promise.all(todo.slice(k, k + PARALLEL).map((r) => store.c.nodes.item(r.id, [r.country, r.region]).patch([{ op: 'add', path: '/hours', value }])
      .catch((e) => { if (e.code !== 404) throw e; })));
    done = Math.min(todo.length, k + PARALLEL);
    if ((k / PARALLEL) % 500 === 0 && k) console.log(`  … ${done}/${todo.length}`);
  }
  console.log(`完了: ${done} 件`);
})().catch((e) => { console.error(e); process.exit(1); });
