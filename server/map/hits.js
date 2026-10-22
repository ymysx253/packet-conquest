'use strict';
// 突破に要る正解の回数(2026-10-22 ユーザー決定: B 案)。つながりの本数(陸の線 + 航路の行き先。同じ相手は 1 本)の平方根の切り上げ。
// つながりが多い要所ほど取りにくい考えは残しつつ、2〜8 回ほどに収める(町・字 2 回、駅 3 回、大きな乗り換え駅 5 回、羽田 8 回くらい)。
// 前は「つながりの本数そのもの」で、町・字 4 回、駅 6 回、羽田 58 回になり、作業に近かった
const hitsFromLinks = (links) => Math.max(1, Math.ceil(Math.sqrt(Math.max(1, Number(links) || 1))));
module.exports = { hitsFromLinks };
