'use strict';
// 新しい番号(server/questions/cl。docs/LEVEL-LIST.md)の問題の見本のページの口(2026-10-22)。手元の確かめ用。
// 環境変数 CL_PREVIEW=1 のときだけ開く。無ければ /cl-preview で始まる道はすべて 404(ページも口も)。本番では開かない。
//   GET  /cl-preview.html, /cl-preview.js   見本のページ(public/ のファイル。開いているときだけふつうに配る)
//   GET  /cl-preview/levels                 → { levels: [{ level, title, kind }] }
//   POST /cl-preview/ask    { level, seed?, hints? } → ゲームと同じ形の問題(world.js の questionPayload。答えは入れない)
//   POST /cl-preview/answer { qid, choice | inputs } → ゲームの result と同じ形(判定は questions/normalize.js の judge)
// 出した問題(答えつき)はこのプロセスのメモリにだけ置く(DB に書かない)。最大 MAX_PENDING 件、古いものから捨てる
const crypto = require('crypto');
const { LEVELS, getClQuestion } = require('./questions/cl');
const { judge } = require('./questions/normalize');
const { questionPayload } = require('./world');

const { normalize } = require('./questions/normalize');

const MAX_PENDING = 200;
const enabled = () => process.env.CL_PREVIEW === '1';

// 画面の形の見本(ダイアログの部品を確かめるための固定の問題。ゲームでは出さない。問題作りの担当の問題ではない)。
// 3 択とヒント、最初の 1 手と IPv4 の 4 つの欄、2 進 8 けたの切り替えボタン、長さつきのアドレスと数字の欄。答えは計算で確かめられるものだけ
const field = (name, label, format, raw, extra = {}) => {
  const f = { name, label, format, ...extra };
  const acc = normalize(format, raw, f);
  if (acc === null) throw new Error(`見本の答えが正規化できません: ${format} ${raw}`);
  return { ...f, accept: [acc] };
};
const SAMPLES = {
  'demo-3': { title: '形の見本: 3 択とヒント', make: () => ({ text: '/26 のサブネット 1 つに含まれるアドレスの数は?', options: ['32', '64', '128'], answerIndex: 1, hint: '/26 は 256 ÷ 4 = 64 個ずつ(32 − 26 = 6 ビット、2 の 6 乗)', explanation: '32 − 26 = 6 ビットがホスト部なので 2^6 = 64 個。' }) },
  'demo-ipv4': { title: '形の見本: IPv4 の 4 つの欄と最初の 1 手', make: () => ({ text: '192.168.10.77/26 のネットワークアドレスは?', answerKind: 'text', fields: [field('net', 'ネットワークアドレス', 'ipv4', '192.168.10.64', { hint: '例: 192.0.2.0' })], firstStep: 'まずブロックの大きさを出す(256 − 192 = 64)', explanation: '/26 のブロックは 64 ずつ(0・64・128・192)。77 は 64〜127 に入るので 192.168.10.64。' }) },
  'demo-bin8': { title: '形の見本: 2 進 8 けたの切り替えボタン', make: () => ({ text: '10 進の 90 を 2 進 8 けたで表すと?', answerKind: 'text', fields: [field('bin', '2 進 8 けた', 'bin', '01011010', { digits: 8, hint: '0 と 1 を 8 桁' })], hint: '128・64・32・16・8・4・2・1 の位に分ける(90 = 64 + 16 + 8 + 2)', explanation: '90 = 64 + 16 + 8 + 2 なので 01011010。' }) },
  'demo-cidr': { title: '形の見本: 長さつきのアドレスと数字の欄', make: () => ({ text: '198.51.100.130/25 が属するネットワーク(長さつき)と、使えるホストの数は?', answerKind: 'text', fields: [field('net', 'ネットワーク', 'ipv4cidr', '198.51.100.128/25', { hint: '例: 192.0.2.0/24' }), field('n', 'ホストの数', 'number', '126', { hint: '例: 30' })], explanation: '/25 は 128 ずつなので 198.51.100.128/25。ホストは 128 − 2 = 126。' }) },
};

function createClPreview() {
  const pending = new Map(); // qid → 問題(答えつき)

  function ask({ level, seed, hints = true } = {}) {
    let q, ent, lv;
    if (typeof level === 'string' && Object.prototype.hasOwnProperty.call(SAMPLES, level)) { // 形の見本
      ent = { title: SAMPLES[level].title, kind: '見本' }; lv = level;
      q = { answerKind: 'choice', ...SAMPLES[level].make(), seed: 0 };
    } else {
      lv = Number(level);
      if (!Number.isInteger(lv) || !LEVELS.has(lv)) throw new Error(`新しい番号の Lv${level} の問題はまだありません`);
      q = getClQuestion({ level: lv, seed: Number.isInteger(seed) && seed >= 0 ? seed : undefined });
      ent = LEVELS.get(lv);
    }
    const qid = crypto.randomBytes(6).toString('hex');
    pending.set(qid, q);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    return { t: 'question', qid, nodeId: null, mode: 'attack', level: lv, seed: q.seed, title: ent.title || '', clKind: ent.kind || '', ...questionPayload(q, { hints: !!hints }) };
  }

  function answer({ qid, choice, inputs } = {}) {
    const q = typeof qid === 'string' ? pending.get(qid) : null;
    if (!q) throw new Error('この問題はもう終わっています');
    const isText = q.answerKind === 'text';
    let ans;
    if (isText) {
      if (!Array.isArray(inputs) || inputs.length !== (q.fields || []).length || inputs.some((x) => typeof x !== 'string' || x.length > 1000)) throw new Error('入力欄の数が合いません');
      ans = inputs;
    } else {
      if (!Number.isInteger(choice) || choice < 0 || choice >= (q.options || []).length) throw new Error('選択肢を選んでください');
      ans = choice;
    }
    pending.delete(qid);
    const correct = judge({ answerKind: q.answerKind, answerIndex: q.answerIndex, fields: q.fields, compare: q.compare, verifier: q.verifier }, ans);
    const answers = isText ? (q.fields || []).map((f) => (f.accept && f.accept[0]) || '') : null;
    return { t: 'result', qid, correct, answerIndex: isText ? null : q.answerIndex, answers, explanation: q.explanation, defenseNote: q.defenseNote || null, outcome: correct ? '見本のページなので、拠点には反映しません' : '見本のページなので、待ち時間はありません' };
  }

  const levels = () => ({
    levels: [...LEVELS.entries()].sort((a, b) => a[0] - b[0]).map(([level, v]) => ({ level, title: v.title || '', kind: v.kind || '' })),
    samples: Object.entries(SAMPLES).map(([id, v]) => ({ level: id, title: v.title, kind: '見本' })),
  });

  // HTTP の口。扱ったら true(扱わない道なら false を返し、ふつうのファイル配信に回す)
  function handle(req, res, url, headers) {
    let p = url.pathname;
    try { p = decodeURIComponent(p); } catch { /* そのまま */ }
    if (!p.toLowerCase().startsWith('/cl-preview')) return false; // Windows のファイルは大文字小文字を区別しないので、小文字にして調べる
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
    if (!enabled()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }); res.end('見つかりません'); return true; }
    if (p === '/cl-preview.html' || p === '/cl-preview.js') return false; // ページはふつうに配る
    if (p === '/cl-preview/levels' && req.method === 'GET') { reply(200, levels()); return true; }
    if ((p === '/cl-preview/ask' || p === '/cl-preview/answer') && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
      req.on('end', () => {
        try {
          const msg = JSON.parse(body || '{}');
          reply(200, p === '/cl-preview/ask' ? ask(msg) : answer(msg));
        } catch (e) { reply(400, { error: (e && e.message) || 'エラー' }); }
      });
      return true;
    }
    reply(404, { error: '見つかりません' });
    return true;
  }

  return { ask, answer, levels, handle, pending };
}

module.exports = { createClPreview, enabled };
