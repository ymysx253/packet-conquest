'use strict';
// 地図の試し(2026-10-22): 背景は map-base.js(PCMapBase。陸・海・区市の境界・湖・地域の支配の色)、拠点は canvas を重ねて描く(docs/MAP-ENGINE.md の案 A)。
// 7.3 の約束(project・pxPerDegLon・setRegionControls・setOverview・setColors・click)を手で確かめる場所。
// 拠点はサーバーに「見ている範囲」を頼んで受け取る(参加しない。読むだけ)。サーバーが無くても背景は見られる。本番の画面ではない
(() => {
  const LIGHT = { water: '#D6ECFA', land: '#F7F9FA', line: '#CBD3DC', lineStrong: '#8A97A6' };
  const DARK = { water: '#17324A', land: '#131B24', line: '#2B3846', lineStrong: '#5B6C7E' };
  const C = { paper: '#FFFFFF', label: '#0E141B', node: '#64748B' };
  const KX = Math.cos((35.68 * Math.PI) / 180); // app.js の経度の縮め方
  const $ = (id) => document.getElementById(id);
  const stat = (s) => { $('stat').textContent = s; };

  const mb = PCMapBase.create({ container: $('map'), center: [139.7671, 35.6812], zoom: 12, minZoom: 4, maxZoom: 18, colors: LIGHT });
  const t0 = performance.now();
  mb.ready.then(() => { stat(`粗い全国版を ${Math.round(performance.now() - t0)} ms で読み込み`); connect(); draw(); });

  // ---------- 試しの操作 ----------
  let overview = false, dark = false;
  $('zin').onclick = () => mb.zoomBy(1);
  $('zout').onclick = () => mb.zoomBy(-1);
  $('ov').onclick = () => { overview = !overview; mb.setOverview(overview); $('ov').textContent = `縮小表示: ${overview ? '入' : '切'}`; };
  $('dark').onclick = () => { dark = !dark; mb.setColors(dark ? DARK : LIGHT); $('dark').textContent = dark ? '明るい色' : '暗い色'; };
  // 見えている区・市にいくつか色を付ける(サーバーの地域の支配の代わり。枠の色と背景色の組)
  const STYLES = [{ fill: '#EF4444', frame: '#B91C1C' }, { fill: '#3B82F6', frame: '#1D4ED8' }, { fill: '#22C55E', frame: '#15803D' }, { fill: '#F59E0B', frame: '#B45309' }];
  $('ctl').onclick = () => {
    const ids = [...new Set(mb.map.queryRenderedFeatures({ layers: mb.map.getStyle().layers.filter((l) => /-land$/.test(l.id)).map((l) => l.id) }).map((f) => f.properties.id))];
    const list = ids.filter((_, i) => i % 3 === 0).map((id, i) => ({ id, ...STYLES[i % STYLES.length] }));
    mb.setRegionControls(list);
    stat(`支配の色を ${list.length} 地域に付けた`);
  };
  $('clr').onclick = () => { mb.setRegionControls([]); stat('支配の色を消した'); };
  mb.on('click', ({ x, y }) => {
    const q = mb.unproject(x, y), p = mb.project(q.lon, q.lat);
    stat(`押した所 ${q.lat.toFixed(4)}, ${q.lon.toFixed(4)}(戻すと ${Math.round(p.x)}, ${Math.round(p.y)} px)/ 倍率 ${mb.getZoom().toFixed(2)}・今の画面の拡大率 ${(mb.pxPerDegLon() / (1000 * KX * 1.1)).toFixed(3)}`);
  });

  // ---------- 拠点: サーバーに見ている範囲を頼む(今の画面と同じしくみ。参加しない) ----------
  const S = { nodes: new Map(), overview: false, ws: null };
  const TILE_LAT = 0.025, TILE_LON = 0.03;
  // 今の画面の倍率(1 倍 = 1° が約 1100 px)を MapLibre の zoom に直すと、段の境目は z0: 10.6 / z1: 8.8 / z2: 6.8 / z3: 5.0
  const tierOf = (zoom) => (zoom >= 10.6 ? 0 : zoom >= 8.8 ? 1 : zoom >= 6.8 ? 2 : zoom >= 5.0 ? 3 : 4);
  const TOWN_ZOOM = 12.6; // 町・字は今の画面の拡大率 10 から
  function tilesInView(z) {
    const b = mb.getBounds(), s = { lat: TILE_LAT * 4 ** z, lon: TILE_LON * 4 ** z }, pad = z === 0 ? 1 : 0;
    const y0 = Math.floor(b.south / s.lat) - pad, y1 = Math.floor(b.north / s.lat) + pad;
    const x0 = Math.floor(b.west / s.lon) - pad, x1 = Math.floor(b.east / s.lon) + pad;
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`t${z}:${y}:${x}`);
    return out;
  }
  let lastKey = '';
  function requestView() {
    if (!S.ws || S.ws.readyState !== 1) return;
    let z = tierOf(mb.getZoom()), tiles = tilesInView(z);
    while (tiles.length > 80 && z < 4) { z++; tiles = tilesInView(z); }
    const key = `${z}:${tiles.join(',')}`;
    if (key === lastKey) return;
    lastKey = key;
    S.ws.send(JSON.stringify({ t: 'view', z, tiles }));
  }
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => { lastKey = ''; requestView(); };
    ws.onclose = () => { setTimeout(connect, 5000); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t !== 'tiles') return;
      if (m.overview) {
        S.nodes.clear(); S.overview = true;
        for (const n of m.nodes) S.nodes.set(n.id, n);
        // 縮小表示のときはサーバーから地域の支配が届く(今の画面と同じ色の取り方)
        mb.setRegionControls((m.regions || []).filter((g) => g.controller).map((g) => {
          const c = g.controller;
          return { id: g.id, fill: c.style ? c.style.fill : c.color, frame: c.style ? c.style.frame : c.color };
        }));
      } else {
        if (S.overview) { S.nodes.clear(); S.overview = false; }
        const dropped = new Set(m.dropped);
        for (const [id, n] of S.nodes) if (dropped.has(n.t0)) S.nodes.delete(id);
        for (const n of m.nodes) S.nodes.set(n.id, n);
      }
      mb.map.triggerRepaint();
    };
  }
  mb.on('moveend', requestView);

  // ---------- 拠点を重ねて描く(地図が動くたびに) ----------
  const cv = $('overlay'), ctx = cv.getContext('2d');
  function resize() {
    const d = window.devicePixelRatio || 1;
    cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d);
    cv.style.width = `${innerWidth}px`; cv.style.height = `${innerHeight}px`;
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  addEventListener('resize', () => { resize(); draw(); });
  resize();
  function draw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const zoom = mb.getZoom(), towns = zoom >= TOWN_ZOOM;
    const list = [];
    for (const n of S.nodes.values()) if (n.genre !== 'town' || towns) {
      const p = mb.project(n.lon, n.lat);
      if (p.x > -50 && p.y > -50 && p.x < innerWidth + 50 && p.y < innerHeight + 50) list.push([n, p]);
    }
    list.sort((a, b) => b[0].level - a[0].level);
    const placed = [];
    ctx.font = '600 13px "BIZ UDPGothic", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
    for (const [n, p] of list) {
      const r = n.genre === 'town' ? 4 : 5 + Math.min(8, Math.log10(Math.max(1, n.level)) * 3);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.owner ? (n.ownerColor || '#EF4444') : C.paper; ctx.fill();
      ctx.strokeStyle = C.node; ctx.lineWidth = 2; ctx.stroke();
      if (n.genre === 'town' && zoom < 13.5) continue;
      const w = ctx.measureText(n.name).width, box = [p.x - w / 2 - 2, p.y + r + 2, w + 4, 16];
      if (placed.some((b) => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])) continue;
      placed.push(box);
      ctx.strokeStyle = C.paper; ctx.lineWidth = 3; ctx.strokeText(n.name, p.x, p.y + r + 3);
      ctx.fillStyle = C.label; ctx.fillText(n.name, p.x, p.y + r + 3);
    }
  }
  mb.on('render', draw);
})();
