'use strict';
// 拠点の形(1〜100。public/shapes100.js)の一覧を SVG の絵にする(2026-10-23。スマホで見てもらう用)。
// 画面と同じ描き方の関数を、canvas の代わりに SVG の道を書き出す小さな入れ物で動かす
// 使い方: node tools/shapes100-svg.js → docs/shapes100.svg
const fs = require('fs');
const path = require('path');
const S = require('../public/shapes100');

function svgContext(out) {
  let d = '', dash = null;
  const f = (v) => Number(v.toFixed(2));
  return {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    beginPath() { d = ''; },
    moveTo(x, y) { d += `M${f(x)} ${f(y)}`; },
    lineTo(x, y) { d += `L${f(x)} ${f(y)}`; },
    closePath() { d += 'Z'; },
    arc(x, y, r) { d += `M${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)}Z`; },
    rect(x, y, w, h) { d += `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`; },
    roundRect(x, y, w, h, r) { d += `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`; },
    setLineDash(a) { dash = a && a.length ? a.join(' ') : null; },
    fill() { out.push(`<path d="${d}" fill="${this.fillStyle}" fill-rule="evenodd"/>`); },
    stroke() { out.push(`<path d="${d}" fill="none" stroke="${this.strokeStyle}" stroke-width="${this.lineWidth}" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`); },
  };
}

const COLS = 10, CW = 100, CH = 74, HEAD = 34, R = 12;
const out = [];
let y = 60;
out.push('<text x="16" y="34" font-size="20" font-weight="700" fill="#16202C">拠点の形一覧(1〜100の案)  左: 持ち主なし  右: 持ち主の色の例</text>');
for (const [name, lo, hi] of S.STAGES) {
  out.push(`<text x="16" y="${y + 22}" font-size="16" font-weight="700" fill="#16202C">${name}(Lv${lo}〜${hi})</text>`);
  y += HEAD;
  let i = 0;
  for (let lv = lo; lv <= hi; lv++, i++) {
    const col = i % COLS, row = Math.floor(i / COLS);
    const x0 = 12 + col * CW, y0 = y + row * CH;
    out.push(`<rect x="${x0}" y="${y0}" width="${CW - 6}" height="${CH - 6}" rx="8" fill="#FFFFFF" stroke="#E3E8EE"/>`);
    const r = R * S.sizeScale(lv);
    for (const [cx, stroke] of [[x0 + 25, '#8A97A6'], [x0 + 68, '#D7263D']]) {
      const ctx = svgContext(out);
      S.draw(ctx, lv, { x: cx, y: y0 + 26 }, r, { fill: '#FFFFFF', stroke, lineWidth: 2 });
    }
    out.push(`<text x="${x0 + (CW - 6) / 2}" y="${y0 + 60}" font-size="12" text-anchor="middle" fill="#16202C">Lv${lv}</text>`);
  }
  y += Math.ceil((hi - lo + 1) / COLS) * CH + 8;
}
const W = 12 + COLS * CW + 6, H = y + 10;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif"><rect width="100%" height="100%" fill="#EEF2F6"/>${out.join('')}</svg>`;
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'shapes100.svg'), svg);
console.log(`docs/shapes100.svg を書いた(${W}×${H})`);
