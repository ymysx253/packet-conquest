'use strict';
// 設計の固定問題(新しい番号 328・329・351・352・353・361。levels-fable-design.js)の確かめ(2026-10-25。docs/questions/CL.md 第 5 章の「担当のテスト」)。test/cl.js が読む。
// ほかの Fable のファイルが書きかけでも動くよう、自分のモジュールと rng だけを読む(server/questions/cl の index は読まない)。
// 確かめること: 表(1 行 = 1 問)の形(15 問以上・id 重複なし・4 択重複なし・answerIndex・解説・理由・根拠・checkedBy)、
// seed 1〜1200 で 15 問が全部出て、選択肢を混ぜても正解の位置が合うこと、使ってよいアドレスと .example、ヒントが無いこと。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeRng } = require('../server/questions/rng');
const D = require('../server/questions/cl/levels-fable-design');

const DATA = path.join(__dirname, '..', 'server', 'questions', 'data', 'cl', 'fable-design');
const N = 1200;

// ---------- 1. 表の行 ----------
let rowCount = 0;
const files = fs.readdirSync(DATA).filter((x) => x.endsWith('.json')).sort();
assert.strictEqual(files.length, Object.keys(D.LEVELS).length, '表のファイルの数とレベルの数が合わない');
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  assert.ok(typeof d.note === 'string' && d.note, `${f}: note がない`);
  assert.ok(d.rows.length >= 15, `${f}: 15 問以上(${d.rows.length})`);
  const ids = new Set(), texts = new Set();
  for (const r of d.rows) {
    rowCount++;
    assert.ok(r.id && !ids.has(r.id), `${f}: id が無いか重複 ${r.id}`); ids.add(r.id);
    assert.ok(!texts.has(r.text), `${f} ${r.id}: 本文がほかの問題と同じ`); texts.add(r.text);
    assert.strictEqual(r.checkedBy, D._test.CHECKED, `${f} ${r.id}: checkedBy`);
    assert.ok(typeof r.source === 'string' && r.source.trim(), `${f} ${r.id}: source(根拠)が無い`);
    assert.ok(Array.isArray(r.options) && r.options.length === 4 && new Set(r.options).size === 4, `${f} ${r.id}: 選択肢は重複なしの 4 個`);
    assert.ok(Number.isInteger(r.answerIndex) && r.answerIndex >= 0 && r.answerIndex < 4, `${f} ${r.id}: answerIndex`);
    assert.ok(r.explanation && /正解は/.test(r.explanation), `${f} ${r.id}: 解説に「正解は」が無い`);
    assert.ok(r.reason && r.reason.unique && r.reason.wrongs, `${f} ${r.id}: 理由(unique・wrongs)が無い`);
    for (const t of [r.table, ...(r.tables || [])].filter(Boolean)) {
      assert.ok(Array.isArray(t.headers) && t.headers.length, `${f} ${r.id}: 表の見出しが無い`);
      for (const row of t.rows) assert.strictEqual(row.length, t.headers.length, `${f} ${r.id}: 表の列数が合わない`);
    }
    assert.ok(!r.hint && !r.firstStep && !r.card, `${f} ${r.id}: 専門はヒント・カードを付けない`);
  }
  // 表を読む問題(328・329・361)は表が付いていること
  if (/^(328|329|361)-/.test(f)) {
    const withTable = d.rows.filter((r) => r.table || r.tables).length;
    assert.ok(withTable >= 10, `${f}: 表を読む問題なのに表が付いた問題が少ない(${withTable})`);
  }
}

// ---------- 2. 使ってよいアドレス・ドメイン(COMMON.md 第 7 章) ----------
const OK_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['169.254.0.0', 16], ['0.0.0.0', 32]];
const v4n = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const v4ok = (ip) => OK_V4.some(([n, l]) => Math.floor(v4n(ip) / 2 ** (32 - l)) === Math.floor(v4n(n) / 2 ** (32 - l)));
function allText(q) {
  const parts = [q.text, q.explanation, ...(q.options || [])];
  for (const t of [q.table, ...(q.tables || [])].filter(Boolean)) parts.push(t.title || '', ...t.headers, ...t.rows.flat());
  return parts.join('\n');
}
function checkSafe(q, where) {
  const s = allText(q);
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) {
    const ip = m[1];
    if (ip.startsWith('255.')) continue;
    assert.ok(v4ok(ip), `${where}: 使ってよい範囲の外のアドレス ${ip}`);
  }
  for (const m of s.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    const name = m[1];
    if (/^\d+(\.\d+)*$/.test(name) || /^\d/.test(name)) continue;
    if (/^(802|rfc|ieee|sp)/i.test(name)) continue; // 規格の番号(802.1Q・SP 800-207)
    if (/^NET::ERR/i.test(name)) continue;
    assert.ok(/\.example$/i.test(name), `${where}: .example 以外のドメインらしい名前 ${name}`);
  }
  for (const m of s.matchAll(/AS (\d{4,6})\b/g)) assert.ok(Number(m[1]) >= 64512 && Number(m[1]) <= 65534, `${where}: プライベートでない AS 番号 ${m[1]}`);
  assert.ok(!/Math\.random/.test(s), `${where}: 文に Math.random`);
}

// ---------- 3. レベルごとに作って数える ----------
const LV = Object.keys(D.LEVELS).map(Number).sort((a, b) => a - b);
assert.deepStrictEqual(LV, [328, 329, 351, 352, 353, 361]);
for (const lv of LV) {
  const ent = D.LEVELS[lv];
  assert.strictEqual(ent.kind, '固'); assert.strictEqual(ent.minDistinct, 15);
  const file = D._test.FILES[lv][1];
  const rows = JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')).rows;
  const seen = new Map(); // id → 正解の位置の集合(混ぜられていること)
  for (let s = 1; s <= N; s++) {
    const q = ent.make(makeRng(s));
    const where = `Lv${lv} seed ${s}`;
    assert.ok(/^cl\d+-[a-z0-9-]+-v\d+$/.test(q.kind), `${where}: kind ${q.kind}`);
    assert.ok(!q.hint && !q.firstStep && !q.card, `${where}: 専門はヒント・カードを付けない`);
    assert.strictEqual(q.options.length, 4, `${where}: 4 択`);
    assert.strictEqual(new Set(q.options).size, 4, `${where}: 選択肢が重複`);
    ent.verify(q);
    // 表の行から引き直して、正解の文字と位置を別に確かめる
    const r = rows.find((x) => x.id === q.meta.id);
    assert.ok(r, `${where}: 表に無い id`);
    assert.strictEqual(q.options[q.answerIndex], r.options[r.answerIndex], `${where}: 正解の文字が表と違う`);
    assert.strictEqual(q.options.filter((o) => o === r.options[r.answerIndex]).length, 1, `${where}: 正解が 2 つ以上`);
    checkSafe(q, where);
    if (!seen.has(q.meta.id)) seen.set(q.meta.id, new Set());
    seen.get(q.meta.id).add(q.answerIndex);
    // 同じ seed で同じ問題(再現できる)
    const q2 = ent.make(makeRng(s));
    assert.deepStrictEqual([q2.meta.id, q2.options], [q.meta.id, q.options], `${where}: 同じ seed で違う問題`);
  }
  for (const r of rows) {
    assert.ok(seen.has(r.id), `Lv${lv}: 問題 ${r.id} が seed 1〜${N} で出ない`);
    assert.ok(seen.get(r.id).size >= 3, `Lv${lv}: 問題 ${r.id} の正解の位置が混ざっていない`);
  }
}

// ---------- 4. 原因・話題の散らばり(361 は原因の種類を散らす。328・329 は型を混ぜる) ----------
const sogo = JSON.parse(fs.readFileSync(path.join(DATA, '361-sogo.json'), 'utf8')).rows;
assert.strictEqual(new Set(sogo.map((r) => r.options[r.answerIndex])).size, sogo.length, 'Lv361: 正解の原因が重なっている');
for (const r of sogo) assert.ok((r.tables || []).length >= 2, `Lv361 ${r.id}: 構成・設定・ログの表が 2 つ以上要る`);
const out = JSON.parse(fs.readFileSync(path.join(DATA, '328-bgp-outbound.json'), 'utf8')).rows;
assert.ok(out.some((r) => /どちらの回線から出ていくか/.test(r.text)) && out.some((r) => /寄せ/.test(r.text) && /設定はどれか/.test(r.text)) && out.some((r) => /何が起きるか/.test(r.text)), 'Lv328: 「今どちら」「寄せるには」「何が起きる」の型がそろっていない');
const inb = JSON.parse(fs.readFileSync(path.join(DATA, '329-bgp-inbound.json'), 'utf8')).rows;
assert.ok(inb.some((r) => /LOCAL_PREF/.test(r.options[r.answerIndex]) === false && /AS パスを長く|AS 65010 を/.test(r.options[r.answerIndex])), 'Lv329: AS パスの延長が正解の問題が無い');
assert.ok(inb.filter((r) => !/効かない/.test(r.text)).every((r) => !/^R1 で.*LOCAL_PREF/.test(r.options[r.answerIndex])), 'Lv329: 入ってくる通信を寄せる手として LOCAL_PREF が正解になっている');
assert.ok(inb.some((r) => /効かない/.test(r.text) && /LOCAL_PREF/.test(r.options[r.answerIndex])), 'Lv329: 「LOCAL_PREF は効かない」を確かめる問題が無い');

console.log(`cl-fable-design ok: ${LV.length} levels (${LV.join(',')}), 固定問題 ${rowCount}`);
