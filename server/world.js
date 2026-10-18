'use strict';
// 永続ワールド。部屋も制限時間もない 1 つの世界で、参加者は東京駅周辺に自分の拠点をもらい、隣の拠点へ広げていく。
// 全件をメモリに持たず、画面に見えているタイルの拠点だけを保存口から読み込む(設計書 第 13 章、docs/DB.md)。
//   - タイルごとのキャッシュ(拠点とリンク)。リンクは周囲のタイルの拠点とだけ計算する
//   - プレイヤーごとに「見ているタイル」を持ち、拠点が変わったらそのタイルを見ている人だけに差分を送る
//   - プレイヤーの点数と拠点数はプレイヤー ドキュメントの集計値(score, nodesOwned)
//   - 突破に必要な正解の回数 = つながりの本数(hits)。進捗は拠点ごとに攻め手(プレイヤーかチーム)別に持つ(設計書 第 14 章)
//   - 強化は 24 時間ごとに 1 下がる。地域の支配は配下の 3/4 以上で、所有が変わるたびに集計する

const crypto = require('crypto');
const tokyo = require('./map/all');
const { nodeDocs, regionDocs } = require('./map/load');
const { distanceKm, tilesAround, tileOf, tileFields, parseTile, tileSize, addrOf, MIN_LEVEL_BY_Z } = require('./map/geo');
const { getQuestion } = require('./questions');
const { judge } = require('./questions/normalize');
const { dayOf, noopEvents } = require('./events');

const COOLDOWN_MS = 4000;               // 不正解のあと操作できない時間(連続不正解で倍増。SECURITY.md F4)
const COOLDOWN_MAX_MS = 60000;          // 待ち時間の上限
const MIN_ANSWER_MS = 1000;             // 最短解答時間(SECURITY.md F6): 出題から 1 秒未満の解答は受け付けない(問題は残す)
const RANK_TTL_MS = 10 * 1000;          // ランキングの集計結果を持つ時間
const RANK_N = 15;
const TEAM_MAX_MEMBERS = 20;            // チームの人数上限の上限(作成時に 2〜20 で決める。第 3.11 節)
// チームの見た目(2026-10-18 決定): リーダーが枠の色・背景色・文字の色とアイコンを変えられる。アイコンは用意した記号から選ぶ
const TEAM_ICONS = ['★', '●', '■', '▲', '◆', '♠', '♣', '♥', '♦', '☀', '☾', '☁', '⚡', '❄', '✿', '⚑', '⚙', '☕', '♪', '✈', '⚓', '☯', '✦', '✪'];
const DEFAULT_TEAM_STYLE = { frame: '#1F2937', fill: '#FDE68A', text: '#1F2937' };
const isHex = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
const MAX_LEVEL = 999;                  // 出題レベルの上限(強化はここまで)
const PROTECT_MS = 24 * 60 * 60 * 1000; // 初心者保護: 生まれた拠点は 24 時間攻撃されない
const PROTECT_MAX_NODES = 3;            // 初心者保護: 所持拠点がこの数以下の人は攻撃されない(作成から NEWBIE_MS の間だけ)
const NEWBIE_MS = 7 * 24 * 60 * 60 * 1000;  // 初心者保護の期限: 作成から 7 日(2026-10-18 決定。別アカウントで要衝を永久に守る穴をふさぐ)
const IDLE_MS = 7 * 24 * 60 * 60 * 1000;    // 休眠: 稼働時間で 7 日接続が無い無料アカウントは、拠点をすべて中立に戻して削除(サブスク会員は除外)
const MOVE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 引っ越し(開始地点の変更)は 1 日 1 回(2026-10-18 決定)
const REACH_TTL_MS = 30 * 1000;             // 「自分の拠点から線でつながっている所有拠点」の計算結果を持つ時間
const TICK_CAP_MS = 5 * 60 * 1000;          // 稼働時計: 1 回の刻みで進めてよい上限。止まっていた時間(メンテナンス)は数えない
const HOME_LINKS = 2;                   // プレイヤーの拠点がつながる近隣拠点の数(開始地点 + 近い 1 つ)
const SPAWN_RINGS_KM = [0.3, 0.6, 1.0];  // 開始地点のまわりに置く半径。空きがなければ広げ、1 km でも無ければ満員(第 3.1 節)
const SPAWN_TRIES = 80;                 // 半径ごとの試行回数
const DEFAULT_START_ID = (tokyo.NODES.find((n) => n.name === '東京駅') || tokyo.NODES[0]).id; // 指定が無いときの開始地点
const MIN_GAP_KM = 0.15;                // 拠点どうしの最小距離
const LOG_MAX = 60;
const MAX_VIEW_TILES = 80;              // 1 人が一度に見られるタイル数
const TILE_TTL_MS = 10 * 60 * 1000;     // 誰も見ていないタイルをキャッシュから落とすまで
const DECAY_MS = 24 * 60 * 60 * 1000;   // 強化の減衰: この時間ごとに強化段数が 1 下がる(第 14.3 節)
const CONTROL_NUM = 3, CONTROL_DEN = 4; // 地域の支配: 配下の 3/4 以上(第 14.2 節)
const REGION_TTL_MS = 10 * 60 * 1000;   // 地域マスターをメモリに持つ時間(全国 約 2,000 件。縮小表示のたびに DB を読まない)
const REGION_TIER_BY_Z = { 1: 6, 2: 6, 3: 5, 4: 3 }; // 縮小の段 → 支配を見せる地域の段(6 市・区 / 5 都道府県 / 3 国。regions.json の kinds)
const COLORS = [
  '#E60012', '#0068B7', '#00A040', '#F08300', '#8F5BA6', '#00A0DE',
  '#C8005F', '#5C7A00', '#9A6B2E', '#1F7A8C', '#B8860B', '#6B5B95',
];

const newId = () => crypto.randomBytes(6).toString('hex');
// 週の鍵: 日本時間の月曜 0 時で区切る(例 "2026-10-12")。週間ランキングの集計単位
function weekKeyOf(t = Date.now()) {
  const jst = new Date(t + 9 * 3600 * 1000);
  const day = (jst.getUTCDay() + 6) % 7; // 月曜 = 0
  const monday = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}
const now = () => Date.now();
const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

class World {
  constructor({ store, country = 'japan', minAnswerMs = MIN_ANSWER_MS, events = null }) {
    this.store = store;
    this.events = events || noopEvents(); // 出来事の記録(docs/LOGS.md)。省略時は何もしない
    this.country = country;
    this.minAnswerMs = minAnswerMs; // テストでは 0 にする
    this.lastDay = null;      // 稼働時計が最後に見た日本時間の日付。変わったら支配の断面(control.daily)を 1 回書く
    this.tiles = new Map();   // tile id(z0) → { nodes: Map<id, node>, edges: Map<key, {a,b}>, linked: boolean, lastUsed }
    this.nodes = new Map();   // 読み込み済みの拠点 id → node(タイルのキャッシュと同じオブジェクト)
    this.adj = new Map();     // id → Set<id>(読み込み済みのリンクから)
    this.players = new Map(); // id → player(オンラインと最近使った人)
    this.listeners = new Set(); // 配信先(index.js が登録)
    this.log = [];
    this.homeSeq = 0;
    // 稼働時計(2026-10-18 決定): サーバーが動いていた時間だけを足す。休眠の判定はこの時計で行い、メンテナンス中は日数が進まない
    this.uptime = 0;
    this.lastTick = now();
    this.teamNames = new Map(); // チーム id → 名前(表示用のキャッシュ)
    this.teamLooks = new Map(); // チーム id → { style, icon }(拠点の色はチームの色に合わせる。2026-10-18 決定)
    this.rankCache = null;
  }
  // ---------- チーム(第 3.11 節、2026-10-18 決定) ----------
  // 作成と参加のどちらでもできる。所属中は作成できない。脱退は可能。人数の上限は作成時に 2〜TEAM_MAX_MEMBERS で決める
  async teamInfo(id) {
    const t = await this.store.loadTeam(id);
    if (t) { this.teamNames.set(t.id, t.name); const pt = this.pubTeam(t); this.teamLooks.set(t.id, { style: pt.style, icon: pt.icon }); }
    return t;
  }
  async createTeam(p, name, maxMembers) {
    if (p.team) throw new Error('チームに所属している間は、新しいチームを作れません(先に脱退してください)');
    const nm = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
    if (!nm) throw new Error('チーム名を入れてください');
    const max = Math.max(2, Math.min(TEAM_MAX_MEMBERS, Number(maxMembers) || 10));
    const team = { id: newId(), type: 'team', name: nm, ownerId: p.id, maxMembers: max, memberCount: 1, createdAt: now(), style: { ...DEFAULT_TEAM_STYLE }, icon: TEAM_ICONS[0] };
    await this.store.saveTeam(team);
    this.teamNames.set(team.id, team.name); this.teamLooks.set(team.id, { style: { ...team.style }, icon: team.icon });
    p.team = team.id; p.reach = null;
    await this.persistPlayer(p);
    this.events.add('team.create', { playerId: p.id, teamId: team.id, detail: { name: team.name, maxMembers: max } });
    this.addLog(`${p.name} がチーム「${team.name}」を作りました`);
    await this.emitPlayers();
    return team;
  }
  async joinTeam(p, teamId) {
    if (p.team) throw new Error('すでにチームに所属しています(先に脱退してください)');
    const team = await this.teamInfo(String(teamId || '').trim());
    if (!team) throw new Error('そのチームは見つかりません');
    if ((team.memberCount || 0) >= team.maxMembers) throw new Error(`このチームは満員です(${team.maxMembers} 人まで)`);
    team.memberCount = (team.memberCount || 0) + 1;
    await this.store.saveTeam(team);
    p.team = team.id;
    await this.persistPlayer(p);
    this.events.add('team.join', { playerId: p.id, teamId: team.id, detail: { memberCount: team.memberCount } });
    this.addLog(`${p.name} がチーム「${team.name}」に参加しました`);
    await this.emitPlayers();
    return team;
  }
  // 見た目の変更(リーダーだけ)
  async styleTeam(p, { frame, fill, text, icon } = {}) {
    if (!p.team) throw new Error('チームに所属していません');
    const team = await this.teamInfo(p.team);
    if (!team) throw new Error('そのチームは見つかりません');
    if (team.ownerId !== p.id) throw new Error('見た目を変えられるのはチームのリーダーだけです');
    const style = { ...DEFAULT_TEAM_STYLE, ...(team.style || {}) };
    for (const [k, v] of Object.entries({ frame, fill, text })) {
      if (v === undefined || v === null) continue;
      if (!isHex(v)) throw new Error('色は #RRGGBB の形で指定してください');
      style[k] = v.toUpperCase();
    }
    if (icon !== undefined && icon !== null) {
      if (!TEAM_ICONS.includes(icon)) throw new Error('アイコンは用意された記号から選んでください');
      team.icon = icon;
    }
    team.style = style;
    await this.store.saveTeam(team);
    this.teamLooks.set(team.id, { style: { ...style }, icon: team.icon });
    this.events.add('team.style', { playerId: p.id, teamId: team.id, detail: { style: { ...style }, icon: team.icon } });
    this.rankCache = null;
    await this.emitPlayers();
    return team;
  }
  pubTeam(t) { return t ? { id: t.id, name: t.name, ownerId: t.ownerId, maxMembers: t.maxMembers, memberCount: t.memberCount, style: { ...DEFAULT_TEAM_STYLE, ...(t.style || {}) }, icon: t.icon || TEAM_ICONS[0] } : null; }
  async leaveTeam(p) {
    if (!p.team) throw new Error('チームに所属していません');
    const team = await this.teamInfo(p.team);
    let newOwnerId = null, deleted = false;
    if (team) {
      team.memberCount = Math.max(0, (team.memberCount || 1) - 1);
      if (team.memberCount === 0) { deleted = true; await this.store.deleteTeam(team.id); }
      else {
        // リーダーが抜けたら、いちばん古くからいる人にリーダーを渡す
        if (team.ownerId === p.id) { const next = (await this.store.teamMembers(team.id, 2)).find((m) => m.id !== p.id); team.ownerId = next ? next.id : null; newOwnerId = team.ownerId; }
        await this.store.saveTeam(team);
      }
    }
    const name = team ? team.name : p.team;
    const teamId = p.team;
    p.team = null;
    await this.persistPlayer(p);
    this.events.add('team.leave', { playerId: p.id, teamId, detail: { memberCount: team ? team.memberCount : null, newOwnerId, deleted } });
    this.addLog(`${p.name} がチーム「${name}」を脱退しました`);
    await this.emitPlayers();
    return name;
  }

  // ---------- 起動 ----------
  async init() {
    if ((await this.store.countNodes()) === 0) {
      await this.store.seedNodes(nodeDocs(tokyo.NODES));
    }
    if ((await this.store.countRegions()) === 0) {
      await this.store.seedRegions(regionDocs(tokyo.NODES));
    }
    const clock = await this.store.loadMeta('clock');
    this.uptime = clock && Number.isFinite(clock.uptimeMs) ? clock.uptimeMs : 0;
    this.lastDay = (clock && typeof clock.day === 'string') ? clock.day : dayOf(now()); // 保存してあるので、0 時をまたいだ再起動でも断面を落とさない
    this.lastTick = now();
    return this;
  }
  // 稼働時計を進める(1 分ごと)。前回から TICK_CAP_MS を超えて経っていれば、その分は止まっていたとみなして数えない。
  // 日本時間の日付が変わっていたら、全地域の支配の断面(control.daily)を 1 回だけ書く(LOGS.md 5.2)
  async tick() {
    const t = now();
    this.uptime += Math.min(TICK_CAP_MS, Math.max(0, t - this.lastTick));
    this.lastTick = t;
    const day = dayOf(t);
    if (this.lastDay && day !== this.lastDay) { try { await this.snapshotControl(t); } catch (e) { console.error('支配の断面の記録に失敗:', e.message); } }
    this.lastDay = day;
    try { await this.store.saveMeta({ id: 'clock', type: 'meta', uptimeMs: this.uptime, savedAt: t, day }); } catch (e) { console.error('稼働時計の保存に失敗:', e.message); }
    return this.uptime;
  }
  // 支配の断面: 区・市(tier 6)・都道府県(5)・国(3)の control を events に写す。id は ctl-日付-地域 なので同じ日に 2 回走っても上書き
  async snapshotControl(at = now()) {
    const day = dayOf(at);
    let count = 0;
    for (const r of (await this.regionIndex()).list) {
      if (![3, 5, 6].includes(r.tier)) continue;
      if (!(r.nodeCount > 0) && !(r.control && r.control.controller)) continue; // 拠点の無い地域(全国の形だけ入れたもの)は残さない
      const c = r.control || {};
      const counts = Object.fromEntries(Object.entries(c.counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 3));
      this.events.add('control.daily', { id: `ctl-${day}-${r.id}`, at, regionId: r.id, detail: { tier: r.tier, controller: c.controller || null, total: c.total || 0, counts } });
      count++;
    }
    return count;
  }
  // 最終接続を記録する(実時刻と稼働時計の両方)
  touch(p) { p.lastSeen = now(); p.lastSeenUp = this.uptime; }

  // ---------- タイルの読み込みとリンク ----------
  tile(t) {
    if (!this.tiles.has(t)) this.tiles.set(t, { nodes: new Map(), edges: new Map(), linked: false, lastUsed: now() });
    const c = this.tiles.get(t); c.lastUsed = now(); return c;
  }
  // z0 のタイル一覧を読み込み、必要ならリンクを計算する。戻り値は読み込んだタイル
  async ensureTiles(tiles0) {
    const need = tiles0.filter((t) => !this.tiles.has(t) || !this.tiles.get(t).loaded);
    if (need.length) {
      const docs = await this.store.loadTiles(this.country, need, 1);
      for (const t of need) { const c = this.tile(t); c.loaded = true; }
      for (const d of docs) this.adopt(d);
    }
    // リンク: 対象タイルの周囲 1 周が読み込まれている必要がある
    const ring = new Set(tiles0.flatMap((t) => tilesAround(t, 1)));
    const ringNeed = [...ring].filter((t) => !this.tiles.has(t) || !this.tiles.get(t).loaded);
    if (ringNeed.length) {
      const docs = await this.store.loadTiles(this.country, ringNeed, 1);
      for (const t of ringNeed) { const c = this.tile(t); c.loaded = true; }
      for (const d of docs) this.adopt(d);
    }
    for (const t of tiles0) if (!this.tile(t).linked) await this.linkTile(t);
  }
  // 読み込んだドキュメントをキャッシュに入れる
  adopt(doc) {
    const existing = this.nodes.get(doc.id);
    if (existing) return existing;
    const n = { ...doc };
    if (!n.base) Object.assign(n, addrOf(n.id));
    if (!Array.isArray(n.adj)) n.adj = [];
    if (!n.hits) n.hits = n.isPlayerNode ? 1 : Math.max(1, n.adj.length);
    if (!n.progress || typeof n.progress !== 'object') n.progress = {};
    if (!Array.isArray(n.routes)) n.routes = []; // 航路(空港・港だけ)
    const t = n.t0 || tileOf(n.lat, n.lon, 0);
    n.t0 = t;
    this.tile(t).nodes.set(n.id, n);
    this.nodes.set(n.id, n);
    return n;
  }
  // つながりはマスターの adj(路線の前後の駅、名所は近い駅。tools/import-links.js)。つながり先が別のタイルで未読なら 1 件ずつ読む
  async linkTile(t) {
    const c = this.tile(t);
    const ok = (n) => n.status === 'public' && n.hackable !== false && !n.isPlayerNode;
    const mine = [...c.nodes.values()].filter(ok);
    const missing = new Set();
    for (const n of mine) for (const m of n.adj) if (!this.nodes.has(m)) missing.add(m);
    for (const id of missing) { const d = await this.store.loadNode(id); if (d) this.adopt(d); }
    for (const n of mine) for (const m of n.adj) { const o = this.nodes.get(m); if (o && ok(o)) this.addEdge(n.id, m, t); }
    const cands = tilesAround(t, 1).flatMap((u) => (this.tiles.has(u) ? [...this.tiles.get(u).nodes.values()].filter(ok) : []));
    // プレイヤーの拠点は近い固定拠点 2 つとつなぐ
    for (const h of c.nodes.values()) if (h.isPlayerNode && h.status === 'public') this.linkHome(h, cands);
    c.linked = true;
  }
  linkHome(h, cands) {
    const near = cands.map((m) => ({ m, d: distanceKm(h, m) })).sort((a, b) => a.d - b.d).slice(0, HOME_LINKS);
    for (const { m } of near) this.addEdge(h.id, m.id, h.t0);
  }
  addEdge(a, b, t) {
    const k = edgeKey(a, b);
    this.tile(t).edges.set(k, { a, b });
    if (!this.adj.has(a)) this.adj.set(a, new Set());
    if (!this.adj.has(b)) this.adj.set(b, new Set());
    this.adj.get(a).add(b); this.adj.get(b).add(a);
  }
  // 誰も見ていない古いタイルを落とす(メモリを抑える)
  evict() {
    const inUse = new Set();
    for (const p of this.players.values()) if (p.online) for (const t of p.view) for (const u of tilesAround(t, 1)) inUse.add(u);
    for (const [t, c] of this.tiles) {
      if (inUse.has(t) || now() - c.lastUsed < TILE_TTL_MS) continue;
      for (const n of c.nodes.values()) { this.nodes.delete(n.id); this.adj.delete(n.id); }
      this.tiles.delete(t);
    }
  }

  // ---------- 配信 ----------
  // 画面へ送る拠点の形(答え・内部値は含めない)
  pub(n) {
    return {
      id: n.id, name: n.name, kind: n.kind, genre: n.genre || null, area: n.area || null, lat: n.lat, lon: n.lon, t0: n.t0,
      level: n.level, value: this.valueOf(n), baseValue: n.value, subnet: n.subnet, owner: n.owner, defense: this.settle(n).defense,
      isPlayerNode: !!n.isPlayerNode, protectedUntil: n.protectedUntil || 0, hackable: n.hackable !== false, lines: n.lines || [],
      hits: n.hits || 1, progress: n.progress || {}, // 突破に必要な回数と、攻め手ごとの正解回数(第 14 章)
      company: n.company || null, // 命名権など企業名の施設の企業名
      routes: n.routes && n.routes.length ? n.routes : undefined, // 航路(空港・港)。行き先 { to, mode, name, lat, lon }
    };
  }
  send(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
  // 拠点が変わったら、そのタイルを見ている人へ
  emitNode(n) {
    const msg = { t: 'nodes', nodes: [this.pub(n)] };
    for (const p of this.players.values()) if (p.online && p.view.has(n.t0)) this.send(p, msg);
  }
  // 週の集計欄を今週のものにそろえる(週が変わっていたら 0 から)
  bumpWeek(p) {
    const wk = weekKeyOf(now());
    if (p.weekKey !== wk) { p.weekKey = wk; p.weekPoints = 0; p.weekNodes = 0; }
    return p;
  }
  // ランキング(第 3.1 節、2026-10-18 決定): 総合(現在の点数・累計点・拠点数)と週間(今週の獲得点)、個人とチーム。10 秒は使い回す
  async rankings() {
    if (this.rankCache && now() - this.rankCache.at < RANK_TTL_MS) return this.rankCache.data;
    const wk = weekKeyOf(now());
    const [score, points, nodes, week, teams] = await Promise.all([
      this.store.topPlayers(RANK_N, 'score'), this.store.topPlayers(RANK_N, 'points'), this.store.topPlayers(RANK_N, 'nodesOwned'),
      this.store.topPlayers(RANK_N, 'weekPoints', { weekKey: wk }), this.store.topTeams(RANK_N),
    ]);
    const pub = (list) => list.map((x) => this.pubPlayer(x));
    const teamDocs = new Map();
    for (const t of teams) teamDocs.set(t.team, await this.teamInfo(t.team));
    const data = {
      week: wk,
      score: pub(score), points: pub(points), nodes: pub(nodes), weekPoints: pub(week).map((x, i) => ({ ...x, weekPoints: week[i].weekPoints || 0 })),
      teams: teams.map((t) => { const d = this.pubTeam(teamDocs.get(t.team)); return { id: t.team, name: d ? d.name : t.team, icon: d ? d.icon : null, style: d ? d.style : null, score: t.score || 0, points: t.points || 0, nodes: t.nodes || 0, members: t.members || 0 }; }),
    };
    this.rankCache = { at: now(), data };
    return data;
  }
  async emitPlayers() {
    this.rankCache = null;
    const rank = await this.rankings();
    for (const p of this.players.values()) {
      if (!p.online) continue;
      const list = rank.score.slice();
      if (!list.some((x) => x.id === p.id)) list.push(this.pubPlayer(p));
      this.send(p, { t: 'players', players: list, rankings: rank, me: this.pubPlayer(this.bumpWeek(p)), log: this.log.slice(-12), now: now() });
    }
  }
  pubPlayer(p) {
    const live = this.players.get(p.id);
    return { id: p.id, name: p.name, color: p.color, online: !!(live && live.online), score: p.score || 0, nodes: p.nodesOwned || 0, points: p.points || 0, newbie: this.isNewbie(p),
      team: p.team || null, teamName: p.team ? (this.teamNames.get(p.team) || null) : null, weekPoints: p.weekKey === weekKeyOf(now()) ? (p.weekPoints || 0) : 0,
      teamStyle: p.team && this.teamLooks.get(p.team) ? this.teamLooks.get(p.team).style : null, teamIcon: p.team && this.teamLooks.get(p.team) ? this.teamLooks.get(p.team).icon : null };
  }
  // 初心者保護(3 拠点以下)の対象か: 作成から 7 日以内
  isNewbie(p) { return now() - (p.createdAt || 0) < NEWBIE_MS; }

  // プレイヤーの見ている範囲を更新し、新しく見えるタイルの拠点とリンクを送る
  async setView(p, tiles, z = 0) {
    const zz = Math.max(0, Math.min(4, Number(z) || 0));
    const list = [...new Set((tiles || []).map(String).filter((t) => { const q = parseTile(t); return q && q.z === zz; }))].slice(0, MAX_VIEW_TILES);
    const minLevel = MIN_LEVEL_BY_Z[zz];
    if (zz === 0) {
      await this.ensureTiles(list);
      const next = new Set(list);
      const added = list.filter((t) => !p.view.has(t));
      const dropped = [...p.view].filter((t) => !next.has(t));
      p.view = next; p.viewZ = 0;
      const nodes = [], edges = [];
      for (const t of added) {
        const c = this.tile(t);
        for (const n of c.nodes.values()) if (n.status === 'public') nodes.push(this.pub(n));
        for (const e of c.edges.values()) edges.push(e);
      }
      // 隣のタイルからこのタイルへ入るリンクも送る(端の拠点が孤立して見えないように)
      for (const t of added) for (const u of tilesAround(t, 1)) if (!next.has(u) && this.tiles.has(u)) {
        for (const e of this.tiles.get(u).edges.values()) if (this.tile(t).nodes.has(e.a) || this.tile(t).nodes.has(e.b)) edges.push(e);
      }
      this.send(p, { t: 'tiles', z: 0, added, dropped, nodes, edges });
    } else {
      // 縮小時: 粗いタイルで、レベルの高い拠点だけ(リンクは送らない)
      const docs = await this.store.loadTiles(this.country, list, minLevel);
      p.view = new Set(); p.viewZ = zz;
      const regions = await this.regionsInView(list, zz);
      this.send(p, { t: 'tiles', z: zz, added: list, dropped: [], overview: true, minLevel, nodes: docs.filter((d) => d.status === 'public').map((d) => this.pub(this.adopt(d))), edges: [], regions });
    }
  }

  // ---------- 参加・復帰 ----------
  // 参加前の人(開始地点を地図から選ぶ)にも範囲の読み込みを許す。配信先にはならない
  guest(ws) {
    if (!ws.guest) ws.guest = { id: 'guest', ws, online: true, guest: true, view: new Set(), viewZ: 0 };
    return ws.guest;
  }
  // 開始地点の検索(名前の一部。ハック可の公開の固定拠点だけ)。各拠点から始めた人数を添える
  async search(country, q) {
    const text = String(q || '').trim().slice(0, 20);
    if (!text) return [];
    const rows = await this.store.searchNodes(country, text, 10);
    const starters = await this.store.countStarters(rows.map((r) => r.id));
    return rows.map((r) => ({ id: r.id, name: r.name, area: r.area || null, level: r.level, genre: r.genre || null, lat: r.lat, lon: r.lon, starters: starters[r.id] || 0 }));
  }
  // 開始地点の拠点を確かめて返す(読み込まれていなければ 1 件読む)
  async startNode(p) {
    const id = p.startNodeId || DEFAULT_START_ID;
    let n = this.nodes.get(id);
    if (!n) { const d = await this.store.loadNode(id); if (d) n = this.adopt(d); }
    if (!n || n.isPlayerNode || n.hackable === false || n.status !== 'public' || n.country !== (p.country || this.country)) {
      throw new Error('その開始地点は選べません。駅か名所を選んでください');
    }
    return n;
  }
  async join(ws, name, token, startNodeId = null) {
    if (token) {
      let p = [...this.players.values()].find((x) => x.token === token);
      if (!p) { const doc = await this.store.findPlayerByToken(token); if (doc) p = this.attach(doc); }
      if (p) {
        if (p.team && !this.teamNames.has(p.team)) await this.teamInfo(p.team);
        if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch { /* 古い接続は閉じるだけ */ } }
        p.ws = ws; p.online = true; this.touch(p); p.view = new Set(); p.connectedAt = now();
        const renamed = !!name && name !== p.name;
        if (name) p.name = name;
        this.addLog(`${p.name} が戻ってきました`);
        await this.persistPlayer(p);
        this.events.add('resume', { playerId: p.id, teamId: p.team || undefined, ip: ws.ip, detail: { renamed } });
        return p;
      }
    }
    const p = this.attach({
      id: newId(), token: newId(), name, color: await this.pickColor(),
      country: this.country, startNodeId: startNodeId || DEFAULT_START_ID, // 登録国と開始地点(第 3.1 節)
      plan: null, // サブスク(予約)。入っていれば休眠でも消えない
      movedAt: null, // 最後に引っ越した時刻(1 日 1 回)
      weekKey: weekKeyOf(now()), weekPoints: 0, weekNodes: 0, // 週間ランキング(日本時間の月曜で区切る)
      wrongStreak: 0, cooldownUntil: 0, // 連続不正解と待ち時間(再接続で消せないよう保存)
      registered: false, accountId: null, registeredAt: null, // 本登録(予約)。復帰コードはお試しで、本登録しても残る(第 3.1 節)
      points: 0, score: 0, nodesOwned: 0, homeNodeId: null, team: null, sponsorId: null, createdAt: now(), lastSeen: now(), lastSeenUp: this.uptime,
    });
    p.ws = ws; p.online = true; p.connectedAt = now();
    let home;
    try { home = await this.spawnHome(p); } catch (e) { this.players.delete(p.id); throw e; }
    this.addLog(`${p.name} が東京に参加しました`);
    await this.persistPlayer(p);
    this.events.add('join', { playerId: p.id, nodeId: home.id, regionId: home.region, ip: ws.ip, detail: { startNodeId: p.startNodeId, name: p.name } });
    return p;
  }
  attach(doc) {
    const p = { ...doc, ws: null, online: false, pending: null, cooldownUntil: doc.cooldownUntil || 0, wrongStreak: doc.wrongStreak || 0, view: new Set(), viewZ: 0, reach: null, reachAt: 0 };
    this.players.set(p.id, p);
    return p;
  }
  async getPlayer(id) {
    if (this.players.has(id)) return this.players.get(id);
    const doc = await this.store.loadPlayer(id);
    return doc ? this.attach(doc) : null;
  }
  // 復帰コードの再発行: 古いコードは使えなくなる(SECURITY.md T7)
  async rekey(p) {
    p.token = newId();
    await this.persistPlayer(p);
    this.events.add('rekey', { playerId: p.id, teamId: p.team || undefined }); // 新旧のコードは書かない
    return p.token;
  }
  // 引っ越し(開始地点の変更。2026-10-18 決定): 今の自分の拠点を消して新しい場所に作る。所有している固定拠点は残るが、
  // 新しい拠点から線がつながるまでは「ただ存在しているだけ」になる。1 日 1 回まで
  async move(p, startNodeId) {
    if (p.movedAt && now() - p.movedAt < MOVE_INTERVAL_MS) {
      const h = Math.ceil((MOVE_INTERVAL_MS - (now() - p.movedAt)) / 3600000);
      throw new Error(`引っ越しは 1 日に 1 回までです(あと ${h} 時間)`);
    }
    if (!startNodeId || startNodeId === p.startNodeId) throw new Error('いまと違う開始地点を選んでください');
    const old = p.homeNodeId ? (this.nodes.get(p.homeNodeId) || await this.store.loadNode(p.homeNodeId)) : null;
    const prevStart = p.startNodeId;
    p.startNodeId = startNodeId;
    try { await this.startNode(p); } catch (e) { p.startNodeId = prevStart; throw e; }
    if (old) {
      await this.store.deleteNode(old.id);
      this.dropNode(old);
      p.nodesOwned = Math.max(0, (p.nodesOwned || 0) - 1);
      p.score = Math.max(0, (p.score || 0) - this.valueOf(old));
    }
    p.pending = null; p.movedAt = now(); this.invalidateReach(p.id);
    p.view = new Set(); // 画面は引っ越しで持っている拠点を全部消して取り直すので、見ている範囲も空に戻す(戻さないと、選んだ駅のタイルが「送り済み」扱いで二度と届かない)
    const home = await this.spawnHome(p);
    this.addLog(`${p.name} が ${home.area} へ引っ越しました`);
    await this.persistPlayer(p);
    this.events.add('move', { playerId: p.id, teamId: p.team || undefined, nodeId: home.id, regionId: home.region, detail: { from: prevStart, to: startNodeId, oldHomeId: old ? old.id : null } });
    await this.emitPlayers();
    return home;
  }
  // 休眠アカウントの回収(2026-10-18 決定): 稼働時計で 7 日接続が無い無料アカウントは、奪った拠点も自分の拠点も含めて全部中立に戻し、アカウントを削除する。
  // サブスク(plan あり)は対象外。いま接続中の人も対象外。古いドキュメント(lastSeenUp 無し)は次に接続したときから数え始める
  async reclaimIdle() {
    if (this.uptime < IDLE_MS) return 0; // 時計がまだ 7 日ぶん進んでいなければ誰も対象にならない
    const docs = await this.store.findIdlePlayers(this.uptime - IDLE_MS);
    let count = 0;
    const touched = new Map(); // region → その地域の拠点(支配の再集計用)
    for (const doc of docs) {
      const live = this.players.get(doc.id);
      if ((live && live.online) || doc.plan) continue;
      const owned = await this.store.nodesOwnedBy(doc.id);
      let nodesFreed = 0, homeDeleted = false;
      for (const d of owned) {
        const n = this.nodes.get(d.id) || d;
        if (n.isPlayerNode) {
          await this.store.deleteNode(n.id);
          this.dropNode(n);
          homeDeleted = true;
          continue;
        }
        n.owner = null; n.defense = 0; n.fortifiedAt = null; n.progress = {}; n.protectedUntil = 0;
        await this.persistNode(n);
        nodesFreed++;
        if (this.nodes.has(n.id)) this.emitNode(n);
        if (n.region) touched.set(n.region, n);
      }
      await this.store.deletePlayer(doc.id);
      this.players.delete(doc.id);
      this.events.add('reclaim', { playerId: doc.id, teamId: doc.team || undefined, detail: { name: doc.name, nodesFreed, homeDeleted, lastSeen: doc.lastSeen, lastSeenUp: doc.lastSeenUp } });
      this.addLog(`${doc.name} は 7 日間接続が無かったため、拠点が中立に戻りました`);
      count++;
    }
    for (const n of touched.values()) await this.updateControl(n);
    if (count) await this.emitPlayers();
    return count;
  }
  // キャッシュから拠点を消す(プレイヤーの拠点の削除)
  dropNode(n) {
    const t = n.t0;
    if (this.tiles.has(t)) { const c = this.tiles.get(t); c.nodes.delete(n.id); for (const k of [...c.edges.keys()]) if (k.split('|').includes(n.id)) c.edges.delete(k); }
    for (const m of this.adj.get(n.id) || []) { const s = this.adj.get(m); if (s) s.delete(n.id); }
    this.adj.delete(n.id);
    this.nodes.delete(n.id);
    const msg = { t: 'nodes', nodes: [{ ...this.pub(n), status: 'gone' }] };
    for (const p of this.players.values()) if (p.online && p.view.has(t)) this.send(p, msg);
  }
  async disconnect(p) {
    const sec = p.connectedAt ? Math.round((now() - p.connectedAt) / 1000) : null;
    p.online = false; p.ws = null; p.pending = null; this.touch(p); p.view = new Set(); p.connectedAt = null;
    await this.persistPlayer(p);
    this.events.add('leave', { playerId: p.id, teamId: p.team || undefined, detail: { sec } });
  }
  async pickColor() {
    const used = new Map();
    for (const p of this.players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
    return COLORS.reduce((best, c) => ((used.get(c) || 0) < (used.get(best) || 0) ? c : best), COLORS[0]);
  }
  async persistPlayer(p) {
    const { ws, online, pending, view, viewZ, reach, reachAt, connectedAt, ...doc } = p;
    doc.type = 'player';
    try { await this.store.savePlayer(doc); } catch (e) { console.error('プレイヤーの保存に失敗:', e.message); }
  }
  async persistNode(n) {
    n.updatedAt = now();
    try { await this.store.saveNode({ ...n, type: 'node' }); } catch (e) { console.error('拠点の保存に失敗:', e.message); }
  }

  // 開始地点(選んだ駅・名所)のまわりの空いている場所に、プレイヤー専用の拠点を生み、開始地点と近い固定拠点につなぐ。
  // 人数の上限は置かず、間隔(MIN_GAP_KM)を守って半径を広げる。1 km まで空きが無ければ満員(第 3.1 節)
  async spawnHome(p) {
    const start = await this.startNode(p);
    const c = { lat: start.lat, lon: start.lon, name: start.area, region: start.region };
    await this.ensureTiles(tilesAround(tileOf(c.lat, c.lon, 0), 1));
    let lat = null, lon = null;
    for (const radius of SPAWN_RINGS_KM) {
      for (let tries = 0; tries < SPAWN_TRIES && lat === null; tries++) {
        const ang = Math.random() * Math.PI * 2;
        const r = radius * Math.sqrt(Math.random());
        // 保存する桁(小数 5 桁)に丸めてから間隔を確かめる(丸めで 1 m ほどずれて 150 m を割らないように)
        const la = Number((c.lat + (r / 111) * Math.cos(ang)).toFixed(5));
        const lo = Number((c.lon + (r / (111 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin(ang)).toFixed(5));
        const near = [...this.nodes.values()].filter((n) => Math.abs(n.lat - la) < 0.01 && Math.abs(n.lon - lo) < 0.012);
        if (near.every((n) => distanceKm(n, { lat: la, lon: lo }) >= MIN_GAP_KM)) { lat = la; lon = lo; }
      }
      if (lat !== null) break;
    }
    if (lat === null) throw new Error(`${start.name} のまわりは満員です。近くの別の駅を選んでください`);
    const k = this.homeSeq++;
    const a = 16 + ((k >> 8) % 16), b = k & 255;
    const id = `home-${newId()}`;
    const node = {
      id, type: 'node', name: `${p.name}の拠点`, genre: null, kind: 'HOME', kindLabel: 'プレイヤーの拠点',
      area: c.name, country: this.country, region: c.region || 'tokyo-chiyoda', startNodeId: start.id,
      lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), location: { type: 'Point', coordinates: [Number(lon.toFixed(5)), Number(lat.toFixed(5))] },
      ...tileFields(lat, lon),
      level: 1, value: 1, hackable: true, lines: [], tags: [],
      subnet: `172.${a}.${b}.0/24`, base: ((172 << 24) >>> 0) + (a << 16) + (b << 8), span: 254,
      status: 'public', isPlayerNode: true, registeredBy: p.id, sponsorId: null,
      owner: p.id, defense: 0, protectedUntil: now() + PROTECT_MS, createdAt: now(), updatedAt: now(),
    };
    const n = this.adopt(node);
    // 開始地点と必ずつなぎ、残りは近い固定拠点
    this.addEdge(n.id, start.id, n.t0);
    const cands = tilesAround(n.t0, 1).flatMap((u) => (this.tiles.has(u) ? [...this.tiles.get(u).nodes.values()] : []))
      .filter((m) => m.status === 'public' && m.hackable !== false && !m.isPlayerNode && m.id !== start.id);
    const near = cands.map((m) => ({ m, d: distanceKm(n, m) })).sort((a, b) => a.d - b.d).slice(0, HOME_LINKS - 1);
    for (const { m } of near) this.addEdge(n.id, m.id, n.t0);
    p.homeNodeId = n.id;
    p.nodesOwned = (p.nodesOwned || 0) + 1;
    p.score = (p.score || 0) + this.valueOf(n);
    await this.persistNode(n);
    this.emitNode(n);
    // 新しく張ったリンクを見ている人へ
    const edges = [...this.tile(n.t0).edges.values()].filter((e) => e.a === n.id || e.b === n.id);
    for (const q of this.players.values()) if (q.online && q.view.has(n.t0)) this.send(q, { t: 'tiles', z: 0, added: [], dropped: [], nodes: [], edges });
    return n;
  }

  // ---------- 集計 ----------
  valueOf(n) { return (n.value || 0) + (this.settle(n).defense || 0); }
  // 強化の減衰(第 14.3 節): 最後に強化・奪取した時刻から 24 時間ごとに 1 下がる。基礎レベルより下にはならない
  settle(n) {
    if (n.defense > 0 && n.fortifiedAt) {
      const steps = Math.floor((now() - n.fortifiedAt) / DECAY_MS);
      if (steps > 0) { const d = Math.min(steps, n.defense); n.defense -= d; n.fortifiedAt += d * DECAY_MS; }
    }
    return n;
  }
  // 回数を数える単位: チームに所属していればチーム、いなければ自分(第 3.2 節)
  attackKey(p) { return p.team || p.id; }
  score(pid) { const p = this.players.get(pid); return p ? p.score || 0 : 0; }
  ownedCount(pid) { const p = this.players.get(pid); return p ? p.nodesOwned || 0 : 0; }

  // 自分の拠点(本拠地)から、自分の所有拠点を線でたどって届く拠点の集合(2026-10-18 決定)。
  // 引っ越しなどで線が切れた所有拠点は「ただ存在しているだけ」で、そこからは広げられない。つなぎ直せばまた使える
  async reach(p) {
    if (p.reach && now() - p.reachAt < REACH_TTL_MS) return p.reach;
    const owned = await this.store.nodesOwnedBy(p.id);
    const byId = new Map(owned.map((n) => [n.id, n]));
    for (const n of this.nodes.values()) if (n.owner === p.id) byId.set(n.id, n); // キャッシュの方が新しいことがある
    for (const [id, n] of byId) if (n.owner !== p.id) byId.delete(id);
    const set = new Set();
    const home = p.homeNodeId && byId.get(p.homeNodeId);
    if (home) {
      const stack = [home.id]; set.add(home.id);
      while (stack.length) {
        const cur = byId.get(stack.pop());
        // 線(adj)と、航路(空路・海路)でつながった所有拠点をたどる
        const nb = new Set([...(cur.adj || []), ...(this.adj.get(cur.id) || []), ...(cur.routes || []).map((r) => r.to)]);
        for (const m of nb) if (byId.has(m) && !set.has(m)) { set.add(m); stack.push(m); }
      }
    }
    p.reach = set; p.reachAt = now();
    return set;
  }
  invalidateReach(pid) { const p = this.players.get(pid); if (p) p.reach = null; }
  // 攻撃できる条件は「自分の拠点から線でつながっている所有拠点に隣接していること」。チームの拠点とつながっているだけでは攻撃できない(2026-10-18 決定)。
  // チームの陣地の近くから始めれば、そこまで自力で進む部分を省略できる
  async canAttack(pid, nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n || n.status !== 'public' || n.owner === pid) return false;
    if (n.hackable === false) return false;
    if (n.isPlayerNode) return false; // プレイヤー自身の拠点は占領禁止(2026-10-18 決定)
    if (n.protectedUntil > now()) return false;
    if (n.owner) { const o = await this.getPlayer(n.owner); if (o && (o.nodesOwned || 0) <= PROTECT_MAX_NODES && this.isNewbie(o)) return false; }
    const nb = this.adj.get(nodeId) || new Set();
    const mine = [...nb].filter((id) => { const m = this.nodes.get(id); return m && m.owner === pid; });
    // 航路(2026-10-19): 自分の拠点からたどれる空港・港を占領していれば、その航路の先の空港・港を攻撃できる(行き先は遠くてよい)
    const viaRoute = (n.routes || []).map((r) => r.to);
    if (!mine.length && !viaRoute.length) return false;
    const p = await this.getPlayer(pid);
    if (!p) return false;
    const reach = await this.reach(p);
    return mine.some((id) => reach.has(id)) || viaRoute.some((id) => reach.has(id));
  }

  // 出題レベル。難しさはレベルだけで決める(設計書 3.2)。突破に必要な回数は hits(つながりの本数)で別に決まる
  levelFor(n, mode) {
    const base = Math.min(MAX_LEVEL, Math.max(1, n.level) + (this.settle(n).defense || 0));
    if (mode === 'fortify') return base;
    return n.owner ? Math.max(4, base) : base;
  }

  // ---------- 問題 ----------
  async ask(p, nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n || n.status !== 'public') throw new Error('その拠点は表示されていません。地図を動かして選び直してください');
    if (n.hackable === false) throw new Error('この場所はネットワークにつながっていません(ハックできません)');
    if (now() < p.cooldownUntil) throw new Error('通信が回復するまで少し待ってください');
    let mode;
    if (n.owner === p.id) {
      if (this.levelFor(n, 'fortify') >= MAX_LEVEL) throw new Error('この拠点の強化はすでに最大です');
      mode = 'fortify';
    } else if (await this.canAttack(p.id, nodeId)) {
      mode = 'attack';
    } else if (n.isPlayerNode) {
      throw new Error('プレイヤー自身の拠点は占領できません');
    } else if (n.protectedUntil > now()) {
      throw new Error('この拠点は生まれたばかりで守られています');
    } else if (n.owner && await (async () => { const o = await this.getPlayer(n.owner); return o && o.nodesOwned <= PROTECT_MAX_NODES && this.isNewbie(o); })()) {
      throw new Error('始めたばかりで拠点が少ないプレイヤーは守られています');
    } else {
      const nb = this.adj.get(nodeId) || new Set();
      const viaOrphan = [...nb].some((id) => { const m = this.nodes.get(id); return m && m.owner === p.id; });
      throw new Error(viaOrphan
        ? 'その所有拠点は自分の拠点から線がつながっていないため、そこからは広げられません。つなぎ直してください'
        : '自分の拠点とつながっている拠点だけ攻撃できます');
    }
    const level = this.levelFor(n, mode);
    if (p.pending && p.pending.nodeId === nodeId && p.pending.mode === mode && p.pending.level === level) return p.pending.payload;
    const q = getQuestion({ level, node: n });
    const qid = newId();
    // 入力式(COMMON.md 第 1 章): fields は name / label / format / hint / digits / vocab だけ配信し、accept は送らない
    const fields = Array.isArray(q.fields) ? q.fields.map((f) => ({ name: f.name, label: f.label, format: f.format, hint: f.hint || null, digits: f.digits || null, vocab: f.vocab || null })) : null;
    const payload = {
      t: 'question', qid, nodeId, mode, level, provisional: !!q.provisional, text: q.text, answerKind: q.answerKind || 'choice',
      options: q.options || null, table: q.table || null, tables: q.tables || null, fields, compare: q.compare || null,
    };
    p.pending = {
      qid, nodeId, mode, level, askedAt: now(), payload, regionId: n.region, qkind: q.kind, // regionId / qkind は出来事の記録(answer)用
      answerKind: q.answerKind || 'choice', answerIndex: q.answerIndex, fields: q.fields || null, compare: q.compare || null, verifier: q.verifier || null,
      explanation: q.explanation, defenseNote: q.defenseNote || null,
    };
    return payload;
  }

  // 解答。4 択は choice(0〜3)、入力式は inputs(文字列の配列。欄の数だけ)。判定は questions/normalize.js の judge
  async answer(p, qid, answer) {
    const pend = p.pending;
    if (!pend || pend.qid !== qid) throw new Error('この問題はもう終わっています');
    if (now() - (pend.askedAt || 0) < this.minAnswerMs) {
      this.events.add('limit', { playerId: p.id, teamId: p.team || undefined, ip: p.ws && p.ws.ip, detail: { rule: 'fast', ms: now() - (pend.askedAt || 0) } });
      throw new Error('解答が速すぎます。問題を読んでからもう一度答えてください');
    }
    if (pend.answerKind === 'text') {
      if (!Array.isArray(answer) || answer.length !== (pend.fields || []).length) throw new Error('入力欄の数が合いません');
      for (let i = 0; i < answer.length; i++) {
        const max = pend.fields[i].format === 'prefixplan' ? 1000 : 200;
        if (typeof answer[i] !== 'string' || answer[i].length > max) throw new Error('入力が長すぎます');
      }
    } else if (!Number.isInteger(answer)) throw new Error('選択肢を選んでください');
    p.pending = null; this.touch(p);
    const correct = judge({ answerKind: pend.answerKind, answerIndex: pend.answerIndex, fields: pend.fields, compare: pend.compare, verifier: pend.verifier }, answer);
    const answeredAt = now(), sec = Math.round((answeredAt - (pend.askedAt || answeredAt)) / 100) / 10; // 出題から解答までの秒(小数 1 桁)
    this.bumpStats(p, pend.level, correct, sec); // 学習記録の集計値。保存は下の persistPlayer(不正解)か apply の中の保存に乗せる
    let outcome, cooldownMs = 0;
    if (correct) { p.wrongStreak = 0; outcome = await this.apply(p, pend.nodeId, pend.mode, pend.level); }
    else {
      // 連続不正解で待ち時間を倍増(4 → 8 → 16 → 32 → 60 秒)。保存するので再接続しても消えない(SECURITY.md F4)
      p.wrongStreak = (p.wrongStreak || 0) + 1;
      cooldownMs = Math.min(COOLDOWN_MAX_MS, COOLDOWN_MS * 2 ** (p.wrongStreak - 1));
      p.cooldownUntil = now() + cooldownMs;
      outcome = `不正解。通信が ${Math.round(cooldownMs / 1000)} 秒止まります${p.wrongStreak > 1 ? `(連続 ${p.wrongStreak} 回目。正解すると戻ります)` : ''}`;
      await this.persistPlayer(p);
    }
    // 出来事の記録(問題の本文・選択肢・答え・qid は書かない)。at は解答の時刻なので、apply が積んだ intrude / capture より前に並ぶ
    this.events.add('answer', {
      at: answeredAt, playerId: p.id, teamId: p.team || undefined, nodeId: pend.nodeId, regionId: pend.regionId, level: pend.level, ok: correct, sec, ip: p.ws && p.ws.ip,
      detail: { mode: pend.mode, qkind: pend.qkind, answerKind: pend.answerKind, wrongStreak: p.wrongStreak, cooldownMs, provisional: !!(pend.payload && pend.payload.provisional) },
    });
    const answers = pend.answerKind === 'text' ? (pend.fields || []).map((f) => (f.accept && f.accept[0]) || '') : null;
    return { t: 'result', qid, correct, answerIndex: pend.answerKind === 'text' ? null : pend.answerIndex, answers, explanation: pend.explanation, defenseNote: pend.defenseNote, outcome, cooldownUntil: p.cooldownUntil, cooldownMs };
  }

  // 学習記録の集計値(players.stats。LOGS.md 3.2、2026-10-18 決定): 出題レベルごと(byLevel)と 100 ごとの領域(byBand。鍵は 100 の位、0 = Lv1〜99)。
  // minSec は正解した解答の最短秒。保存は既存の persistPlayer に乗せる(追加の書き込みはしない)
  bumpStats(p, level, ok, sec) {
    const s = p.stats && typeof p.stats === 'object' ? p.stats : (p.stats = { answers: 0, correct: 0, minSec: null, byLevel: {}, byBand: {}, updatedAt: 0 });
    s.byLevel = s.byLevel || {}; s.byBand = s.byBand || {};
    s.answers = (s.answers || 0) + 1;
    if (ok) { s.correct = (s.correct || 0) + 1; if (s.minSec === null || s.minSec === undefined || sec < s.minSec) s.minSec = sec; }
    for (const [m, k] of [[s.byLevel, String(level)], [s.byBand, String(Math.floor(level / 100))]]) {
      const e = m[k] || (m[k] = { n: 0, ok: 0, secSum: 0 });
      e.n++; if (ok) e.ok++; e.secSum = Math.round((e.secSum + sec) * 10) / 10;
    }
    s.updatedAt = now();
  }

  // 正解したときの効果。状況が変わっていたら反映しない。level は出題レベル(出来事の記録用)
  async apply(p, nodeId, mode, level = null) {
    const n = this.nodes.get(nodeId);
    if (!n) return '状況が変わったため反映されませんでした';
    const ev = { playerId: p.id, teamId: p.team || undefined, nodeId: n.id, regionId: n.region };
    if (mode === 'fortify') {
      if (n.owner !== p.id) return `${n.name} はもう自分の拠点ではありません`;
      this.settle(n);
      n.defense += 1; n.fortifiedAt = now();
      p.score = (p.score || 0) + 1;
      this.addLog(`${p.name} が ${n.name} を強化(出題 Lv${this.levelFor(n, 'attack')})`);
      await this.persistNode(n); await this.persistPlayer(p);
      this.events.add('fortify', { ...ev, level: this.levelFor(n, 'attack'), detail: { defense: n.defense } });
      this.emitNode(n); this.emitPlayers();
      return `${n.name} を強化しました。攻める側の出題は Lv${this.levelFor(n, 'attack')} になります`;
    }
    if (!(await this.canAttack(p.id, nodeId))) return '状況が変わったため反映されませんでした';
    // 回数制(第 14 章): つながりの本数(hits)ぶん正解したら占領。ひとりなら自分、チームならチームの合計
    const key = this.attackKey(p);
    n.progress = n.progress || {};
    n.progress[key] = (n.progress[key] || 0) + 1;
    const hits = n.hits || 1;
    if (n.progress[key] < hits) {
      this.addLog(`${p.name} が ${n.name} に侵入(${n.progress[key]}/${hits})`);
      await this.persistNode(n);
      this.events.add('intrude', { ...ev, level: level === null ? undefined : level, detail: { progress: n.progress[key], hits, key } });
      this.emitNode(n);
      return `${n.name} に侵入しました(突破まで あと ${hits - n.progress[key]} 回)`;
    }
    const prev = n.owner ? await this.getPlayer(n.owner) : null;
    const gained = this.valueOf(n);
    const defenseBefore = n.defense || 0;
    if (prev) { prev.nodesOwned = Math.max(0, (prev.nodesOwned || 0) - 1); prev.score = Math.max(0, (prev.score || 0) - gained); }
    this.events.add('capture', { ...ev, level: level === null ? undefined : level, ip: p.ws && p.ws.ip, detail: { prevOwner: prev ? prev.id : null, prevTeam: prev ? prev.team || null : null, gained, hits, defenseBefore } });
    n.owner = p.id; n.defense = 0; n.fortifiedAt = now(); n.progress = {};
    this.invalidateReach(p.id); if (prev) this.invalidateReach(prev.id);
    p.points = (p.points || 0) + gained;
    p.nodesOwned = (p.nodesOwned || 0) + 1;
    this.bumpWeek(p); p.weekPoints += gained; p.weekNodes += 1;
    p.score = (p.score || 0) + this.valueOf(n);
    this.addLog(prev ? `${p.name} が ${prev.name} から ${n.name} を奪取` : `${p.name} が ${n.name} に到達`);
    await this.persistNode(n); await this.persistPlayer(p);
    if (prev) { await this.persistPlayer(prev); if (prev.nodesOwned === 0) await this.respawn(prev); }
    this.emitNode(n); this.emitPlayers();
    await this.updateControl(n);
    return `${n.name} を獲得しました(+${gained}点)`;
  }

  // ---------- 地域の支配(第 14.2 節): 配下の 3/4 以上を持つプレイヤーかチームが支配。上の段へ順に集計 ----------
  controllerOf(total, counts) {
    if (!total) return null;
    for (const [k, v] of Object.entries(counts)) if (v * CONTROL_DEN >= total * CONTROL_NUM) return k;
    return null;
  }
  // 地域マスターの索引(メモリ)。支配の集計はこの中のオブジェクトを書き換えて保存するので、1 台のサーバーでは常に新しい
  async regionIndex() {
    if (this.regionCache && now() - this.regionCache.at < REGION_TTL_MS) return this.regionCache;
    const list = await this.store.loadRegions();
    const byId = new Map(list.map((r) => [r.id, r]));
    const children = new Map();
    for (const r of list) if (r.parent) { if (!children.has(r.parent)) children.set(r.parent, []); children.get(r.parent).push(r); }
    this.regionCache = { at: now(), list, byId, children };
    return this.regionCache;
  }
  invalidateRegions() { this.regionCache = null; }
  async updateControl(n) {
    if (n.isPlayerNode || !n.region) return false;
    const idx = await this.regionIndex();
    const region = idx.byId.get(n.region) || await this.store.loadRegion(n.region);
    if (!region) return false;
    // 区・市: 配下のハック可の固定拠点を所有者(チーム)ごとに数える
    const { total, byOwner } = await this.store.countOwners(this.country, n.region);
    const counts = {};
    for (const [owner, cnt] of Object.entries(byOwner)) {
      const o = await this.getPlayer(owner);
      const key = o ? this.attackKey(o) : owner;
      counts[key] = (counts[key] || 0) + cnt;
    }
    let changed = await this.saveControl(region, total, counts);
    // 上の段: 配下の地域のうち、同じ支配者が 3/4 以上
    let cur = region;
    while (cur.parent) {
      const parent = idx.byId.get(cur.parent) || await this.store.loadRegion(cur.parent);
      if (!parent) break;
      // 分母は拠点のある配下だけ(全国の区・市を入れたので、駅の無い町村まで数えると支配が成り立たない。2026-10-19)
      const children = (idx.children.get(parent.id) || await this.store.loadRegionChildren(parent.id)).filter((ch) => (ch.nodeCount || 0) > 0 || (ch.control && ch.control.total > 0));
      const c2 = {};
      for (const ch of children) { const k = ch.control && ch.control.controller; if (k) c2[k] = (c2[k] || 0) + 1; }
      if (await this.saveControl(parent, children.length, c2)) changed = true;
      cur = parent;
    }
    return changed;
  }
  async saveControl(region, total, counts) {
    const controller = this.controllerOf(total, counts);
    const before = (region.control && region.control.controller) || null;
    region.control = { total, counts, controller: controller || null, updatedAt: now() };
    try { await this.store.saveRegion(region); } catch (e) { console.error('地域の保存に失敗:', e.message); }
    if (before === (controller || null)) return false;
    this.events.add('control', { regionId: region.id, detail: { tier: region.tier, before, after: controller || null, total, count: counts[controller || before] || 0 } });
    if (controller) { const who = await this.controllerInfo(controller); this.addLog(`${who ? (who.kind === 'team' ? 'チーム「' + who.name + '」' : who.name) : controller} が ${region.name} を支配しました`); }
    else { const b = await this.controllerInfo(before); this.addLog(`${b ? (b.kind === 'team' ? 'チーム「' + b.name + '」' : b.name) : before} の ${region.name} の支配が崩れました`); }
    return true;
  }
  // 支配者(プレイヤー id かチーム id)の表示用の情報。チームならリーダーが決めた見た目つき
  async controllerInfo(key) {
    if (!key) return null;
    const p = await this.getPlayer(key);
    if (p) return { id: p.id, kind: 'player', name: p.name, color: p.color };
    const t = await this.teamInfo(key);
    if (t) { const pt = this.pubTeam(t); return { id: t.id, kind: 'team', name: t.name, color: pt.style.fill, style: pt.style, icon: pt.icon }; }
    return null;
  }
  // 縮小表示に添える地域の支配(見えている範囲に中心がある地域だけ)
  async regionsInView(tiles, z) {
    const tier = REGION_TIER_BY_Z[z];
    if (!tier || !tiles.length) return [];
    const s = tileSize(z);
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const t of tiles) {
      const q = parseTile(t); if (!q) continue;
      minLat = Math.min(minLat, q.y * s.lat); maxLat = Math.max(maxLat, (q.y + 1) * s.lat);
      minLon = Math.min(minLon, q.x * s.lon); maxLon = Math.max(maxLon, (q.x + 1) * s.lon);
    }
    const all = (await this.regionIndex()).list;
    const out = [];
    for (const r of all) {
      if (r.tier !== tier || !r.center) continue;
      if (r.center.lat < minLat || r.center.lat > maxLat || r.center.lon < minLon || r.center.lon > maxLon) continue;
      out.push({ id: r.id, name: r.name, tier: r.tier, pref: r.state || (r.tier === 5 ? r.id : null), lat: r.center.lat, lon: r.center.lon, nodeCount: r.nodeCount || 0,
        total: r.control ? r.control.total : 0, controller: await this.controllerInfo(r.control && r.control.controller) });
    }
    return out;
  }

  // 拠点をすべて失った人は東京に再生成する(自分の拠点は占領されないので通常は起きない。保険として残す)
  async respawn(p) {
    await this.spawnHome(p);
    this.addLog(`${p.name} の拠点がすべて失われたため、東京に新しい拠点が生まれました`);
    await this.persistPlayer(p);
  }

  addLog(text) {
    this.log.push({ at: now(), text });
    if (this.log.length > LOG_MAX) this.log.shift();
  }

  // 参加直後に送る自分の情報
  // 自分の拠点がある都道府県の名前(画面右上の表示用)。地域の索引がメモリにあるときだけ(参加の処理で読み込み済み)
  areaNameOf(p) {
    const home = p.homeNodeId ? this.nodes.get(p.homeNodeId) : null;
    const idx = this.regionCache;
    if (!home || !idx) return null;
    const r = idx.byId.get(home.region);
    const pref = r && r.state ? idx.byId.get(r.state) : null;
    return pref ? pref.name : (r ? r.name : null);
  }
  // 自分の拠点はメモリ(タイルのキャッシュ)に無いことがある(再起動・しばらく見ていない範囲の解放)。無ければ保存から読む。
  // 読めないと画面は既定の開始地点(東京)へ戻ってしまう(2026-10-19 の不具合: 引っ越し後のホームボタンが引っ越し前を出す)
  async welcome(p) {
    let home = null;
    if (p.homeNodeId) {
      home = this.nodes.get(p.homeNodeId) || null;
      if (!home) { const d = await this.store.loadNode(p.homeNodeId); if (d) home = this.adopt(d); }
    }
    // 自分の拠点が無いときの目安は、選んだ開始地点(無ければ東京)
    let spawn = tokyo.SPAWN_CENTER;
    if (!home && p.startNodeId) { try { const s = await this.startNode(p); spawn = { ...spawn, lat: s.lat, lon: s.lon, name: s.name }; } catch { /* 選べない開始地点なら既定のまま */ } }
    return { t: 'welcome', id: p.id, token: p.token, name: p.name, country: p.country || this.country, startNodeId: p.startNodeId || null, movedAt: p.movedAt || null, area: this.areaNameOf(p),
      team: p.team || null, teamName: p.team ? (this.teamNames.get(p.team) || null) : null, cooldownUntil: p.cooldownUntil || 0,
      home: home ? { id: home.id, lat: home.lat, lon: home.lon } : null, spawn };
  }
}

module.exports = { World, PROTECT_MS, PROTECT_MAX_NODES, MAX_LEVEL, DECAY_MS, NEWBIE_MS, IDLE_MS, MOVE_INTERVAL_MS, COOLDOWN_MS, COOLDOWN_MAX_MS, TEAM_MAX_MEMBERS, TEAM_ICONS, weekKeyOf };
