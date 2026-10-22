'use strict';
// 川の元データを国土地理院の最適化ベクトルタイル(地理院地図Vector の元データ)から取ってくる(2026-10-22 ユーザー決定: 地図に川を足す)。
// 国土数値情報の河川データ(W05)は「非商用」なので使わない。地理院のタイルは国土地理院コンテンツ利用規約(公共データ利用規約 第 1.0 版)で、
// 出典と加工した旨を書けば使える(道路中心線 src-gsi-rdcl と同じ規約)。
//
// 使い方:
//   node tools/fetch-gsi-rivers.js <保存先フォルダ>
// 陸地(public/data/bounds/japan.json の区・市の範囲)にかかる z11 のタイル(約 2,400 枚)を <保存先>/11/<x>/<y>.pbf に取る。
// 取ってあるタイルは取り直さない(途中で止めても続きから)。地理院のサーバーに負担をかけないよう 1 枚ずつ、間を空けて取る。
// z11 には主な川の中心線(RvrCL)と、幅の広い川・湖の水面(WA)が入っている。z14 以上の細い水路まで取ると全国で約 10 万枚になるので取らない
const fs = require('fs');
const path = require('path');
const https = require('https');

const [, , OUT] = process.argv;
if (!OUT) { console.error('使い方: node tools/fetch-gsi-rivers.js <保存先フォルダ>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const Z = 11, N = 2 ** Z, WAIT_MS = 300;
const URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const tx = (lon) => Math.floor(((lon + 180) / 360) * N);
const ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N); };

// 陸地にかかるタイル(区・市の輪ごとの範囲で選ぶ。海だけのタイルは取らない)
const J = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/bounds/japan.json'), 'utf8'));
const tiles = new Set();
for (const g of Object.values(J.regions)) for (const ring of g.polys) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [lo, la] of ring) { if (lo < a) a = lo; if (lo > c) c = lo; if (la < b) b = la; if (la > d) d = la; }
  for (let x = tx(a); x <= tx(c); x++) for (let y = ty(d); y <= ty(b); y++) tiles.add(`${x}/${y}`);
}

const get = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'packet-conquest-import (river data, low rate)' } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = [...tiles].sort();
  let got = 0, skip = 0, empty = 0, fail = 0;
  for (const [i, t] of list.entries()) {
    const [x, y] = t.split('/');
    const file = path.join(OUT, String(Z), x, `${y}.pbf`);
    if (fs.existsSync(file)) { skip++; continue; }
    let r = null;
    for (let k = 0; k < 3 && !r; k++) { try { r = await get(URL(Z, x, y)); } catch { await sleep(2000); } }
    if (!r) { fail++; continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (r.status === 200) { fs.writeFileSync(file, r.body); got++; }
    else if (r.status === 404) { fs.writeFileSync(file, Buffer.alloc(0)); empty++; } // データの無いタイル(海の上など)。空のファイルで「取った」と覚える
    else fail++;
    if ((i + 1) % 200 === 0) console.log(`  … ${i + 1}/${list.length}(取った ${got}、無し ${empty}、失敗 ${fail})`);
    await sleep(WAIT_MS);
  }
  console.log(`z${Z} のタイル ${list.length} 枚: 取った ${got}、取ってあった ${skip}、データ無し ${empty}、失敗 ${fail}`);
})();
