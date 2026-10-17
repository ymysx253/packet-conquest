'use strict';
// 永続ワールド。部屋も制限時間もない 1 つの世界で、参加者は東京駅周辺に自分の拠点をもらい、隣の拠点へ広げていく。
// 全件をメモリに持たず、画面に見えているタイルの拠点だけを保存口から読み込む(設計書 第 13 章、docs/DB.md)。
//   - タイルごとのキャッシュ(拠点とリンク)。リンクは周囲のタイルの拠点とだけ計算する
//   - プレイヤーごとに「見ているタイル」を持ち、拠点が変わったらそのタイルを見ている人だけに差分を送る
//   - プレイヤーの点数と拠点数はプレイヤー ドキュメントの集計値(score, nodesOwned)

const crypto = require('crypto');
const tokyo = require('./map/tokyo');
const { nodeDocs } = require('./map/load');
const { distanceKm, tilesAround, tileOf, tileFields, parseTile, linksForTile, addrOf, MIN_LEVEL_BY_Z } = require('./map/geo');
const { getQuestion } = require('./questions');

const COOLDOWN_MS = 4000;               // 不正解のあと操作できない時間
const MAX_LEVEL = 999;                  // 出題レベルの上限(強化はここまで)
const PROTECT_MS = 24 * 60 * 60 * 1000; // 初心者保護: 生まれた拠点は 24 時間攻撃されない
const PROTECT_MAX_NODES = 3;            // 初心者保護: 所持拠点がこの数以下の人は攻撃されない
const HOME_LINKS = 2;                   // プレイヤーの拠点がつながる近隣拠点の数
const MIN_GAP_KM = 0.15;                // 拠点どうしの最小距離
const LOG_MAX = 60;
const MAX_VIEW_TILES = 80;              // 1 人が一度に見られるタイル数
const TILE_TTL_MS = 10 * 60 * 1000;     // 誰も見ていないタイルをキャッシュから落とすまで
const COLORS = [
  '#E60012', '#0068B7', '#00A040', '#F08300', '#8F5BA6', '#00A0DE',
  '#C8005F', '#5C7A00', '#9A6B2E', '#1F7A8C', '#B8860B', '#6B5B95',
];

const newId = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

class World {
  constructor({ store, country = 'japan' }) {
    this.store = store;
    this.country = country;
    this.tiles = new Map();   // tile id(z0) → { nodes: Map<id, node>, edges: Map<key, {a,b}>, linked: boolean, lastUsed }
    this.nodes = new Map();   // 読み込み済みの拠点 id → node(タイルのキャッシュと同じオブジェクト)
    this.adj = new Map();     // id → Set<id>(読み込み済みのリンクから)
    this.players = new Map(); // id → player(オンラインと最近使った人)
    this.listeners = new Set(); // 配信先(index.js が登録)
    this.log = [];
    this.homeSeq = 0;
  }

  // ---------- 起動 ----------
  async init() {
    if ((await this.store.countNodes()) === 0) {
      await this.store.seedNodes(nodeDocs(tokyo.NODES));
    }
    return this;
  }

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
    for (const t of tiles0) if (!this.tile(t).linked) this.linkTile(t);
  }
  // 読み込んだドキュメントをキャッシュに入れる
  adopt(doc) {
    const existing = this.nodes.get(doc.id);
    if (existing) return existing;
    const n = { ...doc };
    if (!n.base) Object.assign(n, addrOf(n.id));
    const t = n.t0 || tileOf(n.lat, n.lon, 0);
    n.t0 = t;
    this.tile(t).nodes.set(n.id, n);
    this.nodes.set(n.id, n);
    return n;
  }
  linkTile(t) {
    const c = this.tile(t);
    const ok = (n) => n.status === 'public' && n.hackable !== false && !n.isPlayerNode;
    const mine = [...c.nodes.values()].filter(ok);
    const cands = tilesAround(t, 1).flatMap((u) => (this.tiles.has(u) ? [...this.tiles.get(u).nodes.values()].filter(ok) : []));
    for (const e of linksForTile(mine, cands, 3)) this.addEdge(e.a, e.b, t);
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
      level: n.level, value: this.valueOf(n), baseValue: n.value, subnet: n.subnet, owner: n.owner, defense: n.defense,
      isPlayerNode: !!n.isPlayerNode, protectedUntil: n.protectedUntil || 0, hackable: n.hackable !== false, lines: n.lines || [],
    };
  }
  send(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
  // 拠点が変わったら、そのタイルを見ている人へ
  emitNode(n) {
    const msg = { t: 'nodes', nodes: [this.pub(n)] };
    for (const p of this.players.values()) if (p.online && p.view.has(n.t0)) this.send(p, msg);
  }
  async emitPlayers() {
    const top = await this.store.topPlayers(15);
    for (const p of this.players.values()) {
      if (!p.online) continue;
      const list = top.map((x) => this.pubPlayer(x));
      if (!list.some((x) => x.id === p.id)) list.push(this.pubPlayer(p));
      this.send(p, { t: 'players', players: list, log: this.log.slice(-12), now: now() });
    }
  }
  pubPlayer(p) {
    const live = this.players.get(p.id);
    return { id: p.id, name: p.name, color: p.color, online: !!(live && live.online), score: p.score || 0, nodes: p.nodesOwned || 0, points: p.points || 0 };
  }

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
      this.send(p, { t: 'tiles', z: zz, added: list, dropped: [], overview: true, minLevel, nodes: docs.filter((d) => d.status === 'public').map((d) => this.pub(this.adopt(d))), edges: [] });
    }
  }

  // ---------- 参加・復帰 ----------
  async join(ws, name, token) {
    if (token) {
      let p = [...this.players.values()].find((x) => x.token === token);
      if (!p) { const doc = await this.store.findPlayerByToken(token); if (doc) p = this.attach(doc); }
      if (p) {
        if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch { /* 古い接続は閉じるだけ */ } }
        p.ws = ws; p.online = true; p.lastSeen = now(); p.view = new Set();
        if (name) p.name = name;
        this.addLog(`${p.name} が戻ってきました`);
        await this.persistPlayer(p);
        return p;
      }
    }
    const p = this.attach({
      id: newId(), token: newId(), name, color: await this.pickColor(),
      points: 0, score: 0, nodesOwned: 0, homeNodeId: null, team: null, sponsorId: null, createdAt: now(), lastSeen: now(),
    });
    p.ws = ws; p.online = true;
    await this.spawnHome(p);
    this.addLog(`${p.name} が東京に参加しました`);
    await this.persistPlayer(p);
    return p;
  }
  attach(doc) {
    const p = { ...doc, ws: null, online: false, pending: null, cooldownUntil: 0, view: new Set(), viewZ: 0 };
    this.players.set(p.id, p);
    return p;
  }
  async getPlayer(id) {
    if (this.players.has(id)) return this.players.get(id);
    const doc = await this.store.loadPlayer(id);
    return doc ? this.attach(doc) : null;
  }
  async disconnect(p) {
    p.online = false; p.ws = null; p.pending = null; p.lastSeen = now(); p.view = new Set();
    await this.persistPlayer(p);
  }
  async pickColor() {
    const used = new Map();
    for (const p of this.players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
    return COLORS.reduce((best, c) => ((used.get(c) || 0) < (used.get(best) || 0) ? c : best), COLORS[0]);
  }
  async persistPlayer(p) {
    const { ws, online, pending, cooldownUntil, view, viewZ, ...doc } = p;
    doc.type = 'player';
    try { await this.store.savePlayer(doc); } catch (e) { console.error('プレイヤーの保存に失敗:', e.message); }
  }
  async persistNode(n) {
    n.updatedAt = now();
    try { await this.store.saveNode({ ...n, type: 'node' }); } catch (e) { console.error('拠点の保存に失敗:', e.message); }
  }

  // 東京駅周辺の空いている場所に、プレイヤー専用の拠点を生み、近い固定拠点とつなぐ
  async spawnHome(p) {
    const c = tokyo.SPAWN_CENTER;
    await this.ensureTiles(tilesAround(tileOf(c.lat, c.lon, 0), 1));
    let lat = c.lat, lon = c.lon;
    for (let tries = 0; tries < 60; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const r = c.radiusKm * Math.sqrt(Math.random());
      const la = c.lat + (r / 111) * Math.cos(ang);
      const lo = c.lon + (r / (111 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin(ang);
      const near = [...this.nodes.values()].filter((n) => Math.abs(n.lat - la) < 0.01 && Math.abs(n.lon - lo) < 0.012);
      if (near.every((n) => distanceKm(n, { lat: la, lon: lo }) >= MIN_GAP_KM)) { lat = la; lon = lo; break; }
    }
    const k = this.homeSeq++;
    const a = 16 + ((k >> 8) % 16), b = k & 255;
    const id = `home-${newId()}`;
    const node = {
      id, type: 'node', name: `${p.name}の拠点`, genre: null, kind: 'HOME', kindLabel: 'プレイヤーの拠点',
      area: c.name, country: this.country, region: c.region || 'tokyo-chiyoda',
      lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), location: { type: 'Point', coordinates: [Number(lon.toFixed(5)), Number(lat.toFixed(5))] },
      ...tileFields(lat, lon),
      level: 1, value: 1, hackable: true, lines: [], tags: [],
      subnet: `172.${a}.${b}.0/24`, base: ((172 << 24) >>> 0) + (a << 16) + (b << 8), span: 254,
      status: 'public', isPlayerNode: true, registeredBy: p.id, sponsorId: null,
      owner: p.id, defense: 0, protectedUntil: now() + PROTECT_MS, createdAt: now(), updatedAt: now(),
    };
    const n = this.adopt(node);
    const cands = tilesAround(n.t0, 1).flatMap((u) => (this.tiles.has(u) ? [...this.tiles.get(u).nodes.values()] : []))
      .filter((m) => m.status === 'public' && m.hackable !== false && !m.isPlayerNode);
    this.linkHome(n, cands);
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
  valueOf(n) { return (n.value || 0) + (n.defense || 0); }
  score(pid) { const p = this.players.get(pid); return p ? p.score || 0 : 0; }
  ownedCount(pid) { const p = this.players.get(pid); return p ? p.nodesOwned || 0 : 0; }

  async canAttack(pid, nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n || n.status !== 'public' || n.owner === pid) return false;
    if (n.hackable === false) return false;
    if (n.protectedUntil > now()) return false;
    if (n.owner) { const o = await this.getPlayer(n.owner); if (o && (o.nodesOwned || 0) <= PROTECT_MAX_NODES) return false; }
    const nb = this.adj.get(nodeId) || new Set();
    for (const id of nb) { const m = this.nodes.get(id); if (m && m.owner === pid) return true; }
    return false;
  }

  // 出題レベル。突破は常に正解 1 回で、難しさはレベルだけで決める(設計書 3.2)
  levelFor(n, mode) {
    const base = Math.min(MAX_LEVEL, Math.max(1, n.level) + (n.defense || 0));
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
    } else if (n.protectedUntil > now()) {
      throw new Error('この拠点は生まれたばかりで守られています');
    } else if (n.owner && (await this.getPlayer(n.owner) || {}).nodesOwned <= PROTECT_MAX_NODES) {
      throw new Error('拠点が少ないプレイヤーは守られています');
    } else {
      throw new Error('自分の拠点とつながっている拠点だけ攻撃できます');
    }
    const level = this.levelFor(n, mode);
    if (p.pending && p.pending.nodeId === nodeId && p.pending.mode === mode && p.pending.level === level) return p.pending.payload;
    const q = getQuestion({ level, node: n });
    const qid = newId();
    const payload = { t: 'question', qid, nodeId, mode, level, provisional: !!q.provisional, text: q.text, options: q.options, table: q.table || null };
    p.pending = { qid, nodeId, mode, level, answerIndex: q.answerIndex, explanation: q.explanation, payload };
    return payload;
  }

  async answer(p, qid, choice) {
    const pend = p.pending;
    if (!pend || pend.qid !== qid) throw new Error('この問題はもう終わっています');
    p.pending = null;
    const correct = choice === pend.answerIndex;
    let outcome;
    if (correct) outcome = await this.apply(p, pend.nodeId, pend.mode);
    else { p.cooldownUntil = now() + COOLDOWN_MS; outcome = '不正解。通信が4秒止まります'; }
    return { t: 'result', qid, correct, answerIndex: pend.answerIndex, explanation: pend.explanation, outcome, cooldownUntil: p.cooldownUntil };
  }

  // 正解したときの効果。状況が変わっていたら反映しない
  async apply(p, nodeId, mode) {
    const n = this.nodes.get(nodeId);
    if (!n) return '状況が変わったため反映されませんでした';
    if (mode === 'fortify') {
      if (n.owner !== p.id) return `${n.name} はもう自分の拠点ではありません`;
      n.defense += 1;
      p.score = (p.score || 0) + 1;
      this.addLog(`${p.name} が ${n.name} を強化(出題 Lv${this.levelFor(n, 'attack')})`);
      await this.persistNode(n); await this.persistPlayer(p);
      this.emitNode(n); this.emitPlayers();
      return `${n.name} を強化しました。攻める側の出題は Lv${this.levelFor(n, 'attack')} になります`;
    }
    if (!(await this.canAttack(p.id, nodeId))) return '状況が変わったため反映されませんでした';
    const prev = n.owner ? await this.getPlayer(n.owner) : null;
    const gained = this.valueOf(n);
    if (prev) { prev.nodesOwned = Math.max(0, (prev.nodesOwned || 0) - 1); prev.score = Math.max(0, (prev.score || 0) - gained); }
    n.owner = p.id; n.defense = 0;
    p.points = (p.points || 0) + gained;
    p.nodesOwned = (p.nodesOwned || 0) + 1;
    p.score = (p.score || 0) + this.valueOf(n);
    this.addLog(prev ? `${p.name} が ${prev.name} から ${n.name} を奪取` : `${p.name} が ${n.name} に到達`);
    await this.persistNode(n); await this.persistPlayer(p);
    if (prev) { await this.persistPlayer(prev); if (prev.nodesOwned === 0) await this.respawn(prev); }
    this.emitNode(n); this.emitPlayers();
    return `${n.name} を獲得しました(+${gained}点)`;
  }

  // 拠点をすべて失った人は東京に再生成する(暫定。記録は残る)
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
  welcome(p) {
    const home = p.homeNodeId ? this.nodes.get(p.homeNodeId) : null;
    return { t: 'welcome', id: p.id, token: p.token, name: p.name, home: home ? { id: home.id, lat: home.lat, lon: home.lon } : null, spawn: tokyo.SPAWN_CENTER };
  }
}

module.exports = { World, PROTECT_MS, PROTECT_MAX_NODES, MAX_LEVEL };
