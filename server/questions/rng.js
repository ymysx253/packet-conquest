'use strict';
// seed 付き乱数(docs/questions/COMMON.md 第 5.2 節)。mulberry32。
// Lv11 以上の生成器は Math.random を使わず、この rng を引数で受け取る。(templateId, seed, generatorVersion) から同じ問題を再現できる。

function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // 両端を含む整数
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  const shuffle = (arr) => { const b = arr.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  return { next, rand, pick, shuffle, seed: a };
}

// seed を決める(無ければ乱数)。32 ビットの正の整数
function newSeed() { return Math.floor(Math.random() * 0xffffffff) >>> 0; }

module.exports = { makeRng, newSeed };
