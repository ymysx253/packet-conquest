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
    far: new Map(),     // 読み込んでいない隣の駅(id → 位置・路線)。路線の線を画面の外へ伸ばすのに使う(2026-10-20)
    tiles: new Set(),   // 受け取っているタイル(z0)
    regions: [],        // 縮小時の地域の支配(区・市 / 都道府県 / 国)
    viewZ: 0, overview: false,
    players: [], log: [], offset: 0,
    question: null, result: null, chosen: null, cooldownUntil: 0,
    selected: null, centerPending: false,
    start: null, picking: false, searchTimer: null, // 開始地点(選んだ駅・名所)と、地図から選ぶモード
    moving: false, movedAt: null, reach: new Set(), // 引っ越しの選択中 / 最後の引っ越し / 自分の拠点から線でつながっている所有拠点
    rankings: null, me2: null, team: null, cooldownMs: 5000, // ランキング / 自分の集計 / 所属チーム / いまの待ち時間の長さ
    chat: { tab: 'team', to: null, rooms: new Map(), loaded: new Set(), partners: [], unread: { all: false, team: false, dm: false }, notes: {}, canWrite: {} }, // チャット(2026-10-21)
    mine: new Map(), // 自分が占領している空港・港(航路を持つもの)。画面の外に出ても覚えておき、航路の線を引く
    // 区・市の境界・陸・湖は背景の部品(map-base.js)が読んで描く(2026-10-22 案 A)。ここでは地域の支配の色を渡すだけ
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
  // 持ち主のチームの見た目 { frame, fill, text }(チームに入っていない人は null)。2026-10-19 ユーザー指摘:
  // 印の線 = 枠の色、印の中 = 背景色(塗りつぶしの形のレベルは枠の色で塗る)、拠点の名前 = 文字の色
  const ownerStyleOf = (n) => {
    if (!n.owner) return null;
    const o = playerById(n.owner);
    const mine = (n.owner === S.me || (S.team && n.ownerTeam === S.team.id)) && S.team && S.team.style;
    const st = (o && o.teamStyle) || mine || (n.ownerFrame ? { frame: n.ownerFrame, fill: n.ownerColor, text: n.ownerText } : null);
    return st && st.frame ? st : null;
  };
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
  // 航路はたどり着いて(自分かチームが空港・港を押さえて)はじめて分かる(2026-10-22 ユーザー指摘: 開始地点を選ぶ前から空路・海路が見えていた。説明書 4.5)。参加前は出さない
  const routesKnown = (n) => !!(S.joined && n && n.owner && (n.owner === S.me || relOf(n) === 'team'));
  // 選んだ空港・港の航路: サーバーが選んだ拠点のつながり先(neighbors)で、押さえているときだけ教えてくれる分
  const routesOfSelected = (n) => (routesKnown(n) && S.selNb && S.selNb.id === n.id ? S.selNb.list.filter((x) => x.route && x.mode).map((x) => ({ to: x.id, mode: x.mode, name: x.name, lat: x.lat, lon: x.lon, hours: x.hours, phantom: x.phantom })) : []);

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
        S.team = m.team ? { id: m.team, name: m.teamName } : null; S.cooldownUntil = m.cooldownUntil || 0; S.cooldownMs = Math.max(5000, S.cooldownUntil - Date.now());
        renderTeam();
        if (S.team) { S.infoOnly = true; send({ t: 'team', action: 'info' }); }
        store.set('pc-token', m.token); store.set('pc-name', m.name);
        $('codeInput').value = m.token;
        S.chat.rooms.clear(); S.chat.loaded.clear(); chatOpen(S.chat.tab); send({ t: 'chat', action: 'partners' });
        $('lobby').hidden = true; $('mePanel').hidden = false; $('onlineChip').hidden = false; $('ownView').hidden = false;
        $('lobbyError').textContent = ''; $('meCode').textContent = m.token;
        resize();
        if (S.home) centerOn(worldOf(S.home.lat, S.home.lon), 9); else if (S.spawn) centerOn(worldOf(S.spawn.lat, S.spawn.lon), 9);
        requestView(true);
        break;
      case 'tiles': onTiles(m); break;
      case 'neighbors': if (m.nodeId === S.selected) { S.selNb = { id: m.nodeId, list: (m.list || []).map((x) => ({ ...x, w: worldOf(x.lat, x.lon) })), siege: m.siege || null }; renderSelected(); } break;
      case 'search': renderSearch(m); break;
      case 'moved':
        S.home = m.home; S.movedAt = m.movedAt; S.moving = false; $('pickBar').hidden = true; S.selected = null; S.question = null; S.result = null;
        if (m.area) $('areaChip').textContent = m.area;
        S.nodes.clear(); S.edges.clear(); S.far.clear(); S.tiles.clear(); lastViewKey = ''; railCache = null; nbCache = null; adjCache = null;
        centerOn(worldOf(m.home.lat, m.home.lon), 9); requestView(true); renderQuestion();
        toast('引っ越しました。新しい拠点から広げ直してください');
        break;
      case 'rekey':
        S.token = m.token; store.set('pc-token', m.token); $('codeInput').value = m.token; $('meCode').textContent = m.token;
        toast('復帰コードを新しくしました。控え直してください');
        break;
      case 'items': S.itemInfo = m; S.extraHomes = m.extraHomes || []; renderItems(); computeReach(); renderSelected(); break; // 持っているアイテム(2026-10-22)
      case 'itemUsed':
        if (m.kind === 'home') { S.placing = false; $('pickBar').hidden = true; centerOn(worldOf(m.home.lat, m.home.lon), 9); requestView(true); toast('本拠地を増やしました'); }
        else toast('守りを延ばしました');
        break;
      case 'myRoutes': S.mine = new Map((m.ports || []).map((o) => [o.id, o])); break; // 自分の空港・港の航路(2026-10-22: 航路は押さえた人にだけ届く)
      case 'nodes':
        for (const n of m.nodes) {
          if (n.status === 'gone') { S.nodes.delete(n.id); if (S.selected === n.id) S.selected = null; continue; }
          if (S.nodes.has(n.id) || S.tiles.has(n.t0)) S.nodes.set(n.id, n);
          rememberRoutes(n);
        }
        if (S.selected && S.selNb && m.nodes.some((n) => n.id === S.selected || S.selNb.list.some((x) => x.id === n.id))) refreshSiege(); // 囲みが変わったかもしれない(2026-10-21)
        computeReach();
        renderSelected();
        break;
      case 'players':
        S.offset = m.now - Date.now(); S.players = m.players; S.log = m.log || S.log; S.rankings = m.rankings || S.rankings; S.me2 = m.me || S.me2;
        if (S.me2 && S.me2.team !== (S.team && S.team.id)) { S.team = S.me2.team ? { id: S.me2.team, name: S.me2.teamName } : null; renderTeam(); if (S.team) { S.infoOnly = true; send({ t: 'team', action: 'info' }); } }
        renderPlayers(); renderSelected();
        break;
      case 'team': {
        S.team = m.team ? { id: m.team.id, name: m.team.name, max: m.team.maxMembers, count: m.team.memberCount, ownerId: m.team.ownerId, style: m.team.style, icon: m.team.icon } : null;
        renderTeam();
        if (S.styleSaving) { S.styleSaving = false; toast('チームの見た目を保存しました'); }
        else if (S.infoOnly) { S.infoOnly = false; }
        else toast(S.team ? `チーム「${S.team.name}」に所属しました` : 'チームを脱退しました');
        break;
      }
      case 'question': S.question = m; S.result = null; S.chosen = null; renderQuestion(); break;
      case 'result': S.result = m; S.cooldownUntil = m.cooldownUntil; if (m.cooldownMs) S.cooldownMs = m.cooldownMs; renderQuestion(); renderSelected(); break;
      case 'chat': onChat(m.msg); break;
      case 'chatHistory': { const key = chatKey(m.kind, m.to); S.chat.rooms.set(key, m.list || []); S.chat.loaded.add(key); S.chat.notes[key] = m.note || null; S.chat.canWrite[key] = !!m.canWrite; renderChat(true); break; }
      case 'teamMembers': S.chat.members = m.list || []; S.chat.membersAt = Date.now(); renderChat(); break;
      case 'chatPartners': S.chat.partners = m.list || []; renderChatTo(); break;
      case 'chatBlock': { const p = S.chat.partners.find((x) => x.id === m.id); if (p) p.blocked = m.on; else S.chat.partners.push({ id: m.id, name: (S.players.find((x) => x.id === m.id) || {}).name || m.id, blocked: m.on }); renderChatTo(); toast(m.on ? 'ブロックしました。この相手からは届きません' : 'ブロックを解きました'); break; }
      case 'chatReport': toast('通報しました。管理者が確認します'); break;
      case 'error':
        if (!S.joined) { $('lobbyError').textContent = m.message; S.wantJoin = false; setJoining(false); } else toast(m.message);
        break;
    }
  }

  // 受け取ったタイルを取り込み、見えなくなったタイルの拠点を捨てる
  function onTiles(m) {
    railCache = null; nbCache = null; adjCache = null; // 拠点とつながりが入れ替わるので、路線の隣どうし・囲みの隣を作り直す
    if (m.overview) {
      // 縮小表示: 送られてきた高レベルの拠点だけに入れ替える
      S.nodes.clear(); S.edges.clear(); S.far.clear(); S.tiles.clear(); S.overview = true; S.viewZ = m.z;
      for (const n of m.nodes) { S.nodes.set(n.id, n); rememberRoutes(n); } // 縮小表示にも自分の空港・港が届くので、航路の線を出せる
      S.regions = Array.isArray(m.regions) ? m.regions : [];
      pushRegions(); // 境界は背景の部品が読む。ここでは支配の色だけ渡す
      return;
    }
    if (S.overview) { S.nodes.clear(); S.edges.clear(); S.far.clear(); S.tiles.clear(); S.overview = false; S.regions = []; pushRegions(); }
    S.viewZ = 0;
    for (const t of m.dropped) {
      S.tiles.delete(t);
      for (const [id, n] of S.nodes) if (n.t0 === t && !(S.home && id === S.home.id)) { if (n.genre === 'station') S.far.set(id, n); S.nodes.delete(id); }
    }
    for (const t of m.added) S.tiles.add(t);
    for (const n of m.nodes) { S.nodes.set(n.id, n); rememberRoutes(n); }
    for (const e of m.edges) S.edges.set(e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`, e);
    for (const [k, e] of S.edges) if (!S.nodes.has(e.a) && !S.nodes.has(e.b)) S.edges.delete(k);
    for (const e of m.edges) if (e.far) S.far.set(e.far.id, e.far);
    { const used = new Set(); for (const e of S.edges.values()) { used.add(e.a); used.add(e.b); } for (const id of [...S.far.keys()]) if (S.nodes.has(id) || !used.has(id)) S.far.delete(id); } // 使わなくなった遠い隣は捨てる
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
  $('pickCancelBtn').onclick = () => { if (S.moving || S.placing) { S.moving = false; S.placing = false; $('pickBar').hidden = true; } else endPick(); };
  // アイテム(2026-10-22): 持っている数を「あなた」のダイアログに出す。本拠地を増やすときは地図で場所を選ぶ
  function renderItems() {
    const it = (S.itemInfo && S.itemInfo.items) || { home: 0, guard: 0 };
    $('itemHomeText').textContent = `本拠地を増やす: ${it.home} 個`;
    $('itemHomeBtn').disabled = !(it.home > 0);
    const g = S.itemInfo && S.itemInfo.guard;
    $('itemGuardText').textContent = `空港・港の守りを延ばす: ${it.guard} 個` + (g ? `(今日使った数 ${g.usedToday}/${g.daily})` : '');
  }
  $('itemHomeBtn').onclick = () => {
    if (!S.joined || !(S.itemInfo && S.itemInfo.items.home > 0)) return;
    if ($('meDialog').open) $('meDialog').close();
    S.placing = true; S.moving = false;
    $('pickBarText').textContent = '本拠地を増やす場所の町・字か、ふつうの駅をタップしてください(町・字は拡大すると出ます)';
    $('pickBar').hidden = false;
  };
  $('npGuardBtn').onclick = () => { if (S.selected) send({ t: 'item', action: 'useGuard', nodeId: S.selected }); };
  // 引っ越し: 地図で新しい開始地点を選ぶ(1 日 1 回)
  // 「あなた」は上の帯。復帰コード・引っ越しはダイアログで(2026-10-19)
  $('meMenuBtn').onclick = () => { const d = $('meDialog'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); };
  $('moveBtn').onclick = () => {
    if (!S.joined) return;
    if ($('meDialog').open) $('meDialog').close(); // 地図で選ぶのでダイアログは閉じる
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
    // チームが変わったら、チームのチャットを読み直す(チームはプレイヤーの一覧の知らせで先に変わることがあるので、ここで比べる)
    const tid = (S.team && S.team.id) || null;
    if (S.chat && S.chat.teamId !== tid) { S.chat.teamId = tid; S.chat.rooms.delete('team'); S.chat.loaded.delete('team'); if (S.chat.tab === 'team') chatOpen('team'); else renderChat(); }
    $('teamNone').hidden = !!S.team; $('teamMine').hidden = !S.team;
    // 上の帯のチームのボタン: 所属していればチームのアイコンと名前を、チームの色で
    const tb = $('teamBtn');
    tb.textContent = S.team ? `${S.team.icon || ''} ${S.team.name || 'チーム'}`.trim() : 'チーム';
    const ts = S.team && S.team.style;
    tb.style.color = ts ? ts.text : ''; tb.style.background = ts ? ts.fill : ''; tb.style.borderColor = ts ? ts.frame : '';
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
  // チームの作成・参加・見た目の変更はダイアログで(2026-10-20 ユーザー指摘)
  $('teamBtn').onclick = () => { renderTeam(); const d = $('teamDialog'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); };
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
  // 陸・海・区市の境界・湖は背景の部品(map-base.js)が読んで描く(2026-10-22 案 A。docs/MAP-ENGINE.md 第 7.3 節)。
  // ここでは届いた地域の支配者の色と、縮小表示かどうかだけを渡す(同じ中身なら渡し直さない)
  let regionKey = '';
  function pushRegions() {
    if (!mb || !mbReady) return; // 背景の用意ができたら、そのときの分をまとめて渡す
    const list = (S.regions || []).filter((g) => g.controller).map((g) => {
      const c = g.controller;
      return { id: g.id, fill: c.style ? c.style.fill : c.color, frame: c.style ? c.style.frame : c.color };
    });
    const key = `${S.overview ? 1 : 0}|${JSON.stringify(list)}`;
    if (key === regionKey) return;
    regionKey = key;
    mb.setOverview(!!S.overview);
    mb.setRegionControls(list);
  }

  // 海路の道すじ(2026-10-19): 海路は陸をまたがず海の上を通る曲線で描く(tools/build-sea-paths.js が書く)。キーは港の id(小さい順)
  S.seaPaths = new Map();
  fetch('data/sea-paths.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d || !d.paths) return;
    for (const [k, pts] of Object.entries(d.paths)) S.seaPaths.set(k, pts.map(([lat, lon]) => worldOf(lat, lon)));
  }).catch(() => { /* 無ければゆるい弧で描く */ });
  // 路線の線の形(2026-10-20 ユーザー指摘: 海沿いで電車の線が海の上を通っていた)。本当の線路の形(N02 を約 60 m で間引いたもの)。
  // キーは駅の id を小さい順に「|」でつないだもの、点は [経度, 緯度] で小さい方の駅から(両端の駅は含まない。[] はまっすぐ)
  S.railPaths = new Map();
  fetch('data/rail-paths.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d || !d.paths) return;
    for (const [k, pts] of Object.entries(d.paths)) S.railPaths.set(k, pts.map(([lon, lat]) => worldOf(lat, lon)));
  }).catch(() => { /* 無ければ前後の駅の向きから作る曲線で描く */ });
  // 新幹線の線(2026-10-21 ユーザー指摘: ドラッグすると途中で消える)。駅と駅の間が長く、両端の駅が読み込み範囲の外だと線を持てないので、
  // 全国の新幹線の線(約 100 本)を最初に読み、読み込み範囲に関係なくいつも描く(拠点を描く倍率のとき)
  S.shkEdges = []; S.shkKeys = new Set(); S.shkStations = new Map();
  fetch('data/shinkansen.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d || !d.edges) return;
    for (const [id, st] of Object.entries(d.stations || {})) S.shkStations.set(id, { id, genre: 'station', name: st.name, lat: st.lat, lon: st.lon, lines: st.lines || [] });
    S.shkEdges = d.edges; S.shkKeys = new Set(d.edges.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  }).catch(() => { /* 無ければ読み込み範囲の線だけ */ });

  // ---------- 投影: 固定の縮尺(経度・緯度 → 平面座標。1 単位 = 0.001°) ----------
  const LAT0 = 35.68; // 横方向の補正の基準(東京)。地図が世界に広がったらメルカトルに変える
  const KX = Math.cos((LAT0 * Math.PI) / 180);
  const worldOf = (lat, lon) => ({ x: lon * 1000 * KX, y: -lat * 1000 });
  const latLonOf = (x, y) => ({ lat: -y / 1000, lon: x / (1000 * KX) });
  const posOf = (n) => { if (!n._p) n._p = worldOf(n.lat, n.lon); return n._p; };

  // ---------- 路線の線(2026-10-20 ユーザー決定) ----------
  // 駅と駅の線は鉄道の地図記号のように、縁取りの中を白と黒の交互にする(新幹線は青緑と白)。乗り物の線は曲線:
  //   同じ路線の前後の駅を通るなめらかな曲線にする(各駅での向きは、反対側の隣の駅からこちらの隣の駅への向き)。分かれ道では、いちばんまっすぐ続く隣を使う
  //   両端の駅が同じ新幹線の路線を持つ線を新幹線とする(全国 101 本。どれも新幹線で隣り合う駅だった)
  const RAIL = { ink: '#2B2B2B', paper: '#FFFFFF', shinkansen: '#00897B' };
  const railNode = (id) => S.nodes.get(id) || S.far.get(id) || (S.shkStations && S.shkStations.get(id)); // 読み込んでいない遠い隣の駅・新幹線の駅も含める
  let railCache = null; // 駅 id → [{ id, lines }](路線でつながる隣の駅)。タイルが届くたびに作り直す
  // 囲み(2026-10-21 ユーザー決定)を地図に出すための、拠点 id → 隣の id(プレイヤーの拠点の線は数えない)。タイルが届くたびに作り直す
  let nbCache = null;
  const neighborsOf = (id) => {
    if (!nbCache) {
      nbCache = new Map();
      const push = (k, v) => { let arr = nbCache.get(k); if (!arr) nbCache.set(k, (arr = [])); arr.push(v); };
      for (const e of S.edges.values()) { const a = S.nodes.get(e.a), b = S.nodes.get(e.b); if ((a && a.isPlayerNode) || (b && b.isPlayerNode)) continue; push(e.a, e.b); push(e.b, e.a); }
    }
    return nbCache.get(id) || [];
  };
  // 突破に必要な回数 = つながりの本数 −(自分かチームが押さえている隣の数 − 1)。最低 1。選んだ拠点はサーバーが数えた値。
  // ほかは画面で数える(読み込み範囲の外の隣は、自分の拠点のほかは分からないので数えない)
  function needFor(n) {
    if (S.selNb && S.selNb.id === n.id && S.selNb.siege) return S.selNb.siege.need;
    const hits = n.hits || 1;
    const mineHere = S.mine.get(n.id);
    const ids = new Set([...neighborsOf(n.id), ...(mineHere ? mineHere.routes.map((x) => x.to) : []), ...[...S.mine.values()].filter((o) => o.routes.some((r) => r.to === n.id)).map((o) => o.id)]); // 航路の先は分かっている分だけ(航路は押さえた人にだけ届く)
    let held = 0;
    for (const id of ids) {
      if (S.mine.has(id)) { held++; continue; }
      const m = S.nodes.get(id) || S.far.get(id);
      if (m && !m.isPlayerNode && m.owner && (relOf(m) === 'me' || relOf(m) === 'team')) held++;
    }
    return Math.max(1, hits - Math.max(0, held - 1));
  }
  const commonLines = (a, b) => { const bl = b.lines || []; return (a.lines || []).filter((l) => bl.includes(l)); };
  function railLinesOf(na, nb) { // 2 つの駅を結ぶ路線(新幹線があれば新幹線だけ)。路線の線でなければ空
    if (na.genre !== 'station' || nb.genre !== 'station' || na.isPlayerNode || nb.isPlayerNode) return [];
    const ls = commonLines(na, nb);
    const shk = ls.filter((l) => l.includes('新幹線'));
    return shk.length ? shk : ls;
  }
  function railIndex() {
    if (railCache) return railCache;
    railCache = new Map();
    const push = (k, v) => { let arr = railCache.get(k); if (!arr) railCache.set(k, (arr = [])); arr.push(v); };
    for (const e of S.edges.values()) {
      const a = railNode(e.a), b = railNode(e.b);
      if (!a || !b) continue;
      const ls = railLinesOf(a, b);
      if (!ls.length) continue;
      push(a.id, { id: b.id, lines: ls }); push(b.id, { id: a.id, lines: ls });
    }
    return railCache;
  }
  function railTangent(na, nb, ls) { // na での線の向き(単位ベクトル)
    const pa = posOf(na), pb = posOf(nb);
    let dx = pb.x - pa.x, dy = pb.y - pa.y; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    let best = null, bestDot = -0.2; // 反対側(内積が小さい)にある同じ路線の隣だけを使う
    for (const m of railIndex().get(na.id) || []) {
      if (m.id === nb.id || !m.lines.some((l) => ls.includes(l))) continue;
      const c = railNode(m.id); if (!c) continue;
      const pc = posOf(c); let ux = pc.x - pa.x, uy = pc.y - pa.y; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      const dot = ux * dx + uy * dy;
      if (dot < bestDot) { bestDot = dot; best = { ux, uy }; }
    }
    if (!best) return { x: dx, y: dy };
    const tx = dx - best.ux, ty = dy - best.uy, tl = Math.hypot(tx, ty) || 1;
    return { x: tx / tl, y: ty / tl };
  }
  function railCurve(na, nb) { // 路線の線の形(画面座標)。本当の線路の形があればそれ(path)、無ければ 3 次ベジェ。路線の線でなければ null
    const ls = railLinesOf(na, nb);
    if (!ls.length) return null;
    const a = toScreen(posOf(na)), b = toScreen(posOf(nb));
    const key = na.id < nb.id ? `${na.id}|${nb.id}` : `${nb.id}|${na.id}`;
    const pts = S.railPaths && S.railPaths.get(key);
    if (pts) { const q = pts.map(toScreen); return { a, b, path: na.id < nb.id ? q : q.reverse(), shinkansen: ls[0].includes('新幹線') }; }
    const L = Math.hypot(b.x - a.x, b.y - a.y) / 3;
    const ta = railTangent(na, nb, ls), tb = railTangent(nb, na, ls);
    return { a, b, c1: { x: a.x + ta.x * L, y: a.y + ta.y * L }, c2: { x: b.x + tb.x * L, y: b.y + tb.y * L }, shinkansen: ls[0].includes('新幹線') };
  }
  // 路線の線の広がり(平面座標の [x0, y0, x1, y1])。画面の外の線を、形を作る前に飛ばすのに使う(2026-10-21: 全部の線を毎回描いていて重かった)。路線の線でなければ null
  const railBoxCache = new Map();
  function railBox(na, nb) {
    if (!railLinesOf(na, nb).length) return null;
    const key = na.id < nb.id ? `${na.id}|${nb.id}` : `${nb.id}|${na.id}`;
    const pts = S.railPaths && S.railPaths.get(key);
    const pa = posOf(na), pb = posOf(nb);
    const hit = railBoxCache.get(key);
    if (hit && hit.pts === pts && hit.ax === pa.x && hit.ay === pa.y && hit.bx === pb.x && hit.by === pb.y) return hit.box;
    let x0 = Math.min(pa.x, pb.x), y0 = Math.min(pa.y, pb.y), x1 = Math.max(pa.x, pb.x), y1 = Math.max(pa.y, pb.y);
    for (const q of pts || []) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
    const pad = pts ? 0 : Math.hypot(pb.x - pa.x, pb.y - pa.y) / 3; // 線路の形が無いときの曲線は、両端から 1/3 までふくらむ
    const box = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    railBoxCache.set(key, { pts, ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y, box });
    return box;
  }
  const railPath = (ctx, cv, begin = true) => { // begin = false: 今の線に足す(同じ色・太さの線を 1 回でまとめて描く)
    if (begin) ctx.beginPath();
    ctx.moveTo(cv.a.x, cv.a.y);
    if (!cv.path) { ctx.bezierCurveTo(cv.c1.x, cv.c1.y, cv.c2.x, cv.c2.y, cv.b.x, cv.b.y); return; }
    // 線路の点を、点と点の中ほどを通るなめらかな線でつなぐ(海路と同じ描き方)
    const q = [cv.a, ...cv.path, cv.b];
    for (let i = 1; i < q.length - 1; i++) ctx.quadraticCurveTo(q[i].x, q[i].y, (q[i].x + q[i + 1].x) / 2, (q[i].y + q[i + 1].y) / 2);
    ctx.lineTo(cv.b.x, cv.b.y);
  };

  // ---------- 地図: 拡大縮小と移動 ----------
  // 背景の地図(陸・海・区市の境界・湖・地域の支配の色)は MapLibre(public/map-base.js の PCMapBase)が描き、拡大縮小・ドラッグ・ピンチも任せる(2026-10-22 案 A。docs/MAP-ENGINE.md 第 7.3 節)。
  // この canvas はその上に重ねる層(pointer-events: none)で、線路・つながり・拠点・名前・航路・陣地・選択を今のまま描く。
  // 画面の位置は MapLibre の投影(Web メルカトル)で出す。平面座標(worldOf)は距離や向きの計算と、線の形の覚え方にだけ使う
  // 倍率の物差しは今のまま: BASE_K は「1 倍」(1° ≈ 1100 px)。今の倍率 ratio = 経度 1 度の px ÷(1000 × KX × BASE_K)
  const BASE_K = 1.1;
  // 地図の文字をくっきり(2026-10-20 ユーザー指摘: ぼやける)。表示倍率 125% などでは CSS の 1px が画面の点 1.25 個になるので、
  // 文字の大きさと置く位置を画面の点の単位にそろえる。文字のまわりは地の色で縁取る(線と重なっても読める)。名前は薄くても 6 割の濃さ
  const snapPx = (v) => { const d = window.devicePixelRatio || 1; return Math.round(v * d) / d; };
  const haloFor = (color) => { // 文字の色が明るければ暗い縁、暗ければ明るい縁
    const m = /^#([0-9a-f]{6})$/i.exec(String(color || '').trim()); if (!m) return '#FFFFFF';
    const v = parseInt(m[1], 16), lum = (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
    return lum > 0.6 ? '#0E141B' : '#FFFFFF';
  };
  const LABEL_MIN_ALPHA = 0.6;
  const LABEL_PLUS = 2; // 地図の文字(拠点と地域の名前)を 2px 大きく。いちばん小さい文字(プレイヤーの拠点の名前)が 12px になる(2026-10-20 ユーザー指摘: 小さくて見えない。最低 12px)
  const V = { w: 0, h: 0 }; // 地図の入れ物の大きさ(CSS px)
  // MapLibre の zoom と今の倍率の対応: 1 倍のときの zoom(MapLibre の世界は zoom 0 で 512 px)。最初の位置を決めるのにだけ使い、あとは今の zoom からの差で動かす
  const ZOOM_AT_RATIO1 = Math.log2((1000 * KX * BASE_K * 360) / 512);
  const ZOOM_STEP = Math.log2(1.4); // + / − ボタン 1 回で 1.4 倍(今までと同じ)
  const baseColors = () => {
    const css = getComputedStyle(document.documentElement), tok = (n) => css.getPropertyValue(n).trim();
    return { water: tok('--water') || '#D6ECFA', land: tok('--land') || '#F7F9FA', line: tok('--line') || '#CBD3DC', lineStrong: tok('--line-strong') || '#8A97A6', river: tok('--river') || '#9FCDEE' };
  };
  let mb = null, mbReady = false;
  try {
    mb = window.PCMapBase.create({ container: $('mapBase'), center: [TOKYO.lon, TOKYO.lat], zoom: ZOOM_AT_RATIO1 + Math.log2(9), minZoom: 4, maxZoom: 18, colors: baseColors() });
  } catch (e) {
    mb = null; // WebGL が使えない端末には対応しない(2026-10-22 ユーザー決定)。そのことだけ伝える
    $('lobbyError').textContent = window.PCMapBase ? 'この端末(ブラウザー)では地図を表示できません。WebGL が使える新しいブラウザーで開いてください' : '地図の部品を読み込めませんでした。ページを読み込み直してください';
  }
  if (mb) {
    // 地図は回さない・傾けない(今までの地図と同じ。画面の外の線を飛ばす計算も、地図が北を上にしている前提)。約束の外なので MapLibre を直接使う
    const m = mb.map;
    if (m) {
      if (m.dragRotate) m.dragRotate.disable();
      if (m.touchZoomRotate && m.touchZoomRotate.disableRotation) m.touchZoomRotate.disableRotation();
      if (m.touchPitch) m.touchPitch.disable();
      if (m.keyboard && m.keyboard.disableRotation) m.keyboard.disableRotation();
    }
    mb.ready.then(() => { mbReady = true; mb.setColors(baseColors()); regionKey = ''; pushRegions(); }).catch(() => { /* 背景が出なくても拠点は描く */ });
  }
  // 1 こまの間だけ使う値: 今の倍率(平面座標 1 単位が何 px か)と、速い投影。1 こまで線路の点など数万回投影するので、
  // こまの始めに MapLibre の投影から「経度はそのまま、緯度はメルカトルの式」の拡大と平行移動を出し、画面の隅の点で合っているか確かめてから使う(合わなければ毎回 mb.project)
  let kFrame = null, fastProj = null;
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  function beginFrame() {
    kFrame = mb.pxPerDegLon() / (1000 * KX); fastProj = null;
    const c = mb.unproject(V.w / 2, V.h / 2), a = mb.unproject(V.w * 0.9, V.h * 0.1), b = mb.unproject(V.w * 0.1, V.h * 0.9);
    const pc = mb.project(c.lon, c.lat), pa = mb.project(a.lon, a.lat), pb = mb.project(b.lon, b.lat);
    const m0 = mercY(c.lat), dl = a.lon - c.lon, dm = mercY(a.lat) - m0;
    if (!dl || !dm) return;
    const f = { lon0: c.lon, m0, x0: pc.x, y0: pc.y, sx: (pa.x - pc.x) / dl, sy: (pa.y - pc.y) / dm };
    if (Math.abs(f.x0 + (b.lon - f.lon0) * f.sx - pb.x) < 0.5 && Math.abs(f.y0 + (mercY(b.lat) - m0) * f.sy - pb.y) < 0.5) fastProj = f;
  }
  function endFrame() { kFrame = null; fastProj = null; }
  // 平面座標 → 画面(地図の入れ物の左上からの CSS px)。画面 → 平面座標
  const toScreen = (p) => {
    const lon = p.x / (1000 * KX), lat = -p.y / 1000;
    if (fastProj) return { x: fastProj.x0 + (lon - fastProj.lon0) * fastProj.sx, y: fastProj.y0 + (mercY(lat) - fastProj.m0) * fastProj.sy };
    const q = mb.project(lon, lat); return { x: q.x, y: q.y };
  };
  const toWorld = (sx, sy) => { const g = mb.unproject(sx, sy); return worldOf(g.lat, g.lon); };
  const pxPerUnit = () => kFrame || (mb ? mb.pxPerDegLon() / (1000 * KX) : BASE_K); // 平面座標 1 単位(0.001°)が何 px か(今までの V.k)
  const zoomRatio = () => pxPerUnit() / BASE_K;
  // 縮小するほど印を小さく。日本全体が見える倍率(段 3・4)では 0.2 倍まで(大きな印が細い陸地を覆い隠していた。2026-10-19)
  const shrink = () => { const r = zoomRatio(); return Math.min(1, Math.max(r < 0.18 ? 0.2 : 0.35, r / 6)); };
  const radiusOf = (n) => shrink() * (n.isPlayerNode ? 8
    : (11 + Math.min(10, n.level) * 0.6 + Math.min(9, Math.floor((n.level - 1) / 10)) * 0.4 + Math.min(9, Math.floor((n.level - 1) / 100)) * 0.8) * (n.genre === 'town' ? 0.7 : 1)); // 町・字は小さめ
  // 町・字(2026-10-18)は数が多いので、ある程度拡大したときだけ描く。自分の拠点・選択中・攻撃できるものは縮小していても描く
  const TOWN_MIN_RATIO = 10, TOWN_LABEL_RATIO = 14; // 町・字の印は拡大率 10 から、名前は 14 から(参加直後の 9 では駅と名所が主役)
  const visibleNode = (n) => n.genre !== 'town' || zoomRatio() >= TOWN_MIN_RATIO || n.id === S.selected || (n.owner && n.owner === S.me) || (relOf(n) === 'team' && ownShown('team')) || canAttack(n.id);

  function resize() {
    const box = $('mapWrap');
    // 地図は枠(画面の残りの高さ)いっぱい(2026-10-19: ページを縦に伸ばさない)。重ねる canvas も背景の地図と同じ大きさ
    const w = Math.max(200, box.clientWidth);
    const h = Math.max(200, box.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    V.w = w; V.h = h;
    if (mb && mb.map && mb.map.resize) mb.map.resize(); // 背景も今すぐ合わせる(見ている範囲をすぐ正しく頼むため。中心は MapLibre が保つ)
    requestView();
  }
  window.addEventListener('resize', resize);
  // 表示倍率だけが変わったとき(別の画面へウィンドウを動かしたなど)も、画面の点に合わせて描き直す(2026-10-20)
  const watchDpr = () => { if (!window.matchMedia) return; const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`); const on = () => { resize(); watchDpr(); }; if (mq.addEventListener) mq.addEventListener('change', on, { once: true }); };
  watchDpr();
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe($('mapWrap')); // 欄の開け閉めで枠の大きさが変わったときも
  // 凡例(レベルの形・持ち主・出典)はダイアログで出す(2026-10-19 ユーザー指摘)
  $('rankBtn').onclick = () => { renderPlayers(); const d = $('rankDialog'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }; // 順位はダイアログ(2026-10-21)
  $('legendBtn').onclick = () => { const d = $('legendDialog'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); };
  // 平面座標 p を真ん中に。ratio を渡せばその倍率に(MapLibre の zoom は今の zoom からの差で出す。最小・最大は MapLibre が守る)
  function centerOn(p, ratio) {
    if (!mb) return;
    const g = latLonOf(p.x, p.y);
    mb.jumpTo({ center: [g.lon, g.lat], zoom: ratio ? mb.getZoom() + Math.log2(ratio / zoomRatio()) : mb.getZoom() });
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
  $('zoomIn').onclick = () => { if (mb) mb.zoomBy(ZOOM_STEP); };
  $('zoomOut').onclick = () => { if (mb) mb.zoomBy(-ZOOM_STEP); };
  $('zoomHome').onclick = centerOnMine;

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
    if (!mb) return [];
    const b = mb.getBounds();
    const s = { lat: TILE_LAT * 4 ** z, lon: TILE_LON * 4 ** z };
    const minLat = Math.min(b.south, b.north), maxLat = Math.max(b.south, b.north), minLon = Math.min(b.west, b.east), maxLon = Math.max(b.west, b.east);
    const pad = z === 0 ? 1 : 0; // 細かい段は周囲 1 周も先読み
    const y0 = Math.floor(minLat / s.lat) - pad, y1 = Math.floor(maxLat / s.lat) + pad;
    const x0 = Math.floor(minLon / s.lon) - pad, x1 = Math.floor(maxLon / s.lon) + pad;
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`t${z}:${y}:${x}`);
    return out;
  }
  // 地図が止まって 150 ms で頼む。動かし続けている間も 0.5 秒に 1 回は頼む(MapLibre の move のたびに呼ばれる)
  let viewTimer = null, viewDue = 0, lastViewKey = '';
  function sendView(force) {
    if (!mb) return;
    let z = zoomTier();
    let tiles = tilesInView(z);
    while (tiles.length > 80 && z < 4) { z++; tiles = tilesInView(z); }
    const key = `${z}:${tiles.join(',')}`;
    if (!force && key === lastViewKey) return;
    lastViewKey = key;
    send({ t: 'view', z, tiles });
  }
  function requestView(force) {
    if (!S.joined && !S.picking) return;
    const t = performance.now();
    if (force) { clearTimeout(viewTimer); viewTimer = setTimeout(() => { viewTimer = null; sendView(true); }, 0); return; }
    if (!viewTimer) viewDue = t + 500;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { viewTimer = null; sendView(false); }, Math.max(0, Math.min(150, viewDue - t)));
  }
  if (mb) { mb.on('move', () => requestView()); mb.on('moveend', () => requestView()); }

  // ドラッグ・ピンチ・ホイールは MapLibre に任せる。動かさずに離したとき(タップ)だけ、背景の部品が click で知らせる
  if (mb) mb.on('click', (e) => tapAt({ x: e.x, y: e.y }));
  // 押せる拠点の上では指の形に(マウスだけ。ドラッグ中は MapLibre の手の形のまま)。カーソルは MapLibre の canvas に付けるので直接使う
  $('mapWrap').addEventListener('pointermove', (e) => {
    if (!mb || !mb.map || e.buttons || e.pointerType !== 'mouse') return;
    const r = canvas.getBoundingClientRect();
    const n = nodeAt({ x: e.clientX - r.left, y: e.clientY - r.top });
    mb.map.getCanvas().style.cursor = n && (canAttack(n.id) || ownerOf(n.id) === S.me) ? 'pointer' : '';
  });

  // 拠点を選ぶ: どの拠点でも情報パネルに出す。攻撃・強化できる拠点なら出題も求める
  function tapAt(pt) {
    const n = nodeAt(pt);
    if (S.placing) { // 本拠地を増やすアイテム(2026-10-22): 置く場所を選ぶ
      if (!n) return;
      if (!startableNode(n)) { toast(startRefusal(n).replace('始められません', '本拠地を置けません')); return; }
      if (window.confirm(`${n.name} のそばに本拠地を増やしますか?
アイテムを 1 個使います。増やした本拠地は引っ越しできません。`)) send({ t: 'item', action: 'useHome', startNodeId: n.id });
      return;
    }
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

  // 拠点 id → 線でつながる隣の id。タイルが届いたとき(線が変わるとき)だけ作り直す(2026-10-21: 毎回すべての線を調べていて、1 こまで 線の数 × 線の数 の計算になり、ドラッグがかくかくだった)
  let adjCache = null;
  function adjacent(id) {
    if (!adjCache) {
      adjCache = new Map();
      const push = (k, v) => { let arr = adjCache.get(k); if (!arr) adjCache.set(k, (arr = [])); arr.push(v); };
      for (const e of S.edges.values()) { push(e.a, e.b); push(e.b, e.a); }
    }
    return adjCache.get(id) || [];
  }
  // 自分の拠点から、見えている所有拠点を線でたどって届く拠点(表示用。判定はサーバー)
  function computeReach() {
    const set = new Set();
    const homes = [S.home && S.home.id, ...(S.extraHomes || [])].filter((id) => id && S.nodes.has(id)); // アイテムで足した本拠地からもたどる(2026-10-22)
    if (!homes.length) { S.reach = set; return; }
    const stack = [...homes]; for (const h of homes) set.add(h);
    while (stack.length) {
      const cur = stack.pop();
      for (const m of adjacent(cur)) if (!set.has(m) && ownerOf(m) === S.me) { set.add(m); stack.push(m); }
    }
    S.reach = set;
  }
  // 季節航路(2026-10-19): サーバーの時計で使える時間かどうか。サーバーが配信のときに判定した open を使い、時間の決まりで今を見直す
  // 開いている時間(航路と拠点で共通): 00:00-00:00 のように from と to が同じなら 1 日中
  const openNow = (hours) => {
    if (!hours || !hours.length) return true;
    const d = new Date(now()); const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return hours.some((h) => { const a = +h.from.slice(0, 2) * 60 + +h.from.slice(3), b = +h.to.slice(0, 2) * 60 + +h.to.slice(3); return a === b || (a < b ? m >= a && m < b : m >= a || m < b); });
  };
  const routeOpenNow = (r) => openNow(r.hours);
  const jstRange = (h) => { const f = (s) => { const x = (+s.slice(0, 2) + 9) % 24; return `${x}:${s.slice(3)}`; }; return `${f(h.from)}〜${f(h.to)}`; }; // UTC → 日本時間の表示
  // 航路を持つ自分の空港・港を覚える(占領が外れたら忘れる)
  function rememberRoutes(n) { // 航路そのものはサーバーの myRoutes で届く。ここでは奪われた空港・港を忘れるだけ
    if (n.owner !== S.me) S.mine.delete(n.id);
  }
  // サーバーの canAttack と同じ条件(表示用。判定はサーバーが行う)
  // ---------- チャット(2026-10-21 ユーザー決定) ----------
  // 全体・チーム・個別。全体は本登録の人だけ書ける(今は準備中)。チームは仲間。個別は誰でも(ブロックできる)。500 字、2 秒に 1 回、7 日残す
  const chatKey = (kind, to) => (kind === 'dm' ? `dm:${to || ''}` : kind);
  const curKey = () => chatKey(S.chat.tab, S.chat.to);
  function chatOpen(kind, to) {
    if (kind === 'members') { S.chat.tab = 'members'; if (S.team) send({ t: 'team', action: 'members' }); renderChat(true); return; } // チーム内の順位(2026-10-21)
    S.chat.tab = kind; if (kind === 'dm' && to !== undefined) S.chat.to = to || null;
    S.chat.unread[kind] = false;
    const key = curKey();
    if ((kind !== 'dm' || S.chat.to) && !S.chat.loaded.has(key)) send({ t: 'chat', action: 'history', kind, to: kind === 'dm' ? S.chat.to : undefined });
    renderChat(true);
  }
  function onChat(msg) {
    const other = msg.kind === 'dm' ? (msg.from === S.me ? msg.to : msg.from) : null;
    const key = chatKey(msg.kind, other);
    const list = S.chat.rooms.get(key) || []; list.push(msg); if (list.length > 200) list.shift(); S.chat.rooms.set(key, list);
    if (msg.kind === 'dm' && !S.chat.partners.some((p) => p.id === other)) { S.chat.partners.push({ id: other, name: msg.from === S.me ? ((S.players.find((x) => x.id === other) || {}).name || other) : msg.fromName, blocked: false }); renderChatTo(); }
    if (key !== curKey() && msg.from !== S.me) S.chat.unread[msg.kind] = true;
    renderChat(key === curKey());
  }
  function renderChatTo() {
    const sel = $('chatTo'); const cur = S.chat.to;
    const opts = [new Option('相手を選ぶ(順位の表の名前を押しても始められます)', '')];
    for (const p of S.chat.partners) opts.push(new Option(`${p.name}${p.blocked ? '(ブロック中)' : ''}`, p.id));
    sel.replaceChildren(...opts); sel.value = cur || '';
    const p = S.chat.partners.find((x) => x.id === cur);
    $('chatBlock').hidden = !cur; $('chatBlock').textContent = p && p.blocked ? 'ブロックを解く' : 'ブロック';
  }
  function renderChat(scroll) {
    for (const b of document.querySelectorAll('.chat-tabs button')) { const k = b.dataset.kind; b.setAttribute('aria-selected', String(k === S.chat.tab)); const u = b.querySelector('.chat-unread'); if (u) u.hidden = !S.chat.unread[k]; }
    $('chatDm').hidden = S.chat.tab !== 'dm'; if (S.chat.tab === 'dm') renderChatTo();
    $('chatForm').hidden = S.chat.tab === 'members';
    if (S.chat.tab === 'members') { // チームの仲間を点数の多い順に。最後に来た日も
      const ul = $('chatList');
      const ago = (t) => { if (!t) return ''; const d = Math.floor((Date.now() - t) / 86400000); return d <= 0 ? '今日' : `${d} 日前`; };
      ul.replaceChildren(...(S.chat.members || []).map((p, i) => { const li = document.createElement('li'); li.className = 'member'; li.textContent = `${i + 1}. ${p.name}${p.id === S.me ? '(あなた)' : ''}  ${p.score}点・${p.nodes}拠点  ${p.online ? '接続中' : `最後に来た日: ${ago(p.lastSeen)}`}`; return li; }));
      const note = !S.team ? 'チームに入ると、仲間の順位が出ます' : !(S.chat.members || []).length ? '読み込み中…' : null;
      $('chatNote').hidden = !note; $('chatNote').textContent = note || '';
      return;
    }
    const key = curKey();
    const list = S.chat.tab === 'dm' && !S.chat.to ? [] : (S.chat.rooms.get(key) || []);
    const ul = $('chatList'); const atBottom = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
    ul.replaceChildren(...list.map((m) => {
      const li = document.createElement('li');
      const t = document.createElement('time'); const d = new Date(m.at); t.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const who = document.createElement('span'); who.className = 'who' + (m.from === S.me ? ' me' : ''); who.textContent = m.from === S.me ? 'あなた' : m.fromName;
      const tx = document.createElement('span'); tx.textContent = m.text;
      li.append(t, who, tx);
      if (m.from !== S.me) { const rp = document.createElement('button'); rp.type = 'button'; rp.className = 'report'; rp.title = '通報する'; rp.textContent = '⚑'; rp.onclick = () => { if (confirm(`${m.fromName} さんの書き込みを通報しますか?`)) send({ t: 'chat', action: 'report', room: m.room, id: m.id }); }; li.append(rp); }
      return li;
    }));
    if (scroll || atBottom) ul.scrollTop = ul.scrollHeight;
    let note = S.chat.tab === 'dm' && !S.chat.to ? '相手を選ぶと個別に話せます' : S.chat.tab === 'team' && !S.team ? 'チームに入ると使えます' : S.chat.notes[key] || null;
    if (!note && S.chat.loaded.has(key) && !list.length) note = 'まだ書き込みはありません(7 日より前のものは消えます)';
    $('chatNote').hidden = !note; $('chatNote').textContent = note || '';
    const canWrite = S.chat.tab === 'dm' ? !!S.chat.to : S.chat.tab === 'team' ? !!S.team : !!S.chat.canWrite[key];
    $('chatInput').disabled = !canWrite; $('chatSend').disabled = !canWrite;
  }
  for (const b of document.querySelectorAll('.chat-tabs button')) b.onclick = () => chatOpen(b.dataset.kind);
  $('chatTo').onchange = () => chatOpen('dm', $('chatTo').value || null);
  $('chatBlock').onclick = () => { const p = S.chat.partners.find((x) => x.id === S.chat.to); send({ t: 'chat', action: 'block', id: S.chat.to, on: !(p && p.blocked) }); };
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim(); if (!text) return;
    send({ t: 'chat', action: 'post', kind: S.chat.tab, to: S.chat.tab === 'dm' ? S.chat.to : undefined, text });
    $('chatInput').value = '';
  };
  // 順位の表の名前を押すと、その人と個別に話す
  $('scores').addEventListener('click', (e) => { const li = e.target.closest('li[data-pid]'); if (!li || li.dataset.pid === S.me) return; const p = S.players.find((x) => x.id === li.dataset.pid) || {}; if (!S.chat.partners.some((x) => x.id === li.dataset.pid)) S.chat.partners.push({ id: li.dataset.pid, name: p.name || li.dataset.pid, blocked: false }); const rd = $('rankDialog'); if (rd.open) rd.close(); chatOpen('dm', li.dataset.pid); });

  let siegeTimer = null;
  function refreshSiege() { // まとめて 1 回だけ聞き直す
    if (siegeTimer) return;
    siegeTimer = setTimeout(() => { siegeTimer = null; if (S.selected) send({ t: 'neighbors', nodeId: S.selected }); }, 400);
  }
  function canAttack(id) {
    const n = nodeById(id);
    if (!n || !S.me || n.owner === S.me) return false;
    if (n.hackable === false) return false;
    if (!openNow(n.hours)) return false; // 開いている時間の外
    if (n.isPlayerNode) return false; // プレイヤー自身の拠点は占領禁止
    if (n.protectedUntil > now()) return false;
    if (n.ownerIsTeam && S.team && n.owner === S.team.id) return false; // 自分のチームの持ち物(2026-10-20)
    if (n.owner && !n.ownerIsTeam) { const o = playerById(n.owner); if (o && o.nodes <= 3 && o.newbie) return false; }
    if (adjacent(id).some((a) => ownerOf(a) === S.me && S.reach.has(a))) return true;
    // 航路の先: 自分が占領している空港・港から航路がある(画面の外の空港でもよい。最終の判定はサーバー)
    for (const o of S.mine.values()) if (o.routes.some((r) => r.to === id && routeOpenNow(r)) && (S.reach.has(o.id) || !S.nodes.has(o.id))) return true;
    return false;
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
    const row = (i, color, name, sub, right, dim, pid) => {
      const li = document.createElement('li');
      if (dim) li.className = 'offline';
      if (pid && pid !== S.me) { li.dataset.pid = pid; li.classList.add('can-dm'); li.title = '押すと個別のチャット'; }
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
      items = list.slice(0, 15).map((p, i) => row(i, p.color, p.name, p.id === S.me ? 'あなた' : (p.teamName ? p.teamName : `${p.nodes}拠点`), val(p), !p.online, p.id));
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
    $('npKana').textContent = n.kana || ''; $('npKana').hidden = !n.kana; // 読み(2026-10-21 ユーザー決定: 漢字が難しくて読めない。地図には出さない)
    // 観光地は細分(温泉・滝 …)を添える(tags の先頭。続けて指定・百選)
    const genreLabel = (GENRE_LABELS[n.genre] || '') + (n.genre === 'tourism' && n.tags && n.tags[0] ? `(${n.tags[0]})` : '');
    $('npMeta').textContent = [n.isPlayerNode ? 'プレイヤーの拠点' : genreLabel, n.tags && n.tags.length > 1 ? n.tags.slice(1).join('・') : '', n.area || ''].filter(Boolean).join(' ・ ');
    $('npLevel').textContent = `Lv${n.level}${n.defense ? `(+${n.defense} 強化 → 出題 Lv${n.level + n.defense})` : ''}` + (!n.isPlayerNode && n.hackable !== false && !hasQuestion(attackLevelOf(n)) ? '(このレベルの問題は準備中。まだ占領できません)' : '');
    $('npValue').textContent = `${n.value}点`;
    if (n.hours) $('npValue').textContent += `(開いている時間: 毎日 ${n.hours.map(jstRange).join('・')} 日本時間)`; // 1 日中ではない拠点だけ
    $('npCompany').hidden = $('npCompanyLabel').hidden = !n.company;
    if (n.company) $('npCompany').textContent = `${n.company}(命名権など。ハック不可)`;
    $('npOwner').textContent = n.ownerIsTeam ? `チーム「${n.ownerTeamName || '?'}」の持ち物${S.team && S.team.id === n.owner ? '(あなたのチーム)' : ''}` // チームを抜けた人が取った拠点はチームの持ち物(2026-10-20)
      : owner ? `${owner.name}${owner.id === S.me ? '(あなた)' : ''}` : (n.owner ? '他のプレイヤー' : '中立');
    // 突破に必要な回数 = つながりの本数。自分(チーム)の進捗と、他の攻め手の最大進捗
    // 囲み(2026-10-21 ユーザー決定): つながりの本数 −(自分かチームが押さえている隣の数 − 1)。最低 1。数はサーバーが選んだときに返す
    const sg = S.selNb && S.selNb.id === n.id && S.selNb.siege ? S.selNb.siege : null;
    const base = n.hits || 1, hits = n.owner === S.me || !sg ? base : sg.need, prog = n.progress || {};
    const myKey = S.team ? S.team.id : S.me;
    const mine = prog[myKey] || 0;
    const others = Object.entries(prog).filter(([k]) => k !== myKey).map(([, v]) => v);
    const parts = [`正解 ${hits} 回(つながり ${base} 本${hits < base ? `、囲み ${sg.held} 本で −${base - hits}` : ''})`];
    if (n.hackable === false) parts.length = 0, parts.push('ハック不可');
    else if (n.owner === S.me) { if (others.length) parts.push(`侵入されています: 最大 ${Math.max(...others)}/${hits}`); }
    else { if (mine) parts.push(`${S.team ? 'チーム' : 'あなた'} ${mine}/${hits}`); if (others.length) parts.push(`他の攻め手 最大 ${Math.max(...others)} 回正解`); } // ほかの攻め手の必要な回数は囲みで人ごとに違う
    $('npHits').textContent = parts.join(' ・ ');
    const lines = Array.isArray(n.lines) ? n.lines : [];
    $('npLines').hidden = !lines.length;
    $('npLinesList').replaceChildren(...lines.map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
    const routes = routesOfSelected(n); // 押さえていない空港・港の行き先は出さない(サーバーも教えない)
    $('npRoutes').hidden = !routes.length;
    $('npRoutesList').replaceChildren(...routes.map((r) => {
      const li = document.createElement('li'); li.tabIndex = 0;
      li.textContent = `${r.mode === 'air' ? '✈ 空路' : '⚓ 海路'} → ${r.name}` + (r.hours ? `(${r.phantom ? '幻の航路' : '季節航路'}: 毎日 ${r.hours.map(jstRange).join('・')} 日本時間${routeOpenNow(r) ? '' : '。いまは運航時間外'})` : ''); // 幻の航路は 1 日 20 分だけ(2026-10-20)
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
    else if (n.hours && !openNow(n.hours) && n.owner !== S.me) status = `いまは閉じています(開いている時間: 毎日 ${n.hours.map(jstRange).join('・')} 日本時間)`;
    else if (n.protectedUntil > now() && (n.genre === 'airport' || n.genre === 'port')) status = `占領されたばかりで守られています(あと ${Math.ceil((n.protectedUntil - now()) / 60000)} 分)`; // 空港・港は占領から 5 分
    else if (n.protectedUntil > now()) status = `生まれたばかりで守られています(あと ${Math.ceil((n.protectedUntil - now()) / 3600000)} 時間)`;
    else if (n.owner && (playerById(n.owner) || {}).nodes <= 3 && (playerById(n.owner) || {}).newbie) status = '始めたばかりで拠点が少ないプレイヤーは守られています';
    else if (canAttack(n.id)) status = `タップすると攻撃の問題が出ます(突破まで あと ${Math.max(1, hits - mine)} 回)`;
    else if (adjacent(n.id).some((a) => ownerOf(a) === S.me)) status = '隣の所有拠点は自分の拠点から線がつながっていないため、ここからは広げられません(つなぎ直すと攻撃できます)';
    else status = '自分の拠点とつながっていないため、まだ攻撃できません';
    $('npStatus').textContent = status;
    { // 守りを延ばすアイテム(2026-10-22): 自分の空港・港で、守りの途中だけ
      const it = S.itemInfo, guarding = n.owner === S.me && !n.ownerIsTeam && (n.genre === 'airport' || n.genre === 'port') && n.protectedUntil > now();
      $('npGuard').hidden = !guarding;
      if (guarding) {
        const have = it ? it.items.guard : 0, used = it ? it.guard.usedToday : 0, daily = it ? it.guard.daily : 5;
        $('npGuardBtn').disabled = !(have > 0) || used >= daily;
        $('npGuardNote').textContent = `あと ${Math.ceil((n.protectedUntil - now()) / 60000)} 分守られています。アイテム ${have} 個(今日 ${used}/${daily})`;
      }
    }
  }

  // ---------- 描画: 問題 ----------
  // ---------- 問題のダイアログ(2026-10-20 ユーザー指摘) ----------
  // 入れ物は 1 つ。見出し・問題文・表・結果・解説は共通で、答えの欄だけを答え方(answerKind)ごとに描き分ける。
  // 新しい答え方(フェーズ 3 のコマンド入力 command / 設定 config など)は ANSWER_VIEWS に描き方を足し、QUESTION_SIZE で大きさを決める
  const ANSWER_VIEWS = {
    choice: { size: () => 'normal' },
    text: { size: (q) => (q.fields || []).some((f) => f.format === 'prefixplan') || (q.fields || []).length > 4 ? 'wide' : 'normal' },
  };
  const QUESTION_SIZE = (q) => {
    const v = ANSWER_VIEWS[q.answerKind || 'choice'];
    const tables = Array.isArray(q.tables) && q.tables.length ? q.tables : (q.table ? [q.table] : []);
    const wideTable = tables.length > 1 || tables.some((t) => (t.headers || []).length > 4);
    return v ? (wideTable && v.size(q) === 'normal' ? 'wide' : v.size(q)) : 'full';
  };
  let qClosing = false;
  function openQuestionDialog(q) {
    const d = $('qDialog');
    d.dataset.size = QUESTION_SIZE(q);
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  }
  function closeQuestionDialog() { const d = $('qDialog'); if (d.open) { qClosing = true; d.close(); qClosing = false; } }
  // 閉じる(Esc・閉じるボタン)と、出ていた問題もやめる(選択の解除と同じ扱い)。もう一度拠点を押せば新しい問題が出る
  $('qDialog').addEventListener('close', () => { if (qClosing) return; S.question = null; S.result = null; S.chosen = null; renderQuestion(); });
  $('qClose').onclick = () => $('qDialog').close();
  // 続けて解く: 同じ拠点の次の問題を求める(突破には何回か正解が要るため)。できるかどうかはサーバーが決める
  $('qNext').onclick = () => {
    const q = S.question; if (!q) return;
    if (now() < S.cooldownUntil) { toast('不正解のため通信が止まっています'); return; }
    const n = nodeById(q.nodeId);
    if (q.mode === 'attack' && n && n.owner === S.me) { toast(`${n.name} はもうあなたの拠点です`); $('qDialog').close(); return; } // 占領し終えたら続きは無い
    send({ t: 'ask', nodeId: q.nodeId });
  };
  function renderQuestion() {
    const q = S.question;
    if (!q) { closeQuestionDialog(); return; }
    openQuestionDialog(q);
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
    const known = !q.answerKind || !!ANSWER_VIEWS[q.answerKind];
    $('qOptions').hidden = isText || !known; $('qFields').hidden = !isText;
    if (!known) { const p = document.createElement('p'); p.className = 'unsupported'; p.textContent = 'この形の問題は、まだ画面が対応していません'; $('qTables').append(p); }
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
    $('qNext').hidden = !r; // 答えたあと、同じ拠点の次の問題へ
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
    if (mb && mbReady) mb.setColors(baseColors()); // 背景の地図の色もダークモードに合わせる
  });

  // ---------- 描画: 地図 ----------
  // 重ねる層は、MapLibre が背景を描くたび(render)に同じこまの中で描き直す(地図と拠点がずれないように)。
  // 地図が止まっている間は、攻撃できる拠点の点滅などのために、こまごと(requestAnimationFrame)に描く
  let lastBaseDraw = -1e9;
  function frame(t) {
    requestAnimationFrame(frame);
    tickUi();
    if (t - lastBaseDraw < 50) return; // 背景が描き続けている間は、そちらの render で描く(1 こまで 2 回描かない)
    draw(t);
  }
  if (mb) mb.on('render', () => { const t = performance.now(); lastBaseDraw = t; draw(t); });
  function draw(t) {
    if (!mb || !V.w) return;
    beginFrame();
    try { drawLayer(t); } finally { endFrame(); }
  }
  function drawLayer(t) {
    const css = getComputedStyle(document.documentElement);
    const tok = (n) => css.getPropertyValue(n).trim();
    const C = { surface: tok('--surface'), ink: tok('--ink'), muted: tok('--muted'), line: tok('--line'), strong: tok('--line-strong'), accent: tok('--accent') };
    ctx.clearRect(0, 0, V.w, V.h);
    if (!S.joined && !S.picking) return;
    const ratio = zoomRatio();
    const grow = V.w < 600 ? 1.15 : 1;

    // 海・陸・区市の境界・湖・地域の支配の色は背景の部品(MapLibre)が下に描く(2026-10-22 案 A)。ここからは重ねる層

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
      // 押さえている空港・港でも、いつも出すのではなく選んだときだけ出す(2026-10-22 ユーザー決定: 航路は長いので地図の邪魔になる)
      // 選んだ空港・港の航路は、その拠点が画面の外に出て読み込みから外れても出し続ける(selectedNode が覚えている)
      const sel = selectedNode();
      if (sel) for (const r of routesOfSelected(sel)) add(sel, r, 'one'); // 押さえていない空港・港を選んでも航路は出さない(2026-10-22)。行き先も押さえていれば太い実線
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
    // 色はチームならチームの背景色、チームに入っていなければその人の色(2026-10-20 ユーザー決定)
    {
      const hr = Math.max(16, Math.min(70, 10 + ratio * 1.6)) * grow;
      for (const n of S.nodes.values()) {
        const rel = relOf(n);
        if (!ownShown(rel) || n.isPlayerNode || !visibleNode(n)) continue;
        const col = (ownerStyleOf(n) || {}).fill || ownerColorOf(n);
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

    // 線路(リンク)。路線の線(駅と駅)は後でまとめて、鉄道の地図記号のように描く
    ctx.lineCap = 'round';
    const lineScale = Math.min(1, Math.max(0.4, ratio / 4));
    const rails = [];
    // 画面の外(少し余白を取る)の線は描かない。同じ色・太さ・濃さの線は 1 本の線にまとめて 1 回で描く(2026-10-21 ユーザー指摘: ドラッグがかくかく。1 こまで 2,000 回以上描いていた)
    const vlo = toWorld(-40, -40), vhi = toWorld(V.w + 40, V.h + 40);
    const offView = (b) => b[2] < vlo.x || b[0] > vhi.x || b[3] < vlo.y || b[1] > vhi.y;
    const lineGroups = new Map(); // '色|太さ|濃さ' → [[a, b], …]
    for (const e of S.edges.values()) {
      if (S.shkKeys.has(e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`)) continue; // 新幹線の線は下でまとめて描く
      const na = railNode(e.a), nb = railNode(e.b);
      if (!na || !nb || !visibleNode(na) || !visibleNode(nb)) continue; // 描かない町・字への線も描かない
      const own = na.owner && na.owner === nb.owner && ownShown(relOf(na)) ? ((ownerStyleOf(na) || {}).frame || ownerColorOf(na)) : null; // チームの線は枠の色
      const ef = Math.min(fadeOf(na), fadeOf(nb)); // 線も、両端の薄い方に合わせて薄く
      const rb = railBox(na, nb);
      if (rb) { // 電車の線は駅が薄くても濃く描く(2026-10-21 ユーザー: 一定の倍率では常に出す。拠点を描く倍率 2.5 倍以上で出る)
        if (offView(rb)) continue;
        const cv = railCurve(na, nb);
        if (cv) rails.push({ cv, own, ef: 1 });
        continue;
      }
      if (!S.nodes.has(na.id) || !S.nodes.has(nb.id)) continue; // 読み込んでいない遠い隣へは、路線の線だけ伸ばす
      const pa = posOf(na), pb = posOf(nb);
      if (offView([Math.min(pa.x, pb.x), Math.min(pa.y, pb.y), Math.max(pa.x, pb.x), Math.max(pa.y, pb.y)])) continue;
      const a = toScreen(pa), b = toScreen(pb);
      const thin = na.isPlayerNode || nb.isPlayerNode;
      const town = na.genre === 'town' || nb.genre === 'town'; // 町・字の線は細く薄く(路線の線を主役にする)
      const gk = `${own || C.line}|${(own ? (thin || town ? 4 : 7) : (thin ? 2.5 : town ? 1.5 : 4)) * lineScale}|${Math.round((town && !own ? 0.55 : 1) * ef * 20) / 20}`; // 濃さは 20 段に丸めてまとめやすく
      if (!lineGroups.has(gk)) lineGroups.set(gk, []);
      lineGroups.get(gk).push([a, b]);
    }
    for (const [gk, segs] of lineGroups) {
      const [col, w, al] = gk.split('|');
      ctx.strokeStyle = col; ctx.lineWidth = Number(w); ctx.globalAlpha = Number(al);
      ctx.beginPath();
      for (const [a, b] of segs) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 新幹線の線: 読み込み範囲に関係なく、画面にかかるものを描く(持ち主の色は、読み込んでいる駅の分だけ分かる)
    if (!S.overview) for (const [a, b] of S.shkEdges) {
      const na = railNode(a), nb = railNode(b);
      if (!na || !nb) continue;
      const rb = railBox(na, nb);
      if (!rb || offView(rb)) continue; // 画面にかからない
      const cv = railCurve(na, nb);
      if (!cv) continue;
      const own = na.owner && na.owner === nb.owner && ownShown(relOf(na)) ? ((ownerStyleOf(na) || {}).frame || ownerColorOf(na)) : null;
      rails.push({ cv, own, ef: 1 });
    }
    if (rails.length) {
      // 縁取り → 中の白 → 交互の色、の順に全部の線へ重ねる(交わるところもきれいに見える)。
      // 占領した路線(両端が同じ持ち主)は記号の形のまま、黒(新幹線は青緑)の部分を持ち主の色にして少し太く(2026-10-20 ユーザー決定。チームならチームの枠の色)
      const W = Math.max(3, 6 * lineScale), inner = Math.max(1.4, W - 2.2), dash = Math.max(4, W * 2.2);
      const Wo = W * 1.4, innerO = Math.max(1.4, Wo - 3);
      ctx.save(); ctx.lineCap = 'butt';
      for (const pass of [0, 1, 2]) {
        ctx.setLineDash(pass === 2 ? [dash, dash] : []);
        const groups = new Map(); // 同じ色・太さ・濃さの線は 1 回で描く(破線の模様は線ごとに始まるので見た目は同じ)
        for (const r of rails) {
          const col = r.own || (r.cv.shinkansen ? RAIL.shinkansen : RAIL.ink);
          const gk = `${pass === 1 ? RAIL.paper : col}|${r.own ? (pass === 0 ? Wo : innerO) : (pass === 0 ? W : inner)}|${r.ef}`;
          if (!groups.has(gk)) groups.set(gk, []);
          groups.get(gk).push(r);
        }
        for (const [gk, list] of groups) {
          const [col, w, al] = gk.split('|');
          ctx.strokeStyle = col; ctx.lineWidth = Number(w); ctx.globalAlpha = Number(al);
          ctx.beginPath();
          for (const r of list) railPath(ctx, r.cv, false);
          ctx.stroke();
        }
      }
      ctx.restore();
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
          if (m.route) { if (!S.drawn || !S.drawn.has(m.id)) { ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2); ctx.fill(); } continue; } // 空路・海路の先は航路の線があるので黒い直線は引かない(2026-10-21 ユーザー指摘)
          const cv = railNode(m.id) ? railCurve(sel, railNode(m.id)) : null; // 路線の線は同じ曲線でなぞる
          if (cv) railPath(ctx, cv); else { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
          ctx.stroke();
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
      // ます目は地図に固定する(画面に固定するとドラッグのたびに残る拠点が入れ替わり、ちらついた。2026-10-19 ユーザー指摘)
      const cell = 34 * grow, cw = cell / pxPerUnit(), best = new Map();
      for (const n of sorted) {
        const p = toScreen(posOf(n));
        if (p.x < -60 || p.y < -60 || p.x > V.w + 60 || p.y > V.h + 60) continue;
        const w = posOf(n); const k = `${Math.floor(w.x / cw)}:${Math.floor(w.y / cw)}`;
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
      const ring = n.isPlayerNode || (S.overview && S.viewZ >= 3) ? r : SH.outerRadius(n.level, r);
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
      // 印の色(2026-10-19 ユーザー指摘): チームの拠点は 線 = 枠の色、中 = 背景色(塗りつぶしのレベルは枠の色)。チームに入っていない人は 線 = その人の色、中 = 白。自分の拠点は真ん中に点
      const tst = owner ? ownerStyleOf(n) : null;
      const lineCol = tst ? tst.frame : col, bgCol = tst ? (tst.fill || C.surface) : C.surface;
      ctx.fillStyle = filled ? lineCol : bgCol; ctx.strokeStyle = lineCol;
      ctx.lineWidth = tst ? 5 : owner ? (n.isPlayerNode ? 5 : 7) : (n.isPlayerNode ? 3 : 4); // チームは中の背景色が見えるよう少し細く
      shape(n, p, r); ctx.fill(); ctx.stroke();
      // 外輪・外枠・札は、日本全体が見える倍率(段 3・4)では描かない(輪の間隔は縮まないので、細い陸地を覆い隠していた。2026-10-19)
      const farView = S.overview && S.viewZ >= 3;
      if (!n.isPlayerNode && !farView) SH.extras(ctx, n.level, p, r, lineCol, bgCol);
      if (owner && n.owner === S.me) { ctx.fillStyle = filled ? bgCol : lineCol; ctx.beginPath(); ctx.arc(p.x, p.y, n.isPlayerNode ? 3 : 4, 0, Math.PI * 2); ctx.fill(); }
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
        const fs = (n.kind === 'IX' ? 14 : n.isPlayerNode ? 10 : 11.5) + LABEL_PLUS;
        const font = `${n.isPlayerNode ? 500 : 700} ${snapPx(fs * grow)}px "BIZ UDPGothic", sans-serif`;
        ctx.font = font;
        const tx = snapPx(p.x), ty = snapPx(p.y + top + (12 + LABEL_PLUS) * grow), tw = ctx.measureText(n.name).width, th = snapPx(fs * grow);
        // 突破に必要な回数を名前の右上に小さく(2026-10-21 ユーザー決定)。自分・チームの拠点、プレイヤーの拠点、ハックできない場所には出さない。囲みで減っていれば色を変える
        const rel = relOf(n);
        const need = !n.isPlayerNode && n.hackable !== false && rel !== 'me' && rel !== 'team' ? needFor(n) : null;
        const needFont = `700 ${snapPx(12)}px "BIZ UDPGothic", sans-serif`;
        let nw = 0; if (need !== null) { ctx.font = needFont; nw = ctx.measureText(String(need)).width + 2; ctx.font = font; }
        // 名前の優先: 選択中・自分の拠点は必ず。ほかはレベルが高いほど先に置く(縮小時の区・市の名前は Lv8 前後と同じ扱い)
        const lp = isSel ? 1e6 : (n.owner && n.owner === S.me) ? 9e5 : 150 + n.level * 20 + (n.kind === 'GW' ? 15 : 0);
        labels.push({ prio: lp, must: isSel || (n.owner && n.owner === S.me), box: [tx - tw / 2 - 3, ty - th, tw + 6 + nw, th + 5], draw: () => {
          ctx.textAlign = 'center'; ctx.font = font;
          if (isSel) {
            const w = tw + 10, h = th + 6;
            ctx.fillStyle = C.surface; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(snapPx(tx - w / 2), ty - h + 4, w, h, 4); else ctx.rect(snapPx(tx - w / 2), ty - h + 4, w, h);
            ctx.fill(); ctx.stroke();
          }
          const color = tst && tst.text && !isSel ? tst.text : n.isPlayerNode && !isSel ? C.muted : C.ink; // チームの拠点の名前はチームの文字の色
          if (!isSel) { // 縁取りは濃いまま(文字だけ薄くすると線が透けるので)
            ctx.globalAlpha = dim ? 0.5 : 1; ctx.lineJoin = 'round'; ctx.lineWidth = 3.5; ctx.strokeStyle = haloFor(color); ctx.strokeText(n.name, tx, ty);
          }
          ctx.globalAlpha = (dim ? 0.3 : 1) * Math.max(LABEL_MIN_ALPHA, fl); // 名前は印と同じく遠いと薄くするが、6 割より薄くしない
          ctx.fillStyle = color;
          ctx.fillText(n.name, tx, ty);
          if (need !== null) {
            const nx = snapPx(tx + tw / 2 + (isSel ? 6 : 2)), ny = snapPx(ty - th + 10);
            ctx.font = needFont; ctx.textAlign = 'left';
            ctx.globalAlpha = dim ? 0.5 : 1; ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = haloFor(C.ink); ctx.strokeText(String(need), nx, ny);
            ctx.globalAlpha = (dim ? 0.3 : 1) * Math.max(LABEL_MIN_ALPHA, fl);
            ctx.fillStyle = need < (n.hits || 1) ? (tok('--good') || '#0E8A45') : C.muted; ctx.fillText(String(need), nx, ny);
          }
          ctx.globalAlpha = 1;
        } });
      }
      ctx.globalAlpha = 1;
    }
    if (S.overview) {
      // 地域の支配(第 14.2 節): 中心に地域名。支配者がいれば、その色の帯と名前
      for (const g of S.regions) {
        const q0 = toScreen(worldOf(g.lat, g.lon)), q = { x: snapPx(q0.x), y: snapPx(q0.y) };
        if (q.x < -80 || q.y < -40 || q.x > V.w + 80 || q.y > V.h + 40) continue;
        const st = g.controller && g.controller.style ? g.controller.style : null;
        const col = g.controller ? (st ? st.fill : g.controller.color) : null;
        const font = `700 ${snapPx((g.tier <= 3 ? 16 : g.tier === 5 ? 14 : 12) + LABEL_PLUS)}px "BIZ UDPGothic", sans-serif`;
        ctx.font = font;
        const label = (g.controller && g.controller.icon ? g.controller.icon + ' ' : '') + g.name, sub = g.controller ? `${g.controller.name} が支配` : '';
        const w = Math.max(ctx.measureText(label).width, sub ? ctx.measureText(sub).width * 0.85 : 0) + 14;
        const h = (sub ? 34 : 20) + LABEL_PLUS * (sub ? 2 : 1);
        // 地域名の優先: 支配者のいる地域 > 国・地方 > 都道府県 > 区・市
        const lp = (g.controller ? 8e5 : 0) + (g.tier <= 3 ? 750 : g.tier === 5 ? 700 : 300);
        labels.push({ prio: lp, box: [q.x - w / 2, q.y - 10, w, h], draw: () => {
          ctx.textAlign = 'center'; ctx.font = font;
          ctx.fillStyle = col || C.surface; ctx.globalAlpha = col ? 0.85 : 0.75;
          ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(q.x - w / 2, q.y - 10, w, h, 5); else ctx.rect(q.x - w / 2, q.y - 10, w, h); ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = st ? st.frame : (col || C.line); ctx.lineWidth = st ? 2 : 1.5; ctx.stroke();
          ctx.fillStyle = st ? st.text : (col ? '#fff' : C.ink); ctx.fillText(label, q.x, snapPx(q.y + 5 + LABEL_PLUS));
          if (sub) { ctx.font = `600 ${snapPx(10.5 + LABEL_PLUS)}px "BIZ UDPGothic", sans-serif`; ctx.fillText(sub, q.x, snapPx(q.y + 19 + LABEL_PLUS * 2)); }
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
      ctx.fillText(`広域表示: Lv${{ 1: 30, 2: 100, 3: 400, 4: 400 }[S.viewZ] || ''} 以上の拠点と、地域の支配。拡大すると全部出ます`, 12, 22);
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
    // 待ち時間は問題のダイアログに出す(右の欄の「あなたの番」は 2026-10-21 になくし、遊び方の説明は説明書のページへ移した)
    // 問題ダイアログにも出す(2026-10-20 ユーザー指摘)。答えたあとの「続けて解く」があるときだけ。待ち時間が終わったら押せるようにする
    const next = $('qNext'), showCool = cd > 0 && !next.hidden;
    $('qCool').hidden = !showCool;
    if (showCool) { $('qCoolBar').style.transform = `scaleX(${Math.min(1, cd / (S.cooldownMs || 5000))})`; $('qCoolText').textContent = `お手付き: あと ${Math.ceil(cd / 1000)} 秒`; }
    if (next.disabled !== (cd > 0)) next.disabled = cd > 0;
  }
  let toastTimer;
  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
  }

  resize();
  requestAnimationFrame(frame);
})();
