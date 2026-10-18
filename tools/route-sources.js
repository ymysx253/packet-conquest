'use strict';
// 航路の出典を読む(docs/DATA-FORMAT.md 第 5 章)。取り込みの道具(import-gateways.js、import-routes.js)が共通に使う。
//   海路: 国土数値情報 港湾間流通量・海上経路データ(S10a、2016 年度、商用可)の定期便海上経路(SeaRoute)
//   空路: 国土交通省「航空輸送統計調査」年報 第 3 表 国内定期航空路線別、区間別、月別運航及び輸送実績(暦年の計)
const fs = require('fs');
const path = require('path');
const { readSheet } = require('./xlsx');

const SEA_SOURCE = 'src-ksj-s10a-2016';
const AIR_SOURCE = 'src-mlit-air-stats';

// 統計表の空港名 → 国際的なコード(IATA、無ければ ICAO)。照合は拠点の codes で行う(第 4 章の照合の順番)。
// ヘリポート(利島・御蔵島・青ヶ島)は空港の拠点が無いので扱わない(取り込みの一覧に「照合できなかった」で出る)
const AIRPORT_CODES = {
  羽田: { iata: 'HND' }, 新千歳: { iata: 'CTS' }, 大阪: { iata: 'ITM' }, 関西: { iata: 'KIX' }, 福岡: { iata: 'FUK' }, 那覇: { iata: 'OKA' }, 成田: { iata: 'NRT' },
  稚内: { iata: 'WKJ' }, 釧路: { iata: 'KUH' }, 函館: { iata: 'HKD' }, 旭川: { iata: 'AKJ' }, 帯広: { iata: 'OBO' }, 中標津: { iata: 'SHB' }, 女満別: { iata: 'MMB' },
  紋別: { iata: 'MBE' }, 青森: { iata: 'AOJ' }, 三沢: { iata: 'MSJ' }, 秋田: { iata: 'AXT' }, 大館: { iata: 'ONJ' }, 山形: { iata: 'GAJ' }, 庄内: { iata: 'SYO' },
  八丈島: { iata: 'HAC' }, 富山: { iata: 'TOY' }, 金沢: { iata: 'KMQ' }, 能登: { iata: 'NTQ' }, 中部: { iata: 'NGO' }, 南紀白浜: { iata: 'SHM' }, 神戸: { iata: 'UKB' },
  鳥取: { iata: 'TTJ' }, 米子: { iata: 'YGJ' }, 出雲: { iata: 'IZO' }, 石見: { iata: 'IWJ' }, 岡山: { iata: 'OKJ' }, 広島: { iata: 'HIJ' }, 岩国: { iata: 'IWK' },
  山口宇部: { iata: 'UBJ' }, 徳島: { iata: 'TKS' }, 高松: { iata: 'TAK' }, 松山: { iata: 'MYJ' }, 高知: { iata: 'KCZ' }, 北九州: { iata: 'KKJ' }, 佐賀: { iata: 'HSG' },
  長崎: { iata: 'NGS' }, 熊本: { iata: 'KMJ' }, 大分: { iata: 'OIT' }, 宮崎: { iata: 'KMI' }, 鹿児島: { iata: 'KOJ' }, 奄美: { iata: 'ASJ' }, 久米島: { iata: 'UEO' },
  宮古: { iata: 'MMY' }, 下地島: { iata: 'SHI' }, 石垣: { iata: 'ISG' }, 花巻: { iata: 'HNA' }, 仙台: { iata: 'SDJ' }, 福島: { iata: 'FKS' }, 新潟: { iata: 'KIJ' },
  松本: { iata: 'MMJ' }, 但馬: { iata: 'TJH' }, 隠岐: { iata: 'OKI' }, 種子島: { iata: 'TNE' }, 屋久島: { iata: 'KUM' }, 徳之島: { iata: 'TKN' }, 利尻: { iata: 'RIS' },
  茨城: { iata: 'IBR' }, 丘珠: { iata: 'OKD' }, 奥尻: { iata: 'OIR' }, 大島: { iata: 'OIM' }, 調布: { icao: 'RJTF' }, 三宅島: { iata: 'MYE' }, 神津島: { icao: 'RJAZ' },
  新島: { icao: 'RJAN' }, 静岡: { iata: 'FSZ' }, 名古屋: { iata: 'NKM' }, 福江: { iata: 'FUJ' }, 対馬: { iata: 'TSJ' }, 壱岐: { iata: 'IKI' }, 天草: { iata: 'AXJ' },
  喜界島: { iata: 'KKX' }, 沖永良部: { iata: 'OKE' }, 与論: { iata: 'RNJ' }, 北大東島: { iata: 'KTD' }, 南大東島: { iata: 'MMD' }, 与那国: { iata: 'OGN' }, 多良間: { iata: 'TRA' },
};
const HELIPORTS = new Set(['利島', '御蔵島', '青ヶ島']);

const clean = (s) => String(s || '').replace(/[\s　]+/g, '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// 空路: 展開済みの xlsx(第 3 表)から、暦年の計を向きごとに。{ year, segments: [{ from, to, flights, passengers, cargoTons, distanceKm }] }
function readAir(dir, year) {
  const out = new Map();
  for (const sheet of [1, 2]) {
    const file = path.join(dir, 'xl', 'worksheets', `sheet${sheet}.xml`);
    if (!fs.existsSync(file)) continue;
    const rows = readSheet(dir, sheet);
    let dist = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r[0] === 2 && typeof r[1] === 'string' && /km/.test(r[1])) dist = Number(r[1].replace(/[^0-9.]/g, '')) || null; // 2 月の行に区間の距離
      if (r[0] !== '暦') continue;
      for (const row of [r, rows[i + 1]]) { // 暦年の計: 「暦」の行と次の「年」の行が向きごと
        if (!row || typeof row[1] !== 'string' || !row[1].includes('―')) continue;
        const [a, b] = row[1].split('―').map(clean);
        const k = `${a}|${b}`;
        const cur = out.get(k) || { from: a, to: b, flights: 0, passengers: 0, cargoTons: 0, distanceKm: dist };
        cur.flights += num(row[2]); cur.passengers += num(row[5]); cur.cargoTons += num(row[10]) / 1000;
        out.set(k, cur);
      }
    }
  }
  return { year, segments: [...out.values()].map((s) => ({ ...s, cargoTons: Math.round(s.cargoTons) })) };
}

// 海路: SeaRoute の GeoJSON。寄港地があれば 出発 → 寄港地 → 到着 の 2 区間に分ける。
// { ports: Map('都道府県/港湾名' → { pref, name, lat, lon }), legs: [{ from, to, shipType, perWeek, sourceRecordId }] }
function readSea(dir) {
  const file = fs.readdirSync(dir).find((f) => /_SeaRoute\.geojson$/.test(f));
  if (!file) throw new Error(`${dir} に *_SeaRoute.geojson がありません`);
  const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const ports = new Map();
  const key = (pref, name) => `${clean(pref)}/${clean(name)}`;
  const put = (pref, name, xy) => { const k = key(pref, name); if (!ports.has(k)) ports.set(k, { key: k, pref: clean(pref), name: clean(name), lat: xy[1], lon: xy[0] }); return k; };
  const raw = data.features.map((f, i) => {
    const p = f.properties; const c = f.geometry.coordinates;
    return { i, from: put(p.S10a_108, p.S10a_109, c[0]), to: put(p.S10a_112, p.S10a_113, c[c.length - 1]), via: p.S10a_111 ? key(p.S10a_110, p.S10a_111) : null,
      shipType: p.S10a_114, perWeek: num(p.S10a_126), distanceKm: num(p.S10a_115) || null };
  });
  const legs = [];
  for (const r of raw) {
    const id = `SeaRoute-${r.i + 1}`;
    if (r.via && ports.has(r.via) && r.via !== r.from && r.via !== r.to) {
      legs.push({ from: r.from, to: r.via, shipType: r.shipType, perWeek: r.perWeek, sourceRecordId: `${id}-1` });
      legs.push({ from: r.via, to: r.to, shipType: r.shipType, perWeek: r.perWeek, sourceRecordId: `${id}-2` });
    } else if (r.from !== r.to) {
      legs.push({ from: r.from, to: r.to, shipType: r.shipType, perWeek: r.perWeek, distanceKm: r.distanceKm, sourceRecordId: id });
    }
  }
  return { ports, legs };
}

module.exports = { readAir, readSea, AIRPORT_CODES, HELIPORTS, SEA_SOURCE, AIR_SOURCE, clean };
