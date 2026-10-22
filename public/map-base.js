'use strict';
// 地図の背景(docs/MAP-ENGINE.md 第 7 章・案 A): 陸・海・区市の境界・湖・地域の支配の色を MapLibre で描く。
// 拠点・線路・つながり・名前・航路は描かない(public/app.js が上に重ねた canvas で描く)。外への約束は 7.3 のとおりで、グローバルの PCMapBase だけを出す。
// 外のサイトからは何も読まない(タイル・フォント・字形データなし。文字を描かないので glyphs も持たない)
(() => {
  const HI_ZOOM = 8; // この zoom 以上で、見えている都道府県の細かい境界を読み足す(読んだ県は粗い全国版で塗らない)
  const NONE = 'rgba(0,0,0,0)';
  const DEFAULT_COLORS = { water: '#D6ECFA', land: '#F7F9FA', line: '#CBD3DC', lineStrong: '#8A97A6' };
  // 今の画面の段の境目(拡大率 ratio 0.7 / 0.18 / 0.05)を MapLibre の zoom に直したもの。縮小表示の輪郭の細さ・薄さを切り替える
  const Z_TIER2 = 8.8, Z_TIER3 = 6.8, Z_TIER4 = 5.0;

  const fc = (features) => ({ type: 'FeatureCollection', features });
  const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // ---------- 輪の並び(穴の区別なし。今の画面は even-odd で塗る)→ GeoJSON の MultiPolygon ----------
  // MapLibre は 1 つ目の輪を外側、2 つ目からを穴として塗るので、輪どうしの入れ子の深さを数えて組み直す
  // (深さが偶数 = 外側、奇数 = いちばん近い外側の輪の穴)。湖の中の島や、区の中に飛び地がある区を正しく抜くため
  function ringArea(r) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
    return Math.abs(a / 2);
  }
  function ringBox(r) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  }
  function inRing(pt, r) {
    const [x, y] = pt;
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const closeRing = (r) => {
    const a = r[0], b = r[r.length - 1];
    return a[0] === b[0] && a[1] === b[1] ? r : [...r, a];
  };
  function polysToMulti(polys) {
    const rings = (polys || []).filter((r) => r && r.length >= 3).map(closeRing);
    if (rings.length <= 1) return rings.map((r) => [r]);
    // 大きい輪から順に見て、それを囲む輪(すでに見た大きい輪)を数える
    const info = rings.map((r) => ({ r, area: ringArea(r), box: ringBox(r), depth: 0, poly: null }))
      .sort((a, b) => b.area - a.area);
    const out = [];
    for (let i = 0; i < info.length; i++) {
      const me = info[i];
      let parent = null;
      for (let j = 0; j < i; j++) {
        const o = info[j];
        if (o.box[0] > me.box[0] || o.box[1] > me.box[1] || o.box[2] < me.box[2] || o.box[3] < me.box[3]) continue;
        if (!inRing(me.r[0], o.r)) continue;
        me.depth++;
        if (!parent || o.area < parent.area) parent = o; // いちばん近い(小さい)囲み
      }
      if (me.depth % 2 === 1 && parent && parent.poly) parent.poly.push(me.r); // 穴
      else { me.poly = [me.r]; out.push(me.poly); }
    }
    return out;
  }
  // 地域 1 つ → GeoJSON の Feature。細かい版(bounds-hi)は multipolygon をそのまま、60 m 版・粗い全国版は polys を組み直す
  const regionFeature = (id, g, pref) => ({
    type: 'Feature',
    properties: { id, pref: pref || g.pref || String(id).split('-')[0] },
    geometry: { type: 'MultiPolygon', coordinates: Array.isArray(g.multipolygon) ? g.multipolygon : polysToMulti(g.polys) },
  });

  function create(opts) {
    const o = opts || {};
    const colors = { ...DEFAULT_COLORS, ...(o.colors || {}) };
    let overview = false;
    let loaded = false; // 地図の層を作り終えたか(それまでの setColors などは覚えておいて後で当てる)
    const ctl = new Map(); // 地域 id → { fill, frame }(今当てている支配の色)
    const prefOf = new Map(); // 地域 id → 都道府県 id(粗い全国版から)
    const hiPrefs = new Set(); // 細かい版を読み終えて層を足した都道府県
    const requested = new Set(); // 細かい版を頼んだ都道府県(読み終える前も含む。2 回頼まない)
    let prefIndex = null; // { <都道府県 id>: { file, bbox, hi } }

    maplibregl.setWorkerUrl('vendor/maplibre/maplibre-gl-csp-worker.js'); // 画面の安全設定(script-src 'self')に合わせた版
    const map = new maplibregl.Map({
      container: o.container,
      style: { version: 8, sources: {}, layers: [{ id: 'pc-bg', type: 'background', paint: { 'background-color': colors.water } }] },
      center: o.center || [139.7671, 35.6812], zoom: o.zoom != null ? o.zoom : 12,
      minZoom: o.minZoom != null ? o.minZoom : 4, maxZoom: o.maxZoom != null ? o.maxZoom : 18,
      renderWorldCopies: false,
      // 地図は北が上のまま(回転・傾きは切る)。ダブルタップ・ダブルクリックでの拡大も切る(拠点を続けて押すことがあるため)
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0, doubleClickZoom: false,
      attributionControl: false, // 出典・クレジットは画面(app.js)の側で出す
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    // ---------- 塗りと線の式(色・縮小表示・支配の色で変わる) ----------
    // 支配の色は feature-state(地域 id を promoteId で使う)に { fill, frame } を入れる。地域が 1,900 あっても式は 1 つで済み、色を変えても源を作り直さない
    const has = ['to-boolean', ['feature-state', 'frame']];
    const paintOf = () => ({
      land: { 'fill-color': colors.land },
      ctl: {
        'fill-color': ['to-color', ['coalesce', ['feature-state', 'fill'], NONE], NONE],
        'fill-opacity': overview ? 0.32 : 0.12,
      },
      // 輪郭: 支配者がいる地域はその枠の色ではっきり。縮小表示では縮小するほど細く薄く(日本全体では 1,900 の区・市の輪郭が陸を覆うため。今の画面と同じ値)
      border: {
        'line-color': ['to-color', ['coalesce', ['feature-state', 'frame'], colors.line], colors.line],
        'line-width': overview
          ? ['step', ['zoom'], ['case', has, 2, 0.5], Z_TIER4, ['case', has, 2, 0.8], Z_TIER3, ['case', has, 2, 1.5]]
          : 1,
        'line-opacity': overview
          ? ['step', ['zoom'], ['case', has, 0.9, 0.25], Z_TIER4, ['case', has, 0.9, 0.45], Z_TIER3, ['case', has, 0.9, 0.9]]
          : ['case', has, 0.9, 0.5],
      },
      water: { 'fill-color': colors.water },
    });
    const kindsOf = (src) => [['land', `${src}-land`], ['ctl', `${src}-ctl`], ['border', `${src}-border`]];
    const allSources = () => ['pc-coarse', ...[...hiPrefs].map((p) => `pc-hi-${p}`)];
    function applyPaint() {
      if (!loaded) return;
      const P = paintOf();
      map.setPaintProperty('pc-bg', 'background-color', colors.water);
      map.setPaintProperty('pc-water', 'fill-color', colors.water);
      for (const src of allSources()) for (const [k, id] of kindsOf(src)) for (const [name, v] of Object.entries(P[k])) map.setPaintProperty(id, name, v);
    }
    // 細かい版を読んだ県は粗い全国版で塗らない(海岸が約 1 km ずれるため)
    function applyCoarseFilter() {
      if (!loaded) return;
      const f = hiPrefs.size ? ['!', ['in', ['get', 'pref'], ['literal', [...hiPrefs]]]] : null;
      for (const [, id] of kindsOf('pc-coarse')) map.setFilter(id, f);
    }

    // 地域の源に層を 3 つ(陸・支配の色・輪郭)足す。重なりの順は 陸 → 支配の色 → 輪郭 → 湖・湾(どの源の層もこの順に並ぶよう、粗い全国版の層の前に差し込む)
    function addRegionLayers(src, before) {
      const P = paintOf();
      map.addLayer({ id: `${src}-land`, type: 'fill', source: src, paint: P.land }, before.land);
      map.addLayer({ id: `${src}-ctl`, type: 'fill', source: src, paint: P.ctl }, before.ctl);
      map.addLayer({ id: `${src}-border`, type: 'line', source: src, layout: { 'line-join': 'round' }, paint: P.border }, before.border);
    }

    // ---------- 地域の支配の色 ----------
    const sourcesOfRegion = (id) => {
      const p = prefOf.get(id) || String(id).split('-')[0];
      return hiPrefs.has(p) ? ['pc-coarse', `pc-hi-${p}`] : ['pc-coarse'];
    };
    function setRegionControls(list) {
      const next = new Map();
      for (const g of list || []) if (g && g.id != null && (g.fill || g.frame)) next.set(String(g.id), { fill: g.fill || null, frame: g.frame || null });
      if (loaded) {
        for (const id of ctl.keys()) if (!next.has(id)) for (const source of sourcesOfRegion(id)) map.removeFeatureState({ source, id });
        for (const [id, c] of next) {
          const old = ctl.get(id);
          if (old && old.fill === c.fill && old.frame === c.frame) continue;
          for (const source of sourcesOfRegion(id)) map.setFeatureState({ source, id }, c);
        }
      }
      ctl.clear();
      for (const [id, c] of next) ctl.set(id, c);
    }

    // ---------- 細かい境界: zoom 8 以上で、見えている範囲にかかる都道府県を読む(一度読んだ県は覚えておく) ----------
    // bounds-hi(約 10 m。穴を持つ multipolygon)があればそれを、無ければ bounds/<都道府県>.json(約 60 m)を使う
    async function loadIndex() {
      const [lo, hi] = await Promise.all([getJson('data/bounds/index.json'), getJson('data/bounds-hi/index.json')]);
      const out = {};
      for (const [p, v] of Object.entries((lo && lo.prefs) || {})) out[p] = { file: `data/bounds/${v.file}`, bbox: v.bbox, low: `data/bounds/${v.file}` };
      for (const [p, v] of Object.entries((hi && hi.prefs) || {})) out[p] = { ...(out[p] || {}), file: `data/bounds-hi/${v.file}`, bbox: v.bbox || (out[p] && out[p].bbox) };
      prefIndex = out;
      loadDetail();
    }
    async function loadPref(p) {
      requested.add(p);
      const ent = prefIndex[p];
      let d = await getJson(ent.file);
      if ((!d || !d.regions) && ent.low && ent.low !== ent.file) d = await getJson(ent.low); // 細かい版が届かなければ 60 m 版
      if (!d || !d.regions) return; // 境界が無くても遊べる(粗い全国版のまま)
      const feats = Object.entries(d.regions).map(([id, g]) => regionFeature(id, g, p));
      const src = `pc-hi-${p}`;
      map.addSource(src, { type: 'geojson', data: fc(feats), promoteId: 'id', tolerance: 0.25 });
      addRegionLayers(src, { land: 'pc-coarse-ctl', ctl: 'pc-coarse-border', border: 'pc-water' });
      hiPrefs.add(p);
      applyCoarseFilter();
      for (const f of feats) { const c = ctl.get(f.properties.id); if (c) map.setFeatureState({ source: src, id: f.properties.id }, c); }
    }
    function loadDetail() {
      if (!loaded || !prefIndex || map.getZoom() < HI_ZOOM) return;
      const b = map.getBounds();
      for (const [p, ent] of Object.entries(prefIndex)) {
        if (requested.has(p) || !ent.bbox) continue;
        const [w, s, e, n] = ent.bbox;
        if (e < b.getWest() || w > b.getEast() || n < b.getSouth() || s > b.getNorth()) continue;
        loadPref(p).catch(() => { /* 読めなくても粗い全国版のまま */ });
      }
    }

    // ---------- 地図を作る: 粗い全国版の陸地を読んだら ready ----------
    const ready = new Promise((resolve) => {
      map.on('load', async () => {
        map.addSource('pc-coarse', { type: 'geojson', data: fc([]), promoteId: 'id' });
        map.addSource('pc-water', { type: 'geojson', data: fc([]) });
        const P = paintOf();
        map.addLayer({ id: 'pc-water', type: 'fill', source: 'pc-water', paint: P.water });
        addRegionLayers('pc-coarse', { land: 'pc-water', ctl: 'pc-water', border: 'pc-water' });
        loaded = true;
        applyPaint(); // create のあと ready の前に変えられた色・縮小表示
        const pending = [...ctl.entries()]; ctl.clear(); setRegionControls(pending.map(([id, c]) => ({ id, ...c })));
        // 湖・湾(全国で 1 ファイル)。島は穴として抜く
        getJson('data/water.json').then((d) => {
          if (!d || !Array.isArray(d.water)) return;
          map.getSource('pc-water').setData(fc(d.water.map((w) => ({ type: 'Feature', properties: { id: w.id }, geometry: { type: 'MultiPolygon', coordinates: polysToMulti(w.polys) } }))));
        });
        loadIndex();
        const japan = await getJson('data/bounds/japan.json');
        if (japan && japan.regions) {
          const feats = Object.entries(japan.regions).map(([id, g]) => regionFeature(id, g, g.pref));
          for (const f of feats) prefOf.set(f.properties.id, f.properties.pref);
          map.getSource('pc-coarse').setData(fc(feats));
        }
        resolve();
      });
    });
    map.on('moveend', loadDetail);
    let zoomTarget = null; // zoomBy の行き先の倍率

    // ---------- 外への約束(7.3) ----------
    return {
      map,
      ready,
      project(lon, lat) { const p = map.project([lon, lat]); return { x: p.x, y: p.y }; },
      unproject(x, y) { const q = map.unproject([x, y]); return { lon: q.lng, lat: q.lat }; },
      getZoom: () => map.getZoom(),
      // Web メルカトルでは経度 1 度の幅はどの緯度でも同じ(世界 1 周が 512 * 2^zoom px)
      pxPerDegLon: () => (512 * 2 ** map.getZoom()) / 360,
      getBounds() { const b = map.getBounds(); return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }; },
      jumpTo(v) { map.jumpTo({ center: v.center, zoom: v.zoom }); },
      // + / − を続けて押したときは、動いている途中の倍率ではなく行き先の倍率から足す(押した回数ぶん確実に変わるように)
      zoomBy(delta, at) {
        const base = map.isEasing() && zoomTarget != null ? zoomTarget : map.getZoom();
        zoomTarget = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), base + delta));
        map.easeTo({ zoom: zoomTarget, duration: 200, ...(at ? { around: map.unproject([at.x, at.y]) } : {}) });
      },
      // click はドラッグでないタップ・クリックのときだけ(MapLibre が動かした距離で見分ける)。ほかは引数なしで呼ぶ。戻り値は外すための関数
      on(type, fn) {
        const h = type === 'click' ? (e) => fn({ x: e.point.x, y: e.point.y }) : () => fn();
        map.on(type, h);
        return () => map.off(type, h);
      },
      setColors(c) { Object.assign(colors, c || {}); applyPaint(); },
      setRegionControls,
      setOverview(v) { if (overview === !!v) return; overview = !!v; applyPaint(); },
    };
  }

  window.PCMapBase = { create };
})();
