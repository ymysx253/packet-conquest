'use strict';
// 1〜100 のレベル(2026-10-23 ユーザー決定)を作る: docs/LEVEL-LIST.md の 361 項目を、段ごとに学ぶ順のまま連続した塊に分けて 1〜89 に詰める。
// 入門 1〜15・初級 16〜35・中級 36〜60・上級 61〜78・専門 79〜89。90〜100 は神レベル(試験の外の上級者向け。中身はまだ無い)。
// 書き出し: server/questions/cl/level100.json(ready は問題のできている項目)。LEVEL-LIST.md を直したり問題を足したりしたら流し直す
// 使い方: node tools/build-level100.js
const fs = require('fs');
const root = require('path').join(__dirname, '..');
const md = fs.readFileSync(root + '/docs/LEVEL-LIST.md', 'utf8').split('\n');
const STAGES = [['入門', /^## 2\. 入門/], ['初級', /^## 3\. 初級/], ['中級', /^## 4\. 中級/], ['上級', /^## 5\. 上級/], ['専門', /^## 6\. 専門/]];
let stage = null; const items = [];
for (const l of md) {
  const s = STAGES.find(([, re]) => re.test(l)); if (s) { stage = s[0]; continue; }
  if (/^## [7-9]|^## 1[0-9]/.test(l)) stage = null;
  const m = /^\| (\d+) \| ([^|]+) \|/.exec(l);
  if (stage && m) items.push({ n: Number(m[1]), stage, title: m[2].trim() });
}
const { LEVELS } = require(root + '/server/questions/cl');
const BANDS = { 入門: [1, 15], 初級: [16, 35], 中級: [36, 60], 上級: [61, 78], 専門: [79, 89] };
const levels = {};
for (const [st, [lo, hi]] of Object.entries(BANDS)) {
  const list = items.filter((x) => x.stage === st); const k = hi - lo + 1;
  for (let i = 0; i < k; i++) {
    const a = Math.round((i * list.length) / k), b = Math.round(((i + 1) * list.length) / k);
    const chunk = list.slice(a, b);
    levels[lo + i] = { stage: st, items: chunk.map((x) => x.n), titles: chunk.map((x) => x.title), ready: chunk.filter((x) => LEVELS.has(x.n)).map((x) => x.n) };
  }
}
const out = { note: '1〜100 のレベル(2026-10-23 ユーザー決定)。docs/LEVEL-LIST.md の項目(1〜361)を、段ごとに学ぶ順のまま連続した塊にまとめた。1 レベルに 3〜5 項目。90〜100 は神レベル(試験の外。上級者向け。中身はまだ無い)。作り直しは tools/build-level100.js', bands: { ...BANDS, 神: [90, 100] }, levels };
fs.writeFileSync(root + '/server/questions/cl/level100.json', JSON.stringify(out, null, 1));
const count = Object.values(levels);
console.log('items', items.length, 'levels', count.length, 'ready levels', count.filter((l) => l.ready.length).length, 'per level', Math.min(...count.map((l) => l.items.length)), '-', Math.max(...count.map((l) => l.items.length)));
for (const [st] of STAGES) console.log(st, items.filter((x) => x.stage === st).length);
