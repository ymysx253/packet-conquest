'use strict';
// 中級(新しい番号 159〜252。docs/LEVEL-LIST.md 第 4 章)の問題。担当: 中級。書き方は docs/questions/CL.md
// 作るのは一覧の「担当」が O で、「今の問題」が空(新規)で、構成図・設定・模擬ターミナルでない行だけ(2026-10-22)。
//   生(計算・表の読み取り): 166 180 183 184 185 187 191 195 196 197 198 199 211 212 214 221 222 223 234 239
//   表(FactBank server/questions/data/cl/mid/): 181 182 186 188 189 190 194 202 213 216 217 218 219 220 224 225 226 227 229 231 232 233 235 236 237 238 240
// 中級の決まり: 1 問 1〜2 分。ヒントは最初の 1 手だけ(firstStep)。解説(explanation)は必ず。
// 生成のレベルは verify で答えを別の方法(2 進の文字列・全部の列挙・逐次の模擬・表の読み直し)で解き直す。
// ゲーム内の規則(同点のときの決め方、分け方の決まり、配る順番など)は本文に書く。
// 乱数は引数の rng(rng.js の makeRng)だけを使う。Math.random は使わない。meta と fields[].accept はサーバーだけが持つ。
const path = require('path');
const { choices, trueFalse } = require('./build');
const { normalize } = require('../normalize');

// ---------- 表(FactBank)の読み込み ----------
// build.loadFacts と同じく checkedBy の無い行は使わない。誤答だけに使う語(distractors)も読む
function bank(file) {
  const d = require(path.join(__dirname, '..', 'data', 'cl', 'mid', file));
  const rows = (d.rows || []).filter((r) => r && r.checkedBy);
  if (!rows.length) throw new Error(`mid/${file}: 確認済み(checkedBy)の行がありません`);
  const terms = [...new Set(rows.filter((r) => r.attrs.type === 'd').map((r) => r.attrs.term).concat(d.distractors || []))];
  return { file, rows, terms, byId: new Map(rows.map((r) => [r.id, r])) };
}
const B = {
  slaac: bank('181-slaac.json'), nd: bank('182-nd.json'), vlan: bank('186-vlan.json'), tag: bank('188-tag.json'),
  intervlan: bank('189-intervlan.json'), loop: bank('190-loop.json'), mtu: bank('194-mtu.json'), rkind: bank('202-routing-kind.json'),
  relay: bank('213-dhcp-relay.json'), mgmt: bank('216-mgmt-proto.json'), sev: bank('217-severity.json'), hash: bank('218-hash.json'),
  sig: bank('219-signature.json'), cert: bank('220-cert.json'), vpn: bank('224-vpn-kind.json'), ssh: bank('225-ssh-telnet.json'),
  con: bank('226-console.json'), tr: bank('227-traceroute.json'), layers: bank('229-layers.json'), ipsec: bank('231-ipsec-ssl.json'),
  split: bank('232-split-tunnel.json'), zone: bank('233-region-zone.json'), natgw: bank('235-nat-gw.json'), sg: bank('236-sg-acl.json'),
  vsw: bank('237-vswitch.json'), htrunk: bank('238-host-trunk.json'), nfv: bank('240-nfv.json'),
};
const end = (s) => (/[。!?]$/.test(s) ? s : `${s}。`);

// 表の 1 行から問題を作る。d = 説明 → 名前(4 択。誤答は同じ表のほかの名前)、t = ○×、q = 問いと答え(誤答は行に書いたもの)
//   sub: 文字の置き換え({S} → A さん など)
function askRow(rng, bk, row, { lead = '', sub = (s) => s } = {}) {
  const a = row.attrs; const pre = lead ? `${lead}\n` : '';
  if (a.type === 't') {
    const ja = sub(row.ja); const tf = trueFalse(ja, a.true);
    return { text: `${pre}次の文は正しいですか。\n「${ja}」`, options: tf.options, answerIndex: tf.answerIndex, explanation: `${a.true ? '正しい' : '誤り'}。${end(sub(a.why))}`, meta: { file: bk.file, rowId: row.id } };
  }
  if (a.type === 'd') {
    const c = choices(rng, a.term, bk.terms.filter((t) => t !== a.term), 4);
    const text = a.ask ? `${pre}${a.ask}` : `${pre}次の説明に当てはまるものはどれ。\n「${row.ja}」`;
    return { text, ...c, explanation: `${a.ask ? `${row.ja} は${a.term}` : `「${row.ja}」は${a.term}`}。${end(a.why)}`, meta: { file: bk.file, rowId: row.id } };
  }
  if (a.type === 'q') {
    const c = choices(rng, sub(a.answer), a.wrong.map(sub), Math.min(4, a.wrong.length + 1));
    return { text: `${pre}${sub(row.ja)}`, ...c, explanation: `答えは「${sub(a.answer)}」。${end(sub(a.why))}`, meta: { file: bk.file, rowId: row.id } };
  }
  throw new Error(`mid/${bk.file}: 行 ${row.id} の型 ${a.type} からは問題を作れません`);
}
const askRows = (bk) => bk.rows.filter((r) => ['t', 'd', 'q'].includes(r.attrs.type));
// 表の問題の確かめ: 正解が行の答えと同じで、誤答に行の答えが入っていないこと
function verifyRow(q, bk, sub = (s) => s) {
  const row = bk.byId.get(q.meta.rowId); if (!row) throw new Error(`${q.kind}: 行 ${q.meta.rowId} が無い`);
  const a = row.attrs;
  if (a.type === 't') { if (q.answerIndex !== (a.true ? 0 : 1)) throw new Error(`${q.kind} ${row.id}: ○× の答えが違う`); return; }
  const want = a.type === 'd' ? a.term : sub(a.answer);
  if (q.options[q.answerIndex] !== want) throw new Error(`${q.kind} ${row.id}: 正解が ${want} でない`);
  if (q.options.filter((o) => o === want).length !== 1) throw new Error(`${q.kind} ${row.id}: 正解が 2 つある`);
  if (a.type === 'q') { const w = new Set(a.wrong.map(sub)); for (const [i, o] of q.options.entries()) if (i !== q.answerIndex && !w.has(o)) throw new Error(`${q.kind} ${row.id}: 誤答 ${o} が行に無い`); }
  if (a.type === 'd') for (const o of q.options) if (!bk.terms.includes(o)) throw new Error(`${q.kind} ${row.id}: 選択肢 ${o} が表に無い`);
}
// 表のレベルの雛形(行から 1 問)
function tableLevel(title, bk, firstStep, kindName, opts = {}) {
  return {
    title, kind: '表', minDistinct: 20,
    make(rng) { const q = askRow(rng, bk, rng.pick(askRows(bk)), opts); return { ...q, firstStep, kind: kindName }; },
    verify(q) { verifyRow(q, bk); },
  };
}

// ---------- アドレスの道具 ----------
const ip = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const num = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const mask = (p) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
const netOf = (a, p) => (a & mask(p)) >>> 0;
const size = (p) => 2 ** (32 - p);
const wild = (p) => ip((~mask(p)) >>> 0);
const fmt = (n) => n.toLocaleString('ja-JP');
const ALLOWED = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24]];
const allowed = (n) => n >= 0 && n <= 0xffffffff && ALLOWED.some(([b, p]) => netOf(n, p) === num(b));
// 検証用(生成とは別の方法): 2 進の文字列
const bits = (s) => s.split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('');
const inBits = (addr, net, p) => bits(addr).slice(0, p) === bits(net).slice(0, p);
// プライベートの /16 を 1 つ
function priv16(rng) {
  const r = rng.next();
  if (r < 0.5) return num(`10.${rng.rand(0, 255)}.0.0`);
  if (r < 0.75) return num(`172.${rng.rand(16, 31)}.0.0`);
  return num('192.168.0.0');
}
// /p のネットワークの第何オクテットで何ずつ区切られるか
function stepOf(p) { const o = Math.floor((p - 1) / 8); return { octet: o + 1, step: 2 ** ((o + 1) * 8 - p) }; }
const hex2 = (n) => n.toString(16).padStart(2, '0');
// ローカル管理の MAC(第 2 桁が 2・6・a・e)。docs/questions/COMMON.md 第 7 章
const localMac = (rng) => [rng.rand(0, 63) * 4 + 2, ...Array.from({ length: 5 }, () => rng.rand(0, 255))].map(hex2).join(':');
function distinctMacs(rng, n) { const s = new Set(); while (s.size < n) s.add(localMac(rng)); return [...s]; }
const gi = (p) => `Gi0/${p}`;
const portsLabel = (list) => (list.length ? list.slice().sort((a, b) => a - b).map(gi).join('・') : 'どのポートにも出さない(捨てる)');
const parsePorts = (s) => (s.startsWith('どの') ? [] : s.split('・').map((x) => Number(x.replace('Gi0/', ''))).sort((a, b) => a - b));
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function input(name, label, format, hint, answer) {
  const acc = normalize(format, answer);
  if (acc === null) throw new Error(`正解 ${answer} が ${format} の正規形にならない`);
  return { answerKind: 'text', fields: [{ name, label, format, hint, accept: [acc] }], compare: 'ordered' };
}
const accept0 = (q) => q.fields[0].accept[0];
function must(cond, msg) { if (!cond) throw new Error(msg); }

// ================= 生成のレベル =================

// ---------- Lv166 集約できない組(○×) ----------
function makeL166(rng) {
  const N = rng.rand(18, 28); const P = N - 1; const b = size(N); const cnt = 2 ** (N - 16);
  const base = priv16(rng);
  const kind = rng.pick(['pair', 'pair', 'odd', 'odd', 'gap']);
  let i;
  if (kind === 'pair') i = 2 * rng.rand(0, cnt / 2 - 1);
  else if (kind === 'odd') i = 2 * rng.rand(0, cnt / 2 - 2) + 1;
  else i = rng.rand(0, cnt - 3);
  const j = kind === 'gap' ? i + 2 : i + 1;
  const A = base + i * b; const Bn = base + j * b;
  const [x, y] = rng.next() < 0.5 ? [A, Bn] : [Bn, A];
  const ok = kind === 'pair';
  const S = netOf(A, P); const E = S + 2 * b - 1;
  let len = N; while (netOf(A, len) !== netOf(Bn, len)) len--;
  const st = stepOf(P);
  const tf = trueFalse('', ok);
  return {
    text: `次の 2 つのネットワークを、ほかのアドレスを 1 つも含めずに、1 つの /${P} にまとめられますか。\n・${ip(x)}/${N}\n・${ip(y)}/${N}`,
    options: tf.options, answerIndex: tf.answerIndex,
    firstStep: `まず /${P} の区切り(第 ${st.octet} オクテットで ${st.step} ずつ)を見る`,
    explanation: ok
      ? `まとめられる。${ip(A)} を含む /${P} は ${ip(S)}/${P}(${ip(S)}〜${ip(E)})。${ip(Bn)}/${N} もこの中にあり、2 つでちょうどこの /${P} になる。`
      : `まとめられない。${ip(A)} を含む /${P} は ${ip(S)}/${P}(${ip(S)}〜${ip(E)})で、${ip(Bn)}/${N} はこの外にある。${kind === 'odd' ? '並んではいるが、/' + P + ' の区切りをまたいでいる。' : '間に別のネットワークがはさまっている。'}2 つを含むいちばん小さい範囲は ${ip(netOf(A, len))}/${len} で、ほかのアドレスも含んでしまう。`,
    kind: 'cl166-summary-pair-v1', meta: { A: ip(A), B: ip(Bn), N, ok, variant: kind },
  };
}
function verifyL166(q) {
  const { A, B: Bs, N } = q.meta;
  const a = bits(A), b = bits(Bs);
  must(/^0*$/.test(a.slice(N)) && /^0*$/.test(b.slice(N)), `${q.kind}: ネットワークアドレスでない`);
  const ok = a !== b && a.slice(0, N - 1) === b.slice(0, N - 1);
  must(q.answerIndex === (ok ? 0 : 1), `${q.kind}: ${A}/${N} と ${Bs}/${N} の答えが違う`);
  must(q.text.includes(`${A}/${N}`) && q.text.includes(`${Bs}/${N}`), `${q.kind}: 本文に 2 つのネットワークが無い`);
}

// ---------- Lv180 EUI-64 ----------
function makeL180(rng) {
  const doc = rng.next() < 0.5;
  const o = doc ? [0x00, 0x00, 0x5e, 0x00, 0x53, rng.rand(0, 255)] : localMac(rng).split(':').map((h) => parseInt(h, 16));
  const mac = o.map(hex2).join(':');
  const ll = rng.next() < 0.4;
  const pre = ll ? [0xfe80, 0, 0, 0] : [0x2001, 0x0db8, rng.rand(0, 0xffff), rng.rand(0, 0xffff)];
  const g = [((o[0] ^ 0x02) << 8) | o[1], (o[2] << 8) | 0xff, (0xfe << 8) | o[3], (o[4] << 8) | o[5]];
  const full = pre.concat(g).map((x) => x.toString(16)).join(':');
  const pfx = normalize('ipv6', pre.concat([0, 0, 0, 0]).map((x) => x.toString(16)).join(':'));
  const q = input('address', 'IPv6 アドレス', 'ipv6', '例: 2001:db8::1', full);
  const iid = g.map((x) => x.toString(16)).join(':');
  return {
    ...q,
    text: `MAC アドレス ${mac} のインターフェースが、プレフィックス ${pfx}/64 に EUI-64 で作ったインターフェース ID をつなげて${ll ? 'リンクローカル' : 'グローバル'}アドレスを作る。できる IPv6 アドレスは?(省略して書いてよい)`,
    firstStep: 'まず MAC アドレスの真ん中に ff:fe を入れる',
    explanation: `MAC を半分に分けて真ん中に ff:fe を入れると ${o.slice(0, 3).map(hex2).join(':')}:ff:fe:${o.slice(3).map(hex2).join(':')}。さらに先頭のオクテットの左から 7 番目のビット(U/L ビット)を反転するので ${hex2(o[0])} → ${hex2(o[0] ^ 2)}。インターフェース ID は ${iid}、アドレスは ${accept0(q)}。反転を忘れると先頭が ${hex2(o[0])} のままになり誤り。`,
    kind: 'cl180-eui64-v1', meta: { mac, prefix: pre.map((x) => x.toString(16)) },
  };
}
function verifyL180(q) {
  // 別の方法: 48 ビットの 2 進の文字列で 7 番目のビットを反転し、16 進にして fffe を差し込む
  const b = q.meta.mac.split(':').map((h) => parseInt(h, 16).toString(2).padStart(8, '0')).join('');
  const flipped = b.slice(0, 6) + (b[6] === '0' ? '1' : '0') + b.slice(7);
  const hex = flipped.match(/.{4}/g).map((x) => parseInt(x, 2).toString(16)).join('');
  const iid = hex.slice(0, 6) + 'fffe' + hex.slice(6);
  const pfx = q.meta.prefix.map((x) => x.padStart(4, '0')).join('');
  const all = (pfx + iid).match(/.{4}/g).join(':');
  must(normalize('ipv6', all) === accept0(q), `${q.kind}: ${q.meta.mac} の答え ${accept0(q)} が ${all} と違う`);
}

// ---------- Lv183 フラッディング ----------
function makeL183(rng) {
  const n = rng.rand(4, 6);
  const ports = rng.shuffle(Array.from({ length: n }, (_, i) => i + 1)); // PC k はポート ports[k-1]
  const macs = distinctMacs(rng, n);
  const pcs = Array.from({ length: n }, (_, k) => ({ name: `PC${k + 1}`, mac: macs[k], port: ports[k] }));
  const s = rng.rand(0, n - 1); let d = rng.rand(0, n - 2); if (d >= s) d++;
  const known = rng.next() < 0.35;
  const others = rng.shuffle(pcs.map((_, k) => k).filter((k) => k !== d)).slice(0, rng.rand(0, 2));
  const learned = rng.shuffle(known ? others.concat([d]) : others);
  const table = learned.map((k) => [pcs[k].mac, gi(pcs[k].port)]);
  const all = pcs.map((p) => p.port);
  const exceptS = all.filter((p) => p !== pcs[s].port);
  const correct = known ? [pcs[d].port] : exceptS;
  const cand = (known ? [exceptS, all, []] : [all, [pcs[d].port], []]).map(portsLabel);
  const c = choices(rng, portsLabel(correct), cand, 4);
  const S = pcs[s], D = pcs[d];
  return {
    text: `スイッチ SW1 のポートに PC が 1 台ずつつながっている(表「つなぎ方」)。${table.length ? 'SW1 の MAC アドレステーブルは表「MAC アドレステーブル」のとおり。' : 'SW1 の MAC アドレステーブルは空(まだ何も覚えていない)。'}${S.name}(${S.mac})が ${D.name}(${D.mac})宛のフレームを送り、SW1 の ${gi(S.port)} に届いた。SW1 はこのフレームをどのポートから出す?`,
    tables: [
      { title: 'つなぎ方', headers: ['PC', 'MAC アドレス', 'ポート'], rows: pcs.slice().sort((a, b) => a.port - b.port).map((p) => [p.name, p.mac, gi(p.port)]) },
    ].concat(table.length ? [{ title: 'MAC アドレステーブル', headers: ['MAC アドレス', 'ポート'], rows: table }] : []),
    ...c,
    firstStep: 'まず MAC アドレステーブルに宛先があるか見る',
    explanation: known
      ? `宛先 ${D.mac} は MAC アドレステーブルに ${gi(D.port)} として載っているので、${gi(D.port)} だけに出す。全ポートに出すのは、宛先が表に無いときだけ。`
      : `宛先 ${D.mac} は MAC アドレステーブルに無いので、受け取った ${gi(S.port)} 以外の全ポート(${portsLabel(exceptS)})に出す(フラッディング)。${D.name} が ${gi(D.port)} にいることを、SW1 はまだ知らない。`
        + `なお、送信元の ${S.mac} は ${gi(S.port)} として覚える。`,
    kind: 'cl183-flooding-v1', meta: { pcs, s, d, table },
  };
}
function verifyL183(q) {
  const { pcs, s, d, table } = q.meta;
  // 別の方法: 表を 1 行ずつ探し、無ければ全ポートから受けたポートを除く
  let hit = null; for (const [mac, port] of table) if (mac === pcs[d].mac) hit = Number(port.replace('Gi0/', ''));
  const want = hit !== null ? [hit] : pcs.map((p) => p.port).filter((p) => p !== pcs[s].port).sort((a, b) => a - b);
  must(sameList(parsePorts(q.options[q.answerIndex]), want), `${q.kind}: 出すポートが違う`);
  must(q.options.filter((o) => sameList(parsePorts(o), want)).length === 1, `${q.kind}: 正解が 2 つある`);
  must(hit === null || hit !== pcs[s].port, `${q.kind}: 受けたポートと宛先のポートが同じ`);
}

// ---------- Lv184 学習の結果 ----------
function makeL184(rng) {
  const n = rng.rand(3, 4);
  const pcs = Array.from({ length: n }, (_, k) => ({ name: `PC${k + 1}`, port: k + 1 }));
  const m = rng.rand(2, 5);
  const frames = Array.from({ length: m }, () => { const a = rng.rand(0, n - 1); let b = rng.rand(0, n - 2); if (b >= a) b++; return [a, b]; });
  const t = rng.next() < 0.7 ? m : rng.rand(1, m - 1);
  const learned = [...new Set(frames.slice(0, t).map((f) => f[0]))];
  const q = input('rows', 'MAC アドレステーブルの行の数', 'number', '半角の数字', String(learned.length));
  const both = new Set(frames.slice(0, t).flat()).size;
  return {
    ...q,
    text: `スイッチ SW1 の MAC アドレステーブルは空から始まる。PC1〜PC${n} は SW1 の Gi0/1〜Gi0/${n} に順につながっている。次のフレームが表の順に送られた。${t === m ? '最後' : `${t} 番目`}のフレームのあと、SW1 の MAC アドレステーブルは何行になる?(覚えた行が古くなって消える時間は、まだ過ぎていない)`,
    table: { headers: ['順', '送信元', '宛先'], rows: frames.map(([a, b], i) => [String(i + 1), `${pcs[a].name}(${gi(pcs[a].port)})`, pcs[b].name]) },
    firstStep: 'まずスイッチが覚えるのは送信元だと思い出す',
    explanation: `スイッチは、届いたフレームの送信元 MAC アドレスと受けたポートを覚える。宛先は覚えない。${t} 番目までの送信元は ${learned.map((k) => pcs[k].name).join('・')} の ${learned.length} 台なので ${learned.length} 行。${both !== learned.length ? `宛先も数えると ${both} になり誤り。` : ''}`,
    kind: 'cl184-mac-learn-v1', meta: { n, frames, t, trap: both },
  };
}
function verifyL184(q) {
  const { frames, t } = q.meta;
  const tableMap = new Map(); // 逐次の模擬: MAC → ポート
  for (let i = 0; i < t; i++) tableMap.set(`pc${frames[i][0]}`, frames[i][0] + 1);
  must(accept0(q) === String(tableMap.size), `${q.kind}: 行の数が違う`);
}

// ---------- Lv185 ARP で調べる相手 ----------
function makeL185(rng) {
  const p = rng.rand(20, 28);
  const net = netOf(priv16(rng) + rng.rand(0, 65535), p); const bc = net + size(p) - 1;
  const gw = rng.next() < 0.7 ? net + 1 : bc - 1;
  let pc; do pc = rng.rand(net + 1, bc - 1); while (pc === gw);
  let dst;
  for (;;) {
    const r = rng.next();
    if (r < 0.4) dst = rng.rand(net + 1, bc - 1); // 同じサブネット
    else if (r < 0.65) dst = rng.next() < 0.5 ? bc + rng.rand(1, 3) : net - rng.rand(2, 4); // 境目のすぐ外
    else dst = priv16(rng) + rng.rand(1, 65534); // 離れたアドレス
    if (dst === gw || dst === pc || dst === net || dst === bc) continue;
    if (!allowed(dst) || (dst & 255) === 0 || (dst & 255) === 255) continue;
    break;
  }
  const same = netOf(dst, p) === net;
  const ans = same ? dst : gw;
  const q = input('target', '調べる相手の IP アドレス', 'ipv4', '例: 192.168.1.1', ip(ans));
  return {
    ...q,
    text: `PC1 のアドレスは ${ip(pc)}/${p}、デフォルトゲートウェイは ${ip(gw)}。PC1 が ${ip(dst)} 宛に IP パケットを送るとき、ARP で MAC アドレスを調べる相手の IP アドレスは?(PC1 の ARP の表は空とする)`,
    firstStep: 'まず宛先が自分と同じサブネットか調べる',
    explanation: `PC1 のサブネットは ${ip(net)}/${p}(${ip(net)}〜${ip(bc)})。${ip(dst)} は${same ? 'この中にあるので、相手に直接送る。ARP で調べるのは宛先の ' + ip(dst) : 'この外にあるので、デフォルトゲートウェイに送る。ARP で調べるのはゲートウェイの ' + ip(gw)}。${same ? '' : '宛先の MAC アドレスを ARP で調べても、別のサブネットなので答えは返らない。'}`,
    kind: 'cl185-arp-target-v1', meta: { pc: ip(pc), p, gw: ip(gw), dst: ip(dst) },
  };
}
function verifyL185(q) {
  const { pc, p, gw, dst } = q.meta;
  const want = inBits(dst, pc, p) ? dst : gw;
  must(accept0(q) === want, `${q.kind}: ${pc}/${p} → ${dst} の答えが違う`);
  must(inBits(gw, pc, p), `${q.kind}: ゲートウェイが同じサブネットに無い`);
  must(dst !== pc && dst !== gw, `${q.kind}: 宛先が自分かゲートウェイ`);
  for (const a of [pc, gw, dst]) must(allowed(num(a)), `${q.kind}: 範囲外のアドレス ${a}`);
}

// ---------- Lv187 アクセスとトランク ----------
function makeL187(rng) {
  for (;;) {
    const k = rng.rand(5, 8);
    const vlans = rng.shuffle([10, 20, 30, 40]).slice(0, rng.rand(2, 3)).sort((a, b) => a - b);
    const cfg = Array.from({ length: k }, (_, i) => {
      if (rng.next() < 0.3) return { port: i + 1, trunk: true, allow: vlans.filter(() => rng.next() < 0.6) };
      return { port: i + 1, trunk: false, vlan: rng.pick(vlans) };
    });
    if (cfg.some((c) => c.trunk && !c.allow.length)) continue;
    const access = cfg.filter((c) => !c.trunk); const trunks = cfg.filter((c) => c.trunk);
    if (!trunks.length || access.length < 2) continue;
    const src = rng.pick(access); const V = src.vlan;
    if (!access.some((c) => c.vlan !== V)) continue;
    const correct = cfg.filter((c) => c.port !== src.port && (c.trunk ? c.allow.includes(V) : c.vlan === V)).map((c) => c.port);
    if (!correct.length) continue;
    const accV = access.filter((c) => c.vlan === V && c.port !== src.port).map((c) => c.port);
    const cand = [accV.concat(trunks.map((c) => c.port)), accV, cfg.map((c) => c.port).filter((p) => p !== src.port), correct.concat([src.port])]
      .map(portsLabel).filter((x) => x !== portsLabel(correct));
    if (new Set(cand).size < 3) continue;
    const c = choices(rng, portsLabel(correct), cand, 4);
    const tIn = trunks.filter((t) => t.allow.includes(V)).map((t) => t.port); const tOut = trunks.filter((t) => !t.allow.includes(V)).map((t) => t.port);
    return {
      text: `スイッチ SW1 のポートの設定は表のとおり。${gi(src.port)} につながる PC(VLAN ${V})が、全員宛(ブロードキャスト)のフレームを送った。SW1 がこのフレームを出すポートをすべて挙げたものはどれ?`,
      table: { headers: ['ポート', '種類', 'VLAN'], rows: cfg.map((c) => [gi(c.port), c.trunk ? 'トランク' : 'アクセス', c.trunk ? `${c.allow.join('・')} を通す` : String(c.vlan)]) },
      ...c,
      firstStep: `まず VLAN ${V} のフレームを運べるポートを拾う`,
      explanation: `VLAN ${V} のフレームが出るのは、VLAN ${V} のアクセスポート${accV.length ? `(${portsLabel(accV)})` : '(ほかには無い)'}と、VLAN ${V} を通すトランク${tIn.length ? `(${portsLabel(tIn)})` : '(無い)'}。受けた ${gi(src.port)} には戻さない。${tOut.length ? `${portsLabel(tOut)} は VLAN ${V} を通さないトランクなので出ない。` : ''}ほかの VLAN のアクセスポートにも出ない。`,
      kind: 'cl187-access-trunk-v1', meta: { cfg, src: src.port, V },
    };
  }
}
function verifyL187(q) {
  const { cfg, src, V } = q.meta;
  const want = [];
  for (const c of cfg) { if (c.port === src) continue; if (c.trunk ? c.allow.indexOf(V) >= 0 : c.vlan === V) want.push(c.port); }
  must(sameList(parsePorts(q.options[q.answerIndex]), want.sort((a, b) => a - b)), `${q.kind}: 出すポートが違う`);
  must(q.options.filter((o) => sameList(parsePorts(o), want)).length === 1, `${q.kind}: 正解が 2 つある`);
}

// ---------- Lv191 ルートブリッジ ----------
const PRIOS = [4096, 8192, 16384, 24576, 28672, 32768, 36864, 61440];
function makeL191(rng) {
  const k = rng.rand(3, 5);
  const tie = rng.next() < 0.5;
  let pr;
  for (;;) {
    pr = Array.from({ length: k }, () => rng.pick(PRIOS));
    const min = Math.min(...pr); const nMin = pr.filter((x) => x === min).length;
    if (tie ? nMin >= 2 : nMin === 1) break;
  }
  const macs = distinctMacs(rng, k);
  if (tie && rng.next() < 0.6) { // 同じ優先度の組は、MAC の頭をそろえて後ろで差を付ける
    const min = Math.min(...pr); const head = macs[0].slice(0, 12);
    const tied = pr.map((x, i) => (x === min ? i : -1)).filter((i) => i >= 0);
    const tails = new Set(); while (tails.size < tied.length) tails.add(`${hex2(rng.rand(0, 255))}:${hex2(rng.rand(0, 255))}`);
    [...tails].forEach((t, j) => { macs[tied[j]] = `${head}${t}`; });
  }
  const sw = pr.map((p, i) => ({ name: `SW${i + 1}`, prio: p, mac: macs[i], m: parseInt(macs[i].replace(/:/g, ''), 16) })); // MAC は 48 ビットなので数で比べてよい
  const root = sw.reduce((a, b) => (b.prio < a.prio || (b.prio === a.prio && b.m < a.m) ? b : a));
  const min = Math.min(...pr); const tied = sw.filter((s) => s.prio === min);
  const q = input('root', 'ルートブリッジのスイッチ', 'devname', '例: SW1', root.name);
  return {
    ...q,
    text: 'スパニングツリーで、ルートブリッジになるのはどのスイッチ? 各スイッチのブリッジの優先度と MAC アドレスは表のとおり(優先度は表の値で比べる)。',
    table: { headers: ['スイッチ', '優先度', 'MAC アドレス'], rows: sw.map((s) => [s.name, String(s.prio), s.mac]) },
    firstStep: 'まず優先度のいちばん小さいスイッチを探す',
    explanation: `ブリッジ ID(優先度、同じなら MAC アドレス)がいちばん小さいスイッチがルートブリッジになる。優先度がいちばん小さいのは ${min}${tied.length > 1 ? ` で、${tied.map((s) => s.name).join('・')} が同じ。MAC アドレスを比べて、いちばん小さい ${root.mac} の ${root.name}` : ` の ${root.name}`} がルートブリッジ。`,
    kind: 'cl191-root-bridge-v1', meta: { sw: sw.map(({ name, prio, mac }) => ({ name, prio, mac })), tie: tied.length > 1 },
  };
}
function verifyL191(q) {
  // 別の方法: 優先度を 5 桁、MAC を 12 桁の 16 進にそろえた文字列の辞書順
  const key = (s) => `${String(s.prio).padStart(5, '0')}-${s.mac.replace(/:/g, '')}`;
  const best = q.meta.sw.slice().sort((a, b) => (key(a) < key(b) ? -1 : 1))[0];
  must(accept0(q) === best.name.toLowerCase(), `${q.kind}: ルートブリッジが違う`);
}

// ---------- Lv195・196 断片の数とオフセット ----------
const MTUS = [1500, 1500, 1500, 1492, 1400, 1280, 1006, 576];
const FRAG_RULE = 'IP ヘッダーはどの断片も 20 バイト(オプションなし)。先頭から、1 個の断片に入るだけ詰めて分ける。最後の断片を除き、断片のデータの長さは 8 バイトの倍数にする。';
function fragParams(rng, allowOne) {
  const M = rng.pick(MTUS); const per = Math.floor((M - 20) / 8) * 8;
  const r = rng.next(); let D;
  if (allowOne && r < 0.05) D = rng.rand(200, M - 20);
  else if (r < 0.2) D = per * rng.rand(2, 8);
  else if (r < 0.3) D = per * rng.rand(1, 7) + rng.rand(1, 8);
  else if (r < 0.38) D = (M - 20) + per * rng.rand(0, 5) + rng.rand(-2, 2);
  else D = rng.rand(per + 1, per * 9);
  if (!allowOne && D <= M - 20) D = M - 20 + rng.rand(1, 50);
  const count = D <= M - 20 ? 1 : 1 + Math.ceil((D - (M - 20)) / per);
  return { M, per, D, count };
}
function fragSim(M, D) { // 逐次の模擬(RFC 791 の分け方)。断片ごとのデータの長さの並び
  const out = []; let rest = D;
  while (rest + 20 > M) { let t = M - 20; while (t % 8 !== 0) t--; out.push(t); rest -= t; }
  out.push(rest); return out;
}
function makeL195(rng) {
  const { M, per, D, count } = fragParams(rng, true);
  const q = input('count', '断片の数', 'number', '半角の数字', String(count));
  return {
    ...q,
    text: `IPv4 で、IP ヘッダーより後ろの部分(データ)が ${fmt(D)} バイトのパケットを、MTU ${fmt(M)} バイトの線へ送る(DF ビットは 0)。いくつの断片になる?(分けなくてよいときは 1)\n${FRAG_RULE}`,
    firstStep: 'まず 1 個の断片に入るデータの長さ(MTU − 20 を 8 の倍数に切り下げ)を出す',
    explanation: count === 1
      ? `データ ${fmt(D)} + ヘッダー 20 = ${fmt(D + 20)} バイトで MTU ${fmt(M)} 以下なので、分けずに 1 個で送れる。`
      : `1 個の断片に入るデータは ${fmt(M)} − 20 = ${fmt(M - 20)}${per !== M - 20 ? ` を 8 の倍数に切り下げた ${fmt(per)}` : ''} バイト。${fmt(per)} バイトずつ ${count - 1} 個送ると、残りは ${fmt(D - per * (count - 1))} バイトで、最後の 1 個に入る。合わせて ${count} 個。`,
    kind: 'cl195-frag-count-v1', meta: { M, D },
  };
}
function verifyL195(q) {
  const parts = fragSim(q.meta.M, q.meta.D);
  must(accept0(q) === String(parts.length), `${q.kind}: MTU ${q.meta.M} データ ${q.meta.D} の断片の数が違う`);
  must(parts.reduce((a, b) => a + b, 0) === q.meta.D && parts.every((x) => x + 20 <= q.meta.M), `${q.kind}: 模擬の分け方がおかしい`);
}
function makeL196(rng) {
  const { M, per, D, count } = fragParams(rng, false);
  const k = rng.rand(2, count);
  const off = ((k - 1) * per) / 8;
  const q = input('offset', 'フラグメントオフセット(8 バイト単位)', 'number', '半角の数字', String(off));
  return {
    ...q,
    text: `IPv4 で、データ(IP ヘッダーより後ろの部分)が ${fmt(D)} バイトのパケットを、MTU ${fmt(M)} バイトの線へ送るので断片に分ける(DF ビットは 0)。${k} 番目の断片のフラグメントオフセットは?(8 バイト単位の値で答える)\n${FRAG_RULE}`,
    firstStep: 'まず 1 個の断片に入るデータの長さを出し、8 で割る',
    explanation: `1 個の断片に入るデータは ${fmt(M - 20)}${per !== M - 20 ? ` を 8 の倍数に切り下げた ${fmt(per)}` : ''} バイト(8 単位で ${per / 8})。${k} 番目の断片は、前の ${k - 1} 個ぶん ${fmt((k - 1) * per)} バイトの後ろから始まるので、オフセットは ${fmt((k - 1) * per)} ÷ 8 = ${fmt(off)}。バイトのまま ${fmt((k - 1) * per)} と答えると誤り。`,
    kind: 'cl196-frag-offset-v1', meta: { M, D, k },
  };
}
function verifyL196(q) {
  const parts = fragSim(q.meta.M, q.meta.D);
  must(q.meta.k >= 2 && q.meta.k <= parts.length, `${q.kind}: 断片の番号が範囲外`);
  const bytes = parts.slice(0, q.meta.k - 1).reduce((a, b) => a + b, 0);
  must(bytes % 8 === 0 && accept0(q) === String(bytes / 8), `${q.kind}: オフセットが違う`);
}

// ---------- Lv197・198・199 経路の選び方 ----------
const SRC = { static: { name: 'スタティック', ad: 1 }, ebgp: { name: '外部 BGP', ad: 20 }, ospf: { name: 'OSPF', ad: 110 }, rip: { name: 'RIP', ad: 120 } };
function metricOf(rng, src) { return src === 'ospf' ? rng.rand(2, 200) : src === 'rip' ? rng.rand(1, 15) : 0; }
function nextHops(rng, n) { const s = new Set(); while (s.size < n) s.add(`10.0.${rng.rand(0, 255)}.${rng.rand(1, 254)}`); return [...s]; }
function randPrefix(rng) { const p = rng.rand(16, 24); return { net: netOf(priv16(rng) + rng.rand(0, 65535), p), p }; }
const routeRows = (rows) => rows.map((r) => [`${ip(r.net)}/${r.p}`, SRC[r.src].name, String(SRC[r.src].ad), String(r.metric), r.nh]);
const ROUTE_HEAD = ['宛先', '出どころ', 'AD 値', 'メトリック', 'ネクストホップ'];
function makeL197(rng) {
  const { net, p } = randPrefix(rng);
  const srcs = rng.shuffle(Object.keys(SRC)).slice(0, rng.rand(2, 4));
  const nh = nextHops(rng, srcs.length);
  const rows = srcs.map((s, i) => ({ net, p, src: s, metric: metricOf(rng, s), nh: nh[i] }));
  const best = rows.reduce((a, b) => (SRC[b.src].ad < SRC[a.src].ad ? b : a));
  const dst = net + rng.rand(1, size(p) - 2);
  const q = input('nexthop', 'ネクストホップ', 'ipv4', '例: 10.0.0.1', best.nh);
  const lowM = rows.reduce((a, b) => (b.metric < a.metric ? b : a));
  return {
    ...q,
    text: `ルーター R1 は、同じ宛先 ${ip(net)}/${p} への経路を、表の出どころからそれぞれ知った。R1 が ${ip(dst)} 宛のパケットを送るネクストホップは?(AD 値は経路の優先度。表の値で比べる)`,
    table: { headers: ROUTE_HEAD, rows: routeRows(rows) },
    firstStep: 'まず AD 値のいちばん小さい候補を探す',
    explanation: `宛先のプレフィックスが同じ候補どうしは、AD 値の小さいものを選ぶ。いちばん小さいのは ${SRC[best.src].name} の ${SRC[best.src].ad} なので、ネクストホップは ${best.nh}。メトリックは同じ出どころの中で比べる値で、出どころが違う候補どうしでは比べない${lowM !== best ? `(メトリックの数がいちばん小さいのは ${SRC[lowM.src].name} だが、選ばれない)` : ''}。`,
    kind: 'cl197-ad-select-v1', meta: { rows: rows.map((r) => ({ ...r, net: ip(r.net) })), dst: ip(dst) },
  };
}
function verifyL197(q) {
  const t = q.table.rows; // 表を読み直して AD 値の最小を探す
  let best = null; for (const r of t) if (best === null || Number(r[2]) < Number(best[2])) best = r;
  must(t.filter((r) => r[2] === best[2]).length === 1, `${q.kind}: AD 値が同じ候補がある`);
  must(accept0(q) === best[4], `${q.kind}: ネクストホップが違う`);
}
function makeL198(rng) {
  const { net, p } = randPrefix(rng);
  const n = rng.rand(2, 4); const withRip = rng.next() < 0.5;
  const costs = new Set(); while (costs.size < n) costs.add(rng.rand(2, 120));
  const nh = nextHops(rng, n + 1);
  const rows = [...costs].map((c, i) => ({ net, p, src: 'ospf', metric: c, nh: nh[i] }));
  if (withRip) rows.splice(rng.rand(0, rows.length), 0, { net, p, src: 'rip', metric: rng.rand(1, 5), nh: nh[n] });
  const ospf = rows.filter((r) => r.src === 'ospf');
  const best = ospf.reduce((a, b) => (b.metric < a.metric ? b : a));
  const q = input('nexthop', 'ネクストホップ', 'ipv4', '例: 10.0.0.1', best.nh);
  return {
    ...q,
    text: `ルーター R1 は、同じ宛先 ${ip(net)}/${p} への経路の候補を表のように知っている。R1 が経路表に載せて使う経路のネクストホップは?(AD 値は経路の優先度。表の値で比べる。OSPF のメトリックはコスト、RIP のメトリックはホップ数)`,
    table: { headers: ROUTE_HEAD, rows: routeRows(rows) },
    firstStep: 'まず同じ出どころ(同じ AD 値)の候補か見る',
    explanation: `${withRip ? 'まず AD 値で比べる。OSPF の 110 が RIP の 120 より小さいので、OSPF の候補だけが残る。RIP のホップ数はコストとは意味が違うので、数が小さくても比べない。' : 'どれも OSPF で AD 値は同じ 110。'}OSPF の中ではコストのいちばん小さい ${best.metric} の経路を選ぶので、ネクストホップは ${best.nh}。`,
    kind: 'cl198-metric-select-v1', meta: { withRip },
  };
}
function verifyL198(q) {
  const t = q.table.rows.map((r) => ({ ad: Number(r[2]), m: Number(r[3]), nh: r[4] }));
  const minAd = Math.min(...t.map((r) => r.ad)); const g = t.filter((r) => r.ad === minAd);
  const minM = Math.min(...g.map((r) => r.m)); const w = g.filter((r) => r.m === minM);
  must(w.length === 1 && accept0(q) === w[0].nh, `${q.kind}: ネクストホップが違う(または同点)`);
}
function makeL199(rng) {
  for (;;) {
    const base = priv16(rng); const dst = base + rng.rand(256, 65279);
    const minLen = ip(base).startsWith('10.') ? 8 : ip(base).startsWith('172.') ? 12 : 16;
    const lens = rng.shuffle([8, 12, 16, 20, 22, 24, 26, 28].filter((l) => l >= minLen)).slice(0, rng.rand(2, 3)).sort((a, b) => a - b);
    const longest = lens[lens.length - 1];
    const srcs = ['static', 'ospf', 'rip'];
    const nh = nextHops(rng, lens.length + 2);
    const rows = lens.map((l, i) => ({ net: netOf(dst, l), p: l, src: l === longest && rng.next() < 0.6 ? 'rip' : rng.pick(srcs), nh: nh[i] }));
    if (rng.next() < 0.7 && longest < 30) { // 長いが当てはまらない行(隣の区画)
      const l2 = Math.min(30, longest + rng.rand(1, 4)); const own = netOf(dst, l2);
      const sib = (own ^ size(l2)) >>> 0;
      rows.push({ net: sib, p: l2, src: rng.pick(['static', 'ospf']), nh: nh[lens.length] });
    }
    if (rng.next() < 0.5) rows.push({ net: 0, p: 0, src: 'static', nh: nh[lens.length + 1] });
    for (const r of rows) r.metric = metricOf(rng, r.src);
    if (!rows.every((r) => r.p === 0 || allowed(r.net))) continue;
    const ordered = rng.shuffle(rows);
    const match = ordered.filter((r) => netOf(dst, r.p) === r.net);
    const best = match.reduce((a, b) => (b.p > a.p ? b : a));
    const miss = ordered.filter((r) => netOf(dst, r.p) !== r.net);
    const q = input('nexthop', 'ネクストホップ', 'ipv4', '例: 10.0.0.1', best.nh);
    return {
      ...q,
      text: `ルーター R1 の経路表は表のとおり。R1 が ${ip(dst)} 宛のパケットを送るネクストホップは?`,
      table: { headers: ROUTE_HEAD, rows: routeRows(ordered) },
      firstStep: 'まず宛先に当てはまる行のうち、プレフィックスのいちばん長い行を探す(AD 値はそのあと)',
      explanation: `${ip(dst)} に当てはまる行は ${match.map((r) => `${ip(r.net)}/${r.p}`).join('・')}。その中でプレフィックスがいちばん長い ${ip(best.net)}/${best.p} を選ぶ(最長一致)ので、ネクストホップは ${best.nh}。AD 値は、プレフィックスが同じ候補どうしを比べるときにだけ使う。${miss.length ? `${miss.map((r) => `${ip(r.net)}/${r.p}(${ip(r.net)}〜${ip(r.net + size(r.p) - 1)})`).join('・')} は ${ip(dst)} を含まない。` : ''}`,
      kind: 'cl199-longest-match-v1', meta: { dst: ip(dst) },
    };
  }
}
function verifyL199(q) {
  const dst = q.meta.dst; let best = null;
  for (const r of q.table.rows) { const [n, p] = r[0].split('/'); if (inBits(dst, n, Number(p)) && (best === null || Number(p) > best.p)) best = { p: Number(p), nh: r[4] }; }
  must(best && accept0(q) === best.nh, `${q.kind}: 最長一致のネクストホップが違う`);
  must(q.table.rows.filter((r) => Number(r[0].split('/')[1]) === best.p && inBits(dst, r[0].split('/')[0], best.p)).length === 1, `${q.kind}: いちばん長い一致が 2 行ある`);
}

// ---------- Lv211 DHCP のプールと除外 ----------
function lanBase(rng) { return rng.next() < 0.5 ? num(`192.168.${rng.rand(0, 255)}.0`) : num(`10.${rng.rand(0, 255)}.${rng.rand(0, 255)}.0`); }
const overlap = (a, b) => a[0] <= b[1] && b[0] <= a[1];
function makeL211(rng) {
  const base = lanBase(rng);
  const a = rng.rand(1, 120); const b = rng.rand(a + 20, 254);
  const shapes = ['head', 'tail', 'inside', 'over', 'outside'];
  const mk = (shape) => {
    const w = rng.rand(3, 15);
    if (shape === 'head') return [a, a + w - 1];
    if (shape === 'tail') return [b - w + 1, b];
    if (shape === 'inside') { const s = rng.rand(a + 1, b - w - 1); return [s, s + w - 1]; }
    if (shape === 'over') return rng.next() < 0.5 && a > 2 ? [Math.max(1, a - rng.rand(1, 10)), a + rng.rand(1, 8)] : [b - rng.rand(1, 8), Math.min(254, b + rng.rand(1, 10))];
    return a > 12 ? [1, rng.rand(2, a - 1)] : [b + 1 <= 250 ? b + 1 : 1, b + 1 <= 250 ? rng.rand(b + 1, 254) : 1];
  };
  const ex = []; const nEx = rng.next() < 0.6 ? 1 : 2;
  let guard = 0;
  while (ex.length < nEx && guard++ < 50) {
    const e = mk(rng.pick(shapes)); if (e[0] > e[1] || e[0] < 1 || e[1] > 254) continue;
    if (ex.some((x) => overlap(x, e))) continue; ex.push(e);
  }
  ex.sort((x, y) => x[0] - y[0]);
  const inPool = ex.map((e) => Math.max(0, Math.min(e[1], b) - Math.max(e[0], a) + 1));
  const ans = (b - a + 1) - inPool.reduce((x, y) => x + y, 0);
  const A = (h) => ip(base + h);
  const q = input('count', '配れるアドレスの数', 'number', '半角の数字', String(ans));
  return {
    ...q,
    text: 'DHCP サーバーの設定は表のとおり。新しい機器に配れるアドレスはいくつ?(除外の範囲のアドレスは配らない。プールの外のアドレスはもともと配らない)',
    table: { headers: ['項目', '値'], rows: [['プール', `${A(a)}〜${A(b)}`]].concat(ex.map((e) => ['除外', e[0] === e[1] ? A(e[0]) : `${A(e[0])}〜${A(e[1])}`])) },
    firstStep: 'まずプールの数を、両端を含めて数える',
    explanation: `プールは ${A(a)}〜${A(b)} で ${b} − ${a} + 1 = ${b - a + 1} 個。${ex.map((e, i) => (inPool[i] ? `除外 ${A(e[0])}〜${A(e[1])} のうちプールに重なるのは ${inPool[i]} 個` : `除外 ${A(e[0])}〜${A(e[1])} はプールの外なので数えない`)).join('。')}。${b - a + 1} − ${inPool.reduce((x, y) => x + y, 0)} = ${ans}。端を 1 つ数え忘れると 1 ずれる。`,
    kind: 'cl211-dhcp-pool-v1', meta: { a, b, ex },
  };
}
function verifyL211(q) {
  const { a, b, ex } = q.meta; let n = 0; // 全部の列挙
  for (let h = 0; h <= 255; h++) if (h >= a && h <= b && !ex.some((e) => h >= e[0] && h <= e[1])) n++;
  must(accept0(q) === String(n), `${q.kind}: 配れる数が違う`);
}

// ---------- Lv212 DHCP の予約 ----------
function makeL212(rng) {
  const base = lanBase(rng); const A = (h) => ip(base + h);
  const a = rng.rand(10, 150); const b = a + rng.rand(20, 40);
  const ex = rng.next() < 0.4 ? [a, a + rng.rand(2, 6)] : null;
  const isEx = (h) => ex && h >= ex[0] && h <= ex[1];
  const free = () => { const s = []; for (let h = a; h <= b; h++) if (!isEx(h)) s.push(h); return s; };
  const nRes = rng.rand(2, 3); const macs = distinctMacs(rng, nRes + 5);
  const resAddr = rng.shuffle(free().slice(0, 12)).slice(0, nRes).sort((x, y) => x - y);
  const devs = rng.shuffle(['PRN1', 'AP1', 'CAM1', 'NAS1']);
  const res = resAddr.map((h, i) => ({ mac: macs[i], h, dev: devs[i] }));
  const cand = free().filter((h) => !resAddr.includes(h));
  const nLease = rng.rand(1, 4);
  const leaseAddr = rng.next() < 0.5 ? cand.slice(0, nLease) : rng.shuffle(cand.slice(0, nLease + 2)).slice(0, nLease).sort((x, y) => x - y);
  const leases = leaseAddr.map((h, i) => ({ h, mac: macs[nRes + i] }));
  const reserved = rng.next() < 0.5;
  let mac, ans;
  if (reserved) { const r = rng.pick(res); mac = r.mac; ans = r.h; }
  else {
    const like = rng.pick(res).mac; const last = parseInt(like.slice(-1), 16);
    mac = like.slice(0, -1) + ((last + rng.rand(1, 15)) % 16).toString(16);
    if (macs.includes(mac)) mac = macs[nRes + 4];
    ans = cand.find((h) => !leaseAddr.includes(h));
  }
  const q = input('address', '渡すアドレス', 'ipv4', '例: 192.168.1.10', A(ans));
  const rule = 'このサーバーは、予約の表にある MAC アドレスの機器には、予約したアドレスを渡す。それ以外の機器には、プールの中で、除外・予約・貸し出し中のどれでもない、いちばん小さいアドレスを渡す。';
  return {
    ...q,
    text: `DHCP サーバーの設定・予約・貸し出し中のアドレスは表のとおり。MAC アドレス ${mac} の機器がアドレスを求めた。サーバーが渡すアドレスは?\n${rule}`,
    tables: [
      { title: '設定', headers: ['項目', '値'], rows: [['プール', `${A(a)}〜${A(b)}`]].concat(ex ? [['除外', `${A(ex[0])}〜${A(ex[1])}`]] : []) },
      { title: '予約', headers: ['MAC アドレス', 'アドレス', '機器'], rows: res.map((r) => [r.mac, A(r.h), r.dev]) },
      { title: '貸し出し中', headers: ['アドレス', 'MAC アドレス'], rows: leases.map((l) => [A(l.h), l.mac]) },
    ],
    firstStep: 'まず予約の表に、その MAC アドレスがあるか見る',
    explanation: reserved
      ? `${mac} は予約の表にあるので、予約した ${A(ans)} を渡す。`
      : `${mac} は予約の表に無い(よく似た MAC アドレスはあるが、1 文字でも違えば別の機器)。プールの先頭から、除外・予約・貸し出し中を飛ばすと、いちばん小さい空きは ${A(ans)}。`,
    kind: 'cl212-dhcp-reserve-v1', meta: { a, b, ex, res, leases, mac, base: ip(base) },
  };
}
function verifyL212(q) {
  const { a, b, ex, res, leases, mac, base } = q.meta; const B0 = num(base);
  const r = res.filter((x) => x.mac === mac);
  let want;
  if (r.length) want = r[0].h;
  else for (let h = 0; h <= 255 && want === undefined; h++) {
    if (h < a || h > b) continue; if (ex && h >= ex[0] && h <= ex[1]) continue;
    if (res.some((x) => x.h === h) || leases.some((x) => x.h === h)) continue; want = h;
  }
  must(want !== undefined && accept0(q) === ip(B0 + want), `${q.kind}: 渡すアドレスが違う`);
  must(!leases.some((l) => l.mac === mac), `${q.kind}: 求めた機器がもう借りている`);
}

// ---------- Lv214 DNS のゾーンを読む ----------
const ZONES = ['shop', 'corp', 'lab', 'town', 'school', 'cafe', 'farm', 'studio', 'museum', 'clinic'];
const HOSTS = ['web', 'app', 'www', 'mail', 'ns1', 'api', 'files', 'front', 'portal', 'cdn', 'web2', 'app2', 'blog', 'shop2', 'img'];
function pubAddrs(rng, n) { const s = new Set(); while (s.size < n) s.add(`${rng.pick(['192.0.2', '198.51.100', '203.0.113'])}.${rng.rand(1, 254)}`); return [...s]; }
function makeL214(rng) {
  const zone = `${rng.pick(ZONES)}.example`; const fq = (h) => `${h}.${zone}`;
  const names = rng.shuffle(HOSTS);
  const nA = rng.rand(3, 4); const addrs = pubAddrs(rng, nA + 1);
  const aHosts = names.slice(0, nA); let pos = nA;
  const recs = aHosts.map((h, i) => ({ name: fq(h), type: 'A', value: addrs[i] }));
  const variant = rng.pick(['cname', 'cname', 'cname', 'direct', 'mx', 'mx']);
  const chain = variant !== 'mx' && rng.next() < 0.35;
  const alias = names[pos++]; const mid = chain ? names[pos++] : null;
  const target = rng.pick(aHosts);
  if (chain) { recs.push({ name: fq(alias), type: 'CNAME', value: fq(mid) }); recs.push({ name: fq(mid), type: 'CNAME', value: fq(target) }); }
  else recs.push({ name: fq(alias), type: 'CNAME', value: fq(target) });
  const mxHost = rng.pick(aHosts.filter((h) => h !== target).concat(aHosts.length > 1 ? [] : aHosts));
  recs.push({ name: zone, type: 'MX', value: `10 ${fq(mxHost)}` });
  const ns = names[pos++]; recs.push({ name: zone, type: 'NS', value: fq(ns) }); recs.push({ name: fq(ns), type: 'A', value: addrs[nA] });
  if (rng.next() < 0.5) recs.push({ name: fq(rng.pick(aHosts)), type: 'AAAA', value: `2001:db8:${rng.rand(1, 0xfff).toString(16)}::${rng.rand(1, 0xff).toString(16)}` });
  let ask, ans, steps;
  if (variant === 'mx') { ans = recs.find((r) => r.name === fq(mxHost) && r.type === 'A').value; ask = `${zone} 宛のメール(例: info@${zone})を受け取るサーバーの IPv4 アドレスは?`; steps = `メールの宛先は ${zone} の MX の行で決まり、${fq(mxHost)}。その A の行が ${ans}。`; }
  else if (variant === 'direct') { const h = rng.pick(aHosts); ans = recs.find((r) => r.name === fq(h) && r.type === 'A').value; ask = `${fq(h)} の IPv4 アドレスは?`; steps = `${fq(h)} には A の行があり ${ans}。`; }
  else { ans = recs.find((r) => r.name === fq(target) && r.type === 'A').value; ask = `${fq(alias)} の IPv4 アドレスは?`; steps = `${fq(alias)} は CNAME(別名)で ${chain ? `${fq(mid)}、それもまた CNAME で ${fq(target)}` : fq(target)} を指す。${fq(target)} の A の行が ${ans}。`; }
  const ordered = rng.shuffle(recs);
  const q = input('address', 'IPv4 アドレス', 'ipv4', '例: 192.0.2.1', ans);
  return {
    ...q,
    text: `${zone} のゾーンの記録は表のとおり(必要な名前はすべてこの表で引ける)。${ask}`,
    table: { headers: ['名前', '種類', '値'], rows: ordered.map((r) => [r.name, r.type, r.value]) },
    firstStep: variant === 'mx' ? 'まず MX の行を見て、メールを受けるサーバーの名前を出す' : 'まず名前の行が CNAME(別名)かどうかを見る',
    explanation: `${steps}AAAA は IPv6 のアドレス、NS はゾーンを受け持つ DNS サーバーの名前なので、ここでは使わない。`,
    kind: 'cl214-dns-zone-v1', meta: { zone, variant, chain, askName: variant === 'mx' ? zone : (variant === 'direct' ? null : fq(alias)) },
  };
}
function verifyL214(q) {
  // 表を読み直す独立の解決器
  const rows = q.table.rows; const get = (n, t) => rows.filter((r) => r[0] === n && r[1] === t).map((r) => r[2]);
  for (const r of rows) if (r[1] === 'CNAME') must(rows.filter((x) => x[0] === r[0]).length === 1, `${q.kind}: CNAME の名前にほかの行がある`);
  let name;
  if (q.meta.variant === 'mx') { const mx = get(q.meta.zone, 'MX'); must(mx.length === 1, `${q.kind}: MX が 1 行でない`); name = mx[0].split(' ')[1]; }
  else if (q.meta.variant === 'direct') name = /^(\S+) の IPv4/.exec(q.text.split('。').pop())[1];
  else name = q.meta.askName;
  for (let i = 0; i < 5; i++) { const c = get(name, 'CNAME'); if (!c.length) break; name = c[0]; }
  const a = get(name, 'A'); must(a.length === 1 && accept0(q) === a[0], `${q.kind}: 引いたアドレスが違う`);
}

// ---------- Lv221・222・223 標準 ACL とワイルドカード ----------
const WILD_LENS = [32, 24, 22, 20, 16, 26];
function aclSpec(s) { return s.any ? 'any' : s.p === 32 ? `host ${ip(s.net)}` : `${ip(s.net)} ${wild(s.p)}`; }
const specMatch = (s, a) => s.any || netOf(a, s.p) === s.net;
function makeAcl(rng, L, base) {
  const nets24 = Array.from({ length: 3 }, () => base + rng.rand(0, 255) * 256);
  const lines = []; const seen = new Set();
  while (lines.length < L) {
    if (lines.length === L - 1 && rng.next() < 0.25) { lines.push({ any: true }); break; }
    const p = rng.pick(WILD_LENS);
    const near = rng.pick(nets24) + rng.rand(0, 255);
    const s = { net: p === 16 ? base : netOf(near, p), p };
    if (seen.has(aclSpec(s))) continue; // 同じ条件の行は 2 回書かない
    seen.add(aclSpec(s)); lines.push(s);
  }
  return lines.map((s, i) => ({ ...s, n: (i + 1) * 10, act: rng.next() < 0.5 ? 'permit' : 'deny' }));
}
const firstHit = (lines, a) => lines.find((l) => specMatch(l, a)) || null;
// 別の方法の評価器: ワイルドカードの 2 進の文字列で 1 ビットずつ照らす
function evalAclBits(table, src) {
  const sb = bits(src);
  for (const [n, act, spec] of table) {
    let ok;
    if (spec === 'any') ok = true;
    else { const [a, w] = spec.startsWith('host ') ? [spec.slice(5), '0.0.0.0'] : spec.split(' '); const ab = bits(a), wb = bits(w); ok = [...sb].every((c, i) => wb[i] === '1' || ab[i] === c); }
    if (ok) return `${act} ${n}`;
  }
  return 'deny implicit';
}
function pickSource(rng, lines, base, target) { // target: 行の番号(0 始まり)か -1(暗黙)
  for (let t = 0; t < 200; t++) {
    let a;
    if (target >= 0 && !lines[target].any) a = lines[target].net + rng.rand(0, size(lines[target].p) - 1);
    else if (rng.next() < 0.5) a = base + rng.rand(0, 65535);
    else a = priv16(rng) + rng.rand(0, 65535);
    if (!allowed(a) || (a & 255) === 0 || (a & 255) === 255) continue;
    const h = firstHit(lines, a);
    if ((target < 0 && h === null) || (target >= 0 && h === lines[target])) return a;
  }
  return null;
}
const aclTable = (lines) => ({ headers: ['行', '動作', '送信元'], rows: lines.map((l) => [String(l.n), l.act, aclSpec(l)]) });
const verdict = (h) => (h ? `${h.act} ${h.n}` : 'deny implicit');
function explainAcl(lines, a) {
  const out = [];
  for (const l of lines) { const hit = specMatch(l, a); out.push(`行 ${l.n}(${aclSpec(l)})は${hit ? '当たる' : '当たらない'}`); if (hit) break; }
  const h = firstHit(lines, a);
  return `${ip(a)}: ${out.join('、')}。${h ? `最初に当たった行 ${h.n} の ${h.act} で決まり、その下の行は見ない。` : 'どの行にも当たらないので、最後の暗黙の拒否(deny)で捨てる。'}`;
}
function makeL221(rng) {
  for (;;) {
    const base = priv16(rng); const L = rng.rand(3, 5); const lines = makeAcl(rng, L, base);
    const targets = rng.shuffle(lines.map((_, i) => i).concat([-1]));
    let src = null; for (const t of targets) { src = pickSource(rng, lines, base, t); if (src !== null) break; }
    if (src === null) continue;
    const q = input('verdict', '結果(動作 行番号)', 'aclverdict', '例: permit 10', verdict(firstHit(lines, src)));
    return {
      ...q,
      text: `ルーター R1 の標準 ACL(送信元のアドレスだけを見る)は表のとおり。送信元 ${ip(src)} のパケットが届いた。結果を「動作 行番号」の形で答える(どの行にも当たらないときは implicit と書く)。`,
      table: aclTable(lines),
      firstStep: 'まず上の行から順に当てていく',
      explanation: `上の行から順に照らし、最初に当たった行で決まる。${explainAcl(lines, src)}`,
      kind: 'cl221-std-acl-v1', meta: { src: ip(src) },
    };
  }
}
function verifyL221(q) { must(accept0(q) === normalize('aclverdict', evalAclBits(q.table.rows, q.meta.src)), `${q.kind}: ${q.meta.src} の判定が違う`); }
function makeL222(rng) {
  for (;;) {
    const base = priv16(rng); const L = rng.rand(2, 3); const lines = makeAcl(rng, L, base);
    const nP = rng.rand(3, 4); const srcs = [];
    for (const t of rng.shuffle(lines.map((_, i) => i).concat([-1, -1])).slice(0, nP)) { const s = pickSource(rng, lines, base, t); if (s !== null && !srcs.includes(s)) srcs.push(s); }
    for (let g = 0; g < 30 && srcs.length < nP; g++) { const s = pickSource(rng, lines, base, rng.rand(-1, lines.length - 1)); if (s !== null && !srcs.includes(s)) srcs.push(s); }
    if (srcs.length < nP) continue; // 足りなければ ACL から作り直す
    const pass = srcs.filter((s) => { const h = firstHit(lines, s); return h && h.act === 'permit'; }).length;
    const q = input('count', '通るパケットの数', 'number', '半角の数字', String(pass));
    return {
      ...q,
      text: `ルーター R1 の標準 ACL(送信元のアドレスだけを見る)は表のとおり。送信元が ${srcs.map(ip).join('・')} の ${nP} 個のパケットがそれぞれ届いた。通る(許可される)パケットはいくつ?`,
      table: aclTable(lines),
      firstStep: 'まず 1 個ずつ、上の行から順に当てる',
      explanation: `${srcs.map((s) => explainAcl(lines, s)).join('\n')}\n許可されるのは ${pass} 個。`,
      kind: 'cl222-acl-count-v1', meta: { srcs: srcs.map(ip) },
    };
  }
}
function verifyL222(q) {
  const acl = q.table.rows; const n = q.meta.srcs.filter((s) => evalAclBits(acl, s).startsWith('permit')).length;
  must(accept0(q) === String(n), `${q.kind}: 通る数が違う`);
}
function makeL223(rng) {
  for (;;) {
    const k = rng.pick([6, 7, 8, 9, 10, 11, 12, 14, 16]); const p = 32 - k;
    const start = netOf(priv16(rng) + rng.rand(0, 65535), p); const last = start + size(p) - 1;
    const r = rng.next();
    const right = r < 0.15 ? start : r < 0.3 ? last : start + rng.rand(1, size(p) - 2);
    const flip = (right ^ (2 ** (k + rng.rand(0, 3)))) >>> 0;
    const flip2 = (right ^ (2 ** (k + rng.rand(4, 7)))) >>> 0;
    const wrongs = [last + 1, start - 1, flip, flip2].filter((a) => allowed(a) && netOf(a, p) !== start).map(ip);
    if (new Set(wrongs).size < 3) continue;
    const c = choices(rng, ip(right), wrongs, 4);
    return {
      text: `ACL の条件「${ip(start)} ${wild(p)}」に当たる(一致する)アドレスはどれ?`,
      ...c,
      firstStep: 'まずワイルドカードの 0 のビットは一致が要ると思い出す',
      explanation: `ワイルドカードの 0 のビットは一致が要り、1 のビットは何でもよい。${wild(p)} は下の ${k} ビットが 1 なので、当たる範囲は ${ip(start)}〜${ip(last)}。この中にあるのは ${ip(right)} だけ。`,
      kind: 'cl223-wildcard-v1', meta: { start: ip(start), wild: wild(p) },
    };
  }
}
function verifyL223(q) {
  const ab = bits(q.meta.start), wb = bits(q.meta.wild);
  const hits = q.options.map((o) => [...bits(o)].every((c, i) => wb[i] === '1' || ab[i] === c));
  must(hits.filter(Boolean).length === 1 && hits[q.answerIndex], `${q.kind}: 当たるアドレスが 1 つでない`);
  for (const o of q.options) must(allowed(num(o)), `${q.kind}: 範囲外のアドレス ${o}`);
}

// ---------- Lv234 仮想ネットワークのサブネット ----------
function makeL234(rng) {
  const p = rng.next() < 0.5 ? 16 : rng.rand(16, 22);
  const c = rng.next() < 0.5 && p <= 20 ? 24 : Math.min(28, p + rng.rand(2, 8));
  const parent = netOf(priv16(rng) + rng.rand(0, 65535), p);
  const cnt = 2 ** (c - p); const r = rng.next();
  const N = r < 0.2 ? 1 : r < 0.35 ? cnt : rng.rand(2, Math.max(2, cnt - 1));
  const sub = parent + (N - 1) * size(c);
  const st = stepOf(c);
  const q = input('subnet', 'サブネット(CIDR)', 'ipv4cidr', '例: 10.0.2.0/24', `${ip(sub)}/${c}`);
  return {
    ...q,
    text: `PC クラウドで、仮想ネットワーク(アドレスの範囲 ${ip(parent)}/${p})を、前から順に同じ大きさの /${c} のサブネットに分ける。${N} 番目のサブネットは?(1 番目は範囲の先頭から始まる。CIDR で答える)`,
    firstStep: `まず /${c} の 1 つの大きさ(第 ${st.octet} オクテットでいくつずつか)を出す`,
    explanation: `/${c} の 1 つは ${fmt(size(c))} 個のアドレス(第 ${st.octet} オクテットで ${st.step} ずつ)。/${p} の中に ${fmt(cnt)} 個ある。${N} 番目は先頭から (${N} − 1) × ${fmt(size(c))} 進んだ所なので ${ip(sub)}/${c}。${N} × ${fmt(size(c))} 進めると 1 つずれる。`,
    kind: 'cl234-vnet-subnet-v1', meta: { parent: ip(parent), p, c, N },
  };
}
function verifyL234(q) {
  const { parent, p, c, N } = q.meta;
  must(N >= 1 && BigInt(N) <= 2n ** BigInt(c - p), `${q.kind}: 番号が範囲外`);
  const n = BigInt(num(parent)) + BigInt(N - 1) * (2n ** BigInt(32 - c));
  const s = [24n, 16n, 8n, 0n].map((sh) => (n >> sh) & 255n).join('.');
  must(accept0(q) === `${s}/${c}`, `${q.kind}: サブネットが違う`);
  must(inBits(s, parent, p), `${q.kind}: 親の範囲の外`);
}

// ---------- Lv239 コンテナのポートの公開 ----------
const CONT = { web: 80, api: 8080, app: 3000, shop: 80, blog: 80, admin: 443, db: 5432, cache: 6379 };
const HOST_PORTS = [8080, 8081, 8000, 8443, 3000, 3001, 5000, 9000, 9080, 15432, 16379, 18080];
function makeL239(rng) {
  const host = `192.168.${rng.rand(0, 255)}.${rng.rand(2, 254)}`;
  const names = rng.shuffle(Object.keys(CONT)).slice(0, rng.rand(2, 4));
  const used = new Set(); const rows = names.map((n, i) => {
    const cp = CONT[n]; let hp;
    if (rng.next() < 0.2 && !used.has(cp)) hp = cp; else { do hp = rng.pick(HOST_PORTS); while (used.has(hp) || hp === cp); }
    used.add(hp); return { name: n, inner: `172.17.0.${i + 2}`, cp, hp };
  });
  const t = rng.pick(rows);
  const q = input('dest', '宛先(アドレス:ポート)', 'addrport', '例: 192.0.2.1:8080', `${host}:${t.hp}`);
  return {
    ...q,
    text: `機械(ホスト)${host} の上でコンテナが動いている。ポートの公開は表のとおり(機械のポートに届いた通信を、コンテナのポートへ渡す)。コンテナの内側のアドレス(172.17.0.x)には、機械の外からは直接届かない。外の PC から ${t.name} コンテナのサービスを使うとき、宛先に打つアドレスとポートは?「アドレス:ポート」の形で答える。`,
    table: { headers: ['コンテナ', '内側のアドレス', 'コンテナのポート', '機械で公開したポート'], rows: rows.map((r) => [r.name, r.inner, String(r.cp), String(r.hp)]) },
    firstStep: 'まず外から見えるのは機械のアドレスだと考える',
    explanation: `外から届くのは機械のアドレス ${host} だけ。${t.name} はコンテナの ${t.cp} 番を、機械の ${t.hp} 番で公開しているので、宛先は ${host}:${t.hp}。機械が受けた通信を ${t.inner}:${t.cp} へ渡す。${t.inner}:${t.cp} は内側のアドレスなので、外からは届かない。`,
    kind: 'cl239-container-port-v1', meta: { host, name: t.name },
  };
}
function verifyL239(q) {
  const r = q.table.rows.filter((x) => x[0] === q.meta.name); must(r.length === 1, `${q.kind}: コンテナが 1 行でない`);
  must(accept0(q) === `${q.meta.host}:${r[0][3]}`, `${q.kind}: 宛先が違う`);
  must(new Set(q.table.rows.map((x) => x[3])).size === q.table.rows.length, `${q.kind}: 機械のポートが重なっている`);
}

// ================= 表のレベル(組み立てが要るもの) =================

// ---------- Lv188 タグとネイティブ VLAN(○×。ネイティブ VLAN の番号を変える問いを混ぜる) ----------
function makeL188(rng) {
  if (rng.next() < 0.5) {
    const N = rng.pick([1, 1, 10, 20, 99, 100, 999]);
    const V = rng.next() < 0.5 ? N : rng.pick([1, 10, 20, 30, 99, 100, 200].filter((x) => x !== N));
    const untag = rng.next() < 0.5;
    const isTrue = untag ? V === N : V !== N;
    const st = `ネイティブ VLAN が ${N} のトランクで、VLAN ${V} のフレームは${untag ? 'タグを付けずに' : 'タグを付けて'}送られる`;
    const tf = trueFalse(st, isTrue);
    return {
      text: `次の文は正しいですか。(どちらの端も、ネイティブ VLAN にタグを付ける特別な設定はしていない)\n「${st}」`, options: tf.options, answerIndex: tf.answerIndex,
      firstStep: 'まずネイティブ VLAN のフレームがどう送られるかを思い出す',
      explanation: `${isTrue ? '正しい' : '誤り'}。トランクでは、ネイティブ VLAN(${N})のフレームだけタグを付けずに送り、ほかの VLAN のフレームにはタグを付ける。VLAN ${V} は${V === N ? 'ネイティブ VLAN なのでタグなし' : 'ネイティブ VLAN ではないのでタグ付き'}。`,
      kind: 'cl188-native-tag-v1', meta: { N, V, untag },
    };
  }
  const q = askRow(rng, B.tag, rng.pick(askRows(B.tag)));
  return { ...q, firstStep: 'まずネイティブ VLAN の意味を思い出す', kind: 'cl188-native-tag-v1' };
}
function verifyL188(q) {
  if (!q.meta.rowId) { const { N, V, untag } = q.meta; must(q.answerIndex === ((untag ? V === N : V !== N) ? 0 : 1), `${q.kind}: タグの答えが違う`); return; }
  verifyRow(q, B.tag);
}

// ---------- Lv189 VLAN 間の通信 ----------
const INTER_OPTS = ['ルーターか L3 スイッチ', '同じ L2 スイッチにつなぐだけでよい', 'リピーターハブ', '無線アクセスポイント'];
function makeL189(rng) {
  const r = rng.next();
  if (r < 0.5) {
    const a = rng.pick([10, 20, 30, 40, 50]); const b = rng.next() < 0.45 ? a : rng.pick([10, 20, 30, 40, 50].filter((x) => x !== a));
    const h1 = rng.rand(2, 120); const h2 = rng.rand(121, 250);
    const desc = `スイッチ SW1 に、PC1(VLAN ${a}、192.168.${a}.${h1}/24)と PC2(VLAN ${b}、192.168.${b}.${h2}/24)がつながっている。`;
    if (a !== b && rng.next() < 0.4) {
      const c = choices(rng, INTER_OPTS[0], INTER_OPTS.slice(1), 4);
      return { text: `${desc}PC1 と PC2 がやりとりするのに要るものはどれ?`, ...c, firstStep: 'まず VLAN が違えば別の網だと考える', explanation: `VLAN が違う(${a} と ${b})ので別の網。網と網の間をつなぐルーターか L3 スイッチが要る。L2 スイッチは VLAN をまたいでフレームを運ばない。ハブやアクセスポイントにも網をつなぐ働きは無い。`, kind: 'cl189-inter-vlan-v1', meta: { a, b, choice: true } };
    }
    const st = 'PC1 から PC2 へ届けるには、ルーターか L3 スイッチを通る必要がある';
    const tf = trueFalse(st, a !== b);
    return { text: `${desc}次の文は正しいですか。\n「${st}」`, options: tf.options, answerIndex: tf.answerIndex, firstStep: 'まず 2 台の VLAN が同じか見る', explanation: a !== b ? `正しい。VLAN が違う(${a} と ${b})ので別の網。ルーターか L3 スイッチを通って届く。` : `誤り。2 台とも VLAN ${a} で、同じサブネット(192.168.${a}.0/24)なので、SW1 の中で直接届く。`, kind: 'cl189-inter-vlan-v1', meta: { a, b } };
  }
  const q = askRow(rng, B.intervlan, rng.pick(askRows(B.intervlan)));
  return { ...q, firstStep: 'まず VLAN が違えば別の網だと考える', kind: 'cl189-inter-vlan-v1' };
}
function verifyL189(q) {
  if (q.meta.rowId) { verifyRow(q, B.intervlan); return; }
  const { a, b, choice } = q.meta;
  if (choice) must(a !== b && q.options[q.answerIndex] === INTER_OPTS[0], `${q.kind}: 要るものの答えが違う`);
  else must(q.answerIndex === (a !== b ? 0 : 1), `${q.kind}: ○× が違う`);
}

// ---------- Lv217 ログの重大度 ----------
const SEV = B.sev.rows.map((r) => ({ num: r.attrs.num, label: r.ja })).sort((a, b) => a.num - b.num);
function makeL217(rng) {
  const t = rng.pick(['num2name', 'name2num', 'heaviest', 'compare']);
  const fs = 'まず syslog の重大度は数が小さいほど重いと思い出す';
  const list = SEV.map((s) => `${s.num} ${s.label}`).join('、');
  if (t === 'num2name') {
    const s = rng.pick(SEV); const c = choices(rng, s.label, SEV.filter((x) => x !== s).map((x) => x.label), 4);
    return { text: `syslog の重大度(severity)${s.num} はどれ?`, ...c, firstStep: fs, explanation: `重大度 ${s.num} は ${s.label}。0〜7 は ${list}。`, kind: 'cl217-severity-v1', meta: { t, num: s.num } };
  }
  if (t === 'name2num') {
    const s = rng.pick(SEV); const q = input('severity', '重大度の数', 'number', '0〜7 の数字', String(s.num));
    return { ...q, text: `syslog の重大度(severity)で ${s.label} は何番?(0〜7 の数で答える)`, firstStep: fs, explanation: `${s.label} は ${s.num}。0〜7 は ${list}。`, kind: 'cl217-severity-v1', meta: { t, num: s.num } };
  }
  if (t === 'heaviest') {
    const four = rng.shuffle(SEV).slice(0, 4); const best = four.reduce((a, b) => (b.num < a.num ? b : a));
    const c = choices(rng, best.label, four.filter((x) => x !== best).map((x) => x.label), 4);
    return { text: 'syslog の重大度(severity)で、次のうちいちばん重い(深刻な)ものはどれ?', ...c, firstStep: fs, explanation: `数が小さいほど重い。この中でいちばん小さいのは ${best.num} の ${best.label}。0〜7 は ${list}。`, kind: 'cl217-severity-v1', meta: { t, nums: four.map((x) => x.num) } };
  }
  const [x, y] = rng.shuffle(SEV).slice(0, 2);
  const st = `syslog の重大度 ${x.num}(${x.label})のログは、重大度 ${y.num}(${y.label})のログより重い(深刻な)`;
  const tf = trueFalse(st, x.num < y.num);
  return { text: `次の文は正しいですか。\n「${st}」`, options: tf.options, answerIndex: tf.answerIndex, firstStep: fs, explanation: `${x.num < y.num ? '正しい' : '誤り'}。syslog の重大度は数が小さいほど重い。${Math.min(x.num, y.num)} のほうが重い。`, kind: 'cl217-severity-v1', meta: { t, x: x.num, y: y.num } };
}
function verifyL217(q) {
  const lab = (n) => SEV.find((s) => s.num === n).label; const m = q.meta;
  must(SEV.length === 8 && SEV.every((s, i) => s.num === i), `${q.kind}: 重大度の表が 0〜7 でない`);
  if (m.t === 'num2name') must(q.options[q.answerIndex] === lab(m.num), `${q.kind}: 名前が違う`);
  else if (m.t === 'name2num') must(accept0(q) === String(m.num), `${q.kind}: 番号が違う`);
  else if (m.t === 'heaviest') must(q.options[q.answerIndex] === lab(Math.min(...m.nums)), `${q.kind}: いちばん重いものが違う`);
  else must(q.answerIndex === (m.x < m.y ? 0 : 1), `${q.kind}: 比べた答えが違う`);
}

// ---------- Lv219 電子署名(送り手・受け手の名前を入れ替える) ----------
const PEOPLE = ['A さん', 'B さん', 'C さん', 'D さん'];
function makeL219(rng) {
  const [S, R] = rng.shuffle(PEOPLE).slice(0, 2);
  const sub = (s) => s.replace(/\{S\}/g, S).replace(/\{R\}/g, R);
  const rows = askRows(B.sig); const qs = rows.filter((r) => r.attrs.type === 'q');
  const row = rng.next() < 0.6 ? rng.pick(qs) : rng.pick(rows.filter((r) => r.attrs.type === 't'));
  const q = askRow(rng, B.sig, row, { sub });
  return { ...q, firstStep: 'まず、その鍵を持っているのは誰かを考える(秘密鍵は持ち主だけ)', kind: 'cl219-signature-v1', meta: { ...q.meta, S, R } };
}
function verifyL219(q) { verifyRow(q, B.sig, (s) => s.replace(/\{S\}/g, q.meta.S).replace(/\{R\}/g, q.meta.R)); }

// ---------- Lv229 切り分けの順番(並べ替え) ----------
function makeL229(rng) {
  const up = rng.next() < 0.75;
  const pick = rng.shuffle(B.layers.rows).slice(0, 4);
  const order = pick.map((r, i) => ({ i: i + 1, num: r.attrs.num })).sort((a, b) => (up ? a.num - b.num : b.num - a.num)).map((x) => x.i);
  const ans = order.join('-');
  const q = input('order', '確かめる順(番号)', 'devname', '例: 3-1-4-2', ans);
  return {
    ...q,
    text: `通信がうまくいかないので、OSI 参照モデルの${up ? '下の層から順に確かめる方法(ボトムアップ)' : '上の層から順に確かめる方法(トップダウン)'}で調べる。次の 4 つを確かめる順に、番号を「3-1-4-2」のように並べて答える。\n${pick.map((r, i) => `${i + 1}. ${r.ja}: ${r.attrs.check}`).join('\n')}`,
    firstStep: up ? 'まずいちばん下の層(番号の小さい層)を探す' : 'まずいちばん上の層(番号の大きい層)を探す',
    explanation: `OSI 参照モデルの層の番号は、物理層 1、データリンク層 2、ネットワーク層 3、トランスポート層 4、アプリケーション層 7。${up ? '下から' : '上から'}並べると ${order.map((i) => pick[i - 1].ja).join(' → ')} なので ${ans}。`,
    kind: 'cl229-troubleshoot-order-v1', meta: { up, ids: pick.map((r) => r.id) },
  };
}
function verifyL229(q) {
  const rows = q.meta.ids.map((id) => B.layers.byId.get(id));
  const idx = [1, 2, 3, 4].sort((a, b) => (q.meta.up ? 1 : -1) * (rows[a - 1].attrs.num - rows[b - 1].attrs.num));
  must(accept0(q) === idx.join(''), `${q.kind}: 並べ方が違う`);
  must(new Set(rows.map((r) => r.attrs.num)).size === 4, `${q.kind}: 同じ層が 2 つある`);
}

// ---------- Lv236 VM ごとの規則とサブネットの規則 ----------
const SG_LEAD = 'PC クラウドでは、VM ごとに付ける規則を「セキュリティグループ」(状態を見る。許可に書いた通信だけを通す)、サブネットに付ける規則を「ネットワーク ACL」(状態を見ない。はじめはすべての通信を通す設定)と呼ぶ。';

// ---------- Lv238 仮想化の機械への線 ----------
function makeL238(rng) {
  if (rng.next() < 0.6) {
    const vl = rng.shuffle([10, 20, 30, 40, 99]).slice(0, rng.rand(2, 3)).sort((a, b) => a - b);
    const vms = vl.map((v, i) => `VM${i + 1}(VLAN ${v})`);
    const ok = `トランク(VLAN ${vl.join('・')} を通す)`;
    const wrong = [`トランク(VLAN ${vl[0]} だけを通す)`, `アクセス(VLAN ${vl[0]})`, `アクセス(VLAN ${vl[1]})`, `トランク(VLAN ${vl.slice(0, -1).join('・')} を通す)`].filter((w) => w !== ok);
    const c = choices(rng, ok, [...new Set(wrong)], 4);
    return {
      text: `仮想化の機械 HV1 の上で ${vms.join('・')} が動き、どの VM も外の網とやりとりする。HV1 の物理 NIC は 1 枚で、物理スイッチ SW1 の 1 つのポートにつながる。SW1 のそのポートの設定として正しいのは?`,
      ...c, firstStep: 'まず 1 本の線に VLAN がいくつ通るかを数える',
      explanation: `1 本の線で VLAN ${vl.join('・')} を運ぶので、トランクにして ${vl.length} つの VLAN をすべて通す。アクセスポートは 1 つの VLAN しか運ばず、通す VLAN が足りないトランクでは、足りない VLAN の VM が外とやりとりできない。`,
      kind: 'cl238-host-trunk-v1', meta: { vl },
    };
  }
  const q = askRow(rng, B.htrunk, rng.pick(askRows(B.htrunk)));
  return { ...q, firstStep: 'まず 1 本の線に VLAN がいくつ通るかを数える', kind: 'cl238-host-trunk-v1' };
}
function verifyL238(q) {
  if (q.meta.rowId) { verifyRow(q, B.htrunk); return; }
  const { vl } = q.meta; const ok = `トランク(VLAN ${vl.join('・')} を通す)`;
  must(vl.length >= 2 && q.options[q.answerIndex] === ok && q.options.filter((o) => o === ok).length === 1, `${q.kind}: 正しい設定が違う`);
}

// ================= レベルの一覧 =================
const gen = (title, make, verify) => ({ title, kind: '生', make, verify, minDistinct: 1000 });
const LEVELS = {
  166: gen('集約できない組', makeL166, verifyL166),
  180: gen('EUI-64', makeL180, verifyL180),
  181: tableLevel('SLAAC', B.slaac, 'まず誰がアドレスを決める(配る)のかを考える', 'cl181-slaac-v1'),
  182: tableLevel('近隣探索', B.nd, 'まず IPv4 の ARP の代わりを思い出す', 'cl182-nd-v1'),
  183: gen('フラッディング', makeL183, verifyL183),
  184: gen('学習の結果', makeL184, verifyL184),
  185: gen('ARP で調べる相手', makeL185, verifyL185),
  186: tableLevel('VLAN とは', B.vlan, 'まず 1 台のスイッチの中で LAN を「分ける」しくみを思い出す', 'cl186-vlan-v1'),
  187: gen('アクセスとトランク', makeL187, verifyL187),
  188: { title: 'タグとネイティブ VLAN', kind: '表', make: makeL188, verify: verifyL188, minDistinct: 20 },
  189: { title: 'VLAN 間の通信', kind: '表', make: makeL189, verify: verifyL189, minDistinct: 20 },
  190: tableLevel('ループ', B.loop, 'まずイーサネットのフレームには TTL が無いことを思い出す', 'cl190-loop-v1'),
  191: gen('ルートブリッジ', makeL191, verifyL191),
  194: tableLevel('MTU とは', B.mtu, 'まずイーサネットの MTU は 1,500 バイトだと思い出す', 'cl194-mtu-v1'),
  195: gen('断片の数', makeL195, verifyL195),
  196: gen('断片のオフセット', makeL196, verifyL196),
  197: gen('AD 値で選ぶ', makeL197, verifyL197),
  198: gen('メトリックで選ぶ', makeL198, verifyL198),
  199: gen('最長一致が先', makeL199, verifyL199),
  202: tableLevel('動的ルーティングの種類', B.rkind, 'まず RIP・OSPF・BGP の経路の決め方の違いを思い出す', 'cl202-routing-kind-v1'),
  211: gen('DHCP のプールと除外', makeL211, verifyL211),
  212: gen('DHCP の予約', makeL212, verifyL212),
  213: tableLevel('DHCP リレー', B.relay, 'まずブロードキャストはルーターを越えないことを思い出す', 'cl213-dhcp-relay-v1'),
  214: gen('DNS のゾーンを読む', makeL214, verifyL214),
  216: tableLevel('NTP・SNMP・syslog', B.mgmt, 'まず NTP・SNMP・syslog の 3 つの役割を思い出す', 'cl216-mgmt-proto-v1'),
  217: { title: 'ログの重大度', kind: '表', make: makeL217, verify: verifyL217, minDistinct: 20 },
  218: tableLevel('ハッシュ', B.hash, 'まず「元に戻せない」のはどれかを考える', 'cl218-hash-v1'),
  219: { title: '電子署名', kind: '表', make: makeL219, verify: verifyL219, minDistinct: 20 },
  220: tableLevel('証明書', B.cert, 'まず公開鍵が本人のものだと第三者が保証するしくみを思い出す', 'cl220-cert-v1'),
  221: gen('標準 ACL を 3〜5 行', makeL221, verifyL221),
  222: gen('複数のパケット', makeL222, verifyL222),
  223: gen('ワイルドカードで読む', makeL223, verifyL223),
  224: tableLevel('VPN の種類', B.vpn, 'まず誰と誰(拠点どうしか、PC 1 台か)をつなぐかを考える', 'cl224-vpn-kind-v1'),
  225: tableLevel('SSH と Telnet', B.ssh, 'まず暗号化するかどうかを考える', 'cl225-ssh-telnet-v1'),
  226: tableLevel('コンソール', B.con, 'まず機器に網の設定がまだ無いときを考える', 'cl226-console-v1'),
  227: tableLevel('traceroute のしくみ', B.tr, 'まず TTL が 0 になったルーターが返事をすることを思い出す', 'cl227-traceroute-v1'),
  229: { title: '切り分けの順番', kind: '表', make: makeL229, verify: verifyL229, minDistinct: 20 },
  231: tableLevel('IPsec と SSL-VPN', B.ipsec, 'まず暗号をかける層(IPsec は IP、SSL-VPN は TLS)を考える', 'cl231-ipsec-ssl-v1'),
  232: tableLevel('リモートアクセス VPN の通り道', B.split, 'まず全部の通信を VPN に通すかどうかを考える', 'cl232-split-tunnel-v1'),
  233: tableLevel('地域とゾーン', B.zone, 'まず「地域」と「その中の区画(ゾーン)」の 2 段を思い出す', 'cl233-region-zone-v1'),
  234: gen('仮想ネットワークのサブネット', makeL234, verifyL234),
  235: tableLevel('NAT ゲートウェイ', B.natgw, 'まず「出るだけ」か「入りも」かを考える', 'cl235-nat-gateway-v1'),
  236: tableLevel('VM ごとの規則とサブネットの規則', B.sg, 'まず規則の付く場所(VM かサブネットか)と、状態を見るかどうかを考える', 'cl236-sg-acl-v1', { lead: SG_LEAD }),
  237: tableLevel('仮想スイッチ', B.vsw, 'まず VM の NIC もソフトだと考える', 'cl237-vswitch-v1'),
  238: { title: '仮想化の機械への線', kind: '表', make: makeL238, verify: verifyL238, minDistinct: 20 },
  239: gen('コンテナのポートの公開', makeL239, verifyL239),
  240: tableLevel('NFV', B.nfv, 'まず「網の機能を仮想化する」ことだと考える', 'cl240-nfv-v1'),
};

module.exports = { LEVELS, internals: { B, bank, askRows, evalAclBits, fragSim, ALLOWED, allowed, bits } };
