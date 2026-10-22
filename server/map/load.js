'use strict';
// 地域ごとの拠点マスター(server/map/data/<region>.json)を読み込み、検証する。
// JSON の項目は Cosmos DB の nodes コンテナーと同じ(設計書 8.7)。将来は DB から読む。

const fs = require('fs');
const { hitsFromLinks } = require('./hits');
const path = require('path');
const { buildLinks, nearest, tileFields, addrOf } = require('./geo');
const { loadSources } = require('./sources');
const { readRouteFiles, deriveRoutes } = require('./routes');

// 外部の識別コード(docs/DATA-FORMAT.md 第 4 章)。キーは決まった名前だけ
const CODE_FORMATS = { iata: /^[A-Z0-9]{3}$/, icao: /^[A-Z0-9]{4}$/, unlocode: /^[A-Z]{2}[A-Z2-9]{3}$/, wikidata: /^Q[0-9]+$/, ksj: /^[0-9]+$/ };
const GATEWAY_TYPES = new Set(['airport', 'port', 'heliport', 'station']);
const GATEWAY_SCOPES = new Set(['international', 'domestic']);
const NODE_STATUSES = new Set(['public', 'hidden']);
// 非公開の理由: military = 自衛隊・米軍が設置・管理する飛行場(2026-10-18 決定。tools/military.js)
// restricted = 立ち入りが制限された場所(皇居、硫黄島・南鳥島・沖ノ鳥島など)
// disputed = 領有をめぐる争いがある地域(北方領土、尖閣諸島。2026-10-19)
const HIDDEN_REASONS = new Set(['military', 'restricted', 'disputed']);

const DATA_DIR = path.join(__dirname, 'data');
const LEVEL_MIN = 1, LEVEL_MAX = 999; // 1〜10 が基本(国は 10)。11〜999 は拡張用。形は public/shapes.js
// 拠点に使ってよい名所のジャンル(docs/PLACES.md 第2章と同じ)
const GENRES = new Set(['station', 'bus_terminal', 'airport', 'port', 'bridge', 'tower', 'park', 'nature', 'zoo_aquarium', 'museum', 'library', 'theater', 'stadium', 'heritage', 'monument', 'shrine_temple', 'government', 'university', 'market', 'convention', 'complex', 'observatory', 'ix', 'town', 'tourism']); // town = 町・字(2026-10-18。tools/import-towns.js)、tourism = 観光地(2026-10-19。tools/import-tourism.js)
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
    if (!n.region || (n.status && n.status !== 'public')) continue; // 非公開の拠点は地域の拠点数・範囲に入れない
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
      // 中心と範囲: 地域マスターにあれば(境界から求めた値)それを使い、無ければ拠点から求める
      center: r.center ? { lat: r.center.lat, lon: r.center.lon } : (s ? { lat: Number((s.lat / s.count).toFixed(5)), lon: Number((s.lon / s.count).toFixed(5)) } : null),
      bbox: Array.isArray(r.bbox) ? { minLat: r.bbox[1], maxLat: r.bbox[3], minLon: r.bbox[0], maxLon: r.bbox[2] } : (s ? { minLat: s.minLat, maxLat: s.maxLat, minLon: s.minLon, maxLon: s.maxLon } : null),
      nodeCount: s ? s.count : 0, levels: s ? s.levels : {},
      control: null, // 支配の集計(World が更新。{ total, counts, controller, updatedAt }。第 14 章)
    };
  });
}

// 読み込んだデータの形を確かめる。おかしければ起動時に止める
function validate(region, data) {
  if (!data || !Array.isArray(data.nodes)) fail(region, 'nodes がありません');
  if (!data.kinds || typeof data.kinds !== 'object') fail(region, 'kinds がありません');
  // 形式と既定の出典(docs/DATA-FORMAT.md 第 4 章、第 2 章)
  if (data.schema !== 'pc.nodes/1') fail(region, 'schema は pc.nodes/1');
  const sources = loadSources();
  if (!sources.byId.has(data.defaultSource)) fail(region, `defaultSource ${data.defaultSource} が出典の台帳に無い`);
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
    // 名前は同じジャンルの中で重ならない(ジャンルが違えば同じ名前でよい。町・字「諏訪湖」と自然の名所「諏訪湖」など。2026-10-19)
    if (names.has(`${n.genre}|${n.name}`)) fail(region, `${n.name}: 名称が重複(同じジャンルの中)`);
    ids.add(n.id); names.add(`${n.genre}|${n.name}`);
    if (!data.kinds[n.kind]) fail(region, `${n.id}: kind が不正 ${n.kind}`);
    if (typeof n.lat !== 'number' || typeof n.lon !== 'number' || n.lat < -90 || n.lat > 90 || n.lon < -180 || n.lon > 180) fail(region, `${n.id}: 緯度・経度が不正`);
    if (!Number.isInteger(n.level) || n.level < LEVEL_MIN || n.level > LEVEL_MAX) fail(region, `${n.id}: level は ${LEVEL_MIN}〜${LEVEL_MAX}`);
    if (!Number.isInteger(n.value) || n.value < VALUE_MIN || n.value > VALUE_MAX) fail(region, `${n.id}: value は ${VALUE_MIN}〜${VALUE_MAX}`);
    if (n.hackable !== undefined && typeof n.hackable !== 'boolean') fail(region, `${n.id}: hackable は true/false`);
    // 企業名の施設(命名権など)はハック不可(2026-10-19 決定)。企業名は画面に出す
    if (n.company !== undefined && (typeof n.company !== 'string' || !n.company)) fail(region, `${n.id}: company は企業名の文字列`);
    if (n.company && n.hackable !== false) fail(region, `${n.id}: 企業名の施設はハック不可(hackable: false)にする`);
    // 出典・識別コード・玄関口(docs/DATA-FORMAT.md 第 4 章)
    if (n.src !== undefined && !sources.byId.has(n.src)) fail(region, `${n.id}: src ${n.src} が出典の台帳に無い`);
    if (n.codes !== undefined) {
      if (!n.codes || typeof n.codes !== 'object' || Array.isArray(n.codes)) fail(region, `${n.id}: codes はオブジェクト`);
      for (const [k, v] of Object.entries(n.codes)) {
        if (k === 'ext') { if (!Array.isArray(v) || v.some((e) => !e || !sources.byId.has(e.scheme) || typeof e.value !== 'string' || !e.value)) fail(region, `${n.id}: codes.ext は [{ scheme: 出典 id, value }]`); continue; }
        if (!CODE_FORMATS[k]) fail(region, `${n.id}: codes の ${k} は決まった名前でない(${Object.keys(CODE_FORMATS).join('/')}/ext)`);
        if (typeof v !== 'string' || !CODE_FORMATS[k].test(v)) fail(region, `${n.id}: codes.${k} の形が違う(${v})`);
      }
    }
    if (n.wikidata !== undefined) fail(region, `${n.id}: wikidata は codes.wikidata に置く`);
    if (n.gateway !== undefined) {
      const g = n.gateway;
      if (!g || !GATEWAY_TYPES.has(g.type) || !GATEWAY_SCOPES.has(g.scope) || (g.hub !== undefined && typeof g.hub !== 'boolean')) fail(region, `${n.id}: gateway は { type, scope, hub? }`);
      if (n.hackable === false) fail(region, `${n.id}: ハック不可の拠点は玄関口(gateway)にしない`);
    }
    if (n.names !== undefined && (!n.names || typeof n.names !== 'object' || Object.values(n.names).some((v) => typeof v !== 'string'))) fail(region, `${n.id}: names は { 言語: 名前 }`);
    if (n.replacedBy !== undefined && (typeof n.replacedBy !== 'string' || !/^[a-z0-9-]+$/.test(n.replacedBy))) fail(region, `${n.id}: replacedBy は拠点 id`);
    if (n.routes !== undefined) fail(region, `${n.id}: 航路は拠点に書かず server/map/data/routes/ に置く(DATA-FORMAT.md 第 5 章)`);
    // 公開状態(DATA-FORMAT.md 第 4 章): hidden は DB には入れるがゲームでは使わない(線・航路・地域の集計・配信の対象外)。理由が要る
    if (n.status !== undefined && !NODE_STATUSES.has(n.status)) fail(region, `${n.id}: status は public か hidden`);
    if (n.status === 'hidden' && !HIDDEN_REASONS.has(n.hiddenReason)) fail(region, `${n.id}: 非公開の拠点は hiddenReason(${[...HIDDEN_REASONS].join('/')})が要る`);
    if (n.hiddenReason !== undefined && n.status !== 'hidden') fail(region, `${n.id}: hiddenReason は非公開の拠点だけ`);
    if (n.status === 'hidden' && Array.isArray(n.adj) && n.adj.length) fail(region, `${n.id}: 非公開の拠点に adj がある`);
    // 町・字(town): 境界が接している町・字(borders)と、中にある駅・名所(contains)。線は tools/import-links.js がこれから作る
    for (const k of ['borders', 'contains']) {
      if (n[k] === undefined) continue;
      if (n.genre !== 'town') fail(region, `${n.id}: ${k} は町・字(town)だけが持つ`);
      if (!Array.isArray(n[k]) || n[k].some((x) => typeof x !== 'string' || !/^[a-z0-9-]+$/.test(x))) fail(region, `${n.id}: ${k} は拠点 id の配列`);
    }
    if (n.genre === 'town' && !/^tw-[0-9]{5}-[0-9]{6}$/.test(n.id)) fail(region, `${n.id}: 町・字の id は tw-<市区町村コード>-<小地域コード>`);
    // 名所のジャンル(docs/PLACES.md 第2章)。地名ではなく名所であることの担保
    if (typeof n.genre !== 'string' || !GENRES.has(n.genre)) fail(region, `${n.id}: genre が不正 ${n.genre}(PLACES.md のジャンルから選ぶ)`);
    // 町・字は丁目をまとめて入れる(tools/import-towns.js)。名前そのものが「八丁目」の大字(春日部市 など)だけは例外
    const townWhole = n.genre === 'town' && /^[0-9０-９一二三四五六七八九十壱弐参]+丁目(\(.*\))?$/.test(n.name);
    if (n.genre !== 'station' && !townWhole && /[0-9０-９一二三四五六七八九十]+丁目/.test(n.name)) fail(region, `${n.id}: 丁目を含む名前は使わない(名所の名前にする。駅名は除く)`);
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
    company: n.company || null, // 命名権など企業名の施設の企業名(画面に出す)
    // 識別コード(駅は国土数値情報のグループコードを id から)、出典、玄関口、言語ごとの名前(DATA-FORMAT.md 第 4 章)
    codes: { ...(n.codes || {}), ...(/^st-[0-9]+$/.test(n.id) ? { ksj: n.id.slice(3) } : {}) },
    wikidata: (n.codes && n.codes.wikidata) || null, // 互換(codes.wikidata と同じ)
    src: n.src || data.defaultSource,
    gateway: n.gateway || null,
    names: n.names || null,
    status: n.status || 'public', hiddenReason: n.hiddenReason || null, // 公開状態(hidden は DB に入れるがゲームでは使わない)
    // 問題生成に使う架空のネットワーク 10.(i+1).0.0/16(順番で決まる。DB 化したら項目として持つ)
    // 問題生成に使う架空のネットワーク。拠点 id から決定的に決める(上限なし。DESIGN.md 第 13 章)
    ...addrOf(n.id),
    adj: Array.isArray(n.adj) ? [...n.adj] : [],
    adjMaster: Array.isArray(n.adj) ? [...n.adj] : [], // マスターの原文(別のファイルの拠点への線を含む。loadAll が使う)
    routes: [], // 航路の要約(loadAll が server/map/data/routes/ の記録から作る)
  }));

  // つながり(設計書 第 14 章): マスターの adj を両向きにそろえる。adj が無い地域(古いマスター)は近い 3 拠点で代用
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const hasAdj = NODES.some((n) => n.adj.length);
  const ADJ = Object.fromEntries(NODES.map((n) => [n.id, new Set()]));
  if (hasAdj) {
    for (const n of NODES) for (const m of n.adj) if (byId[m] && n.hackable && byId[m].hackable && n.status === 'public' && byId[m].status === 'public') { ADJ[n.id].add(m); ADJ[m].add(n.id); }
  } else {
    for (const { a, b } of buildLinks(NODES.filter((n) => n.hackable && n.status === 'public'), 3)) { ADJ[a].add(b); ADJ[b].add(a); }
  }
  for (const n of NODES) { n.adj = [...ADJ[n.id]].sort(); ADJ[n.id] = n.adj; n.links = Math.max(1, n.adj.length); n.hits = hitsFromLinks(n.links); }
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
  for (const n of NODES) for (const m of n.adjMaster || n.adj || []) if (byId[m] && n.hackable && byId[m].hackable && n.status === 'public' && byId[m].status === 'public') { ADJ[n.id].add(m); ADJ[m].add(n.id); }
  for (const n of NODES) { n.adj = [...ADJ[n.id]].sort(); ADJ[n.id] = n.adj; n.links = Math.max(1, n.adj.length); n.hits = hitsFromLinks(n.links); delete n.adjMaster; }
  // 航路(DATA-FORMAT.md 第 5 章): 拠点から独立した記録から、ゲームで使える航路だけを拠点ごとの要約にする。
  // 航路も突破回数に数える(2026-10-19 ユーザー決定: 奪うのが大変 = 維持が大変)。陸の線と同じ相手は 1 本として数える
  const ROUTE_FILES = readRouteFiles();
  const routes = deriveRoutes(byId, ROUTE_FILES, loadSources());
  for (const n of NODES) {
    n.routes = routes.byNode.get(n.id) || [];
    const extra = new Set(n.routes.map((r) => r.to).filter((t) => !n.adj.includes(t)));
    n.links = Math.max(1, n.adj.length + extra.size); // つながりの本数(陸の線 + 航路の行き先)
    n.hits = hitsFromLinks(n.links); // 突破に要る正解の回数 = √(つながりの本数) の切り上げ(2026-10-22 ユーザー決定。server/map/hits.js)
  }
  // 名前(2026-10-21 ユーザー決定): names は言語ごとの名前(ja 漢字、en 英語)。kana は日本語の名前の読み(ひらがな)。
  // 読みと英語は tools/import-yomi.js が作る derived/yomi.json から。読みは「拠点の情報」に出す(地図には出さない)。英語は英語の表示を作ったときに使う
  const YOMI_FILE = path.join(__dirname, 'data', 'derived', 'yomi.json');
  const yomi = fs.existsSync(YOMI_FILE) ? JSON.parse(fs.readFileSync(YOMI_FILE, 'utf8')).nodes : {};
  for (const n of NODES) {
    const y = yomi[n.id];
    n.names = { ...(n.names || {}), ja: n.name, ...(y && y[1] ? { en: y[1] } : {}) };
    if (y && y[0]) n.kana = y[0];
  }
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
    company: m.company || null, codes: m.codes || {}, src: m.src || null, gateway: m.gateway || null, names: m.names || null, kana: m.kana || null,
    adj: m.adj || [], links: m.links || Math.max(1, (m.adj || []).length), hits: m.hits || hitsFromLinks(m.links || (m.adj || []).length), // つながりと、その本数、突破に必要な正解の回数(第 14 章。2026-10-22 から √本数の切り上げ)
    routes: m.routes || [], // 航路(空路・海路)。行き先 { to, mode, name, lat, lon }。占領した空港・港から行き先を攻撃できる
    // 開いている時間(2026-10-19 ユーザー決定)。DB で管理する設定(設定画面で変える)。マスターの入れ直しでは上書きしない(tools/db-setup.js)。既定は 1 日中
    hours: m.hours || [{ from: '00:00', to: '00:00' }],
    subnet: m.subnet, base: m.base, span: m.span,
    status: m.status || 'public', ...(m.hiddenReason ? { hiddenReason: m.hiddenReason } : {}), isPlayerNode: false, registeredBy: null, sponsorId: null,
    owner: null, defense: 0, fortifiedAt: null, progress: {}, protectedUntil: 0, createdAt: now, updatedAt: now,
  }));
}

module.exports = { loadRegion, loadAll, readRegionFile, validate, loadRegions, validateRegions, regionDocs, nodeDocs, GENRES, NODE_STATUSES, HIDDEN_REASONS };
