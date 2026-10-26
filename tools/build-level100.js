'use strict';
// 1〜100 のレベル(2026-10-23 ユーザー決定)を作る: server/questions/cl/level100-map.json(手で直す割り当て)と docs/LEVEL-LIST.md の 361 項目から
// server/questions/cl/level100.json(ready は問題のできている項目)を書き出す。割り当ては話題と難しさでまとめる。項目の数はレベルによって違う(2026-10-23 ユーザー)。
// 入門 1〜15・初級 16〜35・中級 36〜60・上級 61〜78・専門 79〜90。91〜100 は神レベル(試験の外の上級者向け。中身はまだ無い)。
// map・LEVEL-LIST.md を直したり問題を足したりしたら流し直す
// 使い方: node tools/build-level100.js
const fs = require('fs');
const root = require('path').join(__dirname, '..');
const md = fs.readFileSync(root + '/docs/LEVEL-LIST.md', 'utf8').split('\n');
const STAGES = [['入門', /^## 2\. 入門/], ['初級', /^## 3\. 初級/], ['中級', /^## 4\. 中級/], ['上級', /^## 5\. 上級/], ['専門', /^## 6\. 専門/]];
let stage = null; const items = new Map();
for (const l of md) {
  const s = STAGES.find(([, re]) => re.test(l)); if (s) { stage = s[0]; continue; }
  if (/^## [7-9]|^## 1[0-9]/.test(l)) stage = null;
  const m = /^\| (\d+) \| ([^|]+) \|/.exec(l);
  if (stage && m) items.set(Number(m[1]), { stage, title: m[2].trim() });
}
const { LEVELS } = require(root + '/server/questions/cl');
const map = JSON.parse(fs.readFileSync(root + '/server/questions/cl/level100-map.json', 'utf8'));
const BANDS = { 入門: [1, 15], 初級: [16, 35], 中級: [36, 60], 上級: [61, 78], 専門: [79, 90] };
const bandOf = (lv) => Object.keys(BANDS).find((st) => lv >= BANDS[st][0] && lv <= BANDS[st][1]);
// 割り当ての確かめ: どのレベルも空にしない・項目はちょうど 1 回ずつ・自分の段の範囲に入る
const errors = []; const seen = new Map(); const levels = {};
for (let lv = 1; lv <= 90; lv++) {
  const e = map.levels[lv]; const st = bandOf(lv);
  if (!e || !e.items || !e.items.length) { errors.push(`Lv${lv} が空`); continue; }
  if (!e.topic) errors.push(`Lv${lv} に topic が無い`);
  for (const n of e.items) {
    const it = items.get(n);
    if (!it) errors.push(`Lv${lv}: 項目 ${n} は LEVEL-LIST に無い`);
    else if (it.stage !== st) errors.push(`Lv${lv}(${st}): 項目 ${n} は ${it.stage}`);
    if (seen.has(n)) errors.push(`項目 ${n} が Lv${seen.get(n)} と Lv${lv} の両方にある`);
    seen.set(n, lv);
  }
  levels[lv] = { stage: st, topic: e.topic, items: e.items, titles: e.items.map((n) => (items.get(n) || {}).title), ready: e.items.filter((n) => LEVELS.has(n)) };
}
for (const lv of Object.keys(map.levels)) if (!(Number(lv) >= 1 && Number(lv) <= 90)) errors.push(`Lv${lv} は 1〜90 の外`);
for (const n of items.keys()) if (!seen.has(n)) errors.push(`項目 ${n} がどのレベルにも無い`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const out = { note: '1〜100 のレベル(2026-10-23 ユーザー決定)。docs/LEVEL-LIST.md の項目(1〜361)を、話題と難しさでまとめた(項目の数はレベルによって違う)。割り当ての元は level100-map.json。91〜100 は神レベル(試験の外。上級者向け。中身はまだ無い)。作り直しは tools/build-level100.js', bands: { ...BANDS, 神: [91, 100] }, levels };
fs.writeFileSync(root + '/server/questions/cl/level100.json', JSON.stringify(out, null, 1));
const count = Object.values(levels);
console.log('items', items.size, 'levels', count.length, 'ready levels', count.filter((l) => l.ready.length).length, 'per level', Math.min(...count.map((l) => l.items.length)), '-', Math.max(...count.map((l) => l.items.length)));
for (const [st] of STAGES) console.log(st, [...items.values()].filter((x) => x.stage === st).length);
