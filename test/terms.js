'use strict';
// 技術用語マスターと機器種別マスターの検証(重複、参照の整合、必須項目、安全方針)
const assert = require('assert');
const terms = require('../server/questions/data/terms.json');
const devices = require('../server/questions/data/devices.json');

// 用語
const ids = new Set();
for (const t of terms.terms) {
  for (const k of ['id', 'name', 'category']) assert.ok(typeof t[k] === 'string' && t[k], `${t.id || '?'}: ${k} が必要`);
  assert.ok(!ids.has(t.id), `${t.id}: id が重複`); ids.add(t.id);
  assert.ok(terms.categories[t.category], `${t.id}: category が不正 ${t.category}`);
  assert.ok(t.vendor === null || typeof t.vendor === 'string', `${t.id}: vendor は文字列か null`);
  assert.ok(Array.isArray(t.aliases) && Array.isArray(t.related), `${t.id}: aliases / related は配列`);
  assert.ok(typeof t.note === 'string' && t.note, `${t.id}: note(解説での扱い)が必要`);
  // 独自方式には「独自」か「由来」の説明があること(解説で併記するため)
  if (t.vendor && !/オープンソース/.test(t.vendor)) assert.ok(/独自|由来|旧/.test(t.note), `${t.id}: 独自方式である旨を note に書く`);
}
for (const t of terms.terms) for (const r of t.related) assert.ok(ids.has(r), `${t.id}: related の ${r} が無い`);
// 独自方式には標準の対応が related にあること(EIGRP のように標準の代替がないものは note に明記)
for (const t of terms.terms) {
  if (!t.vendor || /オープンソース/.test(t.vendor)) continue;
  const hasStd = t.related.some((r) => terms.terms.find((x) => x.id === r && x.vendor === null));
  assert.ok(hasStd || /標準の代替がない/.test(t.note), `${t.id}: 標準名の対応(related)か、代替がない旨の note が必要`);
}
assert.ok(terms.terms.length >= 30, '用語が少なすぎる');

// 機器
const abbrs = new Set(), dids = new Set();
for (const d of devices.devices) {
  for (const k of ['id', 'abbr', 'name', 'nameEn']) assert.ok(typeof d[k] === 'string' && d[k], `${d.id || '?'}: ${k} が必要`);
  assert.ok(!dids.has(d.id), `${d.id}: id が重複`); dids.add(d.id);
  assert.ok(!abbrs.has(d.abbr), `${d.id}: 略号 ${d.abbr} が重複`); abbrs.add(d.abbr);
  assert.ok(Number.isInteger(d.layer) && d.layer >= 2 && d.layer <= 7, `${d.id}: layer`);
  assert.ok(Array.isArray(d.roles) && d.roles.length, `${d.id}: roles`);
  assert.ok(Array.isArray(d.commands) && Array.isArray(d.configScope), `${d.id}: commands / configScope は配列`);
  // 安全: 走査系・攻撃系のコマンドを機器に持たせない
  for (const c of d.commands) assert.ok(!/nmap|masscan|hydra|metasploit|sqlmap|exploit/i.test(c), `${d.id}: 走査・攻撃系のコマンドは入れない (${c})`);
  // モデル名は架空メーカーの接頭辞
  if (d.model) assert.match(d.model, /^PCN-/, `${d.id}: モデル名は架空メーカー PCN- で始める`);
}
assert.strictEqual(devices.vendor.id, 'pcn');
assert.ok(devices.devices.length >= 12);

// 用語マスターの標準/独自の内訳
const std = terms.terms.filter((t) => t.vendor === null).length;
const prop = terms.terms.filter((t) => t.vendor && !/オープンソース/.test(t.vendor)).length;
console.log(`terms ok: ${terms.terms.length} terms (standard ${std}, vendor ${prop}), ${devices.devices.length} device kinds`);
