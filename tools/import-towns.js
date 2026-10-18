'use strict';
// 町・字(ジャンル town)を拠点マスターに入れる(2026-10-18 決定。docs/GENRE.md、docs/PLACES.md)。何度実行しても同じ結果になる。
//
// 使い方:
//   node tools/import-towns.js <e-Stat 小地域境界データ(GML)のフォルダ> [国土数値情報 N03 の GeoJSON のフォルダ]
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

const [, , gmlDir, n03Dir] = process.argv; // n03Dir(任意): 国土数値情報 N03 の GeoJSON。2020 年以降に変わった市区町村(浜松市の区の再編など)を位置で引くのに使う
if (!gmlDir) { console.error('使い方: node tools/import-towns.js <e-Stat 小地域境界データ(GML)のフォルダ>'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const SOURCE = 'src-estat-boundary-2020';
const TODAY = new Date().toISOString().slice(0, 10);
// 入れない区画(名前): 河川敷、湖・水面の扱いのもの
const SKIP_NAME = /河川敷|水面|水域|無番地/; // 無番地 = 番地の無い国有地などの区画
// 大きな川の水面が 1 つの区画になっているもの(人口 0 のときだけ。同じ名前の陸の町は残す)。
// 細長く、川沿いの町・字を何十もつなぐ線になるので入れない。
// 湖・湾(琵琶湖、霞ヶ浦、浜名湖、中海 など)は入れる(2026-10-19 ユーザー決定: 周りの町と一気につながる要所として面白い)
const WATER_BODY = /(信濃川|天竜川|木曽川|利根川|阿賀野川|最上川|北上川|石狩川|筑後川|吉野川|四万十川|多摩川|荒川|江戸川|淀川|長良川|揖斐川|球磨川|阿武隈川|那珂川|鬼怒川|渡良瀬川|富士川|大井川|相模川)$/;
// 領有をめぐる争いがある地域は、DB に非公開(disputed)で入れる(2026-10-19 ユーザー決定。ゲームでは使わない)。
// 尖閣諸島は国勢調査の小地域(石垣市登野城尖閣)にある。北方領土は小地域に無いので、下で村ごとに入れる。竹島は小地域にも地域マスターにも無い
const DISPUTED_NAME = /尖閣/;
const NORTHERN_VILLAGES = ['01695', '01696', '01697', '01698', '01699', '01700']; // 色丹村・泊村・留夜別村・留別村・紗那村・蘂取村
// 非公開にする区画(名前 → 理由)
const HIDE_RULES = [
  { re: /基地|駐屯地|分屯地|演習場/, reason: 'military' }, // 米軍・自衛隊の基地・駐屯地・演習場(横田基地、朝霞駐屯地、えびの市 浦演習場 など)
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
    // 輪の点は [経度, 緯度, 経度, 緯度, …] の数値の並び(全国で数千万点になるので配列の配列にしない)
    const rings = [...x.matchAll(/<gml:(exterior|interior)>[\s\S]*?<gml:posList>([^<]*)<\/gml:posList>/g)].map((r) => {
      const v = r[2].trim().split(/\s+/);
      const pts = new Float64Array(v.length - (v.length % 2));
      for (let i = 0; i + 1 < v.length; i += 2) { pts[i] = Number(v[i + 1]); pts[i + 1] = Number(v[i]); } // GML は 緯度 経度 の順
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
// 岩手県の「地割」(「崎山第四地割」)も丁目と同じくまとめる(「崎山」)
const stripChome = (s) => { const t = s.replace(/[一二三四五六七八九十〇壱弐参ニ]+丁目.*$/, '').replace(/第[一二三四五六七八九十〇]+地割.*$/, ''); return t || s; };
// 名前を整える: 先頭の「大字」「字」は含めない。「有馬(第一)」「金井(上ノ町)」のような括弧の区分は取ってまとめる。
// 「奥山,大字押戸」のように 2 つの字を並べたものは「奥山・押戸」。括弧だけの名前(「(陸上自衛隊朝霞駐屯地)」)は括弧を外す
const stripOaza = (s) => {
  // 「富田町大字春田」(旧町名 + 大字)は大字のあと(「春田」)を町名にする
  const t = s.replace(/^[^,，、・]+?大字(?=.)/, '').replace(/[,，、]\s*(大字|字)?/g, '・').replace(/^(大字|字)/, '');
  const p = t.replace(/[（(].*$/, '').replace(/[）)]$/, '').trim(); // 開き括弧の無い閉じ括弧(「内山)」)も取る
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

// 国勢調査(2020 年)のあとに変わった市区町村(浜松市の区の再編 2024 年 など)は、コードでは引けないので、
// 町・字の代表点がいまの行政区域(N03)のどれに入るかで決める。N03 のフォルダを渡したときだけ
let n03Rings = null;
function regionAtPoint(p) {
  if (!n03Dir) return null;
  if (!n03Rings) {
    n03Rings = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /^N03-[0-9]{8}_[0-9]{2}\.geojson$/.test(e.name) ? [path.join(d, e.name)] : []));
    for (const f of walk(n03Dir)) {
      for (const ft of JSON.parse(fs.readFileSync(f, 'utf8')).features) {
        const code = ft.properties.N03_007; if (!code) continue;
        const polys = ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates;
        for (const poly of polys) {
          const ring = poly[0]; const pts = new Float64Array(ring.length * 2); const bb = [180, 90, -180, -90];
          ring.forEach(([x, y], i) => { pts[2 * i] = x; pts[2 * i + 1] = y; if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; });
          n03Rings.push({ code, pts, bb });
        }
      }
    }
  }
  const hit = n03Rings.find((r) => p.lon >= r.bb[0] && p.lon <= r.bb[2] && p.lat >= r.bb[1] && p.lat <= r.bb[3] && pointInRing([p.lon, p.lat], r.pts));
  return hit ? regionByCode.get(hit.code) || null : null;
}

// ---------- 点と線 ----------
function pointInRing([x, y], ring) { // ring は [経度, 緯度, …] の並び
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], yi = ring[2 * i + 1], xj = ring[2 * j], yj = ring[2 * j + 1];
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
  for (const f of t.feats) for (const r of f.rings) for (let i = 0; i < r.pts.length; i += 2) { const x = r.pts[i], y = r.pts[i + 1]; if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; }
  t.bb = bb;
  const main = t.feats.slice().sort((a, b) => b.area - a.area)[0]; // 代表点はいちばん広い区画の代表点(区画の中にある点)
  t.lat = main.lat; t.lon = main.lon;
  t.sArea = t.feats.map((f) => f.sArea).sort()[0];
  t.id = `tw-${t.code5}-${t.sArea}`;
  t.region = regionByCode.get(t.code5) || regionAtPoint(t) || null;
  t.jinko = t.feats.reduce((s, f) => s + f.jinko, 0);
}

// ---------- 入れる・入れない・非公開 ----------
const report = { skipped: [], hidden: [], noRegion: [], moved: 0 };
const keep = [];
for (const t of towns) {
  if (!t.name || SKIP_NAME.test(t.name) || (t.jinko === 0 && WATER_BODY.test(t.name))) { report.skipped.push(`${t.cityName} ${t.name}`); continue; }
  if (!t.region) { report.noRegion.push(`${t.code5} ${t.cityName} ${t.name}`); continue; }
  const rule = HIDE_RULES.find((x) => x.re.test(t.name));
  t.hidden = HIDE_TOWNS[`${t.code5}|${t.name}`] || (rule && rule.reason) || (DISPUTED_NAME.test(t.name) ? 'disputed' : null) || (RESTRICTED.some(([s, n, w, e]) => t.lat >= s && t.lat <= n && t.lon >= w && t.lon <= e) ? 'restricted' : null);
  if (t.hidden) report.hidden.push(`${t.cityName} ${t.name}(${t.hidden})`);
  keep.push(t);
}

// 名前: 同じ都道府県で名前が重なる町・字には「(市区町村名)」を付ける
const nameCount = new Map();
for (const t of keep) { const k = `${t.code5.slice(0, 2)}|${t.name}`; nameCount.set(k, (nameCount.get(k) || 0) + 1); }
for (const t of keep) {
  const dup = nameCount.get(`${t.code5.slice(0, 2)}|${t.name}`) > 1; // 名前の重なりは町・字どうしだけで見る(ジャンルが違えば同じ名前でよい)
  t.display = dup ? `${t.name}(${t.region.name})` : t.name;
}
// 同じ市区町村の中でも重なる(字ごとに分けたもの)ときは小地域コードで区別
const seenName = new Map();
for (const t of keep) { const k = `${t.region.parent}|${t.display}`; const c = (seenName.get(k) || 0) + 1; seenName.set(k, c); if (c > 1) t.display = `${t.display}(${t.sArea})`; }

// 既存の拠点から 25 m 以内なら、代表点を少しずらす(同じ場所の二重登録を避ける。テストの決まり)
// 近さの判定は、約 100 m のます目に分けて近所だけ比べる(全国で 10 万件を超えるため)
const grid25 = new Map();
const cell25 = (lat, lon) => `${Math.floor(lat / 0.001)}:${Math.floor(lon / 0.0012)}`;
const put25 = (n) => { const k = cell25(n.lat, n.lon); if (!grid25.has(k)) grid25.set(k, []); grid25.get(k).push(n); };
for (const n of others) put25(n);
const near25 = (p) => {
  const cy = Math.floor(p.lat / 0.001), cx = Math.floor(p.lon / 0.0012);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const n of grid25.get(`${cy + dy}:${cx + dx}`) || []) if (n !== p && distKm(n, p) < 0.025) return n;
  return null;
};
for (const t of keep) {
  let tries = 0;
  while (near25(t) && tries < 8) { const ang = (tries * Math.PI) / 4; t.lat += 0.0004 * Math.cos(ang); t.lon += 0.0005 * Math.sin(ang); tries++; }
  if (tries) report.moved++;
  put25(t);
}

// 境界が接している町・字: 境界の点を 2 つ以上共有している町・字どうし(角で 1 点だけ接するものは除く)。公開の町・字だけ。
// 点は 0.1 m 単位の整数にして表で引く。全国で数千万点になるので、表は経度で 64 に分ける(Map の上限は約 1,600 万件)
const pub = keep.filter((t) => !t.hidden);
const SHARDS = 64;
// 点ごとに最初の 2 つの持ち主を覚える(3 つの町・字が集まる角でも、後から来た町・字は前の 2 つと組になる)
const vertexOwner = Array.from({ length: SHARDS }, () => new Map());
const vertexOwner2 = Array.from({ length: SHARDS }, () => new Map());
const pairCount = new Map();
const bump = (a, b) => { const k = a < b ? `${a}|${b}` : `${b}|${a}`; pairCount.set(k, (pairCount.get(k) || 0) + 1); };
pub.forEach((t, ti) => {
  const seen = new Set(); // 同じ町・字の中で同じ点を 2 回数えない
  for (const f of t.feats) for (const r of f.rings) for (let i = 0; i < r.pts.length; i += 2) {
    const lonQ = Math.round((r.pts[i] - 122) * 1e6), latQ = Math.round((r.pts[i + 1] - 20) * 1e6);
    const vq = latQ * 33554432 + lonQ; // 2^25。どちらも 2^25 未満なので 2^50 未満の整数になる
    if (seen.has(vq)) continue;
    seen.add(vq);
    const s1 = vertexOwner[lonQ % SHARDS], s2 = vertexOwner2[lonQ % SHARDS];
    const o1 = s1.get(vq);
    if (o1 === undefined) { s1.set(vq, ti); continue; }
    bump(o1, ti);
    const o2 = s2.get(vq);
    if (o2 === undefined) s2.set(vq, ti); else bump(o2, ti);
  }
});
const borders = new Map(pub.map((t) => [t.id, new Set()]));
for (const [k, c] of pairCount) {
  if (c < 2) continue;
  const [a, b] = k.split('|').map(Number);
  borders.get(pub[a].id).add(pub[b].id); borders.get(pub[b].id).add(pub[a].id);
}
vertexOwner.length = 0; vertexOwner2.length = 0;

// 町・字の中にある駅・名所(公開・ハック可)。町・字の範囲を約 5 km のます目に登録して、近所の町・字だけ調べる
const townGrid = new Map();
const G5 = 0.05;
for (const t of pub) for (let y = Math.floor(t.bb[1] / G5); y <= Math.floor(t.bb[3] / G5); y++) for (let x = Math.floor(t.bb[0] / G5); x <= Math.floor(t.bb[2] / G5); x++) {
  const k = `${y}:${x}`; if (!townGrid.has(k)) townGrid.set(k, []); townGrid.get(k).push(t);
}
const contains = new Map(pub.map((t) => [t.id, []]));
for (const n of others) {
  if (n.hackable === false || n.status === 'hidden' || n.isPlayerNode) continue;
  const cands = townGrid.get(`${Math.floor(n.lat / G5)}:${Math.floor(n.lon / G5)}`) || [];
  const t = cands.find((x) => inTown(n, x));
  if (t) contains.get(t.id).push(n.id);
}

// ---------- 湖・湾の形(2026-10-19): 画面が薄い水色で塗る(public/data/water.json) ----------
// 湖・湾の町・字(人口 0)の輪郭を、約 30 m の誤差で間引いて書き出す。島(輪の中の穴)も残す(画面は even-odd で塗る)
const LAKE_RE = /(琵琶湖|霞ヶ浦|霞ケ浦|北浦|厚岸湾|厚岸湖|風蓮湖|中海|宍道湖|浜名湖|諏訪湖|猪苗代湖|十和田湖|田沢湖|八郎潟|サロマ湖|能取湖|涛沸湖|網走湖|洞爺湖|支笏湖|屈斜路湖|阿寒湖|小川原湖|河口湖|山中湖|芦ノ湖|中禅寺湖|印旛沼|手賀沼|牛久沼)$/;
function simplify(pts, tol) { // Douglas-Peucker。pts は [経度, 緯度, …]。戻り値は [[経度, 緯度], …]
  const n = pts.length / 2;
  if (n <= 3) return Array.from({ length: n }, (_, i) => [pts[2 * i], pts[2 * i + 1]]);
  const keepPt = new Uint8Array(n); keepPt[0] = 1; keepPt[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let far = -1, fd = 0;
    // 閉じた輪(始点 = 終点)では線分の長さが 0 になるので、始点からの距離で見る
    for (let i = a + 1; i < b; i++) { const px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay; const d = len > 1e-12 ? Math.abs(dy * px - dx * py) / len : Math.hypot(px, py); if (d > fd) { fd = d; far = i; } }
    if (far >= 0 && fd > tol) { keepPt[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keepPt[i]) out.push([Number(pts[2 * i].toFixed(5)), Number(pts[2 * i + 1].toFixed(5))]);
  return out;
}
const waterOut = [];
for (const t of keep) {
  if (t.hidden || t.jinko !== 0 || !LAKE_RE.test(t.name)) continue;
  const rings = [];
  for (const f of t.feats) for (const r of f.rings) { const s = simplify(r.pts, 0.0003); if (s.length >= 4) rings.push(s); }
  if (rings.length) waterOut.push({ id: t.id, name: t.display, kind: 'lake', polys: rings });
}
if (waterOut.length) {
  const WATER_FILE = path.join(ROOT, 'public', 'data', 'water.json');
  const prev = fs.existsSync(WATER_FILE) ? JSON.parse(fs.readFileSync(WATER_FILE, 'utf8')) : { water: [] };
  // 今回の都道府県の湖だけ入れ替える(ほかの都道府県の分は残す)
  const kept = (prev.water || []).filter((w) => !prefsInData.has(w.id.slice(3, 5)));
  const water = [...kept, ...waterOut].sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(WATER_FILE, JSON.stringify({ schema: 'pc.water/1', source: SOURCE, updatedAt: TODAY, note: '湖・湾の形(国勢調査 2020 年 小地域境界の湖・湾の区画を約 30 m で間引いたもの)。画面が薄い水色で塗る', water }));
  console.log(`湖・湾の形: ${water.length} 件を public/data/water.json に書いた(${(fs.statSync(WATER_FILE).size / 1024).toFixed(0)} KB)`);
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
// 北方領土(2026-10-19 ユーザー決定): 国勢調査の小地域に無いので、村ごとに 1 件、地域マスターの村の中心に非公開(disputed)で入れる。
// 出どころは行政区域(国土数値情報 N03)。北海道を取り込むときだけ
if (prefsInData.has('01')) {
  const f = nodeFiles.get('hokkaido');
  for (const code of NORTHERN_VILLAGES) {
    const r = regionByCode.get(code);
    if (!r || !r.center || !f) { report.noRegion.push(`${code}: 北方領土の村が地域マスターに無い`); continue; }
    const taken = f.T.nodes.some((n) => n.name === r.name); // 北海道には古宇郡の泊村もある
    f.T.nodes.push({ id: `tw-${code}-000000`, name: taken ? `${r.name}(北方領土)` : r.name, genre: 'town', kind: 'TOWN', area: r.name, region: r.id, lat: Number(r.center.lat.toFixed(5)), lon: Number(r.center.lon.toFixed(5)), level: 1, value: 1,
      src: 'src-ksj-n03-2026', status: 'hidden', hiddenReason: 'disputed' });
    report.hidden.push(`${r.name}(disputed)`); added++;
  }
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
