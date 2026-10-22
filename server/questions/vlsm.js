'use strict';
// Lv21〜30 アドレス空間の設計(VLSM)。docs/questions/design-11-50.md 第 2 章、docs/questions/COMMON.md。
//   Lv21 3 区画のプレフィックス長(prefixlen × 3、set)
//   Lv22 3 区画の CIDR(ipv4cidr × 3、set)
//   Lv23 4 区画の CIDR。同サイズの区画を含む(ipv4cidr × 4、set)
//   Lv24 指定区画の使用可能範囲と親の未使用数(ipv4 × 2 + number、ordered)
//   Lv25 未使用領域の最小 CIDR 分解(ipv4cidr × k、set)
//   Lv26 足りるか・不足数・最小の親(yesno + number + prefixlen、ordered)
//   Lv27 書かれた順の配置と整列の無駄(ipv4cidr × 3〜4 + number、ordered)
//   Lv28 2 区画の再集約と巻き込み(ipv4cidr + number、ordered)
//   Lv29 既存割り当てへの追加(ipv4cidr × 1〜2、ordered)
//   Lv30 総合(LAN + /30 リンク)。全配置(set)か未使用 CIDR 一覧(set)のどちらかを出す
// すべて入力式(answerKind: 'text')。答えは計算で決まるので常に正確。fields[].accept は normalize を通した正規形。
// 乱数は引数の rng だけを使う(Math.random は使わない)。(templateId, seed, generatorVersion) から同じ問題が再現できる。
// 親ネットワークは node.base / node.span から作る(拠点のブロックの中、または拠点のブロックを含む上位ブロック)。
// 検証テスト test/vlsm.js は別実装(素朴な走査・全アドレス列挙)で解き直す。

const { toIp, netOf } = require('./subnet');
const { normalize } = require('./normalize');

const VERSION = '2026.10';
const RANGE = [21, 30];

const fmt = (n) => n.toLocaleString('ja-JP');
const cidr = (net, p) => `${toIp(net)}/${p}`;
const parseIp = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0) >>> 0;
const log2 = (size) => 31 - Math.clz32(size); // 2 の冪(< 2^32)の指数
const alignUp = (x, size) => Math.ceil(x / size) * size;
const sizeOf = (p) => 2 ** (32 - p);

// 区画名(架空の部署名)。重複なしで選ぶ
const NAMES = ['営業', '開発', '総務', '来客', 'サーバー', '無線', '倉庫', '受付', '経理', '人事', '工場', '管理', '本社', '支店 A', '支店 B', '研究', '会議室', '監視', '物流', '教室'];
// 必要台数の候補。2 の冪 −2 の近く(126, 254, 510)、2 の冪そのもの(128、256: +2 を忘れると 1 段小さくなる罠)、中途半端(60, 300)、小さい(5, 10)を混ぜる
const HOSTS = [3, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30, 32, 40, 50, 60, 62, 64, 75, 100, 120, 126, 128, 150, 200, 250, 254, 256, 300, 400, 500, 510, 512, 600, 700, 900, 1000, 1022, 1024, 1500, 2000, 2046, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000, 30000];

// ---------- 計算の部品(設計書 第 5 章の名前) ----------
// 必要台数 + 2 が収まる最小のブロック。最小は /30(4 アドレス)。/31 は使わない
function blockFor(hosts) {
  const bits = Math.max(2, Math.ceil(Math.log2(hosts + 2)));
  return { size: 2 ** bits, p: 32 - bits };
}
// 大きい順に親の先頭から隙間なく。同サイズは書かれた順(安定)。戻り: 置いた区画(net 付き)と次の空きアドレス
function placeDescending(parentNet, regions) {
  const sorted = regions.map((r, idx) => ({ ...r, ...blockFor(r.hosts), idx })).sort((a, b) => b.size - a.size || a.idx - b.idx);
  let cur = parentNet;
  for (const r of sorted) { r.net = cur; cur += r.size; }
  return { sorted, end: cur };
}
// 書かれた順に、前の区画の次のアドレス以降で自分のサイズに整列した最初の位置へ。飛ばした数も返す
function placeInOrder(parentNet, regions) {
  let cur = parentNet, skipped = 0;
  const placed = regions.map((r) => {
    const b = blockFor(r.hosts); const net = alignUp(cur, b.size);
    skipped += net - cur; cur = net + b.size;
    return { ...r, ...b, net };
  });
  return { placed, end: cur, skipped };
}
// [start, end) を最少個数の CIDR ブロックに分ける(先頭の整列で決まる最大ブロックを順に切る)
function freeCidrs(start, end) {
  const out = [];
  let cur = start;
  while (cur < end) {
    let size = 1;
    while (cur % (size * 2) === 0 && cur + size * 2 <= end) size *= 2;
    out.push({ net: cur, size, p: 32 - log2(size) });
    cur += size;
  }
  return out;
}
// 2 ブロックを含む最小の集約
function summaryOf(a, b) {
  let p = Math.min(a.p, b.p);
  while (p > 0 && netOf(a.net, p) !== netOf(b.net, p)) p--;
  return { net: netOf(a.net, p), p, size: sizeOf(p) };
}
const contains = (outer, inner) => inner.p >= outer.p && netOf(inner.net, outer.p) === outer.net; // outer ⊇ inner
const overlaps = (a, b) => a.net < b.net + b.size && b.net < a.net + a.size;
// 新しい要求を書かれた順に、空きの中で収まる最も先頭の整列位置へ(既存は動かさない)。置けないものは net = null
function placeIntoGaps(parent, existing, requests) {
  const used = existing.map((e) => ({ net: e.net, size: e.size || sizeOf(e.p) }));
  const parentEnd = parent.net + sizeOf(parent.p);
  return requests.map((r) => {
    const b = blockFor(r.hosts);
    let net = null;
    for (let pos = alignUp(parent.net, b.size); pos + b.size <= parentEnd; pos += b.size) {
      if (!used.some((u) => overlaps(u, { net: pos, size: b.size }))) { net = pos; break; }
    }
    if (net !== null) used.push({ net, size: b.size });
    return { ...r, ...b, net };
  });
}

// ---------- 文章の部品 ----------
const RULE = '配置の規則: 必要台数 + 2(ネットワークアドレスとブロードキャストのぶん。台数にはこの 2 つを含めない)が収まる最小のブロックを各区画に与え、ブロックの大きい順に親の先頭から隙間なく並べる。同じ大きさの区画の順番は問わない。台数にはルータのインターフェースぶんも含めてあるので、別に足さない。';
const RULE_INORDER = '配置の規則(この問題だけ): ブロックの大きさは「必要台数 + 2(ネットワークアドレスとブロードキャスト。台数には含めない)が収まる最小のブロック」。並べる順は大きい順ではなく表に書かれた順で、各区画は前の区画の次のアドレス以降にある「自分のブロックの大きさに整列した最初の位置」に置く(最初の区画は親の先頭)。台数にはルータのインターフェースぶんも含めてあるので、別に足さない。';
const RULE_GAPS = '配置の規則: 新しい要求のブロックは「必要台数 + 2(ネットワークアドレスとブロードキャスト。台数には含めない)が収まる最小のブロック」。新しい要求を書かれた順に、空きの中で収まる最も先頭の整列位置(自分のブロックの大きさの倍数になっているアドレス)に置く。既存の区画は動かさない。台数にはルータのインターフェースぶんも含めてあるので、別に足さない。';
const DEFENSE = '必要数ぴったりでなく成長分を見込み、集約できる並びにしておくと経路表と ACL が短くなる。';
const HINT = { ipv4cidr: '例: 192.0.2.0/24', ipv4: '例: 192.0.2.1', prefixlen: '例: 24 または /24', number: '例: 280', yesno: '○ または ×' };

// 区画の表。hosts は台数
const regionTable = (regions) => ({ headers: ['区画', '必要台数'], rows: regions.map((r) => [r.name, `${fmt(r.hosts)} 台`]) });
// 「営業 120 台 → 122 → 128 = 2^7 → /25」
const sizeStep = (r) => `${r.name} ${fmt(r.hosts)} 台 → ${fmt(r.hosts + 2)} → ${fmt(r.size)} = 2^${log2(r.size)} → /${r.p}`;
const sizeSteps = (rs) => rs.map(sizeStep).join('、');
const totalLine = (rs, parentSize) => `${rs.map((r) => fmt(r.size)).join(' + ')} = ${fmt(rs.reduce((s, r) => s + r.size, 0))}${parentSize ? `(親は ${fmt(parentSize)})` : ''}`;
// 大きい方から i 番目の欄のラベル。同サイズの区画はまとめて併記する(入替を許すため)
function rankLabel(sorted, i) {
  const r = sorted[i];
  const group = sorted.filter((x) => x.size === r.size).map((x) => `${x.name} ${fmt(x.hosts)} 台`).join(' / ');
  return `大きい方から ${i + 1} 番目(${group})`;
}
function field(name, label, format, value, extra = {}) {
  const norm = normalize(format, value, extra);
  if (norm === null) throw new Error(`正規化できない答え: ${format} ${value}`);
  return { name, label, format, hint: HINT[format], accept: [norm], ...extra };
}
function baseQuestion(type, params) {
  return { type, templateId: `${type}-v1`, answerKind: 'text', meta: params };
}

// ---------- 乱数で要件を作る ----------
// 拠点のブロック(node.span + 2 アドレス)から親を作る。p が拠点のプレフィックス以上なら拠点の中の整列したブロック、小さければ拠点を含む上位ブロック
function nodePrefix(node) { return 32 - Math.round(Math.log2((node.span || 65534) + 2)); }
function pickParent(rng, node, pMin, pMax) {
  const p = rng.rand(pMin, pMax);
  const np = nodePrefix(node);
  if (p <= np) return { net: netOf(node.base, p), p, size: sizeOf(p) };
  const k = rng.rand(0, 2 ** (p - np) - 1);
  return { net: netOf(node.base, np) + k * sizeOf(p), p, size: sizeOf(p) };
}
// 台数の候補: ブロックが親の半分以下、親の 1/128 以上(小さすぎる区画ばかりにならないように)、min〜max の範囲
function hostCands(parentSize, { min = 3, max = Infinity, floor = parentSize / 128 } = {}) {
  return HOSTS.filter((h) => h >= min && h <= max && blockFor(h).size <= parentSize / 2 && blockFor(h).size >= Math.min(floor, 4));
}
function pickNames(rng, n) { return rng.shuffle(NAMES).slice(0, n); }
const sumSizes = (hosts) => hosts.reduce((s, h) => s + blockFor(h).size, 0);
// 条件 ok を満たすまで台数の組を引き直す(決定的。上限を超えたら最後の組をそのまま返し、呼び出し側が別の条件を記録する)
function drawHosts(rng, n, cands, ok, tries = 300) {
  let hosts = [];
  for (let t = 0; t < tries; t++) {
    hosts = Array.from({ length: n }, () => rng.pick(cands));
    if (ok(hosts)) return hosts;
  }
  // 最後の手段: 小さい方から n 個(必ず収まる)
  const small = cands.slice().sort((a, b) => a - b).slice(0, n);
  return ok(small) ? small : hosts;
}
const regionsOf = (names, hosts) => hosts.map((h, i) => ({ name: names[i], hosts: h }));

const DRAW = {
  21(rng, node) {
    const parent = pickParent(rng, node, 20, 22);
    const cands = hostCands(parent.size, { min: 5, max: 500, floor: 4 });
    const hosts = drawHosts(rng, 3, cands, (hs) => sumSizes(hs) <= parent.size);
    return { parent, regions: regionsOf(pickNames(rng, 3), hosts) };
  },
  22(rng, node) {
    const parent = pickParent(rng, node, 20, 22);
    const hosts = drawHosts(rng, 3, hostCands(parent.size), (hs) => sumSizes(hs) <= parent.size);
    return { parent, regions: regionsOf(pickNames(rng, 3), hosts) };
  },
  23(rng, node) {
    const parent = pickParent(rng, node, 19, 22);
    const wantTie = rng.next() < 0.5;
    const cands = hostCands(parent.size);
    const tieOf = (hs) => new Set(hs.map((h) => blockFor(h).p)).size < hs.length;
    const hosts = drawHosts(rng, 4, cands, (hs) => sumSizes(hs) <= parent.size && tieOf(hs) === wantTie);
    return { parent, regions: regionsOf(pickNames(rng, 4), hosts) };
  },
  24(rng, node) {
    const parent = pickParent(rng, node, 19, 22);
    const n = rng.rand(4, 5);
    // 「k 番目」を一意にするため同サイズの区画は作らない。未使用も 0 にしない
    const hosts = drawHosts(rng, n, hostCands(parent.size), (hs) => sumSizes(hs) < parent.size && new Set(hs.map((h) => blockFor(h).p)).size === hs.length);
    return { parent, regions: regionsOf(pickNames(rng, n), hosts), k: rng.rand(1, n) };
  },
  25(rng, node) {
    const parent = pickParent(rng, node, 20, 22);
    const n = rng.rand(3, 5);
    const hosts = drawHosts(rng, n, hostCands(parent.size), (hs) => {
      const total = sumSizes(hs); if (total >= parent.size) return false;
      const k = freeCidrs(parent.net + total, parent.net + parent.size).length; return k >= 2 && k <= 4;
    });
    return { parent, regions: regionsOf(pickNames(rng, n), hosts) };
  },
  26(rng, node) {
    const parent = pickParent(rng, node, 20, 22);
    const n = rng.rand(4, 6);
    const wantFit = rng.next() < 0.5;
    const hosts = drawHosts(rng, n, hostCands(parent.size), (hs) => {
      const total = sumSizes(hs);
      return wantFit ? total <= parent.size : total > parent.size && total <= parent.size * 4;
    });
    return { parent, regions: regionsOf(pickNames(rng, n), hosts) };
  },
  27(rng, node) {
    const parent = pickParent(rng, node, 21, 23);
    const n = rng.rand(3, 4);
    // 書かれた順が大きい順と一致せず(無駄が 0 にならない)、親に収まる
    const hosts = drawHosts(rng, n, hostCands(parent.size), (hs) => {
      const r = placeInOrder(parent.net, hs.map((h) => ({ hosts: h })));
      return r.end <= parent.net + parent.size && r.skipped > 0;
    });
    return { parent, regions: regionsOf(pickNames(rng, n), hosts) };
  },
  28(rng, node) {
    const parent = pickParent(rng, node, 19, 22);
    const n = rng.rand(4, 5);
    const hosts = drawHosts(rng, n, hostCands(parent.size), (hs) => sumSizes(hs) <= parent.size);
    const regions = regionsOf(pickNames(rng, n), hosts);
    // 巻き込み 0 と 1 以上を半々に。条件に合う組が無ければ最初の組
    const wantNone = rng.next() < 0.5;
    const { sorted } = placeDescending(parent.net, regions);
    const pairs = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
    let pair = null;
    for (const [i, j] of rng.shuffle(pairs)) {
      const a = sorted.find((r) => r.idx === i), b = sorted.find((r) => r.idx === j);
      const s = summaryOf(a, b);
      const engulfed = sorted.filter((r) => r.idx !== i && r.idx !== j && contains(s, r)).length;
      if ((engulfed === 0) === wantNone) { pair = [i, j]; break; }
    }
    return { parent, regions, pair: pair || pairs[0] };
  },
  29(rng, node) {
    const parent = pickParent(rng, node, 16, 22);
    const nExisting = rng.rand(2, 3), nNew = rng.rand(1, 2);
    const parentEnd = parent.net + parent.size;
    const cands = hostCands(parent.size).filter((h) => blockFor(h).size <= parent.size / 4);
    // 既存を非連続に置き(隙間を作る)、新規のうち 1 件以上が「最初の空きを素朴に読むと間違う」ものになるまで引き直す
    for (let t = 0; t < 400; t++) {
      let cur = parent.net; const existing = []; let ok = true;
      for (let i = 0; i < nExisting; i++) {
        const b = blockFor(rng.pick(cands));
        const gap = rng.pick([0, 0, b.size / 4, b.size / 2, b.size, b.size * 2]);
        const net = alignUp(cur + gap, b.size);
        if (net + b.size > parentEnd) { ok = false; break; }
        existing.push({ net, p: b.p, size: b.size }); cur = net + b.size;
      }
      if (!ok || cur >= parentEnd) continue;
      if (!existing.some((e, i) => e.net > (i === 0 ? parent.net : existing[i - 1].net + existing[i - 1].size))) continue; // 既存は非連続(隙間がある)
      const requests = Array.from({ length: nNew }, () => ({ hosts: rng.pick(cands) }));
      const placed = placeIntoGaps(parent, existing, requests);
      if (placed.some((r) => r.net === null)) continue;
      if (!trapOf(parent, existing, placed)) continue;
      const names = pickNames(rng, nExisting);
      return {
        parent,
        existing: existing.map((e, i) => ({ name: names[i], net: e.net, p: e.p })),
        requests: placed.map((r, i) => ({ name: `新規 ${'ABC'[i]}`, hosts: r.hosts })),
      };
    }
    // 最後の手段(構成的): 既存 2 つで、最初の空きには新規が入らない形を作る
    const b = blockFor(rng.pick(cands.filter((h) => blockFor(h).size >= 16)) || 100);
    const names = pickNames(rng, 2);
    return {
      parent,
      existing: [{ name: names[0], net: parent.net, p: b.p + 1 }, { name: names[1], net: parent.net + b.size, p: b.p + 2 }],
      requests: [{ name: '新規 A', hosts: b.size - 2 }],
    };
  },
  30(rng, node, o = {}) {
    const parent = pickParent(rng, node, 20, 22);
    const form = o.form || (rng.next() < 0.5 ? 'plan' : 'free'); // o.form: 新しい番号の口が型を 1 つに決めるときだけ
    // plan は欄数 6 まで(LAN 4 + リンク 1〜2、または LAN 5 + リンク 1)。free は LAN 4〜6 + リンク 1〜3 で、未使用ブロックは 2〜6 個(/30 の端数で細かいブロックが増えるため 6 まで許す)
    const [nLan, nLink] = form === 'plan' ? rng.pick([[4, 1], [4, 2], [5, 1]]) : [rng.rand(4, 6), rng.rand(1, 3)];
    const cands = hostCands(parent.size, { min: 3 });
    const hosts = drawHosts(rng, nLan, cands, (hs) => {
      const total = sumSizes(hs) + 4 * nLink;
      if (total > parent.size) return false;
      if (form === 'plan') return true;
      const k = freeCidrs(parent.net + total, parent.net + parent.size).length; return k >= 2 && k <= 6;
    }, 600);
    return { parent, regions: regionsOf(pickNames(rng, nLan), hosts), links: nLink, form };
  },
};
// Lv29 の罠: 「最初の空きの先頭を自分のサイズに整列した位置」(素朴な読み)と本当の位置が違う要求があるか
function trapOf(parent, existing, placed) {
  const used = existing.map((e) => ({ net: e.net, size: e.size || sizeOf(e.p) }));
  let trap = false;
  for (const r of placed) {
    let first = parent.net;
    while (used.some((u) => u.net <= first && first < u.net + u.size)) first = used.find((u) => u.net <= first && first < u.net + u.size).net + used.find((u) => u.net <= first && first < u.net + u.size).size;
    if (alignUp(first, r.size) !== r.net) trap = true;
    used.push({ net: r.net, size: r.size });
  }
  return trap;
}

// ---------- 問題を組み立てる(パラメータ → 問題。テストが設計書の例題を同じ値で作るのにも使う) ----------
const BUILD = {
  21(params) {
    const { parent, regions } = params;
    const { sorted } = placeDescending(parent.net, regions);
    const q = baseQuestion('vlsm-prefix', params);
    q.text = `親ネットワーク ${cidr(parent.net, parent.p)}(${fmt(parent.size)} アドレス)を、下の ${regions.length} 区画に分ける。\n${RULE}\n各区画のプレフィックス長を、ブロックの大きい方から順に答える。`;
    q.table = regionTable(regions);
    q.compare = 'set';
    q.fields = sorted.map((r, i) => field(`p${i + 1}`, rankLabel(sorted, i), 'prefixlen', String(r.p)));
    q.explanation = `大きい順に並べ替えてから、必要台数 + 2 を 2 の冪に切り上げる: ${sizeSteps(sorted)}。合計 ${totalLine(sorted, parent.size)}。+2 を忘れると台数が 2 の冪ちょうど(128 など)のとき 1 段小さく見積もってしまう。`;
    q.defenseNote = `${DEFENSE}この親には ${fmt(parent.size - sorted.reduce((s, r) => s + r.size, 0))} アドレスが残るので、最大の区画(${sorted[0].name})を 1 段大きく取る余地がある。`;
    return q;
  },
  22(params) { return cidrQuestion('vlsm-cidr3', params); },
  23(params) { return cidrQuestion('vlsm-cidr4', params); },
  24(params) {
    const { parent, regions, k } = params;
    const { sorted } = placeDescending(parent.net, regions);
    const r = sorted[k - 1];
    const total = sorted.reduce((s, x) => s + x.size, 0);
    const unused = parent.size - total;
    const first = r.net + 1, last = r.net + r.size - 2;
    const q = baseQuestion('vlsm-range', params);
    q.text = `親ネットワーク ${cidr(parent.net, parent.p)}(${fmt(parent.size)} アドレス)を、下の ${regions.length} 区画に分ける。\n${RULE}\nブロックの大きい方から ${k} 番目(${r.name} ${fmt(r.hosts)} 台。1 番目から数える)の区画で機器に割り当てられる最初のアドレスと最後のアドレス、そして配置のあと親に残る未使用のアドレス数を答える。`;
    q.table = regionTable(regions);
    q.fields = [
      field('first', `${k} 番目(${r.name})で使える最初のアドレス`, 'ipv4', toIp(first)),
      field('last', `${k} 番目(${r.name})で使える最後のアドレス`, 'ipv4', toIp(last)),
      field('unused', '親に残る未使用アドレス数', 'number', String(unused)),
    ];
    q.explanation = `${sizeSteps(sorted)}。先頭から順に ${sorted.map((x) => `${x.name} ${cidr(x.net, x.p)}`).join('、')}。${k} 番目は ${cidr(r.net, r.p)} で、ネットワークアドレス ${toIp(r.net)} とブロードキャスト ${toIp(r.net + r.size - 1)} を除いた ${toIp(first)}〜${toIp(last)} が機器に使える。未使用は ${fmt(parent.size)} − ${fmt(total)} = ${fmt(unused)}。`;
    q.defenseNote = `${DEFENSE}${r.name} の区画は ${fmt(r.size - 2)} 台まで入るので、${fmt(r.hosts)} 台のいま ${fmt(r.size - 2 - r.hosts)} 台ぶんの余裕がある。`;
    return q;
  },
  25(params) {
    const { parent, regions } = params;
    const { sorted, end } = placeDescending(parent.net, regions);
    const free = freeCidrs(end, parent.net + parent.size);
    const q = baseQuestion('vlsm-free', params);
    q.text = `親ネットワーク ${cidr(parent.net, parent.p)}(${fmt(parent.size)} アドレス)を、下の ${regions.length} 区画に分ける。\n${RULE}\n配置のあと親に残る未使用の領域を、最も少ない個数の CIDR ブロック(${free.length} 個)で答える。先頭側のブロックから順に。`;
    q.table = regionTable(regions);
    q.compare = 'set';
    q.fields = free.map((f, i) => field(`free${i + 1}`, `未使用ブロック 先頭から ${i + 1} 番目`, 'ipv4cidr', cidr(f.net, f.p)));
    q.explanation = `${sizeSteps(sorted)}。合計 ${totalLine(sorted, parent.size)} で、使うのは ${toIp(parent.net)}〜${toIp(end - 1)}。残り ${toIp(end)}〜${toIp(parent.net + parent.size - 1)}(${fmt(parent.size - (end - parent.net))} アドレス)は、先頭の整列で決まる最大のブロックを順に切ると ${free.map((f) => `${cidr(f.net, f.p)}(${fmt(f.size)})`).join('、')} の ${free.length} 個になる。`;
    q.defenseNote = `${DEFENSE}未使用領域を ${free.length} 個の CIDR で把握しておくと、使っていない範囲を ACL で落とす行がそのまま書ける。`;
    return q;
  },
  26(params) {
    const { parent, regions } = params;
    const sized = regions.map((r) => ({ ...r, ...blockFor(r.hosts) })).sort((a, b) => b.size - a.size);
    const total = sized.reduce((s, r) => s + r.size, 0);
    const fits = total <= parent.size;
    const shortage = fits ? 0 : total - parent.size;
    let bits = 0; while (2 ** bits < total) bits++;
    const minP = 32 - bits;
    const q = baseQuestion('vlsm-fit', params);
    q.text = `親ネットワーク ${cidr(parent.net, parent.p)}(${fmt(parent.size)} アドレス)に、下の ${regions.length} 区画を置きたい。\n${RULE}\nすべて収まるか(○ / ×)、収まらない場合に不足するアドレス数(収まるなら 0)、この ${regions.length} 区画をすべて収めるのに必要な最小の親のプレフィックス長(収まる場合もその値を答える)を答える。`;
    q.table = regionTable(regions);
    q.fields = [
      field('fits', '親に収まるか', 'yesno', fits ? 'yes' : 'no'),
      field('shortage', '不足するアドレス数(収まるなら 0)', 'number', String(shortage)),
      field('minParent', '収めるのに必要な最小の親のプレフィックス長', 'prefixlen', String(minP)),
    ];
    q.explanation = `${sizeSteps(sized)}。合計 ${totalLine(sized, parent.size)}。${fits ? `${fmt(total)} ≤ ${fmt(parent.size)} なので収まる(2 の冪を大きい順に詰めるので整列の無駄は出ない)。不足は 0。` : `${fmt(total)} > ${fmt(parent.size)} なので収まらない。不足は ${fmt(total)} − ${fmt(parent.size)} = ${fmt(shortage)}。`}合計 ${fmt(total)} を収める最小の 2 の冪は ${fmt(2 ** bits)} = 2^${bits} なので、必要な親は /${minP}。`;
    q.defenseNote = `${DEFENSE}親の大きさは合計 ${fmt(total)} に対して ${fmt(2 ** bits)} が下限だが、1 段大きい /${minP - 1} を確保しておくと後から増える区画も集約の中に入る。`;
    return q;
  },
  27(params) {
    const { parent, regions } = params;
    const { placed, skipped } = placeInOrder(parent.net, regions);
    const q = baseQuestion('vlsm-inorder', params);
    q.text = `親ネットワーク ${cidr(parent.net, parent.p)}(${fmt(parent.size)} アドレス)に、下の ${regions.length} 区画を表の順に置く。\n${RULE_INORDER}\n各区画の CIDR を書かれた順に答え、最後に整列のために飛ばした(使われずに残った)アドレスの合計数を答える。親の末尾に残る領域は飛ばした数に含めない。`;
    q.table = { headers: ['順', '区画', '必要台数'], rows: regions.map((r, i) => [`${i + 1}`, r.name, `${fmt(r.hosts)} 台`]) };
    q.fields = placed.map((r, i) => field(`c${i + 1}`, `${i + 1} 番目に置く ${r.name}(${fmt(r.hosts)} 台)`, 'ipv4cidr', cidr(r.net, r.p)));
    q.fields.push(field('skipped', '整列のために飛ばしたアドレスの合計数', 'number', String(skipped)));
    const steps = placed.map((r, i) => {
      const prevEnd = i === 0 ? parent.net : placed[i - 1].net + placed[i - 1].size;
      const gap = r.net - prevEnd;
      if (i === 0) return `${r.name} は /${r.p}(${fmt(r.size)} 整列)で親の先頭 ${toIp(r.net)} に置く`;
      return `${r.name} は /${r.p}(${fmt(r.size)} 整列)。前の区画の次は ${toIp(prevEnd)} で、${gap > 0 ? `${fmt(r.size)} の倍数でないので ${toIp(r.net)} まで進める(${toIp(prevEnd)}〜${toIp(r.net - 1)} の ${fmt(gap)} 個が飛ぶ)` : 'ちょうど整列しているのでそのまま置ける'}`;
    });
    q.explanation = `${sizeSteps(placed)}。${steps.join('。')}。飛ばした合計は ${fmt(skipped)}。大きい順に置けばこの無駄は出ない。`;
    q.defenseNote = `${DEFENSE}書かれた順に置くと ${fmt(skipped)} アドレスが飛ぶ。大きい順に並べ直せば隙間なく収まり、残りを 1 つの範囲として扱える。`;
    return q;
  },
  28(params) {
    const { parent, regions, pair } = params;
    const { sorted } = placeDescending(parent.net, regions);
    const a = sorted.find((r) => r.idx === pair[0]), b = sorted.find((r) => r.idx === pair[1]);
    const s = summaryOf(a, b);
    const others = sorted.filter((r) => r.idx !== pair[0] && r.idx !== pair[1]);
    const engulfed = others.filter((r) => contains(s, r));
    const q = baseQuestion('vlsm-summary', params);
    q.text = `親ネットワーク ${cidr(parent.net, parent.p)} を下の表のように配置してある(各区画に必要台数 + 2 が収まる最小のブロックを与え、大きい順に先頭から隙間なく並べた結果。台数にはネットワークアドレスとブロードキャストを含めない)。\n${a.name} ${cidr(a.net, a.p)} と ${b.name} ${cidr(b.net, b.p)} の 2 区画を 1 行の経路にまとめる最小の集約を CIDR で答え、その集約の範囲に含まれてしまう他の区画の数を答える(${a.name} と ${b.name} 自身は数えない。親の未使用領域も数えない)。`;
    q.table = { headers: ['区画', '必要台数', '割り当て'], rows: sorted.map((r) => [r.name, `${fmt(r.hosts)} 台`, cidr(r.net, r.p)]) };
    q.fields = [
      field('summary', `${a.name} と ${b.name} を含む最小の集約`, 'ipv4cidr', cidr(s.net, s.p)),
      field('engulfed', '集約に含まれる他の区画の数', 'number', String(engulfed.length)),
    ];
    const bin = (net) => net.toString(2).padStart(32, '0');
    q.explanation = `${toIp(a.net)} と ${toIp(b.net)} を 2 進にすると先頭 ${s.p} ビットまで同じ(${bin(a.net).slice(0, s.p)})なので、集約は ${cidr(s.net, s.p)}(${toIp(s.net)}〜${toIp(s.net + s.size - 1)}、${fmt(s.size)} アドレス)。${engulfed.length === 0 ? '他の区画はこの範囲に入らない。' : `この範囲には ${engulfed.map((r) => `${r.name} ${cidr(r.net, r.p)}`).join('、')} も入ってしまう(${engulfed.length} 区画)。`}`;
    q.defenseNote = `${DEFENSE}集約 ${cidr(s.net, s.p)} を 1 行の許可にすると${engulfed.length === 0 ? '他の区画は巻き込まないが、未使用領域も通してしまうので、使っていない範囲は別に落とす' : `${engulfed.map((r) => r.name).join('・')} まで通してしまう。巻き込む区画が無い並びに置き直すか、行を分ける`}。`;
    return q;
  },
  29(params) {
    const { parent, existing, requests } = params;
    const ex = existing.map((e) => ({ ...e, size: sizeOf(e.p) }));
    const placed = placeIntoGaps(parent, ex, requests);
    if (placed.some((r) => r.net === null)) throw new Error('新規の要求が親に置けない');
    const q = baseQuestion('vlsm-add', params);
    q.text = `親ネットワーク ${cidr(parent.net, parent.p)}(${fmt(parent.size)} アドレス)には既に下の区画が割り当てられている。新しい要求 ${requests.map((r) => `${r.name}(${fmt(r.hosts)} 台)`).join('、')} を置く。\n${RULE_GAPS}\n${requests.length === 1 ? `${requests[0].name} の CIDR を答える。` : `${requests.map((r) => r.name).join('、')} の CIDR をこの順に答える。`}`;
    q.table = { headers: ['区画', '既存の割り当て', '新規の必要台数'], rows: [...ex.map((e) => [e.name, cidr(e.net, e.p), '—']), ...requests.map((r) => [r.name, '—', `${fmt(r.hosts)} 台`])] };
    q.fields = placed.map((r, i) => field(`new${i + 1}`, `${r.name}(${fmt(r.hosts)} 台)の CIDR`, 'ipv4cidr', cidr(r.net, r.p)));
    const used = ex.map((e) => ({ net: e.net, size: e.size, name: e.name }));
    const steps = placed.map((r) => {
      const blockers = [];
      for (let pos = alignUp(parent.net, r.size); pos < r.net; pos += r.size) {
        const hit = used.find((u) => overlaps(u, { net: pos, size: r.size }));
        if (hit && !blockers.includes(hit.name)) blockers.push(hit.name);
      }
      used.push({ net: r.net, size: r.size, name: r.name });
      return `${r.name} ${fmt(r.hosts)} 台 → ${fmt(r.hosts + 2)} → /${r.p}(${fmt(r.size)} 整列)。${fmt(r.size)} の倍数の位置を先頭から見ると${blockers.length ? ` ${blockers.join('・')} と重なる位置を飛ばして` : ''} ${toIp(r.net)} が最初に空いている → ${cidr(r.net, r.p)}`;
    });
    q.explanation = `${steps.join('。')}。空きの先頭アドレスをそのまま使うのではなく、自分のブロックの大きさに整列した位置で、既存と重ならないところを探す。`;
    q.defenseNote = `${DEFENSE}既存の区画の間に新しい区画を差し込むと集約が崩れやすい。追加分は末尾側にまとめるか、将来の追加ぶんを隣に空けておく。`;
    return q;
  },
  30(params) {
    const { parent, regions, links, form } = params;
    const linkRegions = Array.from({ length: links }, (_, i) => ({ name: `リンク ${i + 1}`, hosts: 2, link: true }));
    const all = [...regions, ...linkRegions];
    const { sorted, end } = placeDescending(parent.net, all);
    const total = end - parent.net;
    const free = freeCidrs(end, parent.net + parent.size);
    const q = baseQuestion(form === 'plan' ? 'vlsm-total-plan' : 'vlsm-total-free', params);
    const intro = `親ネットワーク ${cidr(parent.net, parent.p)}(${fmt(parent.size)} アドレス)に、下の LAN ${regions.length} 区画とルータ間の点対点リンク ${links} 本を置く。\n${RULE}\nリンクは両端のルータ 2 台なので /30 を使う(/31 は使わない)。リンクも LAN と同じ列に並べ、ブロックの大きい順なのでリンクは LAN のあとに来る。`;
    q.table = { headers: ['区画', '必要台数'], rows: all.map((r) => [r.name, r.link ? '2 台(ルータ 2 台)' : `${fmt(r.hosts)} 台`]) };
    q.compare = 'set';
    const lanSteps = sizeSteps(sorted.filter((r) => !r.link));
    if (form === 'plan') {
      q.text = `${intro}\nLAN とリンクをすべて含む全区画の CIDR を、ブロックの大きい方から順に答える。`;
      q.fields = sorted.map((r, i) => field(`c${i + 1}`, rankLabel(sorted, i), 'ipv4cidr', cidr(r.net, r.p)));
      q.explanation = `${lanSteps}、リンクは 2 + 2 = 4 → /30。合計 ${totalLine(sorted, parent.size)}。先頭から ${sorted.map((r) => `${r.name} ${cidr(r.net, r.p)}`).join('、')}。残りは ${fmt(parent.size - total)} アドレス。`;
    } else {
      q.text = `${intro}\n配置のあと親に残る未使用の領域を、最も少ない個数の CIDR ブロック(${free.length} 個)で答える。先頭側のブロックから順に。`;
      q.fields = free.map((f, i) => field(`free${i + 1}`, `未使用ブロック 先頭から ${i + 1} 番目`, 'ipv4cidr', cidr(f.net, f.p)));
      q.explanation = `${lanSteps}、リンクは 2 + 2 = 4 → /30 が ${links} 本。合計 ${totalLine(sorted, parent.size)}。先頭から ${sorted.map((r) => `${r.name} ${cidr(r.net, r.p)}`).join('、')} で ${toIp(end - 1)} まで使う。残り ${toIp(end)}〜${toIp(parent.net + parent.size - 1)}(${fmt(parent.size - total)})は ${free.map((f) => `${cidr(f.net, f.p)}(${fmt(f.size)})`).join('、')} の ${free.length} 個。`;
    }
    q.defenseNote = `${DEFENSE}リンクの /30 を LAN の後ろにまとめて置くと、ルータ間アドレスの範囲を 1 つの集約で表せて、監視や ACL の対象を絞りやすい。`;
    return q;
  },
};
// Lv22・23 共通: 全区画の CIDR(set)
function cidrQuestion(type, params) {
  const { parent, regions } = params;
  const { sorted, end } = placeDescending(parent.net, regions);
  const q = baseQuestion(type, params);
  q.text = `親ネットワーク ${cidr(parent.net, parent.p)}(${fmt(parent.size)} アドレス)を、下の ${regions.length} 区画に分ける。\n${RULE}\n各区画のネットワークアドレスを CIDR 表記で、ブロックの大きい方から順に答える。`;
  q.table = regionTable(regions);
  q.compare = 'set';
  q.fields = sorted.map((r, i) => field(`c${i + 1}`, rankLabel(sorted, i), 'ipv4cidr', cidr(r.net, r.p)));
  const ties = sorted.filter((r, i) => i > 0 && r.size === sorted[i - 1].size);
  q.explanation = `${sizeSteps(sorted)}。合計 ${totalLine(sorted, parent.size)}。先頭 ${toIp(parent.net)} から順に ${sorted.map((r) => `${r.name} ${cidr(r.net, r.p)}`).join('、')}。各区画の先頭は前の区画のブロードキャストの次(${toIp(end - 1)} まで使う)。${ties.length ? '同じ大きさの区画(' + sorted.filter((r) => ties.some((t) => t.size === r.size)).map((r) => r.name).join('・') + ')は順番を入れ替えてもよい。' : ''}+2 を忘れたり 2 の冪への切り上げを忘れると、以降の区画がすべてずれる。`;
  q.defenseNote = `${DEFENSE}この並びなら ${sorted[0].name} と ${sorted[1].name} は ${cidr(summaryOf(sorted[0], sorted[1]).net, summaryOf(sorted[0], sorted[1]).p)} の 1 行で表せる。`;
  return q;
}

// ---------- 公開 ----------
function build(level, params) {
  const f = BUILD[level];
  if (!f) throw new Error(`vlsm.js はレベル ${level} を持たない`);
  return f(params);
}
// opts: 新しい番号の口(cl/levels-legacy.js)が型を 1 つに決めるときだけ渡す(30: form)。渡さなければ今までどおり
function make(level, node, rng, opts = {}) {
  const lv = Math.max(RANGE[0], Math.min(RANGE[1], level));
  const params = DRAW[lv](rng, node, opts);
  const q = build(lv, params);
  return { ...q, level: lv, seed: rng.seed, generatorVersion: VERSION };
}

module.exports = { make, build, RANGE, VERSION, blockFor, placeDescending, placeInOrder, freeCidrs, summaryOf, placeIntoGaps, contains, parseIp, DRAW };
