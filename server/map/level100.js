'use strict';
// 拠点のレベル 1〜90 と点数(2026-10-27 からゲームが使う。docs/DESIGN.md の 2026-10-26・10-27)。
// 拠点マスター(server/map/data/<都道府県>.json)の level は前の格(1〜777)のまま残し、取り込みの道具(tools/levels.js)と
// レベルの計算(tools/level100-nodes.js)が使う。DB に入れる形(load.js の nodeDocs)を作るときに、ここで 1〜90 に置き換える。
//   level: server/map/data/level100.json(tools/level100-nodes.js が作る)。非公開の拠点は表に無いので 1
//   value: 占領の点数 = 四捨五入(K × 1.05^レベル)、最低 1。K は公開の拠点を全部取った合計がおよそ 100 万点になる数
//   top:   日本全体が見える倍率(タイルの段 3・4)で描く拠点。前の格 400 以上(国会議事堂・都庁・都道府県庁舎・国際線の拠点の空港。55 件)
//   grade: 前の格(画面には出さない。DB で元をたどれるように残す)
const path = require('path');

const LEVEL_MAX = 90; // ふつうの拠点のレベルの上限(強化もここで止まる)。91〜100 は神レベル(置く場所は未決)
const POINTS_K = 0.849; // 2026-10-27 の公開 117,222 拠点で合計 999,575 点
const TOP_GRADE = 400;

let table = null;
const levels = () => table || (table = require(path.join(__dirname, 'data', 'level100.json')));
const levelOf = (id) => levels()[id];
const pointsOf = (level) => Math.max(1, Math.round(POINTS_K * 1.05 ** level));

// マスターの拠点(前の格)→ DB に入れる値
function toGame(m) {
  const lv = levelOf(m.id);
  const level = Number.isInteger(lv) ? lv : 1;
  return { level, value: pointsOf(level), grade: m.level, top: m.level >= TOP_GRADE };
}

module.exports = { LEVEL_MAX, POINTS_K, TOP_GRADE, levelOf, pointsOf, toGame, levels };
