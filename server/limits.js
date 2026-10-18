'use strict';
// 接続元(IP)ごとの回数制限(SECURITY.md F2、2026-10-18 決定)。
//   新規作成: 1 時間に 3 回、1 日に 10 回 / 復帰コードの試行: 1 分に 5 回
// サーバー 1 台のメモリに持つ(複数台にしたら共有ストアへ)。

const RULES = {
  create: [{ max: 3, windowMs: 60 * 60 * 1000, label: '1 時間' }, { max: 10, windowMs: 24 * 60 * 60 * 1000, label: '1 日' }],
  resume: [{ max: 5, windowMs: 60 * 1000, label: '1 分' }],
};

class RateLimiter {
  constructor(rules = RULES, now = Date.now) {
    this.rules = rules;
    this.now = now;
    this.hits = new Map(); // `${kind}|${key}` → 時刻の配列
  }
  // 許可なら null、超過なら理由の文字列を返す。許可したときだけ記録する
  take(kind, key) {
    const rules = this.rules[kind];
    if (!rules) return null;
    const id = `${kind}|${key}`;
    const t = this.now();
    const longest = Math.max(...rules.map((r) => r.windowMs));
    const list = (this.hits.get(id) || []).filter((x) => t - x < longest);
    for (const r of rules) {
      if (list.filter((x) => t - x < r.windowMs).length >= r.max) {
        this.hits.set(id, list);
        return kind === 'create'
          ? `同じ接続元からの新規参加が多すぎます(${r.label}に ${r.max} 回まで)。復帰コードがあれば入力してください`
          : `復帰コードの試行が多すぎます(${r.label}に ${r.max} 回まで)。少し待ってからやり直してください`;
      }
    }
    list.push(t);
    this.hits.set(id, list);
    return null;
  }
  // 古い記録を捨てる(定期的に呼ぶ)
  sweep() {
    const t = this.now();
    for (const [id, list] of this.hits) {
      const kind = id.split('|')[0];
      const longest = Math.max(...(this.rules[kind] || [{ windowMs: 0 }]).map((r) => r.windowMs));
      const keep = list.filter((x) => t - x < longest);
      if (keep.length) this.hits.set(id, keep); else this.hits.delete(id);
    }
  }
}

// 接続元の IP。Azure App Service などの前段からは X-Forwarded-For の先頭が本来の接続元
function clientIp(req) {
  const xf = req.headers && req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim().replace(/:\d+$/, '');
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { RateLimiter, RULES, clientIp };
