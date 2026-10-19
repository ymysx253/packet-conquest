'use strict';
// 拠点のレベルを新しい物差しへ一度だけ移す(2026-10-19 決定。docs/LEVEL-PLAN.md、tools/levels.js)。
// ファイルの見出しに levelScale: 2 を書き、もう移したファイルは飛ばす(何度実行しても同じ結果)。
// 取り込みの道具も同じ物差しに直してあるので、取り込み直したときも同じレベルになる。町・字は import-towns.js が人口で決めるので、ここでは触らない。
//
//   国会議事堂 777 / 東京都庁 600 / 国際線の拠点の空港 500 / 都道府県庁舎(古い Lv15)400 / 各県一の城・塔(古い Lv10)300
//   各県一の空港(古い Lv8)250 / 主要駅(古い Lv4〜5)200 / ほかの空港 150 / 港 30〜70 / 乗り換え駅 30〜99 / ふつうの駅 10 / 名所 15〜70
const fs = require('fs');
const path = require('path');
const { L, FAME_OLD_TO_NEW, stationLevel, terminalOf } = require('./levels');

const DATA = path.join(__dirname, '..', 'server/map/data');
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const fame = (old) => FAME_OLD_TO_NEW[Math.max(1, Math.min(5, old))];

function newLevel(n) {
  const old = n.level;
  const pref = n.region.split('-')[0];
  if (n.genre === 'government') {
    if (n.name === '国会議事堂') return L.NATIONAL_SYMBOL;
    if (n.name === '東京都庁') return L.CAPITAL_SYMBOL;
    if (old >= 15) return L.PREF_OFFICE;
    return fame(old);
  }
  if (n.genre === 'airport') {
    if ((n.gateway && n.gateway.hub) || old >= 10) return L.HUB_AIRPORT;
    if (old >= 8) return L.PREF_TOP_AIRPORT;
    return Math.max(fame(old), L.AIRPORT);
  }
  if (n.genre === 'port') return Math.max(fame(old), L.PORT_MIN);
  if (n.genre === 'station') {
    // 取り込みの式と同じ(主要駅の表 + 乗り入れ路線の数)。古い物差しで主要駅(Lv4 以上)だったものは主要駅のまま
    return old >= 4 ? L.MAIN_STATION : stationLevel((n.lines || []).length, terminalOf(pref, n.name));
  }
  if (n.genre === 'bus_terminal') return L.STATION;
  if ((n.genre === 'heritage' || n.genre === 'tower') && old >= 10) return n.genre === 'tower' ? L.TOWER : L.PREF_TOP_CASTLE;
  if (old >= 8) return L.PREF_TOP_CASTLE; // ほかの象徴的な名所(古い物差しで Lv8 以上)
  return fame(old);
}

const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
function writeList(headObj, key, items, groupKey) {
  let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`); let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
}

let files = 0, changed = 0; const tally = {};
for (const r of R.regions.filter((x) => x.nodeFile)) {
  const file = path.join(DATA, `${r.nodeFile}.json`);
  const T = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (T.levelScale === 2) continue;
  const { nodes, ...head } = T;
  for (const n of nodes) {
    if (n.genre === 'town') continue;
    const lv = newLevel(n);
    const k = `${n.genre}:${n.level}→${lv}`; tally[k] = (tally[k] || 0) + 1;
    if (lv !== n.level || n.value !== lv) { n.level = lv; n.value = lv; changed++; }
  }
  // 見出しの並びは保つ(schema の次あたりに levelScale)
  const headObj = { ...head, levelScale: 2 };
  fs.writeFileSync(file, writeList(headObj, 'nodes', nodes, 'area'));
  files++;
}
console.log(`移した: ${files} ファイル、レベルを変えた拠点 ${changed}`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${k}: ${v}`);
