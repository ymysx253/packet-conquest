'use strict';
// 問題の取得口。レベル → 生成器の対応はここ 1 か所(LEVELS.md 第 1〜4 章、docs/questions/COMMON.md 第 5.3 節)。
//   Lv1〜3  サブネット計算(subnet.js の難易度 1〜3)
//   Lv4〜10 アドレッシングの基礎知識(basics.js)
//   Lv11〜  docs/questions/ の設計書に沿った生成器(calc.js 11〜20、vlsm.js 21〜30、transport.js 51〜60 …)。
//          モジュールは { make(level, node, rng), RANGE: [lo, hi], VERSION } を公開する。
//          生成器の無いレベルの拠点は、ゲームでは占領も強化もできない(world.js の ask。2026-10-19)。getQuestion を直接呼ぶと Lv10 までの中で最も近いものを出し provisional を付ける
// 答えはサーバーだけが持ち、クライアントには送らない(q.meta、accept、answerIndex も送らない)。

const { makeQuestion } = require('./subnet');
const { makeBasics } = require('./basics');
const { makeRng, newSeed } = require('./rng');

// Lv11 以上の生成器(ファイルが無ければ飛ばす。実装が進むたびにここへ足す)
const GENERATOR_FILES = ['./calc', './vlsm', './kinds', './hops', './transport', './dhcpdns', './routing', './aclnat', './diagnose', './l2switch'];
const BY_LEVEL = new Map(); // level → module
for (const f of GENERATOR_FILES) {
  let mod;
  try { mod = require(f); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(f.slice(2))) continue; throw e; }
  if (!mod || typeof mod.make !== 'function' || !Array.isArray(mod.RANGE)) throw new Error(`生成器 ${f} の形が違います(make / RANGE)`);
  for (let lv = mod.RANGE[0]; lv <= mod.RANGE[1]; lv++) BY_LEVEL.set(lv, mod);
}
const BASE_MAX = 10;
const MAX_IMPLEMENTED = Math.max(BASE_MAX, ...BY_LEVEL.keys());
const hasGenerator = (level) => level >= 1 && (level <= BASE_MAX || BY_LEVEL.has(level));
// 問題のあるレベルの範囲 [[下, 上], …](画面に送る。問題の無いレベルの拠点は占領・強化できない。2026-10-19)
const QUESTION_RANGES = (() => { const out = []; for (let lv = 1; lv <= 999; lv++) { if (!hasGenerator(lv)) continue; const last = out[out.length - 1]; if (last && last[1] === lv - 1) last[1] = lv; else out.push([lv, lv]); } return out; })();

function getQuestion({ level, node, seed }) {
  const s = Number.isInteger(seed) ? seed >>> 0 : newSeed();
  if (level > BASE_MAX && BY_LEVEL.has(level)) {
    const q = BY_LEVEL.get(level).make(level, node, makeRng(s));
    return { ...q, level, seed: q.seed !== undefined ? q.seed : s, answerKind: q.answerKind || 'choice', source: 'generated', provisional: false };
  }
  const lv = Math.max(1, Math.min(BASE_MAX, level));
  const q = lv <= 3 ? makeQuestion(lv, node.base, node.span || 65534) : makeBasics(lv, node.base);
  return { ...q, level, seed: s, answerKind: 'choice', source: 'generated', provisional: level > BASE_MAX };
}

module.exports = { getQuestion, MAX_IMPLEMENTED, BY_LEVEL, hasGenerator, QUESTION_RANGES };
