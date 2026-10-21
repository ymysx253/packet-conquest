'use strict';
// 地図の試し(2026-10-22): 背景(陸・海・区市の境界・湖・線路・新幹線・海路)を MapLibre で描き、拠点は canvas を重ねて描く(docs/MAP-ENGINE.md の案 A)。
// データは今のまま(public/data/ の JSON)。拠点はサーバーに「見ている範囲」を頼んで受け取る(参加しない。読むだけ)。本番の画面ではない
(() => {
  const C = { water: '#D6ECFA', land: '#F7F9FA', line: '#CBD5E1', ink: '#1F2937', paper: '#FFFFFF', shk: '#0F9488', sea: '#F97316', label: '#0E141B', node: '#64748B' };
  const PREFS = ['aichi', 'akita', 'aomori', 'chiba', 'ehime', 'fukui', 'fukuoka', 'fukushima', 'gifu', 'gunma', 'hiroshima', 'hokkaido', 'hyogo', 'ibaraki', 'ishikawa', 'iwate', 'kagawa', 'kagoshima', 'kanagawa', 'kochi', 'kumamoto', 'kyoto', 'mie', 'miyagi', 'miyazaki', 'nagano', 'nagasaki', 'nara', 'niigata', 'oita', 'okayama', 'okinawa', 'osaka', 'saga', 'saitama', 'shiga', 'shimane', 'shizuoka', 'tochigi', 'tokushima', 'tokyo', 'tottori', 'toyama', 'wakayama', 'yamagata', 'yamaguchi', 'yamanashi'];
  const $ = (id) => document.getElementById(id);
  const stat = (s) => { $('stat').textContent = s; };

  maplibregl.setWorkerUrl('vendor/maplibre/maplibre-gl-csp-worker.js'); // 画面の安全設定(外のプログラムを読まない)に合わせた版
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': C.water } }] },
    center: [139.7671, 35.6812], zoom: 12, minZoom: 4, maxZoom: 18, renderWorldCopies: false,
    attributionControl: { customAttribution: '国土数値情報・国勢調査' },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  const fc = (features) => ({ type: 'FeatureCollection', features });
  const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  map.on('load', async () => {
    // 陸と区・市の境界(47 都道府県の細かい版をまとめて 1 つの源に。MapLibre が倍率ごとに間引いて描く)
    map.addSource('land', { type: 'geojson', data: fc([]), tolerance: 0.2 });
    map.addLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': C.land } });
    map.addLayer({ id: 'border', type: 'line', source: 'land', paint: { 'line-color': C.line, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 12, 1] } });
    map.addSource('water', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': C.water } });
    map.addSource('sea', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'sea', type: 'line', source: 'sea', paint: { 'line-color': C.sea, 'line-width': 2, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } });
    // 線路: 縁取り → 白 → 交互の色(鉄道の地図記号)。新幹線は青緑
    map.addSource('rail', { type: 'geojson', data: fc([]) });
    const railW = ['interpolate', ['linear'], ['zoom'], 8, 2.5, 13, 5, 16, 7];
    const innerW = ['interpolate', ['linear'], ['zoom'], 8, 1.2, 13, 3, 16, 4.6];
    const col = ['case', ['get', 'shk'], C.shk, C.ink];
    map.addLayer({ id: 'rail-case', type: 'line', source: 'rail', minzoom: 7, paint: { 'line-color': col, 'line-width': railW } });
    map.addLayer({ id: 'rail-paper', type: 'line', source: 'rail', minzoom: 7, paint: { 'line-color': C.paper, 'line-width': innerW } });
    map.addLayer({ id: 'rail-dash', type: 'line', source: 'rail', minzoom: 7, paint: { 'line-color': col, 'line-width': innerW, 'line-dasharray': [2.5, 2.5] } });
    map.addLayer({ id: 'shk-wide', type: 'line', source: 'rail', maxzoom: 7, filter: ['get', 'shk'], paint: { 'line-color': C.shk, 'line-width': 2 } });

    stat('地図のデータを読み込み中…');
    const t0 = performance.now();
    const [shk, rail, sea, water] = await Promise.all([getJson('data/shinkansen.json'), getJson('data/rail-paths.json'), getJson('data/sea-paths.json'), getJson('data/water.json')]);
    R.paths = rail ? rail.paths : {};
    R.shk = (shk && shk.edges) || []; R.shkStations = (shk && shk.stations) || {};
    R.shkKeys = new Set(R.shk.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
    updateRails();
    // 航路は空港・港を押さえてはじめて分かるので、試しのページ(参加しない)では出さない(2026-10-22 ユーザー指摘)。形の描き方は本番の画面に入れるときに使う
    void sea;
    map.getSource('water').setData(fc((water ? water.water : []).map((w) => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: w.polys.map((r) => [r]) } }))));
    const land = [];
    await Promise.all(PREFS.map(async (p) => {
      const d = await getJson(`data/bounds/${p}.json`);
      if (d && d.regions) for (const [id, g] of Object.entries(d.regions)) land.push({ type: 'Feature', properties: { id, name: g.name }, geometry: { type: 'MultiPolygon', coordinates: g.polys.map((r) => [r]) } });
    }));
    map.getSource('land').setData(fc(land));
    stat(`地図のデータ ${land.length} 地域を ${Math.round(performance.now() - t0)} ms で読み込み`);
    connect();
    draw();
  });

  // ---------- 線路: 駅と駅のつながり(サーバーから届く)に、線路の形(rail-paths.json の間の点)をはさむ。新幹線は全国分を最初から ----------
  const R = { paths: {}, shk: [], shkStations: {}, shkKeys: new Set() };
  function railLine(a, b, key) {
    const pts = R.paths[key] || [];
    const mid = a.id < b.id ? pts : pts.slice().reverse();
    return [[a.lon, a.lat], ...mid, [b.lon, b.lat]];
  }
  function updateRails() {
    const feats = [];
    for (const [ia, ib] of R.shk) {
      const a = { id: ia, ...R.shkStations[ia] }, b = { id: ib, ...R.shkStations[ib] };
      if (a.lat == null || b.lat == null) continue;
      feats.push({ type: 'Feature', properties: { shk: true }, geometry: { type: 'LineString', coordinates: railLine(a, b, ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`) } });
    }
    for (const [k, ed] of S.edges) {
      if (R.shkKeys.has(k)) continue;
      const a = S.nodes.get(ed.a) || (ed.far && ed.far.id === ed.a ? ed.far : null), b = S.nodes.get(ed.b) || (ed.far && ed.far.id === ed.b ? ed.far : null);
      if (!a || !b || a.genre !== 'station' || b.genre !== 'station' || a.isPlayerNode || b.isPlayerNode) continue;
      if (!(a.lines || []).some((l) => (b.lines || []).includes(l))) continue; // 同じ路線の隣どうしだけ
      feats.push({ type: 'Feature', properties: { shk: false }, geometry: { type: 'LineString', coordinates: railLine(a, b, k) } });
    }
    if (map.getSource('rail')) map.getSource('rail').setData(fc(feats));
  }

  // ---------- 拠点: サーバーに見ている範囲を頼む(今の画面と同じしくみ。参加しない) ----------
  const S = { nodes: new Map(), edges: new Map(), overview: false, ws: null };
  const TILE_LAT = 0.025, TILE_LON = 0.03;
  // 今の画面の倍率(1 倍 = 1° が約 1100 px)を MapLibre の zoom に直すと、段の境目は z0: 10.6 / z1: 8.8 / z2: 6.8 / z3: 5.0
  const tierOf = (zoom) => (zoom >= 10.6 ? 0 : zoom >= 8.8 ? 1 : zoom >= 6.8 ? 2 : zoom >= 5.0 ? 3 : 4);
  const TOWN_ZOOM = 12.6; // 町・字は今の画面の拡大率 10 から
  function tilesInView(z) {
    const b = map.getBounds(), s = { lat: TILE_LAT * 4 ** z, lon: TILE_LON * 4 ** z }, pad = z === 0 ? 1 : 0;
    const y0 = Math.floor(b.getSouth() / s.lat) - pad, y1 = Math.floor(b.getNorth() / s.lat) + pad;
    const x0 = Math.floor(b.getWest() / s.lon) - pad, x1 = Math.floor(b.getEast() / s.lon) + pad;
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`t${z}:${y}:${x}`);
    return out;
  }
  let lastKey = '';
  function requestView() {
    if (!S.ws || S.ws.readyState !== 1) return;
    let z = tierOf(map.getZoom()), tiles = tilesInView(z);
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
    ws.onclose = () => { setTimeout(connect, 2000); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t !== 'tiles') return;
      if (m.overview) { S.nodes.clear(); S.edges.clear(); S.overview = true; for (const n of m.nodes) S.nodes.set(n.id, n); }
      else {
        if (S.overview) { S.nodes.clear(); S.edges.clear(); S.overview = false; }
        const dropped = new Set(m.dropped);
        for (const [id, n] of S.nodes) if (dropped.has(n.t0)) S.nodes.delete(id);
        for (const n of m.nodes) S.nodes.set(n.id, n);
        for (const ed of m.edges) S.edges.set(ed.a < ed.b ? `${ed.a}|${ed.b}` : `${ed.b}|${ed.a}`, ed);
        for (const [k, ed] of S.edges) if (!S.nodes.has(ed.a) && !S.nodes.has(ed.b)) S.edges.delete(k);
      }
      updateRails();
      map.triggerRepaint();
    };
  }
  map.on('moveend', requestView);

  // ---------- 拠点を重ねて描く(地図が動くたびに。拠点の数は少ないので軽い) ----------
  const cv = $('overlay'), ctx = cv.getContext('2d');
  function resize() {
    const d = window.devicePixelRatio || 1;
    cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d);
    cv.style.width = `${innerWidth}px`; cv.style.height = `${innerHeight}px`;
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  addEventListener('resize', () => { resize(); map.resize(); draw(); });
  resize();
  let frames = 0, since = 0, moving = false;
  map.on('movestart', () => { moving = true; frames = 0; since = performance.now(); });
  map.on('moveend', () => { if (moving && frames > 3) stat(`倍率 ${map.getZoom().toFixed(1)} / 拠点 ${S.nodes.size} / 動かしている間 ${Math.round((frames * 1000) / (performance.now() - since))} こま/秒`); moving = false; });
  function draw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const zoom = map.getZoom(), towns = zoom >= TOWN_ZOOM;
    const show = (n) => n.genre !== 'town' || towns;
    const pos = new Map();
    for (const n of S.nodes.values()) if (show(n)) {
      const p = map.project([n.lon, n.lat]);
      if (p.x > -50 && p.y > -50 && p.x < innerWidth + 50 && p.y < innerHeight + 50) pos.set(n.id, p);
    }
    // 町・字などのつながり(路線の線は MapLibre が描く)
    ctx.strokeStyle = C.line; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.8; ctx.beginPath();
    for (const ed of S.edges.values()) {
      const a = pos.get(ed.a), b = pos.get(ed.b);
      if (!a || !b) continue;
      const na = S.nodes.get(ed.a), nb = S.nodes.get(ed.b);
      if (na.genre === 'station' && nb.genre === 'station') continue;
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
    // 印と名前(レベルの高い順に、重ならない名前だけ)
    const list = [...pos.keys()].map((id) => S.nodes.get(id)).sort((a, b) => b.level - a.level);
    const placed = [];
    ctx.font = '600 13px "BIZ UDPGothic", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
    for (const n of list) {
      const p = pos.get(n.id), r = n.genre === 'town' ? 4 : 5 + Math.min(8, Math.log10(Math.max(1, n.level)) * 3);
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
    if (moving) frames++;
  }
  map.on('render', draw);
})();
