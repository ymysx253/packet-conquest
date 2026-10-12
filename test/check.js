'use strict';
const assert = require('assert');
const { makeQuestion, toIp, maskOf, netOf, bcastOf } = require('../server/questions/subnet');
const { NODES } = require('../server/map/japan');
const parseIp = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
let n = 0;
for (let i = 0; i < 30000; i++) {
  const d = 1 + (i % 3), base = NODES[i % NODES.length].base;
  const q = makeQuestion(d, base);
  assert.strictEqual(q.options.length, 4, q.text);
  assert.strictEqual(new Set(q.options).size, 4, q.text);
  assert.ok(q.answerIndex >= 0 && q.answerIndex < 4);
  const ans = q.options[q.answerIndex];
  const m = q.text.match(/(\d+\.\d+\.\d+\.\d+)?\/(\d+)/);
  const p = Number(m[2]); const ip = m[1] ? parseIp(m[1]) : null;
  if (q.type === 'mask') assert.strictEqual(ans, toIp(maskOf(p)));
  if (q.type === 'network') assert.strictEqual(ans, toIp(netOf(ip, p)));
  if (q.type === 'broadcast') assert.strictEqual(ans, toIp(bcastOf(ip, p)));
  if (q.type === 'hosts') assert.strictEqual(ans, (2 ** (32 - p) - 2).toLocaleString('ja-JP'));
  if (q.type === 'same') {
    assert.strictEqual(netOf(parseIp(ans), p), netOf(ip, p));
    q.options.forEach((o, k) => { if (k !== q.answerIndex) assert.notStrictEqual(netOf(parseIp(o), p), netOf(ip, p), q.text + ' ' + o); });
  }
  if (q.type === 'network' || q.type === 'broadcast' || q.type === 'mask') {
    q.options.forEach((o) => assert.match(o, /^\d+\.\d+\.\d+\.\d+$/));
  }
  n++;
}
console.log('questions ok:', n);
