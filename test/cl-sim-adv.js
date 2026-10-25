'use strict';
// 構成図・設定・模擬ターミナルの問題(上級。levels-sim-adv.js)の確かめ。test/cl.js が読む。
// ここでは自分のモジュールと rng だけで seed 1〜2000 を作り、verify(模擬で解き直す)と、境界の場合が出ること、答えの形、使ってよいアドレスを確かめる
const assert = require('assert');
const { LEVELS, _test } = require('../server/questions/cl/levels-sim-adv');
const { makeRng } = require('../server/questions/rng');
const { normalize } = require('../server/questions/normalize');
const sim = require('../server/sim');

const N = 2000;
const OK_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['0.0.0.0', 32]];
const v4n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const v4ok = (ip) => OK_V4.some(([n, l]) => Math.floor(v4n(ip) / 2 ** (32 - l)) === Math.floor(v4n(n) / 2 ** (32 - l)));
// 画面に送る分だけを集めて確かめる(sim・solution・accept は送らない)
function sentText(q) {
  const parts = [q.text, q.explanation, ...(q.options || [])];
  for (const t of [q.table, ...(q.tables || [])].filter(Boolean)) parts.push(...t.headers, ...t.rows.flat());
  for (const f of q.fields || []) parts.push(f.label, f.hint || '');
  for (const n of (q.diagram || {}).nodes || []) parts.push(n.name, n.note || '');
  for (const l of (q.diagram || {}).links || []) parts.push(l.label || '');
  for (const lines of Object.values(q.configView || {})) parts.push(...lines);
  for (const r of q.requirementsText || []) parts.push(r.text);
  return parts.join('\n');
}
function checkSafe(q, where) {
  const s = sentText(q);
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) { if (m[1].startsWith('255.')) continue; assert.ok(v4ok(m[1]), `${where}: 使ってよい範囲の外 ${m[1]}`); }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) { const name = m[1]; if (/^\d/.test(name) || /^(802|rfc|ieee)/i.test(name) || /^Gi\d/.test(name) || /\.\d+$/.test(name) && /^Gi/.test(name)) continue; if (/^[a-z]+\.[a-z]/i.test(name) && !/example$/i.test(name)) assert.fail(`${where}: .example 以外の名前 ${name}`); }
  for (const m of s.matchAll(/\b([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})\b/g)) assert.ok(/^2001:db8:/.test(m[1]), `${where}: 2001:db8 以外の IPv6 ${m[1]}`);
}
// 送らない項目が画面の項目に紛れていない(図の id に名前が無い・accept が図に無い)
function checkShape(q, where) {
  assert.ok(q.diagram && q.diagram.nodes.length >= 3, `${where}: 図が無い`);
  for (const n of q.diagram.nodes) { assert.ok(/^n[0-9a-f]{6}$/.test(n.id), `${where}: 図の id ${n.id}`); assert.ok(!/^(R|SW|PC|SRV|L3SW|INET|ISP|DHCP)\d*$/.test(n.id)); }
  assert.ok(!JSON.stringify(q.diagram).includes('"requirements"') && !JSON.stringify(q.diagram).includes('"solution"'), `${where}: 図に答えの情報`);
  assert.ok(!q.hint && !q.firstStep && !q.card, `${where}: 上級はヒント・カードを付けない`);
  if (q.answerKind === 'config') {
    assert.ok(Array.isArray(q.editable) && q.editable.length, `${where}: editable が無い`);
    assert.ok(Array.isArray(q.requirementsText) && q.requirementsText.length === q.sim.requirements.length, `${where}: 要件の文の数`);
    assert.ok(q.configView && typeof q.configView === 'object', `${where}: configView`);
    assert.ok(Array.isArray(q.solution) && q.solution.every((s) => q.editable.includes(s.device)), `${where}: 正解の例が editable の外`);
    for (const s of q.solution) { const lines = s.text.split('\n'); assert.ok(lines.length <= 40 && lines.every((l) => l.length <= 120), `${where}: 正解の例が長さの上限を超える`); }
  } else if (q.answerKind === 'tap') {
    assert.ok(q.tap && ['one', 'many', 'order', 'port', 'link'].includes(q.tap.mode), `${where}: tap.mode`);
    assert.ok(Array.isArray(q.accept.ids) && q.accept.ids.length >= 1, `${where}: accept.ids`);
    const ids = new Set(q.diagram.nodes.flatMap((n) => [n.id, ...n.ports.map((p) => p.id)]));
    for (const id of q.accept.ids) assert.ok(ids.has(id), `${where}: 正解の id ${id} が図に無い`);
  } else if (q.answerKind === 'text') {
    for (const f of q.fields) assert.strictEqual(normalize(f.format, f.accept[0], f), f.accept[0], `${where}: accept が正規形でない ${f.accept[0]}`);
  } else {
    assert.ok(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 && new Set(q.options).size === q.options.length, `${where}: 選択肢`);
    assert.ok(Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < q.options.length, `${where}: answerIndex`);
  }
  if (q.terminal) { assert.ok(Array.isArray(q.terminal.devices) && q.terminal.devices.includes(q.terminal.start), `${where}: terminal`); assert.ok(q.sim && q.sim.spec, `${where}: terminal に spec が無い`); }
}

const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
const levels = Object.keys(LEVELS).map(Number).sort((a, b) => a - b);
const t0 = Date.now();
for (const lv of levels) {
  const ent = LEVELS[lv];
  const seen = new Set();
  for (let s = 1; s <= N; s++) {
    const q = { ...ent.make(makeRng(s)), level: lv };
    const where = `Lv${lv} seed ${s}`;
    assert.ok(/^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: kind ${q.kind}`);
    assert.ok(typeof q.text === 'string' && q.text && typeof q.explanation === 'string' && q.explanation, `${where}: 文か解説が無い`);
    ent.verify(q);
    checkShape(q, where); checkSafe(q, where);
    seen.add(JSON.stringify([q.text, q.options || null, q.table || null, (q.diagram.nodes || []).map((n) => [n.note, ...(n.ports || []).map((p) => p.note)])])); // IF のアドレスはポートの note にある
    const m = q.meta || {};
    switch (lv) {
      case 257: inc(`257-root-${m.rootDefault}`); inc(`257-prio-${m.prio}`); break;
      case 270: inc(`270-k${m.k}`); break;
      case 297: inc(`297-${m.kind}`); inc(`297-${m.culprit}`); inc(`297-n${m.routers}`); break;
      case 298: inc(`298-${m.cause}`); break;
      case 310: inc(`310-sw-${m.switches}`); break;
      case 311: inc(`311-cost-${m.cost}`); break;
      case 312: inc(`312-ad-${m.ad}`); break;
      case 315: inc(`315-ext-${m.ext}`); break;
      case 316: inc(`316-prio-${m.prio}`); break;
      case 317: inc(`317-gid-${m.gid}`); break;
      case 318: inc(`318-${m.variant}`); break;
      case 319: inc(`319-${m.kind}`); break;
      default: break;
    }
  }
  assert.ok(seen.size >= Math.min(1000, N), `Lv${lv}: 違う問題が ${seen.size} 通りしか作れない`);
}
const need = ['257-root-SW2', '257-root-SW3', '257-prio-0', '257-prio-4096', '270-k1', '270-k2', '270-k3', '297-route-missing', '297-route-wrong', '297-acl', '297-R1', '297-R2', '297-R3', '297-n2', '297-n3',
  '298-gw', '298-down', '298-vlan', '310-sw-true', '310-sw-false', '311-cost-10', '311-cost-100', '312-ad-100', '312-ad-250', '315-ext-443', '315-ext-8443', '316-prio-110', '316-prio-200', '317-gid-1', '317-gid-5', '318-router', '318-server', '319-route', '319-mask', '319-vlan', '319-acl'];
for (const k of need) assert.ok(tally[k] > 0, `境界・型の場合が出ていない: ${k}`);

// 道具の手で確かめる例
assert.strictEqual(_test.reqText({ kind: 'reach', from: 'PC1', to: 'PC2' }), 'PC1 から PC2(ping)に往復で届く');
assert.strictEqual(_test.reqText({ kind: 'reach', from: 'PC2', to: 'SRV1', proto: 'tcp', port: 22, expect: false }), 'PC2 から SRV1(TCP 22)に届かない');
// 318 のタップ: 答えでないポートを送ると id が違う(集合の比較は judge の担当。ここでは図に答え以外のポートもあること)
{ const q = LEVELS[318].make(makeRng(7)); const sw = q.diagram.nodes.find((n) => n.name === 'SW1'); assert.ok(sw.ports.length >= 4 && sw.ports.filter((p) => p.id !== q.accept.ids[0]).length >= 3); }
// 286: 誤りの ACL(返りの行なし)は要件 4 で落ちる
{ const q = LEVELS[286].make(makeRng(9)); const r = sim.judgeConfig(q.sim.spec, q.meta.wrongs[0]); assert.ok(!r.ok && r.failed.includes(4), JSON.stringify(r.failed)); }

console.log(`cl-sim-adv ok: ${levels.length} levels (${levels.join(',')}), ${N} seeds each, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
