'use strict';
// 構成図・設定・模擬ターミナルの問題(中級。levels-sim-mid.js)の確かめ(docs/questions/CL.md 第 5 章の「担当のテスト」)。test/cl.js が読む。
// 自分のモジュールを直接読み、seed 1〜2000 で作って verify を通し、境界の場合が出ること・使ってよいアドレス・答えの形・firstStep を確かめる
// (index は読まない: ほかの担当のファイルが書きかけでも動くように)
const assert = require('assert');
const { LEVELS, _test: T } = require('../server/questions/cl/levels-sim-mid');
const { makeRng } = require('../server/questions/rng');
const { normalize } = require('../server/questions/normalize');
const sim = require('../server/sim');

const N = 2000;
const LV = Object.keys(LEVELS).map(Number).sort((a, b) => a - b);
assert.deepStrictEqual(LV, [192, 193, 200, 201, 215, 228, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252]);

// ---------- 使ってよいアドレス・ドメイン(COMMON.md 第 7 章) ----------
const OK_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['0.0.0.0', 32]];
const v4n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const v4ok = (ip) => OK_V4.some(([n, l]) => Math.floor(v4n(ip) / 2 ** (32 - l)) === Math.floor(v4n(n) / 2 ** (32 - l)));
function allText(q) {
  const parts = [q.text, q.explanation, q.firstStep || '', ...(q.options || [])];
  for (const t of [q.table, ...(q.tables || [])].filter(Boolean)) parts.push(...t.headers, ...t.rows.flat());
  for (const f of q.fields || []) parts.push(f.label, f.hint || '', ...(f.accept || []));
  if (q.diagram) { for (const n of q.diagram.nodes) { parts.push(n.name, n.note || ''); for (const p of n.ports || []) parts.push(p.name, p.note || ''); } for (const l of q.diagram.links) parts.push(l.label || ''); for (const list of Object.values(q.diagram.tables || {})) for (const t of list) parts.push(...t.headers, ...t.rows.flat()); }
  for (const lines of Object.values(q.configView || {})) parts.push(...lines);
  for (const r of q.requirementsText || []) parts.push(r.text);
  for (const c of q.solution || []) parts.push(c.text);
  return parts.join('\n');
}
function checkSafe(q, where) {
  const s = allText(q);
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) { const ip = m[1]; if (ip.startsWith('255.')) continue; assert.ok(v4ok(ip), `${where}: 使ってよい範囲の外のアドレス ${ip}`); }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) { const name = m[1]; if (/^\d/.test(name) || /^(802|rfc|ieee)/i.test(name)) continue; assert.ok(/\.example$/i.test(name), `${where}: .example 以外のドメインらしい名前 ${name}`); }
}

// ---------- 答えの形(SIM-API.md 第 5 章) ----------
function checkShape(q, where) {
  assert.ok(q.diagram && Array.isArray(q.diagram.nodes) && q.diagram.nodes.length >= 3 && Array.isArray(q.diagram.links), `${where}: 図が無い`);
  assert.ok(q.firstStep && q.explanation, `${where}: firstStep か解説が無い`);
  assert.ok(!q.hint && !q.card, `${where}: 中級は hint・card を付けない`);
  const json = JSON.stringify(q.diagram);
  assert.ok(!/accept|solution|requirements|editable/.test(json), `${where}: 図に正解の情報`);
  const ids = new Set(q.diagram.nodes.map((n) => n.id));
  for (const n of q.diagram.nodes) assert.ok(/^n[0-9a-f]{6}$/.test(n.id) && !n.id.includes(n.name), `${where}: 図の id に名前`);
  if (q.answerKind === 'tap') {
    assert.ok(['one', 'many', 'order', 'port', 'link'].includes(q.tap.mode), `${where}: tap.mode`);
    assert.ok(Array.isArray(q.accept.ids) && q.accept.ids.length >= 1, `${where}: accept.ids`);
    for (const id of q.accept.ids) {
      if (q.tap.mode === 'port') { const [nid, port] = id.split(':'); const node = q.diagram.nodes.find((n) => n.id === nid); assert.ok(node && node.ports.some((p) => p.id === id && p.name === port), `${where}: 正解のポート ${id} が図に無い`); }
      else assert.ok(ids.has(id), `${where}: 正解の id ${id} が図に無い`);
    }
    if (q.tap.mode === 'one' || q.tap.mode === 'port') assert.strictEqual(q.accept.ids.length, 1, `${where}: one/port は 1 つ`);
    if (q.tap.mode === 'order') assert.ok(q.accept.ids.length >= 2, `${where}: order は 2 つ以上`);
  } else if (q.answerKind === 'config') {
    assert.ok(Array.isArray(q.editable) && q.editable.length && q.configView && q.requirementsText.length && q.sim && q.sim.spec && q.sim.requirements.length, `${where}: config の形`);
    assert.ok(q.sim.requirements.some((r) => (r.kind === 'reach' && r.expect === false) || r.kind === 'lease' || r.kind === 'route'), `${where}: 「止める」の要件(か配る数・経路の行)が無い`);
    for (const c of q.solution) { assert.ok(q.editable.includes(c.device), `${where}: 正解の例が editable でない機器`); assert.ok(c.text.split('\n').length <= 40 && c.text.split('\n').every((l) => l.length <= 120), `${where}: 正解の例が長さの上限を超える`); }
    for (const [dev, lines] of Object.entries(q.configView)) { assert.ok(q.editable.includes(dev) && Array.isArray(lines), `${where}: configView`); }
  } else if (q.answerKind === 'text') {
    for (const f of q.fields) assert.strictEqual(normalize(f.format, f.accept[0], f), f.accept[0], `${where}: accept が正規形でない ${f.format} ${f.accept[0]}`);
  } else {
    assert.ok(Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < q.options.length, `${where}: 選択肢`);
  }
  if (q.terminal) { assert.ok(Array.isArray(q.terminal.devices) && q.terminal.devices.includes(q.terminal.start) && q.sim && q.sim.spec, `${where}: terminal の形`); }
  if (q.sim) assert.strictEqual(JSON.stringify(q.sim.spec), JSON.stringify(JSON.parse(JSON.stringify(q.sim.spec))), `${where}: spec が JSON にできない`);
}

// ---------- レベルごとに作って数える ----------
const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
const seen = {};
for (const lv of LV) {
  const ent = LEVELS[lv];
  seen[lv] = new Set();
  for (let s = 1; s <= N; s++) {
    const q = { ...ent.make(makeRng(s)), level: lv };
    const where = `Lv${lv} seed ${s}`;
    assert.ok(/^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: kind`);
    checkShape(q, where); checkSafe(q, where);
    ent.verify(q);
    seen[lv].add(JSON.stringify([q.text, q.options || null, q.accept || null, q.fields ? q.fields.map((f) => f.accept) : null, q.solution || null, q.diagram.nodes.map((n) => [n.name, n.note, (n.ports || []).map((p) => p.note)])])); // 図のアドレスが違えば別の問題
    const m = q.meta || {};
    switch (lv) {
      case 192: inc(`192-${m.variant}`); inc(`192-root-${m.root}`); break;
      case 193: inc(`193-${m.seg}`); inc(`193-${m.fwd ? 'fwd' : 'rev'}`); inc(`193-r${m.routers}`); break;
      case 215: inc(`215-${m.variant}`); if (m.cname) inc('215-cname'); break;
      case 228: inc(`228-${m.variant}`); break;
      case 241: inc(`241-${m.shape}`); if (m.direct) inc('241-direct'); if (m.shape === 'tri' && !m.direct) inc('241-around'); if (!m.fwd) inc('241-rev'); break;
      case 242: inc(`242-${m.cause}`); inc(`242-r${m.routers}`); break;
      case 245: inc(`245-${m.cause}`); if (m.n >= 2) inc('245-many'); break;
      case 248: inc(`248-E${m.E}`); break;
      case 250: inc(`250-${m.kind}`); inc(`250-${m.kind}-${m.srvOn}`); break;
      case 251: inc(`251-${m.srvOn}`); break;
      case 252: inc(`252-${m.cause}`); break;
      default: break;
    }
  }
  assert.ok(seen[lv].size >= 1000, `Lv${lv}: 違う問題が ${seen[lv].size} 通りしか作れない`);
}
const need = ['192-prio', '192-two', '192-mac', '192-root-SW1', '192-root-SW2', '192-root-SW3', '193-first', '193-mid', '193-last', '193-fwd', '193-rev', '193-r2', '193-r3',
  '215-lookup', '215-tool', '215-cname', '228-third', '228-count', '228-second', '241-tri', '241-serial', '241-direct', '241-around', '241-rev',
  '242-no-route', '242-wrong-gw', '242-bad-nexthop', '242-r2', '242-r3', '245-ok', '245-trunk-drop', '245-port-wrong', '245-many',
  '248-E9', '248-E99', '250-standard', '250-extended', '250-standard-R1', '250-standard-R2', '251-R1', '251-R2', '252-no-route-r2', '252-no-return-r2', '252-no-arp-pc2'];
for (const k of need) assert.ok(tally[k] > 0, `境界・型の場合が出ていない: ${k}`);

// ---------- 判定に通す: 画面が送る形の答えで正解・不正解になる ----------
{
  // tap: 正解の id と、違う id
  const q = { ...LEVELS[242].make(makeRng(3)) };
  assert.deepStrictEqual(q.accept.ids.length, 1);
  const other = q.diagram.nodes.find((n) => n.id !== q.accept.ids[0]).id; assert.notStrictEqual(other, q.accept.ids[0]);
  // config: 正解の例が通り、空は通らない(verifyConfig と同じことを sim で)
  const c = { ...LEVELS[243].make(makeRng(3)) };
  assert.ok(sim.judgeConfig(c.sim.spec, c.solution).ok); assert.ok(!sim.judgeConfig(c.sim.spec, []).ok);
  // 文法の誤りは errors に行番号つき
  const bad = sim.judgeConfig(c.sim.spec, [{ device: 'R1', text: 'ip rout 10.0.0.0/8 10.0.0.1' }]); assert.ok(!bad.ok && bad.errors[0].line === 1);
  // ターミナル: 60 回・設定できない機器
  const t = LEVELS[228].make(makeRng(3)); const s = sim.session(t.sim.spec, 'PC1');
  assert.ok(/traceroute/.test(sim.exec(s, `traceroute ${t.sim.spec.devices.PC2.ip.split('/')[0]}`)));
  sim.exec(s, 'connect R1'); assert.ok(/設定できません/.test(sim.exec(s, 'configure')), 'ターミナルの問題では設定できない');
  // 道具の手で確かめる例
  const spec = T.aclTopo(makeRng(1)); assert.ok(spec.devices.SRV1 && spec.links.some((l) => l.includes('SRV1')));
  assert.deepStrictEqual(T.parseTrace(' 1  10.0.0.1  1 ms\n 2  *  *  *').map((h) => h.ip), ['10.0.0.1']);
}

console.log(`cl-sim-mid ok: ${LV.length} levels (${LV.join(',')})`);
