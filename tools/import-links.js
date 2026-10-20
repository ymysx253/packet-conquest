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
const LANDMARK_MAX_LINKS = 8;
const { landmarkLinkCount, L } = require('./levels'); // 名所のつながりの上限(レベルが 8 を超える象徴拠点でも 8 本まで)

const distKm = (a, b) => { const R = 6371, toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const vkey = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
const lineKey = (p) => `${p.N02_004} ${p.N02_003}`;

// ---------- 拠点マスター(全ファイルをまとめる) ----------
const FILES = NODE_FILES.map((f) => ({ file: f, T: JSON.parse(fs.readFileSync(f, 'utf8')) }));
for (const x of FILES) x.T.nodes = x.T.nodes.filter((n) => !n.id.startsWith('pp-')); // 前回作った仮の港は外して作り直す(下の「分断の橋渡し」)
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
// 路線の線の形(2026-10-20 ユーザー指摘: 海沿いで電車の線が海の上を通っていた)。前後の駅の向きから作る曲線ではなく、本当の線路の形(N02 の鉄道区間)をなぞる。
// 駅と駅の間の線路を間引いて public/data/rail-paths.json に書く(画面が読む)。キーは 2 つの駅の id を小さい順に「|」でつないだもの、点は小さい方の駅から
const railPaths = new Map();
for (const [line, sts] of stByLine) {
  // この路線に都内の拠点が 1 つも無ければ飛ばす
  const mapped = sts.map((f) => ({ f, id: nodeIdOf(f) }));
  if (!mapped.some((x) => x.id)) continue;
  // 線形のグラフ: 頂点 = 区間と駅の端点。辺 = 区間(駅の区間も辺)
  const graph = new Map(); // vkey → Set<vkey>
  const addV = (k) => { if (!graph.has(k)) graph.set(k, new Set()); return graph.get(k); };
  const addE = (a, b) => { if (a !== b) { addV(a).add(b); addV(b).add(a); } };
  const segCoords = new Map(); // 'a|b' → その区間の点(a から b)
  const addSeg = (c) => { const a = vkey(c[0]), b = vkey(c[c.length - 1]); addE(a, b); if (!segCoords.has(`${a}|${b}`)) { segCoords.set(`${a}|${b}`, c); segCoords.set(`${b}|${a}`, [...c].reverse()); } };
  for (const f of secByLine.get(line) || []) addSeg(f.geometry.coordinates);
  // 駅の端点 → 駅。駅の区間そのものも辺にする
  const stationAt = new Map(); // vkey → index in mapped
  mapped.forEach((x, i) => {
    const c = x.f.geometry.coordinates;
    const a = vkey(c[0]), b = vkey(c[c.length - 1]);
    addSeg(c); stationAt.set(a, i); stationAt.set(b, i);
    if (!x.id) unmapped++;
  });
  // 各駅から線形をたどり、別の駅に着いたら隣とする(途中の駅で止まるので、飛び越えない)
  mapped.forEach((x, i) => {
    if (!x.id) return;
    const c = x.f.geometry.coordinates;
    const starts = [vkey(c[0]), vkey(c[c.length - 1])];
    const seen = new Set(starts);
    const queue = [...starts];
    const prev = new Map(); // たどった道すじ(線路の形を書き出すため)
    while (queue.length) {
      const v = queue.shift();
      for (const w of graph.get(v) || []) {
        if (seen.has(w)) continue;
        seen.add(w); prev.set(w, v);
        const j = stationAt.get(w);
        if (j !== undefined && j !== i) {
          // 隣の駅。都内の拠点なら結ぶ。都外なら線はここで途切れる
          if (mapped[j].id && mapped[j].id !== x.id) {
            link(x.id, mapped[j].id); lineEdges++;
            const pk = x.id < mapped[j].id ? `${x.id}|${mapped[j].id}` : `${mapped[j].id}|${x.id}`;
            if (!railPaths.has(pk)) { // 線路の形: たどった頂点の列を区間の点に戻す(新幹線の駅どうしなどは先に見つけた路線の形)
              const vs = [w]; while (prev.has(vs[vs.length - 1])) vs.push(prev.get(vs[vs.length - 1]));
              vs.reverse();
              const pts = [];
              for (let q = 1; q < vs.length; q++) { const cs = segCoords.get(`${vs[q - 1]}|${vs[q]}`); if (cs) pts.push(...(pts.length ? cs.slice(1) : cs)); }
              if (pts.length >= 2) railPaths.set(pk, x.id < mapped[j].id ? pts : pts.reverse());
            }
          }
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
// 名所から見通せる駅(2026-10-20 ユーザー決定。tools/import-towns.js が作る): 間にほかの町・字がある駅とは直接つながない。一覧に無い名所は前のまま
const LM_VIS_FILE = path.join(__dirname, '..', 'server/map/data/derived/landmark-stations.json');
const LM_VIS = fs.existsSync(LM_VIS_FILE) ? JSON.parse(fs.readFileSync(LM_VIS_FILE, 'utf8')).visible : null;
let landmarkBlocked = 0;
for (const n of nodes) {
  if (n.genre === 'station' || n.genre === 'town' || n.hackable === false || n.status === 'hidden') continue; // 町・字は下で境界から結ぶ
  const cy = Math.floor(n.lat * 20), cx = Math.floor(n.lon * 20);
  const cands = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const s of sGrid.get(`${cy + dy}:${cx + dx}`) || []) { const d = distKm(n, s); if (d <= LANDMARK_MAX_KM) cands.push({ s, d }); }
  const vis = LM_VIS && LM_VIS[n.id] ? new Set(LM_VIS[n.id]) : null;
  const seeThrough = vis ? cands.filter((c) => vis.has(c.s.id)) : cands;
  landmarkBlocked += cands.length - seeThrough.length;
  const near = seeThrough.sort((a, b) => a.d - b.d).slice(0, Math.min(LANDMARK_MAX_LINKS, landmarkLinkCount(n.level))); // 古い物差しと同じ本数(tools/levels.js)
  if (!near.length) landmarkAlone++;
  for (const { s } of near) { link(n.id, s.id); landmarkEdges++; }
}

// ---------- 町・字(2026-10-18): 境界が接している町・字どうし(borders)と、町・字の中にある駅・名所(contains) ----------
// どちらも tools/import-towns.js が国勢調査の小地域境界から求めて拠点マスターに書いたもの。町から町へは一歩ずつ進む
let townEdges = 0;
const usableNode = (n) => n && n.hackable !== false && n.status !== 'hidden';
for (const n of nodes) {
  if (n.genre !== 'town' || !usableNode(n)) continue;
  for (const m of [...(n.borders || []), ...(n.contains || [])]) if (usableNode(byId.get(m)) && !adj.get(n.id).has(m)) { link(n.id, m); townEdges++; }
}

// ---------- 分断の橋渡し ----------
// 離島(2026-10-20 ユーザー決定): 海の上で町どうしはつながらない。陸からも航路からも行けない島に町があれば、島の港から、
// 港が無ければ島に仮の港(pp-。名前は「<町>港(仮)」)を作って、いちばん近い港へ「幻の航路」を引く。幻の航路は 1 日に 20 分だけ使える(航路ごとに時間をずらす)
// (server/map/data/routes/src-phantom.json。出典 src-phantom)。海を通らない分断(山の中など)は、今までどおり近い拠点へ橋をかける。町の無い島にも港を付ける(2026-10-20)
const PHANTOM_SRC = 'src-phantom';
// 開く 20 分は航路ごとにずらす(2026-10-20 ユーザー決定)。航路の id から 20 分刻みの 72 通りのどれかに決める(同じ航路は毎日同じ時間。サーバーの時計の UTC)
const PHANTOM_MIN = 20;
const phantomHours = (id) => { const slot = parseInt(id.slice(3, 11), 16) % (1440 / PHANTOM_MIN); const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; return [{ from: hm(slot * PHANTOM_MIN), to: hm(slot * PHANTOM_MIN + PHANTOM_MIN) }]; };
const hackable = nodes.filter((n) => n.hackable !== false && n.status !== 'hidden'); // 非公開の拠点(自衛隊・米軍の飛行場など)は線の対象外
const parent = new Map(hackable.map((n) => [n.id, n.id]));
const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
const union = (a, b) => { parent.set(find(a), find(b)); };
for (const n of hackable) for (const m of adj.get(n.id)) union(n.id, m);
// 航路でつながる空港・港は同じまとまりとして数える(2026-10-20: 海の上で町どうしはつながらないので、島へは航路で渡る。航路のある島には橋をかけない)
let routeJoins = 0;
{
  const { readRouteFiles, deriveRoutes } = require('../server/map/routes');
  const { loadSources } = require('../server/map/sources');
  const { byNode } = deriveRoutes(Object.fromEntries(nodes.map((n) => [n.id, n])), readRouteFiles().filter((x) => x.data.source !== PHANTOM_SRC), loadSources()); // 前回の幻の航路は数えない(作り直す)
  for (const [id, list] of byNode) for (const r of list) if (parent.has(id) && parent.has(r.to) && find(id) !== find(r.to)) { union(id, r.to); routeJoins++; }
}
// いちばん小さいまとまりから、外側でいちばん近い拠点へ橋を 1 本かける、を 1 つになるまで繰り返す。
// 小さいまとまり × 全拠点で済むので、全国(約 9,000 駅)でも速い(以前は全拠点 × 全拠点を毎回)
const { seaCross, firstCoast, onLand } = require('./sea').makeSea(ROOT);
const { routeId } = require('../server/map/routes');
const isPort = (n) => n.genre === 'port' && n.gateway && n.hackable !== false && n.status !== 'hidden';
const allPorts = hackable.filter(isPort);
const fileOf = new Map(); for (const x of FILES) for (const n of x.T.nodes) fileOf.set(n.id, x.T);
const bridges = [], seaBridges = [], phantomRoutes = [], phantomPorts = [];
const kmText = (d) => (d >= 10 ? d.toFixed(0) + ' km' : (d * 1000).toFixed(0) + ' m');

// 道でつながる島(2026-10-20 ユーザー決定: 道がつながっているところは船ではなく、ふつうの拠点の線で結ぶ)。
// tools/fetch-road-links.js が国土地理院の道路中心線で調べた結果(server/map/data/derived/road-links.json)の組を結ぶ
const ROAD_FILE = path.join(DATA, 'derived', 'road-links.json');
const roadLinks = fs.existsSync(ROAD_FILE) ? JSON.parse(fs.readFileSync(ROAD_FILE, 'utf8')).links : [];
let roadJoins = 0;
for (const r of roadLinks) if (parent.has(r.a) && parent.has(r.b)) { link(r.a, r.b); if (find(r.a) !== find(r.b)) roadJoins++; union(r.a, r.b); }

// 海で隔てられたまとまりの、向こう岸に近いところ(向こう岸の陸地ごと、近い順に 6 か所まで)。
// 道でつながっているかを調べる場所として server/map/data/derived/sea-gaps.json に書く(tools/fetch-road-links.js が読む)
{
  const G = 0.05, grid = new Map();
  for (const n of hackable) { const k = `${Math.floor(n.lat / G)}:${Math.floor(n.lon / G)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
  const comps = new Map();
  for (const n of hackable) { const k = find(n.id); if (!comps.has(k)) comps.set(k, []); comps.get(k).push(n); }
  const main = [...comps.values()].reduce((x, y) => (y.length > x.length ? y : x));
  const gaps = [];
  for (const list of comps.values()) {
    if (list === main) continue;
    const key = find(list[0].id);
    // 島の拠点ごとに、向こう岸の陸地(まとまり)ごとのいちばん近い拠点(いちばん近い陸地が別の島で、橋は本土へ架かっていることがある。笠戸島など)
    const cand = [];
    for (const a of list) {
      const bestBy = new Map(); // 向こう岸のまとまり → いちばん近い組
      const cy = Math.floor(a.lat / G), cx = Math.floor(a.lon / G);
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) for (const b of grid.get(`${cy + dy}:${cx + dx}`) || []) {
        const kb = find(b.id); if (kb === key) continue;
        const d = distKm(a, b); if (d > 20) continue;
        const cur = bestBy.get(kb); if (!cur || d < cur.d) bestBy.set(kb, { a, b, d, kb });
      }
      cand.push(...bestBy.values());
    }
    cand.sort((p, q) => p.d - q.d);
    // 近い順に 6 か所まで: 向こう岸のまとまりが新しいか、島の側の場所が 3 km 以上離れているもの
    const picked = [];
    for (const c of cand) {
      if (picked.length >= 6) break;
      if (picked.some((p) => p.kb === c.kb && distKm(p.a, c.a) < 3)) continue;
      if (seaCross(c.a, c.b)) picked.push(c);
    }
    if (picked.length) gaps.push({ comp: list[0].id, size: list.length, ...(list.length <= 60 ? { nodes: list.map((n) => ({ id: n.id, lat: n.lat, lon: n.lon })) } : {}), pairs: picked.map((p) => ({ a: p.a.id, b: p.b.id, aLat: p.a.lat, aLon: p.a.lon, bLat: p.b.lat, bLon: p.b.lon, km: Number(p.d.toFixed(3)) })) });
  }
  fs.mkdirSync(path.join(DATA, 'derived'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'derived', 'sea-gaps.json'), JSON.stringify({ schema: 'pc.derived.sea-gaps/1', note: '海で隔てられたまとまりの、向こう岸にいちばん近いところ(tools/import-links.js が書き、tools/fetch-road-links.js が道でつながっているかを調べる)', gaps }) + '\n');
}
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
  const overSea = seaCross(best.a, best.b);
  const towns = small.filter((n) => n.genre === 'town');
  if (overSea) { // 海で隔てられた島は、町が無くても港を付ける(2026-10-20 ユーザー: 港をとにかく付けて近くの島と結ぶ)
    // 島の港(あれば)か、町。そこからいちばん近い、島の外の港
    const own = small.find(isPort);
    let pick = null;
    for (const s of own ? [own] : towns.length ? towns : small) for (const q of allPorts) {
      if (find(q.id) === key) continue;
      const d = distKm(s, q);
      if (!pick || d < pick.d) pick = { s, q, d };
    }
    if (pick) {
      let port = own;
      if (!port) { // 仮の港: 町の代表点から結ぶ先の港へ進み、最初に海岸に出る点の 40 m 手前(陸側)に置く(2026-10-20 ユーザー指摘: 島の真ん中にあった)。
        // 町の代表点からは 30 m 以上離す(同じ場所に 2 つの拠点を置かない)。海岸が見つからなければ 150 m ずらす
        const t = pick.s;
        const coast = onLand(t) ? firstCoast(t, pick.q) : null; // 町の代表点が陸の外なら、海岸は探さない(遠くの別の陸地の海岸を拾う)
        let k = Math.min(1, 0.15 / Math.max(pick.d, 0.001));
        if (coast) {
          const kc = Math.max(0.03 / Math.max(pick.d, 0.001), coast.t - 0.04 / Math.max(pick.d, 0.001));
          const c = { lat: t.lat + (pick.q.lat - t.lat) * kc, lon: t.lon + (pick.q.lon - t.lon) * kc };
          if (onLand(c) && !seaCross(t, c)) k = kc; // 島の陸の上で、町から海を渡らずに行ける所だけ
        }
        const at = { lat: Number((t.lat + (pick.q.lat - t.lat) * k).toFixed(5)), lon: Number((t.lon + (pick.q.lon - t.lon) * k).toFixed(5)) };
        port = { id: `pp-${t.id}`, name: `${t.name}港(仮)`, genre: 'port', kind: 'GW', area: t.area, region: t.region, lat: at.lat, lon: at.lon,
          level: L.PORT_MIN, value: L.PORT_MIN, src: PHANTOM_SRC, gateway: { type: 'port', scope: 'domestic' } };
        fileOf.get(t.id).nodes.push(port); nodes.push(port); byId.set(port.id, port); hackable.push(port); allPorts.push(port);
        adj.set(port.id, new Set()); parent.set(port.id, port.id);
        link(port.id, t.id); union(port.id, t.id);
        phantomPorts.push(port.name);
      }
      const q = pick.q;
      phantomRoutes.push({ mode: 'sea', from: port.id, to: q.id, fromRef: { scheme: 'internal', value: port.id }, toRef: { scheme: 'internal', value: q.id },
        bidirectional: true, scope: 'domestic', serviceTypes: ['passenger'], phantom: true, status: 'seasonal', hours: phantomHours(routeId({ src: PHANTOM_SRC, mode: 'sea', from: port.id, to: q.id })), src: PHANTOM_SRC,
        sourceRecordId: `phantom-${phantomRoutes.length + 1}`, retrievedAt: TODAY, note: `幻の航路: ${port.name} – ${q.name}(${kmText(distKm(port, q))}。1 日 20 分だけ)`,
        id: routeId({ src: PHANTOM_SRC, mode: 'sea', from: port.id, to: q.id }) });
      union(port.id, q.id);
      continue;
    }
  }
  link(best.a.id, best.b.id); union(best.a.id, best.b.id);
  const text = `${best.a.name}–${best.b.name} (${kmText(best.d)})`;
  bridges.push(text);
  if (overSea) seaBridges.push(text);
}
{ // 幻の航路の記録(毎回作り直す)
  const file = path.join(DATA, 'routes', `${PHANTOM_SRC}.json`);
  const head = { schema: 'pc.routes/1', source: PHANTOM_SRC, generatedAt: `${TODAY}T00:00:00.000Z`, note: '幻の航路(tools/import-links.js が作る。陸からも航路からも行けない島の港・仮の港と、いちばん近い港を結ぶ。1 日 20 分だけ使える)' };
  fs.writeFileSync(file, JSON.stringify(head, null, 2).replace(/\n}$/, ',\n  "routes": [\n') + phantomRoutes.map((x) => '    ' + JSON.stringify(x)).join(',\n') + '\n  ]\n}\n');
}

// 陸の線が 1 本も無い拠点(航路でつながるので橋渡しの対象にならなかった、町から遠い港など)は、いちばん近い拠点と 1 本つなぐ
for (const a of hackable) {
  if (adj.get(a.id).size) continue;
  let best = null;
  for (const b of hackable) { if (b.id === a.id) continue; const d = distKm(a, b); if (!best || d < best.d) best = { b, d }; }
  if (!best) continue;
  link(a.id, best.b.id);
  bridges.push(`${a.name}–${best.b.name} (${kmText(best.d)})`);
}

// 路線の線の形を書き出す: 約 60 m で間引き、両端(駅)は除いて途中の点だけ。途中の点が無ければ [](まっすぐ)
{
  const simplify = (pts, tol) => {
    if (pts.length <= 2) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop(); const [ax, ay] = pts[i0], [bx, by] = pts[i1]; const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let best = -1, bd = tol * tol;
      for (let i = i0 + 1; i < i1; i++) { const [px, py] = pts[i]; let u = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u)); const ex = ax + u * dx - px, ey = ay + u * dy - py, d2 = ex * ex + ey * ey; if (d2 > bd) { bd = d2; best = i; } }
      if (best >= 0) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const out = {};
  for (const [k, pts] of [...railPaths].sort((p, q) => (p[0] < q[0] ? -1 : 1))) out[k] = simplify(pts, 0.0006).slice(1, -1).map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))]);
  fs.writeFileSync(path.join(ROOT, 'public/data/rail-paths.json'), JSON.stringify({ schema: 'pc.rail-paths/1', note: '路線の線の形(国土数値情報 鉄道データ N02 の線路を約 60 m で間引いたもの。両端の駅は除く)。tools/import-links.js が作る', paths: out }) + '\n');
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
console.log(`対象 ${FILES.length} ファイル ${nodes.length} 拠点。路線のつながり ${lineEdges / 2} 本、名所のつながり ${landmarkEdges} 本(5 km 以内に見通せる駅が無い名所 ${landmarkAlone}。間に町があって外した駅 ${landmarkBlocked})、町・字のつながり ${townEdges} 本、航路でつながったまとまり ${routeJoins}、橋 ${bridges.length} 本。拠点に結びつかなかった N02 の駅 ${unmapped} 件(対象外の都道府県など)`);
console.log('つながりの本数 → 拠点数', JSON.stringify(deg));
console.log('多い順', top.map((t) => `${t.name} ${t.d}`).join(' / '));
if (bridges.length) console.log('橋:', bridges.join(' / '));
console.log(`離島: 幻の航路 ${phantomRoutes.length} 本(仮の港 ${phantomPorts.length} か所: ${phantomPorts.join('、')})。海をまたぐ橋(町の無い島など) ${seaBridges.length} 本: ${seaBridges.join(' / ')}`);
