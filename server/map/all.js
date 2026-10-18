'use strict';
// 全部の拠点マスター(地域マスターで nodeFile を持つ都道府県のファイルを全部読み、1 つにまとめる)。
// 路線のつながり(adj)は都県境をまたぐので、ファイルをまとめたあとで ADJ / EDGES / hits を作る。
// 開始地点の既定(SPAWN_CENTER)は東京のファイルのもの。
const { loadAll } = require('./load');

module.exports = loadAll();
