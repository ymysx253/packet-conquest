'use strict';
// .env(Git 管理外)から環境変数を読む。依存ライブラリなし。すでに設定されている変数は上書きしない。
// 本番(Azure App Service)ではアプリ設定が環境変数になるので、このファイルは無くてよい。
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
    out[key] = val;
  }
  return out;
}

module.exports = { loadEnv };
