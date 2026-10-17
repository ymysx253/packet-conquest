'use strict';
// 拠点の形(設計書 8.8 / 8.9)。ゲーム画面(app.js)と形の一覧(shapes.html)で共有する。
// 原則: レベルが上がるほど大きくしてよいが、模様は必ず変える(重複禁止)。Lv1〜999 のすべてが異なる模様になる。
//
//   1 の位   → 本体の形(10 種)
//   10 の位  → 0〜4: 白抜き + 外輪 0〜4 本 / 5〜9: 黒塗り + 外輪 0〜4 本(黒は実際には所有者の色)
//   100 の位 → 外枠の種類(ギザギザ、波線、点線、二重線、太線、およびその組み合わせ)
//   Lv11 以上はレベル番号の札も付ける(小さく描くときの保険)
//
// Node でもテストできるよう、module.exports にも出す。
(() => {
  const SHAPE_NAMES = {
    1: '円', 2: '角丸四角', 3: '三角形', 4: 'ひし形', 5: '五角形',
    6: '六角形', 7: '星(5点)', 8: '星(6点)', 9: '星(8点)', 10: '二重の星',
  };
  // 設計書 3.2 の難易度との対応
  const QUESTION_NAMES = {
    1: '4択', 2: '15秒の4択', 3: '入力式', 4: '2問連続', 5: '経路表を読む',
    6: 'トラップを見抜く', 7: 'コマンドで到達確認', 8: 'ファイアウォール突破', 9: '経路を作って突破', 10: '複合トラップ(国)',
  };
  const FRAME_NAMES = {
    0: 'なし', 1: 'ギザギザ', 2: '波線', 3: '点線', 4: '二重線', 5: '太線',
    6: 'ギザギザ + 二重線', 7: '波線 + 二重線', 8: '点線 + 二重線', 9: 'ギザギザの太線',
  };
  const MAX_LEVEL = 999;

  // レベル → 模様の要素
  function describe(level) {
    const lv = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
    const n = lv - 1;
    const tens = Math.floor(n / 10) % 10;
    return {
      level: lv,
      shape: (n % 10) + 1,                 // 1〜10
      filled: tens >= 5,                   // 黒塗り
      rings: tens % 5,                     // 外輪 0〜4 本
      frame: Math.floor(n / 100) % 10,     // 外枠の種類 0〜9
      badge: lv > 10,
    };
  }

  function polygon(c, p, r, k, rot = -Math.PI / 2) {
    for (let i = 0; i < k; i++) {
      const a = rot + (i * 2 * Math.PI) / k;
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
  // ギザギザの輪(歯車)
  function gear(c, p, r, teeth, depth) {
    for (let i = 0; i < teeth * 2; i++) {
      const rr = i % 2 === 0 ? r + depth : r;
      const a = -Math.PI / 2 + (i * Math.PI) / teeth;
      const x = p.x + rr * Math.cos(a), y = p.y + rr * Math.sin(a);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
  }
  // 波線の輪
  function wave(c, p, r, waves, amp) {
    const steps = waves * 12;
    for (let i = 0; i <= steps; i++) {
      const a = (i * 2 * Math.PI) / steps;
      const rr = r + amp * Math.sin(a * waves);
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

  // 形のパスだけ作る(塗りや線は呼び出し側)
  function path(c, level, p, r) {
    c.beginPath();
    SHAPES[describe(level).shape](c, p, r);
  }

  // 外輪の始まりの半径と、外枠の半径
  const ringBase = (r) => r * 1.45;
  const frameRadius = (d, r) => ringBase(r) + 4 * d.rings + 5;

  // 形に足す飾り: Lv10 系の内側の星、外輪、外枠、札
  // color: 線と黒塗りの色(所有者の色)。surface: 背景色。
  function extras(c, level, p, r, color, surface) {
    const d = describe(level);
    if (d.shape === 10) {
      c.beginPath(); star(c, p, r * 0.8, r * 0.34, 5);
      c.lineWidth = 2; c.strokeStyle = d.filled ? surface : color; c.stroke();
    }
    c.strokeStyle = color; c.setLineDash([]);
    for (let i = 1; i <= d.rings; i++) {
      c.beginPath(); c.arc(p.x, p.y, ringBase(r) + 4 * i, 0, Math.PI * 2);
      c.lineWidth = 1.5; c.stroke();
    }
    const fr = frameRadius(d, r);
    const f = d.frame;
    const double = f === 4 || f === 6 || f === 7 || f === 8;
    const thick = f === 5 || f === 9;
    c.lineWidth = thick ? 3.5 : 1.5;
    if (f === 1 || f === 6 || f === 9) { c.beginPath(); gear(c, p, fr, 20, 3); c.stroke(); }
    else if (f === 2 || f === 7) { c.beginPath(); wave(c, p, fr + 1.5, 14, 1.8); c.stroke(); }
    else if (f === 3 || f === 8) { c.beginPath(); c.setLineDash([3, 3]); c.arc(p.x, p.y, fr + 1, 0, Math.PI * 2); c.stroke(); c.setLineDash([]); }
    else if (f === 4 || f === 5) { c.beginPath(); c.arc(p.x, p.y, fr + 1, 0, Math.PI * 2); c.stroke(); }
    if (double) { c.beginPath(); c.lineWidth = 1.5; c.arc(p.x, p.y, fr + 5.5, 0, Math.PI * 2); c.stroke(); }
    c.lineWidth = 1.5;

    if (d.badge) {
      const label = `Lv${d.level}`;
      c.font = '700 9px "IBM Plex Mono", monospace';
      const w = c.measureText(label).width + 6;
      const top = outerRadius(level, r);
      const bx = p.x + r * 0.9, by = p.y - top - 10;
      c.fillStyle = color; c.beginPath();
      if (c.roundRect) c.roundRect(bx, by, w, 12, 3); else c.rect(bx, by, w, 12);
      c.fill();
      c.fillStyle = surface; c.textAlign = 'left'; c.fillText(label, bx + 3, by + 9.5);
    }
  }

  // 形を丸ごと描く(一覧ページや凡例用)。黒塗りのレベルは stroke の色で塗る
  function draw(c, level, p, r, { fill, stroke, lineWidth = 3 }) {
    const d = describe(level);
    path(c, level, p, r);
    c.fillStyle = d.filled ? stroke : fill; c.strokeStyle = stroke; c.lineWidth = lineWidth;
    c.fill(); c.stroke();
    extras(c, level, p, r, stroke, fill);
  }

  // 外輪と外枠を含めた、形の外接半径の目安(札は含まない)
  function outerRadius(level, r) {
    const d = describe(level);
    if (d.frame === 0 && d.rings === 0) return r * 1.45;
    const fr = frameRadius(d, r);
    const extra = (d.frame === 4 || d.frame >= 6 && d.frame <= 8) ? 7 : d.frame === 1 || d.frame === 9 ? 4 : 3;
    return d.frame === 0 ? ringBase(r) + 4 * d.rings + 1 : fr + extra;
  }

  const api = { MAX_LEVEL, SHAPE_NAMES, QUESTION_NAMES, FRAME_NAMES, SHAPES, describe, path, extras, draw, polygon, star, outerRadius, isFilled: (level) => describe(level).filled };
  if (typeof window !== 'undefined') window.PCShapes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
