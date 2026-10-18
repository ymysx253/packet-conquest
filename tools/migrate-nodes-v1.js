'use strict';
// 拠点マスターを形式 pc.nodes/1(docs/DATA-FORMAT.md 第 4 章)に移す。何度実行しても同じ結果になる。
//   - ファイルの見出しに schema と defaultSource(駅のファイルなので src-ksj-n02-2025)
//   - wikidata → codes.wikidata。名所・離島の拠点(lm- / isl-)の出典は src-wikidata、東京の手作りの拠点は src-internal
//   - 空港・港に gateway(type、scope、hub)
//   - 拠点の中の routes は持たない(航路は server/map/data/routes/ に置く)
const fs = require('fs');
const path = require('path');
const { HUB_AIRPORTS } = require('./gateway');

const DATA = path.join(__dirname, '..', 'server/map/data');
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
function writeList(headObj, key, items, groupKey) {
  let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`); let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
}
const gatewayOf = (n) => (n.genre === 'airport' || n.genre === 'port')
  ? { type: n.genre, scope: n.genre === 'airport' && HUB_AIRPORTS.has(n.name) ? 'international' : 'domestic', ...(n.genre === 'airport' && HUB_AIRPORTS.has(n.name) ? { hub: true } : {}) }
  : undefined;

let files = 0, moved = 0, gw = 0;
for (const r of R.regions.filter((x) => x.nodeFile)) {
  const file = path.join(DATA, `${r.nodeFile}.json`);
  const T = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { nodes, ...head } = T;
  const headObj = { schema: 'pc.nodes/1', ...head, defaultSource: 'src-ksj-n02-2025' };
  delete headObj.sources; // 出典は台帳(sources.json)に移した
  const list = nodes.map((n) => {
    const { wikidata, routes, ...rest } = n;
    const out = { ...rest };
    if (wikidata || (n.codes && n.codes.wikidata)) { out.codes = { ...(n.codes || {}), wikidata: wikidata || n.codes.wikidata }; moved += wikidata ? 1 : 0; }
    if (/^(lm|isl)-/.test(n.id)) out.src = 'src-wikidata';
    else if (!/^st-/.test(n.id)) out.src = 'src-internal';
    const g = gatewayOf(n);
    if (g) { out.gateway = g; gw++; }
    return out;
  });
  fs.writeFileSync(file, writeList(headObj, 'nodes', list, 'area'));
  files++;
}
console.log(`移した: ${files} ファイル、wikidata → codes.wikidata ${moved} 件、gateway を付けた ${gw} 件`);
