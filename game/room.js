'use strict';
const crypto = require('crypto');
const { NODES, ADJ, byId, SPAWNS } = require('./map');
const { makeQuestion } = require('./questions');

const GAME_MS = 4 * 60 * 1000;
const COOLDOWN_MS = 4000;
const MAX_PLAYERS = 6;
const MAX_LEVEL = 3;
const OFFLINE_GRACE_MS = 60 * 1000;
const COLORS = ['#E60012', '#0068B7', '#00A040', '#F08300', '#8F5BA6', '#00A0DE'];
const BOT_NAMES = ['ボット・ルータ', 'ボット・スイッチ', 'ボット・ゲート', 'ボット・ハブ', 'ボット・ノード'];

const newId = () => crypto.randomBytes(6).toString('hex');

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.phase = 'lobby';
    this.endsAt = 0;
    this.hostId = null;
    this.log = [];
    this.lastActive = Date.now();
    this.resetNodes();
  }

  resetNodes() {
    this.nodes = Object.fromEntries(NODES.map((n) => [n.id, { id: n.id, owner: null, level: n.baseLevel }]));
  }

  // ---------- 参加・退出 ----------
  join(ws, name, token) {
    this.lastActive = Date.now();
    if (token) {
      for (const p of this.players.values()) {
        if (!p.isBot && p.token === token) {
          p.ws = ws; p.online = true; p.offlineSince = 0; p.name = name || p.name;
          if (!this.hostOnline()) this.hostId = p.id;
          this.addLog(`${p.name} が再接続しました`);
          return p;
        }
      }
    }
    if (this.players.size >= MAX_PLAYERS) throw new Error('この部屋は満員です(最大6人)');
    const p = {
      id: newId(), token: newId(), name, color: this.freeColor(), ws,
      online: true, offlineSince: 0, isBot: false, cooldownUntil: 0, pending: null,
    };
    this.players.set(p.id, p);
    if (!this.hostOnline()) this.hostId = p.id;
    if (this.phase === 'playing') this.giveSpawn(p);
    this.addLog(`${p.name} が参加しました`);
    return p;
  }

  addBot(by) {
    if (by.id !== this.hostId) throw new Error('ボットを追加できるのはホストだけです');
    if (this.players.size >= MAX_PLAYERS) throw new Error('この部屋は満員です(最大6人)');
    const used = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || 'ボット';
    const bot = {
      id: newId(), name, color: this.freeColor(), online: true, isBot: true,
      cooldownUntil: 0, pending: null, nextActAt: Date.now() + 5000,
    };
    this.players.set(bot.id, bot);
    if (this.phase === 'playing') this.giveSpawn(bot);
    this.addLog(`${name} が参加しました`);
  }

  disconnect(p) {
    p.online = false; p.offlineSince = Date.now(); p.ws = null; p.pending = null;
    if (this.hostId === p.id) {
      const next = [...this.players.values()].find((x) => !x.isBot && x.online);
      this.hostId = next ? next.id : null;
    }
  }

  removePlayer(p) {
    for (const n of Object.values(this.nodes)) if (n.owner === p.id) n.owner = null;
    this.players.delete(p.id);
    this.addLog(`${p.name} が退出しました`);
  }

  hostOnline() {
    const h = this.players.get(this.hostId);
    return !!(h && h.online && !h.isBot);
  }

  freeColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[0];
  }

  humansOnline() {
    return [...this.players.values()].some((p) => !p.isBot && p.online);
  }

  // ---------- 進行 ----------
  start(by) {
    if (by.id !== this.hostId) throw new Error('ゲームを開始できるのはホストだけです');
    if (this.phase === 'playing') return;
    this.resetNodes();
    this.phase = 'playing';
    this.endsAt = Date.now() + GAME_MS;
    for (const p of this.players.values()) {
      p.cooldownUntil = 0; p.pending = null;
      if (p.isBot) p.nextActAt = Date.now() + 4000 + Math.random() * 3000;
      this.giveSpawn(p);
    }
    this.log = [];
    this.addLog('ゲーム開始。隣の拠点へ広がろう');
  }

  giveSpawn(p) {
    const free = SPAWNS.find((id) => !this.nodes[id].owner)
      || NODES.find((n) => n.kind === 'DC' && !this.nodes[n.id].owner)?.id;
    if (free) { this.nodes[free].owner = p.id; this.nodes[free].level = 1; }
  }

  finish() {
    this.phase = 'ended';
    const ranking = this.ranking();
    if (ranking.length) this.addLog(`終了。1位は ${ranking[0].name}(${ranking[0].score}点)`);
  }

  ranking() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, color: p.color, score: this.score(p.id) }))
      .sort((a, b) => b.score - a.score);
  }

  owned(pid) { return Object.values(this.nodes).filter((n) => n.owner === pid); }
  score(pid) { return this.owned(pid).reduce((s, n) => s + byId[n.id].value, 0); }

  canAttack(pid, nodeId) {
    const n = this.nodes[nodeId];
    if (!n || n.owner === pid) return false;
    if (this.owned(pid).length === 0) return true; // 拠点を全部失ったら、どこからでも再侵入できる
    return ADJ[nodeId].some((id) => this.nodes[id].owner === pid);
  }

  // ---------- 問題 ----------
  ask(p, nodeId) {
    if (this.phase !== 'playing') throw new Error('ゲーム中ではありません');
    const n = this.nodes[nodeId];
    if (!n) throw new Error('その拠点はありません');
    const now = Date.now();
    if (now < p.cooldownUntil) throw new Error('通信が回復するまで少し待ってください');
    let mode;
    if (n.owner === p.id) {
      if (n.level >= MAX_LEVEL) throw new Error('この拠点の防御はすでに最大です');
      mode = 'fortify';
    } else if (this.canAttack(p.id, nodeId)) {
      mode = 'attack';
    } else {
      throw new Error('自分の拠点とつながっている拠点だけ攻撃できます');
    }
    const q = makeQuestion(Math.min(3, n.level + 1), byId[nodeId].base);
    p.pending = { qid: newId(), nodeId, mode, answerIndex: q.answerIndex, explanation: q.explanation };
    return {
      t: 'question', qid: p.pending.qid, nodeId, mode, difficulty: q.difficulty,
      text: q.text, options: q.options,
    };
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
      p.cooldownUntil = Date.now() + COOLDOWN_MS;
      outcome = '不正解。通信が4秒止まります';
    }
    return {
      t: 'result', qid, correct, answerIndex: pend.answerIndex,
      explanation: pend.explanation, outcome, cooldownUntil: p.cooldownUntil,
    };
  }

  // 正解したときの効果。状況が変わっていたら反映しない
  apply(p, nodeId, mode) {
    if (this.phase !== 'playing') return 'ゲームが終わっていたため反映されませんでした';
    const n = this.nodes[nodeId];
    const name = byId[nodeId].name;
    if (mode === 'fortify') {
      if (n.owner !== p.id) return `${name} はもう自分の拠点ではありません`;
      n.level = Math.min(MAX_LEVEL, n.level + 1);
      this.addLog(`${p.name} が ${name} の防御を Lv${n.level} に強化`);
      return `${name} の防御が Lv${n.level} になりました`;
    }
    if (!this.canAttack(p.id, nodeId)) return '状況が変わったため反映されませんでした';
    if (n.level > 0) {
      n.level -= 1;
      this.addLog(`${p.name} が ${name} の防御を突破中(残り Lv${n.level})`);
      return `${name} の防御を下げました(残り Lv${n.level})`;
    }
    const prev = n.owner ? this.players.get(n.owner) : null;
    n.owner = p.id;
    n.level = 0;
    this.addLog(prev ? `${p.name} が ${prev.name} から ${name} を奪取` : `${p.name} が ${name} に到達`);
    return `${name} を獲得しました`;
  }

  // ---------- ボット ----------
  botAct(bot, now) {
    bot.nextActAt = now + 6000 + Math.random() * 4000;
    const mine = this.owned(bot.id);
    const weak = mine.filter((n) => n.level < 1);
    if (weak.length && Math.random() < 0.25) {
      this.apply(bot, weak[Math.floor(Math.random() * weak.length)].id, 'fortify');
      return;
    }
    const targets = NODES.map((n) => n.id).filter((id) => this.canAttack(bot.id, id));
    if (!targets.length) return;
    const neutral = targets.filter((id) => !this.nodes[id].owner);
    const pool = neutral.length && Math.random() < 0.7 ? neutral : targets;
    const target = pool[Math.floor(Math.random() * pool.length)];
    if (Math.random() < 0.7) this.apply(bot, target, 'attack');
  }

  tick(now) {
    if (this.phase === 'playing') {
      if (now >= this.endsAt) { this.finish(); return true; }
      let changed = false;
      for (const p of this.players.values()) {
        if (p.isBot && now >= p.nextActAt) { this.botAct(p, now); changed = true; }
      }
      for (const p of [...this.players.values()]) {
        if (!p.isBot && !p.online && now - p.offlineSince > OFFLINE_GRACE_MS) { this.removePlayer(p); changed = true; }
      }
      return changed;
    }
    let changed = false;
    for (const p of [...this.players.values()]) {
      if (!p.isBot && !p.online && now - p.offlineSince > OFFLINE_GRACE_MS) { this.removePlayer(p); changed = true; }
    }
    return changed;
  }

  addLog(text) {
    this.log.push({ at: Date.now(), text });
    if (this.log.length > 40) this.log.shift();
  }

  snapshot() {
    return {
      t: 'state',
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      endsAt: this.endsAt,
      now: Date.now(),
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, isBot: p.isBot, online: p.online,
        score: this.score(p.id), nodes: this.owned(p.id).length,
      })),
      nodes: Object.values(this.nodes),
      log: this.log.slice(-10),
    };
  }
}

module.exports = { Room, MAX_PLAYERS };
