'use strict';
// 公開データに無い航路を、手で確かめた一覧から入れる(2026-10-19 ユーザー決定。docs/routes/README.md の「手で足した航路」)。
// 何度実行しても同じ結果になる。
//
// 使い方:
//   node tools/import-hand-routes.js
// 読むもの:
//   docs/routes/hand-ports.csv   手で足す港(id は hp-<Wikidata の id>。位置は Wikidata(CC0))
//   docs/routes/hand-routes.csv  手で足す航路(港の id の組。確認元と確認日を必ず書く)
// 書くもの:
//   都道府県の拠点マスター(hp- の拠点を入れ直す)、server/map/data/routes/src-internal.json(丸ごと書き直す)
// 順番: … → import-gateways → **import-hand-routes** → import-tourism → import-towns → import-water → fetch-codes → import-links → build-sea-paths
//
// 決まり:
//   - 航路の「どの港とどの港が結ばれているか」という事実だけを入れる。時刻表・運賃・文章は写さない。運航会社の名前は画面に出さない(2026-10-19 決定)
//   - 出典は手作り(src-internal)。どの公開情報で確かめたかを確認元に残す
const fs = require('fs');
const path = require('path');
const { routeId } = require('../server/map/routes');
const { L } = require('./levels');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const SRC = 'src-internal';
const TODAY = new Date().toISOString().slice(0, 10);

const readCsv = (file) => {
  const [head, ...rows] = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.split(','));
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
};
const ports = readCsv('docs/routes/hand-ports.csv');
const routes = readCsv('docs/routes/hand-routes.csv');

// ---------- 港(hp-)を入れ直す ----------
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const files = new Map();
for (const r of R.regions.filter((x) => x.nodeFile)) files.set(r.id, { file: path.join(DATA, `${r.nodeFile}.json`) });
for (const f of files.values()) { f.T = JSON.parse(fs.readFileSync(f.file, 'utf8')); f.before = f.T.nodes.length; f.T.nodes = f.T.nodes.filter((n) => !n.id.startsWith('hp-')); }
for (const p of ports) {
  if (!/^hp-q[0-9]+$/.test(p.id)) throw new Error(`手で足す港の id は hp-q<Wikidata の番号>: ${p.id}`);
  const f = files.get(p['都道府県']);
  if (!f) throw new Error(`${p.id}: 都道府県 ${p['都道府県']} の拠点マスターが無い`);
  if (!R.regions.some((r) => r.id === p['地域'])) throw new Error(`${p.id}: 地域 ${p['地域']} が無い`);
  if (!p['確認元'] || !p['確認日']) throw new Error(`${p.id}: 確認元と確認日を書く`);
  f.T.nodes.push({
    id: p.id, name: p['名前'], genre: 'port', kind: 'GW', area: p['市区町村'], region: p['地域'],
    lat: Number(Number(p['緯度']).toFixed(5)), lon: Number(Number(p['経度']).toFixed(5)), level: L.PORT_MIN, value: L.PORT_MIN,
    codes: { wikidata: p.Wikidata }, src: 'src-wikidata', gateway: { type: 'port', scope: 'domestic' },
  });
}
const order = Object.fromEntries(R.regions.map((r, i) => [r.id, i]));
const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
const writeList = (headObj, items) => {
  let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, ',\n  "nodes": [\n');
  let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it.area ? '\n' : ''; prev = it.area; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
};
for (const f of files.values()) {
  const changed = f.T.nodes.some((n) => n.id.startsWith('hp-')) || f.before !== f.T.nodes.length;
  if (!changed) continue;
  f.T.nodes = f.T.nodes.map((n, i) => ({ n, i })).sort((a, b) => (order[a.n.region] - order[b.n.region]) || ((a.n.genre === 'station') - (b.n.genre === 'station')) || (a.i - b.i)).map((x) => x.n);
  f.T.version = (f.T.version || 0) + 1; f.T.updatedAt = TODAY;
  const { nodes, ...headObj } = f.T;
  fs.writeFileSync(f.file, writeList(headObj, nodes));
}

// ---------- 航路(src-internal.json) ----------
const known = new Set([...files.values()].flatMap((f) => f.T.nodes.map((n) => n.id)));
const out = routes.map((r, i) => {
  for (const k of ['港A', '港B']) if (!known.has(r[k])) throw new Error(`手で足す航路 ${i + 1} 行目: 港 ${r[k]} が拠点マスターに無い`);
  if (!r['確認元'] || !r['確認日']) throw new Error(`手で足す航路 ${i + 1} 行目: 確認元と確認日を書く`);
  const rec = {
    mode: r['種類'] || 'sea', from: r['港A'], to: r['港B'], fromRef: { scheme: 'internal', value: r['港A'] }, toRef: { scheme: 'internal', value: r['港B'] },
    bidirectional: true, scope: 'domestic', serviceTypes: ['passenger'], status: r['状態'] || 'active',
    src: SRC, sourceRecordId: `hand-routes-${i + 1}`, retrievedAt: r['確認日'], evidence: r['確認元'], ...(r['メモ'] ? { note: r['メモ'] } : {}),
  };
  rec.id = routeId({ src: rec.src, mode: rec.mode, from: rec.from, to: rec.to });
  return rec;
});
const body = out.sort((a, b) => a.id.localeCompare(b.id)).map((r) => '    ' + JSON.stringify(r)).join(',\n');
fs.writeFileSync(path.join(DATA, 'routes', `${SRC}.json`), `{\n  "schema": "pc.routes/1",\n  "source": "${SRC}",\n  "generatedAt": "${new Date().toISOString()}",\n  "routes": [\n${body}\n  ]\n}\n`);
console.log(`手で足した港 ${ports.length} か所、航路 ${out.length} 件(server/map/data/routes/${SRC}.json)`);
