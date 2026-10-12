'use strict';
// 日本とその周辺を簡略化したネットワーク地図。座標は 1000 x 680 の描画空間。
// kind: DC = データセンター(1点), IX = 相互接続点(3点), GW = 海底ケーブルの陸揚げ拠点(2点)

const RAW = [
  ['sapporo', '札幌DC', 'DC', 790, 70],
  ['sendai', '仙台DC', 'DC', 770, 195],
  ['tokyo', '東京IX', 'IX', 690, 295],
  ['yokohama', '横浜DC', 'DC', 745, 395],
  ['nagoya', '名古屋DC', 'DC', 565, 345],
  ['kyoto', '京都DC', 'DC', 480, 250],
  ['osaka', '大阪IX', 'IX', 440, 380],
  ['hiroshima', '広島DC', 'DC', 310, 345],
  ['fukuoka', '福岡DC', 'DC', 200, 420],
  ['naha', '那覇DC', 'DC', 240, 590],
  ['busan', '釜山GW', 'GW', 90, 275],
  ['taipei', '台北GW', 'GW', 80, 520],
  ['singapore', 'シンガポールGW', 'GW', 110, 605],
  ['seattle', 'シアトルGW', 'GW', 930, 160],
  ['la', 'ロサンゼルスGW', 'GW', 930, 470],
];

const LINKS = [
  ['sapporo', 'sendai'], ['sendai', 'tokyo'], ['tokyo', 'yokohama'], ['tokyo', 'nagoya'],
  ['yokohama', 'nagoya'], ['nagoya', 'kyoto'], ['kyoto', 'osaka'], ['nagoya', 'osaka'],
  ['tokyo', 'osaka'], ['osaka', 'hiroshima'], ['hiroshima', 'fukuoka'], ['fukuoka', 'naha'],
  ['fukuoka', 'busan'], ['naha', 'taipei'], ['taipei', 'singapore'], ['osaka', 'singapore'],
  ['tokyo', 'seattle'], ['yokohama', 'la'], ['sapporo', 'seattle'], ['busan', 'kyoto'],
];

const VALUE = { DC: 1, IX: 3, GW: 2 };
const BASE_LEVEL = { DC: 0, IX: 1, GW: 1 };

const NODES = RAW.map(([id, name, kind, x, y], i) => {
  const a = kind === 'GW' ? 172 : 10;
  const b = kind === 'GW' ? 16 + i : i + 1;
  return {
    id, name, kind, x, y,
    value: VALUE[kind],
    baseLevel: BASE_LEVEL[kind],
    base: ((a << 24) >>> 0) + b * 65536,
    subnet: `${a}.${b}.0.0/16`,
    cable: false,
  };
});

const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
const EDGES = LINKS.map(([a, b]) => ({ a, b, cable: byId[a].kind === 'GW' || byId[b].kind === 'GW' }));
const ADJ = Object.fromEntries(NODES.map((n) => [n.id, []]));
for (const { a, b } of EDGES) { ADJ[a].push(b); ADJ[b].push(a); }

// 開始地点の優先順(なるべく離れた拠点)
const SPAWNS = ['sapporo', 'naha', 'la', 'busan', 'sendai', 'hiroshima'];

module.exports = { NODES, EDGES, ADJ, byId, SPAWNS, WIDTH: 1000, HEIGHT: 680 };
