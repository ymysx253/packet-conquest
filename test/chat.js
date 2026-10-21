'use strict';
// チャットの検証(2026-10-21): 全体・チーム・個別、書ける人、500 字・2 秒、伏せ字、ブロック、通報、履歴
const assert = require('assert');
const { World, DEFAULT_START_ID } = require('../server/world');
const { MemoryStore } = require('../server/store');
const { EventLog, dayOf } = require('../server/events');
const { Chat, cleanText, MAX_LEN, INTERVAL_MS } = require('../server/chat');

const fakeWs = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() { this.readyState = 3; } });
const got = (ws) => ws.sent.filter((m) => m.t === 'chat').map((m) => m.msg);

(async () => {
  const store = new MemoryStore();
  const events = new EventLog(store, { flushMs: 100000 });
  const w = await new World({ store, minAnswerMs: 0, events }).init();
  const chat = new Chat(w, store, events);
  const wa = fakeWs(), wb = fakeWs(), wc = fakeWs();
  const a = await w.join(wa, 'あお', null, DEFAULT_START_ID);
  const b = await w.join(wb, 'きい', null, DEFAULT_START_ID);
  const c = await w.join(wc, 'みど', null, DEFAULT_START_ID);
  const pass = () => { for (const p of [a, b, c]) chat.lastAt.set(p.id, 0); }; // 2 秒の待ちを飛ばす(テスト専用)

  // 伏せ字: 悪い言葉、電話番号、メールアドレス。長さは 500 字まで
  assert.strictEqual(cleanText('死ね'), '＊＊');
  assert.ok(!/090-1234-5678/.test(cleanText('電話 090-1234-5678 です')), '電話番号は伏せる');
  assert.ok(!/a@example\.com/.test(cleanText('a@example.com まで')), 'メールアドレスは伏せる');
  assert.strictEqual(cleanText('あ'.repeat(800)).length, MAX_LEN);

  // 全体: 本登録の人だけ書ける(今はまだ誰も本登録していない)
  await assert.rejects(() => chat.post(a, { kind: 'all', text: 'こんにちは' }), /本登録/);
  a.registered = true;
  await chat.post(a, { kind: 'all', text: 'こんにちは' });
  assert.ok(got(wb).some((m) => m.kind === 'all' && m.text === 'こんにちは'), '全体は全員に届く');
  // 2 秒に 1 回まで
  await assert.rejects(() => chat.post(a, { kind: 'all', text: 'もう一回' }), /2 秒/);
  assert.ok(INTERVAL_MS === 2000);

  // チーム: 仲間だけに届く。チームに入っていなければ書けない
  pass();
  await assert.rejects(() => chat.post(b, { kind: 'team', text: 'やあ' }), /チーム/);
  const t = await w.createTeam(a, 'あおチーム', 5);
  await w.joinTeam(b, t.id);
  pass();
  await chat.post(b, { kind: 'team', text: '作戦です' });
  assert.ok(got(wa).some((m) => m.kind === 'team' && m.text === '作戦です'), 'チームの仲間に届く');
  assert.ok(!got(wc).some((m) => m.kind === 'team'), 'チームの外には届かない');

  // チーム内の順位(2026-10-21): 仲間を点数の多い順に
  const ml = await w.teamMemberList(a);
  assert.ok(ml.list.length === 2 && ml.list.every((m) => [a.id, b.id].includes(m.id)) && ml.list[0].score >= ml.list[1].score && 'lastSeen' in ml.list[0], 'チームの仲間の一覧(点数順、最後に来た日)');
  assert.strictEqual((await w.teamMemberList(c)).list.length, 0, 'チームに入っていなければ空');

  // 個別: 2 人にだけ届く。ブロックすると届かない
  pass();
  await chat.post(c, { kind: 'dm', to: a.id, text: 'はじめまして' });
  assert.ok(got(wa).some((m) => m.kind === 'dm' && m.text === 'はじめまして'), '個別は相手に届く');
  assert.ok(!got(wb).some((m) => m.kind === 'dm'), '個別はほかの人には届かない');
  await chat.block(a, c.id, true);
  pass();
  await assert.rejects(() => chat.post(c, { kind: 'dm', to: a.id, text: 'しつこい' }), /送れません/, 'ブロックした相手からは送れない');
  const hist = await chat.history(a, { kind: 'dm', to: c.id });
  assert.ok(hist.list.every((m) => m.from !== c.id), 'ブロックした相手の書き込みは履歴にも出さない');
  await chat.block(a, c.id, false);
  const partners = await chat.partners(a);
  assert.ok(partners.list.some((p) => p.id === c.id), '個別の相手の一覧');

  // 履歴と通報
  const th = await chat.history(a, { kind: 'team' });
  assert.ok(th.list.some((m) => m.text === '作戦です') && th.canWrite, 'チームの履歴');
  const msg = th.list.find((m) => m.text === '作戦です');
  await chat.report(a, { room: msg.room, id: msg.id });
  await assert.rejects(() => chat.report(c, { room: msg.room, id: msg.id }), /通報できません/, 'ほかのチームの書き込みは通報できない');
  await events.flush();
  const reports = await store.eventsByDay(dayOf(Date.now()), { kind: 'chat.report' });
  assert.ok(reports.some((e) => e.detail.id === msg.id && e.detail.text === '作戦です'), '通報は出来事の記録に残る');

  console.log('chat ok: all/team/dm, registered-only all, 500 chars, 2 s, mask, block, report, history');
})().catch((e) => { console.error(e); process.exit(1); });
