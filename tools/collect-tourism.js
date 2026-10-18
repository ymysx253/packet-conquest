'use strict';
// 観光地の候補を Wikidata(CC0)から集めて一覧にする(2026-10-19)。拠点マスターには入れない。人が一覧を見て決めてから取り込む。
// 国土数値情報の観光資源データ(P12)は使用許諾が「非商用」なので使わない。
//
// 使い方:
//   node tools/collect-tourism.js <N03 の GeoJSON が入ったフォルダ> [作業フォルダ]
//
// 出力: docs/tourism/candidates.csv(1 行 1 候補)、docs/tourism/summary.json、docs/tourism/README.md(種類別・都道府県別の件数)
const fs = require('fs');
const path = require('path');
const https = require('https');

const [, , n03Dir, workDir = path.join(require('os').tmpdir(), 'pc-tourism')] = process.argv;
if (!n03Dir) { console.error('使い方: node tools/collect-tourism.js <N03 フォルダ> [作業フォルダ]'); process.exit(1); }
fs.mkdirSync(workDir, { recursive: true });
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const OUT = path.join(ROOT, 'docs/tourism');
const UA = 'PacketConquest/0.1 (tourism candidates; https://github.com/ymysx253/packet-conquest)';
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 日本時間の日付

// 観光地の種類(Wikidata のクラス。P31 が直接このクラスのもの)
const KINDS = [
  { kind: 'onsen', label: '温泉', cls: ['Q655311', 'Q4946461'] },
  { kind: 'scenic', label: '景勝地・展望', cls: ['Q106695446', 'Q177305', 'Q6017969', 'Q11668898', 'Q3240227', 'Q25391', 'Q7558985', 'Q838625', 'Q2042028'] },
  { kind: 'waterfall', label: '滝', cls: ['Q34038'] },
  { kind: 'cape', label: '岬・海岸', cls: ['Q185113', 'Q93352', 'Q18751767', 'Q11959973'] },
  { kind: 'pass', label: '峠', cls: ['Q133056'] },
  { kind: 'roadside', label: '道の駅', cls: ['Q1187691'] },
  { kind: 'ski', label: 'スキー場・キャンプ場', cls: ['Q130003', 'Q832778'] },
  { kind: 'lighthouse', label: '灯台', cls: ['Q39715'] },
];
// 指定・百選(P1435 文化財の指定、P361 一部、P5008 一覧)。種類の目印として付け、名勝と伝建地区は候補にも入れる
const DESIGNATIONS = [
  { label: '特別名勝', q: 'Q94987823', add: 'scenic' }, { label: '名勝', q: 'Q11414752', add: 'scenic' },
  { label: '重要伝統的建造物群保存地区', q: 'Q850649', add: 'townscape' }, { label: '世界遺産', q: 'Q9259' },
  { label: '日本三景', q: 'Q1144867' }, { label: '日本百景', q: 'Q2806722' }, { label: '日本の滝百選', q: 'Q40172600' }, { label: '名水百選', q: 'Q10917783' },
  { label: '日本さくら名所100選', q: 'Q10312216' }, { label: '日本の道100選', q: 'Q11506119' }, { label: '日本の棚田百選', q: 'Q85719567' }, { label: '日本の渚百選', q: 'Q11506004' },
];
const KIND_LABEL = Object.fromEntries([...KINDS.map((k) => [k.kind, k.label]), ['townscape', '町並み(伝建地区)']]);

function sparql(query) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeout: 120000 }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(body).results.bindings); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const point = (v) => { const m = /Point\(([-0-9.]+) ([-0-9.]+)\)/.exec(v || ''); return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null; };
async function cached(name, query) {
  const f = path.join(workDir, `${name}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  let rows = null;
  for (let i = 0; i < 3 && !rows; i++) { try { rows = await sparql(query); } catch (e) { console.log(`  ${name}: ${e.message}(やり直し)`); await wait(3000); } }
  if (!rows) throw new Error(`${name} が取れない`);
  fs.writeFileSync(f, JSON.stringify(rows)); await wait(800);
  return rows;
}
// 項目の基本(名前・座標・知名度・運営者が企業か)
const itemQuery = (where) => `SELECT ?item ?ja ?coord ?sl ?opIsCompany WHERE {
  ${where} ?item wdt:P17 wd:Q17; wdt:P625 ?coord; wikibase:sitelinks ?sl.
  ?item rdfs:label ?ja. FILTER(LANG(?ja) = "ja")
  OPTIONAL { ?item wdt:P137|wdt:P127 ?op. ?op wdt:P31/wdt:P279* wd:Q4830453. BIND(true AS ?opIsCompany) }
}`;

// ---------- 行政区域(位置から都道府県・市区町村) ----------
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const regionByCode = new Map(R.regions.filter((r) => r.kind === 'city' && r.code).map((r) => [r.code.split('-').pop(), r]));
const prefById = new Map(R.regions.filter((r) => r.kind === 'state').map((r) => [r.id, r]));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /^N03-[0-9]{8}_[0-9]{2}\.geojson$/.test(e.name) ? [path.join(d, e.name)] : []));
const rings = [];
for (const f of walk(n03Dir)) for (const ft of JSON.parse(fs.readFileSync(f, 'utf8')).features) {
  const code = ft.properties.N03_007; if (!code) continue;
  for (const poly of ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates) {
    const ring = poly[0]; const bb = [180, 90, -180, -90];
    for (const [x, y] of ring) { if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; }
    rings.push({ code, ring, bb });
  }
}
const pir = ([x, y], ring) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
const regionAt = (p) => { const h = rings.find((r) => p.lon >= r.bb[0] && p.lon <= r.bb[2] && p.lat >= r.bb[1] && p.lat <= r.bb[3] && pir([p.lon, p.lat], r.ring)); return h ? regionByCode.get(h.code) || null : null; };

// ---------- いまの拠点(重なりの判定) ----------
const nodes = R.regions.filter((r) => r.nodeFile).flatMap((r) => JSON.parse(fs.readFileSync(path.join(DATA, `${r.nodeFile}.json`), 'utf8')).nodes);
const byQid = new Map(nodes.filter((n) => n.codes && n.codes.wikidata).map((n) => [n.codes.wikidata, n]));
const grid = new Map(); const cell = (p) => `${Math.floor(p.lat * 100)}:${Math.floor(p.lon * 100)}`;
for (const n of nodes) { if (n.genre === 'town' || n.genre === 'station') continue; const k = cell(n); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
const distKm = (a, b) => { const r = (d) => (d * Math.PI) / 180; const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2; return 6371 * 2 * Math.asin(Math.sqrt(h)); };
const nearSame = (p, name) => {
  const cy = Math.floor(p.lat * 100), cx = Math.floor(p.lon * 100);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const n of grid.get(`${cy + dy}:${cx + dx}`) || []) {
    const d = distKm(n, p);
    if (d < 0.05 || (d < 1 && (n.name.includes(name) || name.includes(n.name.replace(/\(.*\)$/, ''))))) return n;
  }
  return null;
};

(async () => {
  // 1. 種類ごとの候補
  const items = new Map();
  const add = (r, kind) => {
    const q = r.item.value.split('/').pop(); const p = point(r.coord.value); if (!p) return;
    const it = items.get(q) || { qid: q, name: r.ja.value, ...p, sitelinks: Number(r.sl.value), kinds: new Set(), marks: new Set(), company: false };
    it.kinds.add(kind); if (r.opIsCompany) it.company = true; it.sitelinks = Math.max(it.sitelinks, Number(r.sl.value));
    items.set(q, it);
  };
  for (const k of KINDS) for (const c of k.cls) {
    const rows = await cached(`cls-${c}`, itemQuery(`?item wdt:P31 wd:${c}.`));
    for (const r of rows) add(r, k.kind);
    console.log(`${k.label} ${c}: ${rows.length}`);
  }
  // 2. 指定・百選(目印。名勝と伝建地区は候補にも入れる)
  for (const d of DESIGNATIONS) {
    const rows = await cached(`des-${d.q}`, itemQuery(`{ ?item wdt:P1435 wd:${d.q} } UNION { ?item wdt:P361 wd:${d.q} } UNION { ?item wdt:P5008 wd:${d.q} }`));
    for (const r of rows) {
      const q = r.item.value.split('/').pop();
      if (!items.has(q) && d.add) add(r, d.add);
      if (items.has(q)) items.get(q).marks.add(d.label);
    }
    console.log(`${d.label}: ${rows.length}`);
  }

  // 3. 地域・重なり・推奨
  const list = [];
  for (const it of items.values()) {
    const region = regionAt(it);
    if (!region) continue; // 海の上・北方領土などで市区町村が引けないもの
    const pref = prefById.get(region.parent);
    const exist = byQid.get(it.qid) || nearSame(it, it.name);
    const kinds = [...it.kinds];
    const lighthouse = kinds.includes('lighthouse'), ski = kinds.includes('ski');
    const shrine = /(寺|院|神社|神宮|大社|宮|教会|大師)$/.test(it.name); // 名勝の指定で入ってくる寺社(寺社はハック不可。PLACES.md)
    const review = [];
    if (shrine) review.push('寺社(ハック不可)');
    if (lighthouse) review.push('灯台(航路標識。重要インフラの扱いを決める)');
    if (it.company || ski) review.push('企業が運営している可能性(ハック不可の候補)');
    list.push({ pref: pref ? pref.name : '', city: region.name, name: it.name, kinds, kind: kinds.map((k) => KIND_LABEL[k]).join('/'), marks: [...it.marks].join('/'),
      sitelinks: it.sitelinks, qid: it.qid, lat: it.lat.toFixed(5), lon: it.lon.toFixed(5),
      exist: exist ? `${exist.name}(${exist.genre})` : '', review: review.join('、'),
      recommended: !exist && !shrine && !lighthouse && !it.company && !ski && (it.sitelinks >= 3 || it.marks.size > 0) ? '○' : '' });
  }
  const prefOrder = Object.fromEntries(R.regions.filter((r) => r.kind === 'state').map((r, i) => [r.name, i]));
  list.sort((a, b) => (prefOrder[a.pref] - prefOrder[b.pref]) || (b.sitelinks - a.sitelinks) || a.name.localeCompare(b.name, 'ja'));

  // 4. 書き出し
  fs.mkdirSync(OUT, { recursive: true });
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = ['都道府県', '市区町村', '名前', '種類', '指定・百選', '知名度(言語版の数)', 'Wikidata', '緯度', '経度', '既存の拠点と重複', '要確認', '推奨', '採否(確認用)'];
  const rowsCsv = list.map((x) => [x.pref, x.city, x.name, x.kind, x.marks, x.sitelinks, x.qid, x.lat, x.lon, x.exist, x.review, x.recommended, ''].map(esc).join(','));
  fs.writeFileSync(path.join(OUT, 'candidates.csv'), '﻿' + [header.join(','), ...rowsCsv].join('\n') + '\n');
  const byKind = {}; const byPref = {};
  for (const x of list) {
    for (const k of x.kinds.map((kk) => KIND_LABEL[kk])) { const s = (byKind[k] = byKind[k] || { all: 0, dup: 0, rec: 0, review: 0 }); s.all++; if (x.exist) s.dup++; if (x.recommended) s.rec++; if (x.review) s.review++; }
    const p = (byPref[x.pref] = byPref[x.pref] || { all: 0, rec: 0 }); p.all++; if (x.recommended) p.rec++;
  }
  const summary = { updatedAt: TODAY, total: list.length, duplicates: list.filter((x) => x.exist).length, recommended: list.filter((x) => x.recommended).length, review: list.filter((x) => x.review).length, byKind, byPref };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  // 説明(README.md): 種類ごと・都道府県ごとの件数と、知名度の高い例
  const top = (k, n) => list.filter((x) => x.kinds.includes(k)).sort((a, b) => b.sitelinks - a.sitelinks).slice(0, n).map((x) => `${x.name}(${x.pref})`).join('、');
  const md = ['# 観光地の候補', '', `更新: ${TODAY}(\`tools/collect-tourism.js\` が書く)。一覧は \`candidates.csv\`。`, '',
    '出どころは Wikidata(CC0)。国土数値情報の観光資源データは使用許諾が「非商用」なので使わない。', '',
    `候補 **${summary.total}** 件。既存の拠点と重なるもの ${summary.duplicates}、要確認 ${summary.review}、推奨 ${summary.recommended}(重なりが無く、知名度 3 以上か指定・百選があり、企業運営・灯台でないもの)。`, '',
    '## 種類ごとの件数', '', '| 種類 | 候補 | 既存と重なる | 推奨 | 要確認 | 知名度の高い例 |', '|---|---|---|---|---|---|',
    ...Object.entries(KIND_LABEL).filter(([, l]) => byKind[l]).map(([k, l]) => { const b = byKind[l]; return `| ${l} | ${b.all} | ${b.dup} | ${b.rec} | ${b.review} | ${top(k, 5)} |`; }),
    '', '## 都道府県ごとの件数', '', '| 都道府県 | 候補 | 推奨 |', '|---|---|---|',
    ...Object.entries(byPref).sort((a, b) => prefOrder[a[0]] - prefOrder[b[0]]).map(([p, b]) => `| ${p} | ${b.all} | ${b.rec} |`), ''];
  fs.writeFileSync(path.join(OUT, 'README.md'), md.join('\n'));
  console.log(JSON.stringify({ total: summary.total, duplicates: summary.duplicates, recommended: summary.recommended, review: summary.review }));
  console.log(JSON.stringify(byKind));
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
