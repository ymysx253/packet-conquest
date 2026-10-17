'use strict';
// 問題の取得口。レベルで2系統に分ける(設計書 8.6)。
//   Lv1〜4: その場で自動生成(計算で答えが決まるので常に正確)
//   Lv5〜10: DB に保存した固定問題(フェーズ2で実装。クリアまたは定期更新で差し替える)
// 答えはサーバーだけが持ち、クライアントには送らない。
//
// 暫定(設計書 8.8): Lv4 以上の問題はまだ無い。実装されるまでは Lv3 相当の生成問題を出し、provisional を付ける。
//   Lv4 = 2問連続(手順4) / Lv5 = 経路表(フェーズ2) / Lv6 以降 = トラップ・コマンド(フェーズ2〜3)

const { makeQuestion } = require('./subnet');

// レベル → 生成器の難易度(1〜3)
const GEN_DIFFICULTY = { 1: 1, 2: 2, 3: 3 };

function getQuestion({ level, node }) {
  const difficulty = GEN_DIFFICULTY[level] || 3;
  const q = makeQuestion(difficulty, node.base, node.span || 65534);
  return { ...q, level, source: 'generated', provisional: level >= 4 };
}

module.exports = { getQuestion };
