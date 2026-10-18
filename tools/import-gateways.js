'use strict';
// 航路の端点になる空港・港(玄関口)を拠点マスターに入れる(docs/DATA-FORMAT.md 第 4・5 章)。何度実行しても同じ結果になる。
//
// 使い方:
//   node tools/import-gateways.js <S10a を展開したフォルダ> <N03 の GeoJSON が入ったフォルダ(都道府県ごとの下位フォルダ可)>
//
// 順番: import-stations → import-landmarks → import-islands → **import-gateways** → fetch-codes → import-links → import-routes
// (前の道具は自分の拠点を入れ直すので、この道具が付けた codes.ext はそのあとに付け直す必要がある)
//
// 決まり:
//   - 空港: 定期便があり拠点の無い民間の空港だけを足す(id は ap-<Wikidata の id>)。自衛隊・米軍と共用の飛行場(小松・美保・岩国・百里・丘珠・名古屋)は
//     PLACES.md の「軍・自衛隊は扱わない」に当たるかの判断が要るので足さない(DESIGN.md 第 6 章で未決)
//   - 港: S10a の定期便海上経路に出てくる港。既にある港の拠点(5 km 以内で名前が合う)には出典のコード(codes.ext)だけを付ける。
//     無ければ Wikidata の港の項目(名前が合い 5 km 以内)から pt-<Wikidata の id>、それも無ければ S10a の位置から pt-s<ハッシュ> を作る
//   - 既存の拠点から 25 m 以内には作らない(同じ場所の二重登録)
//   - 北方領土・尖閣・立ち入り制限の島には置かない
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { gatewayLevel } = require('./gateway');
const { readSea, SEA_SOURCE, JOINT_USE } = require('./route-sources');

const [, , s10aDir, n03Dir] = process.argv;
if (!s10aDir || !n03Dir) { console.error('使い方: node tools/import-gateways.js <S10a フォルダ> <N03 フォルダ>'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const UA = 'PacketConquest/0.1 (gateway import; https://github.com/ymysx253/packet-conquest)';
const TODAY = new Date().toISOString().slice(0, 10);

// 定期便があり拠点の無い民間の空港(統計表の名前 → Wikidata)。route-sources.js の AIRPORT_CODES と同じ空港
const ADD_AIRPORTS = { 石垣: 'Q11434817', 但馬: 'Q1931194', 利尻: 'Q1049856', 調布: 'Q970339', 天草: 'Q1073798' };
const PORT_CLASSES = ['Q44782', 'Q1478783', 'Q4303352', 'Q1420027', 'Q15310171'];
const RESTRICTED = [[24.72, 24.82, 141.26, 141.37], [24.27, 24.31, 153.96, 154.0], [20.4, 20.45, 136.04, 136.1], [25.6, 26.1, 123.3, 124.7]];
const NORTHERN_BOX = [43.0, 46.0, 145.4, 149.0]; // 北方領土のおおよその範囲(根室半島の先より東)

const distKm = (a, b) => { const r = (d) => (d * Math.PI) / 180; const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2; return 6371 * 2 * Math.asin(Math.sqrt(h)); };
const levelOf = (sl) => (sl >= 40 ? 5 : sl >= 25 ? 4 : sl >= 15 ? 3 : sl >= 8 ? 2 : 1);
const restricted = (p) => RESTRICTED.some(([s, n, w, e]) => p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e) || (p.lat >= NORTHERN_BOX[0] && p.lat <= NORTHERN_BOX[1] && p.lon >= NORTHERN_BOX[2] && p.lon <= NORTHERN_BOX[3] && p.lon > 145.85);

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
const point = (v) => { const m = /Point\(([-0-9.]+) ([-0-9.]+)\)/.exec(v); return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null; };

// ---------- 地域(N03 の行政区域で位置から市区町村を決める) ----------
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const regionByCode = new Map(R.regions.filter((r) => r.kind === 'city' && r.code).map((r) => [r.code.split('-').pop(), r]));
const prefById = new Map(R.regions.filter((r) => r.kind === 'state').map((r) => [r.id, r]));
const files = new Map();
for (const r of R.regions.filter((x) => x.nodeFile)) files.set(r.id, { file: path.join(DATA, `${r.nodeFile}.json`), T: JSON.parse(fs.readFileSync(path.join(DATA, `${r.nodeFile}.json`), 'utf8')) });

function findN03(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findN03(p));
    else if (/^N03-[0-9]{8}_[0-9]{2}\.geojson$/.test(e.name)) out.push(p);
  }
  return out;
}
const rings = [];
for (const f of findN03(n03Dir)) {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const ft of data.features) {
    const code = ft.properties.N03_007; if (!code) continue;
    const polys = ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates;
    for (const p of polys) {
      const ring = p[0]; const bb = [180, 90, -180, -90];
      for (const [x, y] of ring) { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); }
      rings.push({ ring, bb, code });
    }
  }
}
if (!rings.length) { console.error(`${n03Dir} に N03 の GeoJSON がありません`); process.exit(1); }
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// 陸地の中ならその市区町村。海の上(港の位置は湾の中ほどのことがある)なら 8 km 以内で最も近い陸地の市区町村
function regionAt(p) {
  const deg = 8 / 111;
  let best = null;
  for (const r of rings) {
    if (p.lon < r.bb[0] - deg * 1.3 || p.lon > r.bb[2] + deg * 1.3 || p.lat < r.bb[1] - deg || p.lat > r.bb[3] + deg) continue;
    if (p.lon >= r.bb[0] && p.lon <= r.bb[2] && p.lat >= r.bb[1] && p.lat <= r.bb[3] && pointInRing([p.lon, p.lat], r.ring)) return regionByCode.get(r.code) || null;
    for (let i = 0; i < r.ring.length; i++) { const d = distKm(p, { lon: r.ring[i][0], lat: r.ring[i][1] }); if (d <= 8 && (!best || d < best.d)) best = { d, code: r.code }; }
  }
  return best ? regionByCode.get(best.code) || null : null;
}

(async () => {
  // 前回この道具で入れた拠点(ap- / pt-)と、付けた出典のコードを外す
  const all = [];
  for (const { T } of files.values()) {
    T.nodes = T.nodes.filter((n) => !/^(ap|pt)-/.test(n.id));
    for (const n of T.nodes) {
      if (n.codes && n.codes.ext) {
        n.codes.ext = n.codes.ext.filter((e) => e.scheme !== SEA_SOURCE);
        if (!n.codes.ext.length) delete n.codes.ext;
        if (!Object.keys(n.codes).length) delete n.codes;
      }
      all.push(n);
    }
  }
  const prefOfNode = new Map();
  for (const [pid, { T }] of files) for (const n of T.nodes) prefOfNode.set(n.id, pid);
  const near25 = (p) => all.find((n) => Math.abs(n.lat - p.lat) < 0.001 && Math.abs(n.lon - p.lon) < 0.0012 && distKm(n, p) < 0.025);
  const added = { airport: [], portWd: [], portSrc: [], attached: [], skipped: [] };

  const addNode = (node) => {
    const region = regionAt(node);
    if (!region) { added.skipped.push(`${node.name}: 市区町村が決まらない`); return null; }
    const f = files.get(region.parent);
    if (!f) { added.skipped.push(`${node.name}: 都道府県のファイルが無い(${region.parent})`); return null; }
    const taken = new Set(f.T.nodes.map((n) => n.name));
    let name = node.name; if (taken.has(name)) name = `${node.name}(${region.name})`;
    const full = { ...node, name, area: region.name, region: region.id };
    f.T.nodes.push(full); all.push(full); prefOfNode.set(full.id, region.parent);
    return full;
  };

  // ---------- 空港 ----------
  const qids = Object.values(ADD_AIRPORTS);
  const ab = await sparql(`SELECT ?item ?ja ?c ?sl ?iata ?icao WHERE { VALUES ?item { ${qids.map((q) => `wd:${q}`).join(' ')} } ?item wdt:P625 ?c; wikibase:sitelinks ?sl. ?item rdfs:label ?ja. FILTER(LANG(?ja) = "ja") OPTIONAL { ?item wdt:P238 ?iata } OPTIONAL { ?item wdt:P239 ?icao } }`);
  const haveCode = new Set(all.flatMap((n) => [n.codes && n.codes.iata, n.codes && n.codes.icao].filter(Boolean)));
  const seenQ = new Set();
  for (const r of ab) {
    const q = r.item.value.split('/').pop(); if (seenQ.has(q)) continue; seenQ.add(q);
    const p = point(r.c.value); const iata = r.iata && r.iata.value; const icao = r.icao && r.icao.value;
    if (!p || restricted(p)) continue;
    if ((iata && haveCode.has(iata)) || (icao && haveCode.has(icao))) { added.skipped.push(`${r.ja.value}: 同じコードの拠点がある`); continue; }
    if (near25(p)) { added.skipped.push(`${r.ja.value}: 25 m 以内に拠点がある`); continue; }
    const level = gatewayLevel('airport', r.ja.value, levelOf(Number(r.sl.value)));
    const n = addNode({ id: `ap-${q.toLowerCase()}`, name: r.ja.value, genre: 'airport', kind: 'GW', lat: Number(p.lat.toFixed(5)), lon: Number(p.lon.toFixed(5)), level, value: level,
      codes: { ...(iata ? { iata } : {}), ...(icao ? { icao } : {}), wikidata: q }, src: 'src-wikidata', gateway: { type: 'airport', scope: 'domestic' } });
    if (n) added.airport.push(`${n.name}(${iata || icao})`);
  }

  // ---------- 港 ----------
  const { ports } = readSea(s10aDir);
  const wdPorts = [];
  for (const cls of PORT_CLASSES) {
    const b = await sparql(`SELECT ?item ?ja (SAMPLE(?c) AS ?coord) (MAX(?s) AS ?sl) (SAMPLE(?lc) AS ?locode) WHERE {
  ?item wdt:P31 wd:${cls}; wdt:P17 wd:Q17; wdt:P625 ?c; wikibase:sitelinks ?s. FILTER NOT EXISTS { ?item wdt:P576 [] }
  ?item rdfs:label ?ja. FILTER(LANG(?ja) = "ja") OPTIONAL { ?item wdt:P1937 ?lc }
} GROUP BY ?item ?ja`);
    for (const r of b) { const p = point(r.coord.value); if (p) wdPorts.push({ qid: r.item.value.split('/').pop(), name: r.ja.value, ...p, sitelinks: Number(r.sl.value), locode: r.locode && r.locode.value }); }
  }
  const usedQ = new Set(all.map((n) => n.codes && n.codes.wikidata).filter(Boolean));
  const stem = (s) => s.replace(/(港|漁港|フェリーターミナル|旅客ターミナル)$/, '');
  for (const sp of [...ports.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    if (restricted(sp)) { added.skipped.push(`${sp.key}: 扱わない地域`); continue; }
    if (/韓国|中国|台湾|ロシア/.test(sp.key)) { added.skipped.push(`${sp.key}: 海外の港(国内だけ扱う)`); continue; }
    const ext = { scheme: SEA_SOURCE, value: sp.key };
    // a. 既にある港の拠点(5 km 以内で名前が合う。S10a の位置は湾の中ほどのことがある)
    const have = all.filter((n) => n.genre === 'port' && n.hackable !== false && distKm(n, sp) <= 5 && (stem(n.name).includes(sp.name) || sp.name.includes(stem(n.name))))
      .sort((a, b) => distKm(a, sp) - distKm(b, sp))[0];
    if (have) { have.codes = { ...(have.codes || {}), ext: [...((have.codes || {}).ext || []), ext] }; added.attached.push(`${sp.key} → ${have.name}`); continue; }
    // b. Wikidata の港の項目(名前が合い 5 km 以内)
    const wd = wdPorts.filter((w) => !usedQ.has(w.qid) && distKm(w, sp) <= 5 && (stem(w.name) === sp.name || w.name === `${sp.name}港`))
      .sort((a, b) => b.sitelinks - a.sitelinks || distKm(a, sp) - distKm(b, sp))[0];
    if (wd) {
      const dup = near25(wd);
      if (dup) { added.skipped.push(`${sp.key}: Wikidata の ${wd.name} の 25 m 以内に ${dup.name}`); continue; }
      const level = gatewayLevel('port', wd.name, levelOf(wd.sitelinks));
      const locode = wd.locode && /^[A-Z]{2}[A-Z2-9]{3}$/.test(wd.locode) ? wd.locode : null;
      const n = addNode({ id: `pt-${wd.qid.toLowerCase()}`, name: wd.name, genre: 'port', kind: 'GW', lat: Number(wd.lat.toFixed(5)), lon: Number(wd.lon.toFixed(5)), level, value: level,
        codes: { ...(locode ? { unlocode: locode } : {}), wikidata: wd.qid, ext: [ext] }, src: 'src-wikidata', gateway: { type: 'port', scope: 'domestic' } });
      if (n) { usedQ.add(wd.qid); added.portWd.push(n.name); }
      continue;
    }
    // c. S10a の位置から
    if (near25(sp)) { added.skipped.push(`${sp.key}: 25 m 以内に拠点がある`); continue; }
    // 「前泊(伊平屋)」のように島の名前が括弧で付くものは「前泊港(伊平屋)」にする
    const paren = /^(.+?)[(（](.+)[)）]$/.exec(sp.name);
    const name = paren ? `${paren[1].replace(/港$/, '')}港(${paren[2]})` : (/港$/.test(sp.name) ? sp.name : `${sp.name}港`);
    const level = gatewayLevel('port', name, 1);
    const id = 'pt-s' + crypto.createHash('sha256').update(`${SEA_SOURCE}|${sp.key}`).digest('hex').slice(0, 10);
    const n = addNode({ id, name, genre: 'port', kind: 'GW', lat: Number(sp.lat.toFixed(5)), lon: Number(sp.lon.toFixed(5)), level, value: level,
      codes: { ext: [ext] }, src: SEA_SOURCE, gateway: { type: 'port', scope: 'domestic' } });
    if (n) added.portSrc.push(n.name);
  }

  // ---------- 書き出し ----------
  const order = Object.fromEntries(R.regions.map((r, i) => [r.id, i]));
  const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
  const writeList = (headObj, key, items, groupKey) => {
    let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, `,\n  "${key}": [\n`); let prev = null;
    out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
    return out + '\n  ]\n}\n';
  };
  for (const { file, T } of files.values()) {
    T.nodes = T.nodes.map((nd, i) => ({ nd, i })).sort((a, b) => (order[a.nd.region] - order[b.nd.region]) || ((a.nd.genre === 'station') - (b.nd.genre === 'station')) || (a.i - b.i)).map((x) => x.nd);
    const { nodes, ...headObj } = T;
    const before = fs.readFileSync(file, 'utf8');
    const text = writeList(headObj, 'nodes', nodes, 'area');
    if (text !== before) fs.writeFileSync(file, writeList({ ...headObj, updatedAt: TODAY }, 'nodes', nodes, 'area'));
  }
  console.log(`空港を足した: ${added.airport.length} 件 ${added.airport.join('、')}`);
  console.log(`港を足した: Wikidata から ${added.portWd.length} 件、S10a の位置から ${added.portSrc.length} 件`);
  console.log(`既にある港に S10a のコードを付けた: ${added.attached.length} 件`);
  console.log(`足さなかった共用の飛行場(判断待ち): ${Object.values(JOINT_USE).join('、')}`);
  if (added.skipped.length) console.log(`足さなかったもの ${added.skipped.length} 件:\n  ` + added.skipped.join('\n  '));
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
