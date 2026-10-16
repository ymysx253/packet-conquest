'use strict';
// 永続ワールド。部屋も制限時間もない1つの世界で、参加者は東京駅周辺に自分の拠点をもらい、
// 隣の拠点へ広げていく。状態はメモリに持ち、変更のたびに store へ書き込む(設計書 8.2 #13)。

const crypto = require('crypto');
const tokyo = require('./map/tokyo');
const { distanceKm, buildLinks, nearest } = require('./map/geo');
const { getQuestion } = require('./questions');

const COOLDOWN_MS = 4000;               // 不正解のあと操作できない時間
const MAX_DEFENSE = 3;                  // 防御 Lv の上限
const PROTECT_MS = 24 * 60 * 60 * 1000; // 初心者保護: 生まれた拠点は24時間攻撃されない
const PROTECT_MAX_NODES = 3;            // 初心者保護: 所持拠点がこの数以下の人は攻撃されない
const HOME_LINKS = 2;                   // プレイヤーの拠点がつながる近隣拠点の数
const MIN_GAP_KM = 0.15;                // 拠点どうしの最小距離
const LOG_MAX = 60;
const COLORS = [
  '#E60012', '#0068B7', '#00A040', '#F08300', '#8F5BA6', '#00A0DE',
  '#C8005F', '#5C7A00', '#9A6B2E', '#1F7A8C', '#B8860B', '#6B5B95',
];

const newId = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

// 拠点マスター(tokyo.js)を DB の拠点ドキュメントの形にする。初回起動時のシードに使う
function masterToNode(m) {
  return {
    id: m.id, name: m.name, kind: m.kind, kindLabel: m.kindLabel, area: m.area, tags: m.tags || [],
    lat: m.lat, lon: m.lon, level: m.level, value: m.value,
    subnet: m.subnet, base: m.base,
    status: 'public', isPlayerNode: false, registeredBy: null,
    owner: null, defense: 0, protectedUntil: 0, // 突破は常に正解 1 回。難しさは level(+強化)で決める
    createdAt: now(),
  };
}

class World {
  constructor({ store }) {
    this.store = store;
    this.nodes = new Map();
    this.players = new Map();
    this.edges = [];
    this.adj = {};
    this.log = [];
    this.homeSeq = 0;
  }

  // ---------- 起動 ----------
  async init() {
    const saved = await this.store.loadNodes();
    if (saved.length) {
      for (const n of saved) this.nodes.set(n.id, n);
    } else {
      for (const m of tokyo.NODES) {
        const n = masterToNode(m);
        this.nodes.set(n.id, n);
        await this.store.saveNode(n);
      }
    }
    this.homeSeq = [...this.nodes.values()].filter((n) => n.isPlayerNode).length;
    for (const doc of await this.store.loadPlayers()) {
      this.players.set(doc.id, { ...doc, ws: null, online: false, pending: null, cooldownUntil: 0 });
    }
    this.rebuildLinks();
    return this;
  }

  // 公開中の拠点どうしを距離で結び、プレイヤーの拠点は近い拠点につなぐ(拠点が増えても地図が壊れない)
  rebuildLinks() {
    const all = [...this.nodes.values()].filter((n) => n.status === 'public');
    const masters = all.filter((n) => !n.isPlayerNode);
    const edges = buildLinks(masters, 3);
    for (const h of all.filter((n) => n.isPlayerNode)) {
      for (const m of nearest(masters, h.lat, h.lon, HOME_LINKS)) edges.push({ a: h.id, b: m.id });
    }
    this.edges = edges;
    this.adj = Object.fromEntries(all.map((n) => [n.id, []]));
    for (const { a, b } of edges) { this.adj[a].push(b); this.adj[b].push(a); }
  }

  // ---------- 保存(失敗しても遊びは止めない) ----------
  persistNode(n) {
    Promise.resolve(this.store.saveNode(n)).catch((e) => console.error('拠点の保存に失敗:', e.message));
  }
  persistPlayer(p) {
    const { ws, online, pending, cooldownUntil, ...doc } = p;
    Promise.resolve(this.store.savePlayer(doc)).catch((e) => console.error('プレイヤーの保存に失敗:', e.message));
  }

  // ---------- 参加・復帰 ----------
  join(ws, name, token) {
    if (token) {
      const p = [...this.players.values()].find((x) => x.token === token);
      if (p) {
        if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch { /* 古い接続は閉じるだけ */ } }
        p.ws = ws; p.online = true; p.lastSeen = now();
        if (name) p.name = name;
        this.addLog(`${p.name} が戻ってきました`);
        this.persistPlayer(p);
        return p;
      }
    }
    const p = {
      id: newId(), token: newId(), name, color: this.pickColor(),
      points: 0, homeNodeId: null, team: null, createdAt: now(), lastSeen: now(),
      ws, online: true, pending: null, cooldownUntil: 0,
    };
    this.players.set(p.id, p);
    this.spawnHome(p);
    this.addLog(`${p.name} が東京に参加しました`);
    this.persistPlayer(p);
    return p;
  }

  disconnect(p) {
    p.online = false; p.ws = null; p.pending = null; p.lastSeen = now();
    this.persistPlayer(p);
  }

  // いちばん使われていない色を選ぶ
  pickColor() {
    const used = new Map();
    for (const p of this.players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
    return COLORS.reduce((best, c) => ((used.get(c) || 0) < (used.get(best) || 0) ? c : best), COLORS[0]);
  }

  // 東京駅周辺の空いている場所に、プレイヤー専用の拠点を生み、近い拠点とつなぐ
  spawnHome(p) {
    const c = tokyo.SPAWN_CENTER;
    let lat = c.lat, lon = c.lon;
    for (let tries = 0; tries < 60; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const r = c.radiusKm * Math.sqrt(Math.random());
      const la = c.lat + (r / 111) * Math.cos(ang);
      const lo = c.lon + (r / (111 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin(ang);
      const ok = [...this.nodes.values()].every((n) => distanceKm(n, { lat: la, lon: lo }) >= MIN_GAP_KM);
      if (ok) { lat = la; lon = lo; break; }
    }
    // 架空ネットワークは 172.16.0.0/12 の中から /24 を順に割り当てる
    const k = this.homeSeq++;
    const a = 16 + ((k >> 8) % 16), b = k & 255;
    const node = {
      id: `home-${newId()}`, name: `${p.name}の拠点`, kind: 'HOME', kindLabel: 'プレイヤーの拠点', area: tokyo.SPAWN_CENTER.name, tags: [],
      lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), level: 1, value: 1,
      subnet: `172.${a}.${b}.0/24`, base: ((172 << 24) >>> 0) + (a << 16) + (b << 8),
      status: 'public', isPlayerNode: true, registeredBy: p.id,
      owner: p.id, defense: 0, protectedUntil: now() + PROTECT_MS, createdAt: now(),
    };
    this.nodes.set(node.id, node);
    p.homeNodeId = node.id;
    this.rebuildLinks();
    this.persistNode(node);
    return node;
  }

  // ---------- 集計 ----------
  owned(pid) { return [...this.nodes.values()].filter((n) => n.owner === pid); }
  ownedCount(pid) { return this.owned(pid).length; }
  score(pid) { return this.owned(pid).reduce((s, n) => s + n.value, 0); }

  canAttack(pid, nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n || n.status !== 'public' || n.owner === pid) return false;
    if (n.protectedUntil > now()) return false;
    if (n.owner && this.ownedCount(n.owner) <= PROTECT_MAX_NODES) return false;
    return (this.adj[nodeId] || []).some((id) => this.nodes.get(id).owner === pid);
  }

  // 出題レベル。突破は常に正解 1 回で、難しさはレベルだけで決める(設計書 8.8)。
  // 拠点のレベル + 防御強化の段数。他人の陣地はさらに 4 以上(設計書 3.3)。上限 999
  levelFor(n, mode) {
    const base = Math.min(999, Math.max(1, n.level) + (n.defense || 0));
    if (mode === 'fortify') return base;
    return n.owner ? Math.max(4, base) : base;
  }

  // ---------- 問題 ----------
  ask(p, nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n || n.status !== 'public') throw new Error('その拠点はありません');
    if (now() < p.cooldownUntil) throw new Error('通信が回復するまで少し待ってください');
    let mode;
    if (n.owner === p.id) {
      if (n.defense >= MAX_DEFENSE) throw new Error('この拠点の防御はすでに最大です');
      mode = 'fortify';
    } else if (this.canAttack(p.id, nodeId)) {
      mode = 'attack';
    } else if (n.protectedUntil > now()) {
      throw new Error('この拠点は生まれたばかりで守られています');
    } else if (n.owner && this.ownedCount(n.owner) <= PROTECT_MAX_NODES) {
      throw new Error('拠点が少ないプレイヤーは守られています');
    } else {
      throw new Error('自分の拠点とつながっている拠点だけ攻撃できます');
    }
    const level = this.levelFor(n, mode);
    // 同じ拠点を続けて選んだら、作り直さずに出題中の問題を返す(クリックで問題を引き直せない)。
    // 生成問題は別の拠点を選ぶと破棄される。Lv5 以上の固定問題は拠点に紐づき、誰かがクリアするまで同じ問題が残る(設計書 8.6, 8.13)
    if (p.pending && p.pending.nodeId === nodeId && p.pending.mode === mode && p.pending.level === level) return p.pending.payload;
    const q = getQuestion({ level, node: n });
    const qid = newId();
    const payload = { t: 'question', qid, nodeId, mode, level, provisional: !!q.provisional, text: q.text, options: q.options };
    p.pending = { qid, nodeId, mode, level, answerIndex: q.answerIndex, explanation: q.explanation, payload };
    return payload;
  }

  answer(p, qid, choice) {
    const pend = p.pending;
    if (!pend || pend.qid !== qid) throw new Error('この問題はもう終わっています');
    p.pending = null;
    const correct = choice === pend.answerIndex;
    let outcome;
    if (correct) {
      outcome = this.apply(p, pend.nodeId, pend.mode);
    } else {
      p.cooldownUntil = now() + COOLDOWN_MS;
      outcome = '不正解。通信が4秒止まります';
    }
    return {
      t: 'result', qid, correct, answerIndex: pend.answerIndex,
      explanation: pend.explanation, outcome, cooldownUntil: p.cooldownUntil,
    };
  }

  // 正解したときの効果。状況が変わっていたら反映しない
  apply(p, nodeId, mode) {
    const n = this.nodes.get(nodeId);
    if (!n) return '状況が変わったため反映されませんでした';
    if (mode === 'fortify') {
      if (n.owner !== p.id) return `${n.name} はもう自分の拠点ではありません`;
      n.defense = Math.min(MAX_DEFENSE, n.defense + 1);
      this.addLog(`${p.name} が ${n.name} を強化(出題 Lv${this.levelFor(n, 'attack')})`);
      this.persistNode(n);
      return `${n.name} を強化しました。攻める側の出題は Lv${this.levelFor(n, 'attack')} になります`;
    }
    if (!this.canAttack(p.id, nodeId)) return '状況が変わったため反映されませんでした';
    // 正解 1 回で奪取(強化は回数ではなく出題レベルに効く)
    const prev = n.owner ? this.players.get(n.owner) : null;
    n.owner = p.id;
    n.defense = 0;
    p.points += n.value;
    this.addLog(prev ? `${p.name} が ${prev.name} から ${n.name} を奪取` : `${p.name} が ${n.name} に到達`);
    this.persistNode(n);
    this.persistPlayer(p);
    if (prev && this.ownedCount(prev.id) === 0) this.respawn(prev);
    return `${n.name} を獲得しました(+${n.value}点)`;
  }

  // 拠点をすべて失った人は東京駅周辺に再生成する(設計書 8.2 #7 の暫定。累計点などの記録はすべて残る)
  respawn(p) {
    this.spawnHome(p);
    this.addLog(`${p.name} の拠点がすべて失われたため、東京に新しい拠点が生まれました`);
    this.persistPlayer(p);
  }

  addLog(text) {
    this.log.push({ at: now(), text });
    if (this.log.length > LOG_MAX) this.log.shift();
  }

  // ---------- 配信(いまは全体を送る。差分配信は手順6) ----------
  snapshot() {
    return {
      t: 'state',
      now: now(),
      nodes: [...this.nodes.values()].filter((n) => n.status === 'public').map((n) => ({
        id: n.id, name: n.name, kind: n.kind, lat: n.lat, lon: n.lon, level: n.level, value: n.value,
        subnet: n.subnet, owner: n.owner, defense: n.defense, isPlayerNode: n.isPlayerNode,
        protectedUntil: n.protectedUntil,
      })),
      edges: this.edges,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, online: p.online,
        score: this.score(p.id), nodes: this.ownedCount(p.id), points: p.points,
      })),
      log: this.log.slice(-12),
    };
  }
}

module.exports = { World, PROTECT_MS, PROTECT_MAX_NODES, MAX_DEFENSE };
