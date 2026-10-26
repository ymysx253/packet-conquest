'use strict';
// 拠点のレベルを 1〜90 で付け直す「下書き」を計算する(2026-10-26 ユーザー決定。docs/DESIGN.md 第 9 章の 2026-10-26)。
// 拠点マスター・DB・ゲームのプログラムは変えない。書くのは下書き(docs/level100-nodes-draft.json)とまとめ(docs/LEVEL-NODES-DRAFT.md)だけ。
//
// 使い方:
//   node tools/level100-nodes.js <e-Stat 小地域境界データ(GML)のフォルダ>
//   フォルダには r2ka01.gml 〜 r2ka47.gml(国勢調査 2020 年 小地域)を置く(tools/import-towns.js と同じもの)
// 何度流しても同じ結果になる(乱数を使わない)。
//
// 決まり(2026-10-26 ユーザー決定):
//   - 段と割合(公開の全拠点に対して): 入門 1〜15 が 35%、初級 16〜35 が 30%、中級 36〜60 が 20%、上級 61〜78 が 10%、専門 79〜90 が 5%(91〜100 は神レベルで使わない)
//   - 種類ごとに手元の数で並べ、上からの順位を出し、種類ごとに入れてよい段の範囲の中で、全体が割合どおりになるよう境目を計算で決める
//       町・字 = 人口(入門〜上級) / 駅 = 乗り入れる路線の数 → まわりの町・字の人口(入門〜専門)
//       名所・観光地 = 知名度(Wikidata の言語版の数)と指定(初級〜専門) / 空港・港 = 1 年間の旅客数・便数、無ければつながりの本数(上級〜専門。10-26 に変更)
//       専門に決め打ち: 国会議事堂(90)・東京都庁・国際線の拠点の空港・都道府県庁舎・市区町村役場・区役所・国の機関の庁舎(genre government 全部)・大学(university 全部)・幻の航路でしかつながらない港(仮の港 pp- など)
//       (10-26 ユーザー決定: 町・字は専門に入れない。空港・港は上級から上。幻の航路の港は専門。専門の不足はふつうの駅で埋めず、役場・区役所・大学・国の機関を足して埋める)
//   - 段の中のレベルは、その段の中の順位で均等に割り振る(同じ数の拠点は同じレベル)
//
// 境目の決め方(この道具で決めた計算のしかた): 種類 × 段 の件数の表を、目標の割合(入れない段は 0)から出発して、
//   行(種類ごとの件数)と列(段ごとの目標の件数)に交互に合わせる(反復比例調整)。種類ごとの段の件数が決まったら、
//   種類の中で大きい順に上から配る。同じ数の拠点(同じ人口の町など)が境目をまたぐときは、まとまりの真ん中がある段に全部入れる。
const fs = require('fs');
const path = require('path');

const [, , gmlDir] = process.argv;
if (!gmlDir) { console.error('使い方: node tools/level100-nodes.js <e-Stat 小地域境界データ(GML)のフォルダ>'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'docs', 'level100-nodes-draft.json');
const OUT_MD = path.join(ROOT, 'docs', 'LEVEL-NODES-DRAFT.md');
const { townLevel, terminalOf } = require('./levels');

// ---------- 段 ----------
const TIERS = [ // 下から
  { k: 1, name: '入門', lo: 1, hi: 15, share: 0.35 },
  { k: 2, name: '初級', lo: 16, hi: 35, share: 0.30 },
  { k: 3, name: '中級', lo: 36, hi: 60, share: 0.20 },
  { k: 4, name: '上級', lo: 61, hi: 78, share: 0.10 },
  { k: 5, name: '専門', lo: 79, hi: 90, share: 0.05 },
];
const tierOfLevel = (lv) => TIERS.find((t) => lv >= t.lo && lv <= t.hi).k;

// ---------- 町・字の人口(tools/import-towns.js と同じまとめ方) ----------
const get = (f, k) => { const m = new RegExp(`<fme:${k}>([^<]*)</fme:${k}>`).exec(f); return m ? m[1] : ''; };
const stripChome = (s) => { const t = s.replace(/[一二三四五六七八九十〇壱弐参ニ]+丁目.*$/, '').replace(/第[一二三四五六七八九十〇]+地割.*$/, ''); return t || s; };
const stripOaza = (s) => {
  const t = s.replace(/^[^,，、・]+?大字(?=.)/, '').replace(/[,，、]\s*(大字|字)?/g, '・').replace(/^(大字|字)/, '');
  const p = t.replace(/[（(].*$/, '').replace(/[）)]$/, '').trim();
  return p || t.replace(/^[（(]|[）)]$/g, '');
};
const commonPrefix = (list) => { let p = list[0] || ''; for (const s of list) while (p && !s.startsWith(p)) p = p.slice(0, -1); return p; };

function townPopulation(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^r2ka[0-9]{2}\.gml$/.test(f)).sort();
  if (!files.length) throw new Error(`${dir} に r2kaNN.gml がありません`);
  const feats = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/<fme:r2ka[0-9]{2} [\s\S]*?<\/fme:r2ka[0-9]{2}>/g)) {
      const x = m[0].slice(0, m[0].indexOf('<gml:surfaceProperty>') >>> 0 || undefined); // 形の座標は使わない
      if (get(x, 'HCODE') !== '8101') continue; // 8154 は水面
      feats.push({ pref: get(x, 'PREF'), city: get(x, 'CITY'), sArea: get(x, 'S_AREA'), kihon1: get(x, 'KIHON1'), name: get(x, 'S_NAME'), jinko: Number(get(x, 'JINKO')) || 0 });
    }
  }
  const namedCity = new Set(feats.filter((f) => f.name).map((f) => `${f.pref}${f.city}`));
  const kept = feats.filter((f) => !((!f.name && namedCity.has(`${f.pref}${f.city}`)) || /^999/.test(f.kihon1)));
  const byKihon = new Map();
  for (const f of kept) { const k = `${f.pref}${f.city}|${f.kihon1}`; if (!byKihon.has(k)) byKihon.set(k, []); byKihon.get(k).push(f); }
  const towns = [];
  for (const [k, list] of byKihon) {
    const code5 = k.split('|')[0];
    const names = [...new Set(list.map((f) => stripChome(stripOaza(f.name))))];
    let groups;
    if (names.length <= 1) groups = [{ name: names[0] || '', feats: list }];
    else {
      const p = commonPrefix(names).replace(/[（(・]$/, '').replace(/字$/, '');
      if (p.length >= 2) groups = [{ name: p, feats: list }];
      else {
        const m = new Map();
        for (const f of list) { const n = stripChome(stripOaza(f.name)); if (!m.has(n)) m.set(n, []); m.get(n).push(f); }
        groups = [...m].map(([name, fs2]) => ({ name, feats: fs2 }));
      }
    }
    for (const g of groups) towns.push({ code5, name: g.name, feats: g.feats });
  }
  const merged = new Map();
  for (const t of towns) { const k = `${t.code5}|${t.name}`; if (merged.has(k)) merged.get(k).feats.push(...t.feats); else merged.set(k, t); }
  const pop = new Map();
  for (const t of merged.values()) {
    const sArea = t.feats.map((f) => f.sArea).sort()[0];
    pop.set(`tw-${t.code5}-${sArea}`, t.feats.reduce((s, f) => s + f.jinko, 0));
  }
  return { pop, features: feats.length };
}

// ---------- 名所の知名度(Wikidata の言語版の数) ----------
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
function sitelinksByQid() {
  const out = new Map();
  for (const rel of ['docs/landmarks/candidates.csv', 'docs/landmarks/extra.csv', 'docs/landmarks/extra-hand.csv', 'docs/tourism/candidates.csv']) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const head = rows.shift();
    const iq = head.indexOf('Wikidata'), is = head.indexOf('知名度(言語版の数)');
    if (iq < 0 || is < 0) continue;
    for (const r of rows) {
      const q = (r[iq] || '').trim(); if (!/^Q[0-9]+$/.test(q)) continue;
      const s = Number(r[is]); if (!Number.isFinite(s)) continue;
      out.set(q, Math.max(out.get(q) || 0, s));
    }
  }
  return out;
}

// ---------- 読む ----------
const t0 = Date.now();
const { pop: POP, features } = townPopulation(gmlDir);
const A = require('../server/map/all');
const { loadRegions } = require('../server/map/load');
const REG = loadRegions();
const prefOf = (regionId) => [regionId, ...REG.ancestors(regionId)].find((x) => REG.byId.get(x) && REG.byId.get(x).kind === 'state') || null;
const PUB = A.NODES.filter((n) => n.status === 'public' && !n.isPlayerNode);
const byId = new Map(A.NODES.map((n) => [n.id, n]));
const SL = sitelinksByQid();

// ---------- 種類 ----------
const HUB_AIRPORT_LEVEL = 500; // tools/levels.js の L.HUB_AIRPORT(国際線の拠点の空港 7 つ)
const isGovOffice = (n) => n.genre === 'government'; // 国会議事堂・都庁・都道府県庁舎・市区町村役場・区役所・国の機関の庁舎(2026-10-26: 全部専門)
const isPhantomPort = (n) => n.genre === 'port' && (n.id.startsWith('pp-') || ((n.routes || []).length > 0 && (n.routes || []).every((r) => r.phantom))); // 幻の航路でしかつながらない港(2026-10-26: 専門)
const catOf = (n) => {
  if (n.genre === 'town') return 'town';
  if (n.genre === 'station') return 'station';
  if (isGovOffice(n) || n.genre === 'university' || isPhantomPort(n) || (n.genre === 'airport' && n.level >= HUB_AIRPORT_LEVEL)) return 'fixed';
  if (n.genre === 'airport' || n.genre === 'port') return 'gw';
  return 'lm';
};
const CATS = {
  town: { name: '町・字', min: 1, max: 4 },
  station: { name: '駅', min: 1, max: 5 },
  lm: { name: '名所・観光地', min: 2, max: 5 },
  gw: { name: '空港・港', min: 4, max: 5 },
  fixed: { name: '専門に決め打ち(庁舎・役場・国の機関・大学・国際線の拠点の空港・幻の航路の港・国会)', min: 5, max: 5 },
};
const CAT_KEYS = Object.keys(CATS);

// 並べる数(大きいほど上)。key は配列で、前から順に比べる。label は人が読む用
const NATIONAL = /世界遺産|日本三景|特別名勝/;
const FALLBACK_FAME = (lv) => (lv >= 150 ? 60 : lv >= 70 ? 40 : lv >= 50 ? 25 : lv >= 30 ? 15 : lv >= 25 ? 8 : 3); // 知名度の無い名所(東京の手作り): 前の格 → 言語版の数の目安(tools/levels.js の fameLevel の逆)
const stats = { townNoPop: 0, lmNoFame: [], lmCity: [] };
const sumRoutes = (n, k) => (n.routes || []).reduce((s, r) => s + ((r.metrics && r.metrics[k]) || 0), 0);
for (const n of PUB) {
  n._cat = catOf(n);
  if (n._cat === 'town') {
    const p = POP.get(n.id);
    if (p === undefined) { stats.townNoPop++; n._pop = null; n._key = [-1]; n._label = '人口不明'; }
    else { n._pop = p; n._key = [p]; n._label = `人口 ${p.toLocaleString('ja-JP')}`; }
  }
}
for (const n of PUB) {
  if (n._cat === 'station') {
    const term = terminalOf(prefOf(n.region), n.name);
    const lines = (n.lines || []).length;
    const eff = term >= 4 ? 100 : term === 3 ? Math.max(lines, 5) : lines; // 主要駅はいちばん上、地域の主要な乗り換え駅は 5 路線と同じ(tools/levels.js の stationLevel と同じ考え)
    const around = (n.adj || []).filter((id) => id.startsWith('tw-')).reduce((s, id) => s + (POP.get(id) || 0), 0); // つながっているまわりの町・字(駅のある町を含む)の人口の合計
    n._key = [eff, around]; n._around = around;
    n._label = `${lines} 路線${term ? `(主要駅 ${term})` : ''}・まわりの人口 ${around.toLocaleString('ja-JP')}`;
  } else if (n._cat === 'lm') {
    const qid = (n.codes && n.codes.wikidata) || null;
    let fame = qid && SL.has(qid) ? SL.get(qid) : null;
    if (fame === null) { fame = FALLBACK_FAME(n.level); stats.lmNoFame.push(n); }
    const tags = (n.tags || []).slice(1);
    const desig = tags.some((t) => NATIONAL.test(t)) ? 2 : tags.length ? 1 : 0;
    // 指定(tools/levels.js の観光地の決まり): 世界遺産・日本三景・特別名勝は知名度 40 以上と同じ(いちばん上の段の物差し)、ほかの指定・百選は 15 以上と同じ
    const eff = desig === 2 ? Math.max(fame, 40) : desig === 1 ? Math.max(fame, 15) : fame;
    if (n.genre === 'government') stats.lmCity.push(n);
    n._key = [eff, desig, n.level, n.links]; n._fame = fame; // 同じなら 指定 → 前の格(各県で一番の城・観光地など)→ つながりの本数
    n._label = `知名度 ${fame}${qid && SL.has(qid) ? '' : '(前の格から)'}${desig ? `・${tags.join('/')}` : ''}`;
  } else if (n._cat === 'gw') {
    if (n.genre === 'airport') { const v = sumRoutes(n, 'passengers'); n._sub = 'airport'; n._key = [v > 0 ? 1 : 0, v, n.links]; n._label = v > 0 ? `旅客 ${v.toLocaleString('ja-JP')} 人/年` : `旅客の記録なし・つながり ${n.links}`; }
    else { const v = sumRoutes(n, 'flights'); n._sub = 'port'; n._key = [v > 0 ? 1 : 0, v, n.links]; n._label = v > 0 ? `${v.toLocaleString('ja-JP')} 便/年` : `便数の記録なし・つながり ${n.links}`; }
  } else if (n._cat === 'fixed') {
    // 国会 → 都庁 → 国際線の拠点の空港(旅客数) → 都道府県庁舎 → 大学(知名度) → 役場・区役所・国の機関 → 幻の航路の港
    const isPref = n.genre === 'government' && n.level >= 400;
    const rank = n.name === '国会議事堂' && n.level >= 777 ? 7 : n.genre === 'government' && n.level >= 600 ? 6 : n.genre === 'airport' ? 5 : isPref ? 4 : n.genre === 'university' ? 3 : n.genre === 'government' ? 2 : 1;
    const qid = (n.codes && n.codes.wikidata) || null; const fame = qid && SL.has(qid) ? SL.get(qid) : 0;
    n._key = [rank, n.genre === 'airport' ? sumRoutes(n, 'passengers') : fame, n.links];
    n._label = n.genre === 'airport' ? `国際線の拠点の空港・旅客 ${sumRoutes(n, 'passengers').toLocaleString('ja-JP')} 人/年` : rank === 7 ? '国会議事堂' : rank === 6 ? '首都の庁舎' : rank === 4 ? '都道府県庁舎' : rank === 3 ? `大学・知名度 ${fame}` : rank === 2 ? '役場・区役所・国の機関' : '幻の航路の港';
  }
}
const cmpKey = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (b[i] || 0) - (a[i] || 0); if (d) return d; } return 0; };
const sameKey = (a, b) => cmpKey(a, b) === 0;

// 種類ごとに大きい順に並べ、同じ数のまとまり(group)を作る。空港と港は別々に並べ、上からの割合で 1 つの列にまぜる
const lists = {};
for (const c of CAT_KEYS) {
  const nodes = PUB.filter((n) => n._cat === c);
  const subs = c === 'gw' ? ['airport', 'port'] : [null];
  for (const s of subs) {
    const L = nodes.filter((n) => (s ? n._sub === s : true)).sort((a, b) => cmpKey(a._key, b._key) || a.id.localeCompare(b.id));
    let g = -1;
    L.forEach((n, i) => {
      if (i === 0 || !sameKey(L[i - 1]._key, n._key)) g++;
      n._group = `${c}:${s || ''}:${g}`;
    });
    // 上からの割合(まとまりの真ん中)
    const groups = new Map();
    L.forEach((n, i) => { const x = groups.get(n._group) || { first: i, last: i }; x.last = i; groups.set(n._group, x); });
    for (const n of L) { const x = groups.get(n._group); n._p = (x.first + x.last + 1) / 2 / L.length; }
  }
  lists[c] = nodes.sort((a, b) => a._p - b._p || cmpKey(a._key, b._key) || a.id.localeCompare(b.id));
}

// ---------- 種類 × 段 の件数(反復比例調整) ----------
const TOTAL = PUB.length;
const target = TIERS.map((t) => t.share * TOTAL);
const rows = CAT_KEYS.map((c) => lists[c].length);
let M = CAT_KEYS.map((c) => TIERS.map((t) => (t.k >= CATS[c].min && t.k <= CATS[c].max ? t.share : 0)));
for (let it = 0; it < 5000; it++) {
  M = M.map((r, i) => { const s = r.reduce((a, b) => a + b, 0); return r.map((v) => (s ? (v * rows[i]) / s : 0)); });
  const col = TIERS.map((_, j) => M.reduce((a, r) => a + r[j], 0));
  M = M.map((r) => r.map((v, j) => (col[j] ? (v * target[j]) / col[j] : 0)));
}
// 種類ごとの段の件数(上の段から累計で丸める)
const plan = {};
CAT_KEYS.forEach((c, i) => {
  const cnt = {}; let cum = 0, prev = 0;
  for (let j = TIERS.length - 1; j >= 0; j--) { cum += M[i][j]; const r = Math.round(cum); cnt[TIERS[j].k] = r - prev; prev = r; }
  cnt[CATS[c].min] += rows[i] - prev; // 端数の残り(行の合計に合わせる)
  plan[c] = cnt;
});

// ---------- 段に配る ----------
const split = []; // 境目をまたいだ同じ数のまとまり
for (const c of CAT_KEYS) {
  const L = lists[c];
  const bounds = []; let cum = 0; // 上の段から [段, 何件目まで]
  for (let k = 5; k >= 1; k--) { cum += plan[c][k] || 0; bounds.push({ k, end: cum }); }
  const tierAt = (pos) => bounds.find((b) => pos < b.end).k;
  const groups = new Map();
  L.forEach((n, i) => { const x = groups.get(n._group) || { first: i, last: i, nodes: [] }; x.last = Math.max(x.last, i); x.first = Math.min(x.first, i); x.nodes.push(n); groups.set(n._group, x); });
  for (const x of groups.values()) {
    const k = tierAt(Math.floor((x.first + x.last) / 2));
    if (tierAt(x.first) !== tierAt(x.last)) split.push({ c, size: x.nodes.length, label: x.nodes[0]._label + (c === 'lm' ? '・前の格 ' + x.nodes[0].level + '・つながり ' + x.nodes[0].links : ''), from: tierAt(x.first), to: tierAt(x.last), k });
    for (const n of x.nodes) n._tier = k;
  }
}

// 段の中のレベル: 種類ごとに、その段の中の順位で均等に(同じ数のまとまりは、まとまりの先頭の順位で)
for (const c of CAT_KEYS) {
  for (const t of TIERS) {
    const L = lists[c].filter((n) => n._tier === t.k);
    const m = t.hi - t.lo + 1;
    let first = 0;
    L.forEach((n, i) => {
      if (i > 0 && L[i - 1]._group !== n._group) first = i;
      n._new = t.hi - Math.floor((first * m) / L.length);
    });
  }
}
const kokkai = PUB.find((n) => n.genre === 'government' && n.level === 777);
if (kokkai) kokkai._new = 90;

// ---------- 書き出す(下書き) ----------
const ids = PUB.map((n) => n.id).sort();
const json = '{\n' + ids.map((id) => `${JSON.stringify(id)}:${byId.get(id)._new}`).join(',\n') + '\n}\n';
fs.writeFileSync(OUT_JSON, json);

// ---------- まとめ ----------
const fmt = (x) => x.toLocaleString('ja-JP');
const pct = (a, b) => `${((a / b) * 100).toFixed(2)}%`;
const tierCount = TIERS.map((t) => PUB.filter((n) => n._tier === t.k).length);
const catTier = {}; for (const c of CAT_KEYS) catTier[c] = TIERS.map((t) => lists[c].filter((n) => n._tier === t.k).length);
const levelCount = Array.from({ length: 91 }, () => 0); for (const n of PUB) levelCount[n._new]++;

// 人口の確かめ: 出した人口で townLevel が今の level と同じか
const towns = lists.town;
const mismatch = towns.filter((n) => n._pop !== null && townLevel(n._pop) !== n.level);

// 開始地点(server/world.js の startable: 町・字か、レベル 10 以下の駅)
const startOld = PUB.filter((n) => n.hackable !== false && (n.genre === 'town' || (n.genre === 'station' && n.level <= 10)));
const startOldIntro = startOld.filter((n) => n._tier === 1);
const stIntro = PUB.filter((n) => n.genre === 'station' && n._tier === 1);
const startNew10 = PUB.filter((n) => n.hackable !== false && (n.genre === 'town' || (n.genre === 'station' && n._new <= 10)));

// 境目(種類 × 段 の、並べる数の範囲)
const rangeOf = (c, k) => { const L = lists[c].filter((n) => n._tier === k); return L.length ? { top: L[0], bottom: L[L.length - 1], n: L.length } : null; };
const areaOf = (n) => n.area || '';
// 例: 種類 × 段 の、上・真ん中・下
const examples = (c, k) => { const L = lists[c].filter((n) => n._tier === k); if (!L.length) return []; const pick = [...new Set([0, Math.floor(L.length / 2), L.length - 1])]; return pick.map((i) => L[i]); };

const lines = [];
const out = (s = '') => lines.push(s);
out('# 拠点のレベルの付け直し(1〜90)の下書き');
out();
out('`node tools/level100-nodes.js <GML のフォルダ>` が作る(2026-10-26 ユーザー決定に沿った計算の下書き。拠点マスター・DB・ゲームはまだ変えていない)。');
out('id → 新しいレベル の一覧は `docs/level100-nodes-draft.json`。何度流しても同じ結果になる。');
out();
out('## 1. 計算のしかた');
out();
out('- 対象: 公開の全拠点 ' + fmt(TOTAL) + ' 件(占領できない名所 ' + fmt(PUB.filter((n) => n.hackable === false).length) + ' 件も含む。非公開は付けない)');
out('- 種類と並べる数:');
out('  - 町・字: 人口(国勢調査 2020 の小地域。`tools/import-towns.js` と同じまとめ方で拠点 id ごとに足した)');
out('  - 駅: 乗り入れる路線の数(主要駅 4〜5 はいちばん上、地域の主要な乗り換え駅 3 は 5 路線と同じ。`tools/levels.js` の TERMINALS_BY_PREF)→ 同じなら、駅とつながっている町・字(駅のある町を含む)の人口の合計');
out('  - 名所・観光地: 知名度(Wikidata の言語版の数。`docs/landmarks/*.csv` と `docs/tourism/candidates.csv`)。同じなら 指定の有無 → 前の格(各県で一番の城・観光地など)→ つながりの本数。指定のある観光地は、世界遺産・日本三景・特別名勝を知名度 40 以上、ほかの指定・百選を 15 以上と同じに扱う(`tools/levels.js` の観光地の決まりと同じ物差し)。知名度の無いもの ' + stats.lmNoFame.length + ' 件(東京の手作りの名所など)は前の格から目安の知名度を出した。市役所 ' + stats.lmCity.length + ' 件(genre government で格 15)はここに入れた');
out('  - 空港・港: 空港は 1 年間の旅客数、港は 1 年間の便数(航路の記録の metrics の合計)。記録の無いものは記録のあるものの下に、つながりの本数で並べる。空港と港は別々に並べ、上からの割合で 1 つにまぜた');
out('  - 庁舎・国際線の拠点の空港・国会: 決め打ちで専門(国会 → 都庁 → 国際線の拠点の空港 7 つ(旅客数の順)→ 都道府県庁舎)。国会議事堂は 90');
out('- 入れてよい段: 町・字 入門〜上級 / 駅 入門〜専門 / 名所・観光地 初級〜専門 / 空港・港 中級〜専門 / 庁舎ほか 専門');
out('- 境目: 種類 × 段 の件数の表を、目標の割合(入れない段は 0)から出発して、種類ごとの件数と段ごとの目標の件数に交互に合わせて決めた(反復比例調整)。その件数を、種類の中で大きい順に上から配る。同じ数のまとまり(同じ人口の町など)が境目をまたぐときは、まとまりの真ん中がある段に全部入れる');
out('- 段の中のレベル: 種類ごとに、その段に入った拠点を順位で均等に割り振る(同じ数のまとまりは同じレベル)');
out();
out('## 2. 段ごとの件数と割合');
out();
out('| 段 | レベル | 件数 | 割合 | 目標 | 目標の件数 | 差 |');
out('|---|---|---:|---:|---:|---:|---:|');
for (const t of [...TIERS].reverse()) { const i = t.k - 1; out(`| ${t.name} | ${t.lo}〜${t.hi} | ${fmt(tierCount[i])} | ${pct(tierCount[i], TOTAL)} | ${(t.share * 100).toFixed(0)}% | ${fmt(Math.round(target[i]))} | ${tierCount[i] - Math.round(target[i]) >= 0 ? '+' : ''}${fmt(tierCount[i] - Math.round(target[i]))} |`); }
out(`| 計 | | ${fmt(TOTAL)} | 100% | | | |`);
out();
out('## 3. 種類 × 段');
out();
out('| 種類 | 件数 | 入門 | 初級 | 中級 | 上級 | 専門 |');
out('|---|---:|---:|---:|---:|---:|---:|');
for (const c of CAT_KEYS) out(`| ${CATS[c].name} | ${fmt(lists[c].length)} | ${catTier[c].map((v) => (v ? `${fmt(v)}(${((v / lists[c].length) * 100).toFixed(1)}%)` : '–')).join(' | ')} |`);
out(`| 計 | ${fmt(TOTAL)} | ${tierCount.map(fmt).join(' | ')} |`);
out();
out('空港と港の内訳:');
out();
out('| | 件数 | 中級 | 上級 | 専門 |');
out('|---|---:|---:|---:|---:|');
for (const s of ['airport', 'port']) { const L = lists.gw.filter((n) => n._sub === s); out(`| ${s === 'airport' ? '空港(国際線の拠点の 7 つを除く)' : '港'} | ${L.length} | ${[3, 4, 5].map((k) => L.filter((n) => n._tier === k).length).join(' | ')} |`); }
out();
out('## 4. 各段の境目(種類ごとの、その段に入った拠点の並べる数の範囲)');
out();
out('| 種類 | 段 | 件数 | いちばん上 | いちばん下 |');
out('|---|---|---:|---|---|');
for (const c of CAT_KEYS) for (const t of [...TIERS].reverse()) { const r = rangeOf(c, t.k); if (r) out(`| ${CATS[c].name} | ${t.name} | ${fmt(r.n)} | ${r.top._label} | ${r.bottom._label} |`); }
out();
{
  const T = (k) => rangeOf('town', k);
  out(`町・字の人口の境目: 上級 ${fmt(T(4).bottom._pop)} 人以上 / 中級 ${fmt(T(3).bottom._pop)} 人以上 / 初級 ${fmt(T(2).bottom._pop)} 人以上 / 入門 それ未満(${fmt(T(1).top._pop)} 人以下)。`);
  out();
}
out('## 5. レベルごとの件数');
out();
out('| レベル | 件数 | レベル | 件数 | レベル | 件数 | レベル | 件数 | レベル | 件数 |');
out('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (let r = 0; r < 18; r++) { const cells = []; for (let col = 0; col < 5; col++) { const lv = col * 18 + r + 1; cells.push(lv <= 90 ? `${lv} | ${fmt(levelCount[lv])}` : ' | '); } out(`| ${cells.join(' | ')} |`); }
out();
out('## 6. 例(種類 × 段 の、上・真ん中・下)');
out();
out('| 種類 | 段 | 名前 | 市区町村 | 今の格 | 新しいレベル | 並べた数 |');
out('|---|---|---|---|---:|---:|---|');
for (const c of CAT_KEYS) for (const t of [...TIERS].reverse()) for (const n of examples(c, t.k)) out(`| ${CATS[c].name} | ${t.name} | ${n.name} | ${areaOf(n)} | ${n.level} | ${n._new} | ${n._label} |`);
out();
out('## 7. 開始地点にできる拠点(server/world.js の startable)');
out();
out(`- いまの決まり(町・字か、今の格 10 以下の駅)で開始地点にできる拠点 ${fmt(startOld.length)} 件のうち、新しいレベルで入門(1〜15)は ${fmt(startOldIntro.length)} 件(町・字 ${fmt(startOldIntro.filter((n) => n.genre === 'town').length)}、駅 ${fmt(startOldIntro.filter((n) => n.genre === 'station').length)})`);
out(`- 入門の駅は ${fmt(stIntro.length)} 件(駅全体の ${pct(stIntro.length, lists.station.length)})`);
out(`- 決まりの「レベル 10 以下の駅」を新しいレベルで読むと、開始地点にできるのは ${fmt(startNew10.length)} 件(駅 ${fmt(startNew10.filter((n) => n.genre === 'station').length)})。町・字はレベルに関係なく開始地点にできるので、上級(61〜78)の町 ${fmt(catTier.town[3])} 件も開始地点のまま`);
out();
out('## 8. 人口の確かめ');
out();
out(`- GML の区画 ${fmt(features)}(陸)から、町・字の拠点 ${fmt(towns.length)} 件のうち ${fmt(towns.length - stats.townNoPop)} 件の人口を出せた(出せない ${stats.townNoPop} 件)`);
out(`- 出した人口で \`tools/levels.js\` の townLevel を求めると、今の level(1〜9)と一致しないのは ${fmt(mismatch.length)} 件${mismatch.length ? `(例: ${mismatch.slice(0, 5).map((n) => `${n.name} ${n.area} 人口 ${n._pop} → ${townLevel(n._pop)}、今 ${n.level}`).join(' / ')})` : ''}`);
out();
out('## 9. 気になる点');
out();
const nonTown = TOTAL - lists.town.length;
out(`- **専門(5%、${fmt(tierCount[4])} 件)は町・字を入れられないので、町・字以外 ${fmt(nonTown)} 件の ${pct(tierCount[4], nonTown)} が専門になる**。駅の ${pct(catTier.station[4], lists.station.length)}、名所・観光地の ${pct(catTier.lm[4], lists.lm.length)}、空港・港の ${pct(catTier.gw[4], lists.gw.length)} が専門。駅の専門のいちばん下は「${rangeOf('station', 5).bottom._label}」で、1 路線のふつうの駅も多く専門に入る(${fmt(lists.station.filter((n) => n._tier === 5 && (n.lines || []).length <= 1).length)} 件)。専門の割合を下げるか、町・字の大きい町を専門に入れてよいことにするか、決めてもらう材料`);
out(`- 港には仮の港(pp-、${PUB.filter((n) => n.id.startsWith('pp-')).length} 件)と便数の記録の無い港が多く、空港・港は中級より下に置けないので、記録の無い港も中級以上になる(港の中級 ${lists.gw.filter((n) => n._sub === 'port' && n._tier === 3).length} 件のうち記録なし ${lists.gw.filter((n) => n._sub === 'port' && n._tier === 3 && n._key[0] === 0).length} 件)`);
{
  const ports = lists.gw.filter((n) => n._sub === 'port');
  const topPort = ports.slice().sort((a, b) => cmpKey(a._key, b._key))[0];
  const osanbashi = PUB.find((n) => n.name === '大さん橋');
  out(`- 港は 1 年間の便数で並べるので、短い渡し船の多い港が上に来る(いちばん上は ${topPort.name}(${topPort.area})${topPort._label})。航路の記録の無い大きな港は下になる${osanbashi ? `(${osanbashi.name}(${osanbashi.area})は ${osanbashi._label} でレベル ${osanbashi._new})` : ''}`);
}
{
  const bigSplit = split.filter((s) => s.size >= 2).sort((a, b) => b.size - a.size);
  out(`- 同じ数のまとまりが段の境目をまたいだもの ${split.length} 組(真ん中のある段に全部入れた)。大きいもの: ${bigSplit.slice(0, 6).map((s) => `${CATS[s.c].name}「${s.label}」${s.size} 件(${TIERS[s.from - 1].name}〜${TIERS[s.to - 1].name} → ${TIERS[s.k - 1].name})`).join('、') || 'なし'}。このため段の件数が目標から少しずれる`);
}
out(`- 人口 0 の町・字 ${fmt(towns.filter((n) => n._pop === 0).length)} 件は全部同じまとまりで入門の下の方(レベル ${[...new Set(towns.filter((n) => n._pop === 0).map((n) => n._new))].join('・')})`);
out(`- 町・字は上級まで入るので、人口 ${fmt(rangeOf('town', 4).bottom._pop)} 人以上の町(${fmt(catTier.town[3])} 件)は上級(61〜78)。いまの開始地点の決まり(町・字はどれでも開始地点)のままだと、上級の町から始められる`);
out(`- 名所の知名度は言語版の数なので、同じ数の名所が多い(知名度 ${(() => { const m = new Map(); for (const n of lists.lm) m.set(n._fame, (m.get(n._fame) || 0) + 1); const top = [...m].sort((a, b) => b[1] - a[1])[0]; return `${top[0]} が ${top[1]} 件`; })()})。知名度と指定が同じなら前の格 → つながりの本数で並べた(名所のつながりの本数は前の格から決まる部分がある。tools/levels.js の landmarkLinkCount)。それでも同じものは同じレベルなので、段の中のレベルが飛び飛びになるところがある`);
out(`- 段の中のレベルは種類ごとに均等に割るので、同じレベルでも種類によって大きさの物差しが違う(例: 専門の 90 には国会・都庁・国際線の空港と、駅・名所・空港・港の各上位が並ぶ)`);
fs.writeFileSync(OUT_MD, lines.join('\n') + '\n');

// ---------- 標準出力 ----------
console.log(`公開の拠点 ${fmt(TOTAL)} 件(町・字の人口: GML の区画 ${fmt(features)} から。${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
for (const t of [...TIERS].reverse()) { const i = t.k - 1; console.log(`  ${t.name} ${t.lo}〜${t.hi}: ${fmt(tierCount[i])} 件 ${pct(tierCount[i], TOTAL)}(目標 ${fmt(Math.round(target[i]))}、差 ${tierCount[i] - Math.round(target[i])})`); }
console.log('種類 × 段(入門 初級 中級 上級 専門):');
for (const c of CAT_KEYS) console.log(`  ${CATS[c].name.padEnd(8)} ${catTier[c].map((v) => String(v).padStart(6)).join(' ')}`);
console.log(`町・字の人口の確かめ: 人口を出せない ${stats.townNoPop} 件、townLevel が今の level と違う ${mismatch.length} 件`);
console.log(`開始地点(いまの決まり)${fmt(startOld.length)} 件のうち入門 ${fmt(startOldIntro.length)} 件`);
console.log(`書いた: ${path.relative(ROOT, OUT_JSON)}(${(fs.statSync(OUT_JSON).size / 1024 / 1024).toFixed(1)} MB)、${path.relative(ROOT, OUT_MD)}`);
