'use strict';
// 拠点の形一覧(1〜100)のページ(shapes100.html)。形は shapes100.js
(() => {
  const S = window.PCShapes100;
  const css = getComputedStyle(document.documentElement);
  const tok = (n, d) => css.getPropertyValue(n).trim() || d;
  const surface = tok('--surface', '#FFFFFF'), gray = tok('--line-strong', '#8A97A6'), own = '#D7263D';
  const dpr = window.devicePixelRatio || 1;
  const BASE_R = 12; // ゲームの地図で拡大したときの大きさに近い
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return [c, x]; };
  const legend = document.getElementById('legend');
  for (const [k, v] of Object.entries(S.DECO_NAMES)) { const d = document.createElement('div'); d.textContent = `${k}0 台: ${v}`; legend.append(d); }
  const list = document.getElementById('list');
  for (const [name, lo, hi] of S.STAGES) {
    const h = document.createElement('h2'); h.textContent = `${name}(Lv${lo}〜${hi})`; list.append(h);
    const grid = document.createElement('div'); grid.className = 'grid'; list.append(grid);
    for (let lv = lo; lv <= hi; lv++) {
      const d = S.describe(lv), r = BASE_R * S.sizeScale(lv);
      const cell = document.createElement('div'); cell.className = 'cell';
      const [c, x] = canvas(88, 46);
      S.draw(x, lv, { x: 22, y: 23 }, r, { fill: surface, stroke: gray, lineWidth: 2 });
      S.draw(x, lv, { x: 66, y: 23 }, r, { fill: surface, stroke: own, lineWidth: 2 });
      const a = document.createElement('div'); a.className = 'lv'; a.textContent = `Lv${lv}`;
      const b = document.createElement('div'); b.className = 'nm'; b.textContent = `${S.SHAPE_NAMES[d.shape]}・${S.DECO_NAMES[d.deco]}`;
      cell.append(c, a, b); grid.append(cell);
    }
  }
})();
