'use strict';
// 拠点の形(1〜100 のレベル用。2026-10-23 ユーザー依頼: 今の形はレベルが上がると外輪・外枠が増えて大きくなりすぎる。レベル 100 程度で大きさに気をつけて作り直す)。
// 原則: 100 のレベルがすべて違う模様になる。大きさはほとんど変えない(外に付く飾りは 1 つまで。外接半径は本体の 1.65 倍まで)。
//
//   1 の位(レベル − 1 の 1 の位) → 本体の形(10 種。今の形と同じ: 円 … 二重の星)
//   10 の位                      → 飾り(10 種): 白抜き / 中心の点 / 内側の線 / 塗り / 塗り + 白い点 / 外輪 / 塗り + 外輪 / 点線の輪 / 塗り + 点線の輪 / 塗り + ギザギザの輪(神)
//   段(入門〜専門・神)は飾りの順に合わせて、上の段ほど塗り・外の輪が出る
//
// ゲーム画面にはまだ使っていない(拠点の格 → 1〜100 の割り当てが決まってから入れ替える)。一覧は shapes100.html
// Node でもテストできるよう、module.exports にも出す。
(() => {
  const MAX_LEVEL = 100;
  const SHAPE_NAMES = {
    1: '円', 2: '角丸四角', 3: '三角形', 4: 'ひし形', 5: '五角形',
    6: '六角形', 7: '星(5点)', 8: '星(6点)', 9: '星(8点)', 10: '二重の星',
  };
  const DECO_NAMES = {
    0: '白抜き', 1: '中心の点', 2: '内側の線', 3: '塗り', 4: '塗り + 白い点',
    5: '外輪', 6: '塗り + 外輪', 7: '点線の輪', 8: '塗り + 点線の輪', 9: '塗り + ギザギザの輪',
  };
  const STAGES = [['入門', 1, 15], ['初級', 16, 35], ['中級', 36, 60], ['上級', 61, 78], ['専門', 79, 89], ['神', 90, 100]];

  function describe(level) {
    const lv = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
    const n = lv - 1;
    const deco = Math.floor(n / 10);
    return {
      level: lv,
      shape: (n % 10) + 1,
      deco,
      filled: [3, 4, 6, 8, 9].includes(deco),
      dot: deco === 1 || deco === 4,            // 中心の点(白抜きなら線の色、塗りなら背景色)
      inner: deco === 2,                         // 内側に同じ形の小さい線
      ring: deco === 5 || deco === 6 ? 'solid' : deco === 7 || deco === 8 ? 'dash' : deco === 9 ? 'gear' : null,
      stage: (STAGES.find(([, lo, hi]) => lv >= lo && lv <= hi) || STAGES[0])[0],
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
  function gear(c, p, r, teeth, depth) {
    for (let i = 0; i < teeth * 2; i++) {
      const rr = i % 2 === 0 ? r + depth : r;
      const a = -Math.PI / 2 + (i * Math.PI) / teeth;
      const x = p.x + rr * Math.cos(a), y = p.y + rr * Math.sin(a);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
  }

  // 本体の形(外接半径はどれも r の 1.0〜1.3 倍に収める。前は星が 1.45 倍まで出ていた)
  const SHAPES = {
    1: (c, p, r) => c.arc(p.x, p.y, r, 0, Math.PI * 2),
    2: (c, p, r) => { const s = r * 0.86; if (c.roundRect) c.roundRect(p.x - s, p.y - s, s * 2, s * 2, r * 0.3); else c.rect(p.x - s, p.y - s, s * 2, s * 2); },
    3: (c, p, r) => polygon(c, p, r * 1.2, 3, -Math.PI / 2),
    4: (c, p, r) => polygon(c, p, r * 1.15, 4),
    5: (c, p, r) => polygon(c, p, r * 1.08, 5),
    6: (c, p, r) => polygon(c, p, r * 1.05, 6),
    7: (c, p, r) => star(c, p, r * 1.25, r * 0.55, 5),
    8: (c, p, r) => star(c, p, r * 1.2, r * 0.65, 6),
    9: (c, p, r) => star(c, p, r * 1.18, r * 0.75, 8),
    10: (c, p, r) => star(c, p, r * 1.3, r * 0.55, 5),
  };
  const SHAPE_OUTER = { 1: 1, 2: 1.22, 3: 1.2, 4: 1.15, 5: 1.08, 6: 1.05, 7: 1.25, 8: 1.2, 9: 1.18, 10: 1.3 }; // 本体の外接半径(r の倍)

  function path(c, level, p, r) {
    c.beginPath();
    SHAPES[describe(level).shape](c, p, r);
  }
  // 外の輪の半径(本体の外接より少し外。どの形でも同じ所に置き、大きさをそろえる)
  const ringRadius = (r) => r * 1.48;

  // 本体のあとに描く飾り: 中心の点・内側の線・外の輪(1 つだけ)
  // color: 線と塗りの色(持ち主の色)。surface: 背景色
  function extras(c, level, p, r, color, surface) {
    const d = describe(level);
    if (d.shape === 10) { c.beginPath(); star(c, p, r * 0.72, r * 0.3, 5); c.lineWidth = 1.5; c.strokeStyle = d.filled ? surface : color; c.stroke(); }
    if (d.inner) { c.beginPath(); SHAPES[d.shape](c, p, r * 0.55); c.lineWidth = 1.5; c.strokeStyle = color; c.stroke(); }
    if (d.dot) { c.beginPath(); c.arc(p.x, p.y, Math.max(2, r * 0.22), 0, Math.PI * 2); c.fillStyle = d.filled ? surface : color; c.fill(); }
    if (d.ring) {
      c.strokeStyle = color; c.lineWidth = 1.5;
      c.beginPath();
      if (d.ring === 'dash') { c.setLineDash([3, 3]); c.arc(p.x, p.y, ringRadius(r), 0, Math.PI * 2); c.stroke(); c.setLineDash([]); }
      else if (d.ring === 'gear') { gear(c, p, ringRadius(r), 16, r * 0.14); c.stroke(); }
      else { c.arc(p.x, p.y, ringRadius(r), 0, Math.PI * 2); c.stroke(); }
    }
  }

  function draw(c, level, p, r, { fill, stroke, lineWidth = 2 }) {
    const d = describe(level);
    path(c, level, p, r);
    c.fillStyle = d.filled ? stroke : fill; c.strokeStyle = stroke; c.lineWidth = lineWidth;
    c.fill(); c.stroke();
    extras(c, level, p, r, stroke, fill);
  }

  // 外接半径(飾りを含む)。どのレベルも r の 1.65 倍まで
  function outerRadius(level, r) {
    const d = describe(level);
    if (d.ring === 'gear') return ringRadius(r) + r * 0.14;
    if (d.ring) return ringRadius(r);
    return r * SHAPE_OUTER[d.shape];
  }
  // 本体の大きさ(レベル 1 → 1.0 倍、100 → 1.2 倍。前は 1.0 → 2 倍近くまで大きくなった)
  const sizeScale = (level) => 1 + 0.2 * (Math.max(1, Math.min(MAX_LEVEL, level)) - 1) / (MAX_LEVEL - 1);

  const api = { MAX_LEVEL, SHAPE_NAMES, DECO_NAMES, STAGES, SHAPES, describe, path, extras, draw, outerRadius, sizeScale, isFilled: (level) => describe(level).filled };
  if (typeof window !== 'undefined') window.PCShapes100 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
