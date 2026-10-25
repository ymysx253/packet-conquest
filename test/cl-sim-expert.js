'use strict';
// 構成図・設定・模擬ターミナルの問題(専門: 322・324〜326・330・331・344・345・354〜360)の確かめ(2026-10-25。docs/questions/CL.md 第 5 章の「担当のテスト」)。
// test/cl.js が形・verify(生成は 1 万問)・違う問題の数を確かめるので、ここでは専門ならではのこと:
// 境界の場合が出ること(meta の印)、答えの id に機器の名前が入っていないこと、accept が正規形、使ってよいアドレスだけ、ヒントが無いこと、
// 設定の問題は正解の例が通り・空の答えは通らないこと(verify の中)、画面に送らないもの(accept・solution・sim)が問題の中にあること。
// 自分のモジュールを直接読む(ほかの担当のファイルが書きかけでも動くように、server/questions/cl の index は読まない)
const assert = require('assert');
const { makeRng } = require('../server/questions/rng');
const { normalize } = require('../server/questions/normalize');
const { LEVELS } = require('../server/questions/cl/levels-sim-expert');

const N = 2000;
const OK_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['0.0.0.0', 32]];
const v4n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const v4ok = (ip) => OK_V4.some(([n, l]) => Math.floor(v4n(ip) / 2 ** (32 - l)) === Math.floor(v4n(n) / 2 ** (32 - l)));
function allText(q) {
  const parts = [q.text, q.explanation, ...(q.options || [])];
  for (const t of [q.table, ...(q.tables || [])].filter(Boolean)) parts.push(...t.headers, ...t.rows.flat());
  for (const f of q.fields || []) parts.push(f.label, f.hint || '', ...(f.accept || []));
  if (q.diagram) { for (const n of q.diagram.nodes) parts.push(n.name, n.note || ''); for (const l of q.diagram.links) parts.push(l.label || ''); for (const tabs of Object.values(q.diagram.tables || {})) for (const t of tabs) parts.push(t.title || '', ...t.headers, ...t.rows.flat()); }
  for (const r of q.requirementsText || []) parts.push(r.text);
  for (const lines of Object.values(q.configView || {})) parts.push(...lines);
  for (const s of q.solution || []) parts.push(s.text);
  return parts.join('\n');
}
function checkSafe(q, where) {
  const s = allText(q);
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) { const ip = m[1]; if (ip.startsWith('255.')) continue; assert.ok(v4ok(ip), `${where}: 使ってよい範囲の外のアドレス ${ip}`); }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) { const name = m[1]; if (/^\d/.test(name) || /^(802|rfc)/i.test(name)) continue; assert.ok(/\.example$/i.test(name), `${where}: .example 以外のドメインらしい名前 ${name}`); }
}
const nameSet = (q) => new Set(q.diagram.nodes.map((n) => n.name));

const tally = {}; const inc = (k) => { tally[k] = (tally[k] || 0) + 1; };
for (const [lvStr, ent] of Object.entries(LEVELS)) {
  const lv = Number(lvStr);
  const seen = new Set();
  for (let s = 1; s <= N; s++) {
    const q = { ...ent.make(makeRng(s)), level: lv };
    const where = `Lv${lv} seed ${s}`;
    ent.verify(q);
    checkSafe(q, where);
    assert.ok(!q.hint && !q.firstStep && !q.card, `${where}: 専門はヒント・カードを付けない`);
    assert.ok(q.diagram && q.diagram.nodes.length >= 3 && q.diagram.links.length >= 2, `${where}: 図が無い`);
    assert.ok(/^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: kind`);
    for (const n of q.diagram.nodes) assert.ok(/^[0-9a-f]{6}$/.test(n.id) || n.name === '?', `${where}: 機器の id が乱数でない ${n.id}`);
    for (const n of q.diagram.nodes) for (const p of n.ports || []) assert.ok(p.id.startsWith(`${n.id}:`), `${where}: ポートの id`);
    if (q.answerKind === 'tap') {
      assert.ok(['one', 'many', 'order', 'port', 'link'].includes(q.tap.mode), `${where}: tap の形`);
      assert.ok(Array.isArray(q.accept.ids) && q.accept.ids.length >= 1, `${where}: 正解の id`);
      const names = nameSet(q);
      for (const id of q.accept.ids) assert.ok(!names.has(id), `${where}: 正解の id が機器の名前`);
      const known = new Set([...q.diagram.nodes.map((n) => n.id), ...q.diagram.links.map((l) => l.id)]);
      for (const id of q.accept.ids) assert.ok(known.has(id), `${where}: 正解の id が図に無い ${id}`);
      if (q.tap.mode === 'many') assert.deepStrictEqual(q.accept.ids, q.accept.ids.slice().sort(), `${where}: many の正解は並べ替えてある`);
      if (q.tap.mode === 'one' || q.tap.mode === 'link') assert.strictEqual(q.accept.ids.length, 1, `${where}: one/link は 1 つ`);
      assert.ok(!JSON.stringify(q.text).includes(q.accept.ids[0]), `${where}: 問題文に正解の id`);
    } else if (q.answerKind === 'config') {
      assert.ok(Array.isArray(q.editable) && q.editable.length, `${where}: editable`);
      assert.ok(q.sim && q.sim.spec && Array.isArray(q.sim.requirements) && q.sim.requirements.length >= 4, `${where}: sim.spec と要件`);
      assert.deepStrictEqual(q.sim.spec.editable, q.editable, `${where}: spec の editable と合わない`);
      assert.ok(q.requirementsText.length === q.sim.requirements.length && q.requirementsText.every((r) => r.text), `${where}: 要件の文`);
      assert.ok(Array.isArray(q.solution) && q.solution.every((x) => q.editable.includes(x.device) && x.text.split('\n').length <= 40), `${where}: 正解の例`);
      if (lv !== 359) assert.ok(q.sim.requirements.some((r) => r.expect === false), `${where}: 止める要件が無い`);
      for (const d of q.editable) assert.ok(q.configView[d], `${where}: ${d} の configView が無い`);
      assert.ok(/ほかの書き方でも要件を全部満たせば正解/.test(q.explanation), `${where}: 解説に別解の断り`);
    } else {
      assert.strictEqual(q.answerKind, 'text', `${where}: 答え方`);
      for (const f of q.fields) assert.strictEqual(normalize(f.format, f.accept[0], f), f.accept[0], `${where}: accept が正規形でない`);
    }
    if (q.terminal) { assert.ok(q.sim && q.sim.spec, `${where}: ターミナルに spec`); assert.ok(q.terminal.devices.includes(q.terminal.start), `${where}: start`); for (const d of q.terminal.devices) assert.ok(q.sim.spec.devices[d], `${where}: ターミナルの機器 ${d}`); }
    // 境界・型の印
    const m = q.meta || {};
    inc(`${lv}-${m.kind}`);
    if (lv === 325) inc(`325-${m.dir}`);
    if (lv === 326) inc(`326-${m.variant}`);
    if (lv === 330) inc(`330-${m.askSrv ? 'srv' : 'place'}`);
    if (lv === 344) { inc(`344-${m.M === 1500 ? '1500' : 'small'}`); }
    if (lv === 345) { inc(`345-slow${m.slow}`); inc(`345-trap${m.trap ? 'yes' : 'no'}`); if (m.trap && m.trap === m.slow) inc('345-trap-at-slow-hop'); }
    if (lv === 354) inc(`354-${m.broken}`);
    if (lv === 356) { inc(`356-${m.mainVia}`); inc(`356-${m.cutChoice}`); }
    if (lv === 357) inc(`357-r${m.routers}`);
    if (lv === 359) inc(`359-${m.editable}`);
    if (lv === 360) inc(`360-${m.bad}`);
    seen.add(JSON.stringify([q.text, q.table || null, q.diagram.nodes.map((n) => n.note), q.requirementsText || null]));
  }
  const want = ent.kind === '生' ? 1000 : 15;
  assert.ok(seen.size >= Math.min(want, N), `Lv${lv}: 違う問題が ${seen.size} 通りしか作れない`);
}
const need = ['325-AB', '325-BA', '325-A1', '325-B1', '326-pc1side', '326-pc2side', '326-middle', '330-srv', '330-place', '344-1500', '344-small',
  '345-slow0', '345-slow1', '345-slow2', '345-slow3', '345-trapyes', '345-trapno', '345-trap-at-slow-hop', '354-SUB-B', '354-SUB-C',
  '356-R2', '356-R3', '356-near', '356-far', '357-r3', '357-r4', '359-R2', '359-R1+R4', '359-R1+R2+R4', '360-PC1', '360-PC2', '360-PC3', '360-PC4'];
for (const k of need) assert.ok(tally[k] > 0, `境界・型の場合が出ていない: ${k}`);

// 答え方ごとの数(一覧の答え方と合う: tap 7・config 6・入力 1・ターミナル付き 1)
const kinds = {}; for (const [lv, ent] of Object.entries(LEVELS)) { const q = ent.make(makeRng(1)); kinds[q.answerKind] = (kinds[q.answerKind] || 0) + 1; if (q.terminal) kinds.terminal = (kinds.terminal || 0) + 1; void lv; }
assert.deepStrictEqual({ tap: kinds.tap, config: kinds.config, text: kinds.text, terminal: kinds.terminal }, { tap: 8, config: 6, text: 1, terminal: 1 });

console.log(`cl-sim-expert ok: ${Object.keys(LEVELS).length} levels (${Object.keys(LEVELS).join(',')}), tap ${kinds.tap}・config ${kinds.config}・入力 ${kinds.text}`);
