'use strict';
// 互換のための別名。拠点マスターは都道府県ごとのファイル(tokyo.json、kanagawa.json …)にあり、server/map/all.js が全部まとめて読む。
module.exports = require('./all');
