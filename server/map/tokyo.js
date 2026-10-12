'use strict';
// 東京周辺の拠点マスター(フェーズ1)。ここから外へ広げていく。
// 位置は緯度・経度で持ち、描画座標とリンクは geo.js で計算する。
// 名称は実在の場所・建物を使うが、ゲーム内のネットワークや機器はすべて架空(設計書 3.5)。
//
// kind: IX  相互接続点        DC  データセンター     GOV 官公庁
//       LM  ランドマーク      HUB 駅・交通の要所     GW  空港・玄関口
// level: 中立のときの難易度(1: 4択 / 2: 15秒4択 / 3: 入力式)
// value: 点数

const { project, buildLinks, nearest } = require('./geo');

const WIDTH = 1000;
const HEIGHT = 680;

const KINDS = {
  IX: '相互接続点', DC: 'データセンター', GOV: '官公庁',
  LM: 'ランドマーク', HUB: '駅・交通', GW: '玄関口',
};

//      id                 名称                 kind   緯度      経度       Lv 点
const RAW = [
  ['otemachi',         '大手町IX',           'IX',  35.6867, 139.7640, 3, 5],
  ['kokkai',           '国会議事堂',         'GOV', 35.6758, 139.7447, 3, 5],
  ['tokyo-tower',      '東京タワー',         'LM',  35.6586, 139.7454, 3, 5],
  ['kasumigaseki',     '霞が関',             'GOV', 35.6735, 139.7510, 3, 3],
  ['tocho',            '東京都庁',           'GOV', 35.6896, 139.6921, 3, 3],
  ['skytree',          '東京スカイツリー',   'LM',  35.7101, 139.8107, 3, 3],
  ['haneda',           '羽田空港',           'GW',  35.5494, 139.7798, 2, 3],
  ['tokyo-station',    '東京駅',             'HUB', 35.6812, 139.7671, 2, 2],
  ['shinjuku',         '新宿駅',             'HUB', 35.6896, 139.7006, 2, 2],
  ['shibuya',          '渋谷スクランブル交差点', 'LM', 35.6595, 139.7005, 2, 2],
  ['ikebukuro',        '池袋駅',             'HUB', 35.7295, 139.7109, 2, 2],
  ['shinagawa',        '品川駅',             'HUB', 35.6284, 139.7387, 2, 2],
  ['akihabara',        '秋葉原',             'LM',  35.6984, 139.7731, 2, 2],
  ['roppongi',         '六本木ヒルズ',       'LM',  35.6604, 139.7292, 2, 2],
  ['todai',            '東京大学',           'DC',  35.7128, 139.7620, 2, 2],
  ['toyosu-dc',        '豊洲DC',             'DC',  35.6550, 139.7960, 2, 2],
  ['ueno',             '上野公園',           'LM',  35.7141, 139.7744, 1, 1],
  ['asakusa',          '浅草 雷門',          'LM',  35.7111, 139.7966, 1, 1],
  ['odaiba',           'お台場',             'LM',  35.6267, 139.7756, 1, 1],
  ['bigsight',         '東京ビッグサイト',   'LM',  35.6298, 139.7940, 1, 1],
  ['tokyo-dome',       '東京ドーム',         'LM',  35.7056, 139.7519, 1, 1],
  ['meiji-jingu',      '明治神宮',           'LM',  35.6764, 139.6993, 1, 1],
  ['ryogoku',          '両国国技館',         'LM',  35.6967, 139.7933, 1, 1],
  ['nihonbashi',       '日本橋',             'LM',  35.6840, 139.7745, 1, 1],
  ['ginza',            '銀座四丁目',         'LM',  35.6717, 139.7649, 1, 1],
  ['shimbashi',        '新橋駅',             'HUB', 35.6660, 139.7584, 1, 1],
  ['takanawa',         '高輪ゲートウェイ駅', 'HUB', 35.6356, 139.7407, 1, 1],
  ['nakano',           '中野ブロードウェイ', 'LM',  35.7090, 139.6654, 1, 1],
  ['toyosu-market',    '豊洲市場',           'LM',  35.6453, 139.7856, 1, 1],
];

const MASTER = RAW.map(([id, name, kind, lat, lon, level, value], i) => ({
  id, name, kind, kindLabel: KINDS[kind], lat, lon, level, value,
  // 問題生成に使う架空のネットワーク 10.(i+1).0.0/16
  base: ((10 << 24) >>> 0) + (i + 1) * 65536,
  subnet: `10.${i + 1}.0.0/16`,
}));

const NODES = project(MASTER, { width: WIDTH, height: HEIGHT, margin: 70 });
const EDGES = buildLinks(NODES, 3);
const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
const ADJ = Object.fromEntries(NODES.map((n) => [n.id, []]));
for (const { a, b } of EDGES) { ADJ[a].push(b); ADJ[b].push(a); }

// 新しいプレイヤーのノードが生まれる中心(東京駅)。接続先は nearestNodes で決める
const SPAWN_CENTER = { lat: 35.6812, lon: 139.7671, radiusKm: 2.5 };

module.exports = {
  KINDS, NODES, EDGES, ADJ, byId, WIDTH, HEIGHT, SPAWN_CENTER,
  nearestNodes: (lat, lon, k) => nearest(NODES, lat, lon, k),
};
