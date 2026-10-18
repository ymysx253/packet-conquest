'use strict';
// 出来事の記録(docs/LOGS.md)の検証: 日本時間の日付の境界、接続元ハッシュが日替わり、makeEvent の形(ttl、undefined の除去、生の IP を持たない)、
// EventLog のまとめ書き(50 件 / 1 秒)・上限・保存失敗で止まらない・stop で残りを書く、メモリ版の問い合わせ、保存口が壊れていても World の join が通る
const assert = require('assert');
const { dayOf, hashSrc, makeEvent, EventLog, noopEvents, TTL_BY_KIND } = require('../server/events');
const { MemoryStore } = require('../server/store');
const { World } = require('../server/world');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeWs = (ip) => ({ readyState: 1, ip, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} });

(async () => {
  // dayOf: UTC 14:59 は同じ日、UTC 15:00 は日本時間の翌日
  assert.strictEqual(dayOf(Date.UTC(2026, 9, 18, 14, 59, 59)), '2026-10-18');
  assert.strictEqual(dayOf(Date.UTC(2026, 9, 18, 15, 0, 0)), '2026-10-19', 'UTC 15 時 = 日本時間 0 時で日付が変わる');
  assert.strictEqual(dayOf(Date.UTC(2026, 11, 31, 15)), '2027-01-01', '年またぎ');

  // hashSrc: 同じ日・同じ IP なら同じ、日が変わると違う、16 桁の hex、IP が無ければ undefined。LOG_SALT を決めれば再現できる
  const h1 = hashSrc('203.0.113.5', '2026-10-18'), h2 = hashSrc('203.0.113.5', '2026-10-18'), h3 = hashSrc('203.0.113.5', '2026-10-19');
  assert.strictEqual(h1, h2); assert.notStrictEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{16}$/);
  assert.notStrictEqual(hashSrc('203.0.113.6', '2026-10-18'), h1, '別の接続元は別の値');
  assert.strictEqual(hashSrc('', '2026-10-18'), undefined); assert.strictEqual(hashSrc(null, '2026-10-18'), undefined);
  process.env.LOG_SALT = 'test-salt';
  const hs = hashSrc('203.0.113.5', '2026-10-18');
  assert.strictEqual(hs, hashSrc('203.0.113.5', '2026-10-18'));
  assert.notStrictEqual(hs, h1, '塩が違えば値も違う');
  delete process.env.LOG_SALT;

  // makeEvent: id / type / day / at / ttl が埋まり、undefined は落ち、ip は src になって残らない
  const at = Date.UTC(2026, 9, 18, 15, 30); // 日本時間 10-19 0:30
  const ev = makeEvent('capture', { at, playerId: 'p1', teamId: undefined, nodeId: 'st-1', level: 6, ip: '203.0.113.5', detail: { gained: 6, prevOwner: null, nothing: undefined } });
  assert.strictEqual(ev.type, 'event'); assert.strictEqual(ev.day, '2026-10-19'); assert.strictEqual(ev.at, at); assert.strictEqual(ev.kind, 'capture');
  assert.match(ev.id, /^\d+-[0-9a-f]{4}$/);
  assert.strictEqual(ev.ttl, 365 * 86400);
  assert.ok(!('teamId' in ev) && !('ip' in ev) && !('nothing' in ev.detail), 'undefined と ip は残らない');
  assert.strictEqual(ev.detail.prevOwner, null, 'null は残る');
  assert.strictEqual(ev.src, hashSrc('203.0.113.5', '2026-10-19'), 'src は day 込みのハッシュ');
  assert.ok(!JSON.stringify(ev).includes('203.0.113.5'), '生の IP を持たない');
  assert.strictEqual(makeEvent('answer', {}).ttl, 30 * 86400); assert.strictEqual(makeEvent('control.daily', {}).ttl, -1);
  assert.ok(!('ttl' in makeEvent('unknown.kind', {})), '知らない種類はコンテナー既定に任せる');
  assert.strictEqual(makeEvent('control.daily', { id: 'ctl-2026-10-19-tokyo', at }).id, 'ctl-2026-10-19-tokyo', 'id を指定できる(上書き用)');
  for (const k of ['join', 'resume', 'leave', 'answer', 'intrude', 'capture', 'fortify', 'move', 'team.create', 'team.join', 'team.leave', 'team.style', 'control', 'control.daily', 'reclaim', 'rekey', 'limit', 'error']) assert.ok(k in TTL_BY_KIND, `TTL がある: ${k}`);

  // EventLog: 50 件で即 flush、1 件なら 1 秒後に flush
  const calls = [];
  const fake = { appendEvents: async (docs) => { calls.push(docs); } };
  const log = new EventLog(fake, { flushMs: 100 });
  for (let i = 0; i < 49; i++) log.add('answer', { playerId: 'p' });
  assert.strictEqual(calls.length, 0, '50 件に達するまでは書かない');
  log.add('answer', { playerId: 'p' });
  await wait(0);
  assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].length, 50, '50 件たまったらまとめて書く');
  log.add('leave', { playerId: 'p' });
  assert.strictEqual(calls.length, 1);
  await wait(200);
  assert.strictEqual(calls.length, 2); assert.strictEqual(calls[1].length, 1, '時間がたてば残りを書く');
  assert.strictEqual(log.add('x', {}), undefined, 'add は戻り値なし');
  // 上限: 超えたら古いものから捨て、警告は 1 回だけ
  const errors = []; const origError = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const held = { appendEvents: () => new Promise(() => {}) }; // 書き込みが終わらない保存口(バッファだけが育つ)
    const small = new EventLog(held, { flushMs: 100000, batch: 100000, max: 10 });
    for (let i = 0; i < 15; i++) small.add('answer', { level: i });
    assert.strictEqual(small.size, 10, '上限で古いものから捨てる');
    assert.strictEqual(small.buf[0].level, 5, '残るのは新しい 10 件');
    assert.strictEqual(errors.length, 1, '警告は 1 回');
    small.add('answer', { level: 99 });
    assert.strictEqual(errors.length, 1, '2 回目以降は警告しない');
    // 保存の失敗: console.error だけで止まらない。次の flush は新しい分だけ
    const broken = { appendEvents: async () => { throw new Error('接続できません'); } };
    const bl = new EventLog(broken, { flushMs: 20 });
    bl.add('join', { playerId: 'p' });
    await wait(80);
    assert.strictEqual(errors.length, 2, '失敗は console.error 1 回');
    assert.match(errors[1], /ログの保存に失敗/);
    assert.strictEqual(bl.size, 0, '失敗した分は捨てる(再試行しない)');
    const sync = { appendEvents: () => { throw new Error('同期で落ちる'); } };
    const sl = new EventLog(sync, { flushMs: 20 }); sl.add('join', {}); await sl.flush();
    assert.strictEqual(errors.length, 3, '同期の例外も捕まえる');
    // stop: 残りを書き出す
    const st = new EventLog(fake, { flushMs: 100000 });
    st.add('rekey', { playerId: 'p' }); st.add('rekey', { playerId: 'p' });
    await st.stop();
    assert.strictEqual(calls[calls.length - 1].length, 2, 'stop で残りを書く');
    // add が壊れた入力でも例外を出さない
    const nl = new EventLog(fake, { flushMs: 100000 });
    assert.doesNotThrow(() => nl.add('answer', { detail: 'ただの文字列' }));
    assert.doesNotThrow(() => nl.add('answer', null));
  } finally { console.error = origError; }
  // 何もしない版
  const no = noopEvents(); no.add('x', {}); await no.flush(); await no.stop();

  // メモリ版の保存口: upsert、日ごと・種類・プレイヤーで絞る、新しい順、人ごとの複数日、種類ごとの件数
  const store = new MemoryStore();
  const d1 = Date.UTC(2026, 9, 18, 1), d2 = Date.UTC(2026, 9, 19, 1); // 日本時間 10-18 と 10-19
  await store.appendEvents([
    makeEvent('answer', { at: d1, playerId: 'a', ok: true, sec: 3.2 }), makeEvent('answer', { at: d1 + 1000, playerId: 'a', ok: false, sec: 1.1 }),
    makeEvent('capture', { at: d1 + 2000, playerId: 'a', nodeId: 'st-1', regionId: 'tokyo-chiyoda' }), makeEvent('answer', { at: d1 + 3000, playerId: 'b', ok: true, sec: 5 }),
    makeEvent('capture', { at: d2, playerId: 'a', nodeId: 'st-2' }),
  ]);
  const day1 = await store.eventsByDay('2026-10-18');
  assert.strictEqual(day1.length, 4); assert.ok(day1[0].at > day1[3].at, '新しい順');
  assert.strictEqual((await store.eventsByDay('2026-10-18', { kind: 'answer' })).length, 3);
  assert.strictEqual((await store.eventsByDay('2026-10-18', { kind: 'answer', playerId: 'a' })).length, 2);
  assert.strictEqual((await store.eventsByDay('2026-10-18', { regionId: 'tokyo-chiyoda' })).length, 1);
  assert.strictEqual((await store.eventsByDay('2026-10-18', { since: d1 + 2000 })).length, 2);
  assert.strictEqual((await store.eventsByDay('2026-10-18', { limit: 2 })).length, 2);
  assert.strictEqual((await store.eventsOfPlayer('a', ['2026-10-18', '2026-10-19'])).length, 4, '複数日');
  assert.strictEqual((await store.eventsOfPlayer('a', ['2026-10-19'])).length, 1);
  assert.deepStrictEqual(await store.countEventsByKind('2026-10-18'), { answer: 3, capture: 1 });
  await store.appendEvent(makeEvent('control.daily', { id: 'ctl-2026-10-18-tokyo', at: d1, regionId: 'tokyo', detail: { controller: null } }));
  await store.appendEvent(makeEvent('control.daily', { id: 'ctl-2026-10-18-tokyo', at: d1 + 60000, regionId: 'tokyo', detail: { controller: 'x' } }));
  const ctl = await store.eventsByDay('2026-10-18', { kind: 'control.daily' });
  assert.strictEqual(ctl.length, 1); assert.strictEqual(ctl[0].detail.controller, 'x', '同じ id は上書き(upsert)');

  // 保存口の appendEvents が壊れていても、ゲームの join / answer は通る
  const errors2 = []; console.error = (...a) => errors2.push(a.join(' '));
  try {
    const bad = new MemoryStore(); bad.appendEvents = async () => { throw new Error('events コンテナーがありません'); };
    const w = await new World({ store: bad, minAnswerMs: 0, events: new EventLog(bad, { flushMs: 10 }) }).init();
    const p = await w.join(fakeWs('203.0.113.9'), 'テスト', null);
    const [nb] = [...w.adj.get(p.homeNodeId)];
    const q = await w.ask(p, nb);
    const r = await w.answer(p, q.qid, p.pending.answerIndex);
    assert.ok(p.homeNodeId && r.correct, '記録に失敗しても遊べる');
    await w.events.flush();
    assert.ok(errors2.length >= 1 && errors2.every((e) => e.includes('ログの保存に失敗')), '失敗は console.error だけ');
    // World に events を渡さなければ何もしない
    const w0 = await new World({ store: new MemoryStore(), minAnswerMs: 0 }).init();
    await w0.join(fakeWs(), 'だれか', null);
    assert.strictEqual(w0.store.events.size, 0);
  } finally { console.error = origError; }

  console.log('events ok: dayOf, hashSrc, makeEvent, EventLog batching/limit/failure, memory store queries');
})().catch((e) => { console.error(e); process.exit(1); });
