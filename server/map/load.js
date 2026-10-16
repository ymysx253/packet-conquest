'use strict';
// 地域ごとの拠点マスター(server/map/data/<region>.json)を読み込み、検証する。
// JSON の項目は Cosmos DB の nodes コンテナーと同じ(設計書 8.7)。将来は DB から読む。

const fs = require('fs');
const path = require('path');
const { buildLinks, nearest } = require('./geo');

const DATA_DIR = path.join(__dirname, 'data');
const LEVEL_MIN = 1, LEVEL_MAX = 999; // 1〜10 が基本(国は 10)。11〜999 は拡張用。形は public/shapes.js
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
    return {
      id: r.id, type: 'region', name: r.name, nameEn: r.nameEn || null, kind: r.kind, tier: KINDS[r.kind].tier,
      kindLabel: KINDS[r.kind].label, localKind: r.localKind || null, code: r.code || null, country: countryOf(r.id),
      parent: r.parent, path, depth: path.length - 1, status: r.status || 'public', nodeFile: r.nodeFile || null,
      center: s ? { lat: Number((s.lat / s.count).toFixed(5)), lon: Number((s.lon / s.count).toFixed(5)) } : null,
      bbox: s ? { minLat: s.minLat, maxLat: s.maxLat, minLon: s.minLon, maxLon: s.maxLon } : null,
      nodeCount: s ? s.count : 0, levels: s ? s.levels : {},
      level: null, // 地域そのものを拠点として出すときのレベル(未決: DESIGN.md / LEVELS.md #1)
    };
  });
}

// 読み込んだデータの形を確かめる。おかしければ起動時に止める
function validate(region, data) {
  if (!data || !Array.isArray(data.nodes)) fail(region, 'nodes がありません');
  if (!data.kinds || typeof data.kinds !== 'object') fail(region, 'kinds がありません');
  const sp = data.spawn;
  if (!sp || typeof sp.lat !== 'number' || typeof sp.lon !== 'number' || !(sp.radiusKm > 0)) fail(region, 'spawn が不正です');
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
  }
}

function loadRegion(region) {
  const file = path.join(DATA_DIR, `${region}.json`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(region, `読み込めません (${e.message})`); }
  validate(region, data);

  const KINDS = data.kinds;
  const NODES = data.nodes.map((n, i) => ({
    id: n.id, name: n.name, kind: n.kind, kindLabel: KINDS[n.kind], area: n.area, region: n.region,
    lat: n.lat, lon: n.lon, level: n.level, value: n.value,
    // 存在するがハック不可(寺社、重要インフラ。設計書 8.16 / PLACES.md)。線をつながず攻撃できない
    hackable: n.hackable !== false,
    tags: Array.isArray(n.tags) ? n.tags : [],
    // 問題生成に使う架空のネットワーク 10.(i+1).0.0/16(順番で決まる。DB 化したら項目として持つ)
    base: ((10 << 24) >>> 0) + (i + 1) * 65536,
    subnet: `10.${i + 1}.0.0/16`,
  }));
  if (NODES.length > 250) fail(region, '拠点が多すぎます(10.x.0.0/16 は 250 まで)');

  const EDGES = buildLinks(NODES.filter((n) => n.hackable), 3);
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const ADJ = Object.fromEntries(NODES.map((n) => [n.id, []]));
  for (const { a, b } of EDGES) { ADJ[a].push(b); ADJ[b].push(a); }
  const AREAS = [...new Set(NODES.map((n) => n.area))];

  return {
    REGION: data.region, REGION_NAME: data.name, VERSION: data.version,
    KINDS, NODES, EDGES, ADJ, byId, AREAS,
    SPAWN_CENTER: { lat: data.spawn.lat, lon: data.spawn.lon, radiusKm: data.spawn.radiusKm, name: data.spawn.name },
    nearestNodes: (lat, lon, k) => nearest(NODES, lat, lon, k),
  };
}

module.exports = { loadRegion, validate, loadRegions, validateRegions, regionDocs };
