'use strict';
// 問題の取得口。レベル → 問題の対応はここ 1 か所。
// 2026-10-27 から 1〜100 のレベル(docs/LEVEL-LIST.md 第 12 章)で出す: server/questions/cl の getLevelQuestion が、そのレベルに割り当てた
// LEVEL-LIST の項目(level100.json)のうち問題のできているものから 1 つ選ぶ。ふつうの拠点は 1〜90、91〜100 は神レベル(まだ無い)。
// 前の番号の生成器(subnet.js・basics.js・calc.js …)は cl/levels-legacy.js が新しい番号で使っている。
// 問題の無いレベルの拠点は、ゲームでは占領も強化もできない(world.js の ask。2026-10-19)
// 答えはサーバーだけが持ち、クライアントには送らない(q.meta、accept、answerIndex も送らない)。

const cl = require('./cl');

const hasGenerator = (level) => Number.isInteger(level) && level >= 1 && level <= 100 && cl.hasLevel(level);
// 問題のあるレベルの範囲 [[下, 上], …](画面に送る。問題の無いレベルの拠点は占領・強化できない。2026-10-19)
const QUESTION_RANGES = (() => { const out = []; for (let lv = 1; lv <= 100; lv++) { if (!hasGenerator(lv)) continue; const last = out[out.length - 1]; if (last && last[1] === lv - 1) last[1] = lv; else out.push([lv, lv]); } return out; })();

function getQuestion({ level, node = null, seed }) {
  const q = cl.getLevelQuestion({ level, seed, node });
  return { ...q, source: 'cl', provisional: false };
}

module.exports = { getQuestion, hasGenerator, QUESTION_RANGES };
