'use strict';
// 湖・貯水池の形(画面が薄い水色で塗る)を、国土数値情報 湖沼データ(W09、2005 年、商用可)から public/data/water.json に入れる。
// 何度実行しても同じ結果になる。拠点は作らない(占領する町・字の「琵琶湖」などは tools/import-towns.js)。
//
// 使い方:
//   node tools/import-water.js <W09-05-g.xml のパス>
//
// water.json には、国勢調査の小地域から作った湖・湾の形(tools/import-towns.js が書く)も入っている。
// 湖沼データに同じ名前の湖があれば、そちらの形を使う(国勢調査の区画は一部の市の水面しか切り出していないため。琵琶湖は 4 市分だけ)
const fs = require('fs');
const path = require('path');

const [, , xmlPath] = process.argv;
if (!xmlPath) { console.error('使い方: node tools/import-water.js <W09-05-g.xml>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const WATER_FILE = path.join(ROOT, 'public', 'data', 'water.json');
const SOURCE = 'src-ksj-w09-2005';
const TODAY = new Date().toISOString().slice(0, 10);
const TOLERANCE = 0.0005; // 約 50 m で間引く(全国の湖を 1 ファイルで配るので軽くする)
const MIN_AREA_KM2 = 0.1; // これより小さい池は塗らない(縮小した地図では見えず、ファイルが大きくなるだけ)
const ringAreaKm2 = (ring) => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]); const lat = (ring[0][1] * Math.PI) / 180; return Math.abs(a / 2) * 111 * 111 * Math.cos(lat); };

const xml = fs.readFileSync(xmlPath, 'utf8');

// 線(Curve): id → [経度, 緯度, …]
const curves = new Map();
for (const m of xml.matchAll(/<gml:Curve gml:id="([^"]+)">[\s\S]*?<gml:posList>([^<]*)<\/gml:posList>/g)) {
  const v = m[2].trim().split(/\s+/).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < v.length; i += 2) pts.push(v[i + 1], v[i]); // GML は 緯度 経度 の順
  curves.set(m[1], pts);
}
// 向きつきの線(OrientableCurve): id → { base, reverse }
const oriented = new Map();
for (const m of xml.matchAll(/<gml:OrientableCurve gml:id="([^"]+)" orientation="([+-])">\s*<gml:baseCurve xlink:href="#([^"]+)"/g)) oriented.set(m[1], { base: m[3], reverse: m[2] === '-' });
// 面(Surface): id → [輪, …](外側と内側の輪。内側は島)
const ringOf = (body) => {
  const pts = [];
  for (const r of body.matchAll(/<gml:curveMember xlink:href="#([^"]+)"\/>/g)) {
    const o = oriented.get(r[1]);
    const c = o ? curves.get(o.base) : curves.get(r[1]);
    if (!c) continue;
    const seg = [];
    for (let i = 0; i < c.length; i += 2) seg.push([c[i], c[i + 1]]);
    if (o && o.reverse) seg.reverse();
    for (const p of seg) { const last = pts[pts.length - 1]; if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p); }
  }
  return pts;
};
const surfaces = new Map();
for (const m of xml.matchAll(/<gml:Surface gml:id="([^"]+)">([\s\S]*?)<\/gml:Surface>/g)) {
  const rings = [];
  for (const ring of m[2].matchAll(/<gml:(exterior|interior)>([\s\S]*?)<\/gml:\1>/g)) { const pts = ringOf(ring[2]); if (pts.length >= 4) rings.push(pts); }
  surfaces.set(m[1], rings);
}

function simplify(ring, tol) { // Douglas-Peucker。閉じた輪(始点 = 終点)では始点からの距離で見る
  const n = ring.length;
  if (n <= 4) return ring;
  const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let far = -1, fd = 0;
    for (let i = a + 1; i < b; i++) { const px = ring[i][0] - ax, py = ring[i][1] - ay; const d = len > 1e-12 ? Math.abs(dy * px - dx * py) / len : Math.hypot(px, py); if (d > fd) { fd = d; far = i; } }
    if (far >= 0 && fd > tol) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return ring.filter((_, i) => keep[i]).map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]); // 小数 4 桁(約 10 m)
}

// 湖(Lake): 名前・面・市区町村コード
const lakes = [];
for (const m of xml.matchAll(/<ksj:Lake gml:id="([^"]+)">([\s\S]*?)<\/ksj:Lake>/g)) {
  const body = m[2];
  const surf = (/<ksj:bounds xlink:href="#([^"]+)"/.exec(body) || [])[1];
  const name = ((/<ksj:lakeName>([^<]*)<\/ksj:lakeName>/.exec(body) || [])[1] || '').trim();
  const rings = (surfaces.get(surf) || []).map((r) => simplify(r, TOLERANCE)).filter((r) => r.length >= 4);
  if (!rings.length || ringAreaKm2(rings[0]) < MIN_AREA_KM2) continue;
  lakes.push({ id: `w09-${m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: name || '(名前の無い湖沼)', kind: 'lake', src: SOURCE, polys: rings });
}

// 国勢調査から作った形は、同じ名前の湖が湖沼データに無いもの(湾など)だけ残す
const base = (s) => s.replace(/\(.*\)$/, '').replace(/^.*町(?=.+湖$)/, '').replace(/ヶ/g, 'ケ'); // 「霞ヶ浦」と「霞ケ浦」は同じ // 「琵琶湖(大津市)」→「琵琶湖」、「三ヶ日町浜名湖」→「浜名湖」
const w09Names = new Set(lakes.map((l) => base(l.name)));
const prev = fs.existsSync(WATER_FILE) ? JSON.parse(fs.readFileSync(WATER_FILE, 'utf8')) : { water: [] };
const census = (prev.water || []).filter((w) => w.src !== SOURCE && !w.id.startsWith('w09-')).map((w) => ({ ...w, src: w.src || 'src-estat-boundary-2020' }));
const keptCensus = census.filter((w) => !w09Names.has(base(w.name)));
const water = [...lakes, ...keptCensus].sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(WATER_FILE, JSON.stringify({ schema: 'pc.water/1', updatedAt: TODAY,
  note: '湖・湾の形。湖沼は国土数値情報 湖沼データ(W09、2005 年)、湾などは国勢調査 2020 年 小地域境界の水面の区画。約 20〜30 m で間引いたもの。画面が薄い水色で塗る', water }));
const pts = water.reduce((s, w) => s + w.polys.reduce((t, r) => t + r.length, 0), 0);
console.log(`湖沼データ: 湖 ${lakes.length} 件(線 ${curves.size}、面 ${surfaces.size})。国勢調査の形 ${census.length} 件のうち ${keptCensus.length} 件を残した(${keptCensus.map((w) => w.name).join('、')})`);
console.log(`public/data/water.json: ${water.length} 件、${pts} 点、${(fs.statSync(WATER_FILE).size / 1024).toFixed(0)} KB`);
const biwa = lakes.find((l) => l.name === '琵琶湖');
console.log(biwa ? `琵琶湖: 輪 ${biwa.polys.length}、点 ${biwa.polys.reduce((t, r) => t + r.length, 0)}` : '琵琶湖が見つからない');
