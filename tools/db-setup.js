'use strict';
// Cosmos DB のデータベースとコンテナーを作り(あれば使う)、拠点マスターと地域マスターを流し込む。
//
// 使い方(接続文字列は .env か環境変数 COSMOS_CONNECTION_STRING に。Git には入れない):
//   node tools/db-setup.js                 # COSMOS_DATABASE(既定 packet-conquest)に対して
//   node tools/db-setup.js --db pc-dev     # 手元の確認用
//   node tools/db-setup.js --db pc-dev --force   # 拠点マスターを上書き(ゲーム状態 owner/defense/progress は保つ)。adj を入れ直すときもこれ
//   node tools/db-setup.js --force --dry-run     # 書く・消す件数を数えるだけ(何も書かない。本番の前に)
//
// 2026-10-19: 全国(約 9,000 拠点・2,000 地域)向けに、既存の状態を 1 回の問い合わせでまとめて読み、10 件ずつ並列で書くようにした。
// マスターから消えた固定拠点(取り込み直しで統合された駅など)は、誰も持っていなければ削除する。持ち主がいるものは残して一覧を出す。
const path = require('path');
const crypto = require('crypto');
const { loadEnv } = require('../server/env');
loadEnv(path.join(__dirname, '..', '.env'));
const { CosmosStore } = require('../server/store-cosmos');
const { nodeDocs, regionDocs } = require('../server/map/load');
const all = require('../server/map/all');
const { loadSources } = require('../server/map/sources');
const { readRouteFiles } = require('../server/map/routes');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const dbName = flag('--db') || process.env.COSMOS_DATABASE || 'packet-conquest';
const force = !!flag('--force');
const dryRun = !!flag('--dry-run'); // --force と一緒に: 何を書く・消すかを数えるだけで書かない(本番の前の確かめ)

// --force のときの計画(DB を読んだ結果 rows とマスター docs から、書く文書と消す文書を決める。DB に触らない。test/db-setup.js が確かめる)。
// 同じ id の文書が 2 つ以上あることがある(地域が変わったとき古い文書が消えずに残った。2026-10-25 に本番で 2 件見つかった)。
//   - ゲームの状態を引き継ぐ元(主): 持ち主のいる文書 → マスターと同じ地域の文書 → 新しい(updatedAt)文書 の順で選ぶ
//   - マスターと違う地域にある文書は全部消す(主が違う地域にあれば、その状態を引き継いでマスターの地域に書き直す)
//   - マスターから消えた固定拠点は、誰も持っていなければ消す(持ち主がいれば残して一覧を出す)
function planNodes(docs, rows) {
  const byId = new Map();
  for (const r of rows) (byId.get(r.id) || byId.set(r.id, []).get(r.id)).push(r);
  const samePart = (r, d) => r.country === d.country && r.region === d.region;
  const upserts = [], deletes = []; let added = 0, moved = 0, unchanged = 0, movedDeletes = 0, dupDeletes = 0;
  for (const d of docs) {
    const list = byId.get(d.id) || [];
    if (!list.length) { upserts.push(d); added++; continue; }
    const primary = list.slice().sort((a, b) => (!!b.owner - !!a.owner) || (samePart(b, d) - samePart(a, d)) || ((b.updatedAt || 0) - (a.updatedAt || 0)))[0];
    const others = list.filter((r) => !samePart(r, d));
    for (const r of others) { deletes.push(r); if (r === primary) movedDeletes++; else dupDeletes++; }
    const wasMoved = !samePart(primary, d);
    if (wasMoved) moved++;
    const sameDoc = list.find((r) => samePart(r, d));
    if (!wasMoved && sameDoc === primary && primary.masterHash === d.masterHash) { unchanged++; continue; }
    // ゲーム状態は保つ(チームの持ち物 ownerIsTeam と、取ったときのチーム capturedTeam も。2026-10-20)
    const cur = primary;
    upserts.push({ ...d, hours: cur.hours || d.hours, owner: cur.owner || null, defense: cur.defense || 0, fortifiedAt: cur.fortifiedAt || null, progress: cur.progress || {}, protectedUntil: cur.protectedUntil || 0, ...(cur.ownerIsTeam ? { ownerIsTeam: true } : {}), ...(cur.capturedTeam ? { capturedTeam: cur.capturedTeam } : {}), createdAt: cur.createdAt || d.createdAt, sponsorId: cur.sponsorId || null });
  }
  const ids = new Set(docs.map((d) => d.id));
  const stale = rows.filter((r) => !r.isPlayerNode && !ids.has(r.id));
  const removable = stale.filter((r) => !r.owner);
  deletes.push(...removable);
  return { upserts, deletes, kept: stale.filter((r) => r.owner), added, moved, unchanged, movedDeletes, dupDeletes, staleDeletes: removable.length };
}
if (require.main !== module) { module.exports = { planNodes }; return; }
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
  if (dryRun) console.log(`regions: ${regions.length} 件(--dry-run なので書かない)`);
  else { await inChunks(regions, (d) => store.c.regions.items.upsert(d)); console.log(`regions: ${regions.length} 件を保存(支配の集計は維持)`); }

  // 拠点: 空なら全部入れる。--force のときはマスター項目だけ上書きし、ゲーム状態は保つ
  const count = await store.countNodes();
  // マスター項目の指紋(2026-10-19): 全国 11 万件を毎回書き直すと 1 時間半かかるので、中身が変わった拠点だけ書く
  // 開いている時間(hours)は DB で管理する設定なので指紋に入れない(設定画面で変えても、マスターの入れ直しで上書きしない。2026-10-19)
  const masterHash = (d) => crypto.createHash('sha1').update(JSON.stringify({ ...d, hours: undefined, createdAt: 0, updatedAt: 0 })).digest('hex').slice(0, 16);
  const docs = nodeDocs(all.NODES).map((d) => ({ ...d, masterHash: masterHash(d) }));
  if (count === 0) {
    await inChunks(docs, (d) => store.c.nodes.items.upsert(d));
    console.log(`nodes: ${docs.length} 件を保存(初回)`);
  } else if (force) {
    const it = store.c.nodes.items.query('SELECT c.id, c.country, c.region, c.isPlayerNode, c.owner, c.defense, c.fortifiedAt, c.progress, c.protectedUntil, c.ownerIsTeam, c.capturedTeam, c.createdAt, c.updatedAt, c.sponsorId, c.hours, c.masterHash FROM c');
    const { resources: rows } = await it.fetchAll();
    const plan = planNodes(docs, rows);
    console.log(`nodes: 書く ${plan.upserts.length} 件(新規 ${plan.added}・地域が変わった ${plan.moved}・変わらなかった ${plan.unchanged} 件は書かない)、消す ${plan.deletes.length} 件(地域が変わった古い文書 ${plan.movedDeletes}・同じ id の古い写し ${plan.dupDeletes}・マスターから消えた ${plan.staleDeletes})`);
    if (plan.kept.length) console.log(`  持ち主がいるため残した拠点: ${plan.kept.map((r) => `${r.id}(${r.owner})`).join(', ')}`);
    if (dryRun) { console.log('  --dry-run なので書かない。消す文書: ' + plan.deletes.slice(0, 20).map((r) => `${r.id}@${r.region}`).join(', ')); process.exit(0); }
    // 先に古い文書を消してから書く(地域が変わった拠点は、上書きでは別の文書が増えるため)
    await inChunks(plan.deletes, (r) => store.c.nodes.item(r.id, [r.country, r.region]).delete().catch((e) => { if (e.code !== 404) throw e; }));
    await inChunks(plan.upserts, (d) => store.c.nodes.items.upsert(d));
    console.log('nodes: 保存しました(ゲーム状態は維持)');
  } else {
    console.log(`nodes: すでに ${count} 件あるので何もしません(--force でマスター項目を更新)`);
  }
  // 出典の台帳(docs/DATA-FORMAT.md 第 2・7 章): meta に 1 件で写す
  const S = loadSources();
  await store.c.meta.items.upsert({ id: 'sources', schema: 'pc.sources/1', sources: S.SOURCES, syncedAt: new Date().toISOString() });
  console.log(`meta/sources: 出典 ${S.SOURCES.length} 件を保存`);

  // 航路の記録(第 5・7 章): 出典ごとに差し替える。ファイルから消えた記録は削除する
  for (const { name, data } of readRouteFiles()) {
    const recs = data.routes.map((r) => ({ ...r, source: data.source }));
    const { resources: cur } = await store.c.routes.items.query({ query: 'SELECT c.id FROM c WHERE c.source = @s', parameters: [{ name: '@s', value: data.source }] }, { partitionKey: data.source }).fetchAll();
    const keep = new Set(recs.map((r) => r.id));
    await inChunks(recs, (d) => store.c.routes.items.upsert(d));
    const gone = cur.filter((r) => !keep.has(r.id));
    await inChunks(gone, (r) => store.c.routes.item(r.id, data.source).delete().catch((e) => { if (e.code !== 404) throw e; }));
    console.log(`routes: ${name} の ${recs.length} 件を保存、${gone.length} 件を削除`);
  }
  console.log('完了');
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
