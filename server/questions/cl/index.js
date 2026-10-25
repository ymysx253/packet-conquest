'use strict';
// 新しい番号(docs/LEVEL-LIST.md の 1〜361。学ぶ順に並べたレベル)の問題の取得口(2026-10-22)。
// いまのゲームの拠点は、まだ前の番号(server/questions/index.js の Lv1〜30・51〜60)で出題している。
// どの拠点にどの新しいレベルを出すか(docs/LEVEL-PLAN.md の B 案など)は未決なので、ここはゲームにはまだつないでいない。
//
// 段ごとのファイル(担当ごとに 1 つ。同じファイルを 2 人で直さない):
//   levels-intro.js 入門 1〜67 / levels-basic.js 初級 68〜158 / levels-mid.js 中級 159〜252 / levels-adv.js 上級 253〜319 / levels-legacy.js 前の生成器を新しい番号で出す口
//   levels-fable-route.js / levels-fable-diag.js / levels-fable-design.js: 一覧の「担当」が F・O→F の行(Fable 5.1 が作る。2026-10-25)
// 各ファイルは LEVELS = { <番号>: { title, kind, make(rng, ctx), verify?(q), minDistinct? } } を出す。kind: '生' | '表' | '生+固'
// 問題の形は docs/questions/CL.md。テストは test/cl.js(全レベルをまとめて確かめる)
const { makeRng, newSeed } = require('../rng');

const FILES = ['./levels-intro', './levels-basic', './levels-mid', './levels-adv', './levels-legacy',
  './levels-fable-route', './levels-fable-diag', './levels-fable-design', // Fable の分(2026-10-25。docs/questions/CL.md 第 1 章)
  './levels-expert', './levels-expert-facts', // 専門(320〜361)の O の行(Fable 5.1 が作る。2026-10-25)
  './levels-sim-basic', './levels-sim-mid', './levels-sim-adv', './levels-sim-expert']; // 構成図・設定・模擬ターミナルの問題(docs/questions/SIM-API.md。2026-10-25)
const LEVELS = new Map(); // 番号 → { title, kind, make, verify, minDistinct, file }
for (const f of FILES) {
  let mod;
  try { mod = require(f); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(f.slice(2))) continue; throw e; }
  for (const [k, v] of Object.entries(mod.LEVELS || {})) {
    const lv = Number(k);
    if (!Number.isInteger(lv) || lv < 1 || lv > 999) throw new Error(`${f}: 番号 ${k} が正しくありません`);
    if (LEVELS.has(lv)) throw new Error(`${f}: Lv${lv} は ${LEVELS.get(lv).file} にもあります`);
    if (typeof v.make !== 'function') throw new Error(`${f}: Lv${lv} に make がありません`);
    LEVELS.set(lv, { ...v, file: f });
  }
}

const hasClLevel = (lv) => LEVELS.has(lv);
// 問題を 1 つ作る。seed を渡せば同じ問題を作り直せる(固定問題を DB に テンプレート id・seed・版 で残す前提)
function getClQuestion({ level, seed, node = null }) {
  const ent = LEVELS.get(level);
  if (!ent) throw new Error(`新しい番号の Lv${level} の問題はまだありません`);
  const s = Number.isInteger(seed) ? seed >>> 0 : newSeed();
  const q = ent.make(makeRng(s), { level, node });
  return { answerKind: 'choice', ...q, level, seed: s, source: 'cl', clKind: ent.kind };
}

// 1〜100 のレベル(2026-10-23 ユーザー決定。level100.json。tools/build-level100.js が level100-map.json から作る)。1 レベルに LEVEL-LIST の項目が話題と難しさでまとめて入り(数はレベルによって違う)、
// そのうち問題のできている項目から seed で 1 つ選んで出す(同じレベルの中で問題の種類が入れ替わる)。90〜100 は神レベル(まだ無い)
const L100 = require('./level100.json');
const readyOf = (lv) => { const e = L100.levels[lv]; return e ? e.items.filter((n) => LEVELS.has(n)) : []; };
const hasLevel = (lv) => readyOf(lv).length > 0;
function getLevelQuestion({ level, seed, node = null }) {
  const ready = readyOf(level);
  if (!ready.length) throw new Error(`Lv${level} の問題はまだありません`);
  const s = Number.isInteger(seed) ? seed >>> 0 : newSeed();
  const r = makeRng(s);
  const item = ready[Math.floor(r.next() * ready.length)];
  const q = getClQuestion({ level: item, seed: (s ^ 0x5bd1e995) >>> 0, node });
  return { ...q, level, item, seed: s, stage: L100.levels[level].stage };
}

module.exports = { LEVELS, hasClLevel, getClQuestion, L100, hasLevel, getLevelQuestion };
