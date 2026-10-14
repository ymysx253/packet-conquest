'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const ctx = canvas.getContext('2d');

  // 描画用の仮想的な地図の大きさ。緯度・経度からこの範囲に投影する(サーバーは座標を送らない)
  const MAP_W = 1000, MAP_H = 680, MAP_MARGIN = 70;

  const S = {
    ws: null, me: null, token: null, state: null,
    question: null, result: null, chosen: null, cooldownUntil: 0,
    offset: 0, joined: false, wantJoin: false, retry: 0,
    pos: {}, posKey: '',
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても遊べる */ } },
  };
  const now = () => Date.now() + S.offset;

  // ---------- 初期表示 ----------
  $('nameInput').value = store.get('pc-name') || '';
  $('codeInput').value = store.get('pc-token') || '';

  // ---------- 通信 ----------
  const SERVER_HINT = 'サーバーに接続できません。ターミナルで npm.cmd start を実行し、ブラウザで http://localhost:3000 を開いてください。';
  function connect() {
    if (location.protocol === 'file:' || !location.host) {
      // index.html を直接開いた場合。サーバーを通さないと遊べない
      $('lobbyError').textContent = 'このファイルを直接開いても遊べません。' + SERVER_HINT;
      S.wantJoin = false; setJoining(false);
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      setConn(true);
      S.retry = 0;
      if (S.wantJoin) sendJoin();
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      setConn(false);
      if (!S.joined) { $('lobbyError').textContent = SERVER_HINT; setJoining(false); }
      if (S.wantJoin) setTimeout(connect, Math.min(8000, 1000 * 2 ** S.retry++));
    };
  }
  function setJoining(on) {
    const btn = $('joinForm').querySelector('button[type="submit"]');
    btn.disabled = on;
    btn.textContent = on ? '接続中…' : '東京に参加する';
  }
  function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); }
  function sendJoin() {
    send({ t: 'join', name: $('nameInput').value.trim(), token: S.token || undefined });
  }
  function setConn(on) {
    $('conn').dataset.state = on ? 'on' : 'off';
    $('conn').textContent = on ? '接続中' : '再接続中…';
  }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        S.me = m.id; S.token = m.token; S.joined = true;
        store.set('pc-token', m.token); store.set('pc-name', m.name);
        $('codeInput').value = m.token;
        $('lobby').hidden = true; $('mePanel').hidden = false; $('onlineChip').hidden = false;
        $('lobbyError').textContent = '';
        $('meCode').textContent = m.token;
        S.centerPending = true;
        resize();
        break;
      case 'state':
        S.offset = m.now - Date.now();
        S.state = m;
        layout();
        if (S.centerPending && S.pos[m.nodes.find((n) => n.owner === S.me && n.isPlayerNode)?.id]) {
          S.centerPending = false; centerOnMine();
        }
        renderState();
        break;
      case 'question':
        S.question = m; S.result = null; S.chosen = null; renderQuestion();
        break;
      case 'result':
        S.result = m; S.cooldownUntil = m.cooldownUntil; renderQuestion();
        break;
      case 'error':
        if (!S.joined) { $('lobbyError').textContent = m.message; S.wantJoin = false; setJoining(false); } else toast(m.message);
        break;
    }
  }

  // ---------- 参加 ----------
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nameInput').value.trim();
    if (!name) { $('lobbyError').textContent = '名前を入れてください'; return; }
    store.set('pc-name', name);
    S.token = $('codeInput').value.trim() || null;
    S.wantJoin = true;
    $('lobbyError').textContent = '';
    setJoining(true);
    if (S.ws && S.ws.readyState === 1) sendJoin();
    else if (!S.ws || S.ws.readyState !== 0) connect();
  });
  $('copyCodeBtn').onclick = () => {
    const code = S.token || '';
    if (navigator.clipboard && code) {
      navigator.clipboard.writeText(code).then(() => toast('復帰コードをコピーしました'), () => toast('コードを選択してコピーしてください'));
    } else toast('コードを選択してコピーしてください');
  };

  // ---------- 投影: 緯度・経度 → 仮想座標(拠点が増えて範囲が広がっても作り直さない) ----------
  function layout() {
    const nodes = S.state.nodes;
    const key = nodes.map((n) => n.id).join(',');
    if (key === S.posKey) return;
    S.posKey = key;
    const lats = nodes.map((n) => n.lat), lons = nodes.map((n) => n.lon);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const spanX = (maxLon - minLon) * kx || 1e-9, spanY = (maxLat - minLat) || 1e-9;
    const sc = Math.min((MAP_W - 2 * MAP_MARGIN) / spanX, (MAP_H - 2 * MAP_MARGIN) / spanY);
    const ox = (MAP_W - spanX * sc) / 2, oy = (MAP_H - spanY * sc) / 2;
    S.pos = {};
    for (const n of nodes) S.pos[n.id] = { x: ox + (n.lon - minLon) * kx * sc, y: oy + (maxLat - n.lat) * sc };
  }

  // ---------- 描画: パネル ----------
  const nodeById = (id) => S.state && S.state.nodes.find((n) => n.id === id);
  const playerById = (id) => S.state && S.state.players.find((p) => p.id === id);
  const ownerOf = (id) => { const n = nodeById(id); return n ? n.owner : null; };
  const colorOf = (pid) => { const p = playerById(pid); return p ? p.color : null; };

  function renderState() {
    const st = S.state; if (!st) return;
    const players = [...st.players].sort((a, b) => b.score - a.score || b.points - a.points);
    $('onlineCount').textContent = st.players.filter((p) => p.online).length;

    const me = playerById(S.me);
    if (me) {
      $('meSwatch').style.background = me.color;
      $('meName').textContent = me.name;
      $('meScore').textContent = `${me.score}点`;
      $('meNodes').textContent = `${me.nodes}拠点`;
      $('mePoints').textContent = me.points;
    }

    $('scores').replaceChildren(...players.slice(0, 15).map((p, i) => {
      const li = document.createElement('li');
      if (!p.online) li.className = 'offline';
      const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = i + 1;
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = p.color;
      const n = document.createElement('span'); n.className = 'pname'; n.textContent = p.name;
      const sm = document.createElement('small'); sm.textContent = p.id === S.me ? 'あなた' : `${p.nodes}拠点`;
      n.append(sm);
      const sc = document.createElement('span'); sc.className = 'pscore'; sc.textContent = `${p.score}点`;
      li.append(rank, sw, n, sc); return li;
    }));

    $('log').replaceChildren(...st.log.map((l) => {
      const li = document.createElement('li'); li.textContent = l.text; return li;
    }));
    $('log').scrollTop = $('log').scrollHeight;
  }

  // ---------- 描画: 問題 ----------
  function renderQuestion() {
    const q = S.question;
    $('qIdle').hidden = !!q; $('qBox').hidden = !q;
    if (!q) return;
    const node = nodeById(q.nodeId);
    const tag = document.createElement('span');
    tag.className = q.mode === 'attack' ? 'tag' : 'tag def';
    tag.textContent = q.mode === 'attack' ? '攻撃' : '防御強化';
    $('qMode').replaceChildren(tag, document.createTextNode(node ? node.name : ''));
    $('qDiff').textContent = `Lv${q.level} ${'●'.repeat(q.level)}${'○'.repeat(Math.max(0, 4 - q.level))}`;
    $('qText').replaceChildren(...highlightIps(q.text));

    const r = S.result && S.result.qid === q.qid ? S.result : null;
    $('qOptions').replaceChildren(...q.options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'opt'; b.id = `opt${i}`;
      const k = document.createElement('span'); k.className = 'k'; k.textContent = i + 1;
      b.append(k, document.createTextNode(o));
      if (r) {
        b.disabled = true;
        if (i === r.answerIndex) b.classList.add('correct');
        else if (i === S.chosen) b.classList.add('wrong');
      }
      b.onclick = () => choose(i);
      return b;
    }));
    $('qResult').hidden = !r;
    if (r) {
      $('qVerdict').textContent = r.correct ? '正解' : '不正解';
      $('qVerdict').className = `verdict ${r.correct ? 'ok' : 'ng'}`;
      $('qExplain').textContent = r.explanation;
      $('qOutcome').textContent = r.outcome;
    }
  }
  function choose(i) {
    const q = S.question;
    if (!q || (S.result && S.result.qid === q.qid) || S.chosen != null) return;
    S.chosen = i;
    send({ t: 'answer', qid: q.qid, choice: i });
  }
  function highlightIps(text) {
    return text.split(/(\d+\.\d+\.\d+\.\d+(?:\/\d+)?|\/\d+)/).filter(Boolean).map((part) => {
      if (/^(\d+\.\d+\.\d+\.\d+(\/\d+)?|\/\d+)$/.test(part)) {
        const s = document.createElement('span'); s.className = 'ip'; s.textContent = part; return s;
      }
      return document.createTextNode(part);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const n = Number(e.key);
    if (n >= 1 && n <= 4) choose(n - 1);
  });

  // ---------- 地図: 拡大縮小と移動 ----------
  const R = { IX: 17, GOV: 13, GW: 13, LM: 12, HUB: 12, DC: 12, EDU: 12, HOME: 8 };
  // k: 仮想座標 → 画面ピクセルの倍率。tx, ty: 画面の左上にある仮想座標。fit: 全体が収まる倍率
  const V = { k: 1, tx: 0, ty: 0, fit: 1, w: 0, h: 0 };
  const ZOOM_MIN = 0.7, ZOOM_MAX = 8; // fit に対する比
  const toScreen = (p) => ({ x: (p.x - V.tx) * V.k, y: (p.y - V.ty) * V.k });
  const toWorld = (sx, sy) => ({ x: sx / V.k + V.tx, y: sy / V.k + V.ty });
  const zoomRatio = () => V.k / V.fit;

  function resize() {
    const box = $('mapWrap');
    const w = Math.max(280, box.clientWidth);
    const h = Math.round(Math.min(620, Math.max(380, w * 0.7)));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const prevFit = V.fit;
    V.fit = Math.min(w / MAP_W, h / MAP_H);
    if (!V.w) {
      V.k = V.fit; V.tx = (MAP_W - w / V.k) / 2; V.ty = (MAP_H - h / V.k) / 2;
    } else {
      // 画面の中心を保ったまま、倍率を画面の大きさに比例させる
      const cx = V.tx + V.w / 2 / V.k, cy = V.ty + V.h / 2 / V.k;
      V.k = (V.k * V.fit) / prevFit;
      V.tx = cx - w / 2 / V.k; V.ty = cy - h / 2 / V.k;
    }
    V.w = w; V.h = h;
    clampView();
  }
  window.addEventListener('resize', resize);

  function clampK(k) { return Math.min(V.fit * ZOOM_MAX, Math.max(V.fit * ZOOM_MIN, k)); }
  // 地図が画面の外へ出すぎないようにする(半分までは外に出せる)
  function clampView() {
    V.k = clampK(V.k);
    const vw = V.w / V.k, vh = V.h / V.k;
    V.tx = Math.min(MAP_W - vw / 2, Math.max(-vw / 2, V.tx));
    V.ty = Math.min(MAP_H - vh / 2, Math.max(-vh / 2, V.ty));
  }
  // 画面上の点 (sx, sy) を固定したまま拡大縮小する
  function zoomAt(factor, sx, sy) {
    const before = toWorld(sx, sy);
    V.k = clampK(V.k * factor);
    V.tx = before.x - sx / V.k; V.ty = before.y - sy / V.k;
    clampView();
  }
  function centerOn(p, ratio) {
    if (ratio) V.k = clampK(V.fit * ratio);
    V.tx = p.x - V.w / 2 / V.k; V.ty = p.y - V.h / 2 / V.k;
    clampView();
  }
  function centerOnMine() {
    if (!S.state) return;
    const mine = S.state.nodes.find((n) => n.owner === S.me && n.isPlayerNode) || S.state.nodes.find((n) => n.owner === S.me);
    const p = mine && S.pos[mine.id];
    if (p) centerOn(p, Math.max(2.6, zoomRatio()));
  }
  $('zoomIn').onclick = () => zoomAt(1.4, V.w / 2, V.h / 2);
  $('zoomOut').onclick = () => zoomAt(1 / 1.4, V.w / 2, V.h / 2);
  $('zoomHome').onclick = centerOnMine;

  // ホイールで拡大縮小
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  // ドラッグで移動、2本指でピンチ。動かさずに離したらタップ扱い
  const pointers = new Map();
  let gesture = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    const pts = [...pointers.values()];
    if (pts.length === 1) {
      gesture = { type: 'drag', start: pts[0], tx: V.tx, ty: V.ty, moved: false };
    } else if (pts.length === 2) {
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
      if (gesture.moved) { V.tx = gesture.tx - dx / V.k; V.ty = gesture.ty - dy / V.k; clampView(); canvas.style.cursor = 'grabbing'; }
    } else if (gesture.type === 'pinch' && pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      V.k = clampK((gesture.k * dist) / Math.max(1, gesture.dist));
      V.tx = gesture.world.x - mid.x / V.k; V.ty = gesture.world.y - mid.y / V.k;
      clampView();
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

  function tapAt(pt) {
    const n = nodeAt(pt);
    if (!n || !S.joined) return;
    if (now() < S.cooldownUntil) { toast('不正解のため通信が止まっています'); return; }
    send({ t: 'ask', nodeId: n.id });
  }

  function adjacent(id) {
    return S.state.edges.filter((e) => e.a === id || e.b === id).map((e) => (e.a === id ? e.b : e.a));
  }
  // サーバーの canAttack と同じ条件(表示用。判定はサーバーが行う)
  function canAttack(id) {
    const n = nodeById(id);
    if (!n || !S.me || n.owner === S.me) return false;
    if (n.protectedUntil > now()) return false;
    if (n.owner) { const o = playerById(n.owner); if (o && o.nodes <= 3) return false; }
    return adjacent(id).some((a) => ownerOf(a) === S.me);
  }

  function draw(t) {
    requestAnimationFrame(draw);
    tickUi();
    if (!S.state) return;
    const css = getComputedStyle(document.documentElement);
    const tok = (n) => css.getPropertyValue(n).trim();
    const C = { surface: tok('--surface'), ink: tok('--ink'), muted: tok('--muted'), line: tok('--line'), strong: tok('--line-strong'), accent: tok('--accent') };
    ctx.clearRect(0, 0, V.w, V.h);
    const P = S.pos;
    const ratio = zoomRatio();
    // 拠点の大きさと文字は画面上で一定。位置だけが拡大縮小される
    const grow = V.w < 600 ? 1.15 : 1;

    // 線路(リンク)
    ctx.lineCap = 'round';
    for (const e of S.state.edges) {
      const a = P[e.a] && toScreen(P[e.a]), b = P[e.b] && toScreen(P[e.b]);
      if (!a || !b) continue;
      const oa = ownerOf(e.a), ob = ownerOf(e.b);
      const own = oa && oa === ob ? colorOf(oa) : null;
      const na = nodeById(e.a), nb = nodeById(e.b);
      const thin = (na && na.isPlayerNode) || (nb && nb.isPlayerNode);
      ctx.strokeStyle = own || C.line;
      ctx.lineWidth = own ? (thin ? 5 : 7) : (thin ? 2.5 : 4);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // 拠点(駅)。縮小時は名前を減らして見やすくする
    const pulse = 0.5 + 0.5 * Math.sin(t / 260);
    const sorted = [...S.state.nodes].sort((a, b) => (a.isPlayerNode ? 0 : 1) - (b.isPlayerNode ? 0 : 1));
    for (const n of sorted) {
      const p = P[n.id] && toScreen(P[n.id]); if (!p) continue;
      const r = (R[n.kind] || 12) * grow;
      if (p.x < -40 || p.y < -40 || p.x > V.w + 40 || p.y > V.h + 40) continue;
      const owner = n.owner ? colorOf(n.owner) : null;

      if (canAttack(n.id)) {
        ctx.strokeStyle = C.accent; ctx.globalAlpha = 0.45 + 0.55 * pulse; ctx.lineWidth = 5;
        shape(n, p, r + 7); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (S.question && S.question.nodeId === n.id && !(S.result && S.result.qid === S.question.qid)) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.setLineDash([4, 4]);
        shape(n, p, r + 12); ctx.stroke(); ctx.setLineDash([]);
      }
      if (n.protectedUntil > now()) {
        ctx.strokeStyle = C.muted; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        shape(n, p, r + 5); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.fillStyle = C.surface;
      ctx.strokeStyle = owner || C.strong;
      ctx.lineWidth = owner ? (n.isPlayerNode ? 5 : 7) : (n.isPlayerNode ? 3 : 4);
      shape(n, p, r); ctx.fill(); ctx.stroke();
      if (n.kind === 'IX') { ctx.fillStyle = owner || C.strong; shape(n, p, 6); ctx.fill(); }
      if (owner && n.owner === S.me && n.kind !== 'IX') { ctx.fillStyle = owner; shape(n, p, n.isPlayerNode ? 3 : 4); ctx.fill(); }

      // 防御レベル
      for (let i = 0; i < n.defense; i++) {
        ctx.fillStyle = C.ink;
        ctx.fillRect(p.x - (n.defense * 8 - 3) / 2 + i * 8, p.y - r - 11, 5, 5);
      }
      // 名称。縮小時は重要な拠点と自分の拠点だけ
      const showLabel = n.isPlayerNode
        ? (ratio >= 1.8 || n.owner === S.me)
        : (ratio >= 1.25 || n.level >= 3 || n.kind === 'IX' || n.kind === 'GW' || n.owner === S.me);
      if (showLabel) {
        ctx.textAlign = 'center';
        ctx.fillStyle = n.isPlayerNode ? C.muted : C.ink;
        const fs = n.kind === 'IX' ? 14 : n.isPlayerNode ? 10 : 11.5;
        ctx.font = `${n.isPlayerNode ? 500 : 700} ${fs * grow}px "BIZ UDPGothic", sans-serif`;
        ctx.fillText(n.name, p.x, p.y + r + 13 * grow);
      }
    }
  }
  // 拠点の形は難易度で変える: Lv1 円 / Lv2 角丸四角 / Lv3 六角形 / 5点の拠点は星 / プレイヤーの拠点は小さい円
  function shape(n, p, r) {
    ctx.beginPath();
    if (n.isPlayerNode) { ctx.arc(p.x, p.y, r, 0, Math.PI * 2); return; }
    if (n.value >= 5) { star(p, r * 1.3, r * 0.62); return; }
    if (n.level >= 3) { polygon(p, r * 1.1, 6); return; }
    if (n.level === 2) {
      const s = r * 0.9;
      if (ctx.roundRect) ctx.roundRect(p.x - s, p.y - s, s * 2, s * 2, 5);
      else ctx.rect(p.x - s, p.y - s, s * 2, s * 2);
      return;
    }
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  }
  function polygon(p, r, k) {
    for (let i = 0; i < k; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / k;
      const x = p.x + r * Math.cos(a), y = p.y + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  function star(p, outer, inner) {
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? outer : inner;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = p.x + rr * Math.cos(a), y = p.y + rr * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // 画面上の点に近い拠点
  function nodeAt(pt) {
    if (!S.state) return null;
    let best = null, bd = Infinity;
    for (const n of S.state.nodes) {
      const p = S.pos[n.id] && toScreen(S.pos[n.id]); if (!p) continue;
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < (R[n.kind] || 12) + 10 && d < bd) { best = n; bd = d; }
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
