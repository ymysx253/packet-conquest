'use strict';
// 道でつながる島を調べる(2026-10-20 ユーザー決定: 道がつながっているところは船ではなく、ふつうの拠点の線で結ぶ)。
//
// 使い方:
//   node tools/fetch-road-links.js <タイルを置くフォルダ> [--max-km 10]
//
// tools/import-links.js が書いた「海で隔てられたまとまりの、向こう岸にいちばん近いところ」(server/map/data/derived/sea-gaps.json)ごとに、
// 国土地理院の道路中心線(地理院タイル experimental_rdcl、z16 の GeoJSON)を、2 つの拠点を結ぶ線の両側 約 1 km の帯だけ読む。
// 島の側の拠点のまわりの道路と、向こう岸の拠点のまわりの道路が、橋・トンネルを通って 1 つの道路網としてつながっていれば「道でつながる」。
// 結果(結ぶ拠点の組)を server/map/data/derived/road-links.json に書く。tools/import-links.js がそれを読んで、ふつうの拠点の線で結ぶ。
// 結んだあとに残ったまとまりの向こう岸は変わるので、import-links → この道具 を、新しく結ぶ組が無くなるまで繰り返す(読んだタイルはフォルダに残して使い回す)。
//
// 出どころ: 国土地理院「地理院タイル(道路中心線)」。国土地理院コンテンツ利用規約(出典の明示で商用可。CC BY 4.0 と同じ扱い)。出典 src-gsi-rdcl
const fs = require('fs');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const tileDir = args[0];
if (!tileDir) { console.error('使い方: node tools/fetch-road-links.js <タイルを置くフォルダ> [--max-km 10]'); process.exit(1); }
const MAX_KM = Number((args[args.indexOf('--max-km') + 1] || '').match(/^[0-9.]+$/) ? args[args.indexOf('--max-km') + 1] : 10);
const ROOT = path.join(__dirname, '..');
const DERIVED = path.join(ROOT, 'server/map/data/derived');
const GAPS = JSON.parse(fs.readFileSync(path.join(DERIVED, 'sea-gaps.json'), 'utf8')).gaps;
const OUT = path.join(DERIVED, 'road-links.json');
const Z = 16;
const URL = (x, y) => `https://cyberjapandata.gsi.go.jp/xyz/experimental_rdcl/${Z}/${x}/${y}.geojson`;
const PAD_LAT = 0.009, PAD_LON = 0.011; // 帯の幅(約 1 km)
const AREA_LAT = 0.027, AREA_LON = 0.033; // 島全体を調べるときのまわり(約 3 km)
const NEAR_KM = 1; // 拠点のまわり(道路を探す範囲)。2 つの拠点の間の距離の 4 割までに抑える(向こう岸の道路を拾わない)

const tx = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const ty = (lat) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z);
const distKm = (a, b) => { const toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

function corridorTiles(p) {
  const out = new Set();
  const steps = Math.ceil(p.km / 0.2) + 1;
  for (let i = 0; i <= steps; i++) {
    const lat = p.aLat + ((p.bLat - p.aLat) * i) / steps, lon = p.aLon + ((p.bLon - p.aLon) * i) / steps;
    for (let y = ty(lat + PAD_LAT); y <= ty(lat - PAD_LAT); y++) for (let x = tx(lon - PAD_LON); x <= tx(lon + PAD_LON); x++) out.add(`${x}/${y}`);
  }
  return [...out];
}
const fileOf = (t) => path.join(tileDir, `${t.replace('/', '_')}.geojson`);
const get = (url) => new Promise((res) => {
  const req = https.get(url, { headers: { 'User-Agent': 'PacketConquest/0.1 (road links; https://github.com/ymysx253/packet-conquest)' }, timeout: 30000 }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b }));
  });
  req.on('error', () => res({ status: 0, body: '' }));
  req.on('timeout', () => { req.destroy(); res({ status: 0, body: '' }); });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(tileDir, { recursive: true });
  const pairs = GAPS.flatMap((g) => g.pairs.filter((p) => p.km <= MAX_KM).map((p) => ({ ...p, comp: g.comp })));
  const need = new Set();
  for (const p of pairs) { p.tiles = corridorTiles(p); for (const t of p.tiles) if (!fs.existsSync(fileOf(t))) need.add(t); }
  // 島全体(2026-10-20): 帯だけでは、橋が島の端にあって拠点から離れていると拾えない(笠戸島)。拠点 60 以下の島は、島の拠点を囲む枠とまわり 約 3 km を読む
  const areas = GAPS.filter((g) => g.nodes).map((g) => {
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (const n of g.nodes) { la0 = Math.min(la0, n.lat); la1 = Math.max(la1, n.lat); lo0 = Math.min(lo0, n.lon); lo1 = Math.max(lo1, n.lon); }
    const box = [la0 - AREA_LAT, la1 + AREA_LAT, lo0 - AREA_LON, lo1 + AREA_LON];
    const tiles = [];
    for (let y = ty(box[1]); y <= ty(box[0]); y++) for (let x = tx(box[2]); x <= tx(box[3]); x++) tiles.push(`${x}/${y}`);
    return { comp: g.comp, nodes: g.nodes, box, tiles };
  });
  for (const a of areas) for (const t of a.tiles) if (!fs.existsSync(fileOf(t))) need.add(t);
  console.log(`組 ${pairs.length}、島全体 ${areas.length}、読むタイル ${new Set([...pairs.flatMap((p) => p.tiles), ...areas.flatMap((a) => a.tiles)]).size} 枚(まだ無いもの ${need.size} 枚)`);
  // 1 秒に 5 枚まで(国土地理院のサーバーに負担をかけない)。404 は道路の無い枠(海など)なので空として残す
  const list = [...need];
  let done = 0, failed = 0;
  for (let i = 0; i < list.length; i += 5) {
    const batch = list.slice(i, i + 5);
    const t0 = Date.now();
    await Promise.all(batch.map(async (t) => {
      const [x, y] = t.split('/');
      let r = await get(URL(x, y));
      if (r.status !== 200 && r.status !== 404) { await wait(2000); r = await get(URL(x, y)); }
      if (r.status === 200) fs.writeFileSync(fileOf(t), r.body);
      else if (r.status === 404) fs.writeFileSync(fileOf(t), '{"type":"FeatureCollection","features":[]}');
      else failed++;
    }));
    done += batch.length;
    if (done % 1000 < 5) console.log(`  … ${done}/${list.length}(失敗 ${failed})`);
    const spent = Date.now() - t0; if (spent < 1000) await wait(1000 - spent);
  }
  if (failed) console.log(`読めなかったタイル ${failed} 枚(もう一度実行すると読み直す)`);

  // 組ごとに道路網をつくって調べる
  const links = [];
  const cache = new Map();
  const load = (t) => {
    if (cache.has(t)) return cache.get(t);
    let feats = [];
    try { feats = JSON.parse(fs.readFileSync(fileOf(t), 'utf8')).features || []; } catch { feats = []; }
    if (cache.size > 3000) cache.clear();
    cache.set(t, feats);
    return feats;
  };
  const key = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
  for (const p of pairs) {
    const parent = new Map();
    const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let y = x; while (parent.get(y) !== r) { const n = parent.get(y); parent.set(y, r); y = n; } return r; };
    const add = (k) => { if (!parent.has(k)) parent.set(k, k); };
    const pts = new Map(); // key → [lon, lat]
    for (const t of p.tiles) for (const f of load(t)) {
      const g = f.geometry; if (!g) continue;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) for (let i = 0; i < line.length; i++) {
        const k = key(line[i]); add(k); pts.set(k, line[i]);
        if (i) { const a = find(key(line[i - 1])), b = find(k); if (a !== b) parent.set(a, b); }
      }
    }
    const a = { lat: p.aLat, lon: p.aLon }, b = { lat: p.bLat, lon: p.bLon };
    const near = Math.min(NEAR_KM, p.km * 0.4);
    const rootsA = new Set(), rootsB = new Set();
    for (const [k, c] of pts) {
      const q = { lat: c[1], lon: c[0] };
      if (distKm(q, a) <= near) rootsA.add(find(k));
      else if (distKm(q, b) <= near) rootsB.add(find(k));
    }
    if ([...rootsA].some((r) => rootsB.has(r))) links.push({ a: p.a, b: p.b, km: p.km, comp: p.comp });
  }
  // 島全体: 島の拠点のすぐそばの道路と、島の外の拠点のすぐそばの道路が、1 つの道路網なら道でつながる(いちばん近い組を結ぶ)
  if (areas.length) {
    const ALL = [];
    for (const file of fs.readdirSync(path.join(ROOT, 'server/map/data')).filter((x) => x.endsWith('.json'))) {
      try { const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/map/data', file), 'utf8')); if (Array.isArray(j.nodes)) for (const n of j.nodes) if (n.hackable !== false && n.status !== 'hidden' && !n.id.startsWith('pp-')) ALL.push({ id: n.id, lat: n.lat, lon: n.lon }); } catch { /* 拠点のファイルでない */ }
    }
    const NEAR_AREA = 0.3; // すぐそば(km)
    for (const ar of areas) {
      const inComp = new Set(ar.nodes.map((n) => n.id));
      const outs = ALL.filter((n) => !inComp.has(n.id) && n.lat >= ar.box[0] && n.lat <= ar.box[1] && n.lon >= ar.box[2] && n.lon <= ar.box[3]);
      if (!outs.length) continue;
      const parent = new Map();
      const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let y = x; while (parent.get(y) !== r) { const n = parent.get(y); parent.set(y, r); y = n; } return r; };
      const vgrid = new Map(); const VG = 0.003;
      for (const t of ar.tiles) for (const ft of load(t)) {
        const g = ft.geometry; if (!g) continue;
        const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const line of lines) for (let i = 0; i < line.length; i++) {
          const k = key(line[i]);
          if (!parent.has(k)) { parent.set(k, k); const gk = `${Math.floor(line[i][1] / VG)}:${Math.floor(line[i][0] / VG)}`; if (!vgrid.has(gk)) vgrid.set(gk, []); vgrid.get(gk).push([k, line[i]]); }
          if (i) { const a = find(key(line[i - 1])), b = find(k); if (a !== b) parent.set(a, b); }
        }
      }
      const rootsNear = (p, rad) => {
        const out = new Set(); const cy = Math.floor(p.lat / VG), cx = Math.floor(p.lon / VG), span = Math.ceil(rad / 0.3) + 1;
        for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) for (const [k, c] of vgrid.get(`${cy + dy}:${cx + dx}`) || []) if (distKm(p, { lat: c[1], lon: c[0] }) <= rad) out.add(find(k));
        return out;
      };
      const nearestOther = (p, list) => list.reduce((m, q) => Math.min(m, distKm(p, q)), Infinity);
      const aRoots = ar.nodes.map((n) => ({ n, roots: rootsNear(n, Math.min(NEAR_AREA, 0.4 * nearestOther(n, outs))) }));
      let best = null;
      for (const o of outs) {
        const rad = Math.min(NEAR_AREA, 0.4 * nearestOther(o, ar.nodes));
        const ro = rootsNear(o, rad);
        if (!ro.size) continue;
        for (const { n, roots } of aRoots) {
          if (![...roots].some((x) => ro.has(x))) continue;
          const d = distKm(n, o);
          if (!best || d < best.d) best = { a: n.id, b: o.id, d };
        }
      }
      if (best) links.push({ a: best.a, b: best.b, km: Number(best.d.toFixed(3)), comp: ar.comp, by: 'area' });
    }
  }
  // 前回の結果に足す(結んだあとに残ったまとまりを、次の回で調べる)
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).links : [];
  const seen = new Set(prev.map((l) => `${l.a}|${l.b}`));
  const added = links.filter((l) => !seen.has(`${l.a}|${l.b}`));
  const all = [...prev, ...added];
  fs.writeFileSync(OUT, JSON.stringify({ schema: 'pc.derived.road-links/1', note: '道でつながる島(国土地理院の道路中心線で調べた)。tools/fetch-road-links.js が書き、tools/import-links.js が読んで、ふつうの拠点の線で結ぶ', source: 'src-gsi-rdcl', links: all }, null, 0).replace(/\},\{/g, '},\n{') + '\n');
  console.log(`道でつながる組 ${links.length}(新しく ${added.length}、合計 ${all.length})。調べた組 ${pairs.length}`);
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
