'use strict';
// 形の一覧ページ(shapes.html)の描画。CSP でインライン スクリプトを禁じるため別ファイルにしている(SECURITY.md F5)
(() => {
  const S = window.PCShapes;
  const css = getComputedStyle(document.documentElement);
  const stroke = css.getPropertyValue('--line-strong').trim();
  const fill = css.getPropertyValue('--surface').trim();
  const dpr = window.devicePixelRatio || 1;

  function canvasFor(level, size, r) {
    const cv = document.createElement('canvas');
    cv.width = size * dpr; cv.height = size * dpr; cv.style.width = `${size}px`; cv.style.height = `${size}px`;
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.draw(c, level, { x: size / 2, y: size / 2 + (level > 10 ? 6 : 0) }, r, { fill, stroke, lineWidth: 3 });
    return cv;
  }
  function cellFor(lv, size, r) {
    const d = S.describe(lv);
    const cell = document.createElement('div'); cell.className = 'cell' + (d.shape === 10 && d.frame === 0 && d.rings === 0 && !d.filled ? ' country' : '');
    const lab = document.createElement('div'); lab.className = 'lv'; lab.textContent = `Lv${lv}`;
    cell.title = `${S.SHAPE_NAMES[d.shape]} / ${d.filled ? '黒塗り' : '白抜き'} / 外輪 ${d.rings} 本 / 外枠: ${S.FRAME_NAMES[d.frame]}`;
    cell.append(canvasFor(lv, size, r), lab);
    return cell;
  }

  const basic = document.getElementById('basic');
  for (let lv = 1; lv <= 10; lv++) {
    const card = document.createElement('div'); card.className = 'card';
    const text = document.createElement('div');
    const a = document.createElement('div'); a.className = 'lv'; a.textContent = `Lv${lv}`;
    const b = document.createElement('div'); b.className = 'nm'; b.textContent = S.SHAPE_NAMES[lv];
    const q = document.createElement('div'); q.className = 'q'; q.textContent = `問題: ${S.QUESTION_NAMES[lv]}`;
    text.append(a, b, q);
    card.append(canvasFor(lv, 72, 18), text);
    basic.append(card);
  }

  const ext = document.getElementById('ext');
  for (let lv = 11; lv <= 100; lv++) ext.append(cellFor(lv, 96, 12));

  // 101〜999 は百の位ごとに見本(各 10 個)。ボタンで全部出す
  const ext2 = document.getElementById('ext2');
  const SAMPLE = [1, 12, 23, 34, 45, 56, 67, 78, 89, 100];
  function renderExt2(all) {
    ext2.replaceChildren();
    for (let h = 1; h <= 9; h++) {
      const levels = all ? Array.from({ length: 100 }, (_, i) => h * 100 + i + 1).filter((l) => l <= S.MAX_LEVEL) : SAMPLE.map((o) => h * 100 + o).filter((l) => l <= S.MAX_LEVEL);
      for (const lv of levels) ext2.append(cellFor(lv, 108, 12));
    }
  }
  renderExt2(false);
  document.getElementById('showAll').onclick = (e) => { renderExt2(true); e.target.disabled = true; e.target.textContent = '101〜999 をすべて表示中'; };
})();
