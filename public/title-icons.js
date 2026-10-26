'use strict';
// 称号のアイコンの見本(title-icons.html)。形のデータは data/title-samples.json(tools/build-title-samples.js が作る)
(() => {
  const css = getComputedStyle(document.documentElement);
  const tok = (n, d) => css.getPropertyValue(n).trim() || d;
  const surface = tok('--surface', '#FFFFFF');
  const dpr = window.devicePixelRatio || 1;
  const SIZE = 88; // バッジの大きさ(CSS px)。どの称号も同じ
  const R = 40, IN = 27; // 外の輪の半径、中身を収める四角の半分

  const CATS = {
    region: { name: '地域', color: '#2E8B57' },
    island: { name: '島と航路', color: '#1F78B4' },
    tip: { name: '端', color: '#34495E' },
    line: { name: '路線', color: '#D9730D' },
    level: { name: 'レベル', color: '#7B4FBF' },
    count: { name: '正解の数・記録', color: '#C0392B' },
    genre: { name: '拠点の種類', color: '#138D90' },
  };

  // ---------- 手で描く絵(0〜1 の四角の中に描く) ----------
  const P = {
    check(x) { x.beginPath(); x.moveTo(0.18, 0.52); x.lineTo(0.42, 0.76); x.lineTo(0.84, 0.26); x.stroke(); },
    calendar(x) {
      x.strokeRect(0.12, 0.2, 0.76, 0.68); x.beginPath(); x.moveTo(0.12, 0.38); x.lineTo(0.88, 0.38);
      x.moveTo(0.32, 0.1); x.lineTo(0.32, 0.28); x.moveTo(0.68, 0.1); x.lineTo(0.68, 0.28); x.stroke();
    },
    onsen(x) {
      x.beginPath(); x.ellipse(0.5, 0.74, 0.3, 0.12, 0, 0, Math.PI * 2); x.stroke();
      for (const cx of [0.32, 0.5, 0.68]) { x.beginPath(); x.moveTo(cx, 0.6); x.bezierCurveTo(cx - 0.1, 0.48, cx + 0.1, 0.36, cx, 0.16); x.stroke(); }
    },
    plane(x) {
      x.beginPath();
      const p = [[0.5, 0.06], [0.56, 0.16], [0.56, 0.4], [0.94, 0.6], [0.94, 0.68], [0.56, 0.56], [0.56, 0.8], [0.68, 0.9], [0.68, 0.96], [0.5, 0.91], [0.32, 0.96], [0.32, 0.9], [0.44, 0.8], [0.44, 0.56], [0.06, 0.68], [0.06, 0.6], [0.44, 0.4], [0.44, 0.16]];
      p.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.closePath(); x.stroke();
    },
    anchor(x) {
      x.beginPath(); x.arc(0.5, 0.16, 0.08, 0, Math.PI * 2); x.moveTo(0.5, 0.24); x.lineTo(0.5, 0.88);
      x.moveTo(0.3, 0.38); x.lineTo(0.7, 0.38); x.moveTo(0.14, 0.6); x.quadraticCurveTo(0.2, 0.88, 0.5, 0.88); x.quadraticCurveTo(0.8, 0.88, 0.86, 0.6); x.stroke();
      x.beginPath(); x.moveTo(0.08, 0.68); x.lineTo(0.14, 0.58); x.lineTo(0.24, 0.66); x.moveTo(0.92, 0.68); x.lineTo(0.86, 0.58); x.lineTo(0.76, 0.66); x.stroke();
    },
    cap(x) {
      x.beginPath(); x.moveTo(0.5, 0.18); x.lineTo(0.94, 0.38); x.lineTo(0.5, 0.58); x.lineTo(0.06, 0.38); x.closePath(); x.stroke();
      x.beginPath(); x.moveTo(0.24, 0.48); x.lineTo(0.24, 0.72); x.quadraticCurveTo(0.5, 0.86, 0.76, 0.72); x.lineTo(0.76, 0.48); x.stroke();
      x.beginPath(); x.moveTo(0.88, 0.41); x.lineTo(0.88, 0.7); x.stroke();
    },
    hall(x) {
      x.beginPath(); x.moveTo(0.1, 0.36); x.lineTo(0.5, 0.18); x.lineTo(0.9, 0.36); x.closePath(); x.stroke();
      x.strokeRect(0.1, 0.84, 0.8, 0.06);
      x.beginPath(); for (const cx of [0.2, 0.4, 0.6, 0.8]) { x.moveTo(cx, 0.42); x.lineTo(cx, 0.82); } x.stroke();
      x.beginPath(); x.moveTo(0.5, 0.18); x.lineTo(0.5, 0.04); x.lineTo(0.66, 0.08); x.lineTo(0.5, 0.12); x.stroke();
    },
    torii(x) {
      x.beginPath(); x.moveTo(0.06, 0.2); x.quadraticCurveTo(0.5, 0.3, 0.94, 0.2); x.moveTo(0.16, 0.38); x.lineTo(0.84, 0.38);
      x.moveTo(0.26, 0.26); x.lineTo(0.22, 0.92); x.moveTo(0.74, 0.26); x.lineTo(0.78, 0.92); x.moveTo(0.5, 0.27); x.lineTo(0.5, 0.38); x.stroke();
    },
    falls(x) {
      x.beginPath(); x.moveTo(0.08, 0.92); x.lineTo(0.08, 0.14); x.lineTo(0.34, 0.14); x.moveTo(0.92, 0.92); x.lineTo(0.92, 0.14); x.lineTo(0.66, 0.14); x.stroke();
      x.beginPath(); for (const cx of [0.4, 0.5, 0.6]) { x.moveTo(cx, 0.16); x.lineTo(cx, 0.76); } x.stroke();
      x.beginPath(); x.arc(0.5, 0.86, 0.2, Math.PI * 1.1, Math.PI * 1.9); x.stroke();
    },
    islands(x) {
      for (const [cx, cy, rx, ry] of [[0.26, 0.4, 0.16, 0.1], [0.66, 0.3, 0.2, 0.12], [0.56, 0.64, 0.12, 0.08]]) { x.beginPath(); x.ellipse(cx, cy, rx, ry, -0.3, 0, Math.PI * 2); x.stroke(); }
      x.beginPath(); x.moveTo(0.06, 0.86); for (let i = 0; i < 4; i++) x.quadraticCurveTo(0.17 + i * 0.22, 0.78, 0.28 + i * 0.22, 0.86); x.stroke();
    },
    phantom(x) {
      x.beginPath(); x.ellipse(0.16, 0.74, 0.12, 0.08, 0, 0, Math.PI * 2); x.ellipse(0.84, 0.32, 0.12, 0.08, 0, 0, Math.PI * 2); x.stroke();
      x.save(); x.setLineDash([0.07, 0.06]); x.beginPath(); x.moveTo(0.22, 0.66); x.quadraticCurveTo(0.4, 0.16, 0.76, 0.3); x.stroke(); x.restore();
      x.beginPath(); x.moveTo(0.38, 0.5); x.lineTo(0.6, 0.5); x.lineTo(0.55, 0.58); x.lineTo(0.43, 0.58); x.closePath(); x.moveTo(0.49, 0.5); x.lineTo(0.49, 0.36); x.lineTo(0.58, 0.46); x.stroke();
    },
    net(x) {
      const n = [[0.5, 0.18], [0.18, 0.78], [0.82, 0.78]];
      x.beginPath(); x.moveTo(...n[0]); x.lineTo(...n[1]); x.lineTo(...n[2]); x.closePath(); x.stroke();
      for (const [a, b] of n) { x.beginPath(); x.arc(a, b, 0.11, 0, Math.PI * 2); x.fillStyle = surface; x.fill(); x.stroke(); }
    },
  };

  // ---------- 見本の一覧 ----------
  const LIST = [
    ['region', [
      ['岐阜県 制覇', '県の拠点をすべて', { shape: 'pref-gifu' }],
      ['北海道 制覇', '道の拠点をすべて', { shape: 'pref-hokkaido' }],
      ['郡上市 制覇', '市の拠点をすべて', { shape: 'city-gujo' }],
      ['千代田区 制覇', '区の拠点をすべて', { shape: 'city-chiyoda' }],
      ['関東 制覇', '地方の都県をすべて制覇', { shape: 'area-kanto' }],
      ['日本制覇', '公開の拠点をすべて', { shape: 'japan' }],
      ['47 都道府県 足あと', '全都道府県で 1 拠点以上', { shape: 'japan', text: '47' }],
    ]],
    ['island', [
      ['佐渡島 制覇', '島の拠点をすべて', { shape: 'island-sado' }],
      ['屋久島 制覇', '島の拠点をすべて', { shape: 'island-yaku' }],
      ['島めぐり 50 島', '50 の島で 1 拠点以上', { pict: 'islands', text: '50' }],
      ['幻の航路の旅人', '幻の航路をすべて渡る', { pict: 'phantom' }],
    ]],
    ['tip', [
      ['最北端 到達', '宗谷岬を取る', { shape: 'tip-north', text: '北' }],
      ['最南端 到達', '波照間島の拠点を 1 つ', { shape: 'island-hateruma', text: '南' }],
    ]],
    ['line', [
      ['山手線 制覇', '路線の駅をすべて', { shape: 'line-yamanote' }],
      ['東海道新幹線 制覇', '路線の駅をすべて', { shape: 'line-tokaido-sk' }],
      ['宗谷線 制覇', '路線の駅をすべて', { shape: 'line-soya' }],
      ['新幹線 全線制覇', '新幹線の駅をすべて', { shape: 'shinkansen' }],
      ['(会社の全線)', '名前の付け方は未定。形は北海道の JR 線', { shape: 'company-jrh' }],
    ]],
    ['level', [
      ['Lv10 制覇', 'そのレベルを達成', { level: 10 }],
      ['入門 修了', 'Lv1〜15 をすべて達成', { level: 15 }],
      ['中級 修了', 'Lv36〜60 をすべて達成', { level: 60 }],
      ['専門 修了', 'Lv79〜89 をすべて達成', { level: 89 }],
      ['神の領域', '神レベルの拠点を 1 つ', { level: 100 }],
    ]],
    ['count', [
      ['100 問', '正解の合計', { pict: 'check', text: '100' }],
      ['1 万問', '正解の合計', { pict: 'check', text: '1万' }],
      ['サブネット 100 問', '分野ごとの正解', { pict: 'net', text: '100' }],
      ['1 日 100 問', '1 日の正解', { pict: 'calendar', text: '100' }],
      ['100 日', '正解した日の合計', { pict: 'calendar', text: '100日' }],
    ]],
    ['genre', [
      ['空港めぐり 全 88', '全国の空港', { pict: 'plane' }],
      ['港めぐり', '全国の港', { pict: 'anchor' }],
      ['温泉めぐり', '温泉の拠点', { pict: 'onsen' }],
      ['滝めぐり', '滝の拠点', { pict: 'falls' }],
      ['大学めぐり', '大学の拠点', { pict: 'cap' }],
      ['役場めぐり', '市区町村役場・区役所', { pict: 'hall' }],
      ['神社・寺めぐり', '神社・寺の拠点', { pict: 'torii' }],
    ]],
  ];

  const canvas = () => { const c = document.createElement('canvas'); c.width = SIZE * dpr; c.height = SIZE * dpr; c.style.width = `${SIZE}px`; c.style.height = `${SIZE}px`; const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return [c, x]; };

  function badge(x, color, item, shapes) {
    const c = SIZE / 2;
    // 地と輪(どの称号も同じ大きさ)
    x.beginPath(); x.arc(c, c, R, 0, Math.PI * 2); x.fillStyle = surface; x.fill();
    x.globalAlpha = 0.12; x.fillStyle = color; x.fill(); x.globalAlpha = 1;
    x.lineWidth = 4; x.strokeStyle = color; x.stroke();
    const hasText = item.text != null;
    const box = hasText ? IN * 0.8 : IN; // 数字を下に入れるときは絵を小さく上へ
    const cy = hasText ? c - 7 : c;
    x.save(); x.translate(c - box, cy - box); x.scale(box * 2, box * 2);
    x.lineJoin = 'round'; x.lineCap = 'round';
    if (item.shape) {
      const s = shapes[item.shape];
      x.fillStyle = color;
      // 市区町村の多角形を並べて塗ると境目に細い線が出るので、同じ色の細い線でなぞって埋める
      x.strokeStyle = color; x.lineWidth = 0.8 / (box * 2);
      for (const p of s.polys) { x.beginPath(); p.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.closePath(); x.fill(); x.stroke(); }
      x.strokeStyle = color; x.lineWidth = 2.6 / (box * 2);
      x.beginPath(); for (const [a, b, d, e] of s.segs) { x.moveTo(a, b); x.lineTo(d, e); } x.stroke();
      for (const [a, b] of s.marks) { x.beginPath(); x.arc(a, b, 4 / (box * 2), 0, Math.PI * 2); x.fillStyle = '#F2C230'; x.fill(); x.lineWidth = 1.5 / (box * 2); x.strokeStyle = '#3A2F00'; x.stroke(); }
    } else if (item.pict) {
      x.strokeStyle = color; x.lineWidth = 2.4 / (box * 2);
      P[item.pict](x);
    }
    x.restore();
    if (item.level) window.PCShapes100.draw(x, item.level, { x: c, y: c }, 17, { fill: surface, stroke: color, lineWidth: 2.5 });
    if (hasText) {
      x.font = `700 ${String(item.text).length > 3 ? 12 : 14}px "BIZ UDPGothic", sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.lineWidth = 3; x.strokeStyle = surface; x.strokeText(item.text, c, c + R - 13);
      x.fillStyle = color; x.fillText(item.text, c, c + R - 13);
    }
  }

  fetch('data/title-samples.json').then((r) => r.json()).then((shapes) => {
    const list = document.getElementById('list');
    for (const [cat, items] of LIST) {
      const { name, color } = CATS[cat];
      const h = document.createElement('h2'); const dot = document.createElement('i'); dot.style.background = color; h.append(dot, name); list.append(h);
      const grid = document.createElement('div'); grid.className = 'grid'; list.append(grid);
      for (const [title, how, item] of items) {
        const cell = document.createElement('div'); cell.className = 'cell';
        const [cv, x] = canvas(); badge(x, color, item, shapes);
        const a = document.createElement('div'); a.className = 'nm'; a.textContent = title;
        const b = document.createElement('div'); b.className = 'how'; b.textContent = how;
        cell.append(cv, a, b); grid.append(cell);
      }
    }
  });
})();
