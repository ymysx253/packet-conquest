'use strict';
// 航路の記録(docs/DATA-FORMAT.md 第 5 章)。拠点から独立した記録で、server/map/data/routes/<出典 id>.json に置く。
// 読み込み時に「ゲームで使える航路」だけを選び、拠点ごとの要約(行き先・種類・名前・座標)に変える(第 5.3 節)。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'data', 'routes');
const MODES = new Set(['air', 'sea']);                 // 今ゲームで使う種類
const MODES_RESERVED = new Set(['rail', 'land']); // 予約(形式としては受け付け、ゲームではまだ使わない)。海底ケーブルは航路にしない(2026-10-19 決定)

// ゲームでの航路の扱い(設定)。2026-10-19 決定: 航路は「接続」なので向きを区別しない(directed: false)。
// 記録の bidirectional は出典の事実として残し、directed を true にしたときだけ片道として扱う
const ROUTE_RULES = Object.freeze({ directed: false });
// 規模(DATA-FORMAT.md 第 5.2 節 metrics)。2026-10-19 決定: 航路の価値は規模で変える(式は未決。DESIGN.md 第 6 章)
const METRIC_KEYS = ['passengers', 'flights', 'cargoTons'];
const METRIC_BASES = new Set(['actual', 'schedule']); // 実績(統計)か、時刻表からの見込み(週の便数 × 52 など)
const SERVICE_TYPES = new Set(['passenger', 'ferry', 'passenger-cargo', 'ro-ro', 'cargo', 'other']); // 船・便の種類(旅客、フェリー、貨客、RORO、貨物)
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/; // 使える時間の書き方(UTC)
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
    // 使える時間(2026-10-19 ユーザー決定): 毎日この時間だけ使える。サーバーの時計の UTC で HH:MM。to が from より前なら日をまたぐ
    if (r.hours !== undefined && (!Array.isArray(r.hours) || !validHours(r.hours))) fail(`${w}: hours は [{ from: 'HH:MM', to: 'HH:MM' }](UTC)`);
    if (r.hours !== undefined && r.status !== 'seasonal') fail(`${w}: hours は status が seasonal の航路だけ`);
    if (r.metrics !== undefined) {
      const m = r.metrics;
      if (!m || !Number.isInteger(m.year) || m.year < 1900) fail(`${w}: metrics は { year, passengers?, flights?, cargoTons? }(1 年間の値)`);
      for (const k of Object.keys(m)) if (k !== 'year' && k !== 'basis' && !METRIC_KEYS.includes(k)) fail(`${w}: metrics の ${k} は決まった名前でない(${METRIC_KEYS.join('/')}/basis)`);
      if (m.basis !== undefined && !METRIC_BASES.has(m.basis)) fail(`${w}: metrics.basis は actual(実績)か schedule(時刻表からの見込み)`);
      for (const k of METRIC_KEYS) if (m[k] !== undefined && !(Number.isFinite(m[k]) && m[k] >= 0)) fail(`${w}: metrics.${k} は 0 以上の数`);
    }
    if (r.serviceTypes !== undefined && (!Array.isArray(r.serviceTypes) || r.serviceTypes.some((t) => !SERVICE_TYPES.has(t)))) fail(`${w}: serviceTypes は ${[...SERVICE_TYPES].join('/')} の配列`);
    for (const c of r.carriers || []) if (!c || typeof c.code !== 'string' || !c.code || (c.sponsorId !== undefined && typeof c.sponsorId !== 'string')) fail(`${w}: carriers は [{ scheme, code, name, sponsorId? }]`);
    if (r.id !== routeId({ src: r.src, mode: r.mode, from: r.from, to: r.to, carrier: r.carriers && r.carriers[0] && r.carriers[0].code })) fail(`${w}: id が出典・種類・端点・運航者から作った値と違う`);
  }
}

function readRouteFiles(dir = DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ name: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

// いまが使える時間の中か(hours。サーバーの時計の UTC。無ければいつでも)
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
// 開いている時間(航路と拠点で共通。2026-10-19)。[{ from, to }] をサーバーの時計の UTC で見る。from と to が同じ(00:00-00:00 など)は 1 日中
const ALWAYS_OPEN = Object.freeze([Object.freeze({ from: '00:00', to: '00:00' })]);
function openAt(hours, t = Date.now()) {
  if (!hours || !hours.length) return true;
  const d = new Date(t); const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return hours.some((h) => { const a = minutesOf(h.from), b = minutesOf(h.to); return a === b || (a < b ? m >= a && m < b : m >= a || m < b); });
}
const isAlwaysOpen = (hours) => !hours || !hours.length || hours.some((h) => h.from === h.to);
function routeOpen(r, t = Date.now()) { return !r || openAt(r.hours, t); }
const validHours = (hours) => Array.isArray(hours) && hours.length > 0 && hours.every((h) => h && HHMM.test(h.from || '') && HHMM.test(h.to || ''));

// 今日が運航期間の中か(seasonal 用)
const inPeriod = (r, today) => (r.periods || []).some((p) => p.from <= today && (!p.to || today <= p.to));

// ゲームで使える航路を選び、拠点 id → [{ to, mode, name, lat, lon, metrics? }] に変える。使わなかった理由の集計も返す。
// 運航者の名前は要約に入れない(画面に出さない。運航者がスポンサーになったときに別のしくみで出す。2026-10-19 決定)。
// metrics は同じ 2 拠点・同じ種類の記録のうち、いちばん新しい年の値の合計(複数の運航者・出典の分を足す)
function deriveRoutes(byId, files, sources, today = new Date().toISOString().slice(0, 10), rules = ROUTE_RULES) {
  const out = new Map();
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  const add = (a, b, mode, metrics, key, hours) => {
    if (!out.has(a.id)) out.set(a.id, new Map());
    const m = out.get(a.id);
    const k = `${b.id}|${mode}`;
    if (!m.has(k)) m.set(k, { to: b.id, mode, name: b.name, lat: b.lat, lon: b.lon, recs: new Map(), hours: hours ? [] : null });
    const e = m.get(k);
    if (metrics) e.recs.set(key, metrics); // 同じ記録を往復で 2 回数えない
    // 使える時間: 時間の決まりの無い記録が 1 つでもあればいつでも使える。全部に決まりがあれば、その時間を合わせたもの
    if (!hours) e.hours = null; else if (e.hours) for (const h of hours) if (!e.hours.some((x) => x.from === h.from && x.to === h.to)) e.hours.push(h);
  };
  const sumLatest = (recs) => {
    const list = [...recs.values()];
    if (!list.length) return null;
    const year = Math.max(...list.map((x) => x.year));
    const sum = { year };
    const latest = list.filter((y) => y.year === year);
    for (const x of latest) for (const k of METRIC_KEYS) if (x[k] !== undefined) sum[k] = (sum[k] || 0) + x[k];
    const bases = new Set(latest.map((x) => x.basis || 'actual'));
    sum.basis = bases.size === 1 ? [...bases][0] : 'mixed'; // 実績と見込みが混ざったら mixed(価値の式で扱いを決める)
    return sum;
  };
  for (const { name, data } of files) {
    validateRouteFile(name, data, sources.byId);
    const use = sources.usable(data.source, today);
    if (!use.ok) { skip(`出典: ${use.reason}`); continue; }
    for (const r of data.routes) {
      if (!MODES.has(r.mode)) { skip(`予約の種類 ${r.mode}`); continue; }
      // 季節航路: 期間(periods)があればその中だけ。使える時間(hours)だけのものは毎日その時間に使う(判定は使うときにサーバーの時計で)
      const seasonalOk = r.status === 'seasonal' && (r.periods && r.periods.length ? inPeriod(r, today) : !!(r.hours && r.hours.length));
      if (!(r.status === 'active' || seasonalOk)) { skip(`状態 ${r.status}`); continue; }
      const a = byId[r.from], b = byId[r.to];
      if (!a || !b) { skip('端点が拠点に無い'); continue; }
      if ((a.status && a.status !== 'public') || (b.status && b.status !== 'public')) { skip('端点が非公開'); continue; } // 自衛隊・米軍の飛行場など。記録は残す
      if (a.hackable === false || b.hackable === false) { skip('端点がハック不可'); continue; }
      if (!a.gateway || !b.gateway) { skip('端点が玄関口(gateway)でない'); continue; }
      const key = `${data.source}|${r.id}`;
      add(a, b, r.mode, r.metrics, key, r.hours);
      if (!rules.directed || r.bidirectional !== false) add(b, a, r.mode, r.metrics, key, r.hours); // 航路は接続: 向きを区別しない(設定 directed)
    }
  }
  const result = new Map();
  for (const [id, m] of out) {
    result.set(id, [...m.values()].map(({ recs, hours, ...x }) => { const metrics = sumLatest(recs); return { ...x, ...(metrics ? { metrics } : {}), ...(hours && hours.length ? { hours } : {}) }; })
      .sort((x, y) => x.to.localeCompare(y.to) || x.mode.localeCompare(y.mode)));
  }
  return { byNode: result, skipped };
}

module.exports = { routeId, validateRouteFile, readRouteFiles, deriveRoutes, routeOpen, openAt, isAlwaysOpen, validHours, ALWAYS_OPEN, MODES, MODES_RESERVED, ROUTE_RULES, METRIC_KEYS, METRIC_BASES, SERVICE_TYPES, DIR };
