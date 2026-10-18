'use strict';
// 町・字(ジャンル town)を拠点マスターに入れる(2026-10-18 決定。docs/GENRE.md、docs/PLACES.md)。何度実行しても同じ結果になる。
//
// 使い方:
//   node tools/import-towns.js <e-Stat 小地域境界データ(GML)のフォルダ>
//   フォルダには r2kaNN.gml(都道府県ごと。国勢調査 2020 年 小地域(町丁・字等)、世界測地系緯度経度)を置く。複数の都道府県をまとめて渡せる
//
// 順番: import-stations → import-landmarks → import-islands → import-gateways → **import-towns** → fetch-codes → import-links → import-routes
//
// 決まり(2026-10-18 ユーザー決定):
//   - 丁目は分けない。「銀座一丁目」〜「銀座八丁目」は「銀座」1 つ(市区町村コード + 町の番号 KIHON1 でまとめる)
//   - 同じ町の番号に名前の違う字がまとまっているときは、名前の先頭の共通部分(「大字平井谷の入」「大字平井本宿」→「平井」)。共通部分が無ければ字ごとに分ける
//   - 占領できる(ハック可)。基礎レベル Lv1。地域の支配の数に入る。開始地点にも選べる
//   - 線は、境界が接している町・字どうし(borders)と、町・字の中にある駅・名所(contains)。つなぐのは tools/import-links.js
//   - 水面・河川敷は入れない。米軍・自衛隊の基地、皇居、立ち入りが制限された島は非公開(status: hidden)で入れる
//   - id は tw-<市区町村コード 5 桁>-<まとめた区画のうち最小の小地域コード 6 桁>(国勢調査のコードから決まるので、入れ直しても変わらない)
const fs = require('fs');
const path = require('path');

const [, , gmlDir] = process.argv;
if (!gmlDir) { console.error('使い方: node tools/import-towns.js <e-Stat 小地域境界データ(GML)のフォルダ>'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const SOURCE = 'src-estat-boundary-2020';
const TODAY = new Date().toISOString().slice(0, 10);
// 入れない区画(名前): 河川敷、湖・水面の扱いのもの
const SKIP_NAME = /河川敷|水面|水域/;
// 非公開にする区画(名前 → 理由)
const HIDE_RULES = [
  { re: /基地|駐屯地|分屯地/, reason: 'military' },      // 米軍・自衛隊の基地・駐屯地(横田基地、朝霞駐屯地 など)
];
// 非公開にする区画(市区町村コード + 名前 → 理由)
const HIDE_TOWNS = { '13101|千代田': 'restricted' };     // 皇居(皇居の居住区画は扱わない。PLACES.md 第 3 章)
// 立ち入りが制限された島(硫黄島・南鳥島・沖ノ鳥島) [南, 北, 西, 東]
const RESTRICTED = [[24.72, 24.82, 141.26, 141.37], [24.27, 24.31, 153.96, 154.0], [20.4, 20.45, 136.04, 136.1]];

const distKm = (a, b) => { const r = (d) => (d * Math.PI) / 180; const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2; return 6371 * 2 * Math.asin(Math.sqrt(h)); };
const get = (f, k) => { const m = new RegExp(`<fme:${k}>([^<]*)</fme:${k}>`).exec(f); return m ? m[1] : ''; };

// ---------- 読む ----------
const files = fs.readdirSync(gmlDir).filter((f) => /^r2ka[0-9]{2}\.gml$/.test(f)).sort();
if (!files.length) { console.error(`${gmlDir} に r2kaNN.gml がありません`); process.exit(1); }
const feats = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(gmlDir, f), 'utf8');
  for (const m of text.matchAll(/<fme:r2ka[0-9]{2} [\s\S]*?<\/fme:r2ka[0-9]{2}>/g)) {
    const x = m[0];
    if (get(x, 'HCODE') !== '8101') continue; // 8154 は水面
    const rings = [...x.matchAll(/<gml:(exterior|interior)>[\s\S]*?<gml:posList>([^<]*)<\/gml:posList>/g)].map((r) => {
      const v = r[2].trim().split(/\s+/).map(Number); const pts = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i + 1], v[i]]); // GML は 緯度 経度 の順 → [経度, 緯度]
      return { hole: r[1] === 'interior', pts };
    });
    feats.push({ pref: get(x, 'PREF'), city: get(x, 'CITY'), cityName: get(x, 'CITY_NAME'), sArea: get(x, 'S_AREA'), kihon1: get(x, 'KIHON1'),
      name: get(x, 'S_NAME'), area: Number(get(x, 'AREA')) || 0, jinko: Number(get(x, 'JINKO')) || 0,
      lon: Number(get(x, 'X_CODE')), lat: Number(get(x, 'Y_CODE')), rings });
  }
}

// ---------- 町・字にまとめる ----------
// 「銀座一丁目」→「銀座」、「百合ケ丘一丁目大原」→「百合ケ丘」(丁目のあとに字の名前が続く形もある)。
// 名前そのものが「壱丁目」のような町(上尾市など)は、取り除くと空になるのでそのまま残す
const stripChome = (s) => { const t = s.replace(/[一二三四五六七八九十〇壱弐参]+丁目.*$/, ''); return t || s; };
// 名前を整える: 先頭の「大字」「字」は含めない。「有馬(第一)」「金井(上ノ町)」のような括弧の区分は取ってまとめる。
// 「奥山,大字押戸」のように 2 つの字を並べたものは「奥山・押戸」。括弧だけの名前(「(陸上自衛隊朝霞駐屯地)」)は括弧を外す
const stripOaza = (s) => {
  const t = s.replace(/[,，、]\s*(大字|字)?/g, '・').replace(/^(大字|字)/, '');
  const p = t.replace(/[（(].*$/, '').trim();
  return p || t.replace(/^[（(]|[）)]$/g, '');
};
const commonPrefix = (list) => { let p = list[0] || ''; for (const s of list) while (p && !s.startsWith(p)) p = p.slice(0, -1); return p; };
// 名前の無い区画: 字の無い村(村全体が 1 区画。利島村・青ヶ島村など)は村の名前で入れる。
// 名前のある区画もある市区町村の、名前の無い切れ端(境界未定地など)と、町の番号が 999 で始まるもの(境界未定・所属未定)は入れない
const namedCity = new Set(feats.filter((f) => f.name).map((f) => `${f.pref}${f.city}`));
const unnamed = feats.filter((f) => (!f.name && namedCity.has(`${f.pref}${f.city}`)) || /^999/.test(f.kihon1));
for (const f of unnamed) feats.splice(feats.indexOf(f), 1);
const byKihon = new Map();
for (const f of feats) { const k = `${f.pref}${f.city}|${f.kihon1}`; if (!byKihon.has(k)) byKihon.set(k, []); byKihon.get(k).push(f); }
const towns = []; // { key, code5, cityName, name, feats }
for (const [k, list] of byKihon) {
  const code5 = k.split('|')[0];
  const names = [...new Set(list.map((f) => stripChome(stripOaza(f.name))))];
  let groups;
  if (names.length <= 1) groups = [{ name: names[0] || '', feats: list }];
  else {
    const p = commonPrefix(names).replace(/[（(・]$/, '').replace(/字$/, '');
    if (p.length >= 2) groups = [{ name: p, feats: list }];
    else { // 共通部分が無い: 字ごとに分ける
      const m = new Map();
      for (const f of list) { const n = stripChome(stripOaza(f.name)); if (!m.has(n)) m.set(n, []); m.get(n).push(f); }
      groups = [...m].map(([name, fs2]) => ({ name, feats: fs2 }));
    }
  }
  for (const g of groups) towns.push({ code5, cityName: list[0].cityName, name: g.name || list[0].cityName, feats: g.feats });
}
// 丁目ごとに町の番号が分かれていることがある(守谷市 百合ケ丘 など)。同じ市区町村で同じ名前の町はまとめる
{
  const merged = new Map();
  for (const t of towns) {
    const k = `${t.code5}|${t.name}`;
    if (merged.has(k)) merged.get(k).feats.push(...t.feats); else merged.set(k, t);
  }
  towns.length = 0; towns.push(...merged.values());
}

// ---------- 地域・既存の拠点 ----------
const R = JSON.parse(fs.readFileSync(path.join(DATA, 'regions.json'), 'utf8'));
const regionByCode = new Map(R.regions.filter((r) => r.kind === 'city' && r.code).map((r) => [r.code.split('-').pop(), r]));
const nodeFiles = new Map();
for (const r of R.regions.filter((x) => x.nodeFile)) nodeFiles.set(r.id, { file: path.join(DATA, `${r.nodeFile}.json`), T: JSON.parse(fs.readFileSync(path.join(DATA, `${r.nodeFile}.json`), 'utf8')) });
const prefsInData = new Set(feats.map((f) => f.pref));
const others = []; // 町・字以外の拠点(contains と 25 m の判定に使う)
for (const [pid, { T }] of nodeFiles) {
  T.nodes = T.nodes.filter((n) => n.genre !== 'town' || !prefsInData.has(n.id.slice(3, 5))); // 今回の都道府県の町・字は入れ直す
  for (const n of T.nodes) if (n.genre !== 'town') others.push(n);
}

// ---------- 点と線 ----------
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inTown = (p, t) => {
  if (p.lon < t.bb[0] || p.lon > t.bb[2] || p.lat < t.bb[1] || p.lat > t.bb[3]) return false;
  return t.feats.some((f) => f.rings.some((r) => !r.hole && pointInRing([p.lon, p.lat], r.pts)) && !f.rings.some((r) => r.hole && pointInRing([p.lon, p.lat], r.pts)));
};
for (const t of towns) {
  const bb = [180, 90, -180, -90];
  for (const f of t.feats) for (const r of f.rings) for (const [x, y] of r.pts) { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); }
  t.bb = bb;
  const main = t.feats.slice().sort((a, b) => b.area - a.area)[0]; // 代表点はいちばん広い区画の代表点(区画の中にある点)
  t.lat = main.lat; t.lon = main.lon;
  t.sArea = t.feats.map((f) => f.sArea).sort()[0];
  t.id = `tw-${t.code5}-${t.sArea}`;
  t.region = regionByCode.get(t.code5) || null;
  t.jinko = t.feats.reduce((s, f) => s + f.jinko, 0);
}

// ---------- 入れる・入れない・非公開 ----------
const report = { skipped: [], hidden: [], noRegion: [], moved: 0 };
const keep = [];
for (const t of towns) {
  if (SKIP_NAME.test(t.name)) { report.skipped.push(`${t.cityName} ${t.name}`); continue; }
  if (!t.region) { report.noRegion.push(`${t.code5} ${t.cityName} ${t.name}`); continue; }
  const rule = HIDE_RULES.find((x) => x.re.test(t.name));
  t.hidden = HIDE_TOWNS[`${t.code5}|${t.name}`] || (rule && rule.reason) || (RESTRICTED.some(([s, n, w, e]) => t.lat >= s && t.lat <= n && t.lon >= w && t.lon <= e) ? 'restricted' : null);
  if (t.hidden) report.hidden.push(`${t.cityName} ${t.name}(${t.hidden})`);
  keep.push(t);
}

// 名前: 同じ都道府県で名前が重なる町・字、または既存の拠点と同じ名前なら「(市区町村名)」を付ける
const nameCount = new Map();
for (const t of keep) { const k = `${t.code5.slice(0, 2)}|${t.name}`; nameCount.set(k, (nameCount.get(k) || 0) + 1); }
const existingNames = new Set(others.map((n) => `${n.region.split('-')[0]}|${n.name}`));
for (const t of keep) {
  const dup = nameCount.get(`${t.code5.slice(0, 2)}|${t.name}`) > 1 || existingNames.has(`${t.region.parent}|${t.name}`);
  t.display = dup ? `${t.name}(${t.region.name})` : t.name;
}
// 同じ市区町村の中でも重なる(字ごとに分けたもの)ときは小地域コードで区別
const seenName = new Map();
for (const t of keep) { const k = `${t.region.parent}|${t.display}`; const c = (seenName.get(k) || 0) + 1; seenName.set(k, c); if (c > 1) t.display = `${t.display}(${t.sArea})`; }

// 既存の拠点から 25 m 以内なら、代表点を少しずらす(同じ場所の二重登録を避ける。テストの決まり)
const placed = [...others]; // 既存の拠点と、先に置いた町・字
const near25 = (p) => placed.find((n) => n !== p && Math.abs(n.lat - p.lat) < 0.001 && Math.abs(n.lon - p.lon) < 0.0012 && distKm(n, p) < 0.025);
for (const t of keep) {
  let tries = 0;
  while (near25(t) && tries < 8) { const ang = (tries * Math.PI) / 4; t.lat += 0.0004 * Math.cos(ang); t.lon += 0.0005 * Math.sin(ang); tries++; }
  if (tries) report.moved++;
  placed.push(t);
}

// 境界が接している町・字(同じ辺を持つ区画どうし)。公開の町・字だけ
const edgeOwner = new Map();
const key = (a, b) => { const s = `${a[0].toFixed(7)},${a[1].toFixed(7)}`, e = `${b[0].toFixed(7)},${b[1].toFixed(7)}`; return s < e ? `${s}|${e}` : `${e}|${s}`; };
const pub = keep.filter((t) => !t.hidden);
for (const t of pub) for (const f of t.feats) for (const r of f.rings) for (let i = 0; i + 1 < r.pts.length; i++) {
  const k = key(r.pts[i], r.pts[i + 1]);
  const s = edgeOwner.get(k); if (!s) edgeOwner.set(k, new Set([t.id])); else s.add(t.id);
}
const borders = new Map(pub.map((t) => [t.id, new Set()]));
for (const s of edgeOwner.values()) if (s.size > 1) for (const a of s) for (const b of s) if (a !== b) borders.get(a).add(b);

// 町・字の中にある駅・名所(公開・ハック可)
const contains = new Map(pub.map((t) => [t.id, []]));
for (const n of others) {
  if (n.hackable === false || n.status === 'hidden' || n.isPlayerNode) continue;
  const cands = pub.filter((t) => n.lon >= t.bb[0] && n.lon <= t.bb[2] && n.lat >= t.bb[1] && n.lat <= t.bb[3]);
  const t = cands.find((x) => inTown(n, x));
  if (t) contains.get(t.id).push(n.id);
}

// ---------- 書き込む ----------
let added = 0;
for (const t of keep) {
  const f = nodeFiles.get(t.region.parent);
  if (!f) { report.noRegion.push(`${t.code5} ${t.name}: 都道府県のファイルが無い`); continue; }
  if (!f.T.kinds.TOWN) f.T.kinds.TOWN = '町・字';
  if (Array.isArray(f.T.genres) && !f.T.genres.includes('town')) f.T.genres.push('town');
  const node = { id: t.id, name: t.display, genre: 'town', kind: 'TOWN', area: t.region.name, region: t.region.id, lat: Number(t.lat.toFixed(5)), lon: Number(t.lon.toFixed(5)), level: 1, value: 1,
    codes: { ext: [{ scheme: SOURCE, value: `${t.code5}${t.sArea}` }] }, src: SOURCE };
  if (t.hidden) { node.status = 'hidden'; node.hiddenReason = t.hidden; }
  else {
    const b = [...borders.get(t.id)].sort(); const c = contains.get(t.id).sort();
    if (b.length) node.borders = b;
    if (c.length) node.contains = c;
  }
  f.T.nodes.push(node); added++;
}
const order = Object.fromEntries(R.regions.map((r, i) => [r.id, i]));
const rank = (n) => (n.genre === 'station' ? 2 : n.genre === 'town' ? 1 : 0); // 名所 → 町・字 → 駅 の順に並べる
const oneLine = (o) => '    ' + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
const writeList = (headObj, k, items, groupKey) => {
  let out = JSON.stringify(headObj, null, 2).replace(/\n}$/, `,\n  "${k}": [\n`); let prev = null;
  out += items.map((it) => { const gap = prev && prev !== it[groupKey] ? '\n' : ''; prev = it[groupKey]; return gap + oneLine(it); }).join(',\n');
  return out + '\n  ]\n}\n';
};
for (const { file, T } of nodeFiles.values()) {
  const before = fs.readFileSync(file, 'utf8');
  T.nodes = T.nodes.map((nd, i) => ({ nd, i })).sort((a, b) => (order[a.nd.region] - order[b.nd.region]) || (rank(a.nd) - rank(b.nd)) || (a.i - b.i)).map((x) => x.nd);
  const { nodes, ...head } = T;
  const text = writeList(head, 'nodes', nodes, 'area');
  if (text !== before) fs.writeFileSync(file, writeList({ ...head, updatedAt: TODAY }, 'nodes', nodes, 'area'));
}
const linked = pub.filter((t) => (borders.get(t.id).size + contains.get(t.id).length) > 0).length;
console.log(`名前の無い切れ端・境界未定で除いた区画 ${unnamed.length}`);
console.log(`町・字: 区画 ${feats.length} → ${towns.length} にまとめ、${added} 件を入れた(公開 ${pub.length}、非公開 ${report.hidden.length})。線のある町・字 ${linked}`);
console.log(`隣の町・字の線(延べ) ${[...borders.values()].reduce((s, x) => s + x.size, 0) / 2} 本、中の駅・名所との線 ${[...contains.values()].reduce((s, x) => s + x.length, 0)} 本、代表点をずらした ${report.moved} 件`);
if (report.hidden.length) console.log('非公開: ' + report.hidden.join('、'));
if (report.skipped.length) console.log('入れなかった(河川敷など): ' + report.skipped.join('、'));
if (report.noRegion.length) console.log('市区町村が引けない: ' + report.noRegion.join('、'));
