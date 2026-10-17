'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const ctx = canvas.getContext('2d');

  // ---------- 状態 ----------
  const S = {
    ws: null, me: null, token: null, joined: false, wantJoin: false, retry: 0,
    home: null, spawn: null,
    nodes: new Map(),   // id → 拠点(サーバーから受け取った範囲だけ)
    edges: new Map(),   // key → {a, b}
    tiles: new Set(),   // 受け取っているタイル(z0)
    viewZ: 0, overview: false,
    players: [], log: [], offset: 0,
    question: null, result: null, chosen: null, cooldownUntil: 0,
    selected: null, centerPending: false,
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても遊べる */ } },
  };
  const now = () => Date.now() + S.offset;
  const nodeById = (id) => S.nodes.get(id);
  const playerById = (id) => S.players.find((p) => p.id === id);
  const ownerOf = (id) => { const n = nodeById(id); return n ? n.owner : null; };
  const colorOf = (pid) => { const p = playerById(pid); return p ? p.color : null; };

  // ---------- 初期表示 ----------
  $('nameInput').value = store.get('pc-name') || '';
  $('codeInput').value = store.get('pc-token') || '';

  // ---------- 通信 ----------
  const SERVER_HINT = 'サーバーに接続できません。ターミナルで npm.cmd start を実行し、ブラウザで http://localhost:3000 を開いてください。';
  function connect() {
    if (location.protocol === 'file:' || !location.host) {
      $('lobbyError').textContent = 'このファイルを直接開いても遊べません。' + SERVER_HINT;
      S.wantJoin = false; setJoining(false);
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => { setConn(true); S.retry = 0; if (S.wantJoin) sendJoin(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      setConn(false);
      if (!S.joined) { $('lobbyError').textContent = SERVER_HINT; setJoining(false); }
      S.tiles.clear(); // 再接続後にタイルを取り直す
      if (S.wantJoin) setTimeout(connect, Math.min(8000, 1000 * 2 ** S.retry++));
    };
  }
  function setJoining(on) {
    const btn = $('joinForm').querySelector('button[type="submit"]');
    btn.disabled = on; btn.textContent = on ? '接続中…' : '東京に参加する';
  }
  function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); }
  function sendJoin() { send({ t: 'join', name: $('nameInput').value.trim(), token: S.token || undefined }); }
  function setConn(on) { $('conn').dataset.state = on ? 'on' : 'off'; $('conn').textContent = on ? '接続中' : '再接続中…'; }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        S.me = m.id; S.token = m.token; S.joined = true; S.home = m.home; S.spawn = m.spawn;
        store.set('pc-token', m.token); store.set('pc-name', m.name);
        $('codeInput').value = m.token;
        $('lobby').hidden = true; $('mePanel').hidden = false; $('onlineChip').hidden = false;
        $('lobbyError').textContent = ''; $('meCode').textContent = m.token;
        resize();
        if (S.home) centerOn(worldOf(S.home.lat, S.home.lon), 9); else if (S.spawn) centerOn(worldOf(S.spawn.lat, S.spawn.lon), 9);
        requestView(true);
        break;
      case 'tiles': onTiles(m); break;
      case 'nodes':
        for (const n of m.nodes) if (S.nodes.has(n.id) || S.tiles.has(n.t0)) { S.nodes.set(n.id, n); }
        renderSelected();
        break;
      case 'players':
        S.offset = m.now - Date.now(); S.players = m.players; S.log = m.log || S.log;
        renderPlayers(); renderSelected();
        break;
      case 'question': S.question = m; S.result = null; S.chosen = null; renderQuestion(); break;
      case 'result': S.result = m; S.cooldownUntil = m.cooldownUntil; renderQuestion(); break;
      case 'error':
        if (!S.joined) { $('lobbyError').textContent = m.message; S.wantJoin = false; setJoining(false); } else toast(m.message);
        break;
    }
  }

  // 受け取ったタイルを取り込み、見えなくなったタイルの拠点を捨てる
  function onTiles(m) {
    if (m.overview) {
      // 縮小表示: 送られてきた高レベルの拠点だけに入れ替える
      S.nodes.clear(); S.edges.clear(); S.tiles.clear(); S.overview = true; S.viewZ = m.z;
      for (const n of m.nodes) S.nodes.set(n.id, n);
      return;
    }
    if (S.overview) { S.nodes.clear(); S.edges.clear(); S.tiles.clear(); S.overview = false; }
    S.viewZ = 0;
    for (const t of m.dropped) {
      S.tiles.delete(t);
      for (const [id, n] of S.nodes) if (n.t0 === t && !(S.home && id === S.home.id)) S.nodes.delete(id);
    }
    for (const t of m.added) S.tiles.add(t);
    for (const n of m.nodes) S.nodes.set(n.id, n);
    for (const e of m.edges) S.edges.set(e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`, e);
    for (const [k, e] of S.edges) if (!S.nodes.has(e.a) && !S.nodes.has(e.b)) S.edges.delete(k);
    renderSelected();
  }

  // ---------- 参加 ----------
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nameInput').value.trim();
    if (!name) { $('lobbyError').textContent = '名前を入れてください'; return; }
    store.set('pc-name', name);
    S.token = $('codeInput').value.trim() || null;
    S.wantJoin = true; $('lobbyError').textContent = ''; setJoining(true);
    if (S.ws && S.ws.readyState === 1) sendJoin(); else if (!S.ws || S.ws.readyState !== 0) connect();
  });
  $('copyCodeBtn').onclick = () => {
    const code = S.token || '';
    if (navigator.clipboard && code) navigator.clipboard.writeText(code).then(() => toast('復帰コードをコピーしました'), () => toast('コードを選択してコピーしてください'));
    else toast('コードを選択してコピーしてください');
  };

  // ---------- 投影: 固定の縮尺(経度・緯度 → 平面座標。1 単位 = 0.001°) ----------
  const LAT0 = 35.68; // 横方向の補正の基準(東京)。地図が世界に広がったらメルカトルに変える
  const KX = Math.cos((LAT0 * Math.PI) / 180);
  const worldOf = (lat, lon) => ({ x: lon * 1000 * KX, y: -lat * 1000 });
  const latLonOf = (x, y) => ({ lat: -y / 1000, lon: x / (1000 * KX) });
  const posOf = (n) => { if (!n._p) n._p = worldOf(n.lat, n.lon); return n._p; };

  // ---------- 地図: 拡大縮小と移動 ----------
  // k: 平面座標 → 画面ピクセルの倍率。tx, ty: 画面の左上にある平面座標。BASE_K は「1 倍」(1° ≈ 1100 px)
  const BASE_K = 1.1;
  const V = { k: BASE_K, tx: 0, ty: 0, w: 0, h: 0 };
  const ZOOM_MIN = 0.02, ZOOM_MAX = 50; // 1 倍に対する比。0.02 倍で日本全体が入る
  const toScreen = (p) => ({ x: (p.x - V.tx) * V.k, y: (p.y - V.ty) * V.k });
  const toWorld = (sx, sy) => ({ x: sx / V.k + V.tx, y: sy / V.k + V.ty });
  const zoomRatio = () => V.k / BASE_K;
  const shrink = () => Math.min(1, Math.max(0.35, zoomRatio() / 6));
  const radiusOf = (n) => shrink() * (n.isPlayerNode ? 8
    : 11 + Math.min(10, n.level) * 0.6 + Math.min(9, Math.floor((n.level - 1) / 10)) * 0.4 + Math.min(9, Math.floor((n.level - 1) / 100)) * 0.8);

  function resize() {
    const box = $('mapWrap');
    const w = Math.max(280, box.clientWidth);
    const h = Math.round(Math.min(620, Math.max(380, w * 0.7)));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (V.w) { const c = toWorld(V.w / 2, V.h / 2); V.w = w; V.h = h; centerOn(c); } else { V.w = w; V.h = h; }
    requestView();
  }
  window.addEventListener('resize', resize);
  const clampK = (k) => Math.min(BASE_K * ZOOM_MAX, Math.max(BASE_K * ZOOM_MIN, k));
  function zoomAt(factor, sx, sy) {
    const before = toWorld(sx, sy);
    V.k = clampK(V.k * factor);
    V.tx = before.x - sx / V.k; V.ty = before.y - sy / V.k;
    requestView();
  }
  function centerOn(p, ratio) {
    if (ratio) V.k = clampK(BASE_K * ratio);
    V.tx = p.x - V.w / 2 / V.k; V.ty = p.y - V.h / 2 / V.k;
    requestView();
  }
  function centerOnMine() {
    if (S.home) centerOn(worldOf(S.home.lat, S.home.lon), Math.max(9, zoomRatio()));
    else if (S.spawn) centerOn(worldOf(S.spawn.lat, S.spawn.lon), Math.max(9, zoomRatio()));
  }
  $('zoomIn').onclick = () => zoomAt(1.4, V.w / 2, V.h / 2);
  $('zoomOut').onclick = () => zoomAt(1 / 1.4, V.w / 2, V.h / 2);
  $('zoomHome').onclick = centerOnMine;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  // ---------- 見えている範囲のタイルをサーバーに頼む ----------
  // 拡大率 → タイルの段(DESIGN.md 第 13 章)。広いほど粗い段で、高いレベルの拠点だけ
  function zoomTier() {
    const r = zoomRatio();
    if (r >= 2.5) return 0;
    if (r >= 0.7) return 1;
    if (r >= 0.18) return 2;
    if (r >= 0.05) return 3;
    return 4;
  }
  const TILE_LAT = 0.025, TILE_LON = 0.03;
  function tilesInView(z) {
    const a = latLonOf(V.tx, V.ty), b = latLonOf(V.tx + V.w / V.k, V.ty + V.h / V.k);
    const s = { lat: TILE_LAT * 4 ** z, lon: TILE_LON * 4 ** z };
    const minLat = Math.min(a.lat, b.lat), maxLat = Math.max(a.lat, b.lat), minLon = Math.min(a.lon, b.lon), maxLon = Math.max(a.lon, b.lon);
    const pad = z === 0 ? 1 : 0; // 細かい段は周囲 1 周も先読み
    const y0 = Math.floor(minLat / s.lat) - pad, y1 = Math.floor(maxLat / s.lat) + pad;
    const x0 = Math.floor(minLon / s.lon) - pad, x1 = Math.floor(maxLon / s.lon) + pad;
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`t${z}:${y}:${x}`);
    return out;
  }
  let viewTimer = null, lastViewKey = '';
  function requestView(force) {
    if (!S.joined) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      let z = zoomTier();
      let tiles = tilesInView(z);
      while (tiles.length > 80 && z < 4) { z++; tiles = tilesInView(z); }
      const key = `${z}:${tiles.join(',')}`;
      if (!force && key === lastViewKey) return;
      lastViewKey = key;
      send({ t: 'view', z, tiles });
    }, force ? 0 : 150);
  }

  // ドラッグで移動、2 本指でピンチ。動かさずに離したらタップ扱い
  const pointers = new Map();
  let gesture = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    const pts = [...pointers.values()];
    if (pts.length === 1) gesture = { type: 'drag', start: pts[0], tx: V.tx, ty: V.ty, moved: false };
    else if (pts.length === 2) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      gesture = { type: 'pinch', dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), k: V.k, world: toWorld(mid.x, mid.y), moved: true };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      const n = nodeAt(local(e));
      canvas.style.cursor = n && (canAttack(n.id) || ownerOf(n.id) === S.me) ? 'pointer' : 'grab';
      return;
    }
    pointers.set(e.pointerId, local(e));
    const pts = [...pointers.values()];
    if (!gesture) return;
    if (gesture.type === 'drag' && pts.length === 1) {
      const dx = pts[0].x - gesture.start.x, dy = pts[0].y - gesture.start.y;
      if (Math.hypot(dx, dy) > 4) gesture.moved = true;
      if (gesture.moved) { V.tx = gesture.tx - dx / V.k; V.ty = gesture.ty - dy / V.k; canvas.style.cursor = 'grabbing'; requestView(); }
    } else if (gesture.type === 'pinch' && pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      V.k = clampK((gesture.k * dist) / Math.max(1, gesture.dist));
      V.tx = gesture.world.x - mid.x / V.k; V.ty = gesture.world.y - mid.y / V.k;
      requestView();
    }
  });
  const endPointer = (e) => {
    const was = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (gesture && gesture.type === 'drag' && !gesture.moved && was && e.type === 'pointerup') tapAt(was);
    gesture = pointers.size === 1 ? { type: 'drag', start: [...pointers.values()][0], tx: V.tx, ty: V.ty, moved: true } : null;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // 拠点を選ぶ: どの拠点でも情報パネルに出す。攻撃・強化できる拠点なら出題も求める
  function tapAt(pt) {
    const n = nodeAt(pt);
    if (!S.joined) return;
    if (!n) { S.selected = null; renderSelected(); return; }
    S.selected = n.id;
    renderSelected();
    const actionable = !S.overview && (canAttack(n.id) || n.owner === S.me);
    if (!actionable) return;
    if (now() < S.cooldownUntil) { toast('不正解のため通信が止まっています'); return; }
    send({ t: 'ask', nodeId: n.id });
  }

  function adjacent(id) {
    const out = [];
    for (const e of S.edges.values()) { if (e.a === id) out.push(e.b); else if (e.b === id) out.push(e.a); }
    return out;
  }
  // サーバーの canAttack と同じ条件(表示用。判定はサーバーが行う)
  function canAttack(id) {
    const n = nodeById(id);
    if (!n || !S.me || n.owner === S.me) return false;
    if (n.hackable === false) return false;
    if (n.protectedUntil > now()) return false;
    if (n.owner) { const o = playerById(n.owner); if (o && o.nodes <= 3) return false; }
    return adjacent(id).some((a) => ownerOf(a) === S.me);
  }

  // ---------- 描画: パネル ----------
  const GENRE_LABELS = {
    station: '駅', bus_terminal: 'バスターミナル', airport: '空港', port: '港', bridge: '橋', tower: '塔・展望施設',
    park: '公園・庭園', nature: '自然の名所', zoo_aquarium: '動物園・水族館・植物園', museum: '博物館・美術館', library: '図書館',
    theater: '劇場・ホール', stadium: 'スタジアム・競技場', heritage: '歴史的建造物', monument: '記念碑・広場', shrine_temple: '寺社',
    government: '官公庁', university: '大学・研究', market: '市場・商店街', convention: '展示場・会議場', complex: '複合施設',
    observatory: '天文台', ix: '相互接続点',
  };
  function renderPlayers() {
    const players = [...S.players].sort((a, b) => b.score - a.score || b.points - a.points);
    $('onlineCount').textContent = S.players.filter((p) => p.online).length;
    const me = playerById(S.me);
    if (me) {
      $('meSwatch').style.background = me.color; $('meName').textContent = me.name;
      $('meScore').textContent = `${me.score}点`; $('meNodes').textContent = `${me.nodes}拠点`; $('mePoints').textContent = me.points;
    }
    $('scores').replaceChildren(...players.slice(0, 15).map((p, i) => {
      const li = document.createElement('li');
      if (!p.online) li.className = 'offline';
      const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = i + 1;
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = p.color;
      const n = document.createElement('span'); n.className = 'pname'; n.textContent = p.name;
      const sm = document.createElement('small'); sm.textContent = p.id === S.me ? 'あなた' : `${p.nodes}拠点`; n.append(sm);
      const sc = document.createElement('span'); sc.className = 'pscore'; sc.textContent = `${p.score}点`;
      li.append(rank, sw, n, sc); return li;
    }));
    $('log').replaceChildren(...S.log.map((l) => { const li = document.createElement('li'); li.textContent = l.text; return li; }));
    $('log').scrollTop = $('log').scrollHeight;
  }
  function renderSelected() {
    const n = S.selected && nodeById(S.selected);
    $('nodePanel').hidden = !n;
    if (!n) return;
    const owner = n.owner ? playerById(n.owner) : null;
    $('npName').textContent = n.name;
    $('npMeta').textContent = [n.isPlayerNode ? 'プレイヤーの拠点' : GENRE_LABELS[n.genre] || '', n.area || ''].filter(Boolean).join(' ・ ');
    $('npLevel').textContent = `Lv${n.level}${n.defense ? `(+${n.defense} 強化 → 出題 Lv${n.level + n.defense})` : ''}`;
    $('npValue').textContent = `${n.value}点`;
    $('npOwner').textContent = owner ? `${owner.name}${owner.id === S.me ? '(あなた)' : ''}` : (n.owner ? '他のプレイヤー' : '中立');
    const lines = Array.isArray(n.lines) ? n.lines : [];
    $('npLines').hidden = !lines.length;
    $('npLinesList').replaceChildren(...lines.map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
    let status;
    if (S.overview) status = '拡大すると攻撃や強化ができます';
    else if (n.hackable === false) status = 'ネットワークにつながっていない場所です(ハック不可)';
    else if (n.owner === S.me) status = 'タップすると強化の問題が出ます';
    else if (n.protectedUntil > now()) status = `生まれたばかりで守られています(あと ${Math.ceil((n.protectedUntil - now()) / 3600000)} 時間)`;
    else if (n.owner && (playerById(n.owner) || {}).nodes <= 3) status = '拠点が少ないプレイヤーは守られています';
    else if (canAttack(n.id)) status = 'タップすると攻撃の問題が出ます';
    else status = '自分の拠点とつながっていないため、まだ攻撃できません';
    $('npStatus').textContent = status;
  }

  // ---------- 描画: 問題 ----------
  function renderQuestion() {
    const q = S.question;
    $('qIdle').hidden = !!q; $('qBox').hidden = !q;
    if (!q) return;
    const node = nodeById(q.nodeId);
    const tag = document.createElement('span');
    tag.className = q.mode === 'attack' ? 'tag' : 'tag def';
    tag.textContent = q.mode === 'attack' ? '攻撃' : '強化';
    $('qMode').replaceChildren(tag, document.createTextNode(node ? node.name : ''));
    $('qDiff').textContent = `難易度 Lv${q.level}` + (q.provisional ? '(暫定: この難易度の問題は準備中。いまは Lv10 相当)' : '');
    const textNodes = [];
    q.text.split('\n').forEach((line, i) => { if (i) textNodes.push(document.createElement('br')); textNodes.push(...highlightIps(line)); });
    $('qText').replaceChildren(...textNodes);
    const tbl = $('qTable'); tbl.replaceChildren(); tbl.hidden = !q.table;
    if (q.table) {
      const thead = document.createElement('thead'); const hr = document.createElement('tr');
      q.table.headers.forEach((h) => { const th = document.createElement('th'); th.textContent = h; hr.append(th); });
      thead.append(hr);
      const tbody = document.createElement('tbody');
      q.table.rows.forEach((row) => { const tr = document.createElement('tr'); row.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.append(td); }); tbody.append(tr); });
      tbl.append(thead, tbody);
    }
    const r = S.result && S.result.qid === q.qid ? S.result : null;
    $('qOptions').replaceChildren(...q.options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'opt'; b.id = `opt${i}`;
      const k = document.createElement('span'); k.className = 'k'; k.textContent = i + 1;
      b.append(k, document.createTextNode(o));
      if (r) { b.disabled = true; if (i === r.answerIndex) b.classList.add('correct'); else if (i === S.chosen) b.classList.add('wrong'); }
      b.onclick = () => choose(i);
      return b;
    }));
    $('qResult').hidden = !r;
    if (r) {
      $('qVerdict').textContent = r.correct ? '正解' : '不正解';
      $('qVerdict').className = `verdict ${r.correct ? 'ok' : 'ng'}`;
      $('qExplain').textContent = r.explanation; $('qOutcome').textContent = r.outcome;
    }
  }
  function choose(i) {
    const q = S.question;
    if (!q || (S.result && S.result.qid === q.qid) || S.chosen != null) return;
    S.chosen = i; send({ t: 'answer', qid: q.qid, choice: i });
  }
  function highlightIps(text) {
    return text.split(/(\d+\.\d+\.\d+\.\d+(?:\/\d+)?|\/\d+)/).filter(Boolean).map((part) => {
      if (/^(\d+\.\d+\.\d+\.\d+(\/\d+)?|\/\d+)$/.test(part)) { const s = document.createElement('span'); s.className = 'ip'; s.textContent = part; return s; }
      return document.createTextNode(part);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const n = Number(e.key); if (n >= 1 && n <= 4) choose(n - 1);
  });

  // ---------- 拠点の形(shapes.js と共有) ----------
  const SH = window.PCShapes;
  function shape(n, p, r) {
    if (n.isPlayerNode) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); return; }
    SH.path(ctx, n.level, p, r);
  }
  function buildLegend() {
    const css = getComputedStyle(document.documentElement);
    const color = css.getPropertyValue('--line-strong').trim(), surface = css.getPropertyValue('--surface').trim();
    const dpr = window.devicePixelRatio || 1;
    const items = [];
    for (let lv = 1; lv <= 10; lv++) {
      const li = document.createElement('li');
      const cv = document.createElement('canvas');
      cv.width = 26 * dpr; cv.height = 26 * dpr; cv.style.width = '26px'; cv.style.height = '26px';
      const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
      SH.draw(c, lv, { x: 13, y: 13 }, 7, { fill: surface, stroke: color, lineWidth: 2.5 });
      li.append(cv, document.createTextNode(`Lv${lv}`)); li.title = SH.SHAPE_NAMES[lv];
      items.push(li);
    }
    $('legend').prepend(...items);
  }
  buildLegend();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    $('legend').querySelectorAll('li:has(canvas)').forEach((li) => li.remove()); buildLegend();
  });

  // ---------- 描画: 地図 ----------
  function draw(t) {
    requestAnimationFrame(draw);
    tickUi();
    const css = getComputedStyle(document.documentElement);
    const tok = (n) => css.getPropertyValue(n).trim();
    const C = { surface: tok('--surface'), ink: tok('--ink'), muted: tok('--muted'), line: tok('--line'), strong: tok('--line-strong'), accent: tok('--accent') };
    ctx.clearRect(0, 0, V.w, V.h);
    if (!S.joined) return;
    const ratio = zoomRatio();
    const grow = V.w < 600 ? 1.15 : 1;

    // 線路(リンク)
    ctx.lineCap = 'round';
    for (const e of S.edges.values()) {
      const na = nodeById(e.a), nb = nodeById(e.b);
      if (!na || !nb) continue;
      const a = toScreen(posOf(na)), b = toScreen(posOf(nb));
      const own = na.owner && na.owner === nb.owner ? colorOf(na.owner) : null;
      const thin = na.isPlayerNode || nb.isPlayerNode;
      ctx.strokeStyle = own || C.line;
      ctx.lineWidth = (own ? (thin ? 5 : 7) : (thin ? 2.5 : 4)) * Math.min(1, Math.max(0.4, ratio / 4));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // 拠点: プレイヤーの拠点 → 固定拠点 → 選択中(最前面)
    const pulse = 0.5 + 0.5 * Math.sin(t / 260);
    const rank = (n) => (n.id === S.selected ? 2 : n.isPlayerNode ? 0 : 1);
    const sorted = [...S.nodes.values()].sort((a, b) => rank(a) - rank(b));
    for (const n of sorted) {
      const p = toScreen(posOf(n));
      if (p.x < -60 || p.y < -60 || p.x > V.w + 60 || p.y > V.h + 60) continue;
      const r = radiusOf(n) * grow;
      const owner = n.owner ? colorOf(n.owner) || C.strong : null;
      const ring = n.isPlayerNode ? r : SH.outerRadius(n.level, r);
      if (!S.overview && canAttack(n.id)) {
        ctx.strokeStyle = C.accent; ctx.globalAlpha = 0.45 + 0.55 * pulse; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(p.x, p.y, ring + 6, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (S.question && S.question.nodeId === n.id && !(S.result && S.result.qid === S.question.qid)) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(p.x, p.y, ring + 11, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      } else if (S.selected === n.id) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, ring + 9, 0, Math.PI * 2); ctx.stroke();
      }
      if (n.protectedUntil > now()) {
        ctx.strokeStyle = C.muted; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(p.x, p.y, ring + 4, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
      const filled = !n.isPlayerNode && SH.isFilled(n.level);
      const col = owner || (filled ? C.ink : C.strong);
      if (n.hackable === false) ctx.globalAlpha = 0.45;
      ctx.fillStyle = filled ? col : C.surface; ctx.strokeStyle = col;
      ctx.lineWidth = owner ? (n.isPlayerNode ? 5 : 7) : (n.isPlayerNode ? 3 : 4);
      shape(n, p, r); ctx.fill(); ctx.stroke();
      if (!n.isPlayerNode) SH.extras(ctx, n.level, p, r, col, C.surface);
      if (owner && n.owner === S.me) { ctx.fillStyle = filled ? C.surface : owner; ctx.beginPath(); ctx.arc(p.x, p.y, n.isPlayerNode ? 3 : 4, 0, Math.PI * 2); ctx.fill(); }
      const top = ring;
      for (let i = 0; i < Math.min(n.defense, 12); i++) { ctx.fillStyle = C.ink; ctx.fillRect(p.x - (Math.min(n.defense, 12) * 8 - 3) / 2 + i * 8, p.y - top - 9, 5, 5); }
      // 名前: 寄ったときだけ全部。縮小時はレベルの高いものと自分の拠点
      const showLabel = S.overview ? true : n.isPlayerNode
        ? (ratio >= 7 || n.owner === S.me)
        : (ratio >= 7 || (ratio >= 3.5 && n.level >= 2) || (ratio >= 1.5 && n.level >= 3) || n.level >= 4 || n.kind === 'IX' || n.kind === 'GW' || n.owner === S.me);
      if (showLabel) {
        const isSel = S.selected === n.id, dim = S.selected && !isSel;
        ctx.textAlign = 'center';
        const fs = n.kind === 'IX' ? 14 : n.isPlayerNode ? 10 : 11.5;
        ctx.font = `${n.isPlayerNode ? 500 : 700} ${fs * grow}px "BIZ UDPGothic", sans-serif`;
        const ty = p.y + top + 12 * grow;
        if (isSel) {
          const w = ctx.measureText(n.name).width + 10, h = fs * grow + 6;
          ctx.fillStyle = C.surface; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(p.x - w / 2, ty - h + 4, w, h, 4); else ctx.rect(p.x - w / 2, ty - h + 4, w, h);
          ctx.fill(); ctx.stroke();
        }
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = n.isPlayerNode && !isSel ? C.muted : C.ink;
        ctx.fillText(n.name, p.x, ty);
      }
      ctx.globalAlpha = 1;
    }
    if (S.overview) {
      ctx.fillStyle = C.muted; ctx.font = '600 12px "BIZ UDPGothic", sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`広域表示: Lv${{ 1: 2, 2: 4, 3: 50, 4: 400 }[S.viewZ] || ''} 以上の拠点だけ。拡大すると全部出ます`, 12, V.h - 10);
    }
  }
  function nodeAt(pt) {
    let best = null, bd = Infinity;
    for (const n of S.nodes.values()) {
      const p = toScreen(posOf(n));
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < radiusOf(n) + 10 && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  // ---------- 待ち時間 ----------
  function tickUi() {
    const cd = S.cooldownUntil - now();
    $('cool').hidden = cd <= 0;
    if (cd > 0) $('coolBar').style.transform = `scaleX(${cd / 4000})`;
  }
  let toastTimer;
  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
  }

  resize();
  requestAnimationFrame(draw);
})();
