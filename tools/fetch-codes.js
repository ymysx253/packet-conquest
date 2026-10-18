'use strict';
// 空港・港の拠点に国際的な識別コードを付ける(docs/DATA-FORMAT.md 第 4 章)。何度実行しても同じ結果になる。
//   IATA(P238)・ICAO(P239)・UN/LOCODE(P1937)を Wikidata(CC0)から引き、codes に書く。
//   世界展開のとき、協力企業や公的データの航路をこのコードで拠点に結びつける。
//   Wikidata の id が無い手作りの拠点は、IATA で引いた空港の Wikidata の id も付ける(KNOWN_IATA)。
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA = path.join(__dirname, '..', 'server/map/data');
const UA = 'PacketConquest/0.1 (gateway codes; https://github.com/ymysx253/packet-conquest)';
const KNOWN_IATA = { haneda: 'HND' }; // 手作りの拠点 id → IATA
const FORMATS = { iata: /^[A-Z0-9]{3}$/, icao: /^[A-Z0-9]{4}$/, unlocode: /^[A-Z]{2}[A-Z2-9]{3}$/ };

function sparql(query) {
  return new Promise((resolve, reject) => {
    const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeout: 120000 }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(body).results.bindings); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}

const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
function writeList(headObj, key, items, groupKey) {
  let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`); let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
}

(async () => {
  const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
  const files = R.regions.filter((x) => x.nodeFile).map((r) => {
    const file = path.join(DATA, `${r.nodeFile}.json`);
    return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  });
  const gw = files.flatMap((f) => f.data.nodes.filter((n) => n.genre === 'airport' || n.genre === 'port'));
  const qids = [...new Set(gw.map((n) => n.codes && n.codes.wikidata).filter(Boolean))];

  const codes = new Map(); // QID → { iata, icao, unlocode }
  const put = (q, k, v) => { if (!v || !FORMATS[k].test(v)) return; const c = codes.get(q) || {}; (c[k] = c[k] || []).push(v); codes.set(q, c); };
  for (let i = 0; i < qids.length; i += 150) {
    const vals = qids.slice(i, i + 150).map((q) => `wd:${q}`).join(' ');
    const b = await sparql(`SELECT ?item ?iata ?icao ?locode WHERE { VALUES ?item { ${vals} } OPTIONAL { ?item wdt:P238 ?iata } OPTIONAL { ?item wdt:P239 ?icao } OPTIONAL { ?item wdt:P1937 ?locode } }`);
    for (const x of b) {
      const q = x.item.value.split('/').pop();
      put(q, 'iata', x.iata && x.iata.value); put(q, 'icao', x.icao && x.icao.value); put(q, 'unlocode', x.locode && x.locode.value);
    }
  }
  // 手作りの拠点: IATA から Wikidata の id を引く
  const byIata = new Map();
  const iatas = Object.values(KNOWN_IATA);
  if (iatas.length) {
    const b = await sparql(`SELECT ?item ?iata ?icao WHERE { VALUES ?iata { ${iatas.map((c) => `"${c}"`).join(' ')} } ?item wdt:P238 ?iata ; wdt:P17 wd:Q17 . OPTIONAL { ?item wdt:P239 ?icao } }`);
    for (const x of b) {
      const q = x.item.value.split('/').pop();
      byIata.set(x.iata.value, q); put(q, 'iata', x.iata.value); put(q, 'icao', x.icao && x.icao.value);
    }
  }

  let changed = 0; const conflicts = [];
  const tally = { iata: 0, icao: 0, unlocode: 0 };
  for (const f of files) {
    let dirty = false;
    for (const n of f.data.nodes) {
      if (n.genre !== 'airport' && n.genre !== 'port') continue;
      let q = n.codes && n.codes.wikidata;
      if (!q && KNOWN_IATA[n.id]) q = byIata.get(KNOWN_IATA[n.id]);
      if (!q) continue;
      const c = codes.get(q) || {};
      const next = { ...(n.codes || {}), wikidata: q };
      for (const k of ['iata', 'icao', 'unlocode']) {
        const vs = [...new Set(c[k] || [])];
        if (vs.length > 1) { conflicts.push(`${n.name} ${k}: ${vs.join('/')}`); continue; } // 値が割れているものは書かない(人が確かめる)
        if (vs.length === 1) { next[k] = vs[0]; tally[k]++; }
      }
      const order = ['iata', 'icao', 'unlocode', 'wikidata', 'ext'];
      const sorted = Object.fromEntries(order.filter((k) => next[k] !== undefined).map((k) => [k, next[k]]));
      if (JSON.stringify(sorted) !== JSON.stringify(n.codes || {})) { n.codes = sorted; dirty = true; changed++; }
    }
    if (dirty) {
      const { nodes, ...head } = f.data;
      fs.writeFileSync(f.file, writeList(head, 'nodes', nodes, 'area'));
    }
  }
  console.log(`空港・港 ${gw.length} 件、コードを書き換えた ${changed} 件(IATA ${tally.iata}、ICAO ${tally.icao}、UN/LOCODE ${tally.unlocode})`);
  if (conflicts.length) console.log('値が割れていて書かなかったもの:\n  ' + conflicts.join('\n  '));
})().catch((e) => { console.error(e); process.exit(1); });
