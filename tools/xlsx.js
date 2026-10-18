'use strict';
// 最小限の xlsx 読み取り(依存なし)。展開済みのフォルダ(xl/sharedStrings.xml と xl/worksheets/sheetN.xml)から
// 行ごとの配列を返す。統計表の取り込み(tools/import-routes.js)専用で、書式・数式は扱わない。
// xlsx の展開は Windows の tar.exe(tar -xf file.xlsx -C dir)か unzip で行う。
const fs = require('fs');
const path = require('path');

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function sharedStrings(dir) {
  const f = path.join(dir, 'xl', 'sharedStrings.xml');
  if (!fs.existsSync(f)) return [];
  const xml = fs.readFileSync(f, 'utf8');
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
}

const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

// sheet は 1 始まり。戻り値は [[セルの値...], ...](空のセルは null)
function readSheet(dir, sheet = 1) {
  const ss = sharedStrings(dir);
  const xml = fs.readFileSync(path.join(dir, 'xl', 'worksheets', `sheet${sheet}.xml`), 'utf8');
  const rows = [];
  for (const r of xml.matchAll(/<row[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[2].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/t="(\w+)"/) || [])[1];
      const body = c[2] || '';
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = null;
      if (type === 's' && v !== undefined) val = ss[Number(v)];
      else if (type === 'inlineStr') val = unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      else if (type === 'str' && v !== undefined) val = unxml(v);
      else if (v !== undefined) val = Number(v);
      if (ref) row[colIndex(ref)] = val;
    }
    rows[Number(r[1]) - 1] = Array.from(row, (x) => (x === undefined ? null : x));
  }
  return Array.from(rows, (x) => x || []);
}

module.exports = { readSheet };
