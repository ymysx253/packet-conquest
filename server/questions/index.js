'use strict';
// 問題の取得口。レベル → 生成器の対応はここ 1 か所(設計書 8.18 訂正版、LEVELS.md 第 1〜4 章)。
//   Lv1〜3  サブネット計算(subnet.js の難易度 1〜3)
//   Lv4〜10 アドレッシングの基礎知識(basics.js: VLSM、集約、IPv6、経路表、ARP/MAC 表、ACL、NAT 表)
//   Lv11〜  未実装。実装されるまでは Lv10 までの中で最も近いものを出し、provisional を付ける
// 答えはサーバーだけが持ち、クライアントには送らない(q.meta も送らない)。

const { makeQuestion } = require('./subnet');
const { makeBasics } = require('./basics');

const MAX_IMPLEMENTED = 10;

function getQuestion({ level, node }) {
  const lv = Math.max(1, Math.min(MAX_IMPLEMENTED, level));
  const q = lv <= 3 ? makeQuestion(lv, node.base, node.span || 65534) : makeBasics(lv, node.base);
  return { ...q, level, source: 'generated', provisional: level > MAX_IMPLEMENTED };
}

module.exports = { getQuestion, MAX_IMPLEMENTED };
