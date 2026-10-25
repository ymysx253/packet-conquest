'use strict';
// 新しい番号(server/questions/cl。docs/LEVEL-LIST.md)の問題の見本のページの口(2026-10-22)。手元の確かめ用。
// 環境変数 CL_PREVIEW=1 のときだけ開く。無ければ /cl-preview で始まる道はすべて 404(ページも口も)。本番では開かない。
//   GET  /cl-preview.html, /cl-preview.js   見本のページ(public/ のファイル。開いているときだけふつうに配る)
//   GET  /cl-preview/levels                 → { levels: [{ level, title, kind }] }
//   POST /cl-preview/ask    { level, seed?, hints? } → ゲームと同じ形の問題(world.js の questionPayload。答えは入れない)
//   POST /cl-preview/answer { qid, choice | inputs | ids | configs } → ゲームの result と同じ形(判定は questions/normalize.js の judgeDetail)
//   POST /cl-preview/term   { qid, line } → { t: 'termOut', qid, line, out, device }(模擬ターミナルの 1 行。SIM-API.md 第 7 章)
// 出した問題(答えつき)はこのプロセスのメモリにだけ置く(DB に書かない)。最大 MAX_PENDING 件、古いものから捨てる
const crypto = require('crypto');
const { LEVELS, getClQuestion } = require('./questions/cl');
const { judgeDetail, normalize } = require('./questions/normalize');
const { questionPayload } = require('./world');
const { makeRng } = require('./questions/rng');
const sim = require('./sim');

const MAX_PENDING = 200;
const TERM_MAX = 60, TERM_MIN_MS = 300; // world.term と同じ上限
const enabled = () => process.env.CL_PREVIEW === '1';

// 画面の形の見本(ダイアログの部品を確かめるための固定の問題。ゲームでは出さない。問題作りの担当の問題ではない)。
// 3 択とヒント、最初の 1 手と IPv4 の 4 つの欄、2 進 8 けたの切り替えボタン、長さつきのアドレスと数字の欄、構成図のタップ、設定を書く、模擬ターミナル。答えは計算で確かめられるものだけ
const field = (name, label, format, raw, extra = {}) => {
  const f = { name, label, format, ...extra };
  const acc = normalize(format, raw, f);
  if (acc === null) throw new Error(`見本の答えが正規化できません: ${format} ${raw}`);
  return { ...f, accept: [acc] };
};
// 構成図の見本の土台: 直列の構成(sim.gen.serial)と、問題ごとの乱数 id(名前 → id。正解の id は画面に送らない)
const demoSpec = (routers) => sim.gen.serial(makeRng(7), { routers });
const randomIds = (spec) => Object.fromEntries(Object.keys(spec.devices).map((n) => [n, crypto.randomBytes(3).toString('hex')]));
const ipOnly = (cidr) => String(cidr).split('/')[0];
function demoTap() {
  const spec = demoSpec(2); const ids = randomIds(spec);
  return {
    text: 'PC1 のデフォルトゲートウェイになっている機器を 1 つタップしてください。', answerKind: 'tap', tap: { mode: 'one' },
    diagram: sim.diagram(spec, { nodeIds: ids }), accept: { ids: [ids.R1] }, sim: { spec },
    explanation: `PC1 のデフォルトゲートウェイは ${spec.devices.PC1.gateway} で、これは R1 の Gi0/0 のアドレス。PC1 がほかの網へ送るパケットは、まず R1 に向かう。`,
  };
}
function demoTerm() {
  const spec = demoSpec(1);
  return {
    text: 'ターミナルで PC1 の設定を見て(ipconfig)、PC1 の IPv4 アドレスを答えてください。', answerKind: 'text',
    fields: [field('ip', 'PC1 の IPv4 アドレス', 'ipv4', ipOnly(spec.devices.PC1.ip), { hint: '例: 192.0.2.10' })],
    terminal: { devices: ['PC1', 'R1'], start: 'PC1' }, sim: { spec },
    explanation: `ipconfig の「IPv4 アドレス」が ${ipOnly(spec.devices.PC1.ip)}。ゲートウェイは ${spec.devices.PC1.gateway}(R1)。`,
  };
}
function demoConfig() {
  const spec = demoSpec(2); const ids = randomIds(spec);
  const lan1 = `${spec.meta.lan1}.0/24`, lan2 = `${spec.meta.lan2}.0/24`;
  const r1Link = ipOnly(spec.devices.R1.ifaces[1].ip), r2Link = ipOnly(spec.devices.R2.ifaces[0].ip);
  spec.devices.R1.routes = []; spec.devices.R2.routes = []; // 往復の静的経路を消しておく(書くのが答え)
  spec.editable = ['R1', 'R2'];
  spec.requirements = [
    { id: 1, kind: 'reach', from: 'PC1', to: 'PC2', proto: 'icmp', roundTrip: true, expect: true },
    { id: 2, kind: 'route', device: 'R1', prefix: lan2, via: r2Link },
    { id: 3, kind: 'route', device: 'R2', prefix: lan1, via: r1Link },
  ];
  const net = sim.build(spec);
  const view = (dev) => { const rc = sim.runningConfig(net, dev); return Array.isArray(rc) ? rc : String(rc || '').split('\n'); };
  return {
    text: 'R1 と R2 に静的経路が無く、PC1 から PC2 に届きません。R1 と R2 に静的経路を書いて、PC1 と PC2 が往復で通信できるようにしてください(書き方: ip route <網>/<長さ> <次の機器のアドレス>)。',
    answerKind: 'config', editable: ['R1', 'R2'], configView: { R1: view('R1'), R2: view('R2') },
    requirementsText: [{ id: 1, text: 'PC1 から PC2 へ往復で届く' }, { id: 2, text: `R1 に ${lan2} への経路(次は ${r2Link})がある` }, { id: 3, text: `R2 に ${lan1} への経路(次は ${r1Link})がある` }],
    diagram: sim.diagram(spec, { nodeIds: ids }), sim: { spec, requirements: spec.requirements },
    solution: [{ device: 'R1', text: `ip route ${lan2} ${r2Link}` }, { device: 'R2', text: `ip route ${lan1} ${r1Link}` }],
    explanation: `正解の例: R1 に「ip route ${lan2} ${r2Link}」、R2 に「ip route ${lan1} ${r1Link}」。行きの経路だけでは返事が戻れないので、両方のルーターに書く。`,
  };
}
const SAMPLES = {
  'demo-3': { title: '形の見本: 3 択とヒント', make: () => ({ text: '/26 のサブネット 1 つに含まれるアドレスの数は?', options: ['32', '64', '128'], answerIndex: 1, hint: '/26 は 256 ÷ 4 = 64 個ずつ(32 − 26 = 6 ビット、2 の 6 乗)', explanation: '32 − 26 = 6 ビットがホスト部なので 2^6 = 64 個。' }) },
  'demo-ipv4': { title: '形の見本: IPv4 の 4 つの欄と最初の 1 手', make: () => ({ text: '192.168.10.77/26 のネットワークアドレスは?', answerKind: 'text', fields: [field('net', 'ネットワークアドレス', 'ipv4', '192.168.10.64', { hint: '例: 192.0.2.0' })], firstStep: 'まずブロックの大きさを出す(256 − 192 = 64)', explanation: '/26 のブロックは 64 ずつ(0・64・128・192)。77 は 64〜127 に入るので 192.168.10.64。' }) },
  'demo-bin8': { title: '形の見本: 2 進 8 けたの切り替えボタン', make: () => ({ text: '10 進の 90 を 2 進 8 けたで表すと?', answerKind: 'text', fields: [field('bin', '2 進 8 けた', 'bin', '01011010', { digits: 8, hint: '0 と 1 を 8 桁' })], hint: '128・64・32・16・8・4・2・1 の位に分ける(90 = 64 + 16 + 8 + 2)', explanation: '90 = 64 + 16 + 8 + 2 なので 01011010。' }) },
  'demo-cidr': { title: '形の見本: 長さつきのアドレスと数字の欄', make: () => ({ text: '198.51.100.130/25 が属するネットワーク(長さつき)と、使えるホストの数は?', answerKind: 'text', fields: [field('net', 'ネットワーク', 'ipv4cidr', '198.51.100.128/25', { hint: '例: 192.0.2.0/24' }), field('n', 'ホストの数', 'number', '126', { hint: '例: 30' })], explanation: '/25 は 128 ずつなので 198.51.100.128/25。ホストは 128 − 2 = 126。' }) },
  'demo-tap': { title: '形の見本: 構成図をタップ', make: demoTap },
  'demo-config': { title: '形の見本: 設定を書く(往復の静的経路)', make: demoConfig },
  'demo-term': { title: '形の見本: 模擬ターミナル', make: demoTerm },
};

function createClPreview() {
  const pending = new Map(); // qid → 問題(答えつき)
  const sessions = new Map(); // qid → { s(ターミナルの session), count, last }

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
    while (pending.size > MAX_PENDING) { const old = pending.keys().next().value; pending.delete(old); sessions.delete(old); }
    return { t: 'question', qid, nodeId: null, mode: 'attack', level: lv, seed: q.seed, title: ent.title || '', clKind: ent.kind || '', ...questionPayload(q, { hints: !!hints }) };
  }

  // 答え。4 択は choice、入力式は inputs、構成図のタップは ids、設定は configs(形の検査は world.answer と同じ)
  function answer({ qid, choice, inputs, ids, configs } = {}) {
    const q = typeof qid === 'string' ? pending.get(qid) : null;
    if (!q) throw new Error('この問題はもう終わっています');
    const kind = q.answerKind || 'choice';
    let ans;
    if (kind === 'text') {
      if (!Array.isArray(inputs) || inputs.length !== (q.fields || []).length || inputs.some((x) => typeof x !== 'string' || x.length > 1000)) throw new Error('入力欄の数が合いません');
      ans = inputs;
    } else if (kind === 'tap') {
      if (!Array.isArray(ids) || !ids.length || ids.length > 12 || ids.some((x) => typeof x !== 'string' || !x || x.length > 64)) throw new Error('答えの形が違います(図で選んでから答えてください)');
      ans = { ids };
    } else if (kind === 'config') {
      if (!Array.isArray(configs) || !configs.length || configs.length > 8 || configs.some((c) => !c || typeof c.device !== 'string' || c.device.length > 16 || typeof c.text !== 'string' || c.text.length > 4800)) throw new Error('答えの形が違います(設定を書いてから答えてください)');
      ans = { configs: configs.map((c) => ({ device: c.device, text: c.text })) };
    } else {
      if (!Number.isInteger(choice) || choice < 0 || choice >= (q.options || []).length) throw new Error('選択肢を選んでください');
      ans = choice;
    }
    pending.delete(qid); sessions.delete(qid);
    const det = judgeDetail({ answerKind: kind, answerIndex: q.answerIndex, fields: q.fields, compare: q.compare, verifier: q.verifier, accept: q.accept, tap: q.tap, editable: q.editable, sim: q.sim }, ans);
    const answers = kind === 'text' ? (q.fields || []).map((f) => (f.accept && f.accept[0]) || '') : null;
    // 見本なので、満たさなかった要件・文法の誤り・タップの正解はいつも返す(ゲームでは中立の拠点と強化のときだけ)
    return {
      t: 'result', qid, correct: det.correct, answerIndex: ['text', 'tap', 'config'].includes(kind) ? null : q.answerIndex, answers,
      failed: kind === 'config' ? det.failed : null, errors: det.errors.length ? det.errors : null, correctIds: kind === 'tap' && !det.correct && q.accept ? q.accept.ids.slice() : null,
      explanation: q.explanation, defenseNote: q.defenseNote || null, outcome: det.correct ? '見本のページなので、拠点には反映しません' : '見本のページなので、待ち時間はありません',
    };
  }

  // 模擬ターミナルの 1 行。world.term と同じ決まり(60 回・0.3 秒・終わった問題は文で返す)
  function term({ qid, line } = {}) {
    if (typeof line !== 'string' || line.length > 120) throw new Error('コマンドは 1 行 120 字までです');
    const q = typeof qid === 'string' ? pending.get(qid) : null;
    const reply = (out, device = null) => ({ t: 'termOut', qid, line, out, device });
    if (!q) return reply('この問題はもう終わっています');
    if (!q.terminal || !q.sim || !q.sim.spec) return reply('この問題にはターミナルがありません');
    let e = sessions.get(qid);
    if (!line.trim()) return reply('', e ? e.s.device : (q.terminal.start || null));
    if (e && e.count >= TERM_MAX) return reply(`この問題で打てるコマンドは ${TERM_MAX} 回までです`, e.s.device);
    if (e && Date.now() - e.last < TERM_MIN_MS) return reply('速すぎます。少し待ってからもう一度打ってください', e.s.device);
    if (!e) { e = { s: sim.session(q.sim.spec, q.terminal.start), count: 0, last: 0 }; sessions.set(qid, e); }
    e.count += 1; e.last = Date.now();
    let out;
    try { out = sim.exec(e.s, line); } catch (err) { out = `コマンドを処理できませんでした(${(err && err.message) || 'エラー'})`; }
    return reply(String(out == null ? '' : out), e.s.device);
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
    const posts = { '/cl-preview/ask': ask, '/cl-preview/answer': answer, '/cl-preview/term': term };
    if (posts[p] && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 60000) req.destroy(); }); // 設定の答え(8 台 × 4,800 字)が入る大きさ
      req.on('end', () => {
        try { reply(200, posts[p](JSON.parse(body || '{}'))); }
        catch (e) { reply(400, { error: (e && e.message) || 'エラー' }); }
      });
      return true;
    }
    reply(404, { error: '見つかりません' });
    return true;
  }

  return { ask, answer, term, levels, handle, pending, sessions };
}

module.exports = { createClPreview, enabled, SAMPLES };
