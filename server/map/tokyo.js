'use strict';
// 東京の拠点マスター。中身は server/map/data/tokyo.json にあり、ここは読み込むだけ。
const { loadRegion } = require('./load');

module.exports = loadRegion('tokyo');
