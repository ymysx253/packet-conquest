'use strict';
// 拠点どうしのつながり(adj)を拠点マスター(server/map/data/tokyo.json)に書き込む(設計書 第 14 章)。
//
// 使い方:
//   node tools/import-links.js <N02 鉄道区間 GeoJSON> <N02 駅 GeoJSON>
// 出どころ: 国土交通省「国土数値情報」鉄道データ(N02)。
//
// つながりの決め方(突破に必要な正解の回数 = つながりの本数):
//   1. 駅: 同じ路線の前後の駅と結ぶ。路線の線形(鉄道区間)をたどり、次の駅に着いたところで止める。
//      都外の駅は拠点ではないので、そこで線は途切れる(終点扱い)
//   2. 名所(駅以外でハック可): 近い駅をレベルと同じ数だけ結ぶ(Lv1 は最寄り 1 駅、Lv5 は近い 5 駅。上限 8)
//   3. 分断があれば、いちばん近い拠点どうしを橋として結ぶ(地図が必ずつながるように)
//   4. 寺社・重要インフラ(hackable: false)と非公開の拠点(status: hidden)は結ばない
// import-stations.js を再実行したら、このツールももう一度実行する(adj が消えるため)。
const fs = require('fs');
const path = require('path');

const [, , sectionFile, stationFile] = process.argv;
if (!sectionFile || !stationFile) {
  console.error('使い方: node tools/import-links.js <N02_RailroadSection.geojson> <N02_Station.geojson>');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const REGIONS = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
// 対象は地域マスターで nodeFile を持つ都道府県のファイル全部(都県境をまたぐ路線のつながりを作るため、まとめて計算する)
const NODE_FILES = REGIONS.regions.filter((x) => x.nodeFile).map((x) => path.join(DATA, `${x.nodeFile}.json`));
const TODAY = '2026-10-19';
const LANDMARK_MAX_LINKS = 8; // 名所のつながりの上限(レベルが 8 を超える象徴拠点でも 8 本まで)

const distKm = (a, b) => { const R = 6371, toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const vkey = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
const lineKey = (p) => `${p.N02_004} ${p.N02_003}`;

// ---------- 拠点マスター(全ファイルをまとめる) ----------
const FILES = NODE_FILES.map((f) => ({ file: f, T: JSON.parse(fs.readFileSync(f, 'utf8')) }));
const nodes = FILES.flatMap((x) => x.T.nodes);
const byId = new Map(nodes.map((n) => [n.id, n]));
const stations = nodes.filter((n) => n.genre === 'station');
const baseName = (name) => name.replace(/駅(\(.*\))?$/, '');
const stationsByBase = new Map();
for (const s of stations) (stationsByBase.get(baseName(s.name)) || stationsByBase.set(baseName(s.name), []).get(baseName(s.name))).push(s);

// N02 の駅(1 路線 1 件)→ 拠点 id。グループコードで引き、まとめられた駅は名前と距離(1.2 km)で引く
function nodeIdOf(feature) {
  const p = feature.properties;
  const direct = byId.get(`st-${p.N02_005g}`);
  if (direct) return direct.id;
  const cs = feature.geometry.coordinates;
  const m = cs[Math.floor(cs.length / 2)];
  const pt = { lat: m[1], lon: m[0] };
  // 停留場の名前は「富山駅」のように末尾に「駅」を含むことがある(取り込みで「富山」と統合済み)ので、末尾の「駅」を除いた名前でも引く
  // 「◯◯駅前」など駅に統合した停留場は、駅の名前でも引く
  const keys = [p.N02_005, p.N02_005.replace(/駅$/, ''), p.N02_005.replace(/駅(前|東口|西口|南口|北口)$/, '')];
  const cands = [...new Set(keys)].flatMap((k) => stationsByBase.get(k) || []).filter((s) => distKm(s, pt) <= 1.2 && s.lines.includes(lineKey(p)));
  if (!cands.length) {
    // 別名で統合された駅(30 m 以内): 名前ではなく、近くにあって同じ路線を持つ拠点で引く
    const near = stations.filter((s) => distKm(s, pt) <= 0.3 && s.lines.includes(lineKey(p)));
    if (!near.length) return null;
    near.sort((a, b) => distKm(a, pt) - distKm(b, pt));
    return near[0].id;
  }
  cands.sort((a, b) => distKm(a, pt) - distKm(b, pt));
  return cands[0].id;
}

// ---------- 路線ごとに線形をたどって前後の駅を見つける ----------
const sections = JSON.parse(fs.readFileSync(sectionFile, 'utf8')).features;
const stationFeatures = JSON.parse(fs.readFileSync(stationFile, 'utf8')).features;
const secByLine = new Map();
for (const f of sections) { const k = lineKey(f.properties); (secByLine.get(k) || secByLine.set(k, []).get(k)).push(f); }
const stByLine = new Map();
for (const f of stationFeatures) { const k = lineKey(f.properties); (stByLine.get(k) || stByLine.set(k, []).get(k)).push(f); }

const adj = new Map(nodes.map((n) => [n.id, new Set()]));
const link = (a, b) => { if (a && b && a !== b) { adj.get(a).add(b); adj.get(b).add(a); } };
let lineEdges = 0, unmapped = 0;
for (const [line, sts] of stByLine) {
  // この路線に都内の拠点が 1 つも無ければ飛ばす
  const mapped = sts.map((f) => ({ f, id: nodeIdOf(f) }));
  if (!mapped.some((x) => x.id)) continue;
  // 線形のグラフ: 頂点 = 区間と駅の端点。辺 = 区間(駅の区間も辺)
  const graph = new Map(); // vkey → Set<vkey>
  const addV = (k) => { if (!graph.has(k)) graph.set(k, new Set()); return graph.get(k); };
  const addE = (a, b) => { if (a !== b) { addV(a).add(b); addV(b).add(a); } };
  for (const f of secByLine.get(line) || []) { const c = f.geometry.coordinates; addE(vkey(c[0]), vkey(c[c.length - 1])); }
  // 駅の端点 → 駅。駅の区間そのものも辺にする
  const stationAt = new Map(); // vkey → index in mapped
  mapped.forEach((x, i) => {
    const c = x.f.geometry.coordinates;
    const a = vkey(c[0]), b = vkey(c[c.length - 1]);
    addE(a, b); stationAt.set(a, i); stationAt.set(b, i);
    if (!x.id) unmapped++;
  });
  // 各駅から線形をたどり、別の駅に着いたら隣とする(途中の駅で止まるので、飛び越えない)
  mapped.forEach((x, i) => {
    if (!x.id) return;
    const c = x.f.geometry.coordinates;
    const starts = [vkey(c[0]), vkey(c[c.length - 1])];
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length) {
      const v = queue.shift();
      for (const w of graph.get(v) || []) {
        if (seen.has(w)) continue;
        seen.add(w);
        const j = stationAt.get(w);
        if (j !== undefined && j !== i) {
          // 隣の駅。都内の拠点なら結ぶ。都外なら線はここで途切れる
          if (mapped[j].id && mapped[j].id !== x.id) { link(x.id, mapped[j].id); lineEdges++; }
          continue; // 駅の先へは進まない
        }
        queue.push(w);
      }
    }
  });
}

// ---------- 名所: 5 km 以内の近い駅をレベルと同じ数だけ(2026-10-19) ----------
// 駅の少ない県で、離島や山の名所が遠くの駅に集まって結ばれないよう距離に上限を置く。
// 5 km 以内に駅が無い名所は結ばず、下の「分断の橋渡し」で近い名所どうし → 最も近い所へ 1 本でつながる
const LANDMARK_MAX_KM = 5;
const hackableStations = stations.filter((s) => s.hackable !== false);
const sGrid = new Map();
const sCell = (p) => `${Math.floor(p.lat * 20)}:${Math.floor(p.lon * 20)}`; // 約 5 km のます目
for (const s of hackableStations) { const k = sCell(s); if (!sGrid.has(k)) sGrid.set(k, []); sGrid.get(k).push(s); }
let landmarkEdges = 0, landmarkAlone = 0;
for (const n of nodes) {
  if (n.genre === 'station' || n.hackable === false || n.status === 'hidden') continue;
  const cy = Math.floor(n.lat * 20), cx = Math.floor(n.lon * 20);
  const cands = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const s of sGrid.get(`${cy + dy}:${cx + dx}`) || []) { const d = distKm(n, s); if (d <= LANDMARK_MAX_KM) cands.push({ s, d }); }
  const near = cands.sort((a, b) => a.d - b.d).slice(0, Math.min(LANDMARK_MAX_LINKS, Math.max(1, n.level)));
  if (!near.length) landmarkAlone++;
  for (const { s } of near) { link(n.id, s.id); landmarkEdges++; }
}

// ---------- 分断の橋渡し ----------
const hackable = nodes.filter((n) => n.hackable !== false && n.status !== 'hidden'); // 非公開の拠点(自衛隊・米軍の飛行場など)は線の対象外
const parent = new Map(hackable.map((n) => [n.id, n.id]));
const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
const union = (a, b) => { parent.set(find(a), find(b)); };
for (const n of hackable) for (const m of adj.get(n.id)) union(n.id, m);
// いちばん小さいまとまりから、外側でいちばん近い拠点へ橋を 1 本かける、を 1 つになるまで繰り返す。
// 小さいまとまり × 全拠点で済むので、全国(約 9,000 駅)でも速い(以前は全拠点 × 全拠点を毎回)
const bridges = [];
for (;;) {
  const comps = new Map();
  for (const n of hackable) { const k = find(n.id); if (!comps.has(k)) comps.set(k, []); comps.get(k).push(n); }
  if (comps.size <= 1) break;
  const small = [...comps.values()].reduce((x, y) => (y.length < x.length ? y : x));
  const key = find(small[0].id);
  let best = null;
  for (const a of small) for (const b of hackable) {
    if (find(b.id) === key) continue;
    const d = distKm(a, b);
    if (!best || d < best.d) best = { a, b, d };
  }
  link(best.a.id, best.b.id); union(best.a.id, best.b.id);
  bridges.push(`${best.a.name}–${best.b.name} (${best.d >= 10 ? best.d.toFixed(0) + ' km' : (best.d * 1000).toFixed(0) + ' m'})`);
}

// ---------- 書き戻し(ファイルごと) ----------
for (const n of nodes) {
  if (n.hackable === false || n.status === 'hidden') { delete n.adj; continue; } // ハック不可・非公開の拠点には線を張らない
  n.adj = [...adj.get(n.id)].sort();
}
const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
function writeList(head, key, items, groupKey) {
  let out = JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`);
  let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
}
for (const { file, T } of FILES) {
  T.version = (T.version || 0) + 1;
  T.updatedAt = TODAY;
  const { nodes: list, ...head } = T;
  fs.writeFileSync(file, writeList(head, 'nodes', list, 'area'));
}

const deg = {}; for (const n of hackable) { const d = adj.get(n.id).size; deg[d] = (deg[d] || 0) + 1; }
const top = hackable.map((n) => ({ name: n.name, d: adj.get(n.id).size })).sort((a, b) => b.d - a.d).slice(0, 8);
console.log(`対象 ${FILES.length} ファイル ${nodes.length} 拠点。路線のつながり ${lineEdges / 2} 本、名所のつながり ${landmarkEdges} 本(5 km 以内に駅が無い名所 ${landmarkAlone})、橋 ${bridges.length} 本。拠点に結びつかなかった N02 の駅 ${unmapped} 件(対象外の都道府県など)`);
console.log('つながりの本数 → 拠点数', JSON.stringify(deg));
console.log('多い順', top.map((t) => `${t.name} ${t.d}`).join(' / '));
if (bridges.length) console.log('橋:', bridges.join(' / '));
