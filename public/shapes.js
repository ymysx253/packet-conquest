'use strict';
// 拠点の形(設計書 8.8)。ゲーム画面(app.js)と形の一覧(shapes.html)で共有する。
// Lv1〜10 は固有の形。Lv11〜99 は「1の位の形 + 10の位ぶんの外輪(最大3本) + レベル番号」。国は Lv10。
(() => {
  const SHAPE_NAMES = {
    1: '円', 2: '角丸四角', 3: '三角形', 4: 'ひし形', 5: '五角形',
    6: '六角形', 7: '星(5点)', 8: '星(6点)', 9: '星(8点)', 10: '二重の星(国)',
  };
  // 設計書 3.2 の難易度との対応
  const QUESTION_NAMES = {
    1: '4択', 2: '15秒の4択', 3: '入力式', 4: '2問連続', 5: '経路表を読む',
    6: 'トラップを見抜く', 7: 'コマンドで到達確認', 8: 'ファイアウォール突破', 9: '経路を作って突破', 10: '複合トラップ(国)',
  };

  function polygon(c, p, r, k) {
    for (let i = 0; i < k; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / k;
      const x = p.x + r * Math.cos(a), y = p.y + r * Math.sin(a);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
  }
  function star(c, p, outer, inner, points) {
    for (let i = 0; i < points * 2; i++) {
      const rr = i % 2 === 0 ? outer : inner;
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const x = p.x + rr * Math.cos(a), y = p.y + rr * Math.sin(a);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
  }

  const SHAPES = {
    1: (c, p, r) => c.arc(p.x, p.y, r, 0, Math.PI * 2),
    2: (c, p, r) => { const s = r * 0.9; if (c.roundRect) c.roundRect(p.x - s, p.y - s, s * 2, s * 2, 5); else c.rect(p.x - s, p.y - s, s * 2, s * 2); },
    3: (c, p, r) => polygon(c, p, r * 1.25, 3),
    4: (c, p, r) => polygon(c, p, r * 1.2, 4),
    5: (c, p, r) => polygon(c, p, r * 1.12, 5),
    6: (c, p, r) => polygon(c, p, r * 1.08, 6),
    7: (c, p, r) => star(c, p, r * 1.35, r * 0.62, 5),
    8: (c, p, r) => star(c, p, r * 1.32, r * 0.72, 6),
    9: (c, p, r) => star(c, p, r * 1.3, r * 0.8, 8),
    10: (c, p, r) => star(c, p, r * 1.45, r * 0.62, 5),
  };
  const shapeIndex = (level) => ((Math.max(1, level) - 1) % 10) + 1;
  const ringCount = (level) => Math.min(3, Math.floor((Math.max(1, level) - 1) / 10));

  // 形のパスだけ作る(塗りや線は呼び出し側)
  function path(c, level, p, r) {
    c.beginPath();
    SHAPES[shapeIndex(level)](c, p, r);
  }
  // 形に足す飾り: Lv10 系は内側の星、Lv11 以上は外輪と番号
  function extras(c, level, p, r, color, surface) {
    if (shapeIndex(level) === 10) {
      c.beginPath(); star(c, p, r * 0.8, r * 0.34, 5);
      c.lineWidth = 2; c.strokeStyle = color; c.stroke();
    }
    const rings = ringCount(level);
    for (let i = 1; i <= rings; i++) {
      c.beginPath(); c.arc(p.x, p.y, r * 1.45 + 4 * i, 0, Math.PI * 2);
      c.lineWidth = 1.5; c.strokeStyle = color; c.stroke();
    }
    if (level > 10) {
      const label = `Lv${level}`;
      c.font = '700 9px "IBM Plex Mono", monospace';
      const w = c.measureText(label).width + 6;
      const bx = p.x + r * 0.9, by = p.y - r * 1.5 - 4 * rings - 12;
      c.fillStyle = color; c.beginPath();
      if (c.roundRect) c.roundRect(bx, by, w, 12, 3); else c.rect(bx, by, w, 12);
      c.fill();
      c.fillStyle = surface; c.textAlign = 'left'; c.fillText(label, bx + 3, by + 9.5);
    }
  }
  // 形を丸ごと描く(一覧ページや凡例用)
  function draw(c, level, p, r, { fill, stroke, lineWidth = 3 }) {
    path(c, level, p, r);
    c.fillStyle = fill; c.strokeStyle = stroke; c.lineWidth = lineWidth;
    c.fill(); c.stroke();
    extras(c, level, p, r, stroke, fill);
  }
  // 外輪とバッジを含めた、形の外接半径の目安
  const outerRadius = (level, r) => r * 1.5 + 4 * ringCount(level) + (level > 10 ? 14 : 0);

  window.PCShapes = { SHAPE_NAMES, QUESTION_NAMES, SHAPES, shapeIndex, ringCount, path, extras, draw, polygon, star, outerRadius };
})();
