'use strict';
// 出来事の記録(docs/LOGS.md)。画面に流す活動ログ(world.addLog)とは別に、集計と調査に使う構造化した記録を events コンテナーへ残す。
//   dayOf(t)              日本時間の日付 "YYYY-MM-DD"(weekKeyOf と同じ計算。サーバーの時刻帯に依存しない)
//   hashSrc(ip, day)      接続元のハッシュ(SHA-256 の先頭 16 桁)。塩は LOG_SALT + day なので日をまたいだ追跡はできない。生の IP は保存しない
//   makeEvent(kind, f)    id / type / day / at / ttl を埋めた 1 件。ip を渡せば src に変えて ip は捨てる。undefined の項目は落とす
//   EventLog              同期 add でバッファに積み、1 秒または 50 件で store.appendEvents にまとめ書き。失敗は console.error だけ(ゲームを止めない)
//   noopEvents()          何もしない EventLog(テストや events を渡さないときの既定)
// 残さないもの: 問題の本文・選択肢・正解、復帰コード、生の IP(LOGS.md 1.2・3.4)。

const crypto = require('crypto');

const DAY_S = 24 * 60 * 60;
// 種類ごとの保持期間(秒)。無い種類はコンテナーの既定(90 日)に任せる。無期限は -1(LOGS.md 2.2、2026-10-18 決定)
const TTL_BY_KIND = {
  join: 365 * DAY_S, resume: 90 * DAY_S, leave: 90 * DAY_S,
  answer: 30 * DAY_S, intrude: 90 * DAY_S, capture: 365 * DAY_S, fortify: 90 * DAY_S,
  move: 365 * DAY_S, 'team.create': 365 * DAY_S, 'team.join': 365 * DAY_S, 'team.leave': 365 * DAY_S, 'team.style': 90 * DAY_S,
  control: 365 * DAY_S, 'control.daily': -1, reclaim: 365 * DAY_S, rekey: 365 * DAY_S,
  limit: 90 * DAY_S, error: 30 * DAY_S,
  'item.grant': 3 * 365 * DAY_S, 'item.use': 365 * DAY_S, // アイテムを渡した・使った(2026-10-22)。渡したのはのちの支払いの記録とつき合わせるので長めに残す
  'chat.report': 365 * DAY_S, 'chat.block': 90 * DAY_S, // チャットの通報(書き込みの写しつき。管理者が見る)とブロック(2026-10-21)
};
const DEFAULT_TTL = 90 * DAY_S; // コンテナー既定(defaultTtl)。store-cosmos.js の CONTAINERS と一致させる
const FLUSH_MS = 1000;
const BATCH = 50;
const BUFFER_MAX = 5000;
const RANDOM_SALT = crypto.randomBytes(16).toString('hex'); // LOG_SALT が無いときの塩(再起動で変わる)

function dayOf(t = Date.now()) {
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function hashSrc(ip, day = dayOf()) {
  if (!ip) return undefined;
  const salt = process.env.LOG_SALT || RANDOM_SALT;
  return crypto.createHash('sha256').update(`${salt}${day}${ip}`).digest('hex').slice(0, 16);
}

// undefined の項目を落とす(1 段)。null は残す(「前の所有者なし」などの意味がある)
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function makeEvent(kind, fields = {}) {
  const { id, at: atIn, ip, detail, ttl, ...rest } = fields;
  const at = Number.isFinite(atIn) ? atIn : Date.now();
  const day = dayOf(at);
  const doc = compact({
    id: id || `${at}-${crypto.randomBytes(2).toString('hex')}`,
    type: 'event', day, at, kind,
    ...compact(rest),
    src: rest.src || hashSrc(ip, day),
    detail: detail && typeof detail === 'object' ? compact(detail) : undefined,
    ttl: ttl !== undefined ? ttl : TTL_BY_KIND[kind],
  });
  return doc;
}

class EventLog {
  constructor(store, { flushMs = FLUSH_MS, batch = BATCH, max = BUFFER_MAX } = {}) {
    this.store = store;
    this.flushMs = flushMs; this.batch = batch; this.max = max;
    this.buf = [];
    this.timer = null;
    this.inflight = new Set();
    this.warned = false;
    this.dropped = 0;
  }
  get size() { return this.buf.length; }
  // 同期。例外を出さず、戻り値もない。ゲームの処理を待たせない
  add(kind, fields) {
    try {
      this.buf.push(makeEvent(kind, fields));
      if (this.buf.length > this.max) {
        const over = this.buf.length - this.max;
        this.buf.splice(0, over); this.dropped += over;
        if (!this.warned) { this.warned = true; console.error(`出来事の記録がたまりすぎたため古いものを捨てました(${over} 件。上限 ${this.max})`); }
      }
      if (this.buf.length >= this.batch) this.flush();
      else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.flushMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
      }
    } catch (e) {
      console.error('出来事の記録に失敗:', e && e.message);
    }
  }
  // たまった分をまとめて保存する。失敗は console.error だけ(再試行しない)
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buf.length) return Promise.resolve();
    const docs = this.buf; this.buf = [];
    let p;
    try { p = Promise.resolve(this.store.appendEvents(docs)); } catch (e) { p = Promise.reject(e); }
    const done = p.catch((e) => { console.error('ログの保存に失敗:', e && e.message); }).finally(() => this.inflight.delete(done));
    this.inflight.add(done);
    return done;
  }
  // 終了時: 残りを flush し、送信中のものを待つ
  async stop() {
    await this.flush();
    await Promise.all([...this.inflight]);
  }
}

function noopEvents() {
  return { add() {}, flush: async () => {}, stop: async () => {}, size: 0 };
}

module.exports = { dayOf, hashSrc, makeEvent, EventLog, noopEvents, TTL_BY_KIND, DEFAULT_TTL };
