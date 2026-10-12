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
  function connect() {
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
      if (S.wantJoin) setTimeout(connect, Math.min(8000, 1000 * 2 ** S.retry++));
    };
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
        resize();
        setTimeout(scrollToMine, 80);
        break;
      case 'state':
        S.offset = m.now - Date.now();
        S.state = m;
        layout();
        renderState();
        break;
      case 'question':
        S.question = m; S.result = null; S.chosen = null; renderQuestion();
        break;
      case 'result':
        S.result = m; S.cooldownUntil = m.cooldownUntil; renderQuestion();
        break;
      case 'error':
        if (!S.joined) { $('lobbyError').textContent = m.message; S.wantJoin = false; } else toast(m.message);
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
    if (S.ws && S.ws.readyState === 1) sendJoin(); else connect();
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

  // ---------- 地図 ----------
  const R = { IX: 17, GOV: 13, GW: 13, LM: 12, HUB: 12, DC: 12, HOME: 8 };
  let scale = 1;
  let grow = 1; // 小さい画面では拠点と文字を大きくする

  function resize() {
    const w = Math.max($('mapScroll').clientWidth, 680);
    const h = (w * MAP_H) / MAP_W;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    scale = w / MAP_W;
    grow = Math.min(1.4, Math.max(1, 0.85 / scale));
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  }
  window.addEventListener('resize', resize);
  // 狭い画面では、自分の拠点が見える位置まで地図をスクロールする
  function scrollToMine() {
    const box = $('mapScroll');
    if (!S.state || box.scrollWidth <= box.clientWidth) return;
    const mine = S.state.nodes.find((n) => n.owner === S.me && n.isPlayerNode) || S.state.nodes.find((n) => n.owner === S.me);
    const p = mine && S.pos[mine.id];
    if (p) box.scrollLeft = Math.max(0, p.x * scale - box.clientWidth / 2);
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
    ctx.clearRect(0, 0, MAP_W, MAP_H);
    const P = S.pos;

    // 線路(リンク)
    ctx.lineCap = 'round';
    for (const e of S.state.edges) {
      const a = P[e.a], b = P[e.b];
      if (!a || !b) continue;
      const oa = ownerOf(e.a), ob = ownerOf(e.b);
      const own = oa && oa === ob ? colorOf(oa) : null;
      const na = nodeById(e.a), nb = nodeById(e.b);
      const thin = (na && na.isPlayerNode) || (nb && nb.isPlayerNode);
      ctx.strokeStyle = own || C.line;
      ctx.lineWidth = own ? (thin ? 5 : 7) : (thin ? 2.5 : 4);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // 拠点(駅)
    const pulse = 0.5 + 0.5 * Math.sin(t / 260);
    const sorted = [...S.state.nodes].sort((a, b) => (a.isPlayerNode ? 0 : 1) - (b.isPlayerNode ? 0 : 1));
    for (const n of sorted) {
      const p = P[n.id]; if (!p) continue;
      const r = (R[n.kind] || 12) * grow;
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
      // 名称
      ctx.textAlign = 'center';
      ctx.fillStyle = n.isPlayerNode ? C.muted : C.ink;
      const fs = n.kind === 'IX' ? 14 : n.isPlayerNode ? 9.5 : 11.5;
      ctx.font = `${n.isPlayerNode ? 500 : 700} ${fs * grow}px "BIZ UDPGothic", sans-serif`;
      ctx.fillText(n.name, p.x, p.y + r + 13 * grow);
    }
  }
  function shape(n, p, r) {
    ctx.beginPath();
    if (n.kind === 'GW') {
      const s = r * 0.92;
      if (ctx.roundRect) ctx.roundRect(p.x - s, p.y - s, s * 2, s * 2, 4);
      else ctx.rect(p.x - s, p.y - s, s * 2, s * 2);
    } else if (n.kind === 'GOV') {
      ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x + r, p.y); ctx.lineTo(p.x, p.y + r); ctx.lineTo(p.x - r, p.y); ctx.closePath();
    } else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  }

  function nodeAt(ev) {
    if (!S.state) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / scale, y = (ev.clientY - rect.top) / scale;
    let best = null, bd = Infinity;
    for (const n of S.state.nodes) {
      const p = S.pos[n.id]; if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < (R[n.kind] || 12) * grow + 10 && d < bd) { best = n; bd = d; }
    }
    return best;
  }
  canvas.addEventListener('click', (ev) => {
    const n = nodeAt(ev);
    if (!n || !S.joined) return;
    if (now() < S.cooldownUntil) { toast('不正解のため通信が止まっています'); return; }
    send({ t: 'ask', nodeId: n.id });
  });
  canvas.addEventListener('mousemove', (ev) => {
    const n = nodeAt(ev);
    canvas.style.cursor = n && (canAttack(n.id) || ownerOf(n.id) === S.me) ? 'pointer' : 'default';
  });

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
