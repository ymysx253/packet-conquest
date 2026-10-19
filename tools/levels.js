'use strict';
// レベルの物差し(2026-10-19 決定。docs/LEVEL-PLAN.md)。取り込みの道具と、一度だけのレベルの移し替え(tools/migrate-levels-v2.js)が共通に使う。
// レベルは出題の難しさそのもの(docs/LEVELS.md)。国の象徴を 777 に置き、そこから段ごとに割り付ける。
//
//   国の象徴(国会議事堂) 777 / 首都の象徴(東京都庁) 600 / 国際線の拠点の空港 500 / 都道府県庁舎 400 / 各県で一番の城・塔 300
//   各県で一番の空港 250 / 主要駅 200 / ほかの空港 150・各県で一番の観光地 150 / 乗り換え駅・港・有名な名所 30〜99 / ふつうの駅 10・ほかの名所 15〜25 / 町・字 1〜9

const L = Object.freeze({
  NATIONAL_SYMBOL: 777, CAPITAL_SYMBOL: 600, HUB_AIRPORT: 500, PREF_OFFICE: 400, PREF_TOP_CASTLE: 300, TOWER: 300,
  PREF_TOP_AIRPORT: 250, MAIN_STATION: 200, AIRPORT: 150, PORT_MIN: 30, STATION: 10,
  // 観光地(2026-10-19 ユーザー決定。tools/import-tourism.js): 世界遺産・日本三景・特別名勝 300、各都道府県で一番 150、指定・百選あり 30〜70、ほか 15〜25
  TOURISM_NATIONAL: 300, TOURISM_PREF_TOP: 150, TOURISM_DESIGNATED_MIN: 30, TOURISM_PLAIN_MAX: 25,
});

// 名所の知名度(Wikidata の言語版の数)→ レベル。40 以上 70、25 以上 50、15 以上 30、8 以上 25、それ未満 15
const fameLevel = (sitelinks) => (sitelinks >= 40 ? 70 : sitelinks >= 25 ? 50 : sitelinks >= 15 ? 30 : sitelinks >= 8 ? 25 : 15);
// 移し替え用: 古い物差し(知名度で Lv1〜5)→ 新しい物差し
const FAME_OLD_TO_NEW = { 1: 15, 2: 25, 3: 30, 4: 50, 5: 70 };

// 主要ターミナルと象徴的な駅(都道府県ごと。同名の駅が別の県にあるため)。値 4〜5 は主要駅(200)、3 は地域の主要な乗り換え駅(60 以上)
const TERMINALS_BY_PREF = {
  tokyo: { 大手町: 5, 東京: 4, 新宿: 4, 池袋: 4, 渋谷: 4, 品川: 4, 上野: 4, 霞ケ関: 4, 霞ヶ関: 4, 霞が関: 4,
    秋葉原: 3, 北千住: 3, 立川: 3, 八王子: 3, 町田: 3, 吉祥寺: 3, 新橋: 3, 有楽町: 3, 錦糸町: 3, 蒲田: 3, 中野: 3, 高田馬場: 3 },
  kanagawa: { 横浜: 4, 川崎: 3, 武蔵小杉: 3, 新横浜: 3, 藤沢: 3, 大船: 3, 小田原: 3, 海老名: 3 },
  chiba: { 千葉: 4, 船橋: 3, 西船橋: 3, 柏: 3, 松戸: 3, 津田沼: 3, 成田空港: 3 },
  saitama: { 大宮: 4, 浦和: 3, 川越: 3, 所沢: 3, 熊谷: 3 },
  ibaraki: { 水戸: 3, つくば: 3, 土浦: 3 }, tochigi: { 宇都宮: 3, 小山: 3 }, gunma: { 高崎: 3, 前橋: 3 },
  hokkaido: { 札幌: 4, さっぽろ: 3, 大通: 3, 新千歳空港: 3, 旭川: 3, 函館: 3, 新函館北斗: 3, 釧路: 3, 帯広: 3 },
  aomori: { 青森: 3, 新青森: 3, 八戸: 3 }, iwate: { 盛岡: 3 }, miyagi: { 仙台: 4 }, akita: { 秋田: 3 }, yamagata: { 山形: 3 }, fukushima: { 福島: 3, 郡山: 3 },
  niigata: { 新潟: 3 }, toyama: { 富山: 3 }, ishikawa: { 金沢: 3 }, fukui: { 福井: 3 }, yamanashi: { 甲府: 3 }, nagano: { 長野: 3, 松本: 3 },
  gifu: { 岐阜: 3 }, shizuoka: { 静岡: 3, 浜松: 3 }, aichi: { 名古屋: 4, 栄: 3, 金山: 3, 中部国際空港: 3, 豊橋: 3 },
  mie: { 津: 3, 四日市: 3 }, shiga: { 大津: 3, 草津: 3 }, kyoto: { 京都: 4, 烏丸: 3, 四条: 3, 河原町: 3 },
  osaka: { 大阪: 4, 梅田: 4, 大阪梅田: 4, 新大阪: 4, 難波: 3, なんば: 3, 天王寺: 3, 大阪阿部野橋: 3, 京橋: 3, 鶴橋: 3, 本町: 3, 淀屋橋: 3, 関西空港: 3 },
  hyogo: { 三ノ宮: 4, 神戸三宮: 4, 三宮: 3, 神戸: 3, 新神戸: 3, 姫路: 3, 尼崎: 3 }, nara: { 奈良: 3, 大和西大寺: 3 }, wakayama: { 和歌山: 3 },
  tottori: { 鳥取: 3 }, shimane: { 松江: 3 }, okayama: { 岡山: 3 }, hiroshima: { 広島: 3 }, yamaguchi: { 新山口: 3, 下関: 3 },
  tokushima: { 徳島: 3 }, kagawa: { 高松: 3 }, ehime: { 松山: 3 }, kochi: { 高知: 3 },
  fukuoka: { 博多: 4, 天神: 3, '西鉄福岡(天神)': 3, 小倉: 3, 福岡空港: 3 }, saga: { 佐賀: 3 }, nagasaki: { 長崎: 3 }, kumamoto: { 熊本: 3 },
  oita: { 大分: 3 }, miyazaki: { 宮崎: 3 }, kagoshima: { 鹿児島中央: 3 }, okinawa: { 那覇空港: 3, 県庁前: 3 },
};

// 駅: 主要駅 200。乗り換え駅は乗り入れ路線の数で 30〜99(2 路線 30、1 路線増えるごとに +10)。地域の主要な乗り換え駅は 60 以上。ふつうの駅 10
function stationLevel(lineCount, terminal = 0) {
  if (terminal >= 4) return L.MAIN_STATION;
  let level = lineCount >= 2 ? Math.min(99, 30 + (lineCount - 2) * 10) : L.STATION;
  if (terminal === 3) level = Math.max(level, 60);
  return level;
}
const baseStationName = (name) => name.replace(/駅(\(.*\))?$/, '');
const terminalOf = (prefId, name) => (TERMINALS_BY_PREF[prefId] || {})[baseStationName(name)] || 0;

// 町・字: 人口(国勢調査 2020 年)で Lv1〜9
function townLevel(pop) {
  return pop >= 20000 ? 9 : pop >= 10000 ? 8 : pop >= 5000 ? 7 : pop >= 2000 ? 6 : pop >= 1000 ? 5 : pop >= 500 ? 4 : pop >= 100 ? 3 : pop >= 1 ? 2 : 1;
}

// 名所が近くの駅と結ぶ線の数(tools/import-links.js)。古い物差しの「レベルと同じ数(上限 8)」を、新しい物差しで同じ本数になるように引く
function landmarkLinkCount(level) {
  return level >= 250 ? 8 : level >= 70 ? 5 : level >= 50 ? 4 : level >= 30 ? 3 : level >= 25 ? 2 : 1;
}

module.exports = { L, fameLevel, FAME_OLD_TO_NEW, TERMINALS_BY_PREF, stationLevel, terminalOf, townLevel, landmarkLinkCount };
