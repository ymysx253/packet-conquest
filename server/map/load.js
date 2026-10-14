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

// 読み込んだデータの形を確かめる。おかしければ起動時に止める
function validate(region, data) {
  if (!data || !Array.isArray(data.nodes)) fail(region, 'nodes がありません');
  if (!data.kinds || typeof data.kinds !== 'object') fail(region, 'kinds がありません');
  const sp = data.spawn;
  if (!sp || typeof sp.lat !== 'number' || typeof sp.lon !== 'number' || !(sp.radiusKm > 0)) fail(region, 'spawn が不正です');
  const ids = new Set(), names = new Set();
  for (const n of data.nodes) {
    const where = n && n.id ? n.id : JSON.stringify(n);
    for (const k of ['id', 'name', 'kind', 'area']) if (typeof n[k] !== 'string' || !n[k]) fail(region, `${where}: ${k} が必要です`);
    if (!/^[a-z0-9-]+$/.test(n.id)) fail(region, `${n.id}: id は英小文字・数字・ハイフンだけ`);
    if (ids.has(n.id)) fail(region, `${n.id}: id が重複`);
    if (names.has(n.name)) fail(region, `${n.name}: 名称が重複`);
    ids.add(n.id); names.add(n.name);
    if (!data.kinds[n.kind]) fail(region, `${n.id}: kind が不正 ${n.kind}`);
    if (typeof n.lat !== 'number' || typeof n.lon !== 'number' || n.lat < -90 || n.lat > 90 || n.lon < -180 || n.lon > 180) fail(region, `${n.id}: 緯度・経度が不正`);
    if (!Number.isInteger(n.level) || n.level < LEVEL_MIN || n.level > LEVEL_MAX) fail(region, `${n.id}: level は ${LEVEL_MIN}〜${LEVEL_MAX}`);
    if (!Number.isInteger(n.value) || n.value < VALUE_MIN || n.value > VALUE_MAX) fail(region, `${n.id}: value は ${VALUE_MIN}〜${VALUE_MAX}`);
  }
}

function loadRegion(region) {
  const file = path.join(DATA_DIR, `${region}.json`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(region, `読み込めません (${e.message})`); }
  validate(region, data);

  const KINDS = data.kinds;
  const NODES = data.nodes.map((n, i) => ({
    id: n.id, name: n.name, kind: n.kind, kindLabel: KINDS[n.kind], area: n.area,
    lat: n.lat, lon: n.lon, level: n.level, value: n.value,
    tags: Array.isArray(n.tags) ? n.tags : [],
    // 問題生成に使う架空のネットワーク 10.(i+1).0.0/16(順番で決まる。DB 化したら項目として持つ)
    base: ((10 << 24) >>> 0) + (i + 1) * 65536,
    subnet: `10.${i + 1}.0.0/16`,
  }));
  if (NODES.length > 250) fail(region, '拠点が多すぎます(10.x.0.0/16 は 250 まで)');

  const EDGES = buildLinks(NODES, 3);
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

module.exports = { loadRegion, validate };
