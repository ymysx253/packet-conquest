# 構成図・設定・模擬ターミナルの仕組み(部品の口)

作成: 2026-10-25。`DIAGRAM-CONFIG.md`(下書き)の案をそのまま採用して作り始めた(ユーザー指示: 残りの問題をすべて作る)。第 8 章の「決めること」は案のとおり: 省略形は受けない・文法の誤りは行番号つきで返す(回数に数えない)・不正解のときは満たさなかった要件の番号を中立の拠点と強化のときだけ見せる・スマホでも出す・座標は型ごとの表・出力はゲーム専用の短い形・解説で正しい設定の例を見せる。変えたくなったらここを直す。

この文書は**部品どうしの口(形と名前)**を決める。作る人が分かれても組み合わさるように、ここに無い形は作らない。

## 1. ファイル

| 部品 | ファイル | 中身 |
|---|---|---|
| 模擬の本体 | `server/sim/index.js` | 下の API を全部出す(中は `model.js`・`config.js`・`l2.js`・`l3.js`・`services.js`・`terminal.js`・`diagram.js`・`netgen.js` に分けてよい。`netgen-min.js` は残す) |
| 画面: 図 | `public/diagram.js`(`window.PCDiagram`) | SVG を描き、タップを受ける |
| 画面: 設定とターミナル | `public/terminal.js`(`window.PCTerminal`) | 設定の欄(機器ごと)とターミナル(入力行・出力・↑履歴・Tab 補完) |
| ダイアログ | `public/qdialog.js` | `answerKind` の 'tap'・'config' と、`terminal` の付いた問題を描く |
| 判定 | `server/questions/normalize.js` の `judge` | 'tap' は id の比較、'config' は `sim.judgeConfig` |
| 問題 | `server/questions/cl/levels-sim-{basic,mid,adv,expert}.js` | 61 項目。表は `server/questions/data/cl/sim/` |
| 口 | `server/world.js`・`server/index.js`・`server/cl-preview.js` | 送る項目、答えの形の検査、ターミナルの 1 行のやりとり |

## 2. 構成(spec)の形

問題の生成器が作り、`sim.build(spec)` に渡す。JSON にできる素のオブジェクトだけ(関数を入れない)。seed から同じものが作れること。

```js
{
  devices: {
    R1: { kind: 'router',   ifaces: [{ name: 'Gi0/0', ip: '10.1.1.1/24' }, { name: 'Gi0/1', ip: '10.0.12.1/30', ospfCost: 10 }],
          routes: [{ prefix: '10.3.3.0/24', via: '10.0.12.2' }],            // 静的経路。via はアドレスか IF 名。ad は省略なら 1
          ospf: { networks: ['10.0.0.0/8'], area: 0 },                       // 入れる網(IF のアドレスがこの網に入れば OSPF に参加)
          acls: { A10: { type: 'standard', lines: [{ seq: 10, action: 'deny', src: '10.1.1.0/24' }, { seq: 20, action: 'permit', src: 'any' }] },
                  A20: { type: 'extended', lines: [{ seq: 10, action: 'permit', proto: 'tcp', src: 'any', dst: '192.0.2.10/32', dport: 443 }] } },
          nat: { inside: ['Gi0/0'], outside: ['Gi0/1'], source: [{ src: '10.1.1.0/24', iface: 'Gi0/1', overload: true }],
                 static: [{ proto: 'tcp', insideIp: '10.1.1.20', insidePort: 443, outsideIp: '203.0.113.2', outsidePort: 443 }] },
          dhcp: { pools: [{ name: 'LAN30', network: '192.168.30.0/24', gateway: '192.168.30.1', dns: '192.168.30.53', exclude: [['192.168.30.1', '192.168.30.49']] }] } },
    // IF に付けられるもの: ip, ipv6, shutdown(true/false), ospfCost, aclIn, aclOut(ACL 名), natSide('inside'|'outside'), dhcpRelay(アドレス),
    //   vrrp: { group, vip, priority(既定 100), preempt(既定 true) }, sub: [{ tag: 10, ip: '…' }](副 IF。名前は 'Gi0/0.10' で書いても同じ)
    SW1: { kind: 'switch', vlans: [1, 10, 20], stpPriority: 32768,
           ifaces: [{ name: 'Gi1/0/1', mode: 'access', vlan: 10 }, { name: 'Gi1/0/24', mode: 'trunk', allowed: [10, 20], native: 1 },
                    { name: 'Gi1/0/2', mode: 'access', vlan: 10, edge: true, channelGroup: { id: 1, mode: 'active' }, snoopingTrust: false }],
           dhcpSnooping: false },
    L3SW1: { kind: 'l3switch', ipRouting: true, vlans: [10, 20], ifaces: [/* スイッチのポート */], svis: [{ vlan: 10, ip: '10.1.10.1/24' }] },
    PC1: { kind: 'host', ip: '10.1.1.10/24', gateway: '10.1.1.1', dns: '10.1.1.53', dhcp: false, ipv6: '2001:db8:1:1::10/64' },
    SRV1: { kind: 'server', ip: '…', gateway: '…', listen: [{ proto: 'tcp', port: 443 }] },  // 待ち受け(reach の tcp/udp で見る)
    FW1: { kind: 'firewall', /* ルーターと同じ項目 + */ zones: { inside: ['Gi0/0'], outside: ['Gi0/1'] }, policies: [{ from: 'inside', to: 'outside', proto: 'tcp', dport: 443, action: 'permit' }] },
    INET: { kind: 'internet', ip: '203.0.113.1/24' },   // 外の網の代わり(そこへ届けば「外に出られた」)
  },
  links: [['PC1', 'SW1:Gi1/0/1'], ['SW1:Gi1/0/24', 'R1:Gi0/0'], ['R1:Gi0/1', 'R2:Gi0/0']],  // 'dev' か 'dev:port'。ホストは 1 口なのでポートを省ける
  editable: ['R1', 'R3'],                 // 設定を書いてよい機器(無ければ設定の問題ではない)
  requirements: [ /* 第 4 章 */ ],
  layout: 'serial' | 'triangle' | 'square' | 'two-sites' | 'two-switches' | 'cloud' | { /* 自分で座標を置く: 第 5 章 */ },
  hidden: { R2: ['routes'] },             // 図やターミナルから隠すもの(「直す」問題で壊した所を見せないときに使う。省略可)
}
```

- 名前は `devices.json` の付け方(R1・SW1・L3SW1・FW1・PC1・SRV1)。IF 名はルーター `Gi0/n`、スイッチ `Gi1/0/n`、ホスト `Eth0`(省略可)
- アドレスは `COMMON.md` 第 7 章の範囲だけ。MAC は spec に書かなければ `sim.build` がローカル管理(`02:…`)で決める(seed は spec に `seed` を入れれば決まる)
- 機器の種類: router / switch / l3switch / host / server / firewall / internet(外の網 1 口)/ cloud-subnet(PC クラウドの型で使う。経路表 `routeTable: [{ prefix, target: 'local'|'igw'|'natgw'|'peer:<name>' }]`)

## 3. 模擬の API(`server/sim/index.js`)

```js
const sim = require('../sim');
const net = sim.build(spec);                  // 状態を持つ構成(spec は変えない)。sim.clone(net) で写し
sim.applyConfig(net, 'R1', text)              // → { ok, errors: [{ line: 3, text: 'ip rout …', message: '知らないコマンド' }] }。読めた行は当てる
sim.checkSyntax(spec, 'R1', text)             // → 同じ形。当てない(文法だけ)
const st = sim.state(net)                     // 計算した状態(下)
sim.reach(net, 'PC1', 'PC2', { proto: 'icmp'|'tcp'|'udp', port, roundTrip: true, toIp })  // → { ok, path: ['PC1','SW1','R1','R2','PC2'], stoppedAt, reason }
sim.trace(net, 'PC1', '10.3.3.20')            // → { hops: [{ n: 1, ip: '10.1.1.1', device: 'R1' }, …], reached }
sim.check(net, requirements)                  // → [{ id, ok, detail }]
sim.judgeConfig(spec, configs)                // configs: [{ device, text }] → { ok, failed: [要件 id], errors: [{ device, line, message }] }。内部で build → applyConfig → check
const s = sim.session(spec, 'PC1');           // ターミナル(状態は s の中)
sim.exec(s, 'ping 10.3.3.20')                 // → 出力の文字(複数行)。s.device が今の機器。'connect R2' で替える。'configure' … 'end' で設定を当てる(editable の機器だけ)
sim.diagram(spec, { nodeIds, showIps: true }) // → 画面に送る図(第 5 章)。nodeIds は名前 → 乱数 id(問題ごとに生成器が決める)
sim.gen                                       // 構成を作る道具(第 6 章)
```

`sim.state(net)` の中身(確かめ・ターミナルの出力・解説に使う):

| 項目 | 形 |
|---|---|
| `routes[dev]` | `[{ prefix: '10.3.3.0/24', via: '10.0.12.2' or null, iface: 'Gi0/1', proto: 'C'(直結)|'S'(静的)|'O'(OSPF), ad, metric }]`。同じ宛先は AD の小さい方だけ残す |
| `arp[dev]` | `[{ ip, mac, iface }]`(収束した状態) |
| `vlans[dev]` | `{ 10: { ports: ['Gi1/0/1'], trunks: ['Gi1/0/24'] } }` |
| `domains` | ブロードキャストドメインの一覧 `[{ id, members: ['PC1', 'R1:Gi0/0', 'SW1:Gi1/0/1' …], vlan }]` |
| `stp[dev]` | `{ root: 'SW1', ports: { 'Gi1/0/24': 'root'|'designated'|'alternate'|'backup'|'disabled' } }` |
| `lag[dev]` | `{ 1: { members: ['Gi1/0/1', 'Gi1/0/2'], up: true } }` |
| `vrrp` | `[{ group, vip, master: 'R1', backup: 'R2' }]` |
| `dhcp[dev]` | `{ pools: [{ name, free: 205, first: '192.168.30.50' }], bindings: [{ ip, mac, host }] }` |
| `nat[dev]` | `[{ inside: '10.1.1.10:51000', outside: '203.0.113.2:51000', proto }]`(reach を流したあとに増える) |

**決まり(ゲーム内の規則。問題文にも書く)**

- 経路: 直結(AD 0)→ 静的(1。`ip route … 200` なら 200)→ OSPF(110。コストは IF の `ospfCost`、無ければ 1。最短の道。同じコストは両方残し、先頭の IF を使う)。引くときは最長一致
- ARP: 同じ網なら相手、違えばゲートウェイ。アドレスの重複は「重複」で止まる。ゲートウェイがいない(その番地に機器が無い)なら ARP で止まる
- パケットの旅: 送り元 → (L2: 同じ VLAN の範囲だけ)→ ルーターの受信 ACL → NAT(内→外は送信元、外→内は宛先。受信の ACL は NAT の前、送信の ACL は後)→ 経路表 → 送信 ACL → 次へ。TTL は 1 ずつ減り 0 で捨てる。32 ホップで輪。往復(`roundTrip`)は返りも同じ手順で、状態を見る FW(firewall)は返りを覚えていて通す。ルーターの ACL は状態を見ない
- 待ち受け: `reach` の tcp/udp は相手が `listen` していなければ「届いたが拒否」(ok: false, reason: 'closed')。icmp は常に答える
- DHCP: 範囲の先頭から除外を飛ばして順に配る。リレーは `dhcpRelay` の先へ(サーバーは受けた IF の網で範囲を選ぶ)。配れる数 = 範囲 − 除外 − ゲートウェイ
- VRRP: `LEVEL-LIST` 255・256 と同じ(優先度 → アドレス大。持ち主 255。preempt)
- STP: ブリッジ ID = 優先度 + MAC(小さい方がルート)。コストは全部 4(1 Gbps)。同点は相手のブリッジ ID、次にポート番号
- LACP: 両端が束の設定をしていて、少なくとも片方が active なら束になる(254 と同じ)
- OSPF のネイバー: 260 と同じ(エリア・hello/dead・網・認証・スタブ)。ここでは「同じ網に IF があり両方 OSPF に入れていれば隣」と簡単にし、hello などは spec の `ospf.hello/dead` があるときだけ見る

## 4. 要件(requirements)

```js
{ id: 1, kind: 'reach',   from: 'PC1', to: 'PC2', proto: 'icmp', roundTrip: true, expect: true }   // 届く(expect: false なら「届かない」)
{ id: 2, kind: 'reach',   from: 'PC1', to: 'SRV1', proto: 'tcp', port: 443, expect: true }
{ id: 3, kind: 'route',   device: 'R1', prefix: '10.3.3.0/24', via: '10.0.12.2' }                   // via か iface。無ければ「経路がある」だけ
{ id: 4, kind: 'lease',   device: 'R1', host: 'PC1', ip: '192.168.30.50' }                           // PC1 が最初にもらうアドレス
{ id: 5, kind: 'lease',   device: 'R1', pool: 'LAN30', count: 205 }                                  // 配れる数
{ id: 6, kind: 'master',  vip: '10.0.1.254', device: 'R1' }                                          // 代表
{ id: 7, kind: 'master',  vip: '10.0.1.254', device: 'R2', down: ['R1'] }                            // R1 を止めたあとの代表
{ id: 8, kind: 'failover', cut: [['R2:Gi0/1', 'R4:Gi0/0']], then: { kind: 'reach', from: 'PC1', to: 'PC2' } } // 線を切ったあとも届く
{ id: 9, kind: 'vlan',    device: 'SW1', port: 'Gi1/0/1', vlan: 10 }                                 // ポートが VLAN 10 のアクセス
{ id: 10, kind: 'trunk',  device: 'SW1', port: 'Gi1/0/24', allowed: [10, 20] }                       // トランクで 10・20 を通す
{ id: 11, kind: 'path',   from: 'PC1', to: 'PC2', via: ['R1', 'R3', 'R4'] }                          // 通るルーターの順
{ id: 12, kind: 'state',  device: 'R1', path: 'vrrp.0.priority', equals: 120 }                       // 逃げ道(めったに使わない)
```

- `check` は全部を評価して配列で返す(途中で止めない)。`judgeConfig` は errors が無く、全部 ok なら正解
- 「止める」要件(`expect: false`)を設定の問題には必ず入れる(DIAGRAM-CONFIG.md 4.3)

## 5. 画面に送る図(diagram)と答えの形

```js
diagram: {
  w: 1000, h: 600,                                                  // viewBox。型の表で決める
  nodes: [{ id: 'k7f3a2', name: 'R1', kind: 'router', x: 500, y: 120, note: '10.1.1.1/24', ports: [{ id: 'k7f3a2:Gi0/0', name: 'Gi0/0', x: 470, y: 150 }] }],
  links: [{ id: 'l9c1', a: { node: 'k7f3a2', port: 'Gi0/0' }, b: { node: 'm2e8', port: null }, label: '10.1.1.0/24', style: 'solid'|'dash'|'bold' }],
  groups: [{ id: 'g1', label: 'VLAN 10', nodes: ['…'] }],          // 省略可
  tables: { 'k7f3a2': [{ title: '経路表', headers, rows }] },        // 機器をタップすると出る表(省略可)
}
```

- id は問題ごとの乱数(`sim.diagram` に `nodeIds` を渡す。名前 → id)。**正解の id は送らない**
- `answerKind: 'tap'`: 問題に `tap: { mode: 'one'|'many'|'order'|'port'|'link' }`。画面は `{ ids: [...] }` を送る(port は `'<nodeId>:<port>'`、link は link の id)。サーバーの正解は `accept: { ids: [...] }`。judge: one/port/link は 1 つが同じ、many は集合が同じ、order は列が同じ
- `answerKind: 'config'`: 問題に `editable: ['R1', 'R3']`(見せる名前)と、機器ごとの今の設定の抜粋 `configView: { R1: ['interface Gi0/0', ' ip address 10.1.1.1/24', …] }`(見せてよい分だけ)。画面は `{ configs: [{ device: 'R1', text: '…' }] }` を送る(1 台 40 行・1 行 120 字)。サーバーは `q.sim = { spec, requirements }` を持ち(送らない)、`sim.judgeConfig` で判定。不正解のときの結果に `failed: [要件 id]` と `requirementsText`(要件の文の一覧。これは出題時にも送ってよい)
- `terminal: { devices: ['PC1', 'R1'], start: 'PC1' }` が付いた問題: 画面はターミナルの欄を出す。1 行を `{ t: 'term', qid, line }` で送り、`{ t: 'termOut', qid, line, out }` が返る。1 問 60 回・0.3 秒に 1 回まで。答えは `answerKind` のとおり(text / choice / tap / config)
- `answerKind: 'config'` の問題でもターミナルを付けてよい(観測してから直す)。ターミナルの `configure` … `end` で当てた設定は、その session の中だけ。最後の答えは config の欄で送る(session の設定は答えに使わない。画面はターミナルで打った設定を欄にコピーするボタンを出してよい)

## 6. 構成を作る道具(`sim.gen`)

```js
sim.gen.serial(rng, { routers: 1..3, hostsOnLan1: 1..5, switches: true })  // PC1 — SW1 — R1 — [R2 — R3] — SW2 — PC2(netgen-min と同じ形。spec を返す)
sim.gen.triangle(rng)        // R1・R2・R3 が三角形。PC1 は R1、PC2 は R3 の下。R1–R3 の直接の線と R2 回り
sim.gen.square(rng, { costs }) // R1–R2–R4 と R1–R3–R4 の 2 本の道(356・357・311)
sim.gen.twoSites(rng)        // 本社(R1・SW1・PC1・SRV1)と支社(R2・SW2・PC2)、間は外の網(INET)。VPN・NAT・ACL の問題の土台
sim.gen.twoSwitches(rng, { vlans: [10, 20] }) // SW1–SW2 をトランクでつなぎ、両方に VLAN 10・20 の PC。L3SW か R1 の副 IF で VLAN 間
sim.gen.cloud(rng)           // PC クラウド: 公開・非公開のサブネット、NAT ゲートウェイ、インターネットゲートウェイ、ピアリング(354)
sim.gen.addresses(rng)       // 安全な範囲から /24・/30 を切り出す小道具
```

- どれも**そろった(全部届く)状態**を返す。問題はそこから消す・壊す(plant-then-perturb)
- 返す spec には `layout` が入っている(型ごとの座標の表は `diagram.js` 側が持つ)

## 7. ターミナルのコマンド(`sim.exec`)

| 機器 | コマンド | 出力(ゲーム専用の短い形。英語の項目名 + 日本語) |
|---|---|---|
| 共通 | `connect <機器>` / `exit` / `help` / `?` | 機器を替える / 元へ / 使える語 |
| PC・SRV | `ipconfig`(`ip addr`)、`ping <ip|名前>`、`traceroute`(`tracert`)、`arp -a`、`nslookup <名前>`、`route print`(`ip route`) | 自分のアドレス・ゲートウェイ・DNS、ping は 4 回の結果(TTL つき)、traceroute は 4.4 の形 |
| ルーター・L3SW・FW | `show ip route`、`show ip interface brief`、`show ip arp`、`show access-lists`、`show ip nat translations`、`show ip ospf neighbor`、`show vrrp`、`show ip dhcp binding`、`show running-config`、`ping`、`traceroute` | 状態から作る。`hidden` のものは出さない |
| スイッチ | `show vlan`、`show interfaces trunk`、`show mac address-table`、`show spanning-tree`、`show etherchannel summary`、`show ip dhcp snooping`、`show running-config` | 同上 |
| 設定 | `configure` → 第 4.2 章(DIAGRAM-CONFIG.md)の文法を 1 行ずつ → `end` | 文法の誤りは「行 n: …」。`editable` でない機器では「この機器は設定できません」 |

- Tab 補完の候補は `sim.completions(session, partial)` → 語の配列(コマンドの語・IF 名・機器名だけ。アドレスは補わない)
- 打った字は読むだけ。外へは何もつながない。出力も安全な範囲のアドレスだけになる(構成がそうなので)

## 8. 確かめ方

- `test/sim.js`: 文法(受ける・受けない)、経路の最長一致と AD、ARP の重複、ACL の順と NAT の前後、VLAN の範囲、STP の根と止まるポート、LACP、VRRP、DHCP の配り方、OSPF の最短の道。答えは**別の作り方**(素朴な総当たり・BFS)で解き直す
- 問題のテスト `test/cl-sim-*.js`: 生成した問題ごとに、正解の例(`q.solution`。設定の文字 / id の列。画面には送らない)を `sim.judgeConfig` に通して正解になること、わざと間違えた答え(1 行抜く・逆の経路・別の機器)が不正解になること、原因が 1 つに決まること

## 9. 作ったときに決めた細部(2026-10-25。server/sim の各ファイルの先頭にも書いてある)

- 端点の鍵: ルーター・ホストの IF `R1:Gi0/0`、副 IF `R1:Gi0/0.10`、スイッチの VLAN と SVI `SW1#vlan10`。アクセスポートの VLAN がスイッチに無ければ通さない。トランクのネイティブ VLAN が両端で違えば、その 2 つの VLAN がつながる
- STP は全 VLAN 共通で 1 本。束(LACP)は 1 本に数える。ブリッジ ID = 優先度 + いちばん小さい MAC、コストは全部 4。LACP は 254 の規則(両方 on も束)
- OSPF: 同じドメインで同じ網にあり、両方が参加し、エリアが同じなら隣(hello/dead/認証は spec に書いてあるときだけ見る)。網へのメトリック = そこまでのコスト + その IF のコスト。`redistribute static` は外部経路(メトリック 20)。静的経路の via がどの直結の網にも無ければ経路表に載らない
- ルーターの順: 受信 ACL → NAT(外側 IF で受けたものの宛先)→ 自分宛か → TTL → 経路 → NAT(内 → 外の送信元)→ FW のポリシー(状態で返りを通す)→ 送信 ACL → ARP。ホストは直結 + ゲートウェイの既定経路。外の網(internet)は、ほかの機器が持っていない自分の網のアドレスを全部持つ
- 設定の塊(interface …)の中でトップの行(ip route・vlan・spanning-tree priority など)を書いたら、塊を出てから当てる(exit 忘れを許す)
- traceroute は各ホップの返事が送り元へ戻れるかも見て、戻れないホップは `*  *  *`。reach の返りの失敗は `reason: 'back:<理由>'`、stoppedAt は返りの止まった所
- DHCP: 同じドメインのサーバー、無ければルーター IF の dhcpRelay の先。配る順はホスト名順。配れる数 = 254 − 除外 − ゲートウェイ。VRRP の仮想 MAC は `00:00:5e:00:01:<グループ>`
- クラウド: `cloud-subnet` は VLAN 1 のスイッチ兼ゲートウェイ(.1)。経路表は local / peer:<名> / igw / natgw。natgw の先からは返りしか入れない。`cloud-gw`(IGW・NATGW)は図に見せるだけの口
- DNS: サーバー役の機器に `dnsRecords: [{ name, type: 'A'|'CNAME', value }]`(270 用。nslookup が CNAME の連鎖をたどる)。`hidden` の項目は show と running-config に出さない
- 画面(public/diagram.js・terminal.js・qdialog.js)は第 5 章のとおり。IF のアドレスは機器の note にまとめず `ports[].note` に入れる。ポートの座標は機器の縁(中心から 36〜42)。結果には `failed`(満たさなかった要件 id)と、任意で `correctIds`(tap の正解。中立の拠点と強化のときだけ)
