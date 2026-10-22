'use strict';
// 入門(新しい番号 1〜67。docs/LEVEL-LIST.md 第 2 章)の問題。担当: 入門。書き方は docs/questions/CL.md
const { loadFacts, trueFalse } = require('./build');

const NETWORK_WHAT = loadFacts('intro/network-what.json');

const LEVELS = {
  // Lv1 ネットワークとは(○×)。見本として土台を作ったときに書いた(2026-10-22)
  1: {
    title: 'ネットワークとは', kind: '表', minDistinct: NETWORK_WHAT.length,
    make(rng) {
      const row = rng.pick(NETWORK_WHAT);
      const tf = trueFalse(row.ja, row.attrs.true);
      return {
        text: `次の文は正しいですか。\n「${row.ja}」`, options: tf.options, answerIndex: tf.answerIndex,
        card: 'ネットワークは、2 台以上の機器をつないで、データをやりとりできるようにしたしくみ。ケーブルでも無線でもよく、インターネットにつながっていなくてもよい。',
        explanation: row.attrs.true ? `正しい。${row.ja}。` : `誤り。ネットワークは 2 台以上の機器をつないでデータをやりとりするしくみで、つなぎ方(ケーブル・無線)や台数、インターネットにつながっているかは問わない。`,
        kind: 'cl1-network-what-v1',
      };
    },
  },
};

module.exports = { LEVELS };
