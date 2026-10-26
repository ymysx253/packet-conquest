'use strict';
// 試作(2026-10-27 ユーザー依頼: 1〜100 のレベルと新しい印をモックで見る)。LEVEL100_MOCK=1 かつ STORE=memory のときだけ効く。
// 拠点マスター・DB は変えない。メモリ版にシードするときに、拠点のレベルを下書き(docs/level100-nodes-draft.json)に置き換え、
// 縮小したときに出す段(ov)を付ける。画面は ?lv100 を付けて開く(public/app.js の MOCK100)。
const path = require('path');

const ENABLED = process.env.LEVEL100_MOCK === '1' && process.env.STORE === 'memory';

// 縮小の段(よいかんじで決めた試作の値。今の件数に近くなるように):
//   段 1(地方が見える): Lv87 以上(約 2,100 件。今の Lv30 以上 2,179 件と同じくらい)
//   段 2(いくつかの県が見える): Lv90(約 490 件。今は Lv100 以上 265 件)
//   段 3・4(日本全体): 今と同じ顔ぶれ(国会議事堂・都庁・都道府県庁舎・国際線の拠点の空港。前のレベル 400 以上 55 件)
const tierOf = (oldLevel, lv) => (oldLevel >= 400 ? 4 : lv >= 90 ? 2 : lv >= 87 ? 1 : 0);

function apply(docs) {
  if (!ENABLED) return docs;
  const draft = require(path.join(__dirname, '..', 'docs', 'level100-nodes-draft.json'));
  let n = 0;
  for (const d of docs) {
    const lv = draft[d.id];
    if (!Number.isInteger(lv)) continue;
    d.ov = tierOf(d.level, lv);
    d.level = lv; n++;
  }
  console.log(`試作: 拠点のレベルを 1〜100 の下書きにした(${n} 件)`);
  return docs;
}

module.exports = { ENABLED, apply };
