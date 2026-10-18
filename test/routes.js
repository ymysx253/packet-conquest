'use strict';
// 航路の記録と出典の台帳(docs/DATA-FORMAT.md 第 2 章・第 5 章)。小さな作り物のデータで規則を確かめる
const assert = require('assert');
const { routeId, validateRouteFile, deriveRoutes, readRouteFiles } = require('../server/map/routes');
const { validateSources, usableIn, loadSources } = require('../server/map/sources');

const TODAY = '2026-10-19';
const src = (id, more = {}) => ({ id, title: id, publisher: 'test', kind: 'government', license: 'CC-BY-4.0', commercialUse: true, shareAlike: false, attribution: false, status: 'active', ...more });
const byIdS = validateSources({ schema: 'pc.sources/1', sources: [
  src('src-ok'),
  src('src-nc', { commercialUse: false }),
  src('src-sa', { shareAlike: true }),
  src('src-old', { status: 'retired' }),
  src('src-partner', { kind: 'partner', contract: { id: 'C-1', validUntil: '2027-03-31' } }),
  src('src-expired', { kind: 'partner', contract: { id: 'C-0', validUntil: '2026-01-31' } }),
] });
const sources = { byId: byIdS, usable: (id, today) => usableIn(byIdS, id, today) };

// 台帳の判定
assert.ok(usableIn(byIdS, 'src-ok', TODAY).ok);
assert.match(usableIn(byIdS, 'src-nc', TODAY).reason, /非商用/);
assert.match(usableIn(byIdS, 'src-sa', TODAY).reason, /継承/);
assert.match(usableIn(byIdS, 'src-old', TODAY).reason, /retired/);
assert.ok(usableIn(byIdS, 'src-partner', TODAY).ok, '契約の期限内は使える');
assert.match(usableIn(byIdS, 'src-expired', TODAY).reason, /期限切れ/, '契約が切れたら使わない');
assert.match(usableIn(byIdS, 'src-nope', TODAY).reason, /台帳に無い/);
assert.throws(() => validateSources({ schema: 'pc.sources/1', sources: [src('src-p', { kind: 'partner' })] }), /contract/, '協力企業は契約の記録が要る');
assert.throws(() => validateSources({ schema: 'pc.sources/1', sources: [src('src-a'), src('src-a')] }), /重複/);
assert.throws(() => validateSources({ schema: 'pc.sources/1', sources: [src('src-b', { attribution: true })] }), /attributionText/);

// 本物の台帳は読める。ゲームで使う出典はすべて使える判定
const S = loadSources();
for (const id of ['src-ksj-n02-2025', 'src-ksj-n03-2026', 'src-wikidata', 'src-internal']) assert.ok(S.usable(id).ok, id);
for (const id of ['src-ksj-c02', 'src-ksj-c09', 'src-ksj-n09', 'src-ksj-s10b']) assert.ok(!S.usable(id).ok, `${id} は非商用なので使わない`);

// 作り物の拠点
const node = (id, more = {}) => ({ id, name: id.toUpperCase(), lat: 35, lon: 139, ...more });
const byId = {
  a: node('a', { gateway: { type: 'airport', scope: 'domestic' } }),
  b: node('b', { gateway: { type: 'airport', scope: 'domestic' } }),
  c: node('c', { gateway: { type: 'port', scope: 'domestic' } }),
  st: node('st'), // 玄関口でない
  ng: node('ng', { hackable: false, gateway: { type: 'port', scope: 'domestic' } }),
};
const ref = (v) => ({ scheme: 'internal', value: v });
const rec = (source, mode, from, to, more = {}) => {
  const r = { mode, from, to, fromRef: ref(from), toRef: ref(to), status: 'active', src: source, retrievedAt: TODAY, ...more };
  r.id = routeId({ src: source, mode, from, to, carrier: r.carriers && r.carriers[0] && r.carriers[0].code });
  return r;
};
const file = (source, routes) => ({ name: `${source}.json`, data: { schema: 'pc.routes/1', source, routes } });

// id は決まった式で作られる(同じ入力なら同じ id)
assert.strictEqual(routeId({ src: 's', mode: 'air', from: 'a', to: 'b' }), routeId({ src: 's', mode: 'air', from: 'a', to: 'b' }));
assert.notStrictEqual(routeId({ src: 's', mode: 'air', from: 'a', to: 'b' }), routeId({ src: 's', mode: 'air', from: 'a', to: 'b', carrier: 'X' }), '運航者が違えば別の記録');
assert.match(routeId({ src: 's', mode: 'air', from: 'a', to: 'b' }), /^rt-[0-9a-f]{12}$/);

const files = [
  file('src-ok', [
    rec('src-ok', 'air', 'a', 'b'),
    rec('src-ok', 'air', 'b', 'a'),                       // 逆向きの重複はまとめる
    rec('src-ok', 'sea', 'a', 'c', { status: 'ended' }),  // 終わった航路は使わない
    rec('src-ok', 'sea', 'b', 'c', { status: 'seasonal', periods: [{ from: '2026-07-01', to: '2026-08-31' }] }), // 季節外
    rec('src-ok', 'sea', 'a', 'st'),                      // 玄関口でない
    rec('src-ok', 'sea', 'a', 'ng'),                      // ハック不可
    rec('src-ok', 'sea', 'a', 'zz'),                      // 拠点に無い
    rec('src-ok', 'rail', 'a', 'b'),                      // 予約の種類
    rec('src-ok', 'sea', 'c', 'b', { bidirectional: false }), // 片道
  ]),
  file('src-nc', [rec('src-nc', 'sea', 'b', 'c')]),
  file('src-expired', [rec('src-expired', 'air', 'a', 'c')]),
  file('src-partner', [rec('src-partner', 'air', 'a', 'c', { carriers: [{ code: 'ZZ', name: 'テスト航空' }] })]),
];
const { byNode, skipped } = deriveRoutes(byId, files, sources, TODAY);
const to = (id) => (byNode.get(id) || []).map((r) => `${r.mode}:${r.to}`);
assert.deepStrictEqual(to('a'), ['air:b', 'air:c'], 'a は b(往復の重複は 1 本)と c(協力企業の期限内)');
assert.deepStrictEqual(to('b'), ['air:a'], '片道 c→b は b からは出ない');
assert.deepStrictEqual(to('c'), ['air:a', 'sea:b']);
assert.deepStrictEqual(to('st'), []);
assert.deepStrictEqual(to('ng'), []);
assert.strictEqual(byNode.get('a')[0].name, 'B', '行き先の名前と座標を添える');
for (const why of ['状態 ended', '状態 seasonal', '端点が玄関口(gateway)でない', '端点がハック不可', '端点が拠点に無い', '予約の種類 rail', '出典: 使用許諾が非商用', '出典: 契約の期限切れ(2026-01-31)']) assert.ok(skipped[why] >= 1, `使わなかった理由: ${why}`);
// 季節の期間中は使う
assert.deepStrictEqual(deriveRoutes(byId, files, sources, '2026-08-01').byNode.get('b').map((r) => `${r.mode}:${r.to}`), ['air:a', 'sea:c']);

// 壊れた記録を拒む
const bad = (mut) => { const f = file('src-ok', [rec('src-ok', 'air', 'a', 'b')]); mut(f.data, f.data.routes[0]); return () => validateRouteFile('t', f.data, byIdS); };
assert.doesNotThrow(bad(() => {}));
assert.throws(bad((d) => { d.schema = 'x'; }), /schema/);
assert.throws(bad((d) => { d.source = 'src-nope'; }), /台帳に無い/);
assert.throws(bad((d, r) => { r.id = 'rt-000000000000'; }), /作った値と違う/);
assert.throws(bad((d, r) => { r.mode = 'bus'; }), /mode/);
assert.throws(bad((d, r) => { r.status = 'open'; }), /status/);
assert.throws(bad((d, r) => { r.src = 'src-nc'; }), /src はファイルの出典/);
assert.throws(bad((d, r) => { delete r.retrievedAt; }), /retrievedAt/);
assert.throws(bad((d, r) => { delete r.toRef; }), /toRef/);
assert.throws(bad((d) => { d.routes.push(d.routes[0]); }), /重複/);

// リポジトリの航路の記録(あれば)はすべて形式どおり
for (const f of readRouteFiles()) validateRouteFile(f.name, f.data, S.byId);

console.log('routes ok');
