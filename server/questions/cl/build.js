'use strict';
// 新しい番号(docs/LEVEL-LIST.md の 1〜361。学ぶ順)の問題を作るための共通の道具(2026-10-22)。
// 表(FactBank)の行から ○×・3 択・4 択を組み立てる。乱数は引数の rng(rng.js の makeRng)だけを使う。Math.random は使わない。
// 問題の形は docs/questions/CL.md。答え(answerIndex・accept・meta)はサーバーだけが持ち、画面には送らない(world.js が送る項目を選ぶ)
const path = require('path');

const TF = ['○', '×']; // ○× の選択肢(0 = ○、1 = ×)

// 表を読む。checkedBy の無い行は使わない(本番の生成に使わない決まり。transport.js と同じ)
function loadFacts(file) {
  const d = require(path.join(__dirname, '..', 'data', 'cl', file));
  const rows = (d.rows || []).filter((r) => r && r.checkedBy);
  if (!rows.length) throw new Error(`${file}: 確認済み(checkedBy)の行がありません`);
  return rows;
}

// 正解 1 つと誤答の候補から、重複なしの n 択を作る。候補が足りなければ例外(足りない問題を出さない)
function choices(rng, correct, wrongs, n = 4) {
  const set = new Set([correct]);
  for (const w of rng.shuffle(wrongs)) { if (set.size >= n) break; if (w != null && w !== '' && w !== correct) set.add(w); }
  if (set.size < n) throw new Error(`選択肢が ${n} つ作れません(${correct})`);
  const options = rng.shuffle([...set]);
  return { options, answerIndex: options.indexOf(correct) };
}

// ○×: 文が正しければ ○
function trueFalse(statement, isTrue) {
  return { options: TF.slice(), answerIndex: isTrue ? 0 : 1, statement };
}

// 表の行から「説明 → 名前」(または「名前 → 説明」)の n 択。get(row) で行から出す値を決める
//   ask(row) → 問題文、answer(row) → 正解の文字、others: 誤答に使う行(既定は同じ表のほかの行)
function fromFacts(rng, rows, { n = 4, ask, answer, others = null, pick = null }) {
  const row = pick ? pick(rng, rows) : rng.pick(rows);
  const correct = answer(row);
  const wrongs = (others || rows).filter((r) => r !== row).map(answer).filter((v) => v !== correct);
  const c = choices(rng, correct, wrongs, n);
  return { row, text: ask(row), ...c };
}

module.exports = { TF, loadFacts, choices, trueFalse, fromFacts };
