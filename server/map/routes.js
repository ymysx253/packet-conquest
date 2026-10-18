'use strict';
// 航路の記録(docs/DATA-FORMAT.md 第 5 章)。拠点から独立した記録で、server/map/data/routes/<出典 id>.json に置く。
// 読み込み時に「ゲームで使える航路」だけを選び、拠点ごとの要約(行き先・種類・名前・座標)に変える(第 5.3 節)。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'data', 'routes');
const MODES = new Set(['air', 'sea']);                 // 今ゲームで使う種類
const MODES_RESERVED = new Set(['rail', 'cable', 'land']); // 予約(形式としては受け付け、ゲームではまだ使わない)
const STATUSES = new Set(['active', 'seasonal', 'suspended', 'planned', 'ended']);
const SCHEMES = new Set(['iata', 'icao', 'unlocode', 'wikidata', 'ksj', 'internal']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// 同じ入力からは同じ id(出典・種類・端点・運航者)
function routeId({ src, mode, from, to, carrier }) {
  const key = [src, mode, from, to, carrier || ''].join('|');
  return 'rt-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function validateRouteFile(name, data, sourcesById) {
  const fail = (m) => { throw new Error(`航路 ${name}: ${m}`); };
  if (!data || data.schema !== 'pc.routes/1') fail('schema は pc.routes/1');
  if (!sourcesById.has(data.source)) fail(`出典 ${data.source} が台帳に無い`);
  if (!Array.isArray(data.routes)) fail('routes が要る');
  const ids = new Set();
  for (const r of data.routes) {
    const w = `${r && r.id}`;
    if (!r || typeof r.id !== 'string' || !/^rt-[0-9a-f]{12}$/.test(r.id)) fail(`${w}: id は rt- + 12 桁`);
    if (ids.has(r.id)) fail(`${w}: id が重複`);
    ids.add(r.id);
    if (!MODES.has(r.mode) && !MODES_RESERVED.has(r.mode)) fail(`${w}: mode が不正 ${r.mode}`);
    for (const k of ['from', 'to']) if (typeof r[k] !== 'string' || !/^[a-z0-9-]+$/.test(r[k])) fail(`${w}: ${k} は内部の拠点 id`);
    if (r.from === r.to) fail(`${w}: 出発と到着が同じ`);
    for (const k of ['fromRef', 'toRef']) if (!r[k] || !(SCHEMES.has(r[k].scheme) || sourcesById.has(r[k].scheme)) || typeof r[k].value !== 'string' || !r[k].value) fail(`${w}: ${k} は { scheme, value }`);
    if (!STATUSES.has(r.status)) fail(`${w}: status が不正 ${r.status}`);
    if (r.src !== data.source) fail(`${w}: src はファイルの出典と同じにする`);
    if (typeof r.retrievedAt !== 'string' || !DAY.test(r.retrievedAt.slice(0, 10))) fail(`${w}: retrievedAt が要る`);
    if (r.bidirectional !== undefined && typeof r.bidirectional !== 'boolean') fail(`${w}: bidirectional は true/false`);
    for (const p of r.periods || []) if (!DAY.test(p.from || '') || (p.to && !DAY.test(p.to))) fail(`${w}: periods の日付は YYYY-MM-DD`);
    if (r.id !== routeId({ src: r.src, mode: r.mode, from: r.from, to: r.to, carrier: r.carriers && r.carriers[0] && r.carriers[0].code })) fail(`${w}: id が出典・種類・端点・運航者から作った値と違う`);
  }
}

function readRouteFiles(dir = DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ name: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

// 今日が運航期間の中か(seasonal 用)
const inPeriod = (r, today) => (r.periods || []).some((p) => p.from <= today && (!p.to || today <= p.to));

// ゲームで使える航路を選び、拠点 id → [{ to, mode, name, lat, lon }] に変える。使わなかった理由の集計も返す
function deriveRoutes(byId, files, sources, today = new Date().toISOString().slice(0, 10)) {
  const out = new Map();
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  const add = (a, b, mode) => {
    if (!out.has(a.id)) out.set(a.id, new Map());
    out.get(a.id).set(`${b.id}|${mode}`, { to: b.id, mode, name: b.name, lat: b.lat, lon: b.lon });
  };
  for (const { name, data } of files) {
    validateRouteFile(name, data, sources.byId);
    const use = sources.usable(data.source, today);
    if (!use.ok) { skip(`出典: ${use.reason}`); continue; }
    for (const r of data.routes) {
      if (!MODES.has(r.mode)) { skip(`予約の種類 ${r.mode}`); continue; }
      if (!(r.status === 'active' || (r.status === 'seasonal' && inPeriod(r, today)))) { skip(`状態 ${r.status}`); continue; }
      const a = byId[r.from], b = byId[r.to];
      if (!a || !b) { skip('端点が拠点に無い'); continue; }
      if (a.hackable === false || b.hackable === false) { skip('端点がハック不可'); continue; }
      if (!a.gateway || !b.gateway) { skip('端点が玄関口(gateway)でない'); continue; }
      add(a, b, r.mode);
      if (r.bidirectional !== false) add(b, a, r.mode); // ゲームの線は往復(片道の扱いは DATA-FORMAT.md 第 9 章で未決)
    }
  }
  const result = new Map();
  for (const [id, m] of out) result.set(id, [...m.values()].sort((x, y) => x.to.localeCompare(y.to) || x.mode.localeCompare(y.mode)));
  return { byNode: result, skipped };
}

module.exports = { routeId, validateRouteFile, readRouteFiles, deriveRoutes, MODES, MODES_RESERVED, DIR };
