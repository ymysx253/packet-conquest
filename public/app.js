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
    regions: [],        // 縮小時の地域の支配(区・市 / 都道府県 / 国)
    viewZ: 0, overview: false,
    players: [], log: [], offset: 0,
    question: null, result: null, chosen: null, cooldownUntil: 0,
    selected: null, centerPending: false,
    start: null, picking: false, searchTimer: null, // 開始地点(選んだ駅・名所)と、地図から選ぶモード
    moving: false, movedAt: null, reach: new Set(), // 引っ越しの選択中 / 最後の引っ越し / 自分の拠点から線でつながっている所有拠点
    rankings: null, me2: null, team: null, cooldownMs: 4000, // ランキング / 自分の集計 / 所属チーム / いまの待ち時間の長さ
    mine: new Map(), // 自分が占領している空港・港(航路を持つもの)。画面の外に出ても覚えておき、航路の線を引く
    bounds: new Map(), // 区・市の境界(地域 id → { polys })。public/data/bounds/<都道府県>.json を見えている分だけ読む
    boundsLoaded: new Set(), coarse: null, // 読み込み済みの都道府県 / 縮小時の粗い全国版(japan.json)
  };
  const TOKYO = { lat: 35.68124, lon: 139.76712 }; // 参加前に地図から選ぶときの初期位置(東京駅のあたり。既定の開始地点「丸の内」の隣)
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても遊べる */ } },
  };
  const now = () => Date.now() + S.offset;
  const nodeById = (id) => S.nodes.get(id);
  // 選んでいる拠点(2026-10-19): 地図を動かして読み込みから外れても、選んでいる間は覚えておいた拠点を使う(情報パネルも航路の線も出したまま)
  const selectedNode = () => {
    const n = S.selected && S.nodes.get(S.selected);
    if (n) S.selNode = n;
    return n || (S.selected && S.selNode && S.selNode.id === S.selected ? S.selNode : null);
  };
  const playerById = (id) => S.players.find((p) => p.id === id);
  const ownerOf = (id) => { const n = nodeById(id); return n ? n.owner : null; };
  // 拠点の色: チームに所属していればチームの背景色、いなければプレイヤーの色(2026-10-18 決定)
  const colorOf = (pid) => { const p = playerById(pid); return p ? (p.teamStyle && p.teamStyle.fill ? p.teamStyle.fill : p.color) : null; };
  const teamFrameOf = (n) => { const o = playerById(n.owner); return (S.team && S.team.style && S.team.style.frame) || (o && o.teamStyle && o.teamStyle.frame) || null; };
  // 拠点の持ち主の色(一覧にいない持ち主は、サーバーが拠点に添えた色)
  const ownerColorOf = (n) => (n.owner ? colorOf(n.owner) || n.ownerColor || null : null);
  // 持ち主との関係(2026-10-19): 'me' 自分 / 'team' チームの仲間 / 'other' ほかの人 / null 持ち主なし
  const relOf = (n) => {
    if (!n.owner) return null;
    if (n.owner === S.me) return 'me';
    const t = S.team && S.team.id;
    if (t) { const o = playerById(n.owner); if (n.ownerTeam === t || (o && o.team === t)) return 'team'; }
    return 'other';
  };
  // 地図の上の切り替え「自分だけ / チームまで / 全員」: 持ち主の色と陣地のにじみを、どこまで出すか
  const OWN_VIEWS = ['me', 'team', 'all'];
  const ownShown = (rel) => !!rel && (S.ownView === 'all' || rel === 'me' || (rel === 'team' && S.ownView === 'team'));

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
    ws.onopen = () => { setConn(true); S.retry = 0; if (S.wantJoin) sendJoin(); if (S.pendingSearch) { send({ t: 'search', q: S.pendingSearch }); S.pendingSearch = null; } if (S.picking) requestView(true); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      setConn(false);
      if (!S.joined && S.wantJoin) { $('lobbyError').textContent = SERVER_HINT; setJoining(false); }
      S.tiles.clear(); lastViewKey = ''; // 再接続後にタイルを取り直す
      if (S.wantJoin) setTimeout(connect, Math.min(8000, 1000 * 2 ** S.retry++));
    };
  }
  function setJoining(on) {
    const btn = $('joinForm').querySelector('button[type="submit"]');
    btn.disabled = on; btn.textContent = on ? '接続中…' : '参加する';
  }
  function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); }
  function sendJoin() { send({ t: 'join', name: $('nameInput').value.trim(), token: S.token || undefined, startNodeId: S.start ? S.start.id : undefined, country: $('countrySelect').value }); }
  function setConn(on) { $('conn').dataset.state = on ? 'on' : 'off'; $('conn').textContent = on ? '接続中' : '再接続中…'; }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        S.me = m.id; S.token = m.token; S.joined = true; S.home = m.home; S.spawn = m.spawn; S.questionRanges = m.questionRanges || null; S.movedAt = m.movedAt || null; S.mine.clear();
        $('areaChip').textContent = m.area || '日本';
        S.team = m.team ? { id: m.team, name: m.teamName } : null; S.cooldownUntil = m.cooldownUntil || 0; S.cooldownMs = Math.max(4000, S.cooldownUntil - Date.now());
        $('teamPanel').hidden = false; renderTeam();
        if (S.team) { S.infoOnly = true; send({ t: 'team', action: 'info' }); }
        store.set('pc-token', m.token); store.set('pc-name', m.name);
        $('codeInput').value = m.token;
        $('lobby').hidden = true; $('mePanel').hidden = false; $('onlineChip').hidden = false; $('ownView').hidden = false;
        $('lobbyError').textContent = ''; $('meCode').textContent = m.token;
        resize();
        if (S.home) centerOn(worldOf(S.home.lat, S.home.lon), 9); else if (S.spawn) centerOn(worldOf(S.spawn.lat, S.spawn.lon), 9);
        requestView(true);
        break;
      case 'tiles': onTiles(m); break;
      case 'neighbors': if (m.nodeId === S.selected) S.selNb = { id: m.nodeId, list: (m.list || []).map((x) => ({ ...x, w: worldOf(x.lat, x.lon) })) }; break;
      case 'search': renderSearch(m); break;
      case 'moved':
        S.home = m.home; S.movedAt = m.movedAt; S.moving = false; $('pickBar').hidden = true; S.selected = null; S.question = null; S.result = null;
        if (m.area) $('areaChip').textContent = m.area;
        S.nodes.clear(); S.edges.clear(); S.tiles.clear(); lastViewKey = '';
        centerOn(worldOf(m.home.lat, m.home.lon), 9); requestView(true); renderQuestion();
        toast('引っ越しました。新しい拠点から広げ直してください');
        break;
      case 'rekey':
        S.token = m.token; store.set('pc-token', m.token); $('codeInput').value = m.token; $('meCode').textContent = m.token;
        toast('復帰コードを新しくしました。控え直してください');
        break;
      case 'nodes':
        for (const n of m.nodes) {
          if (n.status === 'gone') { S.nodes.delete(n.id); if (S.selected === n.id) S.selected = null; continue; }
          if (S.nodes.has(n.id) || S.tiles.has(n.t0)) S.nodes.set(n.id, n);
          rememberRoutes(n);
        }
        computeReach();
        renderSelected();
        break;
      case 'players':
        S.offset = m.now - Date.now(); S.players = m.players; S.log = m.log || S.log; S.rankings = m.rankings || S.rankings; S.me2 = m.me || S.me2;
        if (S.me2 && S.me2.team !== (S.team && S.team.id)) { S.team = S.me2.team ? { id: S.me2.team, name: S.me2.teamName } : null; renderTeam(); if (S.team) { S.infoOnly = true; send({ t: 'team', action: 'info' }); } }
        renderPlayers(); renderSelected();
        break;
      case 'team': {
        const had = S.team && S.team.id;
        S.team = m.team ? { id: m.team.id, name: m.team.name, max: m.team.maxMembers, count: m.team.memberCount, ownerId: m.team.ownerId, style: m.team.style, icon: m.team.icon } : null;
        renderTeam();
        if (S.styleSaving) { S.styleSaving = false; toast('チームの見た目を保存しました'); }
        else if (S.infoOnly) { S.infoOnly = false; }
        else toast(S.team ? `チーム「${S.team.name}」に所属しました` : 'チームを脱退しました');
        break;
      }
      case 'question': S.question = m; S.result = null; S.chosen = null; renderQuestion(); break;
      case 'result': S.result = m; S.cooldownUntil = m.cooldownUntil; if (m.cooldownMs) S.cooldownMs = m.cooldownMs; renderQuestion(); renderSelected(); break;
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
      for (const n of m.nodes) { S.nodes.set(n.id, n); rememberRoutes(n); } // 縮小表示にも自分の空港・港が届くので、航路の線を出せる
      S.regions = Array.isArray(m.regions) ? m.regions : [];
      if (m.z >= 3) loadCoarse(); else for (const g of S.regions) loadBounds(g.pref);
      return;
    }
    if (S.overview) { S.nodes.clear(); S.edges.clear(); S.tiles.clear(); S.overview = false; S.regions = []; }
    S.viewZ = 0;
    for (const t of m.dropped) {
      S.tiles.delete(t);
      for (const [id, n] of S.nodes) if (n.t0 === t && !(S.home && id === S.home.id)) S.nodes.delete(id);
    }
    for (const t of m.added) S.tiles.add(t);
    for (const n of m.nodes) { S.nodes.set(n.id, n); rememberRoutes(n); }
    // 拡大したままでも、見えている拠点の都道府県の境界を読む(縮小表示を経ないと読まれなかった。2026-10-19)
    for (const pref of new Set(m.nodes.map((n) => (n.region || '').split('-')[0]).filter(Boolean))) loadBounds(pref);
    for (const e of m.edges) S.edges.set(e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`, e);
    for (const [k, e] of S.edges) if (!S.nodes.has(e.a) && !S.nodes.has(e.b)) S.edges.delete(k);
    computeReach();
    renderSelected();
  }

  // ---------- 開始地点: 名前で検索、または地図から選ぶ ----------
  function ensureConnected() { if (!S.ws || S.ws.readyState > 1) connect(); }
  $('startInput').addEventListener('input', () => {
    const q = $('startInput').value.trim();
    S.start = null; $('startPicked').textContent = '開始地点: 丸の内(未選択)';
    clearTimeout(S.searchTimer);
    if (!q) { $('startResults').hidden = true; $('startPicked').textContent = '開始地点: 丸の内'; return; }
    ensureConnected();
    S.searchTimer = setTimeout(() => { if (S.ws && S.ws.readyState === 1) send({ t: 'search', q }); else S.pendingSearch = q; }, 250);
  });
  function renderSearch(m) {
    if (m.q !== $('startInput').value.trim()) return;
    const ul = $('startResults');
    ul.replaceChildren(...m.results.map((r) => {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.textContent = `${r.name}(${r.area || ''} Lv${r.level})`;
      if (r.startable === false) {
        // 開始地点にできない(Lv1 でない駅・名所)。理由と、近くの開始地点にできるものを出す(2026-10-19)
        li.className = 'disabled';
        const sm = document.createElement('small');
        sm.textContent = `Lv${r.level} の${r.genre === 'station' ? '駅' : '場所'}からは始められません。` + (r.near && r.near.length ? '近くなら:' : '町・字か、ふつうの駅(Lv10)を選んでください');
        li.append(name, sm);
        for (const x of r.near || []) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'near';
          b.textContent = `${x.name}(${x.genre === 'town' ? '町・字' : '駅'})`;
          b.onclick = (e) => { e.stopPropagation(); setStart(x); ul.hidden = true; };
          li.append(b);
        }
        return li;
      }
      li.tabIndex = 0;
      const sm = document.createElement('small'); sm.textContent = r.starters ? `ここから ${r.starters} 人` : 'まだ誰もいません';
      li.append(name, sm);
      const choose = () => { setStart(r); ul.hidden = true; };
      li.onclick = choose; li.onkeydown = (e) => { if (e.key === 'Enter') choose(); };
      return li;
    }));
    if (!m.results.length) { const li = document.createElement('li'); li.textContent = '見つかりません(駅名は「駅」なしでも探せます)'; ul.replaceChildren(li); }
    ul.hidden = false;
  }
  // 開始地点にできるもの(2026-10-19 決定): 町・字(Lv1〜9)と、ふつうの駅(Lv10)だけ。サーバーの startable と同じ
  const startableNode = (n) => !!n && !n.isPlayerNode && n.hackable !== false && (n.genre === 'town' || (n.genre === 'station' && n.level <= 10));
  // 問題のあるレベル(サーバーが welcome で送る範囲)。問題の無いレベルの拠点は、線がつながっていても占領・強化できない(2026-10-19)
  const hasQuestion = (lv) => (S.questionRanges || [[1, 999]]).some(([a, b]) => lv >= a && lv <= b);
  const attackLevelOf = (n) => { const base = Math.max(1, n.level) + (n.defense || 0); return n.owner ? Math.max(4, base) : base; };
  // 濃さ(2026-10-19 ユーザー案): 縮小して重なっているときは低いレベルほど薄く、拡大して重なりが無くなると元の濃さ。
  // レベルの帯ごとに「この拡大率で元の濃さ」を決める(町・字 30、駅・名所 24、乗り換え駅など 14、空港など 6、Lv200 以上はいつも濃い)。いちばん薄くて 12%。
  // 選択中・自分とチームの拠点・攻撃できる拠点は薄くしない
  const fadeOf = (n) => {
    if (n.id === S.selected || n.isPlayerNode || (n.owner && n.owner === S.me) || (relOf(n) === 'team' && ownShown('team')) || (!S.overview && canAttack(n.id) && hasQuestion(attackLevelOf(n)))) return 1;
    const full = n.level >= 200 ? 0 : n.level >= 100 ? 6 : n.level >= 30 ? 14 : n.level >= 10 ? 24 : 30;
    return full ? Math.max(0.12, Math.min(1, (zoomRatio() / full) ** 2)) : 1;
  };
  const startRefusal = (n) => (n.isPlayerNode || n.hackable === false)
    ? 'そこは開始地点にできません。町・字か、ふつうの駅(Lv10)を選んでください'
    : `${n.name}(Lv${n.level})からは始められません。町・字か、ふつうの駅(Lv10)を選んでください(町・字は地図を拡大すると出ます)`;
  function setStart(r) {
    S.start = { id: r.id, name: r.name };
    $('startInput').value = r.name;
    $('startPicked').textContent = `開始地点: ${r.name}${r.area ? '(' + r.area + ')' : ''}`;
  }
  $('pickMapBtn').onclick = () => {
    S.picking = true; $('lobby').hidden = true; $('pickBar').hidden = false; $('startResults').hidden = true;
    ensureConnected(); resize();
    centerOn(worldOf(TOKYO.lat, TOKYO.lon), 9);
    requestView(true);
  };
  function endPick() { S.picking = false; $('pickBar').hidden = true; $('lobby').hidden = false; }
  $('pickCancelBtn').onclick = () => { if (S.moving) { S.moving = false; $('pickBar').hidden = true; } else endPick(); };
  // 引っ越し: 地図で新しい開始地点を選ぶ(1 日 1 回)
  $('moveBtn').onclick = () => {
    if (!S.joined) return;
    if (S.movedAt && now() - S.movedAt < 24 * 3600 * 1000) { toast(`引っ越しは 1 日に 1 回までです(あと ${Math.ceil((24 * 3600 * 1000 - (now() - S.movedAt)) / 3600000)} 時間)`); return; }
    S.moving = true; $('pickBarText').textContent = '引っ越し先の町・字か、ふつうの駅をタップしてください(町・字は拡大すると出ます。所有拠点は残りますが、線がつながるまで広げられません)'; $('pickBar').hidden = false;
  };

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
  const TEAM_ICONS = ['★', '●', '■', '▲', '◆', '♠', '♣', '♥', '♦', '☀', '☾', '☁', '⚡', '❄', '✿', '⚑', '⚙', '☕', '♪', '✈', '⚓', '☯', '✦', '✪'];
  $('teamIcon').replaceChildren(...TEAM_ICONS.map((ic) => { const o = document.createElement('option'); o.value = ic; o.textContent = ic; return o; }));
  function renderTeam() {
    $('teamNone').hidden = !!S.team; $('teamMine').hidden = !S.team;
    if (S.team) {
      $('teamName').textContent = `${S.team.icon || ''} ${S.team.name || '(名前なし)'}`.trim(); $('teamCode').textContent = S.team.id;
      const isLeader = S.team.ownerId === S.me;
      $('teamStyle').hidden = !isLeader;
      if (isLeader && S.team.style) { $('teamFrame').value = S.team.style.frame; $('teamFill').value = S.team.style.fill; $('teamText').value = S.team.style.text; $('teamIcon').value = S.team.icon || TEAM_ICONS[0]; }
      if (S.team.style) { $('teamName').style.color = S.team.style.text; $('teamName').style.background = S.team.style.fill; $('teamName').style.border = `2px solid ${S.team.style.frame}`; $('teamName').style.borderRadius = '6px'; $('teamName').style.padding = '2px 8px'; $('teamName').style.display = 'inline-block'; }
      const t = (S.rankings && (S.rankings.teams || []).find((x) => x.id === S.team.id)) || null;
      $('teamMeta').textContent = t ? `${t.members}人 ・ 合計 ${t.score}点 ・ ${t.nodes}拠点。同じ拠点への正解回数はチームで合算されます` : 'コードを仲間に伝えると参加できます';
    }
  }
  $('teamStyleBtn').onclick = () => { S.styleSaving = true; send({ t: 'team', action: 'style', frame: $('teamFrame').value, fill: $('teamFill').value, text: $('teamText').value, icon: $('teamIcon').value }); };
  $('teamCreateBtn').onclick = () => { const name = $('teamNameInput').value.trim(); if (!name) { toast('チーム名を入れてください'); return; } send({ t: 'team', action: 'create', name, max: Number($('teamMaxInput').value) || 10 }); };
  $('teamJoinBtn').onclick = () => { const id = $('teamJoinInput').value.trim(); if (!id) { toast('チーム コードを入れてください'); return; } send({ t: 'team', action: 'join', teamId: id }); };
  $('teamLeaveBtn').onclick = () => { if (window.confirm('チームを脱退しますか?')) send({ t: 'team', action: 'leave' }); };
  $('teamCopyBtn').onclick = () => { const c = S.team ? S.team.id : ''; if (navigator.clipboard && c) navigator.clipboard.writeText(c).then(() => toast('チーム コードをコピーしました'), () => toast('コードを選択してコピーしてください')); };
  $('rekeyBtn').onclick = () => {
    if (!S.joined) return;
    if (window.confirm('復帰コードを新しくします。いまのコードは使えなくなります。よろしいですか?')) send({ t: 'rekey' });
  };
  $('copyCodeBtn').onclick = () => {
    const code = S.token || '';
    if (navigator.clipboard && code) navigator.clipboard.writeText(code).then(() => toast('復帰コードをコピーしました'), () => toast('コードを選択してコピーしてください'));
    else toast('コードを選択してコピーしてください');
  };

  // ---------- 区・市の境界(地域の支配の色分け。第 13 章・第 14.2 節) ----------
  // 都道府県ごとの詳細ファイルは、サーバーから届いた地域の pref を見て必要なぶんだけ取る。縮小時(z3〜4)は粗い全国版を 1 回だけ取る
  const projectPolys = (polys) => polys.map((ring) => ring.map(([lon, lat]) => worldOf(lat, lon)));
  function loadBounds(pref) {
    if (!pref || S.boundsLoaded.has(pref)) return;
    S.boundsLoaded.add(pref);
    fetch(`data/bounds/${pref}.json`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d || !d.regions) return;
      for (const [id, g] of Object.entries(d.regions)) S.bounds.set(id, { id, name: g.name, pref, polys: projectPolys(g.polys) });
      S.boundsReady.add(pref); // 海の塗り分けで、この県は細かい版を使う
    }).catch(() => { /* 境界が無くても遊べる */ });
  }
  S.boundsReady = new Set(); // 細かい境界を読み終えた都道府県
  function loadCoarse() {
    if (S.coarse) return;
    S.coarse = new Map();
    fetch('data/bounds/japan.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d || !d.regions) return;
      for (const [id, g] of Object.entries(d.regions)) S.coarse.set(id, { id, name: g.name, pref: g.pref, polys: projectPolys(g.polys) });
    }).catch(() => { /* 無くても遊べる */ });
  }
  loadBounds('tokyo'); // 開始地点の既定は東京
  loadCoarse(); // 粗い全国版はいつも読む(海を水色にするとき、陸地の下地に使う。2026-10-19)
  // 湖・湾の形(2026-10-19): 薄い水色で塗る。全国で 1 ファイル(tools/import-towns.js が書く)
  S.water = [];
  fetch('data/water.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d || !Array.isArray(d.water)) return;
    S.water = d.water.map((w) => ({ id: w.id, name: w.name, polys: projectPolys(w.polys) }));
  }).catch(() => { /* 無くても遊べる */ });

  // 海路の道すじ(2026-10-19): 海路は陸をまたがず海の上を通る曲線で描く(tools/build-sea-paths.js が書く)。キーは港の id(小さい順)
  S.seaPaths = new Map();
  fetch('data/sea-paths.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d || !d.paths) return;
    for (const [k, pts] of Object.entries(d.paths)) S.seaPaths.set(k, pts.map(([lat, lon]) => worldOf(lat, lon)));
  }).catch(() => { /* 無ければゆるい弧で描く */ });

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
  const ZOOM_MIN = 0.02, ZOOM_MAX = 150; // 1 倍に対する比。0.02 倍で日本全体が入る。拡大は 150 倍まで(2026-10-19 に 50 から上げた。ユーザー指摘)
  const toScreen = (p) => ({ x: (p.x - V.tx) * V.k, y: (p.y - V.ty) * V.k });
  const toWorld = (sx, sy) => ({ x: sx / V.k + V.tx, y: sy / V.k + V.ty });
  const zoomRatio = () => V.k / BASE_K;
  const shrink = () => Math.min(1, Math.max(0.35, zoomRatio() / 6));
  const radiusOf = (n) => shrink() * (n.isPlayerNode ? 8
    : (11 + Math.min(10, n.level) * 0.6 + Math.min(9, Math.floor((n.level - 1) / 10)) * 0.4 + Math.min(9, Math.floor((n.level - 1) / 100)) * 0.8) * (n.genre === 'town' ? 0.7 : 1)); // 町・字は小さめ
  // 町・字(2026-10-18)は数が多いので、ある程度拡大したときだけ描く。自分の拠点・選択中・攻撃できるものは縮小していても描く
  const TOWN_MIN_RATIO = 10, TOWN_LABEL_RATIO = 14; // 町・字の印は拡大率 10 から、名前は 14 から(参加直後の 9 では駅と名所が主役)
  const visibleNode = (n) => n.genre !== 'town' || zoomRatio() >= TOWN_MIN_RATIO || n.id === S.selected || (n.owner && n.owner === S.me) || (relOf(n) === 'team' && ownShown('team')) || canAttack(n.id);

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
  // 持ち主の表示の切り替え(端末ごとに覚える)
  try { const v = localStorage.getItem('pc.ownView'); S.ownView = OWN_VIEWS.includes(v) ? v : 'all'; } catch (e) { S.ownView = 'all'; }
  const renderOwnView = () => { for (const b of document.querySelectorAll('#ownView button')) b.setAttribute('aria-pressed', String(b.dataset.v === S.ownView)); };
  for (const b of document.querySelectorAll('#ownView button')) b.onclick = () => { S.ownView = b.dataset.v; try { localStorage.setItem('pc.ownView', S.ownView); } catch (e) { /* 覚えられなくても動く */ } renderOwnView(); };
  renderOwnView();
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
    if (!S.joined && !S.picking) return;
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
    if (S.moving) {
      if (!n) return;
      if (!startableNode(n)) { toast(startRefusal(n)); return; }
      if (window.confirm(`${n.name} のそばへ引っ越しますか?\n今の自分の拠点は消え、所有している拠点は新しい拠点と線がつながるまで広げられません。1 日 1 回までです。`)) send({ t: 'move', startNodeId: n.id });
      return;
    }
    if (S.picking) {
      // 開始地点を地図から選ぶ: 町・字とふつうの駅だけ(2026-10-19。判定はサーバーでもする)
      if (!n) return;
      if (!startableNode(n)) { toast(startRefusal(n)); return; }
      setStart({ id: n.id, name: n.name, area: n.area }); endPick();
      return;
    }
    if (!S.joined) return;
    // 何も無いところを押したら選択を解除する。出ている問題文も消す(2026-10-19 ユーザー指摘)
    if (!n) { S.selected = null; S.selNb = null; S.question = null; S.result = null; renderQuestion(); renderSelected(); return; }
    if (S.selected !== n.id) { S.selNb = null; send({ t: 'neighbors', nodeId: n.id }); } // 縮小していても、つながる線を全部出すため
    S.selected = n.id;
    renderSelected();
    const actionable = !S.overview && (canAttack(n.id) || n.owner === S.me);
    if (!actionable) return;
    if (!n.isPlayerNode && n.owner !== S.me && !hasQuestion(attackLevelOf(n))) { toast(`Lv${attackLevelOf(n)} の問題はまだありません。この拠点はまだ占領できません`); return; }
    if (n.owner === S.me && !n.isPlayerNode && !hasQuestion(Math.max(4, Math.max(1, n.level) + (n.defense || 0) + 1))) { toast('これ以上強化できません(次のレベルの問題がまだありません)'); return; }
    if (now() < S.cooldownUntil) { toast('不正解のため通信が止まっています'); return; }
    send({ t: 'ask', nodeId: n.id });
  }

  function adjacent(id) {
    const out = [];
    for (const e of S.edges.values()) { if (e.a === id) out.push(e.b); else if (e.b === id) out.push(e.a); }
    return out;
  }
  // 自分の拠点から、見えている所有拠点を線でたどって届く拠点(表示用。判定はサーバー)
  function computeReach() {
    const set = new Set();
    if (!S.home || !S.nodes.has(S.home.id)) { S.reach = set; return; }
    const stack = [S.home.id]; set.add(S.home.id);
    while (stack.length) {
      const cur = stack.pop();
      for (const m of adjacent(cur)) if (!set.has(m) && ownerOf(m) === S.me) { set.add(m); stack.push(m); }
    }
    S.reach = set;
  }
  // 季節航路(2026-10-19): サーバーの時計で使える時間かどうか。サーバーが配信のときに判定した open を使い、時間の決まりで今を見直す
  const routeOpenNow = (r) => {
    if (!r.hours) return true;
    const d = new Date(now()); const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return r.hours.some((h) => { const a = +h.from.slice(0, 2) * 60 + +h.from.slice(3), b = +h.to.slice(0, 2) * 60 + +h.to.slice(3); return a < b ? m >= a && m < b : m >= a || m < b; });
  };
  const jstRange = (h) => { const f = (s) => { const x = (+s.slice(0, 2) + 9) % 24; return `${x}:${s.slice(3)}`; }; return `${f(h.from)}〜${f(h.to)}`; }; // UTC → 日本時間の表示
  // 航路を持つ自分の空港・港を覚える(占領が外れたら忘れる)
  function rememberRoutes(n) {
    if (n.owner === S.me && Array.isArray(n.routes) && n.routes.length) S.mine.set(n.id, { id: n.id, name: n.name, lat: n.lat, lon: n.lon, routes: n.routes });
    else S.mine.delete(n.id);
  }
  // サーバーの canAttack と同じ条件(表示用。判定はサーバーが行う)
  function canAttack(id) {
    const n = nodeById(id);
    if (!n || !S.me || n.owner === S.me) return false;
    if (n.hackable === false) return false;
    if (n.isPlayerNode) return false; // プレイヤー自身の拠点は占領禁止
    if (n.protectedUntil > now()) return false;
    if (n.owner) { const o = playerById(n.owner); if (o && o.nodes <= 3 && o.newbie) return false; }
    if (adjacent(id).some((a) => ownerOf(a) === S.me && S.reach.has(a))) return true;
    // 航路の先: 自分が占領している空港・港から航路がある(画面の外の空港でもよい。最終の判定はサーバー)
    return (n.routes || []).some((r) => routeOpenNow(r) && S.mine.has(r.to) && (S.reach.has(r.to) || !S.nodes.has(r.to)));
  }

  // ---------- 描画: パネル ----------
  const GENRE_LABELS = {
    station: '駅', bus_terminal: 'バスターミナル', airport: '空港', port: '港', bridge: '橋', tower: '塔・展望施設',
    park: '公園・庭園', nature: '自然の名所', zoo_aquarium: '動物園・水族館・植物園', museum: '博物館・美術館', library: '図書館',
    theater: '劇場・ホール', stadium: 'スタジアム・競技場', heritage: '歴史的建造物', monument: '記念碑・広場', shrine_temple: '寺社',
    government: '官公庁', university: '大学・研究', market: '市場・商店街', convention: '展示場・会議場', complex: '複合施設',
    observatory: '天文台', ix: '相互接続点', town: '町・字', tourism: '観光地',
  };
  $('rankKind').onchange = renderPlayers;
  function renderPlayers() {
    $('onlineCount').textContent = S.players.filter((p) => p.online).length;
    const me = S.me2 || playerById(S.me);
    if (me) {
      $('meSwatch').style.background = me.teamStyle && me.teamStyle.fill ? me.teamStyle.fill : me.color; $('meName').textContent = me.name + (me.teamName ? `(${me.teamIcon ? me.teamIcon + ' ' : ''}${me.teamName})` : '');
      $('meScore').textContent = `${me.score}点`; $('meNodes').textContent = `${me.nodes}拠点`; $('mePoints').textContent = me.points;
    }
    const kind = $('rankKind').value;
    const R = S.rankings || {};
    const row = (i, color, name, sub, right, dim) => {
      const li = document.createElement('li');
      if (dim) li.className = 'offline';
      const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = i + 1;
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = color || 'transparent';
      const n = document.createElement('span'); n.className = 'pname'; n.textContent = name;
      const sm = document.createElement('small'); sm.textContent = sub; n.append(sm);
      const sc = document.createElement('span'); sc.className = 'pscore'; sc.textContent = right;
      li.append(rank, sw, n, sc); return li;
    };
    let items;
    if (kind === 'teams') {
      items = (R.teams || []).map((t, i) => row(i, t.style ? t.style.fill : null, `${t.icon ? t.icon + ' ' : ''}${t.name || t.id}`, `${t.members}人 ・ ${t.nodes}拠点`, `${t.score}点`, false));
      if (!items.length) { const li = document.createElement('li'); li.className = 'offline'; li.textContent = 'まだチームがありません'; items = [li]; }
    } else {
      const list = kind === 'score' ? [...S.players].sort((a, b) => b.score - a.score || b.points - a.points) : kind === 'weekPoints' ? (R.weekPoints || []).filter((p) => (p.weekPoints || 0) > 0) : (R[kind] || []);
      const val = (p) => kind === 'points' ? `${p.points}点` : kind === 'nodes' ? `${p.nodes}拠点` : kind === 'weekPoints' ? `+${p.weekPoints || 0}点` : `${p.score}点`;
      items = list.slice(0, 15).map((p, i) => row(i, p.color, p.name, p.id === S.me ? 'あなた' : (p.teamName ? p.teamName : `${p.nodes}拠点`), val(p), !p.online));
      if (!items.length) { const li = document.createElement('li'); li.className = 'offline'; li.textContent = kind === 'weekPoints' ? '今週はまだ誰も獲得していません' : 'まだ順位がありません'; items = [li]; }
    }
    $('scoreTitle').textContent = kind === 'weekPoints' && R.week ? `順位(${R.week} の週)` : '順位';
    $('scores').replaceChildren(...items);
    $('log').replaceChildren(...S.log.map((l) => { const li = document.createElement('li'); li.textContent = l.text; return li; }));
    $('log').scrollTop = $('log').scrollHeight;
  }
  function renderSelected() {
    const n = selectedNode();
    $('nodePanel').hidden = !n;
    if (!n) return;
    const owner = n.owner ? playerById(n.owner) : null;
    $('npName').textContent = n.name;
    // 観光地は細分(温泉・滝 …)を添える(tags の先頭。続けて指定・百選)
    const genreLabel = (GENRE_LABELS[n.genre] || '') + (n.genre === 'tourism' && n.tags && n.tags[0] ? `(${n.tags[0]})` : '');
    $('npMeta').textContent = [n.isPlayerNode ? 'プレイヤーの拠点' : genreLabel, n.tags && n.tags.length > 1 ? n.tags.slice(1).join('・') : '', n.area || ''].filter(Boolean).join(' ・ ');
    $('npLevel').textContent = `Lv${n.level}${n.defense ? `(+${n.defense} 強化 → 出題 Lv${n.level + n.defense})` : ''}` + (!n.isPlayerNode && n.hackable !== false && !hasQuestion(attackLevelOf(n)) ? '(このレベルの問題は準備中。まだ占領できません)' : '');
    $('npValue').textContent = `${n.value}点`;
    $('npCompany').hidden = $('npCompanyLabel').hidden = !n.company;
    if (n.company) $('npCompany').textContent = `${n.company}(命名権など。ハック不可)`;
    $('npOwner').textContent = owner ? `${owner.name}${owner.id === S.me ? '(あなた)' : ''}` : (n.owner ? '他のプレイヤー' : '中立');
    // 突破に必要な回数 = つながりの本数。自分(チーム)の進捗と、他の攻め手の最大進捗
    const hits = n.hits || 1, prog = n.progress || {};
    const myKey = S.team ? S.team.id : S.me;
    const mine = prog[myKey] || 0;
    const others = Object.entries(prog).filter(([k]) => k !== myKey).map(([, v]) => v);
    const parts = [`正解 ${hits} 回(つながり ${hits} 本)`];
    if (n.hackable === false) parts.length = 0, parts.push('ハック不可');
    else if (n.owner === S.me) { if (others.length) parts.push(`侵入されています: 最大 ${Math.max(...others)}/${hits}`); }
    else { if (mine) parts.push(`${S.team ? 'チーム' : 'あなた'} ${mine}/${hits}`); if (others.length) parts.push(`他の攻め手 最大 ${Math.max(...others)}/${hits}`); }
    $('npHits').textContent = parts.join(' ・ ');
    const lines = Array.isArray(n.lines) ? n.lines : [];
    $('npLines').hidden = !lines.length;
    $('npLinesList').replaceChildren(...lines.map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
    const routes = Array.isArray(n.routes) ? n.routes : [];
    $('npRoutes').hidden = !routes.length;
    $('npRoutesList').replaceChildren(...routes.map((r) => {
      const li = document.createElement('li'); li.tabIndex = 0;
      li.textContent = `${r.mode === 'air' ? '✈ 空路' : '⚓ 海路'} → ${r.name}` + (r.hours ? `(季節航路: 毎日 ${r.hours.map(jstRange).join('・')} 日本時間${routeOpenNow(r) ? '' : '。いまは運航時間外'})` : '');
      if (r.hours && !routeOpenNow(r)) li.style.opacity = '0.55';
      const go = () => { centerOn(worldOf(r.lat, r.lon), Math.max(9, zoomRatio())); requestView(true); };
      li.onclick = go; li.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      return li;
    }));
    let status;
    if (S.overview) status = '拡大すると攻撃や強化ができます';
    else if (n.hackable === false) status = 'ネットワークにつながっていない場所です(ハック不可)';
    else if (n.owner === S.me) status = 'タップすると強化の問題が出ます';
    else if (n.isPlayerNode) status = 'プレイヤー自身の拠点は占領できません';
    else if (n.protectedUntil > now() && (n.genre === 'airport' || n.genre === 'port')) status = `占領されたばかりで守られています(あと ${Math.ceil((n.protectedUntil - now()) / 60000)} 分)`; // 空港・港は占領から 5 分
    else if (n.protectedUntil > now()) status = `生まれたばかりで守られています(あと ${Math.ceil((n.protectedUntil - now()) / 3600000)} 時間)`;
    else if (n.owner && (playerById(n.owner) || {}).nodes <= 3 && (playerById(n.owner) || {}).newbie) status = '始めたばかりで拠点が少ないプレイヤーは守られています';
    else if (canAttack(n.id)) status = `タップすると攻撃の問題が出ます(突破まで あと ${Math.max(1, hits - mine)} 回)`;
    else if (adjacent(n.id).some((a) => ownerOf(a) === S.me)) status = '隣の所有拠点は自分の拠点から線がつながっていないため、ここからは広げられません(つなぎ直すと攻撃できます)';
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
    // 表: 1 つ(table)でも複数(tables)でも描く
    const wrap = $('qTables');
    const makeTable = (t) => {
      const tbl = document.createElement('table'); tbl.className = 'qtable';
      if (t.title) { const cap = document.createElement('caption'); cap.textContent = t.title; tbl.append(cap); }
      const thead = document.createElement('thead'); const hr = document.createElement('tr');
      (t.headers || []).forEach((h) => { const th = document.createElement('th'); th.textContent = h; hr.append(th); });
      thead.append(hr);
      const tbody = document.createElement('tbody');
      (t.rows || []).forEach((row) => { const tr = document.createElement('tr'); row.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.append(td); }); tbody.append(tr); });
      tbl.append(thead, tbody); return tbl;
    };
    const tables = Array.isArray(q.tables) && q.tables.length ? q.tables : (q.table ? [q.table] : []);
    wrap.replaceChildren(...tables.map(makeTable));
    const r = S.result && S.result.qid === q.qid ? S.result : null;
    const isText = q.answerKind === 'text' && Array.isArray(q.fields);
    $('qOptions').hidden = isText; $('qFields').hidden = !isText;
    if (isText) renderFields(q, r);
    $('qOptions').replaceChildren(...(isText ? [] : (q.options || [])).map((o, i) => {
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
      const showAnswers = isText && Array.isArray(r.answers) && !r.correct;
      $('qAnswers').hidden = !showAnswers;
      if (showAnswers) $('qAnswers').textContent = '正解: ' + q.fields.map((f, i) => `${f.label}: ${r.answers[i]}`).join(' / ');
      $('qDefense').hidden = !r.defenseNote;
      if (r.defenseNote) $('qDefense').textContent = `守る側なら: ${r.defenseNote}`;
    }
  }
  // 入力式の欄(COMMON.md 第 2 章): 欄ごとにラベルと例示。Enter か「答える」で送る。送信後は無効化
  function renderFields(q, r) {
    const list = $('qFieldList');
    const sent = !!r || (Array.isArray(S.chosen) && S.chosen.qid === q.qid);
    if (list.dataset.qid !== q.qid) {
      list.dataset.qid = q.qid;
      list.replaceChildren(...q.fields.map((f, i) => {
        const box = document.createElement('div'); box.className = 'field';
        const lab = document.createElement('label'); lab.textContent = f.label || f.name; lab.htmlFor = `fld${i}`;
        const inp = document.createElement(f.format === 'prefixplan' ? 'textarea' : 'input');
        inp.id = `fld${i}`; inp.name = f.name; inp.placeholder = f.hint || ''; inp.maxLength = f.format === 'prefixplan' ? 1000 : 200;
        if (inp.tagName === 'INPUT') { inp.type = 'text'; inp.inputMode = ['number', 'prefixlen'].includes(f.format) ? 'numeric' : 'text'; inp.autocapitalize = 'off'; inp.spellcheck = false; }
        else inp.rows = 4;
        inp.addEventListener('input', updateSubmit);
        box.append(lab, inp); return box;
      }));
      setTimeout(() => { const first = list.querySelector('input,textarea'); if (first) first.focus(); }, 0);
    }
    for (const el of list.querySelectorAll('input,textarea')) el.disabled = sent;
    $('qSubmit').disabled = sent || !allFilled();
    if (r && Array.isArray(r.answers)) {
      list.querySelectorAll('.field').forEach((box, i) => { box.classList.remove('ok', 'ng'); box.classList.add(r.correct ? 'ok' : 'ng'); });
    }
  }
  function allFilled() { return [...$('qFieldList').querySelectorAll('input,textarea')].every((el) => el.value.trim()); }
  function updateSubmit() { $('qSubmit').disabled = !allFilled(); }
  $('qFields').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = S.question;
    if (!q || q.answerKind !== 'text' || (S.result && S.result.qid === q.qid) || (S.chosen && S.chosen.qid === q.qid)) return;
    if (!allFilled()) { toast('すべての欄を入れてください'); return; }
    const inputs = [...$('qFieldList').querySelectorAll('input,textarea')].map((el) => el.value);
    S.chosen = { qid: q.qid, inputs };
    send({ t: 'answer', qid: q.qid, inputs });
    renderQuestion();
  });
  function choose(i) {
    const q = S.question;
    if (!q || q.answerKind === 'text' || (S.result && S.result.qid === q.qid) || S.chosen != null) return;
    S.chosen = i; send({ t: 'answer', qid: q.qid, choice: i });
  }
  function highlightIps(text) {
    return text.split(/(\d+\.\d+\.\d+\.\d+(?:\/\d+)?|\/\d+)/).filter(Boolean).map((part) => {
      if (/^(\d+\.\d+\.\d+\.\d+(\/\d+)?|\/\d+)$/.test(part)) { const s = document.createElement('span'); s.className = 'ip'; s.textContent = part; return s; }
      return document.createTextNode(part);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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
    if (!S.joined && !S.picking) return;
    const ratio = zoomRatio();
    const grow = V.w < 600 ? 1.15 : 1;

    // 海(2026-10-19 ユーザー指摘: 湖と同じ色に): 下地を水色にして、陸地(区・市の面)を陸の色で塗る。
    // 陸地は粗い全国版(約 1 km)を下地にし、読み込んである都道府県は細かい版で重ねる。全国版が届くまでは今までどおり(全部陸の色)
    if (S.coarse && S.coarse.size) {
      ctx.fillStyle = tok('--water') || '#D6ECFA'; ctx.fillRect(0, 0, V.w, V.h);
      ctx.fillStyle = tok('--land') || '#F7F9FA';
      const lo = toWorld(0, 0), hi = toWorld(V.w, V.h);
      const detailed = !(S.overview && S.viewZ >= 3); // 細かい境界を使う倍率か
      const fillLand = (set, coarse) => {
        for (const b of set.values()) {
          if (!b.polys[0] || !b.polys[0][0]) continue;
          if (coarse && detailed && S.boundsReady.has(b.pref)) continue; // 細かい版を読んだ県は粗い版で塗らない(海岸が約 1 km ずれるため)
          if (!b.bbox) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const ring of b.polys) for (const q of ring) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; } b.bbox = [x0, y0, x1, y1]; }
          if (b.bbox[2] < lo.x || b.bbox[0] > hi.x || b.bbox[3] < lo.y || b.bbox[1] > hi.y) continue;
          ctx.beginPath();
          for (const ring of b.polys) { for (let i = 0; i < ring.length; i++) { const q = toScreen(ring[i]); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); } ctx.closePath(); }
          ctx.fill('evenodd');
        }
      };
      fillLand(S.coarse, true);
      if (detailed) fillLand(S.bounds, false);
    }

    // 区・市の境界: 支配者がいればその色で薄く塗る。縮小時は輪郭も濃く。z3 以上は粗い全国版
    const boundSet = S.overview && S.viewZ >= 3 && S.coarse ? S.coarse : S.bounds;
    if (boundSet && boundSet.size) {
      const ctl = new Map((S.regions || []).map((g) => [g.id, g.controller]));
      ctx.lineJoin = 'round';
      const lo = toWorld(0, 0), hi = toWorld(V.w, V.h);
      for (const b of boundSet.values()) {
        // 画面の外の地域は描かない(全国を読んだときの負荷を抑える)
        const r0 = b.polys[0] && b.polys[0][0];
        if (!r0) continue;
        if (!b.bbox) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const ring of b.polys) for (const q of ring) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; } b.bbox = [x0, y0, x1, y1]; }
        if (b.bbox[2] < lo.x || b.bbox[0] > hi.x || b.bbox[3] < lo.y || b.bbox[1] > hi.y) continue;
        const c = ctl.get(b.id);
        ctx.beginPath();
        for (const ring of b.polys) {
          for (let i = 0; i < ring.length; i++) { const q = toScreen(ring[i]); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }
          ctx.closePath();
        }
        const fillCol = c ? (c.style ? c.style.fill : c.color) : null, frameCol = c ? (c.style ? c.style.frame : c.color) : null;
        if (fillCol) { ctx.fillStyle = fillCol; ctx.globalAlpha = S.overview ? 0.32 : 0.12; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.strokeStyle = frameCol || C.line; ctx.lineWidth = S.overview ? (c ? 2 : 1.5) : 1; ctx.globalAlpha = S.overview ? 0.9 : 0.5; ctx.stroke(); ctx.globalAlpha = 1;
      }
    }

    // 湖・湾(2026-10-19): 薄い水色で塗る。島は穴として抜く(even-odd)。画面の外のものは描かない
    if (S.water && S.water.length) {
      const lo = toWorld(0, 0), hi = toWorld(V.w, V.h);
      ctx.fillStyle = tok('--water') || '#D6ECFA';
      for (const w of S.water) {
        if (!w.bbox) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const ring of w.polys) for (const q of ring) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; } w.bbox = [x0, y0, x1, y1]; }
        if (w.bbox[2] < lo.x || w.bbox[0] > hi.x || w.bbox[3] < lo.y || w.bbox[1] > hi.y) continue;
        ctx.beginPath();
        for (const ring of w.polys) {
          for (let i = 0; i < ring.length; i++) { const q = toScreen(ring[i]); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }
          ctx.closePath();
        }
        ctx.fill('evenodd');
      }
    }

    // 航路(2026-10-19 ユーザー決定): 実際の空路・海路を、占領したときに曲線で出す(空路は紫の弧、海路はオレンジで海の上を通る線)
    //   片方の端を自分(切り替えで出すならチームも)が持つ → 点線(行き先を攻撃できる)/ 両端とも → 太い実線 / 空港・港を選んだとき → その航路を薄く
    {
      const pairs = new Map(); // 'idA|idB' → { a, b, mode, state }
      const rank = { sel: 1, one: 2, both: 3 };
      const ownedByUs = (id) => { if (S.mine.has(id)) return true; const m = S.nodes.get(id); return !!m && m.owner && (m.owner === S.me || (relOf(m) === 'team' && ownShown('team'))); };
      const add = (o, r, state) => {
        if (!routeOpenNow(r)) return; // 季節航路は使える時間だけ線を出す
        const [x, y] = o.id < r.to ? [o.id, r.to] : [r.to, o.id];
        const key = `${x}|${y}`;
        const st = state === 'one' && ownedByUs(r.to) ? 'both' : state;
        const cur = pairs.get(key);
        if (cur && rank[cur.state] >= rank[st]) return;
        const A = o.id === x ? o : r, B = o.id === x ? r : o; // 向きをそろえる(同じ航路はどちらから見ても同じ曲線)
        pairs.set(key, { key, a: worldOf(A.lat, A.lon), b: worldOf(B.lat, B.lon), mode: r.mode, state: st });
      };
      for (const o of S.mine.values()) for (const r of o.routes) add(o, r, 'one');
      if (ownShown('team')) for (const n of S.nodes.values()) if (n.routes && n.routes.length && relOf(n) === 'team') for (const r of n.routes) add(n, r, 'one');
      // 選んだ空港・港の航路は、その拠点が画面の外に出て読み込みから外れても出し続ける(selectedNode が覚えている)
      const sel = selectedNode();
      if (sel && sel.routes) for (const r of sel.routes) add(sel, r, 'sel');
      if (pairs.size) {
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const p of [...pairs.values()].sort((u, v) => rank[u.state] - rank[v.state])) {
          ctx.strokeStyle = p.mode === 'air' ? '#8B5CF6' : '#F97316'; // 空路は紫、海路はオレンジ(海を水色にしたので青・水色から変えた。2026-10-19 ユーザー指摘)
          ctx.lineWidth = p.state === 'both' ? 4.5 : p.state === 'one' ? 2.5 : 2;
          ctx.globalAlpha = p.state === 'sel' ? 0.4 : p.state === 'one' ? 0.85 : 0.95;
          ctx.setLineDash(p.state === 'both' ? [] : p.state === 'one' ? [8, 6] : [4, 6]);
          const path = p.mode === 'sea' ? S.seaPaths.get(p.key) : null;
          ctx.beginPath();
          if (path && path.length >= 2) {
            // 海の上の点を、点と点の中ほどを通るなめらかな曲線でつなぐ
            const q = path.map(toScreen);
            ctx.moveTo(q[0].x, q[0].y);
            for (let i = 1; i < q.length - 1; i++) ctx.quadraticCurveTo(q[i].x, q[i].y, (q[i].x + q[i + 1].x) / 2, (q[i].y + q[i + 1].y) / 2);
            ctx.lineTo(q[q.length - 1].x, q[q.length - 1].y);
          } else {
            // 空路(と道すじの無い海路)はゆるい弧。曲がる向きと強さはいつも同じ(線路と見分けやすく)
            const a = toScreen(p.a), b = toScreen(p.b);
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, k = p.mode === 'air' ? 0.18 : 0.1;
            ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx - dy * k, my + dx * k, b.x, b.y);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 陣地(2026-10-19): 持っている拠点のまわりを持ち主の色で薄くにじませる。切り替えで出す範囲を決める
    {
      const hr = Math.max(16, Math.min(70, 10 + ratio * 1.6)) * grow;
      for (const n of S.nodes.values()) {
        const rel = relOf(n);
        if (!ownShown(rel) || n.isPlayerNode || !visibleNode(n)) continue;
        const col = ownerColorOf(n);
        if (!col) continue;
        const p = toScreen(posOf(n));
        if (p.x < -hr || p.y < -hr || p.x > V.w + hr || p.y > V.h + hr) continue;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, hr);
        g.addColorStop(0, col); g.addColorStop(1, 'transparent');
        ctx.globalAlpha = rel === 'other' ? 0.16 : 0.28; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, hr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // 線路(リンク)
    ctx.lineCap = 'round';
    for (const e of S.edges.values()) {
      const na = nodeById(e.a), nb = nodeById(e.b);
      if (!na || !nb || !visibleNode(na) || !visibleNode(nb)) continue; // 描かない町・字への線も描かない
      const a = toScreen(posOf(na)), b = toScreen(posOf(nb));
      const own = na.owner && na.owner === nb.owner && ownShown(relOf(na)) ? ownerColorOf(na) : null;
      const thin = na.isPlayerNode || nb.isPlayerNode;
      const town = na.genre === 'town' || nb.genre === 'town'; // 町・字の線は細く薄く(路線の線を主役にする)
      ctx.strokeStyle = own || C.line;
      ctx.lineWidth = (own ? (thin || town ? 4 : 7) : (thin ? 2.5 : town ? 1.5 : 4)) * Math.min(1, Math.max(0.4, ratio / 4));
      const ef = Math.min(fadeOf(na), fadeOf(nb)); // 線も、両端の薄い方に合わせて薄く
      ctx.globalAlpha = (town && !own ? 0.55 : 1) * ef;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 選んだ拠点のつながり(2026-10-19 ユーザー決定): 拡大・縮小にかかわらず、つながり先まで黒い線で出す(選択を解除すると元の色)
    {
      const sel = selectedNode();
      if (sel && S.selNb && S.selNb.id === sel.id && S.selNb.list.length) {
        const a = toScreen(posOf(sel));
        ctx.save(); ctx.strokeStyle = C.ink; ctx.fillStyle = C.ink; ctx.lineCap = 'round'; ctx.globalAlpha = 0.9;
        ctx.lineWidth = Math.max(2, Math.min(4, 1.5 + ratio / 6));
        for (const m of S.selNb.list) {
          const b = toScreen(S.nodes.has(m.id) ? posOf(S.nodes.get(m.id)) : m.w);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          if (!S.drawn || !S.drawn.has(m.id)) { ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2); ctx.fill(); } // 描いていない拠点(縮小で隠れた町・字など)は点で示す
        }
        ctx.restore();
      }
    }

    // 拠点: プレイヤーの拠点 → 固定拠点 → 選択中(最前面)
    const pulse = 0.5 + 0.5 * Math.sin(t / 260);
    const rank = (n) => (n.id === S.selected ? 2 : n.isPlayerNode ? 0 : 1);
    // レベルの低いものから描き、高いものを上に重ねる(2026-10-19 ユーザー案)
    const sorted = [...S.nodes.values()].filter(visibleNode).sort((a, b) => rank(a) - rank(b) || a.level - b.level);
    // 重要さ(間引きと名前の優先順位): 選択中 > 自分の拠点 > チームの拠点 > 誰かの拠点 > レベル > 空港・港
    const prio = (n) => (n.id === S.selected ? 1e6 : 0) + (n.owner && n.owner === S.me ? 1e5 : 0) + (relOf(n) === 'team' ? 5e4 : 0) + (n.owner ? 1e4 : 0) + n.level * 10 + (n.kind === 'GW' ? 5 : 0);
    // 縮小表示: 画面の小さなます目(約 34 px)ごとに、いちばん重要な拠点だけを描く(倍率に対して印が多すぎないように)
    let drawList = sorted;
    if (S.overview) {
      const cell = 34 * grow, best = new Map();
      for (const n of sorted) {
        const p = toScreen(posOf(n));
        if (p.x < -60 || p.y < -60 || p.x > V.w + 60 || p.y > V.h + 60) continue;
        const k = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
        const b = best.get(k);
        if (!b || prio(n) > prio(b)) best.set(k, n);
      }
      const keep = new Set(best.values());
      drawList = sorted.filter((n) => keep.has(n));
    }
    S.drawn = new Set(drawList.map((n) => n.id));
    // 名前は最後にまとめて、重要なものから重ならないように置く
    const labels = [];
    for (const n of drawList) {
      const p = toScreen(posOf(n));
      if (p.x < -60 || p.y < -60 || p.x > V.w + 60 || p.y > V.h + 60) continue;
      const r = radiusOf(n) * grow;
      const rel = relOf(n), shownOwn = ownShown(rel);
      const owner = n.owner && shownOwn ? ownerColorOf(n) || C.strong : null; // 切り替えで出さない持ち主は、持ち主なしと同じ見た目
      const ring = n.isPlayerNode ? r : SH.outerRadius(n.level, r);
      if (!S.overview && canAttack(n.id) && hasQuestion(attackLevelOf(n))) {
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
      // 持ち主のいない拠点は、塗りつぶしの形でも元の色(灰色)。黒(文字の色)は濃すぎる(2026-10-19 ユーザー指摘)
      const col = owner || C.strong;
      const fa = fadeOf(n); // 縮小時は低いレベルほど薄く
      ctx.globalAlpha = fa;
      if (n.hackable === false) ctx.globalAlpha = 0.45 * fa;
      else if (owner && n.owner === S.me && !n.isPlayerNode && !S.reach.has(n.id)) ctx.globalAlpha = 0.55 * fa; // 自分の拠点から線が切れている所有拠点
      // 自分: 塗り + 真ん中の点 / チーム: 塗り(チームの色)+ チームの枠の色 / ほかの人: 塗りだけ(2026-10-19)
      const frame = rel === 'team' && owner ? teamFrameOf(n) : null;
      ctx.fillStyle = filled || frame ? col : C.surface; ctx.strokeStyle = frame || col;
      ctx.lineWidth = frame ? 4 : owner ? (n.isPlayerNode ? 5 : 7) : (n.isPlayerNode ? 3 : 4); // チームの枠は細めにして、中の塗り(チームの色)を見せる
      shape(n, p, r); ctx.fill(); ctx.stroke();
      if (!n.isPlayerNode) SH.extras(ctx, n.level, p, r, frame || col, frame ? col : C.surface);
      if (owner && n.owner === S.me) { ctx.fillStyle = filled ? C.surface : owner; ctx.beginPath(); ctx.arc(p.x, p.y, n.isPlayerNode ? 3 : 4, 0, Math.PI * 2); ctx.fill(); }
      // 侵入の進捗: 攻め手ごとの正解回数を弧で示す(自分は自分の色、ほかは灰色)
      const hits = n.hits || 1, prog = n.progress || {};
      const entries = Object.entries(prog).filter(([, v]) => v > 0);
      if (entries.length && !S.overview) {
        entries.sort((x, y) => (x[0] === S.me ? 1 : 0) - (y[0] === S.me ? 1 : 0));
        for (const [k, v] of entries) {
          const mineKey = k === S.me || (S.team && k === S.team.id);
          ctx.strokeStyle = mineKey ? (colorOf(S.me) || C.accent) : C.muted; ctx.lineWidth = 3.5;
          ctx.beginPath(); ctx.arc(p.x, p.y, ring + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, v / hits)); ctx.stroke();
        }
      }
      const top = ring;
      for (let i = 0; i < Math.min(n.defense, 12); i++) { ctx.fillStyle = C.ink; ctx.fillRect(p.x - (Math.min(n.defense, 12) * 8 - 3) / 2 + i * 8, p.y - top - 9, 5, 5); }
      // 名前: 寄ったときだけ全部。縮小時はレベルの高いものと自分の拠点
      const showLabel = S.overview ? true : n.isPlayerNode
        ? (ratio >= 7 || n.owner === S.me)
        : n.genre === 'town' ? (ratio >= TOWN_LABEL_RATIO || n.owner === S.me || n.id === S.selected)
        : (ratio >= 14 || (ratio >= 5 && n.level >= 30) || (ratio >= 2 && n.level >= 100) || n.level >= 200 || n.kind === 'IX' || n.owner === S.me); // 2026-10-19 の物差し
      if (showLabel) {
        const isSel = S.selected === n.id, dim = S.selected && !isSel, fl = fadeOf(n);
        const fs = n.kind === 'IX' ? 14 : n.isPlayerNode ? 10 : 11.5;
        const font = `${n.isPlayerNode ? 500 : 700} ${fs * grow}px "BIZ UDPGothic", sans-serif`;
        ctx.font = font;
        const ty = p.y + top + 12 * grow, tw = ctx.measureText(n.name).width, th = fs * grow;
        // 名前の優先: 選択中・自分の拠点は必ず。ほかはレベルが高いほど先に置く(縮小時の区・市の名前は Lv8 前後と同じ扱い)
        const lp = isSel ? 1e6 : (n.owner && n.owner === S.me) ? 9e5 : 150 + n.level * 20 + (n.kind === 'GW' ? 15 : 0);
        labels.push({ prio: lp, must: isSel || (n.owner && n.owner === S.me), box: [p.x - tw / 2 - 3, ty - th, tw + 6, th + 5], draw: () => {
          ctx.textAlign = 'center'; ctx.font = font;
          if (isSel) {
            const w = tw + 10, h = th + 6;
            ctx.fillStyle = C.surface; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(p.x - w / 2, ty - h + 4, w, h, 4); else ctx.rect(p.x - w / 2, ty - h + 4, w, h);
            ctx.fill(); ctx.stroke();
          }
          ctx.globalAlpha = (dim ? 0.3 : 1) * fl; // 名前も印と同じ濃さ
          ctx.fillStyle = n.isPlayerNode && !isSel ? C.muted : C.ink;
          ctx.fillText(n.name, p.x, ty);
          ctx.globalAlpha = 1;
        } });
      }
      ctx.globalAlpha = 1;
    }
    if (S.overview) {
      // 地域の支配(第 14.2 節): 中心に地域名。支配者がいれば、その色の帯と名前
      for (const g of S.regions) {
        const q = toScreen(worldOf(g.lat, g.lon));
        if (q.x < -80 || q.y < -40 || q.x > V.w + 80 || q.y > V.h + 40) continue;
        const st = g.controller && g.controller.style ? g.controller.style : null;
        const col = g.controller ? (st ? st.fill : g.controller.color) : null;
        const font = `700 ${g.tier <= 3 ? 16 : g.tier === 5 ? 14 : 12}px "BIZ UDPGothic", sans-serif`;
        ctx.font = font;
        const label = (g.controller && g.controller.icon ? g.controller.icon + ' ' : '') + g.name, sub = g.controller ? `${g.controller.name} が支配` : '';
        const w = Math.max(ctx.measureText(label).width, sub ? ctx.measureText(sub).width * 0.85 : 0) + 14;
        const h = sub ? 34 : 20;
        // 地域名の優先: 支配者のいる地域 > 国・地方 > 都道府県 > 区・市
        const lp = (g.controller ? 8e5 : 0) + (g.tier <= 3 ? 750 : g.tier === 5 ? 700 : 300);
        labels.push({ prio: lp, box: [q.x - w / 2, q.y - 10, w, h], draw: () => {
          ctx.textAlign = 'center'; ctx.font = font;
          ctx.fillStyle = col || C.surface; ctx.globalAlpha = col ? 0.85 : 0.75;
          ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(q.x - w / 2, q.y - 10, w, h, 5); else ctx.rect(q.x - w / 2, q.y - 10, w, h); ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = st ? st.frame : (col || C.line); ctx.lineWidth = st ? 2 : 1.5; ctx.stroke();
          ctx.fillStyle = st ? st.text : (col ? '#fff' : C.ink); ctx.fillText(label, q.x, q.y + 5);
          if (sub) { ctx.font = '600 10.5px "BIZ UDPGothic", sans-serif'; ctx.fillText(sub, q.x, q.y + 19); }
        } });
      }
    }
    // 名前を重要な順に置く。既に置いた名前と重なるものは出さない(選択中と自分の拠点は必ず出す)
    const placed = S.overview ? [[8, 8, 520, 20]] : []; // 左上の「広域表示」の説明の場所
    const hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    labels.sort((a, b) => b.prio - a.prio);
    for (const l of labels) {
      if (!l.must && placed.some((b) => hit(l.box, b))) continue;
      placed.push(l.box); l.draw();
    }
    if (S.overview) {
      ctx.fillStyle = C.muted; ctx.font = '600 12px "BIZ UDPGothic", sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`広域表示: Lv${{ 1: 30, 2: 100, 3: 250, 4: 400 }[S.viewZ] || ''} 以上の拠点と、地域の支配。拡大すると全部出ます`, 12, 22);
    }
  }
  function nodeAt(pt) {
    let best = null, bd = Infinity;
    for (const n of S.nodes.values()) {
      if (S.drawn && !S.drawn.has(n.id)) continue; // 描いていない拠点(縮小表示で間引いたもの、拡大前の町・字)は押せない
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
    if (cd > 0) $('coolBar').style.transform = `scaleX(${Math.min(1, cd / (S.cooldownMs || 4000))})`;
  }
  let toastTimer;
  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
  }

  resize();
  requestAnimationFrame(draw);
})();
