'use strict';
// 全国の名所の候補を Wikidata(CC0)から集め、確認用の一覧を書き出す(設計書 3.4 の地理データの標準、docs/PLACES.md)。
// 拠点マスターには入れない。人が一覧を見て採否を決めてから、別の手順で取り込む。
//
// 使い方:
//   node tools/collect-landmarks.js <N03 の GeoJSON が入ったフォルダ> [作業フォルダ]
//   作業フォルダには Wikidata の応答をジャンルごとに保存する(2 回目以降は再取得しない。消せば取り直す)
// 出力:
//   docs/landmarks/candidates.csv   確認用の一覧(Excel で開けるよう BOM 付き UTF-8)
//   docs/landmarks/summary.json     件数の集計(README の表の元)
//
// 選び方:
//   1. ジャンルごとに Wikidata の分類(下位の分類を含む)で、日本(P17 = Q17)にあり座標(P625)を持つものを取る。
//      閉館・廃止の記録(P576 解散・廃止日、P3999 閉鎖日)があるものは除く
//   2. 知名度は Wikipedia などの言語版の数(sitelinks)。ジャンルごとに下限を変える(山は多いので高め)
//   3. 病院・学校・警察・軍・発電所などの分類を併せ持つものは除く(PLACES.md 第 3 章)
//   4. 都道府県・市区町村は国土数値情報 N03 の境界で座標から決める。どこにも入らないもの(海上など)は除く
//   5. 既存の拠点(駅と東京の名所)と同じ名前、または 80 m 以内のものは「既存と重複」に印を付ける
//   6. 推奨: 各都道府県で知名度の高い順に最大 50 件(同じジャンルは 10 件まで)。重複・寺社・要確認・企業名の施設は推奨に含めない
//   7. 取り込みの印(2026-10-19 決定): 推奨は「○」(ハック可)。寺社・テーマパーク・命名権など企業名の施設は全部「○(ハック不可)」(線をつなげない)。
//      企業名は Wikidata の「名前の由来(P138)」「スポンサー(P859)」が企業(Q4830453 の下位)を指すもので判定し、その企業名を表示する
const fs = require('fs');
const path = require('path');
const https = require('https');

const [, , n03Dir, workDir = path.join(require('os').tmpdir(), 'pc-landmarks')] = process.argv;
if (!n03Dir) { console.error('使い方: node tools/collect-landmarks.js <N03 フォルダ> [作業フォルダ]'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs/landmarks');
const UA = 'PacketConquest/0.1 (landmark candidate collection; https://github.com/ymysx253/packet-conquest)';
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ジャンル(PLACES.md 第 2 章)→ Wikidata の分類と sitelinks の下限。complex(複合施設)と ix は企業名や判断が要るので自動では集めない
// 下限は 2026-10-19 に下げた(各都道府県 50 件を選べるだけの候補を集めるため)。選ぶのは知名度の高い順なので、下限を下げても上位は変わらない。
// 寺社は「全部取り込む(ハック不可)」と決めたので下限を据え置く(下げると数千件になる)
const GENRES = [
  { genre: 'airport', classes: ['Q1248784'], min: 2 },
  { genre: 'port', classes: ['Q1478783', 'Q4303352'], min: 1 },
  { genre: 'bus_terminal', classes: ['Q494829'], min: 1 },
  { genre: 'bridge', classes: ['Q12280'], min: 2 },
  { genre: 'tower', classes: ['Q12518', 'Q1440300'], min: 2 },
  { genre: 'park', classes: ['Q22698', 'Q22746', 'Q1107656'], min: 2 },
  { genre: 'nature', classes: ['Q8502'], min: 4, label: '山' },
  { genre: 'nature', classes: ['Q34038', 'Q150784', 'Q185113', 'Q40080'], min: 2, label: '滝・峡谷・岬・浜' },
  { genre: 'nature', classes: ['Q23397'], min: 3, label: '湖' },
  { genre: 'zoo_aquarium', classes: ['Q43501', 'Q2281788', 'Q167346'], min: 1 },
  { genre: 'museum', classes: ['Q33506', 'Q207694'], min: 2 },
  { genre: 'library', classes: ['Q7075'], min: 2 },
  { genre: 'theater', classes: ['Q24354', 'Q1060829'], min: 2 },
  { genre: 'stadium', classes: ['Q483110', 'Q641226'], min: 2 },
  { genre: 'heritage', classes: ['Q92026'], min: 2, label: '城' },
  { genre: 'heritage', classes: ['Q839954'], min: 2, label: '遺跡' },
  { genre: 'monument', classes: ['Q4989906'], min: 2 },
  { genre: 'shrine_temple', classes: ['Q845945', 'Q5393308'], min: 6 },
  { genre: 'shrine_temple', classes: ['Q16970'], min: 4, label: '教会' },
  { genre: 'government', classes: ['Q100705206'], min: 1, label: '都道府県庁舎' },
  { genre: 'government', classes: ['Q543654'], min: 2, label: '市庁舎' },
  { genre: 'university', classes: ['Q3918'], min: 3 },
  { genre: 'market', classes: ['Q37654', 'Q330284', 'Q21000333'], min: 1 },
  { genre: 'convention', classes: ['Q1378975'], min: 1 },
  { genre: 'observatory', classes: ['Q62832', 'Q148319'], min: 1 },
];
// 併せ持っていたら除く分類(PLACES.md 第 3 章「避けるジャンル」)
const EXCLUDE = new Set([ // ID は Wikidata のラベルで確認済み(2026-10-19)
  'Q16917', 'Q1774898', // 病院、診療所
  'Q3914', 'Q9842', 'Q9826', 'Q149566', 'Q1244442', // 学校、小学校、高校、中学校、学校施設
  'Q861951', 'Q1195942', // 警察署、消防署
  'Q245016', 'Q18691599', // 軍事基地、軍事施設
  'Q159719', 'Q134447', 'Q174814', 'Q12323', // 発電所、原子力発電所、変電所、ダム
  'Q40357', 'Q3917681', // 刑務所、大使館
  'Q39614', 'Q381885', // 墓地、墓
  'Q5003624', 'Q95652804', // 慰霊碑・記念碑(慰霊)、被爆建造物(災害・事件の慰霊の場は遊びの対象にしない)
  'Q695850', // 軍用飛行場
  'Q123705', 'Q494721', 'Q1054813', // 都市の地区(地名)、日本の市、自治体(地名そのもの)
  'Q11303', 'Q1021645', 'Q11691', // 超高層建築物、オフィスビル、証券取引所(企業)
  'Q1071482', 'Q46169', // 国立公園(広すぎて 1 点に決まらない)
]);
// 名前で除くもの(分類が付いていないことがあるため)
const EXCLUDE_NAME = /原爆|平和記念|平和祈念|平和公園|慰霊|追悼|戦没|殉難|墓|陵|基地|駐屯地|航空隊|国立公園|国定公園|ビル$|ビルディング$|本社|支社/;
// 立ち入りが制限された島(自衛隊・気象庁などの施設だけがある。硫黄島は戦没の地でもある)は範囲で除く
const RESTRICTED = [
  { name: '硫黄島', lat: [24.72, 24.82], lon: [141.26, 141.37] },
  { name: '南鳥島', lat: [24.27, 24.31], lon: [153.96, 154.0] },
  { name: '沖ノ鳥島', lat: [20.4, 20.45], lon: [136.04, 136.1] },
  { name: '尖閣諸島(領有をめぐる争いがある地域は扱わない)', lat: [25.6, 26.1], lon: [123.3, 124.7] },
];
const inRestricted = (c) => RESTRICTED.some((z) => c.lat >= z.lat[0] && c.lat <= z.lat[1] && c.lon >= z.lon[0] && c.lon <= z.lon[1]);
// 残すが「要確認」の印を付けるもの
const REVIEW_TYPES = { Q2416723: 'テーマパーク・遊園地(運営者の確認が要る。企業ならスポンサー候補)', Q194195: 'テーマパーク・遊園地(運営者の確認が要る。企業ならスポンサー候補)', Q5124659: '軍民共用の飛行場' };
const REVIEW_NAME = [[/飛行場$/, '軍の飛行場の可能性']];
// ジャンルの優先(1 つの名所が複数のジャンルに当たるとき)。寺社は必ずハック不可にするため最優先、城は博物館より先
const PRIORITY = ['shrine_temple', 'heritage', 'airport', 'port', 'bus_terminal', 'bridge', 'tower', 'zoo_aquarium', 'museum', 'observatory', 'stadium', 'theater', 'library', 'convention', 'university', 'government', 'market', 'park', 'monument', 'nature'];
const GENRE_JA = {
  airport: '空港', port: '港', bus_terminal: 'バスターミナル', bridge: '橋', tower: '塔・展望施設', park: '公園・庭園', nature: '自然の名所',
  zoo_aquarium: '動物園・水族館・植物園', museum: '博物館・美術館', library: '図書館', theater: '劇場・ホール', stadium: 'スタジアム・アリーナ',
  heritage: '城・遺跡', monument: '記念碑', shrine_temple: '寺社・教会', government: '庁舎', university: '大学', market: '市場・商店街',
  convention: '展示場・会議場', observatory: '天文台・プラネタリウム',
};

// ---------- Wikidata ----------
function sparql(query) {
  return new Promise((resolve, reject) => {
    const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeout: 120000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body).results.bindings); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function queryFor(cls, min, deep) {
  return `SELECT ?item ?ja (SAMPLE(?c) AS ?coord) (MAX(?s) AS ?sl) (GROUP_CONCAT(DISTINCT STRAFTER(STR(?t), "entity/"); separator="|") AS ?types) WHERE {
  ?item wdt:P31${deep ? '/wdt:P279*' : ''} wd:${cls}; wdt:P17 wd:Q17; wdt:P625 ?c; wikibase:sitelinks ?s.
  FILTER(?s >= ${min})
  FILTER NOT EXISTS { ?item wdt:P576 [] }
  FILTER NOT EXISTS { ?item wdt:P3999 [] }
  ?item rdfs:label ?ja. FILTER(LANG(?ja) = "ja")
  ?item wdt:P31 ?t.
} GROUP BY ?item ?ja`;
}
async function fetchClass(cls, min) {
  const cache = path.join(workDir, `${cls}-${min}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  let rows = null;
  // 下位の分類込み → 直接の分類だけ → 間を置いてもう 1 回。それでも時間切れなら飛ばす(公開サービスの 60 秒の上限があるため)
  const tries = [[true, 0], [false, 5000], [false, 20000]];
  for (const [deep, delay] of tries) {
    if (delay) await wait(delay);
    try { rows = await sparql(queryFor(cls, min, deep)); break; } catch (e) {
      console.log(`  ${cls}: ${deep ? '下位の分類込み' : '直接の分類だけ'}で失敗(${e.message.slice(0, 50)})`);
    }
  }
  if (!rows) {
    // 下限を変えて取り直したときなど、同じ分類の保存済みの結果があればそれを使う(下限が高い分、件数は少なめ)
    const older = fs.readdirSync(workDir).filter((x) => x.startsWith(`${cls}-`) && x.endsWith('.json')).sort((x, y) => parseInt(x.split('-')[1], 10) - parseInt(y.split('-')[1], 10));
    if (older.length) { console.log(`  ${cls}: 取得できなかったので、保存済みの ${older[0]} を使います`); return JSON.parse(fs.readFileSync(path.join(workDir, older[0]), 'utf8')); }
    console.log(`  ${cls}: 取得できなかったので飛ばします(次の実行で取り直します)`); return [];
  }
  const out = rows.map((r) => {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(r.coord.value);
    return { qid: r.item.value.split('/').pop(), name: r.ja.value, lon: Number(m[1]), lat: Number(m[2]), sitelinks: Number(r.sl.value), types: r.types.value.split('|') };
  });
  fs.writeFileSync(cache, JSON.stringify(out));
  await wait(1500); // 問い合わせの間隔(公開サービスへの配慮)
  return out;
}

// ---------- 境界(N03)で都道府県・市区町村を決める ----------
const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/map/data/regions.json'), 'utf8'));
const regionByCode = new Map(R.regions.filter((r) => r.code && /^JP-\d\d-\d+$/.test(r.code)).map((r) => [r.code.slice(6), r]));
const prefByCode = new Map(R.regions.filter((r) => r.kind === 'state').map((r) => [r.code.slice(3), r]));
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function locate(cands) {
  const files = fs.readdirSync(n03Dir).filter((f) => /^N03-\d{8}_\d{2}\.geojson$/.test(f)).sort();
  for (const f of files) {
    const pp = f.slice(-10, -8);
    const data = JSON.parse(fs.readFileSync(path.join(n03Dir, f), 'utf8'));
    let bb = [180, 90, -180, -90];
    const feats = data.features.map((ft) => {
      const polys = ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates;
      const b = [180, 90, -180, -90];
      for (const p of polys) for (const [x, y] of p[0]) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
      bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])];
      return { code: ft.properties.N03_007, polys, b };
    });
    for (const c of cands) {
      if (c.region) continue;
      const pt = [c.lon, c.lat];
      if (pt[0] < bb[0] || pt[0] > bb[2] || pt[1] < bb[1] || pt[1] > bb[3]) continue;
      for (const ft of feats) {
        if (pt[0] < ft.b[0] || pt[0] > ft.b[2] || pt[1] < ft.b[1] || pt[1] > ft.b[3]) continue;
        if (!ft.polys.some((p) => pointInRing(pt, p[0]) && !p.slice(1).some((h) => pointInRing(pt, h)))) continue;
        const reg = regionByCode.get(ft.code);
        if (reg) { c.region = reg.id; c.area = reg.name; c.pref = prefByCode.get(pp).id; c.prefName = prefByCode.get(pp).name; c.prefCode = pp; }
        break;
      }
    }
  }
}

// ---------- 既存の拠点との重複 ----------
const distKm = (a, b) => { const toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };
function existingNodes() {
  const out = [];
  for (const r of R.regions.filter((x) => x.nodeFile)) {
    const f = path.join(ROOT, 'server/map/data', `${r.nodeFile}.json`);
    // この道具と離島の道具が入れたもの(id が lm- / isl-)は除く。比べるのは駅と手で入れた名所だけ(自分の取り込み結果と重複扱いしない)
    if (fs.existsSync(f)) for (const n of JSON.parse(fs.readFileSync(f, 'utf8')).nodes) if (!/^(lm|isl)-/.test(n.id)) out.push({ name: n.name, lat: n.lat, lon: n.lon, genre: n.genre, pref: r.id });
  }
  return out;
}

// 命名権など、名前が企業に由来する施設(P138 名前の由来 / P859 スポンサー が企業)。結果は作業フォルダに保存
async function companiesOf(qids) {
  const cache = path.join(workDir, 'companies.json');
  const known = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : {};
  const todo = qids.filter((q) => !(q in known));
  for (let i = 0; i < todo.length; i += 150) {
    const chunk = todo.slice(i, i + 150);
    const q = `SELECT ?item ?co ?coja WHERE { VALUES ?item { ${chunk.map((x) => 'wd:' + x).join(' ')} }
  ?item wdt:P138|wdt:P859 ?co. ?co wdt:P31/wdt:P279* wd:Q4830453.
  OPTIONAL { ?co rdfs:label ?coja FILTER(LANG(?coja) = "ja") } }`;
    let rows = [];
    try { rows = await sparql(q); } catch (e) { console.log(`  企業の判定で失敗(${e.message.slice(0, 50)})。この 150 件は企業なしとして扱う`); }
    for (const x of chunk) known[x] = known[x] || null;
    for (const row of rows) { const id = row.item.value.split('/').pop(); known[id] = row.coja ? row.coja.value : row.co.value.split('/').pop(); }
    fs.writeFileSync(cache, JSON.stringify(known));
    await wait(1500);
  }
  return known;
}

(async () => {
  // 1. 集める
  const byQid = new Map();
  for (const g of GENRES) {
    for (const cls of g.classes) {
      const rows = await fetchClass(cls, g.min);
      console.log(`${GENRE_JA[g.genre]}${g.label ? `(${g.label})` : ''} ${cls}: ${rows.length} 件`);
      for (const row of rows) {
        const cur = byQid.get(row.qid) || { ...row, types: new Set(), genres: new Map() };
        row.types.forEach((t) => cur.types.add(t));
        cur.sitelinks = Math.max(cur.sitelinks, row.sitelinks);
        if (!cur.genres.has(g.genre)) cur.genres.set(g.genre, g.label || '');
        byQid.set(row.qid, cur);
      }
    }
  }
  // 除外とジャンルの決定(すべての分類を集めてから)
  const regionNames = new Set(R.regions.map((x) => x.name));
  const excluded = { type: 0, name: 0 };
  const cands = [];
  for (const c of byQid.values()) {
    if ([...c.types].some((t) => EXCLUDE.has(t))) { excluded.type++; continue; }
    if (EXCLUDE_NAME.test(c.name) || regionNames.has(c.name)) { excluded.name++; continue; }
    if (inRestricted(c)) { excluded.restricted = (excluded.restricted || 0) + 1; continue; }
    c.genre = PRIORITY.find((g) => c.genres.has(g));
    c.sub = c.genres.get(c.genre);
    const notes = [...c.types].map((t) => REVIEW_TYPES[t]).filter(Boolean);
    for (const [re, why] of REVIEW_NAME) if (why && re.test(c.name)) notes.push(why);
    c.review = [...new Set(notes)].join('・');
    c.types = [...c.types];
    cands.push(c);
  }
  console.log(`候補(重複を除く): ${cands.length} 件(分類で除外 ${excluded.type}、名前で除外 ${excluded.name}、立ち入り制限の島 ${excluded.restricted || 0})`);

  // 2. 都道府県・市区町村
  locate(cands);
  // 北方領土(6 村と根室市の歯舞群島)は扱わない(実際に行けない地域で、運用の主体も違うため)
  const NORTHERN = /^hokkaido-0(1695|1696|1697|1698|1699|1700)$/;
  for (const c of cands) if (c.region && (NORTHERN.test(c.region) || (c.region === 'hokkaido-01223' && c.lon > 145.85))) { c.region = null; c.northern = true; }
  const located = cands.filter((c) => c.region);
  console.log(`境界の中にあるもの: ${located.length} 件(海上など境界外 ${cands.length - located.length} 件は除外)`);

  // 3. 既存と重複
  const nodes = existingNodes();
  const grid = new Map();
  const cell = (p) => `${Math.floor(p.lat * 50)}:${Math.floor(p.lon * 50)}`;
  for (const n of nodes) { const k = cell(n); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
  for (const c of located) {
    const cy = Math.floor(c.lat * 50), cx = Math.floor(c.lon * 50);
    for (let dy = -2; dy <= 2 && !c.dup; dy++) for (let dx = -2; dx <= 2 && !c.dup; dx++) for (const n of grid.get(`${cy + dy}:${cx + dx}`) || []) {
      // 同じ名前、80 m 以内、または同じジャンルで近い(敷地が広いので中心がずれる。空港 3 km、その他 300 m)
      const d = distKm(n, c);
      const sameGenreNear = n.genre === c.genre && d < (c.genre === 'airport' ? 3 : 0.3);
      if (n.name === c.name || (n.genre !== 'station' && d < 0.08) || sameGenreNear) { c.dup = n.name; break; }
    }
    if (!c.dup) { const same = nodes.find((n) => n.pref === c.pref && n.name === c.name); if (same) c.dup = same.name; }
  }

  // 3.5 企業名の施設(命名権など)
  const companies = await companiesOf(located.filter((c) => c.genre !== 'shrine_temple').map((c) => c.qid));
  // 採るのは「施設名に企業名が含まれる」か「スタジアム・アリーナ(命名権が一般的)」のときだけ。大学は対象外(創立者や前身の名前が企業扱いになっていることがある)。
  // Wikidata の誤り(例: Bunkamura → 東映太秦映画村)を拾わないため
  const coreOf = (co) => String(co).replace(/株式会社|有限会社|ホールディングス|グループ|カンパニー|・/g, '').trim();
  const nameHas = (name, co) => { const k = coreOf(co); return k.length >= 2 && (name.includes(k) || name.includes(k.slice(0, Math.min(4, k.length)))); };
  for (const c of located) {
    const co = companies[c.qid];
    if (!co || c.genre === 'university') continue;
    if (!(nameHas(c.name, co) || c.genre === 'stadium')) continue;
    c.company = co; c.review = [c.review, '命名権など企業名の施設'].filter(Boolean).join('・');
  }
  console.log(`企業名の施設: ${located.filter((c) => c.company).length} 件`);

  // 4. 推奨(都道府県ごとに知名度順で最大 50 件、同じジャンルは 10 件まで。重複・寺社・要確認・企業名は除く)
  const PER_PREF = 50, PER_GENRE = 10;
  const byPref = new Map();
  for (const c of located) { if (!byPref.has(c.pref)) byPref.set(c.pref, []); byPref.get(c.pref).push(c); }
  for (const list of byPref.values()) {
    list.sort((a, b) => b.sitelinks - a.sitelinks || a.name.localeCompare(b.name, 'ja'));
    const perGenre = {};
    let n = 0;
    for (const c of list) {
      if (n >= PER_PREF || c.dup || c.review || c.genre === 'shrine_temple') continue;
      if ((perGenre[c.genre] || 0) >= PER_GENRE) continue;
      c.recommended = true; perGenre[c.genre] = (perGenre[c.genre] || 0) + 1; n++;
    }
  }
  // 取り込みの印: 推奨はハック可。寺社・テーマパーク・企業名の施設は全部ハック不可(線をつなげない)。軍の飛行場の可能性があるものと重複は取り込まない
  for (const c of located) {
    const nonHack = !c.dup && (c.genre === 'shrine_temple' || c.company || /テーマパーク/.test(c.review || ''));
    const military = /飛行場/.test(c.review || '');
    c.take = c.recommended ? '○' : (nonHack && !military ? '○(ハック不可)' : '');
  }

  // 5. 書き出し(都道府県コード順 → 推奨 → 知名度順)
  located.sort((a, b) => a.prefCode.localeCompare(b.prefCode) || (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0) || b.sitelinks - a.sitelinks || a.name.localeCompare(b.name, 'ja'));
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = ['都道府県', '市区町村', '名前', 'ジャンル', 'genre', '細分', 'ハック', '推奨', '取り込み', '既存と重複', '要確認', '企業(命名権など)', '知名度(言語版の数)', 'Wikidata', '緯度', '経度', '採否(確認用)'];
  const lines = located.map((c) => [c.prefName, c.area, c.name, GENRE_JA[c.genre], c.genre, c.sub, c.take === '○' ? '可' : (c.take ? '不可' : ''), c.recommended ? '○' : '', c.take, c.dup || '', c.review || '', c.company || '', c.sitelinks, c.qid, c.lat.toFixed(5), c.lon.toFixed(5), ''].map(esc).join(','));
  fs.writeFileSync(path.join(OUT_DIR, 'candidates.csv'), '﻿' + [header.join(','), ...lines].join('\r\n') + '\r\n');

  const summary = { collectedAt: '2026-10-19', source: 'Wikidata(CC0)。座標の所属は「国土数値情報(行政区域データ)」(国土交通省)で判定', total: located.length, recommended: located.filter((c) => c.recommended).length, dup: located.filter((c) => c.dup).length, review: located.filter((c) => c.review).length, company: located.filter((c) => c.company).length, take: located.filter((c) => c.take === '○').length, takeNonHack: located.filter((c) => c.take === '○(ハック不可)').length, excluded, byGenre: {}, byPref: {} };
  for (const c of located) {
    summary.byGenre[c.genre] = (summary.byGenre[c.genre] || 0) + 1;
    const p = (summary.byPref[c.prefName] ||= { code: c.prefCode, total: 0, recommended: 0, top: [] });
    p.total++; if (c.recommended) { p.recommended++; p.top.push(`${c.name}(${GENRE_JA[c.genre]})`); }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`書き出し: ${located.length} 件(推奨 ${summary.recommended}、既存と重複 ${summary.dup})→ docs/landmarks/candidates.csv`);
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
