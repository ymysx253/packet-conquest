'use strict';
// テスト用: ワールドが出した問題の正解と不正解を作る(2026-10-27 から問題は 1〜100 の新しい問題で、選択・書き込み・タップ・設定がある)。
// server/questions の getQuestion を包んで出した問題を覚える。server/world.js より先に require すること(world.js は読み込み時に getQuestion を取り出す)。
// 設定の問題の正解の例(solution)は pending に入らないので、ここで覚えた問題から取る。
const Q = require('../server/questions');

const real = Q.getQuestion;
let last = null;
const byQid = new Map();
Q.getQuestion = (args) => (last = real(args));

// p.pending の問題(ask のすぐあとに呼ぶ。同じ拠点で出し直さないときは前の問題のまま)
function questionOf(p) {
  const pend = p && p.pending;
  if (!pend) return null;
  if (!byQid.has(pend.qid)) byQid.set(pend.qid, last);
  return byQid.get(pend.qid);
}

function rightAnswer(p) {
  const q = questionOf(p);
  if (!q) return -1;
  if (q.answerKind === 'text') return q.fields.map((f) => String((f.accept || [])[0] ?? ''));
  if (q.answerKind === 'tap') return { ids: q.accept.ids };
  if (q.answerKind === 'config') return { configs: q.solution };
  return q.answerIndex;
}

function wrongAnswer(p) {
  const q = questionOf(p);
  if (q.answerKind === 'text') return q.fields.map(() => 'まちがい');
  if (q.answerKind === 'tap') return { ids: ['まちがい'] };
  if (q.answerKind === 'config') return { configs: [{ device: q.editable[0], text: '' }] };
  return (q.answerIndex + 1) % q.options.length;
}

module.exports = { questionOf, rightAnswer, wrongAnswer };
