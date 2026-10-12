'use strict';
// 問題の取得口。レベルで2系統に分ける(設計書 8.6)。
//   Lv1〜4: その場で自動生成(計算で答えが決まるので常に正確)
//   Lv5〜10: DB に保存した固定問題(フェーズ2で実装。クリアまたは定期更新で差し替える)
// 答えはサーバーだけが持ち、クライアントには送らない。

const { makeQuestion } = require('./subnet');

function getQuestion({ level, node }) {
  if (level <= 4) {
    // 生成器の難易度は 1〜3。Lv4 は手順4で「2問連続」にする
    const q = makeQuestion(Math.min(3, level), node.base);
    return { ...q, level, source: 'generated' };
  }
  throw new Error('この難易度の問題はまだ用意されていません');
}

module.exports = { getQuestion };
