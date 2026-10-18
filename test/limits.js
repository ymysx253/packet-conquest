'use strict';
// 接続元ごとの回数制限の検証(SECURITY.md F2)
const assert = require('assert');
const { RateLimiter, clientIp } = require('../server/limits');

let t = 1_000_000;
const lim = new RateLimiter(undefined, () => t);
// 新規作成: 1 時間に 3 回
assert.strictEqual(lim.take('create', 'a'), null);
assert.strictEqual(lim.take('create', 'a'), null);
assert.strictEqual(lim.take('create', 'a'), null);
assert.match(lim.take('create', 'a'), /1 時間に 3 回/);
assert.strictEqual(lim.take('create', 'b'), null, '別の接続元は別に数える');
t += 61 * 60 * 1000;
assert.strictEqual(lim.take('create', 'a'), null, '1 時間たてばまた作れる');
// 1 日に 10 回
for (let i = 0; i < 6; i++) { t += 61 * 60 * 1000; assert.strictEqual(lim.take('create', 'a'), null); }
t += 61 * 60 * 1000;
assert.match(lim.take('create', 'a'), /1 日に 10 回/, '10 回目のあとは 1 日の上限');
t += 25 * 60 * 60 * 1000;
assert.strictEqual(lim.take('create', 'a'), null, '1 日たてばまた作れる');
// 復帰の試行: 1 分に 5 回。超過は記録しない(待てば回復する)
for (let i = 0; i < 5; i++) assert.strictEqual(lim.take('resume', 'a'), null);
assert.match(lim.take('resume', 'a'), /1 分に 5 回/);
t += 61 * 1000;
assert.strictEqual(lim.take('resume', 'a'), null);
// 掃除
t += 48 * 60 * 60 * 1000;
lim.sweep();
assert.strictEqual(lim.hits.size, 0, '古い記録は消える');
// 接続元の IP
assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.2' } }), '203.0.113.5');
assert.strictEqual(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
console.log('limits ok');
