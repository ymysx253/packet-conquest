'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const ctx = canvas.getContext('2d');

  const S = {
    ws: null, me: null, room: null, map: null, state: null,
    question: null, result: null, chosen: null, cooldownUntil: 0,
    offset: 0, joined: false, retry: 0, hover: null,
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても遊べる */ } },
  };
  // 再接続用の合言葉はタブごとに持つ(同じブラウザの別タブは別プレイヤーになる)
  const tabStore = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 保存できなくても遊べる */ } },
  };
  const now = () => Date.now() + S.offset;

  // ---------- 初期表示 ----------
  const params = new URLSearchParams(location.search);
  $('roomInput').value = (params.get('room') || randomCode()).toUpperCase().slice(0, 6);
  $('nameInput').value = store.get('pj-name') || '';
  function randomCode() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join('');
  }

  // ---------- 通信 ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      setConn(true);
      S.retry = 0;
      if (S.room) sendJoin();
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      setConn(false);
      if (S.room) setTimeout(connect, Math.min(8000, 1000 * 2 ** S.retry++));
    };
  }
  function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); }
  function sendJoin() {
    send({ t: 'join', room: S.room, name: $('nameInput').value, token: tabStore.get(`pj-token-${S.room}`) });
  }
  function setConn(on) {
    $('conn').dataset.state = on ? 'on' : 'off';
    $('conn').textContent = on ? '接続中' : '再接続中…';
  }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        S.me = m.id; S.map = m.map; S.joined = true;
        tabStore.set(`pj-token-${m.room}`, m.token);
        history.replaceState(null, '', `?room=${m.room}`);
        $('roomChip').hidden = false; $('roomCode').textContent = m.room;
        $('lobbyError').textContent = '';
        resize();
        break;
      case 'state': {
        const prevPhase = S.state && S.state.phase;
        S.offset = m.now - Date.now();
        S.state = m;
        if (m.phase === 'playing' && prevPhase !== 'playing') {
          S.question = null; S.result = null; S.cooldownUntil = 0; renderQuestion();
          setTimeout(scrollToMine, 50);
        }
        renderState();
        break;
      }
      case 'question':
        S.question = m; S.result = null; S.chosen = null; renderQuestion();
        break;
      case 'result':
        S.result = m; S.cooldownUntil = m.cooldownUntil; renderQuestion();
        break;
      case 'error':
        if (!S.joined) $('lobbyError').textContent = m.message; else toast(m.message);
        break;
    }
  }

  // ---------- ロビー ----------
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('roomInput').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(code)) { $('lobbyError').textContent = '部屋コードは英数字4〜6文字です'; return; }
    store.set('pj-name', $('nameInput').value.trim());
    S.room = code;
    if (S.ws && S.ws.readyState === 1) sendJoin(); else connect();
  });
  $('startBtn').onclick = () => send({ t: 'start' });
  $('againBtn').onclick = () => send({ t: 'start' });
  $('botBtn').onclick = () => send({ t: 'addBot' });
  $('copyBtn').onclick = () => {
    const url = inviteUrl();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => toast('招待リンクをコピーしました'), () => toast('下のリンクを選択してコピーしてください'));
    } else toast('下のリンクを選択してコピーしてください');
  };
  const inviteUrl = () => `${location.origin}${location.pathname}?room=${S.room}`;

  // ---------- 描画: パネル ----------
  function renderState() {
    const st = S.state; if (!st) return;
    const isHost = st.hostId === S.me;
    const players = [...st.players].sort((a, b) => b.score - a.score);

    $('lobby').hidden = st.phase === 'playing';
    $('joinForm').hidden = true;
    $('waiting').hidden = st.phase !== 'lobby';
    $('results').hidden = st.phase !== 'ended';
    $('timer').hidden = st.phase !== 'playing';

    $('roster').replaceChildren(...st.players.map((p) => playerRow(p)));
    $('startBtn').hidden = !isHost; $('botBtn').hidden = !isHost;
    $('botBtn').disabled = st.players.length >= 6;
    $('waitHint').textContent = isHost
      ? '1人でもボットを追加すれば遊べます。友達には招待リンクを送ってください。'
      : 'ホストがゲームを開始するのを待っています。';
    $('inviteUrl').textContent = inviteUrl();

    $('final').replaceChildren(...players.map((p, i) => {
      const li = document.createElement('li');
      const r = document.createElement('span'); r.className = 'rank'; r.textContent = `${i + 1}`;
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = p.color;
      const n = document.createElement('span'); n.textContent = p.name + (p.id === S.me ? '(あなた)' : '');
      const pts = document.createElement('span'); pts.className = 'pts'; pts.textContent = `${p.score}点`;
      li.append(r, sw, n, pts); return li;
    }));
    $('againBtn').hidden = !isHost;
    $('againHint').textContent = isHost ? '' : 'ホストが次のゲームを始めるのを待っています。';

    $('scores').replaceChildren(...players.map((p) => {
      const li = document.createElement('li');
      if (!p.online) li.className = 'offline';
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = p.color;
      const n = document.createElement('span'); n.className = 'pname'; n.textContent = p.name;
      const sm = document.createElement('small'); sm.textContent = p.id === S.me ? 'あなた' : `${p.nodes}拠点`;
      n.append(sm);
      const sc = document.createElement('span'); sc.className = 'pscore'; sc.textContent = `${p.score}点`;
      li.append(sw, n, sc); return li;
    }));

    $('log').replaceChildren(...st.log.map((l) => {
      const li = document.createElement('li'); li.textContent = l.text; return li;
    }));
    $('log').scrollTop = $('log').scrollHeight;
  }

  function playerRow(p) {
    const li = document.createElement('li');
    const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = p.color;
    const n = document.createElement('span');
    n.textContent = p.name + (p.id === S.me ? '(あなた)' : '') + (p.id === S.state.hostId ? ' ・ホスト' : '');
    li.append(sw, n); return li;
  }

  // ---------- 描画: 問題 ----------
  function renderQuestion() {
    const q = S.question;
    $('qIdle').hidden = !!q; $('qBox').hidden = !q;
    if (!q) return;
    const node = S.map.nodes.find((n) => n.id === q.nodeId);
    const tag = document.createElement('span');
    tag.className = q.mode === 'attack' ? 'tag' : 'tag def';
    tag.textContent = q.mode === 'attack' ? '攻撃' : '防御強化';
    $('qMode').replaceChildren(tag, document.createTextNode(node ? node.name : ''));
    $('qDiff').textContent = `難易度 ${'●'.repeat(q.difficulty)}${'○'.repeat(3 - q.difficulty)}`;
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
  const R = { DC: 13, GW: 14, IX: 19 };
  let scale = 1;
  let grow = 1; // 小さい画面では拠点と文字を大きくする

  function resize() {
    if (!S.map) return;
    const w = Math.max($('mapScroll').clientWidth, 680);
    const h = (w * S.map.height) / S.map.width;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    scale = w / S.map.width;
    grow = Math.min(1.4, Math.max(1, 0.85 / scale));
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  }
  window.addEventListener('resize', resize);
  // 狭い画面では、自分の開始拠点が見える位置まで地図をスクロールする
  function scrollToMine() {
    const box = $('mapScroll');
    if (!S.map || !S.state || box.scrollWidth <= box.clientWidth) return;
    const mine = S.state.nodes.find((n) => n.owner === S.me);
    const node = mine && S.map.nodes.find((n) => n.id === mine.id);
    if (node) box.scrollLeft = Math.max(0, node.x * scale - box.clientWidth / 2);
  }

  const nodeState = (id) => S.state && S.state.nodes.find((n) => n.id === id);
  const ownerOf = (id) => { const n = nodeState(id); return n && n.owner; };
  const colorOf = (pid) => { const p = S.state && S.state.players.find((x) => x.id === pid); return p ? p.color : null; };
  function adjacent(id) {
    return S.map.edges.filter((e) => e.a === id || e.b === id).map((e) => (e.a === id ? e.b : e.a));
  }
  function canAttack(id) {
    if (!S.state || S.state.phase !== 'playing') return false;
    if (ownerOf(id) === S.me) return false;
    const mine = S.state.nodes.filter((n) => n.owner === S.me).length;
    if (mine === 0) return true;
    return adjacent(id).some((a) => ownerOf(a) === S.me);
  }

  function draw(t) {
    requestAnimationFrame(draw);
    tickUi();
    if (!S.map) return;
    const css = getComputedStyle(document.documentElement);
    const tok = (n) => css.getPropertyValue(n).trim();
    const C = { surface: tok('--surface'), ink: tok('--ink'), muted: tok('--muted'), line: tok('--line'), strong: tok('--line-strong'), accent: tok('--accent') };
    ctx.clearRect(0, 0, S.map.width, S.map.height);
    const byId = Object.fromEntries(S.map.nodes.map((n) => [n.id, n]));

    // 線路(リンク)
    ctx.lineCap = 'round';
    for (const e of S.map.edges) {
      const a = byId[e.a], b = byId[e.b];
      const oa = ownerOf(e.a), ob = ownerOf(e.b);
      const own = oa && oa === ob ? colorOf(oa) : null;
      ctx.setLineDash(e.cable ? [10, 9] : []);
      ctx.strokeStyle = own || C.line;
      ctx.lineWidth = own ? 8 : 5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // 拠点(駅)
    const pulse = 0.5 + 0.5 * Math.sin(t / 260);
    for (const n of S.map.nodes) {
      const st = nodeState(n.id) || { owner: null, level: 0 };
      const r = R[n.kind] * grow;
      const owner = st.owner ? colorOf(st.owner) : null;

      if (canAttack(n.id)) {
        ctx.strokeStyle = C.accent; ctx.globalAlpha = 0.45 + 0.55 * pulse; ctx.lineWidth = 5;
        shape(n, r + 8); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (S.question && S.question.nodeId === n.id && !(S.result && S.result.qid === S.question.qid)) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.setLineDash([4, 4]);
        shape(n, r + 13); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.fillStyle = C.surface;
      ctx.strokeStyle = owner || C.strong;
      ctx.lineWidth = owner ? 7 : 4;
      shape(n, r); ctx.fill(); ctx.stroke();
      if (n.kind === 'IX') { ctx.fillStyle = owner || C.strong; shape(n, 6); ctx.fill(); }
      if (owner && st.owner === S.me && n.kind !== 'IX') { ctx.fillStyle = owner; shape(n, 4); ctx.fill(); }

      // 防御レベル
      for (let i = 0; i < st.level; i++) {
        ctx.fillStyle = C.ink;
        ctx.fillRect(n.x - (st.level * 9 - 3) / 2 + i * 9, n.y - r - 12, 6, 6);
      }
      // 駅名
      ctx.textAlign = 'center';
      ctx.fillStyle = C.ink;
      ctx.font = `700 ${(n.kind === 'IX' ? 15 : 13) * grow}px "BIZ UDPGothic", sans-serif`;
      ctx.fillText(n.name, n.x, n.y + r + 18 * grow);
      ctx.fillStyle = C.muted;
      ctx.font = `500 ${10.5 * grow}px "IBM Plex Mono", monospace`;
      ctx.fillText(n.subnet, n.x, n.y + r + 31 * grow);
    }
  }
  function shape(n, r) {
    ctx.beginPath();
    if (n.kind === 'GW') {
      const s = r * 0.92;
      if (ctx.roundRect) ctx.roundRect(n.x - s, n.y - s, s * 2, s * 2, 4);
      else ctx.rect(n.x - s, n.y - s, s * 2, s * 2);
    } else ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  }

  function nodeAt(ev) {
    if (!S.map) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / scale, y = (ev.clientY - rect.top) / scale;
    let best = null, bd = Infinity;
    for (const n of S.map.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < R[n.kind] * grow + 16 && d < bd) { best = n; bd = d; }
    }
    return best;
  }
  canvas.addEventListener('click', (ev) => {
    const n = nodeAt(ev);
    if (!n || !S.state || S.state.phase !== 'playing') return;
    if (now() < S.cooldownUntil) { toast('不正解のため通信が止まっています'); return; }
    send({ t: 'ask', nodeId: n.id });
  });
  canvas.addEventListener('mousemove', (ev) => {
    const n = nodeAt(ev);
    canvas.style.cursor = n && (canAttack(n.id) || ownerOf(n.id) === S.me) ? 'pointer' : 'default';
  });

  // ---------- タイマー・待ち時間 ----------
  function tickUi() {
    const st = S.state;
    if (st && st.phase === 'playing') {
      const left = Math.max(0, st.endsAt - now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      $('timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
      $('timer').classList.toggle('low', left < 30000);
    }
    const cd = S.cooldownUntil - now();
    $('cool').hidden = cd <= 0;
    if (cd > 0) $('coolBar').style.transform = `scaleX(${cd / 4000})`;
  }

  let toastTimer;
  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
  }

  requestAnimationFrame(draw);
})();
