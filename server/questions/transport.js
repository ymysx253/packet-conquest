'use strict';
// Lv51〜60「トランスポートとポート」の問題生成器(docs/questions/design-51-100.md 第 2 章、COMMON.md)。
//   Lv51 TCP と UDP の性質の違い(4 択。FactBank tcp-udp)
//   Lv52 サービス → 既定ポート(入力 number。FactBank ports)
//   Lv53 ポート → サービス(4 択。FactBank ports)/ 番号の 3 区分(4 択。生成)
//   Lv54 ハンドシェイクの段(4 択。FactBank handshake)/ エフェメラルポート(4 択。生成)
//   Lv55 ハンドシェイクの seq/ack(入力 number)
//   Lv56 データ転送中の累積 ACK と次の seq(入力 number)
//   Lv57 5 タプルで接続を数える(表 + 入力 number)
//   Lv58 NAPT 表に新規フロー 1 行(衝突なし。表 + 入力 addrport)
//   Lv59 NAPT のポート付け替え(衝突あり。表 + 入力 addrport)
//   Lv60 NAPT に新規フロー 2〜3 本を順に(衝突の連鎖と TCP/UDP の名前空間。表 2 つ + 入力 addrport)
// ゲーム内の規則(設計書 第 2 章の冒頭。本文に毎回書く):
//   - エフェメラルポートは IANA の 49152〜65535
//   - NAPT はポート保持。使用中なら「衝突した番号から 1 ずつ上げて最初の空き」。TCP と UDP は別の名前空間
//   - ISN は 1,000,000〜2,000,000,000。2^32 の折り返しと FIN は出さない
// 乱数は引数の rng(makeRng)だけを使う。Math.random は使わない。
// q.meta はテスト用の真の値、fields[].accept は正規形の正解。どちらもクライアントには送らない。

const { toIp } = require('./subnet');
const { normalize } = require('./normalize');

const VERSION = '2026.10';
const RANGE = [51, 60];

const FACTS = {
  tcpUdp: require('./data/facts/tcp-udp.json').rows.filter((r) => r.checkedBy),
  ports: require('./data/facts/ports.json').rows.filter((r) => r.checkedBy),
  handshake: require('./data/facts/handshake.json').rows.filter((r) => r.checkedBy),
};

const fmt = (n) => n.toLocaleString('ja-JP');
const EPHEMERAL = [49152, 65535];
const DEFAULT_NODE = { base: 0x0a000000, span: 4094, name: '' }; // 10.0.0.0/20 相当

// 正解 + 候補から重複なしの 4 択(subnet.buildOptions と同じ流儀。並べ替えは rng で行う)
function buildOptions(rng, correct, candidates, filler) {
  const set = new Set([correct]);
  for (const c of candidates) { if (set.size >= 4) break; if (c != null && c !== '') set.add(c); }
  let guard = 0;
  while (set.size < 4 && guard++ < 50) set.add(filler());
  const options = rng.shuffle([...set]);
  return { options, answerIndex: options.indexOf(correct), answerKind: 'choice' };
}
// 入力式の問題の骨組み(1 欄)
function textField(name, label, format, hint, accept) {
  return { answerKind: 'text', fields: [{ name, label, format, hint, accept: accept.map((a) => normalize(format, a)) }], compare: 'ordered' };
}
// 拠点の架空ネットワークから互いに異なるホストアドレスを n 個
function insideHosts(node, rng, n) {
  const span = Math.max(16, node.span || 4094);
  const seen = new Set();
  while (seen.size < n) seen.add(rng.rand(1, span - 1));
  return [...seen].map((h) => toIp((node.base + h) >>> 0));
}
// 互いに異なる整数を n 個(lo〜hi)
function distinctInts(rng, n, lo, hi) {
  const seen = new Set();
  while (seen.size < n) seen.add(rng.rand(lo, hi));
  return [...seen];
}
const outsideServer = (rng) => `198.51.100.${rng.rand(2, 250)}`;
const SERVICE_PORTS = [80, 443, 53];

// ---------- Lv51 TCP と UDP の性質(固定テンプレート tcp-udp-fact-v1) ----------
const TCPUDP_KINDS = {
  tcp: { label: 'TCP にはあって UDP にはない', has: (r) => r.attrs.tcp && !r.attrs.udp },
  udp: { label: 'UDP にはあって TCP にはない', has: (r) => r.attrs.udp && !r.attrs.tcp },
  both: { label: 'TCP と UDP の両方にある', has: (r) => r.attrs.tcp && r.attrs.udp },
};
function tcpUdpFact(node, rng, force = {}) {
  const kind = force.kind || rng.pick(Object.keys(TCPUDP_KINDS));
  const k = TCPUDP_KINDS[kind];
  const rows = FACTS.tcpUdp;
  const row = force.row || rng.pick(rows.filter(k.has));
  const wrong = rng.shuffle(rows.filter((r) => !k.has(r))).map((r) => r.ja);
  const q = buildOptions(rng, row.ja, wrong, () => 'どちらにも無い性質');
  q.text = `次のうち、${k.label}性質はどれ？`;
  q.explanation = `「${row.ja}」は${k.label}性質。接続の確立・確認応答と再送・順序の保証・フロー制御・輻輳制御は TCP だけ。ブロードキャストやマルチキャスト宛に送れるのは UDP だけ。ポート番号とチェックサムは両方にある。ヘッダ長は TCP が最小 20 バイト、UDP が 8 バイト固定。`;
  q.defenseNote = kind === 'udp' || row.id === 'ack-retransmit'
    ? '再送の無い UDP は到達の保証が無いので、監視では応答の有無を別に確認する。'
    : 'TCP と UDP で性質が違うことを知っていると、ファイアウォールの状態管理(接続の追跡)がどちらに効くかを見分けられる。';
  q.templateId = 'tcp-udp-fact-v1'; q.type = 'tcpudp'; q.meta = { rowId: row.id, kind, attrs: row.attrs };
  return q;
}

// ---------- Lv52 サービス → 既定ポート(固定テンプレート port-of-service-v1) ----------
function portOfService(node, rng, force = {}) {
  const row = force.row || rng.pick(FACTS.ports);
  const a = row.attrs;
  const tr = a.transport.toUpperCase();
  const q = textField('port', 'ポート番号', 'number', '半角の数字', [String(a.port)]);
  q.text = `${a.service} は${row.ja}に使うプロトコル。${a.ask ? `${a.ask}ポートとして` : ''}既定で使う ${tr} ポート番号は？ 半角の数字で答える。`;
  q.explanation = `${a.label} は ${tr} ${a.port}。${row.note ? row.note + '。' : ''}覚え方: HTTP 80、HTTPS 443、SSH 22、SMTP 25 は TCP。DNS 53、DHCP 67(サーバー)/68(クライアント)、NTP 123、SNMP 161(問い合わせ)/162(トラップ)は UDP が主。`;
  q.defenseNote = `既定ポート ${a.port} を知っていると、ファイアウォールの許可行を必要なサービスだけに絞れる。`;
  q.templateId = 'port-of-service-v1'; q.type = 'portof'; q.meta = { rowId: row.id, port: a.port, transport: a.transport };
  return q;
}

// ---------- Lv53 ポート → サービス(固定テンプレート service-of-port-v1)/ 3 区分(生成 port-range-v1) ----------
function serviceOfPort(node, rng, force = {}) {
  const row = force.row || rng.pick(FACTS.ports);
  const a = row.attrs;
  const tr = a.transport.toUpperCase();
  const wrong = rng.shuffle(FACTS.ports.filter((r) => r.attrs.port !== a.port)).map((r) => r.attrs.label);
  const q = buildOptions(rng, a.label, wrong, () => 'FTP');
  q.text = `${tr} ポート ${a.port} を既定で使うサービスは？`;
  q.explanation = `${tr} ${a.port} は ${a.label}(${row.ja}${a.ask ? `で${a.ask}ポート` : ''})。${row.note ? row.note + '。' : ''}`;
  q.defenseNote = `ポート ${a.port} がどのサービスかを知っていると、通信記録に見慣れない宛先ポートが現れたときに正常か判断できる。`;
  q.templateId = 'service-of-port-v1'; q.type = 'serviceof'; q.meta = { rowId: row.id, port: a.port, transport: a.transport };
  return q;
}
const RANGE_LABELS = { well: 'ウェルノウンポート', reg: '登録済みポート', dyn: '動的・プライベートポート(エフェメラル)' };
const rangeOf = (n) => (n < 1024 ? 'well' : n < 49152 ? 'reg' : 'dyn');
function portRange(node, rng, force = {}) {
  let n;
  if (force.n !== undefined) n = force.n;
  else if (rng.next() < 0.2) n = rng.pick([1023, 1024, 49151, 49152]);
  else { const r = rng.pick(['well', 'reg', 'dyn']); n = r === 'well' ? rng.rand(0, 1023) : r === 'reg' ? rng.rand(1024, 49151) : rng.rand(49152, 65535); }
  const correct = RANGE_LABELS[rangeOf(n)];
  const q = buildOptions(rng, correct, [...Object.values(RANGE_LABELS).filter((l) => l !== correct), '予約済みポート(そのような区分は無い)'], () => '予約済みポート');
  q.text = `ポート番号 ${n} は、IANA が定める番号の 3 区分のどれに属する？`;
  q.explanation = `IANA の区分は、ウェルノウン 0〜1023(主要サービスが待ち受ける)、登録済み 1024〜49151(登録されたアプリケーション)、動的・プライベート 49152〜65535(クライアントの送信元に使うエフェメラルポート)。${n} は${correct}。`;
  q.defenseNote = '番号の区分を知っていると、サーバーが 49152 以上のポートで待ち受けているような「場違いな」設定に気づける。';
  q.templateId = 'port-range-v1'; q.type = 'portrange'; q.meta = { n, range: rangeOf(n) };
  return q;
}

// ---------- Lv54 ハンドシェイクの段(固定テンプレート handshake-fact-v1)/ エフェメラル(生成 ephemeral-pick-v1) ----------
const SENDER_JA = { client: 'クライアント(接続を始める側)', server: 'サーバー(待ち受ける側)' };
const SENDER_SHORT = { client: 'クライアント', server: 'サーバー' };
const HS_RULE = 'TCP の 3 ウェイハンドシェイクは、クライアントの SYN → サーバーの SYN+ACK → クライアントの ACK の 3 段。';
function handshakeFact(node, rng, force = {}) {
  const rows = FACTS.handshake;
  const row = force.row || rng.pick(rows);
  const kind = force.kind || rng.pick(['flag', 'sender', 'step']);
  const a = row.attrs;
  const other = rows.filter((r) => r.id !== row.id);
  let q;
  if (kind === 'flag') {
    q = buildOptions(rng, a.flags, rng.shuffle([...other.map((r) => r.attrs.flags), ...rng.shuffle(['FIN', 'RST'])]), () => 'PSH');
    q.text = `TCP の 3 ウェイハンドシェイクの ${a.step} 段目で送られるセグメントに立っているフラグは？`;
  } else if (kind === 'sender') {
    const combo = (s, f) => `${SENDER_SHORT[s]}が ${f} を送る`;
    const swapped = combo(a.sender === 'client' ? 'server' : 'client', a.flags);
    q = buildOptions(rng, combo(a.sender, a.flags), [swapped, ...other.map((r) => combo(r.attrs.sender, r.attrs.flags))], () => 'ルータが RST を送る');
    q.text = `TCP の 3 ウェイハンドシェイクの ${a.step} 段目(${row.ja})では、だれがどのフラグのセグメントを送る？`;
  } else {
    q = buildOptions(rng, `${a.step} 段目`, [...other.map((r) => `${r.attrs.step} 段目`), 'ハンドシェイクには含まれない'], () => '4 段目');
    q.text = `TCP の 3 ウェイハンドシェイクで、${SENDER_SHORT[a.sender]}が ${a.flags} を送るのは何段目？(1 始まりで数える)`;
  }
  q.explanation = `${HS_RULE}${a.step} 段目は${SENDER_JA[a.sender]}が ${a.flags} を送る(${row.ja})。FIN は切断、RST は強制切断に使い、ハンドシェイクには出ない。`;
  q.defenseNote = 'SYN に対して ACK が返らない接続が大量に残っているときは正常なハンドシェイクではないので、途中で止まった接続の数を監視の指標にできる。';
  q.templateId = 'handshake-fact-v1'; q.type = 'handshake'; q.meta = { rowId: row.id, kind, attrs: a };
  return q;
}
const WELL_KNOWN = [80, 443, 22, 25, 53, 123];
function ephemeralPick(node, rng, force = {}) {
  const correct = force.port !== undefined ? force.port : rng.rand(EPHEMERAL[0], EPHEMERAL[1]);
  const wrongs = rng.shuffle(WELL_KNOWN).slice(0, 2);
  let extra; do { extra = rng.rand(1, 1023); } while (WELL_KNOWN.includes(extra));
  wrongs.push(extra);
  const q = buildOptions(rng, String(correct), rng.shuffle(wrongs).map(String), () => String(rng.rand(1, 1023)));
  q.text = `クライアントが TCP 接続を始めるとき、送信元ポートには IANA の推奨範囲(49152〜65535)のエフェメラルポートが使われる。次のうち、クライアントの送信元ポートとして使われ得る番号はどれ？`;
  q.explanation = `宛先ポートはサービスの既定番号(80 や 443 など 1024 未満が多い)だが、送信元ポートはクライアントの OS が IANA の推奨範囲 49152〜65535 から空き番号を選ぶ。${correct} だけが範囲内。`;
  q.defenseNote = '送信元ポートがエフェメラル範囲であるのが普通なので、1024 未満の送信元ポートで内側から出て行く通信は点検の対象にできる。';
  q.templateId = 'ephemeral-pick-v1'; q.type = 'ephemeral'; q.meta = { port: correct, wrongs };
  return q;
}

// ---------- Lv55 ハンドシェイクの seq/ack(生成 handshake-seq-v1) ----------
const ISN = [1000000, 2000000000];
const HS_ASKS = {
  'synack-seq': { ja: 'サーバーが返す SYN/ACK セグメントの SEQ 番号', value: (a, b) => b },
  'synack-ack': { ja: 'サーバーが返す SYN/ACK セグメントの ACK 番号', value: (a, b) => a + 1 },
  'ack-seq': { ja: 'クライアントが 3 段目に送る ACK セグメントの SEQ 番号', value: (a, b) => a + 1 },
  'ack-ack': { ja: 'クライアントが 3 段目に送る ACK セグメントの ACK 番号', value: (a, b) => b + 1 },
};
function handshakeSeq(node, rng, force = {}) {
  let a = force.a !== undefined ? force.a : rng.rand(ISN[0], ISN[1]);
  let b = force.b !== undefined ? force.b : rng.rand(ISN[0], ISN[1]);
  while (Math.abs(a - b) < 2) b = rng.rand(ISN[0], ISN[1]); // a と b が隣り合うと +1 の取り違えを見分けられない
  const ask = force.ask || rng.pick(Object.keys(HS_ASKS));
  const v = HS_ASKS[ask].value(a, b);
  const q = textField('value', '番号', 'number', '半角の数字', [String(v)]);
  q.text = `TCP の 3 ウェイハンドシェイクで、クライアントの初期シーケンス番号(ISN)が ${fmt(a)}、サーバーの初期シーケンス番号が ${fmt(b)} のとき、${HS_ASKS[ask].ja}は？ 初期 seq は本文の値をそのまま使い、番号の折り返しは無いものとする。半角の数字で答える。`;
  q.explanation = `SYN と SYN/ACK の SYN は 1 バイト分の番号を消費する。SYN(seq=${fmt(a)})→ SYN/ACK(seq=${fmt(b)}, ack=${fmt(a + 1)})→ ACK(seq=${fmt(a + 1)}, ack=${fmt(b + 1)})。ACK 番号は「次に受け取りたい番号」なので相手の ISN + 1。答えは ${fmt(v)}。`;
  q.defenseNote = 'seq/ack の期待値を計算できると、期待から外れた番号で届くセグメントを接続に属さない異常として見分けられる。';
  q.templateId = 'handshake-seq-v1'; q.type = 'hsseq'; q.meta = { a, b, ask, value: v };
  return q;
}

// ---------- Lv56 データ転送中の seq/ack(生成 data-ack-v1) ----------
function dataAck(node, rng, force = {}) {
  const s = force.s !== undefined ? force.s : rng.rand(1000, 2000000000);
  const lens = force.lens || Array.from({ length: rng.rand(1, 3) }, () => (rng.next() < 0.4 ? 1460 : rng.rand(1, 1460)));
  const n = lens.length;
  const ask = force.ask || rng.pick(['ack', 'seq']);
  const k = ask === 'ack' ? (force.k !== undefined ? force.k : rng.rand(1, n)) : n;
  const sums = lens.reduce((acc, l) => acc.concat([acc[acc.length - 1] + l]), [0]); // sums[i] = 先頭 i 本の合計
  const v = s + sums[k];
  const q = textField('value', '番号', 'number', '半角の数字', [String(v)]);
  const segs = lens.map((l) => `${fmt(l)} バイト`).join('・');
  const head = `ハンドシェイク後、送信側の SEQ 番号は ${fmt(s)} から始まる(折り返しは無いものとする)。${n === 1 ? `${segs}のセグメントを 1 本送り、届いた。` : `${segs}の ${n} セグメントを続けて送り、すべて届いた。`}`;
  if (ask === 'ack') q.text = `${head}受信側が ${k === n ? `${n} 本すべて` : `${k} 本目まで`}を受け取った時点で返す ACK 番号は？ ACK 番号は「次に受け取りたいバイトの番号」で、複数本には累積して 1 つ返す。半角の数字で答える。`;
  else q.text = `${head}送信側が続けて送る次(${n + 1} 本目)のセグメントの SEQ 番号は？ SEQ 番号は「そのセグメントの先頭バイトの番号」。半角の数字で答える。`;
  q.explanation = `${fmt(s)} + ${lens.slice(0, k).map(fmt).join(' + ')} = ${fmt(v)}。ACK 番号は受け取った最後のバイトの次、次に送る SEQ 番号も同じ値。累積 ACK なので複数本まとめて 1 つの番号で答えられる。`;
  q.defenseNote = 'ACK 番号が届いたバイト数の累積になることを知っていると、通信記録から再送や欠落の有無を読み取れる。';
  q.templateId = 'data-ack-v1'; q.type = 'dataack'; q.meta = { s, lens, ask, k, value: v };
  return q;
}

// ---------- Lv57 5 タプル(生成 five-tuple-v1) ----------
function fiveTuple(node, rng, force = {}) {
  const [A, B] = insideHosts(node, rng, 2);
  const [S, S2, D] = distinctInts(rng, 3, 2, 250).map((x) => `198.51.100.${x}`);
  const pA = rng.rand(EPHEMERAL[0], 65000); const pB = pA + rng.rand(1, 100); const pC = pA + rng.rand(101, 300);
  const nConn = force.nConn || rng.rand(3, 5);
  const conns = [
    { proto: 'TCP', src: `${A}:${pA}`, dst: `${S}:443`, why: 'tcp' },
    { proto: 'TCP', src: `${A}:${pB}`, dst: `${S}:443`, why: 'sameip' },   // 同じ IP の別ポート
    { proto: 'UDP', src: `${A}:${pA}`, dst: `${D}:53`, why: 'proto' },     // 同じ送信元ポートで別プロトコル
  ];
  if (nConn >= 4) conns.push({ proto: 'TCP', src: `${B}:${pA}`, dst: `${S}:443`, why: 'otherhost' });
  if (nConn >= 5) conns.push({ proto: 'TCP', src: `${A}:${pC}`, dst: `${S2}:80`, why: 'otherdst' });
  const dupOf = rng.rand(0, conns.length - 1), revOf = rng.rand(0, conns.length - 1);
  const packets = conns.map((c) => ({ proto: c.proto, src: c.src, dst: c.dst, role: 'fwd' }));
  packets.push({ proto: conns[dupOf].proto, src: conns[dupOf].src, dst: conns[dupOf].dst, role: 'dup' });
  packets.push({ proto: conns[revOf].proto, src: conns[revOf].dst, dst: conns[revOf].src, role: 'rev' });
  const rows = rng.shuffle(packets);
  const q = textField('count', '接続の本数', 'number', '半角の数字', [String(nConn)]);
  q.text = `次の ${rows.length} 個のパケットは、何本の接続(5 タプル = プロトコル・送信元 IP:ポート・宛先 IP:ポートで区別)に属する？ 同じ接続の復路(送信元と宛先が入れ替わったもの)も同じ接続と数える。半角の数字で答える。`;
  q.table = { headers: ['#', 'プロトコル', '送信元', '宛先'], rows: rows.map((p, i) => [String(i + 1), p.proto, p.src, p.dst]) };
  const idx = (pred) => rows.findIndex(pred) + 1;
  const dupIdx = rows.map((p, i) => (p.role === 'dup' || (p.role === 'fwd' && p.src === conns[dupOf].src && p.dst === conns[dupOf].dst && p.proto === conns[dupOf].proto) ? i + 1 : 0)).filter(Boolean);
  const revIdx = idx((p) => p.role === 'rev');
  const revFwd = idx((p) => p.role === 'fwd' && p.src === conns[revOf].src && p.dst === conns[revOf].dst && p.proto === conns[revOf].proto);
  const udpIdx = idx((p) => p.proto === 'UDP' && p.role === 'fwd');
  const tcpIdx = idx((p) => p.proto === 'TCP' && p.src === `${A}:${pA}` && p.role === 'fwd');
  q.explanation = `#${dupIdx.join(' と #')} は 5 タプルがすべて同じなので同じ接続。#${revIdx} は #${revFwd} の復路(送信元と宛先が逆)なので同じ接続。#${udpIdx} は #${tcpIdx} と送信元 IP:ポートが同じでもプロトコルが UDP なので別の接続。同じ IP でもポートが違えば別の接続。合わせて ${nConn} 本。`;
  q.defenseNote = '5 タプルで接続を数えられると、ファイアウォールやNAPT の状態表に残るセッション数の正常な上限を見積もれる。';
  q.templateId = 'five-tuple-v1'; q.type = 'fivetuple'; q.meta = { nConn, packets: rows.map((p) => ({ proto: p.proto, src: p.src, dst: p.dst, role: p.role })) };
  return q;
}

// ---------- Lv58〜60 NAPT ----------
// 付け替え規則(ゲーム内の規則): ポート保持。使用中なら衝突した番号から 1 ずつ上げて最初の空き。TCP と UDP は別の名前空間
const NAPT_RULE = '変換はポート保持(内側ローカルのポート番号をそのまま内側グローバルのポートに使う)。その番号が同じプロトコルで使用中なら、番号を 1 ずつ上げて最初の空きを使う。';
function firstFree(used, port) { let p = port; while (used.has(p)) p++; return p; }
const usedPorts = (rows, proto) => new Set(rows.filter((r) => r.proto === proto).map((r) => r.gport));
const addrport = (ip, port) => `${ip}:${port}`;
// 既存行を作る。protos: 行ごとのプロトコル。remapped: 1 行をあらかじめ付け替え済み(ローカル p → グローバル p+1)にする
function naptRows(node, rng, protos, { remapped = false, consecutive = false } = {}) {
  const n = protos.length;
  const global = `203.0.113.${rng.rand(2, 250)}`;
  const hosts = insideHosts(node, rng, n + 4);
  let ports = distinctInts(rng, n, EPHEMERAL[0], 65000);
  if (consecutive) ports = [ports[0], ports[0] + 1, ...ports.slice(2).filter((p) => p !== ports[0] + 1)];
  while (ports.length < n) { const p = rng.rand(EPHEMERAL[0], 65000); if (!ports.includes(p)) ports.push(p); }
  const rows = ports.map((p, i) => ({ proto: protos[i], host: hosts[i], lport: p, gport: p, outside: `${outsideServer(rng)}:${rng.pick(SERVICE_PORTS)}` }));
  if (remapped) { const r = rows[rng.rand(0, n - 1)]; if (!ports.includes(r.gport + 1)) r.gport = r.lport + 1; } // 以前に付け替えられた行(ローカル p → グローバル p+1)
  return { global, rows, spare: hosts.slice(n) };
}
const naptTable = (rows, withProto = true) => ({
  headers: withProto ? ['プロトコル', '内側ローカル', '内側グローバル', '外側(宛先)'] : ['内側ローカル', '内側グローバル', '外側(宛先)'],
  rows: rows.map((r) => (withProto ? [r.proto] : []).concat([addrport(r.host, r.lport), addrport(r.globalIp, r.gport), r.outside])),
});
const naptMeta = (global, rows) => ({ global, rows: rows.map((r) => ({ proto: r.proto, host: r.host, lport: r.lport, gport: r.gport, outside: r.outside })) });
const flowJa = (f) => `${f.proto} ${addrport(f.host, f.port)} → ${f.outside}`;
const NAPT_DEFENSE = (host) => `NAPT 表の行は接続 1 本につき 1 行なので、短時間に行が急増したとき内側のどのホスト(例: ${host})が原因かを表から追える。`;

function naptAdd(node, rng, force = {}) {
  const n = rng.rand(3, 4);
  const remapped = rng.next() < 0.3;
  const { global, rows, spare } = naptRows(node, rng, Array(n).fill('TCP'), { remapped });
  rows.forEach((r) => { r.globalIp = global; });
  const used = usedPorts(rows, 'TCP');
  const remappedRow = rows.find((r) => r.lport !== r.gport);
  let port;
  if (remappedRow && rng.next() < 0.6) port = remappedRow.lport;            // 既存行のローカル側にだけ現れる番号(グローバル側では空き)
  else do { port = rng.rand(EPHEMERAL[0], 65000); } while (used.has(port) || rows.some((r) => r.lport === port));
  const flow = { proto: 'TCP', host: spare[0], port, outside: `${outsideServer(rng)}:${rng.pick(SERVICE_PORTS)}` };
  const g = firstFree(used, port); // 衝突しないので port のまま
  const q = textField('global', '内側グローバル(アドレス:ポート)', 'addrport', '例: 192.0.2.1:50000', [addrport(global, g)]);
  q.text = `NAPT の変換表が次のとおり(内側グローバルのアドレスは ${global})。内部の ${addrport(flow.host, flow.port)} から ${flow.outside} へ ${flow.proto} の新しい接続が始まった。この接続のために表に足す行の内側グローバル(アドレス:ポート)は？ ${NAPT_RULE}「アドレス:ポート」の形で答える。`;
  q.table = naptTable(rows);
  q.explanation = `空きを調べるのは内側グローバルの列(同じプロトコル)。${port} は内側グローバルの列で使われていないので、そのまま ${addrport(global, g)}。${port === (remappedRow && remappedRow.lport) ? `内側ローカルの列に ${port} があるが、それは別の行のローカル側の番号で、グローバル側では空き。` : ''}復路はこの ${g} で表を引いて ${addrport(flow.host, flow.port)} に戻される。`;
  q.defenseNote = NAPT_DEFENSE(flow.host);
  q.templateId = 'napt-add-v1'; q.type = 'naptadd'; q.meta = { ...naptMeta(global, rows), flow, assigned: g, trap: port === (remappedRow && remappedRow.lport) ? 'local-only' : null };
  return q;
}

function naptCollide(node, rng, force = {}) {
  const n = rng.rand(3, 4);
  const chain = force.chain !== undefined ? force.chain : rng.next() < 0.3;
  let global, rows, spare;
  if (force.rows) { ({ global, rows } = force); spare = force.spare; }
  else ({ global, rows, spare } = naptRows(node, rng, Array(n).fill('TCP'), { consecutive: chain, remapped: !chain && rng.next() < 0.3 }));
  rows.forEach((r) => { r.globalIp = global; });
  const used = usedPorts(rows, 'TCP');
  // 衝突する番号: 連鎖なら連続する 2 つの先頭、そうでなければ既存グローバルポートのどれか
  let port;
  if (force.port !== undefined) port = force.port;
  else if (chain) port = [...used].find((p) => used.has(p + 1));
  else port = rng.pick([...used]);
  const flow = force.flow || { proto: 'TCP', host: spare[0], port, outside: `${outsideServer(rng)}:${rng.pick(SERVICE_PORTS)}` };
  const g = firstFree(used, flow.port);
  const q = textField('global', '内側グローバル(アドレス:ポート)', 'addrport', '例: 192.0.2.1:50000', [addrport(global, g)]);
  q.text = `NAPT の変換表が次のとおり(内側グローバルのアドレスは ${global})。内部の ${addrport(flow.host, flow.port)} から ${flow.outside} へ ${flow.proto} の新しい接続が始まった。この接続の内側グローバル(アドレス:ポート)は？ ${NAPT_RULE}「アドレス:ポート」の形で答える。`;
  q.table = naptTable(rows);
  const steps = []; for (let p = flow.port; p < g; p++) { const r = rows.find((x) => x.proto === flow.proto && x.gport === p); steps.push(`${p} は ${r.host} が使用中`); }
  q.explanation = `${steps.join('、')}なので、1 ずつ上げて最初の空きの ${g} を使う。${addrport(global, g)}。復路はこの ${g} で表を引いて ${addrport(flow.host, flow.port)} に戻される。`;
  q.defenseNote = NAPT_DEFENSE(flow.host);
  q.templateId = 'napt-collide-v1'; q.type = 'naptcollide'; q.meta = { ...naptMeta(global, rows), flow, assigned: g, chain: g - flow.port };
  return q;
}

// 新規フローを順に適用する(本番の計算)。戻り値は各フローの割り当て
function applyFlows(rows, flows) {
  const used = { TCP: usedPorts(rows, 'TCP'), UDP: usedPorts(rows, 'UDP') };
  return flows.map((f) => { const g = firstFree(used[f.proto], f.port); used[f.proto].add(g); return g; });
}
function naptMulti(node, rng, force = {}) {
  const n = rng.rand(3, 4);
  const protos = Array.from({ length: n }, (_, i) => (i === 0 ? 'TCP' : i === 1 ? 'UDP' : rng.pick(['TCP', 'UDP'])));
  const { global, rows, spare } = naptRows(node, rng, rng.shuffle(protos));
  rows.forEach((r) => { r.globalIp = global; });
  const tcpRows = rows.filter((r) => r.proto === 'TCP'), udpRows = rows.filter((r) => r.proto === 'UDP');
  const variant = force.variant || rng.pick(['chain-last', 'udp-last', 'two']);
  const out = () => `${outsideServer(rng)}:${rng.pick(SERVICE_PORTS)}`;
  let flows;
  if (variant === 'two') {
    // f1: TCP。番号は既存 UDP 行のグローバルポートと同じ(別プロトコルなので衝突しない)。f2: TCP で f1 と同じ番号(前の新規行と衝突)
    const p = rng.pick(udpRows).gport;
    flows = [{ proto: 'TCP', host: spare[0], port: p, outside: out() }, { proto: 'TCP', host: spare[1], port: p, outside: out() }];
  } else if (variant === 'chain-last') {
    // f1: TCP が既存 TCP 行と衝突して付け替え。f2: UDP で f1 の付け替え後と同じ番号(衝突しない)。f3: TCP で f1 の付け替え後の番号(前の新規行と衝突)
    const p = rng.pick(tcpRows).gport;
    const g1 = firstFree(usedPorts(rows, 'TCP'), p);
    flows = [{ proto: 'TCP', host: spare[0], port: p, outside: out() }, { proto: 'UDP', host: spare[1], port: g1, outside: out() }, { proto: 'TCP', host: spare[2], port: g1, outside: out() }];
  } else {
    // f1: TCP(衝突あり/なし)。f2: TCP で f1 の付け替え後の番号(前の新規行と衝突)。f3: UDP で f2 の付け替え後の番号(別プロトコルなので衝突しない)
    const p = rng.next() < 0.5 ? rng.pick(tcpRows).gport : firstFree(usedPorts(rows, 'TCP'), rng.rand(EPHEMERAL[0], 65000));
    const g1 = firstFree(usedPorts(rows, 'TCP'), p);
    const g2 = firstFree(new Set([...usedPorts(rows, 'TCP'), g1]), g1);
    flows = [{ proto: 'TCP', host: spare[0], port: p, outside: out() }, { proto: 'TCP', host: spare[1], port: g1, outside: out() }, { proto: 'UDP', host: spare[2], port: g2, outside: out() }];
  }
  const assigned = applyFlows(rows, flows);
  const last = flows.length - 1;
  const q = textField('global', '最後の接続の内側グローバル(アドレス:ポート)', 'addrport', '例: 192.0.2.1:50000', [addrport(global, assigned[last])]);
  q.text = `NAPT の変換表が次のとおり(内側グローバルのアドレスは ${global})。続いて、2 つ目の表の ${flows.length} 本の新しい接続がこの順に始まった。最後(${flows.length} 本目)の接続の内側グローバル(アドレス:ポート)は？ ${NAPT_RULE}TCP と UDP のポートは別々に管理する(同じ番号でもプロトコルが違えば衝突しない)。前に足した行も使用中として数える。「アドレス:ポート」の形で答える。`;
  q.tables = [
    { title: '変換表', ...naptTable(rows) },
    { title: '新しい接続(この順に始まる)', headers: ['順', 'プロトコル', '内側ローカル', '外側(宛先)'], rows: flows.map((f, i) => [String(i + 1), f.proto, addrport(f.host, f.port), f.outside]) },
  ];
  const steps = flows.map((f, i) => `${i + 1} 本目(${f.proto} ${f.port})は、${f.proto} で ${assigned[i] === f.port ? `${f.port} が空きなのでそのまま` : `${assigned[i] - f.port === 1 ? f.port : `${f.port}〜${assigned[i] - 1}`} が使用中なので`} ${assigned[i]}`);
  q.explanation = `順に足す。${steps.join('。')}。別プロトコルで同じ番号が使われていても衝突ではない。最後の行は ${addrport(global, assigned[last])}。`;
  q.defenseNote = NAPT_DEFENSE(flows[last].host);
  q.templateId = 'napt-multi-v1'; q.type = 'naptmulti'; q.meta = { ...naptMeta(global, rows), flows, assigned, variant };
  return q;
}

// レベル → 生成器
const BY_LEVEL = {
  51: [tcpUdpFact],
  52: [portOfService],
  53: [serviceOfPort, portRange],
  54: [handshakeFact, ephemeralPick],
  55: [handshakeSeq],
  56: [dataAck],
  57: [fiveTuple],
  58: [naptAdd],
  59: [naptCollide],
  60: [naptMulti],
};

function make(level, node, rng) {
  const gens = BY_LEVEL[level];
  if (!gens) throw new Error(`Lv${level} の生成器は transport.js にありません(${RANGE[0]}〜${RANGE[1]})`);
  const q = rng.pick(gens)(node || DEFAULT_NODE, rng);
  q.level = level; q.seed = rng.seed; q.generatorVersion = VERSION;
  return q;
}

module.exports = {
  make, RANGE, VERSION, BY_LEVEL, FACTS,
  // 検証テスト用(行や値を固定して全数・例題を作る)
  internals: { tcpUdpFact, portOfService, serviceOfPort, portRange, handshakeFact, ephemeralPick, handshakeSeq, dataAck, fiveTuple, naptAdd, naptCollide, naptMulti, firstFree, DEFAULT_NODE, TCPUDP_KINDS, RANGE_LABELS },
};
