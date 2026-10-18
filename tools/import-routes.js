'use strict';
// 航路の記録を作る(docs/DATA-FORMAT.md 第 5 章)。出典ごとに server/map/data/routes/<出典 id>.json を丸ごと書き直す。拠点は作らない。
//
// 使い方:
//   node tools/import-routes.js --sea <S10a を展開したフォルダ> --air <航空輸送統計 第 3 表の xlsx を展開したフォルダ> --air-year 2025
//   (片方だけでもよい。先に tools/import-gateways.js で端点の空港・港を拠点にしておく)
//
// 照合(第 4 章の照合の順番): 空路は統計表の空港名 → IATA / ICAO(tools/route-sources.js)→ 拠点の codes。
// 海路は S10a の「都道府県/港湾名」→ 拠点の codes.ext(import-gateways.js が付けたもの)。照合できなかった端点は一覧に出し、航路は作らない。
const fs = require('fs');
const path = require('path');
const { routeId } = require('../server/map/routes');
const { readAir, readSea, AIRPORT_CODES, HELIPORTS, JOINT_USE, SEA_SOURCE, AIR_SOURCE } = require('./route-sources');
const { NODES } = require('../server/map/all');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const seaDir = opt('--sea'), airDir = opt('--air'), airYear = Number(opt('--air-year')) || null;
if (!seaDir && !airDir) { console.error('使い方: node tools/import-routes.js --sea <S10a フォルダ> --air <xlsx フォルダ> --air-year <年>'); process.exit(1); }
if (airDir && !airYear) { console.error('--air-year(統計の暦年)が要る'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'server/map/data/routes');
const REPORT = path.join(ROOT, 'docs/routes/README.md');
const TODAY = new Date().toISOString().slice(0, 10);
const SEA_YEAR = 2016; // S10a 第 1.2 版の海上経路(平成 28 年)
const SERVICE = { フェリー: 'ferry', RORO船: 'ro-ro', 貨物船: 'cargo', 貨客船: 'passenger-cargo' };

const byCode = { iata: new Map(), icao: new Map(), ext: new Map() };
for (const n of NODES) {
  if (!n.gateway || n.hackable === false) continue;
  const c = n.codes || {};
  if (c.iata) byCode.iata.set(c.iata, n);
  if (c.icao) byCode.icao.set(c.icao, n);
  for (const e of c.ext || []) byCode.ext.set(`${e.scheme}|${e.value}`, n);
}
const write = (source, routes) => {
  fs.mkdirSync(OUT, { recursive: true });
  const data = { schema: 'pc.routes/1', source, generatedAt: new Date().toISOString(), routes: routes.sort((a, b) => a.id.localeCompare(b.id)) };
  const body = data.routes.map((r) => '    ' + JSON.stringify(r)).join(',\n');
  fs.writeFileSync(path.join(OUT, `${source}.json`), `{\n  "schema": "${data.schema}",\n  "source": "${source}",\n  "generatedAt": "${data.generatedAt}",\n  "routes": [\n${body}\n  ]\n}\n`);
};
const airLines = [], seaLines = [];

if (airDir) {
  const { segments } = readAir(airDir, airYear);
  const unmatched = new Map();
  const routes = [];
  const nodeOf = (name) => {
    if (HELIPORTS.has(name)) return { why: 'ヘリポート(空港の拠点が無い)' };
    if (JOINT_USE[name]) return { why: `自衛隊・米軍と共用の${JOINT_USE[name]}(拠点にするか判断待ち)` };
    const c = AIRPORT_CODES[name];
    if (!c) return { why: '空港名がコードの表に無い' };
    const n = c.iata ? byCode.iata.get(c.iata) : byCode.icao.get(c.icao);
    if (!n) return { why: '拠点が無い', ref: c };
    return { n, ref: c.iata ? { scheme: 'iata', value: c.iata } : { scheme: 'icao', value: c.icao } };
  };
  for (const s of segments) {
    if (!(s.flights > 0)) continue;
    const a = nodeOf(s.from), b = nodeOf(s.to);
    if (!a.n || !b.n) { for (const [nm, x] of [[s.from, a], [s.to, b]]) if (!x.n) unmatched.set(nm, x.why); continue; }
    if (a.n.id === b.n.id) continue;
    const r = { mode: 'air', from: a.n.id, to: b.n.id, fromRef: a.ref, toRef: b.ref, bidirectional: true, scope: 'domestic', status: 'active',
      metrics: { year: airYear, basis: 'actual', flights: s.flights, passengers: s.passengers, cargoTons: s.cargoTons },
      ...(s.distanceKm ? { distanceKm: s.distanceKm } : {}), src: AIR_SOURCE, sourceRecordId: `T3-${airYear}-${s.from}-${s.to}`, retrievedAt: TODAY };
    r.id = routeId({ src: r.src, mode: r.mode, from: r.from, to: r.to });
    routes.push(r);
  }
  write(AIR_SOURCE, routes);
  const pairs = new Set(routes.map((r) => [r.from, r.to].sort().join('|')));
  console.log(`空路: 区間 ${segments.length}、航路の記録 ${routes.length} 件(空港の組 ${pairs.size})、照合できなかった空港 ${unmatched.size}`);
  airLines.push(`## 空路(${AIR_SOURCE}、${airYear} 年)`, '', `区間 ${segments.length}、航路の記録 ${routes.length} 件(空港の組 ${pairs.size})。`, '',
    '照合できなかった空港(この空港が端の区間は航路にしていない):', '', ...[...unmatched].map(([k, v]) => `- ${k}: ${v}`), '');
}

if (seaDir) {
  const { legs } = readSea(seaDir);
  const unmatched = new Map();
  const merged = new Map(); // 向きつきの組ごとにまとめる(便数は足す)
  for (const l of legs) {
    const a = byCode.ext.get(`${SEA_SOURCE}|${l.from}`), b = byCode.ext.get(`${SEA_SOURCE}|${l.to}`);
    if (!a || !b) { for (const [k, n] of [[l.from, a], [l.to, b]]) if (!n) unmatched.set(k, /韓国|中国|台湾|ロシア/.test(k) ? '海外の港(国内だけ扱う)' : '港の拠点が無い'); continue; }
    if (a.id === b.id) continue;
    const k = `${a.id}|${b.id}`;
    const cur = merged.get(k) || { a, b, fromKey: l.from, toKey: l.to, perWeek: 0, service: new Set(), ids: [] };
    cur.perWeek += l.perWeek; cur.service.add(SERVICE[l.shipType] || 'other'); cur.ids.push(l.sourceRecordId);
    merged.set(k, cur);
  }
  const routes = [...merged.values()].map((m) => {
    const r = { mode: 'sea', from: m.a.id, to: m.b.id, fromRef: { scheme: SEA_SOURCE, value: m.fromKey }, toRef: { scheme: SEA_SOURCE, value: m.toKey }, bidirectional: true, scope: 'domestic',
      serviceTypes: [...m.service].sort(), status: 'active', ...(m.perWeek > 0 ? { metrics: { year: SEA_YEAR, basis: 'schedule', flights: m.perWeek * 52 } } : {}),
      src: SEA_SOURCE, sourceRecordId: m.ids.join(','), retrievedAt: TODAY };
    r.id = routeId({ src: r.src, mode: r.mode, from: r.from, to: r.to });
    return r;
  });
  write(SEA_SOURCE, routes);
  const pairs = new Set(routes.map((r) => [r.from, r.to].sort().join('|')));
  console.log(`海路: 区間 ${legs.length}、航路の記録 ${routes.length} 件(港の組 ${pairs.size})、照合できなかった港 ${unmatched.size}`);
  seaLines.push(`## 海路(${SEA_SOURCE}、${SEA_YEAR} 年の定期便)`, '', `区間 ${legs.length}(寄港地で分けたもの)、航路の記録 ${routes.length} 件(港の組 ${pairs.size})。便数は週あたりの定期便 × 52 の見込み(\`metrics.basis: "schedule"\`)。`, '',
    '照合できなかった港:', '', ...[...unmatched].map(([k, v]) => `- ${k}: ${v}`), '');
}

// 取り込みの記録(人が見てから本番に入れる。DATA-FORMAT.md 第 6.4 節)
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
const prev = fs.existsSync(REPORT) ? fs.readFileSync(REPORT, 'utf8') : '';
// 片方だけ取り込んだときは、もう片方の節は前回の記録を残す
const keep = (title) => { const k = prev.indexOf(`## ${title}`); if (k < 0) return ''; const e = prev.indexOf('\n## ', k + 3); return (e < 0 ? prev.slice(k) : prev.slice(k, e)).trim(); };
const airPart = airDir ? airLines.join('\n') : keep('空路');
const seaPart = seaDir ? seaLines.join('\n') : keep('海路');
fs.writeFileSync(REPORT, ['# 航路の取り込みの記録', '', `更新: ${TODAY}(\`tools/import-routes.js\` が書く)。形式は \`docs/DATA-FORMAT.md\` 第 5 章。`, '', airPart, '', seaPart, ''].join('\n').replace(/\n{3,}/g, '\n\n'));
console.log(`記録: ${path.relative(ROOT, REPORT)}`);
