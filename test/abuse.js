'use strict';
// 不正耐性の攻撃テスト(SECURITY.md 第 8 章、フェーズ 1 手順 9)。
// メモリ版のサーバーを別プロセスで起動し、WebSocket で次を確かめる:
//   F1 別サイトの Origin は拒まれる / F3 連打すると切断される・壊れたメッセージは無視される / F6 出題直後の解答は受け付けない
//   T2 隣でない拠点や自分の拠点以外からの攻撃は拒まれる / T3 同じ問題に 2 回答えられない / F2 新規作成の回数制限
//   セキュリティヘッダ(F5)が付く
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3105;
const URL = `ws://localhost:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res, rej) => http.get(`http://localhost:${PORT}${p}`, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', rej));
const client = (opts = {}) => new Promise((res, rej) => {
  const ws = new WebSocket(URL, opts); const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d)));
  ws.on('open', () => res({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)), raw: (s) => ws.send(s) }));
  ws.on('error', rej);
});
const last = (c, t) => [...c.inbox].reverse().find((m) => m.t === t);

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), STORE: 'memory', ALLOWED_ORIGINS: 'https://packet-conquest.com', COSMOS_CONNECTION_STRING: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; }); server.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 100 && !out.includes('http://localhost'); i++) await wait(100);
    assert.ok(out.includes('保存: メモリ'), 'メモリ版で起動する: ' + out);

    // F5 セキュリティヘッダ
    const page = await get('/');
    assert.strictEqual(page.status, 200);
    assert.ok(page.headers['content-security-policy'] && page.headers['content-security-policy'].includes("default-src 'self'"), 'CSP が付く');
    assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(page.headers['x-frame-options'], 'DENY');
    assert.ok(page.headers['referrer-policy'], 'Referrer-Policy が付く');
    assert.strictEqual((await get('/../package.json')).status, 404, 'public の外は出さない');

    // F1 Origin: 別サイトは拒否、自サイト(localhost)と許可リストは通る、Origin 無し(非ブラウザ)は通る
    await assert.rejects(client({ headers: { Origin: 'https://evil.example' } }), /403|Unexpected server response/, '別サイトの Origin は拒否');
    const okOrigin = await client({ headers: { Origin: `http://localhost:${PORT}` } }); okOrigin.ws.close();
    const okListed = await client({ headers: { Origin: 'https://packet-conquest.com' } }); okListed.ws.close();

    // 参加と基本の流れ
    const a = await client();
    a.send({ t: 'join', name: 'あたっかー' }); await wait(300);
    const wa = last(a, 'welcome');
    assert.ok(wa && wa.id, '参加できる');
    const TILE_LAT = 0.025, TILE_LON = 0.03;
    const y = Math.floor(wa.home.lat / TILE_LAT), x = Math.floor(wa.home.lon / TILE_LON);
    const tiles = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push(`t0:${y + dy}:${x + dx}`);
    a.send({ t: 'view', z: 0, tiles }); await wait(400);
    const tl = last(a, 'tiles');
    const nb = tl.edges.filter((e) => e.a === wa.home.id || e.b === wa.home.id).map((e) => (e.a === wa.home.id ? e.b : e.a));
    const far = tl.nodes.find((n) => !n.isPlayerNode && n.hackable && !nb.includes(n.id));

    // T2 画面を書き換えても、隣でない拠点は攻撃できない。1 接続で 2 回目の join は拒否
    a.send({ t: 'ask', nodeId: far.id }); await wait(200);
    assert.match(last(a, 'error').message, /つながっている拠点だけ/);
    a.send({ t: 'join', name: 'にど' }); await wait(200);
    assert.match(last(a, 'error').message, /すでに参加/);

    // F3 壊れたメッセージは無視され、接続は生きている
    a.raw('{not json'); a.raw(JSON.stringify({ t: 42 })); a.raw(JSON.stringify({ t: 'answer', qid: { x: 1 }, choice: 'a' })); a.raw(JSON.stringify({ t: 'view', tiles: 'x' }));
    await wait(200);
    assert.strictEqual(a.ws.readyState, WebSocket.OPEN, '壊れたメッセージで落ちない');

    // F6 出題直後(1 秒未満)の解答は受け付けない。同じ問題にあとで答えられる
    a.send({ t: 'ask', nodeId: nb[0] }); await wait(200);
    const q = last(a, 'question');
    assert.ok(q && q.qid, '出題される');
    a.send({ t: 'answer', qid: q.qid, choice: 0 }); await wait(200);
    assert.match(last(a, 'error').message, /速すぎ|もう一度/, '1 秒未満の解答は拒否');
    assert.ok(!last(a, 'result'), '結果は出ていない');
    await wait(1000);
    a.send({ t: 'answer', qid: q.qid, choice: 0 }); await wait(300);
    const r1 = last(a, 'result');
    assert.ok(r1 && r1.qid === q.qid, '1 秒たてば答えられる');
    // T3 同じ問題にもう一度は答えられない
    a.send({ t: 'answer', qid: q.qid, choice: 1 }); await wait(200);
    assert.match(last(a, 'error').message, /もう終わっています/);

    // F3 連打: 1 秒に大量に送ると切断される
    const flood = await client();
    for (let i = 0; i < 200; i++) flood.raw(JSON.stringify({ t: 'search', q: 'a' }));
    await wait(500);
    assert.notStrictEqual(flood.ws.readyState, WebSocket.OPEN, '連打すると切断される');

    // F2 新規作成の回数制限(同じ接続元から 1 時間 3 回)
    const c1 = await client(); c1.send({ t: 'join', name: 'に' }); await wait(200);
    const c2 = await client(); c2.send({ t: 'join', name: 'さん' }); await wait(200);
    const c3 = await client(); c3.send({ t: 'join', name: 'よん' }); await wait(200);
    assert.ok(last(c1, 'welcome') && last(c2, 'welcome'), '3 回目までは作れる');
    assert.match((last(c3, 'error') || last(c3, 'welcome') && { message: '' } || {}).message || '', /多すぎます/, '4 回目は制限');

    console.log('abuse ok: Origin, headers, validation, flood, min answer time, join limits');
    for (const c of [a, flood, c1, c2, c3]) try { c.ws.close(); } catch { /* 終了 */ }
  } finally {
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
