'use strict';
// 47 都道府県の庁舎をそろえる(2026-10-19 決定: 都道府県庁舎は Lv400)。名所の候補一覧(docs/landmarks/candidates.csv)に無い県の庁舎を
// Wikidata で名前から探し、docs/landmarks/extra.csv(同じ列。採否 ○)に書く。import-landmarks.js が候補一覧と一緒に読む。
//
// 使い方: node tools/fetch-pref-offices.js <N03 の GeoJSON が入ったフォルダ>
const fs = require('fs');
const path = require('path');
const https = require('https');

const [, , n03Dir] = process.argv;
if (!n03Dir) { console.error('使い方: node tools/fetch-pref-offices.js <N03 フォルダ>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const CSV = path.join(ROOT, 'docs/landmarks/candidates.csv');
const EXTRA = path.join(ROOT, 'docs/landmarks/extra.csv');
const UA = 'PacketConquest/0.1 (prefectural offices; https://github.com/ymysx253/packet-conquest)';

const sparql = (q) => new Promise((res, rej) => {
  https.get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeout: 60000 }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => (b += c)); r.on('end', () => { if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode)); res(JSON.parse(b).results.bindings); });
  }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const point = (v) => { const m = /Point\(([-0-9.]+) ([-0-9.]+)\)/.exec(v || ''); return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null; };

// 行政区域(位置から市区町村名)
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const regionByCode = new Map(R.regions.filter((r) => r.kind === 'city' && r.code).map((r) => [r.code.split('-').pop(), r]));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /^N03-[0-9]{8}_[0-9]{2}\.geojson$/.test(e.name) ? [path.join(d, e.name)] : []));
const rings = [];
for (const f of walk(n03Dir)) for (const ft of JSON.parse(fs.readFileSync(f, 'utf8')).features) {
  const code = ft.properties.N03_007; if (!code) continue;
  for (const poly of ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates) {
    const ring = poly[0]; const bb = [180, 90, -180, -90];
    for (const [x, y] of ring) { if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; }
    rings.push({ code, ring, bb });
  }
}
const pir = ([x, y], ring) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
const regionAt = (p) => { const h = rings.find((r) => p.lon >= r.bb[0] && p.lon <= r.bb[2] && p.lat >= r.bb[1] && p.lat <= r.bb[3] && pir([p.lon, p.lat], r.ring)); return h ? regionByCode.get(h.code) || null : null; };

(async () => {
  // すでに拠点になっている庁舎(名所の一覧で取り込み済み、または手作り)と、一覧にある庁舎
  const nodes = R.regions.filter((r) => r.nodeFile).flatMap((r) => JSON.parse(fs.readFileSync(path.join(DATA, `${r.nodeFile}.json`), 'utf8')).nodes);
  const hasOffice = new Set(nodes.filter((n) => n.genre === 'government' && /(都|道|府|県)庁/.test(n.name)).map((n) => n.region.split('-')[0]));
  const csv = fs.readFileSync(CSV, 'utf8').replace(/^﻿/, '').split('\n');
  const header = csv[0];
  const prefs = R.regions.filter((r) => r.kind === 'state');
  const out = [];
  for (const pref of prefs) {
    if (hasOffice.has(pref.id)) continue;
    // 名前の候補: 「青森県庁舎」「青森県庁」「北海道庁舎」など
    const names = [`${pref.name}庁舎`, `${pref.name}庁`, `${pref.name}本庁舎`];
    let found = null;
    for (const nm of names) {
      const rows = await sparql(`SELECT ?item ?c ?sl WHERE { ?item rdfs:label "${nm}"@ja; wdt:P625 ?c; wikibase:sitelinks ?sl. } LIMIT 3`);
      await wait(400);
      const r = rows.map((x) => ({ qid: x.item.value.split('/').pop(), ...point(x.c.value), sl: Number(x.sl.value) })).find((x) => x.lat);
      if (r) { found = { ...r, name: nm }; break; }
    }
    if (!found) { console.log(`見つからない: ${pref.name}`); continue; }
    const region = regionAt(found);
    if (!region) { console.log(`市区町村が引けない: ${pref.name} ${found.name}`); continue; }
    out.push([pref.name, region.name, found.name, '庁舎', 'government', '都道府県庁舎', '可', '○', '○', '', '', '', found.sl, found.qid, found.lat.toFixed(5), found.lon.toFixed(5), '○'].join(','));
    console.log(`${pref.name}: ${found.name}(${found.qid}、${region.name})`);
  }
  fs.writeFileSync(EXTRA, '﻿' + [header, ...out].join('\n') + '\n');
  console.log(`docs/landmarks/extra.csv: ${out.length} 件(すでに庁舎がある都道府県 ${hasOffice.size})`);
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
