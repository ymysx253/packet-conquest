'use strict';
// テスト用の敵(2026-10-22 ユーザー依頼): シナリオ(tools/scenarios/*.json)どおりにチームと敵のプレイヤーを作り、サーバーの中で動かす。
// 見ている間だけ動かす前提。環境変数 SIM_BOTS にシナリオのファイルを渡すと、起動のあとに動き出す(server/index.js)。
// 本番のデータベース(packet-conquest)では動かない(2026-10-18 ユーザー決定: 本番 DB にテストのデータを書かない)。手元のメモリ版で使う。
//
// 敵の動き(1 人ずつ paceSec の間隔で):
//   - fortifyRate の割合で、自分の拠点(プレイヤーの拠点以外)を強化する
//   - それ以外は攻める。focusRate の割合で、チームの仲間が攻めている拠点や、ほかのチームの拠点を狙う(囲み・取り合いが起きやすい)
//   - 問題はサーバーの中で受け、thinkSec 待ってから答える。accuracy の割合で正解し、残りはわざと間違える(お手付きの時間はふつうの人と同じ)
// 敵は正解を知っているが、それはサーバーの中だけ。ふつうのプレイヤーに正解を送らない仕組みは変えない
const fs = require('fs');
const { hasGenerator } = require('./questions');

const TEAM_LOOKS = [ // チームの見た目(見分けやすい色。枠・背景・文字)
  { frame: '#B91C1C', fill: '#FCA5A5', text: '#7F1D1D' },
  { frame: '#1D4ED8', fill: '#93C5FD', text: '#1E3A8A' },
  { frame: '#047857', fill: '#6EE7B7', text: '#064E3B' },
  { frame: '#7C3AED', fill: '#C4B5FD', text: '#4C1D95' },
];
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const fakeWs = () => ({ readyState: 1, ip: 'sim', send() {}, close() {} }); // 敵には画面が無い(送る先なし)

class Bots {
  constructor(world, scenario) {
    this.world = world; this.sc = scenario; this.bots = []; this.timers = new Set(); this.stopped = false;
    this.stats = { asks: 0, correct: 0, wrong: 0, captures: 0, errors: 0 };
  }
  async start() {
    const w = this.world, sc = this.sc;
    for (const [ti, t] of sc.teams.entries()) {
      const members = [];
      for (let i = 0; i < t.members; i++) {
        const p = await w.join(fakeWs(), `${t.name}-${i + 1}`.slice(0, 12), null, t.start);
        members.push(p);
      }
      const team = await w.createTeam(members[0], t.name, Math.max(t.members, 5));
      try { await w.styleTeam(members[0], TEAM_LOOKS[ti % TEAM_LOOKS.length]); } catch { /* 見た目は無くても動く */ }
      for (const p of members.slice(1)) await w.joinTeam(p, team.id);
      for (const p of members) this.bots.push({ p, team: team.id });
    }
    console.log(`テスト用の敵: ${sc.teams.length} チーム・${this.bots.length} 人を動かします`);
    for (const b of this.bots) this.schedule(b, rand(1, sc.paceSec[1]));
    return this;
  }
  stop() { this.stopped = true; for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
  schedule(b, sec) {
    if (this.stopped) return;
    const t = setTimeout(() => { this.timers.delete(t); this.act(b).catch(() => { this.stats.errors++; }).finally(() => this.schedule(b, rand(...this.sc.paceSec))); }, sec * 1000);
    this.timers.add(t);
  }
  // 攻められる拠点(自分の拠点から線でたどれる所有拠点の隣)
  async targets(b) {
    const w = this.world, p = b.p, out = new Map();
    for (const id of await w.reach(p)) {
      const n = w.nodes.get(id); if (!n) continue;
      for (const m of new Set([...(n.adj || []), ...(w.adj.get(id) || [])])) {
        if (out.has(m)) continue;
        const t = w.nodes.get(m);
        if (!t || t.owner === p.id || t.isPlayerNode || t.hackable === false || !hasGenerator(w.levelFor(t, 'attack'))) continue;
        if (await w.canAttack(p.id, m)) out.set(m, t);
      }
    }
    return [...out.values()];
  }
  async act(b) {
    const w = this.world, p = b.p, sc = this.sc;
    if (Date.now() < (p.cooldownUntil || 0)) return;
    let nodeId = null;
    if (Math.random() < sc.fortifyRate) {
      const mine = [...w.nodes.values()].filter((n) => n.owner === p.id && !n.isPlayerNode && hasGenerator(Math.min(999, w.levelFor(n, 'fortify') + 1)));
      if (mine.length) nodeId = pick(mine).id;
    }
    if (!nodeId) {
      const ts = await this.targets(b);
      if (!ts.length) return;
      const mates = new Set(this.bots.filter((x) => x.team === b.team).map((x) => x.p.id));
      const focus = ts.filter((t) => Object.keys(t.progress || {}).some((k) => mates.has(k) || k === b.team) || (t.owner && !mates.has(t.owner) && t.owner !== b.team));
      nodeId = (Math.random() < sc.focusRate && focus.length ? pick(focus) : pick(ts)).id;
    }
    const q = await w.ask(p, nodeId);
    this.stats.asks++;
    await new Promise((r) => { const t = setTimeout(() => { this.timers.delete(t); r(); }, rand(...sc.thinkSec) * 1000); this.timers.add(t); });
    if (this.stopped || !p.pending || p.pending.qid !== q.qid) return;
    const pend = p.pending, ok = Math.random() < sc.accuracy;
    let answer;
    if (pend.answerKind === 'text') answer = ok && !pend.verifier ? (pend.fields || []).map((f) => String((f.accept || [''])[0])) : (pend.fields || []).map(() => 'x');
    else answer = ok ? pend.answerIndex : ((pend.answerIndex || 0) + 1 + Math.floor(Math.random() * 3)) % Math.max(2, (pend.payload.options || []).length || 4);
    const before = w.nodes.get(nodeId) && w.nodes.get(nodeId).owner;
    const res = await w.answer(p, q.qid, answer);
    if (res.correct) this.stats.correct++; else this.stats.wrong++;
    const after = w.nodes.get(nodeId) && w.nodes.get(nodeId).owner;
    if (after === p.id && before !== p.id) this.stats.captures++;
  }
}

// シナリオを読んで動かす。本番のデータベースでは動かさない
async function startBots(world, file, { databaseName = null } = {}) {
  if (databaseName === 'packet-conquest') { console.error('テスト用の敵は本番のデータベース(packet-conquest)では動かしません'); return null; }
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Bots(world, scenario).start();
}

module.exports = { Bots, startBots };
