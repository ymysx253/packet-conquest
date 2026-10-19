'use strict';
// 空港と港(玄関口)の基礎レベル。名所の取り込み(import-landmarks.js)、離島の取り込み(import-islands.js)、航路の端点(import-gateways.js)で共通に使う。
// 2026-10-19 に新しい物差しへ(docs/LEVEL-PLAN.md、tools/levels.js):
//   空港: 最低 Lv150。各都道府県で知名度 1 位の空港は Lv250(取り込み側で決める)。国際線の拠点の空港は Lv500
//   港:   最低 Lv30(知名度が高ければ 50・70)
// 空港・港は占領すると航路(空路・海路)の先の空港・港を攻撃できる(docs/DESIGN.md 3.4、航路のデータは tools/import-routes.js)。
const { L } = require('./levels');

// 国際線の拠点の空港(Wikidata の日本語ラベル。羽田は東京の手作りの拠点「羽田空港」)
const HUB_AIRPORTS = new Set(['成田国際空港', '羽田空港', '東京国際空港', '関西国際空港', '中部国際空港', '新千歳空港', '福岡空港', '那覇空港']);
const AIRPORT_MIN = L.AIRPORT, AIRPORT_HUB = L.HUB_AIRPORT, PORT_MIN = L.PORT_MIN;

function gatewayLevel(genre, name, level) {
  if (genre === 'airport') return HUB_AIRPORTS.has(name) ? Math.max(level, AIRPORT_HUB) : Math.max(level, AIRPORT_MIN);
  if (genre === 'port') return Math.max(level, PORT_MIN);
  return level;
}

module.exports = { gatewayLevel, HUB_AIRPORTS, AIRPORT_MIN, AIRPORT_HUB, PORT_MIN };
