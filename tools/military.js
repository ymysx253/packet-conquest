'use strict';
// 自衛隊・米軍が設置・管理する飛行場(空港法の「共用空港」8 か所)はゲームで扱わない(2026-10-18 ユーザー決定: 軍事施設は外し、民間に限定)。
// 民間の旅客ターミナルがあっても、飛行場そのものが防衛省・米軍の施設なので扱わない(docs/PLACES.md)。
// 拠点マスターと DB には非公開(status: hidden、hiddenReason: military)で入れておく(後で使えるように。同日のユーザー指示)。
// 国や自治体が管理する民間の空港で、自衛隊も滑走路を使うもの(那覇空港 = 国管理、名古屋飛行場 = 愛知県管理)は民間の空港として扱う。
// 取り込みの道具(collect-landmarks、import-landmarks、import-islands、import-gateways、import-routes)とテスト(test/map.js)が共通に使う。

// 札幌(丘珠)、千歳、三沢、百里(茨城)、小松、美保(米子)、徳島、岩国
const MILITARY_IATA = new Set(['OKD', 'MSJ', 'IBR', 'KMQ', 'YGJ', 'TKS', 'IWK']); // 千歳飛行場は IATA コードが無い
const MILITARY_ICAO = new Set(['RJCO', 'RJCJ', 'RJSM', 'RJAH', 'RJNK', 'RJOH', 'RJOS', 'RJOI']);
const MILITARY_QID = new Set(['Q3275012', 'Q2902013', 'Q1350451', 'Q3566938', 'Q1156420', 'Q1141511', 'Q1141913', 'Q1142453', 'Q1030389']);
const MILITARY_NAME = /^(札幌飛行場|丘珠空港|千歳飛行場|千歳基地|三沢飛行場|三沢空港|百里飛行場|茨城空港|小松飛行場|小松空港|美保飛行場|米子空港|米子鬼太郎空港|徳島飛行場|徳島空港|徳島阿波おどり空港|岩国飛行場|岩国錦帯橋空港)$/;
// 航空輸送統計の空港名(tools/route-sources.js の表の名前)
const MILITARY_STAT_NAMES = { 丘珠: '札幌飛行場', 三沢: '三沢飛行場', 茨城: '百里飛行場', 金沢: '小松飛行場', 米子: '美保飛行場', 徳島: '徳島飛行場', 岩国: '岩国飛行場' };

// 拠点(または候補)が自衛隊・米軍の飛行場か。{ name, codes?: { iata, icao, wikidata }, qid? }
function isMilitaryAirfield(x) {
  const c = x.codes || {};
  return MILITARY_NAME.test(x.name || '') || MILITARY_IATA.has(c.iata) || MILITARY_ICAO.has(c.icao) || MILITARY_QID.has(c.wikidata) || MILITARY_QID.has(x.qid);
}

module.exports = { isMilitaryAirfield, MILITARY_IATA, MILITARY_ICAO, MILITARY_QID, MILITARY_STAT_NAMES };
