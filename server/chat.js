'use strict';
// チャット(2026-10-21 ユーザー決定。docs/DESIGN.md 決定記録)
//   - 部屋は 3 種類: 全体(all)・チーム(team:<チーム id>)・個別(dm:<id>|<id>。id は小さい順)
//   - 全体は本登録の人だけ書ける(読むのは誰でも)。チームは仲間全員。お試し版は個別だけ(チームに入れないため)
//   - 1 回 500 字まで。2 秒に 1 回まで。7 日残す(Cosmos DB の chats は TTL で 7 日に消える。メモリ版は読むときに古いものを捨てる)
//   - 悪い言葉と、電話番号・メールアドレスらしいもの(個人情報)は伏せ字にする
//   - 個別はブロックできる(ブロックした相手からは届かない)。書き込みは通報でき、通報は出来事の記録(events の chat.report)に残す
const crypto = require('crypto');

const MAX_LEN = 500;
const INTERVAL_MS = 2000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_N = 100;

// 伏せ字にする言葉(運用で足す)。ひどい悪口・脅し・差別の言葉の代表だけを置く
const NG_WORDS = ['死ね', 'しね', '氏ね', '殺す', 'ころす', '殺すぞ', 'きもい', 'キモい', 'うざい', 'ウザい', 'クズ', 'ゴミ', 'カス'];
const MASKS = [
  /0\d{1,4}[-ー−‐ ]?\d{1,4}[-ー−‐ ]?\d{3,4}/g, // 電話番号らしいもの
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // メールアドレスらしいもの
];
function cleanText(raw) {
  let s = String(raw || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim();
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN);
  for (const w of NG_WORDS) s = s.split(w).join('＊'.repeat(w.length));
  for (const re of MASKS) s = s.replace(re, (m) => '＊'.repeat(Math.min(m.length, 12)));
  return s;
}
const dmRoom = (a, b) => (a < b ? `dm:${a}|${b}` : `dm:${b}|${a}`);

class Chat {
  constructor(world, store, events) { this.world = world; this.store = store; this.events = events; this.lastAt = new Map(); }

  // 部屋の id と、書ける・読めるか。kind: all / team / dm
  roomOf(p, kind, to) {
    if (kind === 'all') return { room: 'all', canWrite: !!p.registered, why: '全体のチャットは本登録した人だけ書けます(本登録は準備中です)' };
    if (kind === 'team') return p.team ? { room: `team:${p.team}`, canWrite: true } : { room: null, why: 'チームに入ると使えます' };
    if (kind === 'dm') {
      if (typeof to !== 'string' || !to || to === p.id) return { room: null, why: '相手を選んでください' };
      return { room: dmRoom(p.id, to), canWrite: true, to };
    }
    return { room: null, why: '部屋が違います' };
  }

  async post(p, { kind, to, text }) {
    const r = this.roomOf(p, kind, to);
    if (!r.room) throw new Error(r.why);
    if (!r.canWrite) throw new Error(r.why);
    const body = cleanText(text);
    if (!body) throw new Error('何も書かれていません');
    const t = Date.now();
    if (t - (this.lastAt.get(p.id) || 0) < INTERVAL_MS) throw new Error('少し待ってから送ってください(2 秒に 1 回まで)');
    if (kind === 'dm') {
      const other = await this.world.getPlayer(to);
      if (!other) throw new Error('相手が見つかりません');
      if ((other.blocks || []).includes(p.id)) throw new Error('この相手には送れません');
    }
    this.lastAt.set(p.id, t);
    const msg = { id: crypto.randomBytes(8).toString('hex'), type: 'chat', room: r.room, kind, from: p.id, fromName: p.name, ...(kind === 'dm' ? { to } : {}), text: body, at: t };
    await this.store.saveChat(msg);
    this.deliver(msg);
    return msg;
  }

  // 届ける: 全体は接続中の全員、チームは仲間、個別は 2 人(ブロックしていれば届けない)
  deliver(msg) {
    for (const q of this.world.players.values()) {
      if (!q.online) continue;
      let ok = false;
      if (msg.kind === 'all') ok = true;
      else if (msg.kind === 'team') ok = q.team && msg.room === `team:${q.team}`;
      else if (msg.kind === 'dm') ok = (q.id === msg.from || q.id === msg.to) && !(q.id === msg.to && (q.blocks || []).includes(msg.from));
      if (ok) this.world.send(q, { t: 'chat', msg: this.pub(msg) });
    }
  }
  pub(m) { return { id: m.id, room: m.room, kind: m.kind, from: m.from, fromName: m.fromName, to: m.to, text: m.text, at: m.at }; }

  async history(p, { kind, to }) {
    const r = this.roomOf(p, kind, to);
    if (!r.room) return { t: 'chatHistory', kind, to: to || null, list: [], note: r.why };
    let list = await this.store.loadChats(r.room, Date.now() - KEEP_MS, HISTORY_N);
    if (kind === 'dm') list = list.filter((m) => !(m.from !== p.id && (p.blocks || []).includes(m.from)));
    return { t: 'chatHistory', kind, to: to || null, list: list.map((m) => this.pub(m)), canWrite: !!r.canWrite, note: r.canWrite ? null : r.why };
  }

  // 個別の相手の一覧(7 日以内にやり取りした人)
  async partners(p) {
    const rows = await this.store.dmPartners(p.id, Date.now() - KEEP_MS);
    const out = [];
    for (const id of rows) { const q = await this.world.getPlayer(id); if (q) out.push({ id, name: q.name, blocked: (p.blocks || []).includes(id) }); }
    return { t: 'chatPartners', list: out };
  }

  async block(p, id, on) {
    if (typeof id !== 'string' || !id || id === p.id) throw new Error('相手が違います');
    const set = new Set(p.blocks || []);
    if (on) set.add(id); else set.delete(id);
    p.blocks = [...set].slice(0, 500);
    await this.world.persistPlayer(p);
    this.events.add('chat.block', { playerId: p.id, detail: { target: id, on: !!on } });
    return { t: 'chatBlock', id, on: !!on };
  }

  // 通報: その書き込みの写しを出来事の記録に残す(管理者が見る)
  async report(p, { room, id }) {
    if (typeof room !== 'string' || typeof id !== 'string') throw new Error('通報する書き込みが違います');
    const m = await this.store.loadChat(room, id);
    if (!m) throw new Error('書き込みが見つかりません(7 日を過ぎると消えます)');
    const mine = m.kind === 'all' || (m.kind === 'team' && m.room === `team:${p.team}`) || (m.kind === 'dm' && (m.from === p.id || m.to === p.id));
    if (!mine) throw new Error('その書き込みは通報できません');
    this.events.add('chat.report', { playerId: p.id, detail: { room: m.room, id: m.id, from: m.from, fromName: m.fromName, text: m.text, at: m.at } });
    return { t: 'chatReport', id };
  }
}

module.exports = { Chat, cleanText, dmRoom, MAX_LEN, INTERVAL_MS, KEEP_MS };
