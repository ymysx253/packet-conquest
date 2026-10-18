'use strict';
// 地域ごとの拠点マスター(server/map/data/<region>.json)を読み込み、検証する。
// JSON の項目は Cosmos DB の nodes コンテナーと同じ(設計書 8.7)。将来は DB から読む。

const fs = require('fs');
const path = require('path');
const { buildLinks, nearest, tileFields, addrOf } = require('./geo');

const DATA_DIR = path.join(__dirname, 'data');
const LEVEL_MIN = 1, LEVEL_MAX = 999; // 1〜10 が基本(国は 10)。11〜999 は拡張用。形は public/shapes.js
// 拠点に使ってよい名所のジャンル(docs/PLACES.md 第2章と同じ)
const GENRES = new Set(['station', 'bus_terminal', 'airport', 'port', 'bridge', 'tower', 'park', 'nature', 'zoo_aquarium', 'museum', 'library', 'theater', 'stadium', 'heritage', 'monument', 'shrine_temple', 'government', 'university', 'market', 'convention', 'complex', 'observatory', 'ix']);
const VALUE_MIN = 1, VALUE_MAX = 999;

function fail(region, msg) { throw new Error(`拠点マスター ${region}: ${msg}`); }

// ---------- 地域マスター(server/map/data/regions.json。Cosmos DB の regions コンテナーと同じ項目) ----------
// 世界共通の階層。kind ごとに tier(段)を持ち、親は必ず自分より浅い段。国ごとに段数が違うので、
// 「地方」のない国は国 → 州 のように段を飛ばしてよい。拠点は leafKinds(市・区、地区)にだけ属せる。

function validateRegions(data) {
  if (!data || !Array.isArray(data.regions)) throw new Error('地域マスター: regions がありません');
  if (!data.kinds || typeof data.kinds !== 'object') throw new Error('地域マスター: kinds がありません');
  const tierOf = (kind) => (data.kinds[kind] && Number.isInteger(data.kinds[kind].tier) ? data.kinds[kind].tier : null);
  const leaf = Array.isArray(data.leafKinds) ? data.leafKinds : [];
  for (const k of leaf) if (tierOf(k) === null) throw new Error(`地域マスター: leafKinds の ${k} が kinds にありません`);
  const byId = new Map();
  for (const r of data.regions) {
    const where = r && r.id ? r.id : JSON.stringify(r);
    for (const k of ['id', 'name', 'kind']) if (typeof r[k] !== 'string' || !r[k]) throw new Error(`地域マスター ${where}: ${k} が必要です`);
    if (!/^[a-z0-9-]+$/.test(r.id)) throw new Error(`地域マスター ${r.id}: id は英小文字・数字・ハイフンだけ`);
    if (byId.has(r.id)) throw new Error(`地域マスター ${r.id}: id が重複`);
    if (tierOf(r.kind) === null) throw new Error(`地域マスター ${r.id}: kind が不正 ${r.kind}`);
    if (!(r.parent === null || typeof r.parent === 'string')) throw new Error(`地域マスター ${r.id}: parent は id か null`);
    if (r.code != null && typeof r.code !== 'string') throw new Error(`地域マスター ${r.id}: code は文字列か null`);
    byId.set(r.id, r);
  }
  let roots = 0;
  for (const r of data.regions) {
    if (r.parent === null) {
      if (tierOf(r.kind) !== 0) throw new Error(`地域マスター ${r.id}: parent が無いのは最上位(tier 0)だけ`);
      roots++; continue;
    }
    if (!byId.has(r.parent)) throw new Error(`地域マスター ${r.id}: parent ${r.parent} がありません`);
    const pt = tierOf(byId.get(r.parent).kind), t = tierOf(r.kind);
    if (!(pt < t)) throw new Error(`地域マスター ${r.id}: parent ${r.parent}(tier ${pt})は自分(tier ${t})より浅い段であるべき`);
  }
  if (roots !== 1) throw new Error(`地域マスター: 最上位(tier 0)はちょうど 1 つ(いま ${roots})`);
  return byId;
}

let regionsCache = null;
function loadRegions() {
  if (regionsCache) return regionsCache;
  const file = path.join(DATA_DIR, 'regions.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`地域マスター: 読み込めません (${e.message})`); }
  const byId = validateRegions(data);
  const children = {};
  for (const r of data.regions) if (r.parent) (children[r.parent] ||= []).push(r.id);
  // 先祖をたどる(世界まで)
  const ancestors = (id) => { const out = []; let cur = byId.get(id); while (cur && cur.parent) { out.push(cur.parent); cur = byId.get(cur.parent); } return out; };
  const tierOf = (id) => { const r = byId.get(id); return r ? data.kinds[r.kind].tier : null; };
  const isLeaf = (id) => { const r = byId.get(id); return !!r && data.leafKinds.includes(r.kind); };
  // 国(tier 2)を返す。拠点がどの国に属するかに使う
  const countryOf = (id) => [id, ...ancestors(id)].find((x) => byId.get(x).kind === 'country') || null;
  regionsCache = { REGIONS: data.regions, KINDS: data.kinds, LEAF_KINDS: data.leafKinds, byId, children, ancestors, tierOf, isLeaf, countryOf, VERSION: data.version };
  return regionsCache;
}

// Cosmos DB に入れる形(派生値つき)。nodes を渡すと中心・範囲・拠点数・レベル分布を付ける
function regionDocs(nodes = []) {
  const { REGIONS, byId, ancestors } = loadRegions();
  const stats = {};
  for (const n of nodes) {
    if (!n.region) continue;
    for (const rid of [n.region, ...ancestors(n.region)]) {
      const s = (stats[rid] ||= { count: 0, lat: 0, lon: 0, minLat: 90, maxLat: -90, minLon: 180, maxLon: -180, levels: {} });
      s.count++; s.lat += n.lat; s.lon += n.lon;
      s.minLat = Math.min(s.minLat, n.lat); s.maxLat = Math.max(s.maxLat, n.lat);
      s.minLon = Math.min(s.minLon, n.lon); s.maxLon = Math.max(s.maxLon, n.lon);
      s.levels[n.level] = (s.levels[n.level] || 0) + 1;
    }
  }
  const { KINDS, countryOf } = loadRegions();
  return REGIONS.map((r) => {
    const s = stats[r.id];
    const path = [...ancestors(r.id)].reverse().concat(r.id);
    const state = path.find((id) => byId.get(id) && byId.get(id).kind === 'state') || null; // 所属する都道府県(形ファイルの単位)
    return {
      state,
      id: r.id, type: 'region', name: r.name, nameEn: r.nameEn || null, kind: r.kind, tier: KINDS[r.kind].tier,
      kindLabel: KINDS[r.kind].label, localKind: r.localKind || null, code: r.code || null, country: countryOf(r.id),
      parent: r.parent, path, depth: path.length - 1, status: r.status || 'public', nodeFile: r.nodeFile || null,
      center: s ? { lat: Number((s.lat / s.count).toFixed(5)), lon: Number((s.lon / s.count).toFixed(5)) } : null,
      bbox: s ? { minLat: s.minLat, maxLat: s.maxLat, minLon: s.minLon, maxLon: s.maxLon } : null,
      nodeCount: s ? s.count : 0, levels: s ? s.levels : {},
      control: null, // 支配の集計(World が更新。{ total, counts, controller, updatedAt }。第 14 章)
    };
  });
}

// 読み込んだデータの形を確かめる。おかしければ起動時に止める
function validate(region, data) {
  if (!data || !Array.isArray(data.nodes)) fail(region, 'nodes がありません');
  if (!data.kinds || typeof data.kinds !== 'object') fail(region, 'kinds がありません');
  const sp = data.spawn;
  if (sp !== undefined && (!sp || typeof sp.lat !== 'number' || typeof sp.lon !== 'number' || !(sp.radiusKm > 0))) fail(region, 'spawn が不正です');
  const ids = new Set(), names = new Set();
  const regions = loadRegions();
  for (const n of data.nodes) {
    const where = n && n.id ? n.id : JSON.stringify(n);
    for (const k of ['id', 'name', 'kind', 'area', 'region']) if (typeof n[k] !== 'string' || !n[k]) fail(region, `${where}: ${k} が必要です`);
    const reg = regions.byId.get(n.region);
    if (!reg) fail(region, `${n.id}: region ${n.region} が地域マスターにありません`);
    if (!regions.isLeaf(n.region)) fail(region, `${n.id}: region は最下層(${regions.LEAF_KINDS.join('/')})を指すこと(${reg.kind})`);
    if (reg.name !== n.area) fail(region, `${n.id}: area「${n.area}」と region「${reg.name}」が食い違います`);
    if (!/^[a-z0-9-]+$/.test(n.id)) fail(region, `${n.id}: id は英小文字・数字・ハイフンだけ`);
    if (ids.has(n.id)) fail(region, `${n.id}: id が重複`);
    if (names.has(n.name)) fail(region, `${n.name}: 名称が重複`);
    ids.add(n.id); names.add(n.name);
    if (!data.kinds[n.kind]) fail(region, `${n.id}: kind が不正 ${n.kind}`);
    if (typeof n.lat !== 'number' || typeof n.lon !== 'number' || n.lat < -90 || n.lat > 90 || n.lon < -180 || n.lon > 180) fail(region, `${n.id}: 緯度・経度が不正`);
    if (!Number.isInteger(n.level) || n.level < LEVEL_MIN || n.level > LEVEL_MAX) fail(region, `${n.id}: level は ${LEVEL_MIN}〜${LEVEL_MAX}`);
    if (!Number.isInteger(n.value) || n.value < VALUE_MIN || n.value > VALUE_MAX) fail(region, `${n.id}: value は ${VALUE_MIN}〜${VALUE_MAX}`);
    if (n.hackable !== undefined && typeof n.hackable !== 'boolean') fail(region, `${n.id}: hackable は true/false`);
    // 名所のジャンル(docs/PLACES.md 第2章)。地名ではなく名所であることの担保
    if (typeof n.genre !== 'string' || !GENRES.has(n.genre)) fail(region, `${n.id}: genre が不正 ${n.genre}(PLACES.md のジャンルから選ぶ)`);
    if (n.genre !== 'station' && /[0-9０-９一二三四五六七八九十]+丁目/.test(n.name)) fail(region, `${n.id}: 丁目を含む名前は使わない(名所の名前にする。駅名は除く)`);
    // つながり(設計書 第 14 章): 突破に必要な正解の回数 = つながりの本数。tools/import-links.js が書く
    if (n.adj !== undefined) {
      if (!Array.isArray(n.adj) || n.adj.some((x) => typeof x !== 'string')) fail(region, `${n.id}: adj は拠点 id の配列`);
      if (n.hackable === false && n.adj.length) fail(region, `${n.id}: ハック不可の拠点に adj がある`);
      if (n.adj.includes(n.id)) fail(region, `${n.id}: adj に自分がいる`);
    }
  }
  // adj のつながり先が別のファイル(隣の都県)にあることがあるので、ここでは形だけ見る。全体での存在は loadAll が確かめる
  for (const n of data.nodes) for (const m of n.adj || []) if (!/^[a-z0-9-]+$/.test(m)) fail(region, `${n.id}: adj の ${m} が不正`);
}

function readRegionFile(region) {
  const file = path.join(DATA_DIR, `${region}.json`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(region, `読み込めません (${e.message})`); }
  validate(region, data);
  return data;
}
function loadRegion(region) {
  const data = readRegionFile(region);
  const KINDS = data.kinds;
  const NODES = data.nodes.map((n, i) => ({
    id: n.id, name: n.name, genre: n.genre, alias: n.alias || null, kind: n.kind, kindLabel: KINDS[n.kind], area: n.area, region: n.region,
    country: loadRegions().countryOf(n.region),
    ...tileFields(n.lat, n.lon),
    lat: n.lat, lon: n.lon, level: n.level, value: n.value,
    // 存在するがハック不可(寺社、重要インフラ。設計書 8.16 / PLACES.md)。線をつながず攻撃できない
    hackable: n.hackable !== false,
    lines: Array.isArray(n.lines) ? n.lines : [], // 駅の路線(事業者 路線名)。取り込み元: 国土数値情報
    tags: Array.isArray(n.tags) ? n.tags : [],
    // 問題生成に使う架空のネットワーク 10.(i+1).0.0/16(順番で決まる。DB 化したら項目として持つ)
    // 問題生成に使う架空のネットワーク。拠点 id から決定的に決める(上限なし。DESIGN.md 第 13 章)
    ...addrOf(n.id),
    adj: Array.isArray(n.adj) ? [...n.adj] : [],
    adjMaster: Array.isArray(n.adj) ? [...n.adj] : [], // マスターの原文(別のファイルの拠点への線を含む。loadAll が使う)
  }));

  // つながり(設計書 第 14 章): マスターの adj を両向きにそろえる。adj が無い地域(古いマスター)は近い 3 拠点で代用
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const hasAdj = NODES.some((n) => n.adj.length);
  const ADJ = Object.fromEntries(NODES.map((n) => [n.id, new Set()]));
  if (hasAdj) {
    for (const n of NODES) for (const m of n.adj) if (byId[m] && n.hackable && byId[m].hackable) { ADJ[n.id].add(m); ADJ[m].add(n.id); }
  } else {
    for (const { a, b } of buildLinks(NODES.filter((n) => n.hackable), 3)) { ADJ[a].add(b); ADJ[b].add(a); }
  }
  for (const n of NODES) { n.adj = [...ADJ[n.id]].sort(); ADJ[n.id] = n.adj; n.hits = Math.max(1, n.adj.length); }
  const EDGES = [];
  for (const n of NODES) for (const m of n.adj) if (n.id < m) EDGES.push({ a: n.id, b: m });
  const AREAS = [...new Set(NODES.map((n) => n.area))];

  return {
    REGION: data.region, REGION_NAME: data.name, VERSION: data.version,
    KINDS, NODES, EDGES, ADJ, byId, AREAS,
    SPAWN_CENTER: data.spawn ? { lat: data.spawn.lat, lon: data.spawn.lon, radiusKm: data.spawn.radiusKm, name: data.spawn.name } : null,
    nearestNodes: (lat, lon, k) => nearest(NODES, lat, lon, k),
  };
}

// 地域マスターで nodeFile を持つ都道府県のファイルを全部読み、1 つにまとめる。つながり(adj)は都県境をまたぐので全体で組む
let allCache = null;
function loadAll() {
  if (allCache) return allCache;
  const regions = loadRegions();
  const files = regions.REGIONS.filter((r) => r.nodeFile).map((r) => r.nodeFile);
  if (!files.length) throw new Error('地域マスターに nodeFile を持つ都道府県がありません');
  const parts = files.map((f) => loadRegion(f));
  const NODES = parts.flatMap((p) => p.NODES);
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const dupId = NODES.map((n) => n.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupId.length) throw new Error(`拠点マスター: id が複数のファイルで重複: ${dupId.slice(0, 5).join(', ')}`);
  // 全体で adj をそろえる(存在しない相手は落とす。両向きに)
  const ADJ = Object.fromEntries(NODES.map((n) => [n.id, new Set()]));
  for (const n of NODES) for (const m of n.adjMaster || n.adj || []) if (byId[m] && n.hackable && byId[m].hackable) { ADJ[n.id].add(m); ADJ[m].add(n.id); }
  for (const n of NODES) { n.adj = [...ADJ[n.id]].sort(); ADJ[n.id] = n.adj; n.hits = Math.max(1, n.adj.length); delete n.adjMaster; }
  const EDGES = [];
  for (const n of NODES) for (const m of n.adj) if (n.id < m) EDGES.push({ a: n.id, b: m });
  const KINDS = Object.assign({}, ...parts.map((p) => p.KINDS));
  const spawnPart = parts.find((p) => p.SPAWN_CENTER) || parts[0];
  allCache = {
    REGION: 'japan', REGION_NAME: '日本', FILES: files, VERSION: parts.map((p) => p.VERSION).join('.'),
    KINDS, NODES, EDGES, ADJ, byId, AREAS: [...new Set(NODES.map((n) => n.area))],
    SPAWN_CENTER: spawnPart.SPAWN_CENTER,
    nearestNodes: (lat, lon, k) => nearest(NODES, lat, lon, k),
  };
  return allCache;
}

// Cosmos DB の nodes に入れる形(docs/DB.md 3.2)。ゲーム状態の初期値つき
function nodeDocs(nodes, now = Date.now()) {
  return nodes.map((m) => ({
    id: m.id, type: 'node', name: m.name, genre: m.genre, alias: m.alias || null, kind: m.kind, kindLabel: m.kindLabel,
    area: m.area, country: m.country, region: m.region, lat: m.lat, lon: m.lon,
    location: { type: 'Point', coordinates: [m.lon, m.lat] },
    t0: m.t0, t1: m.t1, t2: m.t2, t3: m.t3, t4: m.t4,
    level: m.level, value: m.value, hackable: m.hackable !== false, lines: m.lines || [], tags: m.tags || [],
    adj: m.adj || [], hits: m.hits || Math.max(1, (m.adj || []).length), // つながりと、突破に必要な正解の回数(第 14 章)
    subnet: m.subnet, base: m.base, span: m.span,
    status: 'public', isPlayerNode: false, registeredBy: null, sponsorId: null,
    owner: null, defense: 0, fortifiedAt: null, progress: {}, protectedUntil: 0, createdAt: now, updatedAt: now,
  }));
}

module.exports = { loadRegion, loadAll, readRegionFile, validate, loadRegions, validateRegions, regionDocs, nodeDocs, GENRES };
