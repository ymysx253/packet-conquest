'use strict';
// 本番(Azure App Service の Linux)で使う Node.js 本体を取ってきて runtime/node/ に置く(2026-10-26)。
// App Service の組み込みの「Node 24 LTS」は細かい版を選べず古いまま(2026-10-26 に v24.7.0。セキュリティ修正が入っていない)なので、
// 公式の Linux 版を zip に同梱し、スタートアップ コマンドでそれを使って起動する(docs/DEPLOY.md)。
//
// 使い方: node tools/fetch-node-runtime.js [版]      例: node tools/fetch-node-runtime.js 24.22.1
//   1. nodejs.org から SHASUMS256.txt と node-v<版>-linux-x64.tar.xz を取る(HTTPS)
//   2. SHA-256 を SHASUMS256.txt と照らす(合わなければ止めて消す)
//   3. 取ったファイルは別のフォルダー(runtime/download/)に置き、bin/node と LICENSE だけを runtime/node/ に取り出す
// runtime/ は Git に入れない(.gitignore)。make-zip.cmd が zip に入れる。
// 新しいセキュリティリリースが出たら、版を変えてこれを流し直し、zip を作り直して置くだけでよい
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = (process.argv[2] || '24.22.1').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) { console.error(`版の形が違う: ${VERSION}`); process.exit(1); }
const BASE = `https://nodejs.org/dist/v${VERSION}/`;
const FILE = `node-v${VERSION}-linux-x64.tar.xz`;
const ROOT = path.join(__dirname, '..', 'runtime');
const DL = path.join(ROOT, 'download');
const OUT = path.join(ROOT, 'node');

function get(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const chunks = []; let n = 0;
      res.on('data', (c) => { chunks.push(c); n += c.length; if (n > 200 * 1024 * 1024) { res.destroy(); reject(new Error('大きすぎる')); } });
      res.on('end', () => { const buf = Buffer.concat(chunks); if (dest) fs.writeFileSync(dest, buf); resolve(buf); });
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(DL, { recursive: true });
  console.log(`Node.js v${VERSION}(Linux x64)を ${BASE} から取ります`);
  const sums = (await get(BASE + 'SHASUMS256.txt', path.join(DL, 'SHASUMS256.txt'))).toString('utf8');
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${FILE}`));
  if (!line) throw new Error(`SHASUMS256.txt に ${FILE} が無い`);
  const want = line.trim().split(/\s+/)[0];
  const tarPath = path.join(DL, FILE);
  const buf = await get(BASE + FILE, tarPath);
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== want) { fs.rmSync(tarPath, { force: true }); throw new Error(`SHA-256 が合わない(公式 ${want} / 取ったもの ${got})。消しました`); }
  console.log(`SHA-256 一致: ${got}(${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  // 取り出す(Windows の tar.exe は xz を読める)。bin/node と LICENSE だけ
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });
  const top = `node-v${VERSION}-linux-x64`;
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-x', '-f', tarPath, '-C', DL, `${top}/bin/node`, `${top}/LICENSE`], { stdio: 'inherit' });
  fs.renameSync(path.join(DL, top, 'bin', 'node'), path.join(OUT, 'bin', 'node'));
  fs.renameSync(path.join(DL, top, 'LICENSE'), path.join(OUT, 'LICENSE'));
  fs.rmSync(path.join(DL, top), { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'VERSION'), `v${VERSION}\nsha256 ${FILE} ${want}\nfetched ${new Date().toISOString()}\n`);
  console.log(`runtime/node/bin/node に置きました(v${VERSION})。make-zip.cmd で zip に入ります`);
})().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
