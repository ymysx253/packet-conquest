'use strict';
// 拠点を足す道具(tools/import-offices.js、tools/import-universities.js)が共通に使う部品(2026-10-26)。
//   - Wikidata(CC0)への問い合わせ(作業フォルダに保存し、2 回目からは保存した応答を使う。消せば取り直す)
//   - 座標が複数ある項目の座標を 1 つに決める(本部の所在地 P159 に近いもの)
//   - 国土数値情報 行政区域(N03)の境界で、座標から市区町村を決める(tools/collect-landmarks.js と同じやり方)
//   - 拠点マスター(都道府県ごとのファイル)の読み書き
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const UA = 'PacketConquest/0.1 (place collection; https://github.com/ymysx253/packet-conquest)';

const distKm = (a, b) => { const r = (d) => (d * Math.PI) / 180; const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Wikidata ----------
function sparqlOnce(query) {
  return new Promise((resolve, reject) => {
    const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeout: 120000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body).results.bindings); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
// 問い合わせの結果を { 変数: 値 } の配列にする(項目の URI は QID に)。作業フォルダの <name>.json に保存する
async function cachedQuery(workDir, name, query) {
  fs.mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, `${name}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let rows = null, last = null;
  for (const delay of [0, 5000, 20000]) {
    if (delay) await wait(delay);
    try { rows = await sparqlOnce(query); break; } catch (e) { last = e; console.log(`  ${name}: 問い合わせに失敗(${e.message.slice(0, 60)})`); }
  }
  if (!rows) throw new Error(`Wikidata の問い合わせ ${name} に失敗しました: ${last && last.message}`);
  const out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value.replace('http://www.wikidata.org/entity/', '')])));
  fs.writeFileSync(file, JSON.stringify(out));
  await wait(1500); // 公開サービスへの配慮
  return out;
}
const parsePoint = (s) => { const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(s); return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null; };

// 座標が複数ある項目(キャンパスが 2 つある大学など)。ほぼ同じ所(300 m 以内)なら 1 つ目。離れていれば、
// 本部の所在地(P159)の修飾子の座標、無ければ P159 の項目の座標にいちばん近いもの。どちらも無ければ決めない(null)
async function pickCoords(items, workDir, name) {
  const spread = (cs) => { let m = 0; for (const a of cs) for (const b of cs) m = Math.max(m, distKm(a, b)); return m; };
  const need = items.filter((x) => x.coords.length > 1 && spread(x.coords) > 0.3);
  const hq = new Map();
  if (need.length) {
    const q = `SELECT ?item ?qc ?hc WHERE { VALUES ?item { ${need.map((x) => 'wd:' + x.qid).join(' ')} }
  OPTIONAL { ?item p:P159/pq:P625 ?qc } OPTIONAL { ?item wdt:P159 ?h. ?h wdt:P625 ?hc } }`;
    for (const r of await cachedQuery(workDir, name, q)) {
      const cur = hq.get(r.item) || {};
      if (r.qc && !cur.qc) cur.qc = parsePoint(r.qc);
      if (r.hc && !cur.hc) cur.hc = parsePoint(r.hc);
      hq.set(r.item, cur);
    }
  }
  const undecided = [];
  for (const x of items) {
    const sorted = [...x.coords].sort((a, b) => a.lat - b.lat || a.lon - b.lon); // 問い合わせの順に左右されないように
    if (sorted.length === 1 || spread(sorted) <= 0.3) { x.lat = sorted[0].lat; x.lon = sorted[0].lon; continue; }
    const h = hq.get(x.qid) || {};
    const ref = h.qc || h.hc;
    if (!ref) { x.lat = null; undecided.push(x); continue; }
    const best = sorted.reduce((p, c) => (distKm(c, ref) < distKm(p, ref) ? c : p));
    x.lat = best.lat; x.lon = best.lon; x.coordBy = h.qc ? '本部の座標' : '本部の所在地';
  }
  return undecided;
}

// ---------- 境界(N03)で市区町村を決める ----------
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const regionByCode = new Map(R.regions.filter((r) => r.kind === 'city' && r.code && /^JP-\d\d-\d+$/.test(r.code)).map((r) => [r.code.split('-').pop(), r]));
const regionById = new Map(R.regions.map((r) => [r.id, r]));
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// cands の各要素({ lat, lon })に region(地域マスターの市区町村)を付ける。境界の外(海の上など)は付かない
function locate(cands, n03Dir) {
  const files = fs.readdirSync(n03Dir).filter((f) => /^N03-\d{8}_\d{2}\.geojson$/.test(f)).sort();
  if (!files.length) throw new Error(`${n03Dir} に N03-YYYYMMDD_NN.geojson がありません`);
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(n03Dir, f), 'utf8'));
    let bb = [180, 90, -180, -90];
    const feats = data.features.map((ft) => {
      const polys = ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates;
      const b = [180, 90, -180, -90];
      for (const p of polys) for (const [x, y] of p[0]) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
      bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])];
      return { code: ft.properties.N03_007, polys, b };
    });
    for (const c of cands) {
      if (c.region) continue;
      const pt = [c.lon, c.lat];
      if (pt[0] < bb[0] || pt[0] > bb[2] || pt[1] < bb[1] || pt[1] > bb[3]) continue;
      for (const ft of feats) {
        if (pt[0] < ft.b[0] || pt[0] > ft.b[2] || pt[1] < ft.b[1] || pt[1] > ft.b[3]) continue;
        if (!ft.polys.some((p) => pointInRing(pt, p[0]) && !p.slice(1).some((h) => pointInRing(pt, h)))) continue;
        const reg = regionByCode.get(ft.code);
        if (reg) c.region = reg;
        break;
      }
    }
  }
}
// 扱わない・置かない場所(PLACES.md 付記): 北方領土の 6 村と歯舞群島、立ち入り制限の島、尖閣諸島
const NORTHERN = /^hokkaido-0(1695|1696|1697|1698|1699|1700)$/;
const RESTRICTED = [[24.72, 24.82, 141.26, 141.37], [24.27, 24.31, 153.96, 154.0], [20.4, 20.45, 136.04, 136.1], [25.6, 26.1, 123.3, 124.7]];
const outOfBounds = (c) => (c.region && (NORTHERN.test(c.region.id) || (c.region.id === 'hokkaido-01223' && c.lon > 145.85))) || RESTRICTED.some(([s, n, w, e]) => c.lat >= s && c.lat <= n && c.lon >= w && c.lon <= e);

// ---------- 拠点マスター ----------
function loadNodeFiles() {
  const files = new Map(); // 都道府県 id → { file, T }
  for (const r of R.regions.filter((x) => x.nodeFile)) {
    const file = path.join(DATA, `${r.nodeFile}.json`);
    files.set(r.id, { file, T: JSON.parse(fs.readFileSync(file, 'utf8')) });
  }
  return files;
}
const prefOf = (region) => { let cur = region; while (cur && cur.kind !== 'state') cur = regionById.get(cur.parent); return cur; };
// 近くの拠点を引くます目(約 500 m)。町・字は代表点なので入れない(建物と比べない。tools/import-tourism.js と同じ)
function nodeGrid(files) {
  const grid = new Map();
  const add = (n) => { const k = `${Math.floor(n.lat * 200)}:${Math.floor(n.lon * 200)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); };
  for (const { T } of files.values()) for (const n of T.nodes) if (n.genre !== 'town') add(n);
  const near = (p, km) => {
    const out = []; const cy = Math.floor(p.lat * 200), cx = Math.floor(p.lon * 200), r = Math.ceil(km / 0.5);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) for (const n of grid.get(`${cy + dy}:${cx + dx}`) || []) { const d = distKm(n, p); if (d < km) out.push({ n, d }); }
    return out.sort((a, b) => a.d - b.d);
  };
  return { add, near };
}
const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
function writeList(headObj, key, items, groupKey) {
  let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`);
  let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
}
// 地域の並び → 名所・町・字・駅の順(tools/import-towns.js と同じ)に並べて書く。中身が変わったファイルだけ書き、そのときだけ版を上げる
function writeNodeFiles(files, today) {
  const order = Object.fromEntries(R.regions.map((r, i) => [r.id, i]));
  const rank = (n) => (n.genre === 'station' ? 2 : n.genre === 'town' ? 1 : 0);
  let written = 0;
  for (const { file, T } of files.values()) {
    T.nodes = T.nodes.map((n, i) => ({ n, i })).sort((a, b) => (order[a.n.region] - order[b.n.region]) || (rank(a.n) - rank(b.n)) || (a.i - b.i)).map((x) => x.n);
    const before = fs.readFileSync(file, 'utf8');
    const { nodes, ...head } = T;
    if (writeList(head, 'nodes', nodes, 'area') === before) continue;
    fs.writeFileSync(file, writeList({ ...head, version: (T.version || 0) + 1, updatedAt: today }, 'nodes', nodes, 'area'));
    written++;
  }
  return written;
}

module.exports = { ROOT, DATA, R, regionByCode, regionById, distKm, cachedQuery, parsePoint, pickCoords, locate, outOfBounds, loadNodeFiles, prefOf, nodeGrid, writeNodeFiles };
