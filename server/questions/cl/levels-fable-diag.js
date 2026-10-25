'use strict';
// Fable の分: 診断と記録(docs/LEVEL-LIST.md 第 10 章 (b) の束 C・D と F3 の一部)。番号 230・285・296・323・342・343・349。
// 担当: Claude Fable 5.1(2026-10-25)。書き方は docs/questions/CL.md。表は server/questions/data/cl/fable-diag/、テストは test/cl-fable-diag.js。
// 上級・専門はヒントなし(解説だけ)。230 だけ中級なので firstStep(最初の 1 手)を付ける。
// 診断の問題は「そろった状態を作って 1 つだけ壊す」で作り、verify は表の文字を読み直して独立に模擬し、原因が 1 つに決まることを確かめる。
//
// ゲーム内の規則(問題文にも書く):
//   230 半分に分ける: 返事のあった所まではつながっていると考え、返事のあった所と無かった所の境目を調べる。どこにも返事が無ければ PC1 自身と最初の線
//   285 ACL と NAT: 受信の向きの ACL は NAT の前(変換する前のアドレス・ポートで照らす)。送信の向きの ACL は NAT の後(変換したあとで照らす)
//   296 表から原因: ルーターは 受信 IF の ACL → 経路表(いちばん長く一致する行)→ 出る IF で次の転送先の ARP の順に処理し、どこかで止まれば捨てる
//   323 VPN: IKE の版・暗号・ハッシュ・DH グループ・事前共有鍵は両端で同じ。相手のアドレスは互いに相手の外側のアドレス。守る範囲は鏡写し。IKE SA の寿命は違ってよい(短い方に合わせて動く)
//   342 再送: 同じ送信元から同じ宛先へ、同じ seq・同じ長さのデータ(長さ 1 以上)をもう一度送ったもの。長さ 0 の ACK(重複 ACK・keepalive)は再送ではない
//   349 ログ: JST = UTC + 9 時間。「時計が n 分進んでいる」= 表示が正しい時刻より n 分あと
const { loadFacts } = require('./build');

// ================= 共通の道具 =================
const F = (file) => loadFacts(`fable-diag/${file}`);
const numField = (name, label, value, hint) => ({ name, label, format: 'number', hint, accept: [String(value)] });
const textQ = (fields) => ({ answerKind: 'text', fields });
const bin32 = (s) => s.split('.').map((x) => Number(x).toString(2).padStart(8, '0')).join('');
const binIn = (ip, c) => { if (c === 'any') return true; const [a, l] = c.split('/'); return bin32(ip).slice(0, Number(l)) === bin32(a).slice(0, Number(l)); };
const hex2 = (rng) => rng.rand(0, 255).toString(16).padStart(2, '0');
const macOf = (rng) => `02:${[1, 2, 3, 4, 5].map(() => hex2(rng)).join(':')}`; // ローカル管理の MAC
const jn = (a, b) => (/^[A-Za-z0-9/]+$/.test(b) ? `${a} と ${b} の間` : `${a} と${b}の間`); // 「R1 と R2 の間」「R3 とサーバーの間」
const gen = (title, kindName, make, verify) => ({ title, kind: '生', minDistinct: 1000, make(rng) { return { ...make(rng), kind: kindName }; }, verify });
const fixedGen = (title, kindName, make, verify) => ({ title, kind: '生+固', minDistinct: 15, make(rng) { return { ...make(rng), kind: kindName }; }, verify });

// ================= Lv230 半分に分ける(中級。生+固) =================
// PC1 → R1 → (R2 → R3) → サーバーの道すじ。PC1 から各機器への ping の結果から、返事のあった所と無かった所の境目を答える
function bisectQ(rng) {
  const nR = rng.rand(2, 3);
  const X = rng.rand(1, 250);
  const lan = `192.168.${X}`;
  const chain = [{ name: 'R1', addr: `${lan}.1`, label: 'R1(PC1 のデフォルトゲートウェイ)' }];
  for (let i = 2; i <= nR; i++) chain.push({ name: `R${i}`, addr: `10.${X}.${i - 1}.2`, label: `R${i}` });
  chain.push({ name: 'サーバー', addr: `172.16.${rng.rand(0, 255)}.10`, label: 'サーバー' });
  const k = rng.rand(0, chain.length - 1); // 返事のあった機器の数(PC1 に近い方から数える。全部返事があるケースは出さない)
  const seg = (i) => (i === 0 ? 'PC1 と R1 の間(PC1 自身の設定と最初の線)' : `${jn(chain[i - 1].name, chain[i].name)}(${chain[i - 1].name} から先)`);
  const rows = rng.shuffle(chain.map((d, i) => [d.label, d.addr, i < k ? '返事あり' : '返事なし']));
  const options = chain.map((_, i) => seg(i));
  const okNames = chain.slice(0, k).map((d) => d.name), ngNames = chain.slice(k).map((d) => d.name);
  return {
    text: `PC1(${lan}.${rng.rand(2, 254)})からサーバーへ通信できない。道すじは PC1 → ${chain.map((d) => d.name).join(' → ')}。PC1 から道すじの各機器へ ping した結果は次の表のとおり(表の順番は混ぜてある)。「半分に分ける」考え方(返事のあった所まではつながっていると考え、返事のあった所と無かった所の境目を調べる。どこにも返事が無ければ、PC1 自身とその最初の線を調べる)で、次に調べるのはどこか。`,
    table: { headers: ['宛先', 'アドレス', '結果'], rows },
    options, answerIndex: k,
    firstStep: 'まず、返事のあった機器のうち PC1 からいちばん遠いものを見つける(PC1 に近い方から順に表を見る)',
    explanation: `正解は「${seg(k)}」。` + (k === 0
      ? `どの機器からも返事が無い(${ngNames.join('・')})。いちばん近い R1 にも届かないので、PC1 自身(アドレス・マスク・ゲートウェイの設定)と PC1 から R1 までの線から調べる。遠くの機器から調べるのは遠回り。`
      : `返事あり: ${okNames.join('・')}。返事なし: ${ngNames.join('・')}。${okNames[okNames.length - 1]} までは届いているので、そこまでの区間は調べなくてよい。届かなくなるのは ${jn(okNames[okNames.length - 1], ngNames[0])}なので、そこ(${okNames[okNames.length - 1]} の先の線と${/^[A-Za-z0-9/]+$/.test(ngNames[0]) ? ` ${ngNames[0]} ` : ngNames[0]}側の設定)を次に見る。`),
    meta: { k, n: chain.length },
  };
}
function verifyBisect(q) { // 問題文の道すじと表を読み直して、境目を数え直す
  const names = /道すじは PC1 → (.+?)。/.exec(q.text)[1].split(' → ');
  const res = names.map((nm) => { const r = q.table.rows.find((x) => x[0] === nm || x[0].startsWith(`${nm}(`)); if (!r) throw new Error(`Lv230: 表に ${nm} が無い`); return r[2] === '返事あり'; });
  let k = 0; while (k < res.length && res[k]) k++;
  for (let i = k; i < res.length; i++) if (res[i]) throw new Error('Lv230: 返事の無い機器の先に返事がある');
  if (k === res.length) throw new Error('Lv230: 全部に返事がある');
  const want = k === 0 ? 'PC1 と R1 の間' : jn(names[k - 1], names[k]);
  const hits = q.options.map((o) => o.startsWith(want));
  if (hits.filter(Boolean).length !== 1 || !hits[q.answerIndex]) throw new Error(`Lv230: 答えが違う ${want}`);
  if (!q.firstStep) throw new Error('Lv230: firstStep が無い');
}

// ================= Lv285 ACL と NAT の前後(上級。生) =================
function aclNatQ(rng) {
  const X = rng.rand(1, 250); const lan = `192.168.${X}`;
  const A = rng.rand(2, 100); const B = A + rng.rand(1, 50); const B2 = rng.next() < 0.5 ? B : B + rng.rand(1, 50);
  const web = `${lan}.${rng.pick([10, 20, 30])}`, ssh = `${lan}.${rng.pick([11, 21, 31])}`;
  const webExt = rng.pick([443, 8443, 10443]), sshExt = rng.pick([22, 2222, 10022]);
  const pc = `${lan}.${rng.rand(100, 250)}`;
  const ext = `198.51.100.${rng.rand(2, 250)}`;
  const napt = `203.0.113.${A}`;
  const table = {
    headers: ['種類', '外側(グローバル)', '内側(プライベート)'],
    rows: [
      ['NAPT(内 → 外。送信元を変換)', `${napt}(ポートは付け替え)`, `${lan}.0/24(どのポートでも)`],
      ['ポートフォワード(外 → 内。宛先を変換)', `TCP 203.0.113.${B}:${webExt}`, `TCP ${web}:443`],
      ['ポートフォワード(外 → 内。宛先を変換)', `TCP 203.0.113.${B2}:${sshExt}`, `TCP ${ssh}:22`],
    ],
  };
  const svc = rng.pick([
    { name: 'HTTPS', ext: `203.0.113.${B}:${webExt}`, in: `${web}:443`, host: web, label: 'Web サーバー' },
    { name: 'SSH', ext: `203.0.113.${B2}:${sshExt}`, in: `${ssh}:22`, host: ssh, label: '管理用サーバー' },
  ]);
  const variant = rng.pick(['outIn-recv', 'outIn-send', 'inOut-send', 'inOut-recv']);
  const rule = 'R1 の Gi0/0 は内側(LAN)、Gi0/1 は外側(インターネット)。R1 では、受信の向きの ACL は NAT の前に当てる(変換する前のアドレスとポートで照らす)。送信の向きの ACL は NAT の後に当てる(変換したあとのアドレスとポートで照らす)。NAT の設定は次の表のとおり。';
  const ap = (name, label, value) => textQ([{ name, label, format: 'addrport', hint: '例: 203.0.113.1:443', accept: [value] }]);
  const ip = (name, label, value) => textQ([{ name, label, format: 'ipv4', hint: '例: 203.0.113.1', accept: [value] }]);
  const common = `\nこのルーターでは、外側 IF で受信した外 → 内のパケットは、受信の ACL のあとにポートフォワードで宛先が ${svc.ext} から ${svc.in} に書き換わり、内側 IF から出る(送信の ACL は書き換え後を見る)。内 → 外のパケットは、内側 IF の受信の ACL のあとに NAPT で送信元が ${napt} に書き換わり、外側 IF から出る。`;
  if (variant === 'outIn-recv') return { text: `${rule}外から ${svc.label}(内 ${svc.host})への ${svc.name} を通したい。外側 IF Gi0/1 の受信の ACL に書く宛先(アドレス:ポート)は?`, table, ...ap('dst', '宛先(アドレス:ポート)', svc.ext), explanation: `正解は ${svc.ext}。外側 IF の受信の ACL は NAT の前なので、外から来たままの宛先(グローバルのアドレスとポート)で照らす。${svc.in} と書くと、変換前のパケットには合わず通らない。${common}`, meta: { variant, svc: svc.name } };
  if (variant === 'outIn-send') return { text: `${rule}外から ${svc.label}(内 ${svc.host})への ${svc.name} を通したい。この通信が内側 IF Gi0/0 から LAN へ出るときの、Gi0/0 の送信の ACL に書く宛先(アドレス:ポート)は?`, table, ...ap('dst', '宛先(アドレス:ポート)', svc.in), explanation: `正解は ${svc.in}。内側 IF の送信の ACL は NAT の後なので、ポートフォワードで書き換わったあとの宛先(内側のアドレスとポート)で照らす。${svc.ext} と書くと、書き換え後のパケットには合わない。${common}`, meta: { variant, svc: svc.name } };
  if (variant === 'inOut-send') return { text: `${rule}内の PC1(${pc})から外のサーバー ${ext} への HTTPS(宛先ポート 443)を通したい。外側 IF Gi0/1 の送信の ACL に書く送信元アドレスは?`, table, ...ip('src', '送信元アドレス', napt), explanation: `正解は ${napt}。外側 IF の送信の ACL は NAT の後なので、NAPT で書き換わったあとの送信元(グローバルのアドレス)で照らす。${pc} と書くと、書き換え後のパケットには合わない。${common}`, meta: { variant, svc: svc.name } };
  return { text: `${rule}内の PC1(${pc})から外のサーバー ${ext} への HTTPS(宛先ポート 443)を通したい。内側 IF Gi0/0 の受信の ACL に書く送信元アドレスは?`, table, ...ip('src', '送信元アドレス', pc), explanation: `正解は ${pc}。内側 IF の受信の ACL は NAT の前なので、PC1 が送ったままの送信元(プライベートのアドレス)で照らす。${napt} と書くと、変換前のパケットには合わない。${common}`, meta: { variant, svc: svc.name } };
}
function verifyAclNat(q) { // 問題文の IF・向き・項目と NAT の表から、規則どおりに答えを出し直す
  const t = q.text;
  const ifm = /(Gi0\/[01]) の(受信|送信)の ACL に書く(宛先|送信元)/.exec(t);
  if (!ifm) throw new Error('Lv285: 問題文に IF と向きが無い');
  const [, iface, dir, field] = ifm; const pre = dir === '受信';
  let want;
  if (/^.*外から /.test(t)) { // 外 → 内: Gi0/1 で受け、Gi0/0 から出る
    const svcName = /への (HTTPS|SSH) を/.exec(t)[1]; const port = svcName === 'HTTPS' ? ':443' : ':22';
    const row = q.table.rows.find((r) => r[0].startsWith('ポートフォワード') && r[2].endsWith(port));
    const strip = (s) => s.replace(/^TCP /, '');
    want = pre ? strip(row[1]) : strip(row[2]);
    if (field !== '宛先' || iface !== (pre ? 'Gi0/1' : 'Gi0/0')) throw new Error('Lv285: 外 → 内の IF・項目が合わない');
    if (q.fields[0].format !== 'addrport') throw new Error('Lv285: 形式が addrport でない');
  } else { // 内 → 外: Gi0/0 で受け、Gi0/1 から出る
    const pc = /内の PC1\(([\d.]+)\)/.exec(t)[1];
    const row = q.table.rows.find((r) => r[0].startsWith('NAPT'));
    want = pre ? pc : /^([\d.]+)/.exec(row[1])[1];
    if (field !== '送信元' || iface !== (pre ? 'Gi0/0' : 'Gi0/1')) throw new Error('Lv285: 内 → 外の IF・項目が合わない');
    if (q.fields[0].format !== 'ipv4') throw new Error('Lv285: 形式が ipv4 でない');
  }
  if (q.fields[0].accept[0] !== want) throw new Error(`Lv285: 答えが違う ${q.fields[0].accept[0]} / ${want}`);
}

// ================= Lv296 表から原因(規則)(上級。生) =================
// R1: Gi0/0 = LAN(PC1)、Gi0/1 = R2 への線(サーバーの網は R2 の先)、Gi0/2 = R3 への線(別の網は R3 の先)。
// 壊すのは 1 つ: 経路の行の次の転送先が違う(route-wrong)/ 宛先の行が無くデフォルトで R3 へ行く(route-default)/ 合う行が無い(route-none)/ 次の転送先の ARP が未解決(arp)/ ACL の deny(acl)
const CAUSES_296 = ['route-wrong', 'route-default', 'route-none', 'arp', 'acl'];
function causeQ(rng) {
  const X = rng.rand(1, 250);
  const lan = `192.168.${X}`; const h = rng.rand(2, 254); const pc = `${lan}.${h}`;
  let h2; do { h2 = rng.rand(2, 254); } while (h2 === h); const otherPc = `${lan}.${h2}`;
  const l12 = `10.${X}.12`, l13 = `10.${X}.13`;
  const r2 = `${l12}.2`, r3 = `${l13}.2`;
  const S = rng.rand(0, 255); let T; do { T = rng.rand(0, 255); } while (T === S);
  const srvNet = `172.16.${S}.0/24`, othNet = `172.16.${T}.0/24`, srv = `172.16.${S}.10`;
  const port = rng.pick([443, 80, 22]); const sport = 49152 + rng.rand(0, 16000);
  const cause = rng.pick(CAUSES_296);
  // 経路表
  const routes = [[`${lan}.0/24`, '直結', 'Gi0/0'], [`${l12}.0/30`, '直結', 'Gi0/1'], [`${l13}.0/30`, '直結', 'Gi0/2']];
  if (cause === 'route-wrong') routes.push([srvNet, r3, 'Gi0/2']);
  else if (cause !== 'route-default' && cause !== 'route-none') routes.push([srvNet, r2, 'Gi0/1']);
  routes.push([othNet, r3, 'Gi0/2']);
  const hasDefault = cause === 'route-default' || (cause !== 'route-none' && rng.next() < 0.5);
  if (hasDefault) routes.push(['0.0.0.0/0', r3, 'Gi0/2']);
  const routeRows = rng.shuffle(routes).map((r, i) => [String(i + 1), ...r]);
  // ARP 表
  const arp = [[pc, macOf(rng), 'Gi0/0', '解決済み'], [r2, cause === 'arp' ? '—' : macOf(rng), 'Gi0/1', cause === 'arp' ? '未解決' : '解決済み'], [r3, macOf(rng), 'Gi0/2', '解決済み']];
  const otherUnresolved = rng.next() < 0.6;
  if (otherUnresolved) arp.push([otherPc, '—', 'Gi0/0', '未解決']); // 無関係の未解決(誤答の候補)
  const arpRows = rng.shuffle(arp).map((r, i) => [String(i + 1), ...r]);
  // ACL(Gi0/0 の受信)。合わない deny を 1 行、パケットに合う行(permit か、acl のときは deny)を 1 行、最後に permit ip any
  const otherPort = rng.pick([443, 80, 22].filter((p) => p !== port));
  const decoy = rng.pick([
    ['deny', 'tcp', `${lan}.0/24`, othNet, 'すべて'],
    ['deny', 'tcp', `${lan}.0/24`, `${srv}/32`, String(otherPort)],
    ['deny', 'tcp', `${otherPc}/32`, srvNet, 'すべて'],
    ['deny', 'udp', 'any', 'any', 'すべて'],
  ]);
  const act = cause === 'acl' ? 'deny' : 'permit';
  const match = rng.pick([
    [act, 'tcp', `${pc}/32`, `${srv}/32`, String(port)],
    [act, 'tcp', `${lan}.0/24`, srvNet, String(port)],
    [act, 'ip', `${lan}.0/24`, srvNet, '—'],
    [act, 'tcp', `${lan}.0/24`, `${srv}/32`, 'すべて'],
  ]);
  const decoyFirst = rng.next() < 0.5;
  const aclRows = (decoyFirst ? [decoy, match] : [match, decoy]).concat([['permit', 'ip', `${lan}.0/24`, 'any', '—']]).map((r, i) => [String((i + 1) * 10), ...r]);
  // 選択肢: 正解の行 + 紛らわしい行
  const rl = (r) => `経路表の ${r[0]} 行目`, al = (r) => `ARP 表の ${r[0]} 行目`, cl = (r) => `ACL の ${r[0]} 行`;
  const NONE = '経路表: 宛先に合う行が無い';
  const srvRow = routeRows.find((r) => r[1] === srvNet), defRow = routeRows.find((r) => r[1] === '0.0.0.0/0'), othRow = routeRows.find((r) => r[1] === othNet);
  const arpR2 = arpRows.find((r) => r[1] === r2), arpOther = arpRows.find((r) => r[1] === otherPc), arpR3 = arpRows.find((r) => r[1] === r3);
  const aclDecoy = aclRows.find((r) => r.slice(1).join() === decoy.join());
  const aclMatch = aclRows.find((r) => r.slice(1).join() === match.join());
  const answer = cause === 'acl' ? cl(aclMatch) : cause === 'route-none' ? NONE : cause === 'route-wrong' ? rl(srvRow) : cause === 'route-default' ? rl(defRow) : al(arpR2);
  const suspicious = [aclDecoy && cl(aclDecoy), arpOther && al(arpOther), srvRow && rl(srvRow), defRow && rl(defRow), NONE].filter((x) => x && x !== answer);
  const rest = [othRow && rl(othRow), arpR2 && al(arpR2), arpR3 && al(arpR3), aclMatch && cl(aclMatch), ...aclRows.filter((r) => r[1] === 'permit' && r !== aclMatch).map(cl)].filter((x) => x && x !== answer);
  const wrongs = [...new Set(rng.shuffle(suspicious).slice(0, 3).concat(rng.shuffle(rest)))].slice(0, 3);
  const options = rng.shuffle([answer, ...wrongs]);
  const why = { // 原因ごとの解説(無い行を参照しないよう、選んだ原因の分だけ作る)
    'route-wrong': () => `宛先 ${srv} に合う行は ${srvRow[0]} 行目(${srvNet})だが、次の転送先が R3(${r3})になっている。サーバーの網は R2 の先なので、R3 へ送っても届かない。ACL は通り、R3 の ARP も解決済みなので、止めているのはこの行。`,
    'route-default': () => `宛先 ${srv} に合う行は ${defRow[0]} 行目(0.0.0.0/0)しかなく、R3(${r3})へ送ってしまう。サーバーの網 ${srvNet} の行が無いので、デフォルトの行が原因。ACL は通り、ARP も解決済み。`,
    'route-none': () => `経路表に ${srv} に合う行が無い(${srvNet} の行も 0.0.0.0/0 も無い)。ACL は通るが、経路が無いので R1 はここで捨てる。`,
    arp: () => `経路は ${srvNet} → R2(${r2})で正しく、ACL も通る。しかし R2 の ARP が未解決なので、Gi0/1 から送るときの宛先 MAC が分からず送れない。${otherUnresolved ? `${otherPc} の未解決は、このパケットには関係ない。` : ''}`,
    acl: () => `Gi0/0 の受信の ACL は上から照らし、${aclMatch[0]} 行(${act} ${match[1]} ${match[2]} → ${match[3]}${match[1] === 'ip' ? '' : ` ポート ${match[4]}`})にこのパケットが合い、deny で捨てられる。経路表も ARP も正しいが、ACL で止まるので先へ進まない。`,
  }[cause]();
  return {
    text: `R1 の設定と表は次のとおり。R1 は、受信 IF の ACL → 経路表(宛先にいちばん長く一致する行)→ 出る IF で次の転送先の ARP、の順に処理し、どこかで止まればパケットを捨てる。つながり: Gi0/0 は LAN ${lan}.0/24(PC1 ${pc})。Gi0/1 は R2(${r2})への線で、サーバー(${srv})の網 ${srvNet} は R2 の先にある。Gi0/2 は R3(${r3})への線で、${othNet} は R3 の先にある。次のパケットがサーバーに届かない。原因になっている 1 行はどれか。\nパケット: TCP ${pc}:${sport} → ${srv}:${port}`,
    tables: [
      { title: '経路表', headers: ['行', '宛先', '次の転送先', '出る IF'], rows: routeRows },
      { title: 'ARP 表', headers: ['行', 'アドレス', 'MAC', 'IF', '状態'], rows: arpRows },
      { title: 'ACL(Gi0/0 の受信)', headers: ['行', '動作', '手順', '送信元', '宛先', '宛先ポート'], rows: aclRows },
    ],
    options, answerIndex: options.indexOf(answer),
    explanation: `正解は「${answer}」。${why}\n見る順: ACL(${aclRows.map((r) => `${r[0]} 行 ${r[1]}`).join('、')})→ 経路表 → ARP。先の段で止まれば、あとの段は見ない。`,
    meta: { cause, hasDefault, otherUnresolved, decoyFirst },
  };
}
function verifyCause(q) { // 表の文字を 2 進で読み直し、ACL → 経路 → ARP を独立に模擬する。原因は 1 つだけ
  const [rt, at, acl] = q.tables;
  const m = /パケット: TCP ([\d.]+):\d+ → ([\d.]+):(\d+)/.exec(q.text);
  const src = m[1], dst = m[2], port = m[3];
  const nh = /Gi0\/1 は R2\(([\d.]+)\)への線で、サーバー\(([\d.]+)\)の網 [\d./]+ は R2 の先/.exec(q.text);
  if (!nh || nh[2] !== dst) throw new Error('Lv296: 問題文のつながりが読めない');
  const correctNh = nh[1];
  let aclHit = null;
  for (const r of acl.rows) { const [, , proto, s, d, p] = r; if ((proto === 'ip' || proto === 'tcp') && binIn(src, s) && binIn(dst, d) && (proto === 'ip' || p === 'すべて' || p === port)) { aclHit = r; break; } }
  if (!aclHit) throw new Error('Lv296: 暗黙の拒否になっている');
  const aclBlock = aclHit[1] === 'deny';
  let best = null, bl = -1;
  for (const r of rt.rows) { const l = Number(r[1].split('/')[1]); if (binIn(dst, r[1]) && l > bl) { best = r; bl = l; } }
  const routeNone = !best; const routeWrong = !!best && best[2] !== correctNh;
  const arpOf = (ip) => at.rows.find((r) => r[1] === ip);
  const arpOk = (ip) => { const r = arpOf(ip); return !!r && r[4] === '解決済み' && r[2] !== '—'; };
  const arpBlock = !arpOk(correctNh);
  const fails = [aclBlock && 'acl', routeNone && 'none', routeWrong && 'wrong', arpBlock && 'arp'].filter(Boolean);
  if (fails.length !== 1) throw new Error(`Lv296: 原因が 1 つでない(${fails.join(',')})`);
  if (routeWrong && !arpOk(best[2])) throw new Error('Lv296: 違う経路の先の ARP も未解決(原因が 2 つ)');
  const want = aclBlock ? `ACL の ${aclHit[0]} 行` : routeNone ? '経路表: 宛先に合う行が無い' : routeWrong ? `経路表の ${best[0]} 行目` : `ARP 表の ${arpOf(correctNh)[0]} 行目`;
  if (q.options[q.answerIndex] !== want || q.options.filter((o) => o === want).length !== 1) throw new Error(`Lv296: 答えが違う ${q.options[q.answerIndex]} / ${want}`);
}

// ================= Lv323 VPN が上がらない(専門。生+固) =================
const VPN_ITEMS = ['IKE の版', '暗号', 'ハッシュ', 'DH グループ', '事前共有鍵', '相手のアドレス', '守る範囲(自分の側 → 相手の側)', 'IKE SA の寿命(秒)'];
const VPN_BROKEN = { ver: 'IKE の版', enc: '暗号', hash: 'ハッシュ', dh: 'DH グループ', psk: '事前共有鍵', peer: '相手のアドレス', ts: '守る範囲(自分の側 → 相手の側)' };
function vpnQ(rng) {
  const a = `203.0.113.${rng.rand(2, 200)}`, b = `198.51.100.${rng.rand(2, 200)}`;
  const hq = `192.168.${rng.rand(1, 100)}.0/24`, br = `192.168.${rng.rand(101, 250)}.0/24`;
  const other = (v, arr) => rng.pick(arr.filter((x) => x !== v));
  const VERS = ['IKEv1', 'IKEv2'], ENCS = ['AES-128', 'AES-256', 'AES-GCM-256'], HASHES = ['SHA-256', 'SHA-384'], DHS = ['グループ 14', 'グループ 19', 'グループ 20'], LIVES = [3600, 28800, 86400];
  const ver = rng.pick(VERS), enc = rng.pick(ENCS), hash = rng.pick(HASHES), dh = rng.pick(DHS);
  const digits = String(rng.rand(1000, 9999)); const word = rng.pick(['kita', 'minami', 'higashi', 'nishi']);
  const psk = `pcq-${digits}-${word}`;
  const life1 = rng.pick(LIVES); const lifeDiff = rng.next() < 0.6; const life2 = lifeDiff ? other(life1, LIVES) : life1;
  const R1 = { ver, enc, hash, dh, psk, self: a, peer: b, ts: `${hq} → ${br}`, life: life1 };
  const R2 = { ver, enc, hash, dh, psk, self: b, peer: a, ts: `${br} → ${hq}`, life: life2 };
  const broken = rng.pick(Object.keys(VPN_BROKEN));
  const side = rng.next() < 0.6 ? R2 : R1; const sideName = side === R2 ? 'R2' : 'R1';
  const peerOf = side === R2 ? R1 : R2;
  if (broken === 'ver') side.ver = other(ver, VERS);
  if (broken === 'enc') side.enc = other(enc, ENCS);
  if (broken === 'hash') side.hash = other(hash, HASHES);
  if (broken === 'dh') side.dh = other(dh, DHS);
  if (broken === 'psk') side.psk = rng.next() < 0.5 ? `pcq-${digits[0]}${digits[2]}${digits[1]}${digits[3]}-${word}` : `pcq-${digits}-${other(word, ['kita', 'minami', 'higashi', 'nishi'])}`;
  if (broken === 'psk' && side.psk === psk) side.psk = `pcq-${digits}-${other(word, ['kita', 'minami', 'higashi', 'nishi'])}`;
  if (broken === 'peer') { const o = peerOf.self.split('.'); side.peer = rng.next() < 0.5 ? `${o[0]}.${o[1]}.${o[2]}.${Number(o[3]) + 1}` : `${peerOf.ts.split(' → ')[0].replace(/\.0\/24$/, '.1')}`; }
  if (broken === 'ts') side.ts = rng.next() < 0.5 ? peerOf.ts : `${side.ts.split(' → ')[0]} → 192.168.${rng.rand(1, 250)}.0/24`;
  if (broken === 'ts' && (side.ts === `${side.ts.split(' → ')[0]} → ${peerOf.ts.split(' → ')[0]}`)) side.ts = peerOf.ts; // たまたま正しい形になったら、鏡写しでない形にする
  const rows = [
    ['自分の外側のアドレス', R1.self, R2.self], ['相手のアドレス', R1.peer, R2.peer], ['IKE の版', R1.ver, R2.ver], ['暗号', R1.enc, R2.enc], ['ハッシュ', R1.hash, R2.hash],
    ['DH グループ', R1.dh, R2.dh], ['事前共有鍵', R1.psk, R2.psk], ['守る範囲(自分の側 → 相手の側)', R1.ts, R2.ts], ['IKE SA の寿命(秒)', String(R1.life), String(R2.life)],
  ];
  const answer = VPN_BROKEN[broken];
  const pool = VPN_ITEMS.filter((x) => x !== answer);
  const wrongs = lifeDiff ? ['IKE SA の寿命(秒)', ...rng.shuffle(pool.filter((x) => x !== 'IKE SA の寿命(秒)')).slice(0, 2)] : rng.shuffle(pool.filter((x) => x !== 'IKE SA の寿命(秒)')).slice(0, 3);
  const options = rng.shuffle([answer, ...wrongs]);
  const why = {
    ver: `${sideName} の IKE の版が相手と違う(${R1.ver} と ${R2.ver})。版が違うと、やりとりそのものが始まらない。`,
    enc: `暗号が ${R1.enc} と ${R2.enc} で違う。IKE の提案が合わず、SA ができない。`,
    hash: `ハッシュ(認証の方式)が ${R1.hash} と ${R2.hash} で違う。提案が合わない。`,
    dh: `DH グループが ${R1.dh} と ${R2.dh} で違う。鍵の交換の条件が合わない。`,
    psk: `事前共有鍵が「${R1.psk}」と「${R2.psk}」で違う(よく見ると 1 か所違う)。鍵が違うと認証で失敗する。`,
    peer: `${sideName} の相手のアドレス ${side.peer} が、相手の外側のアドレス ${peerOf.self} を指していない。相手に届かないか、相手が知らないアドレスからの要求として捨てられる。`,
    ts: `守る範囲が鏡写しになっていない。R1 は「${R1.ts}」、R2 は「${R2.ts}」。R2 は R1 の自分の側と相手の側を入れ替えた形でなければならない。`,
  }[broken];
  return {
    text: `本社 R1(外側 ${a})と支社 R2(外側 ${b})の間の拠点間 VPN(IPsec)が上がらない。両端の設定は次の表のとおり。決まり: IKE の版・暗号・ハッシュ・DH グループ・事前共有鍵は両端で同じにする。相手のアドレスは、互いに相手の外側のアドレスを指す。守る範囲は鏡写し(R1 の「自分の側 → 相手の側」と R2 のそれが入れ替わった形)。IKE SA の寿命は違っていてよい(短い方に合わせて動く)。合っていない項目はどれか。`,
    table: { headers: ['項目', '本社 R1', '支社 R2'], rows },
    options, answerIndex: options.indexOf(answer),
    explanation: `正解は「${answer}」。${why}` + (lifeDiff ? ` IKE SA の寿命は ${R1.life} と ${R2.life} で違うが、短い方に合わせて動くので原因ではない。` : '') + '自分の外側のアドレスは両端で違っていて当然。ほかの項目はそろっている。',
    meta: { broken, lifeDiff, side: sideName },
  };
}
function verifyVpn(q) { // 表を読み直して規則を当て、合わない項目が 1 つだけであることを確かめる
  const v = Object.fromEntries(q.table.rows.map((r) => [r[0], [r[1], r[2]]]));
  const same = (k) => v[k][0] === v[k][1];
  const fails = [];
  for (const k of ['IKE の版', '暗号', 'ハッシュ', 'DH グループ', '事前共有鍵']) if (!same(k)) fails.push(k);
  if (!(v['相手のアドレス'][0] === v['自分の外側のアドレス'][1] && v['相手のアドレス'][1] === v['自分の外側のアドレス'][0])) fails.push('相手のアドレス');
  const [a1, b1] = v['守る範囲(自分の側 → 相手の側)'][0].split(' → '), [a2, b2] = v['守る範囲(自分の側 → 相手の側)'][1].split(' → ');
  if (!(a1 === b2 && b1 === a2)) fails.push('守る範囲(自分の側 → 相手の側)');
  if (fails.length !== 1) throw new Error(`Lv323: 合わない項目が 1 つでない(${fails.join(',')})`);
  if (q.options[q.answerIndex] !== fails[0] || q.options.filter((o) => o === fails[0]).length !== 1) throw new Error(`Lv323: 答えが違う ${fails[0]}`);
  if (q.options[q.answerIndex] === 'IKE SA の寿命(秒)') throw new Error('Lv323: 寿命が正解になっている');
}

// ================= Lv342 記録から再送(専門。生) =================
function retransQ(rng) {
  const X = rng.rand(1, 250); const C = `192.168.${X}.${rng.rand(2, 254)}`, S = `203.0.113.${rng.rand(2, 250)}`;
  const cp = rng.rand(49152, 65535), sp = rng.pick([443, 80, 8443]);
  const c = `${C}:${cp}`, s = `${S}:${sp}`;
  const shape = rng.pick(['timeout', 'timeout', 'fast']);
  const keep = rng.next() < 0.4; const reorder = shape === 'timeout' && rng.next() < 0.5;
  const rows = []; let t = 0;
  const push = (dt, src, dst, flags, seq, ack, len) => { t = Math.round((t + dt) * 1000) / 1000; rows.push([src, dst, flags, seq, ack, len, t]); };
  const L1 = rng.rand(80, 600);
  let ans, nextC, nextS, explain;
  if (shape === 'timeout') {
    const rto = rng.pick([0.2, 0.3, 0.5, 1.0]);
    push(0, c, s, 'PSH,ACK', 1, 1, L1);
    push(rto, c, s, 'PSH,ACK', 1, 1, L1); ans = rows.length;
    push(0.012, s, c, 'ACK', 1, 1 + L1, 0);
    const M1 = rng.rand(200, 1460), M2 = rng.rand(200, 1460);
    if (reorder) {
      push(0.02, s, c, 'ACK', 1 + M1, 1 + L1, M2); // 2 つ目が先に着いた(順番の入れ替わり)
      push(0.001, c, s, 'ACK', 1 + L1, 1, 0);      // 重複 ACK(まだ seq 1 を待っている)
      push(0.003, s, c, 'PSH,ACK', 1, 1 + L1, M1);
      push(0.001, c, s, 'ACK', 1 + L1, 1 + M1 + M2, 0);
    } else {
      push(0.02, s, c, 'ACK', 1, 1 + L1, M1);
      push(0.001, s, c, 'PSH,ACK', 1 + M1, 1 + L1, M2);
      push(0.001, c, s, 'ACK', 1 + L1, 1 + M1 + M2, 0);
    }
    nextC = 1 + L1; nextS = 1 + M1 + M2;
    explain = `1 行目の要求(seq 1、長さ ${L1})に ${rto} 秒たっても ACK が来ないので、PC1 が同じ seq・同じ長さで送り直したのが ${ans} 行目(再送タイマーによる再送)。`
      + (reorder ? `サーバーの 2 つのデータは、seq ${1 + M1} の方が先に記録されているが、seq が違うので再送ではない(順番が入れ替わって届いただけ)。そのとき PC1 が返した ack 1 の ACK は重複 ACK で、長さ 0 なので再送に数えない。` : '');
  } else {
    const M = [1, 2, 3, 4, 5].map(() => rng.rand(200, 1460));
    push(0, c, s, 'PSH,ACK', 1, 1, L1);
    push(0.012, s, c, 'ACK', 1, 1 + L1, 0);
    let seq = 1; const seqs = [];
    for (let i = 0; i < 5; i++) { seqs.push(seq); push(i === 0 ? 0.005 : 0.001, s, c, i === 4 ? 'PSH,ACK' : 'ACK', seq, 1 + L1, M[i]); seq += M[i]; }
    // 2 つ目(seq seqs[1])が途中で落ちた。PC1 は 1 つ目の ACK のあと、3〜5 つ目を受けるたびに同じ ack の ACK(重複 ACK)を返す
    push(0.004, c, s, 'ACK', 1 + L1, seqs[1], 0);
    push(0.001, c, s, 'ACK', 1 + L1, seqs[1], 0);
    push(0.001, c, s, 'ACK', 1 + L1, seqs[1], 0);
    push(0.001, c, s, 'ACK', 1 + L1, seqs[1], 0);
    push(0.003, s, c, 'ACK', seqs[1], 1 + L1, M[1]); ans = rows.length; // 3 つの重複 ACK を受けて再送
    push(0.004, c, s, 'ACK', 1 + L1, seq, 0);
    nextC = 1 + L1; nextS = seq;
    explain = `サーバーの seq ${seqs[1]}(長さ ${M[1]})は ${rows.findIndex((r) => r[3] === seqs[1] && r[5] === M[1]) + 1} 行目で一度送られているが、PC1 には届かなかった。PC1 は次のデータを受けるたびに ack ${seqs[1]} の ACK を返し(重複 ACK)、3 つ目の重複 ACK を受けたサーバーが同じ seq・同じ長さで送り直したのが ${ans} 行目。重複 ACK は長さ 0 なので再送ではない。`;
  }
  if (keep) {
    push(rng.pick([10, 30, 60]), c, s, 'ACK', nextC - 1, nextS, 0);
    push(0.011, s, c, 'ACK', nextS, nextC, 0);
    explain += `最後の 2 行は keepalive(seq が次に送る番号より 1 小さい、長さ 0 の ACK と、その返事)で、データではないので再送ではない。`;
  }
  return {
    text: `PC1(${C})とサーバー(${S})の TCP 通信の記録(サーバーの近くで取った)。3 ウェイハンドシェイクの直後からで、seq・ack は相対値。再送とは、同じ送信元から同じ宛先へ、同じ seq・同じ長さのデータ(長さ 1 以上)をもう一度送ったもの。長さ 0 の ACK(重複 ACK や keepalive)は再送に数えない。再送した行(2 回目の方)の番号はいくつか。`,
    table: { headers: ['番号', '時刻(秒)', '送信元', '宛先', 'フラグ', 'seq', 'ack', '長さ'], rows: rows.map((r, i) => [String(i + 1), r[6].toFixed(3), r[0], r[1], r[2], String(r[3]), String(r[4]), String(r[5])]) },
    ...textQ([numField('row', '行の番号', ans, '例: 5')]),
    explanation: `正解は ${ans} 行目。${explain}`,
    meta: { shape, keep, reorder },
  };
}
function verifyRetrans(q) { // 表を読み直し、同じ送信元・宛先・seq・長さ(1 以上)の 2 回目を数える
  const rows = q.table.rows.map((r) => ({ n: Number(r[0]), src: r[2], dst: r[3], seq: r[5], len: Number(r[7]) }));
  const re = rows.filter((r, i) => r.len > 0 && rows.slice(0, i).some((p) => p.src === r.src && p.dst === r.dst && p.seq === r.seq && p.len === r.len));
  if (re.length !== 1) throw new Error(`Lv342: 再送が ${re.length} 行`);
  if (q.fields[0].accept[0] !== String(re[0].n)) throw new Error(`Lv342: 行が違う ${q.fields[0].accept[0]} / ${re[0].n}`);
  for (let i = 1; i < q.table.rows.length; i++) if (Number(q.table.rows[i][1]) <= Number(q.table.rows[i - 1][1])) throw new Error('Lv342: 時刻が増えていない');
}

// ================= Lv343 接続の失敗(専門。表) =================
const TCPF = F('tcp-fail.json');
const OBS = TCPF.filter((r) => r.attrs.group === 'obs');
const STMT = TCPF.filter((r) => typeof r.attrs.true === 'boolean');
const subCap = (rows, v) => rows.map((r) => r.map((x) => x.replace(/\{C\}/g, v.C).replace(/\{S\}/g, v.S).replace(/\{P\}/g, String(v.P)).replace(/\{R\}/g, v.R)));
function obsQ(rng) {
  const ans = rng.pick(OBS);
  const v = { C: `192.168.${rng.rand(1, 250)}.${rng.rand(2, 254)}`, S: `203.0.113.${rng.rand(2, 250)}`, P: ans.id === 'o-udp-unreach' ? rng.pick([53, 123, 161]) : rng.pick([22, 25, 80, 443, 8080]), R: `198.51.100.${rng.rand(1, 250)}` };
  const others = rng.shuffle(OBS.filter((r) => r !== ans)).slice(0, 3);
  const picked = rng.shuffle([ans, ...others]);
  return {
    text: `PC1(${v.C})からサーバー(${v.S})のポート ${v.P} への通信の記録(途中のルーターは R9(${v.R}))。この記録から分かることはどれか。`,
    table: { headers: ['送信元', '宛先', '内容'], rows: subCap(ans.attrs.capture, v) },
    options: picked.map((r) => r.attrs.desc), answerIndex: picked.indexOf(ans),
    explanation: [`正解は「${ans.attrs.desc}」。記録は「${ans.ja}」の形。`, ...others.map((r) => `「${r.attrs.desc}」は、記録が「${r.ja}」の形のときに分かること。`)].join('\n'),
    meta: { type: 'obs', ans: ans.id },
  };
}
function stmtQ(rng) {
  const wantTrue = rng.next() < 0.5;
  const ans = rng.pick(STMT.filter((r) => r.attrs.true === wantTrue));
  const others = rng.shuffle(STMT.filter((r) => r.attrs.true !== wantTrue)).slice(0, 3);
  const picked = rng.shuffle([ans, ...others]);
  return {
    text: `接続の失敗の記録の読み方について、${wantTrue ? '正しい' : '誤っている'}ものはどれか。`,
    options: picked.map((r) => r.ja), answerIndex: picked.indexOf(ans),
    explanation: [`正解は「${ans.ja}」(${wantTrue ? '正しい文' : '誤っている文'})。${ans.attrs.why}`, ...others.map((r) => `「${r.ja}」は${r.attrs.true ? '正しい' : '誤り'}。${r.attrs.why}`)].join('\n'),
    meta: { type: 'stmt', wantTrue, ids: picked.map((r) => r.id) },
  };
}
function tfQ(rng) {
  const r = rng.pick(STMT);
  return { text: `次の文は正しいか。\n「${r.ja}」`, options: ['○', '×'], answerIndex: r.attrs.true ? 0 : 1, explanation: `${r.attrs.true ? '正しい(○)' : '誤り(×)'}。${r.attrs.why}`, meta: { type: 'tf', id: r.id } };
}
function verifyConnFail(q) {
  const m = q.meta;
  if (m.type === 'obs') { // 問題文のアドレスで表を作り直し、どの行の記録かを独立に決める
    const t = /PC1\(([\d.]+)\)からサーバー\(([\d.]+)\)のポート (\d+) への通信の記録\(途中のルーターは R9\(([\d.]+)\)\)/.exec(q.text);
    const v = { C: t[1], S: t[2], P: Number(t[3]), R: t[4] };
    const hits = OBS.filter((r) => JSON.stringify(subCap(r.attrs.capture, v)) === JSON.stringify(q.table.rows));
    if (hits.length !== 1) throw new Error('Lv343: 記録に合う行が 1 つでない');
    if (q.options[q.answerIndex] !== hits[0].attrs.desc || q.options.filter((o) => o === hits[0].attrs.desc).length !== 1) throw new Error('Lv343: 分かることが違う');
  } else if (m.type === 'stmt') {
    const hits = q.options.map((o) => { const r = STMT.find((x) => x.ja === o); if (!r) throw new Error(`Lv343: 表に無い文 ${o}`); return r.attrs.true === m.wantTrue; });
    if (hits.filter(Boolean).length !== 1 || !hits[q.answerIndex]) throw new Error('Lv343: 正解が 1 つに決まらない');
  } else {
    const r = STMT.find((x) => x.id === m.id); if ((r.attrs.true ? 0 : 1) !== q.answerIndex) throw new Error('Lv343: ○× が表と合わない');
  }
}

// ================= Lv349 ログの突き合わせ(専門。生+固) =================
const LOG_DEVS = ['R1', 'SW1', 'FW1'];
const LOG_EVENTS = ['Gi0/1 がダウンした', 'Gi1/0/24 がダウンした', '拠点間 VPN が切れた', 'OSPF のネイバーが落ちた', 'VRRP の代表が替わった', 'ポートの電源(PoE)を止めた'];
const hms = (sec) => { const s = ((sec % 86400) + 86400) % 86400; return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':'); };
const secOf = (s) => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + x; };
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
function logQ(rng) {
  const tz = LOG_DEVS.map(() => rng.pick(['JST', 'UTC']));
  const off = LOG_DEVS.map(() => rng.pick([0, 0, 1, 2, 3, 5, -1, -2, -3]));
  const base = rng.rand(1, 13) * 3600 + rng.rand(0, 59) * 60 + rng.rand(0, 59); // UTC の秒
  let trueSec;
  for (;;) { trueSec = LOG_DEVS.map(() => base + rng.rand(0, 600)); const s = trueSec.slice().sort((a, b) => a - b); if (s[1] - s[0] >= 5 && s[2] - s[1] >= 5) break; }
  const disp = trueSec.map((t, i) => t + (tz[i] === 'JST' ? 9 * 3600 : 0) + off[i] * 60);
  const events = rng.shuffle(LOG_EVENTS).slice(0, 3);
  const trueOrder = [0, 1, 2].sort((a, b) => trueSec[a] - trueSec[b]);
  const dispOrder = [0, 1, 2].sort((a, b) => disp[a] - disp[b]);
  const trap = trueOrder.join() !== dispOrder.join();
  const variant = rng.pick(['first', 'order']);
  const clock = (i) => (off[i] === 0 ? '時計は正しい' : off[i] > 0 ? `時計は正しい時刻より ${off[i]} 分進んでいる` : `時計は正しい時刻より ${-off[i]} 分遅れている`);
  const rows = rng.shuffle(LOG_DEVS.map((d, i) => [d, hms(disp[i]), events[i]]));
  const text = `3 台の機器のログは次の表のとおり。時刻の表し方と時計の正しさは機器ごとに違う: ${LOG_DEVS.map((d, i) => `${d} のログは ${tz[i]}(${clock(i)})`).join('。')}。JST は UTC より 9 時間進んでいる。「n 分進んでいる」は、表示が正しい時刻より n 分あとになること。`;
  const conv = LOG_DEVS.map((d, i) => `${d}: 表示 ${hms(disp[i])} ${tz[i]}${tz[i] === 'JST' ? ` = ${hms(disp[i] - 9 * 3600)} UTC` : ''}${off[i] ? `、時計が ${Math.abs(off[i])} 分${off[i] > 0 ? '進んでいる' : '遅れている'}ので正しくは ${hms(trueSec[i])} UTC` : off[i] === 0 && tz[i] === 'UTC' ? '(そのまま)' : ''}`).join('\n');
  const orderStr = (p) => p.map((i) => LOG_DEVS[i]).join(' → ');
  const tail = `\n${conv}\n正しい時刻(UTC)に直すと ${orderStr(trueOrder)} の順。` + (trap ? `表示の時刻をそのまま並べると ${orderStr(dispOrder)} に見えるが、表し方と時計のずれをそろえていないので誤り。` : '');
  if (variant === 'first') {
    const options = rng.shuffle(LOG_DEVS.slice());
    const ans = LOG_DEVS[trueOrder[0]];
    return { text: `${text}いちばん先に起きたのはどの機器のログか。`, table: { headers: ['機器', '時刻', '内容'], rows }, options, answerIndex: options.indexOf(ans), explanation: `正解は ${ans}。${tail}`, meta: { variant, trap, mixed: new Set(tz).size > 1 } };
  }
  const ans = orderStr(trueOrder);
  const options = rng.shuffle([ans, ...rng.shuffle(PERMS.map(orderStr).filter((o) => o !== ans)).slice(0, 3)]);
  return { text: `${text}起きた順に並べたものはどれか。`, table: { headers: ['機器', '時刻', '内容'], rows }, options, answerIndex: options.indexOf(ans), explanation: `正解は ${ans}。${tail}`, meta: { variant, trap, mixed: new Set(tz).size > 1 } };
}
function verifyLogs(q) { // 問題文の表し方・ずれと表の時刻から、UTC の正しい時刻に直して並べ直す
  const spec = {};
  for (const m of q.text.matchAll(/(R1|SW1|FW1) のログは (JST|UTC)\((時計は正しい|時計は正しい時刻より (\d+) 分進んでいる|時計は正しい時刻より (\d+) 分遅れている)\)/g)) {
    spec[m[1]] = { tz: m[2], off: m[4] ? Number(m[4]) : m[5] ? -Number(m[5]) : 0 };
  }
  if (Object.keys(spec).length !== 3) throw new Error('Lv349: 問題文に 3 台の表し方が無い');
  const tru = q.table.rows.map((r) => ({ d: r[0], t: secOf(r[1]) - (spec[r[0]].tz === 'JST' ? 9 * 3600 : 0) - spec[r[0]].off * 60 }));
  tru.sort((a, b) => a.t - b.t);
  if (tru[0].t === tru[1].t || tru[1].t === tru[2].t) throw new Error('Lv349: 同時刻がある');
  const want = /いちばん先に起きた/.test(q.text) ? tru[0].d : tru.map((x) => x.d).join(' → ');
  if (q.options[q.answerIndex] !== want || q.options.filter((o) => o === want).length !== 1) throw new Error(`Lv349: 答えが違う ${want}`);
}

// ================= レベルの一覧 =================
const LEVELS = {
  230: { ...fixedGen('半分に分ける', 'cl230-bisect-v1', bisectQ, verifyBisect) },
  285: gen('ACL と NAT の前後', 'cl285-acl-nat-order-v1', aclNatQ, verifyAclNat),
  296: gen('表から原因(規則)', 'cl296-table-cause-v1', causeQ, verifyCause),
  323: fixedGen('VPN が上がらない', 'cl323-vpn-mismatch-v1', vpnQ, verifyVpn),
  342: gen('記録から再送', 'cl342-retransmit-v1', retransQ, verifyRetrans),
  343: { title: '接続の失敗', kind: '表', minDistinct: 20, make(rng) { return { ...rng.pick([obsQ, obsQ, stmtQ, tfQ])(rng), kind: 'cl343-conn-fail-v1' }; }, verify: verifyConnFail },
  349: fixedGen('ログの突き合わせ', 'cl349-log-order-v1', logQ, verifyLogs),
};

module.exports = { LEVELS, _test: { CAUSES_296, VPN_ITEMS, OBS, STMT, hms, secOf, binIn } };
