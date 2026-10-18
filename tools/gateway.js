'use strict';
// 空港と港(玄関口)の基礎レベル(2026-10-19 決定)。名所の取り込み(import-landmarks.js)と離島の取り込み(import-islands.js)で共通に使う。
//   空港: 最低 Lv5。各都道府県で知名度 1 位の空港は Lv8(取り込み側で決める)。国際線の拠点の空港は Lv10
//   港:   最低 Lv3
// 空港・港は占領すると航路(空路・海路)の先の空港・港を攻撃できる(docs/DESIGN.md 3.4、航路のデータは tools/import-routes.js)。

// 国際線の拠点の空港(Wikidata の日本語ラベル。羽田は東京の手作りの拠点「羽田空港」)
const HUB_AIRPORTS = new Set(['成田国際空港', '羽田空港', '東京国際空港', '関西国際空港', '中部国際空港', '新千歳空港', '福岡空港', '那覇空港']);
const AIRPORT_MIN = 5, AIRPORT_HUB = 10, PORT_MIN = 3;

function gatewayLevel(genre, name, level) {
  if (genre === 'airport') return HUB_AIRPORTS.has(name) ? Math.max(level, AIRPORT_HUB) : Math.max(level, AIRPORT_MIN);
  if (genre === 'port') return Math.max(level, PORT_MIN);
  return level;
}

module.exports = { gatewayLevel, HUB_AIRPORTS, AIRPORT_MIN, AIRPORT_HUB, PORT_MIN };
