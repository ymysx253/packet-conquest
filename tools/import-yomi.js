'use strict';
// 拠点の読み(ひらがな)と英語の名前(2026-10-21 ユーザー決定)。地図には出さない。読みは「拠点の情報」の名前の下に出す。
// 英語の名前は英語の表示を作ったときに使う(今は出さない)。
//
// 使い方:
//   node tools/import-yomi.js <日本郵便 郵便番号データ UTF-8 版 utf_ken_all.csv>
//
// 出どころ:
//   - 町・字: 日本郵便「郵便番号データ」(UTF-8 版。町域名の読みは全角カタカナ)。市区町村コードと町域名で突き合わせる。
//     「郵便番号データに限っては日本郵便株式会社は著作権を主張しません。自由に配布していただいて結構です。」(出典 src-jp-post-zip)
//   - 駅: Wikidata の駅の項目(名前と位置 1.5 km 以内で突き合わせる)の かな表記(P1814)と英語の名前。かなが無ければ、同じ市区町村の同じ名前の町の読み + 「えき」
//   - 名所・観光地・空港・港など(codes.wikidata がある拠点): Wikidata の かな表記と英語の名前
//   - 英語の名前が無い拠点は、読みからヘボン式のローマ字を作る(伸ばす音の記号は付けない。とうきょう → Tokyo)
// 推測で読みを付けない(同じ漢字でも土地ごとに読みが違う。日本橋: 東京は にほんばし、大阪は にっぽんばし)。出どころに読みが無い拠点は読みなし。
// 結果は server/map/data/derived/yomi.json(拠点 id → [読み, 英語])。server/map/load.js が読み込むときに、読みは kana、英語は names.en として足す(names は言語ごとの名前、kana は日本語の名前の読み。2026-10-21 ユーザー決定)。
// 拠点を作る道具を流し直しても消えないよう、拠点マスターとは別のファイルにする
const fs = require('fs');
const path = require('path');
const https = require('https');

const [, , kenAll] = process.argv;
if (!kenAll) { console.error('使い方: node tools/import-yomi.js <utf_ken_all.csv>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'server/map/data');
const OUT = path.join(DATA, 'derived', 'yomi.json');
const UA = 'PacketConquest/0.1 (readings; https://github.com/ymysx253/packet-conquest)';

// ---------- かな・ローマ字 ----------
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const ROMA = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho', ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo', りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo', びゃ: 'bya', びゅ: 'byu', びょ: 'byo', ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  しぇ: 'she', ちぇ: 'che', じぇ: 'je', てぃ: 'ti', でぃ: 'di', ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va',
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo', ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo', ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu', ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
};
function romaLower(hira) { // 大文字にしない(っ・ん の次の音を調べるのにも使う)
  let out = '';
  for (let i = 0; i < hira.length; i++) {
    const two = hira.slice(i, i + 2);
    if (ROMA[two]) { out += ROMA[two]; i++; continue; }
    const c = hira[i];
    if (c === 'ん') { out += /^[aiueoy]/.test(romaLower(hira.slice(i + 1, i + 3)) || '') ? "n'" : 'n'; continue; }
    if (c === 'っ') { const nx = romaLower(hira.slice(i + 1, i + 3)); out += nx ? (nx.startsWith('ch') ? 't' : nx[0]) : ''; continue; }
    if (c === 'ー') continue; // 伸ばす音は書かない
    out += ROMA[c] !== undefined ? ROMA[c] : /[0-9A-Za-z]/.test(c) ? c : c === '・' || c === ' ' ? ' ' : '';
  }
  // 伸ばす音は記号を付けずにまとめる(おう・おお → o、うう → u)
  return out.replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u');
}
function romaji(hira) { const out = romaLower(hira); return out ? out[0].toUpperCase() + out.slice(1) : ''; }

// ---------- 拠点 ----------
const files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json'));
const nodes = [];
for (const f of files) { try { const j = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); if (Array.isArray(j.nodes)) nodes.push(...j.nodes.filter((n) => !n.id.startsWith('pp-'))); } catch { /* 拠点のファイルでない */ } }
const distKm = (a, b) => { const r = (d) => (d * Math.PI) / 180; const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const result = new Map(); // id → { kana, en, how }

// ---------- 町・字: 郵便番号データ ----------
const OLD = { 彌: '弥', 劒: '剣', 龍: '竜', 澤: '沢', 濱: '浜', 邊: '辺', 邉: '辺', 嶋: '島', 圓: '円', 國: '国', 櫻: '桜', 廣: '広', 竈: '竃', 檜: '桧', 槇: '槙', 瀨: '瀬', 塚: '塚', 﨑: '崎', 舘: '館' };
const norm = (s) => s.replace(/[（(].*$/, '').replace(/ヶ/g, 'ケ').replace(/^(大字|字)/, '').replace(/[　 ]/g, '').replace(/./g, (c) => OLD[c] || c);
const ken = new Map(); // 市区町村コード|町名 → 読み(ひらがな)
for (const line of fs.readFileSync(kenAll, 'utf8').split(/\r?\n/)) {
  if (!line) continue;
  const c = line.split(',').map((x) => x.replace(/^"|"$/g, ''));
  const name = c[8];
  if (/以下に掲載がない|の次に番地|一円/.test(name)) continue;
  const kana = toHira(c[5].replace(/[（(].*$/, ''));
  const k = `${c[0]}|${norm(name)}`;
  if (!ken.has(k)) ken.set(k, kana);
}
const townKana = new Map(); // 市区町村コード|町名 → 読み(駅の読みに使う)
let townHit = 0, towns = 0;
for (const t of nodes) {
  if (t.genre !== 'town') continue;
  towns++;
  const city = t.id.split('-')[1], rc = (t.region || '').split('-').pop();
  const nm = norm(t.name.replace(/\(.+\)$/, ''));
  const kana = ken.get(`${city}|${nm}`) || ken.get(`${rc}|${nm}`);
  if (!kana) continue;
  townHit++;
  townKana.set(`${rc}|${nm}`, kana);
  result.set(t.id, { kana, en: romaji(kana), how: 'post' });
}
console.log(`町・字: ${towns} のうち ${townHit} に読み(${((townHit / towns) * 100).toFixed(1)}%)`);

// ---------- Wikidata ----------
const sparql = (q) => new Promise((res, rej) => {
  https.get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeout: 180000 }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => (b += c)); r.on('end', () => { if (r.statusCode !== 200) return rej(new Error(`HTTP ${r.statusCode}`)); res(JSON.parse(b).results.bindings); });
  }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const point = (v) => { const m = /Point\(([-0-9.]+) ([-0-9.]+)\)/.exec(v || ''); return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null; };
const cleanEn = (s) => (s || '').trim();

(async () => {
  // 名所など(codes.wikidata がある拠点)
  const byQid = new Map();
  for (const n of nodes) { const q = n.codes && n.codes.wikidata; if (q && n.genre !== 'town') { if (!byQid.has(q)) byQid.set(q, []); byQid.get(q).push(n); } }
  const qids = [...byQid.keys()];
  let qHit = 0;
  for (let i = 0; i < qids.length; i += 250) {
    const vals = qids.slice(i, i + 250).map((q) => `wd:${q}`).join(' ');
    const rows = await sparql(`SELECT ?item ?kana ?en WHERE { VALUES ?item { ${vals} } OPTIONAL { ?item wdt:P1814 ?kana } OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") } }`);
    for (const r of rows) {
      const q = r.item.value.split('/').pop();
      for (const n of byQid.get(q) || []) {
        const cur = result.get(n.id) || {};
        const kana = r.kana ? toHira(r.kana.value.replace(/\s/g, '')) : cur.kana;
        const en = r.en ? cleanEn(r.en.value) : cur.en;
        if (kana || en) result.set(n.id, { kana: kana || null, en: en || (kana ? romaji(kana) : null), how: 'wikidata' });
      }
    }
    await wait(500);
  }
  for (const q of qids) for (const n of byQid.get(q)) if (result.has(n.id) && result.get(n.id).kana) qHit++;
  console.log(`名所など(Wikidata の id あり): ${qids.length} 項目、読みあり ${qHit} 拠点`);

  // 駅: Wikidata の駅の項目と、名前と位置で突き合わせる
  const rows = await sparql(`SELECT ?item ?ja ?kana ?en ?c WHERE { VALUES ?cls { wd:Q55488 wd:Q928830 wd:Q2175765 } ?item wdt:P31 ?cls; wdt:P17 wd:Q17; wdt:P625 ?c. ?item rdfs:label ?ja FILTER(LANG(?ja) = "ja") OPTIONAL { ?item wdt:P1814 ?kana } OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") } }`);
  const wdSt = new Map(); // 名前(駅を除く)→ [{ p, kana, en }]
  for (const r of rows) {
    const p = point(r.c.value); if (!p) continue;
    const base = r.ja.value.replace(/\s*\(.*\)$/, '').replace(/駅$/, '');
    if (!wdSt.has(base)) wdSt.set(base, []);
    wdSt.get(base).push({ p, kana: r.kana ? toHira(r.kana.value.replace(/\s/g, '')) : null, en: r.en ? cleanEn(r.en.value) : null });
  }
  let st = 0, stKana = 0, stEn = 0, stTown = 0;
  for (const n of nodes) {
    if (n.genre !== 'station') continue;
    st++;
    const base = n.name.replace(/\(.*\)$/, '').replace(/駅$/, '');
    const cands = (wdSt.get(base) || []).map((c) => ({ ...c, d: distKm(n, c.p) })).filter((c) => c.d <= 1.5).sort((a, b) => (b.kana ? 1 : 0) - (a.kana ? 1 : 0) || a.d - b.d);
    let kana = cands.find((c) => c.kana) ? cands.find((c) => c.kana).kana : null;
    const en = cands.find((c) => c.en) ? cands.find((c) => c.en).en : null;
    if (!kana) { // 同じ市区町村の同じ名前の町の読み + えき
      const rc = (n.region || '').split('-').pop();
      const tk = townKana.get(`${rc}|${norm(base)}`);
      if (tk) { kana = `${tk}えき`; stTown++; }
    }
    if (kana) stKana++;
    if (en) stEn++;
    if (kana || en) result.set(n.id, { kana: kana || null, en: en || (kana ? `${romaji(kana.replace(/えき$/, ''))} Station` : null), how: 'station' });
  }
  console.log(`駅: ${st} のうち 読み ${stKana}(町の読みから ${stTown})、英語 ${stEn}(Wikidata の駅 ${rows.length} 件)`);

  // 書き出し
  const out = {};
  for (const [id, v] of [...result].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out[id] = [v.kana || '', v.en || ''];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ schema: 'pc.derived.yomi/1', note: '拠点の読み(ひらがな)と英語の名前。拠点 id → [読み, 英語]。tools/import-yomi.js が作り、server/map/load.js が kana と names.en として足す', sources: ['src-jp-post-zip', 'src-wikidata'], updatedAt: new Date().toISOString().slice(0, 10), nodes: out }).replace(/\],"/g, '],\n"') + '\n');
  const all = nodes.filter((n) => n.status !== 'hidden').length;
  const withKana = [...result.values()].filter((v) => v.kana).length;
  console.log(`拠点 ${all} のうち 読み ${withKana}(${((withKana / all) * 100).toFixed(1)}%)、英語 ${[...result.values()].filter((v) => v.en).length}。${path.relative(ROOT, OUT)} に書いた`);
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
