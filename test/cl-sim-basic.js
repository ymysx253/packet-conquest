'use strict';
// 構成図・設定・模擬ターミナルの問題(入門・初級: 67・149〜158)の確かめ(2026-10-25。docs/questions/CL.md 第 5 章の「担当のテスト」)。test/cl.js が読む。
// 自分のモジュールと rng・normalize だけで動く(index は読まない)。seed 1〜2000 で verify を通し、境界の場合が出ること、
// accept の正規形、使ってよいアドレス(図の note・configView・要件の文も含めて)、入門の card・初級の hint、図の id に名前が入らないことを確かめる
const assert = require('assert');
const { LEVELS, _test: T } = require('../server/questions/cl/levels-sim-basic');
const { makeRng } = require('../server/questions/rng');
const { normalize, judge } = require('../server/questions/normalize');
const sim = require('../server/sim');

const N = 2000;
const LV = Object.keys(LEVELS).map(Number).sort((a, b) => a - b);
assert.deepStrictEqual(LV, [67, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158]);

// ---------- 使ってよいアドレス(COMMON.md 第 7 章) ----------
const OK_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['0.0.0.0', 32]];
const v4n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const v4ok = (ip) => OK_V4.some(([n, l]) => Math.floor(v4n(ip) / 2 ** (32 - l)) === Math.floor(v4n(n) / 2 ** (32 - l)));
function allText(q) {
  const parts = [q.text, q.explanation, q.hint || '', q.card || '', ...(q.options || [])];
  for (const t of [q.table, ...(q.tables || [])].filter(Boolean)) parts.push(...t.headers, ...t.rows.flat());
  for (const f of q.fields || []) parts.push(f.label, f.hint || '', ...(f.accept || []));
  for (const n of (q.diagram || {}).nodes || []) parts.push(n.name, n.note || '', ...(n.ports || []).map((p) => `${p.name} ${p.note || ''}`));
  for (const l of (q.diagram || {}).links || []) parts.push(l.label || '');
  for (const lines of Object.values(q.configView || {})) parts.push(...lines);
  for (const r of q.requirementsText || []) parts.push(r.text);
  for (const s of q.solution || []) parts.push(s.text);
  return parts.join('\n');
}
function checkSafe(q, where) {
  const s = allText(q);
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) { if (m[1].startsWith('255.')) continue; assert.ok(v4ok(m[1]), `${where}: 使ってよい範囲の外 ${m[1]}`); }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) { const name = m[1]; if (/^\d/.test(name) || /^(802|rfc|ieee)/i.test(name)) continue; assert.ok(/\.example$/i.test(name), `${where}: .example 以外の名前 ${name}`); }
  assert.ok(!/Math\.random/.test(s), `${where}: Math.random`);
}

// ---------- 道具の手で確かめる例 ----------
assert.strictEqual(T.netOfCidr('10.1.2.77/24'), '10.1.2.0/24');
assert.strictEqual(T.netOfCidr('192.168.10.130/25'), '192.168.10.128/25');
assert.ok(T.sameNet('10.1.1.5/24', '10.1.1.250/24')); assert.ok(!T.sameNet('10.1.1.5/24', '10.1.2.5/24')); assert.ok(!T.sameNet('10.1.1.5/24', '10.1.1.5/25'));
{
  const spec = sim.gen.serial(makeRng(3), { routers: 2, hostsOnLan1: 2, switches: true });
  assert.strictEqual(T.countDomains(spec), 3, 'ルーター 2 台なら LAN 2 + 間の線 1');
  const d = T.bfsDomain(spec, 'PC1'); assert.ok(d.has('SW1') && d.has('R1') && d.has('PC3') && !d.has('R2') && !d.has('PC2'));
}

// ---------- レベルごとに作って数える ----------
const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
for (const lv of LV) {
  const ent = LEVELS[lv];
  for (let s = 1; s <= N; s++) {
    const q = ent.make(makeRng(s));
    const where = `Lv${lv} seed ${s}`;
    ent.verify(q);
    checkSafe(q, where);
    assert.ok(q.diagram && q.diagram.nodes.length >= 3 && q.diagram.links.length >= 2, `${where}: 図が無い`);
    assert.ok(typeof q.explanation === 'string' && q.explanation.length > 10, `${where}: 解説が無い`);
    assert.ok(/^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: kind`);
    // 図の id は乱数で、名前(R1・SW1・PC1)を含まない。ポートの id は <node id>:<ポート名>
    for (const n of q.diagram.nodes) { assert.ok(/^[0-9a-f]{6}$/.test(n.id), `${where}: id が乱数でない ${n.id}`); for (const p of n.ports || []) assert.ok(p.id.startsWith(`${n.id}:`), `${where}: ポートの id`); }
    if (lv === 67) { assert.ok(q.card, `${where}: 入門は card`); assert.ok(!q.hint, `${where}: 入門に hint は要らない`); }
    else assert.ok(q.hint && !q.card, `${where}: 初級は hint`);
    const m = q.meta || {};
    if (q.answerKind === 'tap') {
      assert.ok(['one', 'many'].includes(q.tap.mode), `${where}: tap の形`);
      assert.ok(Array.isArray(q.accept.ids) && q.accept.ids.length >= 1, `${where}: 正解の id が無い`);
      if (q.tap.mode === 'one') assert.strictEqual(q.accept.ids.length, 1, `${where}: one なのに複数`);
      const ids = new Set(q.diagram.nodes.map((n) => n.id));
      for (const id of q.accept.ids) assert.ok(ids.has(id), `${where}: 正解の id が図に無い`);
      assert.ok(!JSON.stringify(q.diagram).includes('accept'), `${where}: 図に正解が混ざっている`);
      assert.ok(!q.options && !q.fields, `${where}: tap に選択肢や欄がある`);
    } else if (q.answerKind === 'config') {
      assert.ok(Array.isArray(q.editable) && q.editable.length === 1, `${where}: editable`);
      assert.ok(q.configView && q.configView[q.editable[0]], `${where}: configView`);
      assert.ok(Array.isArray(q.requirementsText) && q.requirementsText.every((r) => Number.isInteger(r.id) && r.text), `${where}: requirementsText`);
      assert.deepStrictEqual(q.sim.spec.editable, q.editable, `${where}: spec の editable`);
      assert.ok(q.sim.requirements.length >= 1 && q.sim.requirements === q.sim.spec.requirements, `${where}: 要件`);
      const lines = q.solution[0].text.split('\n'); assert.ok(lines.length <= 40 && lines.every((l) => l.length <= 120), `${where}: 正解の例が長すぎる`);
      assert.ok(q.explanation.includes(lines[0]), `${where}: 解説に正解の例が無い`);
    } else if (q.answerKind === 'text') {
      for (const f of q.fields) assert.strictEqual(normalize(f.format, f.accept[0], f), f.accept[0], `${where}: accept が正規形でない ${f.accept[0]}`);
      assert.ok(judge(q, q.fields.map((f) => f.accept[0])), `${where}: accept が正解にならない`);
    } else {
      assert.ok(Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answerIndex), `${where}: 選択肢`);
    }
    if (q.terminal) { assert.ok(q.sim && q.sim.spec && q.terminal.devices.includes(q.terminal.start), `${where}: terminal の形`); assert.ok(sim.build(q.sim.spec).devices[q.terminal.start], `${where}: start の機器が無い`); }
    switch (lv) {
      case 67: inc(`67-${m.ask}`); break;
      case 149: inc(`149-${m.t}`); break;
      case 150: inc(`150-${m.side}`); inc(`150-n${Math.min(m.n, 3)}`); if (m.routers === 2) inc('150-r2'); break;
      case 151: inc(`151-${m.side}`); if (m.routers === 2) inc('151-r2'); if (q.accept.ids.length >= 4) inc('151-big'); break;
      case 152: inc(`152-n${m.n}`); if (!m.switches) inc('152-nosw'); break;
      case 153: inc(`153-${m.pc}`); break;
      case 154: inc(`154-${m.pc}`); if (m.routers === 2) inc('154-r2'); break;
      case 155: inc(`155-${m.cause}`); if (m.bad === 'PC1') inc('155-pc1'); break;
      case 156: inc(`156-r${m.routers}`); inc(`156-h${m.hosts}`); break;
      case 157: inc(`157-side${m.side}-r${m.routers}`); break;
      case 158: inc(`158-${m.brk}`); inc(`158-${m.t}`); inc(`158-${m.ok ? 'ok' : 'ng'}`); if (m.brk === 'pc1-gw' && m.t === 'r1') inc('158-pc1gw-r1'); break;
      default: break;
    }
  }
}
const need = [
  '67-ip', '67-gw', '67-len',
  '149-router', '149-switch-of-pc1', '149-host-of-ip',
  '150-PC1', '150-PC2', '150-n1', '150-n2', '150-n3', '150-r2',
  '151-PC1', '151-PC2', '151-r2', '151-big',
  '152-n2', '152-n3', '152-n4', '152-nosw',
  '153-PC1', '153-PC2', '153-PC3', '154-PC1', '154-PC2', '154-r2',
  '155-mask', '155-gw', '155-net', '155-pc1',
  '156-r1', '156-r2', '156-h1', '156-h3', '157-side0-r1', '157-side1-r1', '157-side0-r2', '157-side1-r2',
  '158-none', '158-pc2-gw', '158-r-route-back', '158-pc1-gw', '158-r1-route', '158-pc2', '158-r1', '158-ttl', '158-ok', '158-ng', '158-pc1gw-r1',
];
for (const k of need) assert.ok(tally[k] > 0, `境界・型の場合が出ていない: ${k}`);

// ---------- 同じ seed で同じ問題(固定問題の保存の前提) ----------
for (const lv of LV) { const a = LEVELS[lv].make(makeRng(42)), b = LEVELS[lv].make(makeRng(42)); assert.strictEqual(JSON.stringify([a.text, a.accept, a.fields, a.diagram]), JSON.stringify([b.text, b.accept, b.fields, b.diagram]), `Lv${lv}: 同じ seed で違う問題`); }

// ---------- 設定の問題: 画面から来る形(configs)で judgeConfig が通ること(別の機器名・空の text は不正解) ----------
{
  const q = LEVELS[156].make(makeRng(5));
  assert.ok(sim.judgeConfig(q.sim.spec, q.solution).ok);
  assert.ok(!sim.judgeConfig(q.sim.spec, [{ device: 'PC1', text: '' }]).ok);
  assert.ok(!sim.judgeConfig(q.sim.spec, [{ device: 'PC2', text: q.solution[0].text }]).ok, '設定できない機器は不正解');
  const q2 = LEVELS[157].make(makeRng(5));
  assert.ok(sim.judgeConfig(q2.sim.spec, [{ device: 'R1', text: q2.solution[0].text.replace(/ ip address/, 'ip address') }]).ok, '字下げ無しでも通る');
  assert.ok(!sim.judgeConfig(q2.sim.spec, [{ device: 'R1', text: q2.solution[0].text.replace('interface', 'int') }]).ok, '省略形は通らない');
}

console.log(`cl-sim-basic ok: ${LV.length} levels (${LV.join(',')})`);
