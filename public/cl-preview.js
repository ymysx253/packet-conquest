'use strict';
// 新しい番号の問題の見本のページ(cl-preview.html。2026-10-22)。サーバーの口は server/cl-preview.js(CL_PREVIEW=1 のときだけ開く)。
// レベルと seed をサーバーに頼み、ゲームと同じダイアログ(qdialog.js)で出す。答えはサーバーへ送り、判定もサーバー(画面は正解を持たない)
// 2026-10-25: 構成図のタップ(`{ qid, ids }`)・設定(`{ qid, configs }`)・模擬ターミナルの 1 行(`POST /cl-preview/term { qid, line }` → `{ out, device }`)に対応。
//   画面だけの見本(サーバーが無くても描ける。開発中の確かめ用): `?demo=tap-one|tap-many|tap-order|tap-port|tap-link|config|terminal`。
//   見本は固定の図と設定の欄を描くだけで、答えは判定しない(「送る形」を見せる)
(() => {
  const $ = (id) => document.getElementById(id);
  const PCQ = window.PCQuestion;
  const S = { question: null, result: null, chosen: null, demo: null };

  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (res) => { const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || `エラー(${res.status})`); return j; });
  const showError = (m) => { $('pvError').textContent = m || ''; $('pvDlgError').textContent = m || ''; }; // ダイアログが開いていれば、その中にも出す

  // ---------- 画面だけの見本(固定の図) ----------
  const DEMO_DIAGRAM = {
    w: 1000, h: 520,
    nodes: [
      { id: 'n-pc1', name: 'PC1', kind: 'host', x: 110, y: 260, note: '10.1.1.10/24' },
      { id: 'n-sw1', name: 'SW1', kind: 'switch', x: 300, y: 260, ports: [{ name: 'Gi1/0/1', x: 258, y: 260 }, { name: 'Gi1/0/24', x: 342, y: 260 }] },
      { id: 'n-r1', name: 'R1', kind: 'router', x: 500, y: 260, note: '10.1.1.1 / 10.0.12.1', ports: [{ name: 'Gi0/0', x: 462, y: 260 }, { name: 'Gi0/1', x: 538, y: 240 }] },
      { id: 'n-r2', name: 'R2', kind: 'router', x: 700, y: 120, note: '10.0.12.2 / 10.3.3.1', ports: [{ name: 'Gi0/0', x: 662, y: 140 }, { name: 'Gi0/1', x: 738, y: 120 }] },
      { id: 'n-fw1', name: 'FW1', kind: 'firewall', x: 700, y: 400 },
      { id: 'n-srv1', name: 'SRV1', kind: 'server', x: 890, y: 120, note: '10.3.3.20/24' },
      { id: 'n-inet', name: '外の網', kind: 'internet', x: 890, y: 400 },
    ],
    links: [
      { id: 'l1', a: { node: 'n-pc1' }, b: { node: 'n-sw1', port: 'Gi1/0/1' }, label: '10.1.1.0/24' },
      { id: 'l2', a: { node: 'n-sw1', port: 'Gi1/0/24' }, b: { node: 'n-r1', port: 'Gi0/0' } },
      { id: 'l3', a: { node: 'n-r1', port: 'Gi0/1' }, b: { node: 'n-r2', port: 'Gi0/0' }, label: '10.0.12.0/30', style: 'bold' },
      { id: 'l4', a: { node: 'n-r2', port: 'Gi0/1' }, b: { node: 'n-srv1' }, label: '10.3.3.0/24' },
      { id: 'l5', a: { node: 'n-r1' }, b: { node: 'n-fw1' }, style: 'dash' },
      { id: 'l6', a: { node: 'n-fw1' }, b: { node: 'n-inet' }, style: 'dash', label: '203.0.113.0/24' },
    ],
    groups: [{ id: 'g1', label: '本社 LAN', nodes: ['n-pc1', 'n-sw1'] }],
    tables: { 'n-r1': [{ title: 'R1 の経路表', headers: ['宛先', '次の転送先', '出る IF'], rows: [['10.1.1.0/24', '直結', 'Gi0/0'], ['10.0.12.0/30', '直結', 'Gi0/1'], ['10.3.3.0/24', '10.0.12.2', 'Gi0/1']] }] },
  };

  // 型ごとの見本(serial・triangle・two-switches。文字の重なりを見るため。ポートごとのアドレスは port.note)
  const P = (name, x, y, note) => ({ name, x, y, note });
  const DEMO_SERIAL = {
    w: 1000, h: 420,
    nodes: [
      { id: 's-pc1', name: 'PC1', kind: 'host', x: 80, y: 210, note: '10.1.1.10/24' },
      { id: 's-sw1', name: 'SW1', kind: 'switch', x: 230, y: 210, ports: [P('Gi1/0/1', 190, 210), P('Gi1/0/24', 270, 210)] },
      { id: 's-r1', name: 'R1', kind: 'router', x: 400, y: 210, ports: [P('Gi0/0', 364, 210, '10.1.1.1/24'), P('Gi0/1', 436, 210, '10.0.12.1/30')] },
      { id: 's-r2', name: 'R2', kind: 'router', x: 580, y: 210, ports: [P('Gi0/0', 544, 210, '10.0.12.2/30'), P('Gi0/1', 616, 210, '10.0.23.1/30')] },
      { id: 's-r3', name: 'R3', kind: 'router', x: 760, y: 210, ports: [P('Gi0/0', 724, 210, '10.0.23.2/30'), P('Gi0/1', 796, 210, '10.3.3.1/24')] },
      { id: 's-sw2', name: 'SW2', kind: 'switch', x: 880, y: 320, ports: [P('Gi1/0/24', 848, 300)] },
      { id: 's-pc2', name: 'PC2', kind: 'host', x: 880, y: 90, note: '10.3.3.20/24' },
    ],
    links: [
      { id: 'sl1', a: { node: 's-pc1' }, b: { node: 's-sw1', port: 'Gi1/0/1' } },
      { id: 'sl2', a: { node: 's-sw1', port: 'Gi1/0/24' }, b: { node: 's-r1', port: 'Gi0/0' }, label: '10.1.1.0/24' },
      { id: 'sl3', a: { node: 's-r1', port: 'Gi0/1' }, b: { node: 's-r2', port: 'Gi0/0' }, label: '10.0.12.0/30' },
      { id: 'sl4', a: { node: 's-r2', port: 'Gi0/1' }, b: { node: 's-r3', port: 'Gi0/0' }, label: '10.0.23.0/30' },
      { id: 'sl5', a: { node: 's-r3', port: 'Gi0/1' }, b: { node: 's-sw2', port: 'Gi1/0/24' }, label: '10.3.3.0/24' },
      { id: 'sl6', a: { node: 's-sw2' }, b: { node: 's-pc2' } },
    ],
  };
  const DEMO_TRIANGLE = {
    w: 1000, h: 520,
    nodes: [
      { id: 't-pc1', name: 'PC1', kind: 'host', x: 100, y: 400, note: '10.1.1.10/24' },
      { id: 't-r1', name: 'R1', kind: 'router', x: 300, y: 400, ports: [P('Gi0/0', 264, 400, '10.1.1.1/24'), P('Gi0/1', 336, 400, '10.0.13.1/30'), P('Gi0/2', 300, 364, '10.0.12.1/30')] },
      { id: 't-r2', name: 'R2', kind: 'router', x: 500, y: 110, ports: [P('Gi0/0', 464, 110, '10.0.12.2/30'), P('Gi0/1', 536, 110, '10.0.23.1/30')] },
      { id: 't-r3', name: 'R3', kind: 'router', x: 700, y: 400, ports: [P('Gi0/0', 664, 400, '10.0.13.2/30'), P('Gi0/1', 736, 400, '10.3.3.1/24'), P('Gi0/2', 700, 364, '10.0.23.2/30')] },
      { id: 't-pc2', name: 'PC2', kind: 'host', x: 900, y: 400, note: '10.3.3.20/24' },
    ],
    links: [
      { id: 'tl1', a: { node: 't-pc1' }, b: { node: 't-r1', port: 'Gi0/0' }, label: '10.1.1.0/24' },
      { id: 'tl2', a: { node: 't-r1', port: 'Gi0/2' }, b: { node: 't-r2', port: 'Gi0/0' }, label: '10.0.12.0/30(コスト 1)' },
      { id: 'tl3', a: { node: 't-r2', port: 'Gi0/1' }, b: { node: 't-r3', port: 'Gi0/2' }, label: '10.0.23.0/30(コスト 1)' },
      { id: 'tl4', a: { node: 't-r1', port: 'Gi0/1' }, b: { node: 't-r3', port: 'Gi0/0' }, label: '10.0.13.0/30(コスト 10)', style: 'bold' },
      { id: 'tl5', a: { node: 't-r3', port: 'Gi0/1' }, b: { node: 't-pc2' }, label: '10.3.3.0/24' },
    ],
  };
  const DEMO_TWO_SWITCHES = {
    w: 1000, h: 560,
    nodes: [
      { id: 'w-pc1', name: 'PC1', kind: 'host', x: 100, y: 120, note: 'VLAN 10 / 10.1.10.11/24' },
      { id: 'w-pc2', name: 'PC2', kind: 'host', x: 100, y: 440, note: 'VLAN 20 / 10.1.20.12/24' },
      { id: 'w-sw1', name: 'SW1', kind: 'switch', x: 330, y: 280, ports: [P('Gi1/0/1', 300, 244), P('Gi1/0/2', 300, 316), P('Gi1/0/24', 372, 280)] },
      { id: 'w-sw2', name: 'SW2', kind: 'switch', x: 640, y: 280, ports: [P('Gi1/0/24', 598, 280), P('Gi1/0/1', 670, 244), P('Gi1/0/2', 670, 316), P('Gi1/0/23', 640, 244)] },
      { id: 'w-pc3', name: 'PC3', kind: 'host', x: 880, y: 120, note: 'VLAN 10 / 10.1.10.13/24' },
      { id: 'w-pc4', name: 'PC4', kind: 'host', x: 880, y: 440, note: 'VLAN 20 / 10.1.20.14/24' },
      { id: 'w-l3', name: 'L3SW1', kind: 'l3switch', x: 640, y: 80, note: 'VLAN 10: 10.1.10.1 / VLAN 20: 10.1.20.1', ports: [P('Gi1/0/1', 640, 116)] },
    ],
    links: [
      { id: 'wl1', a: { node: 'w-pc1' }, b: { node: 'w-sw1', port: 'Gi1/0/1' } },
      { id: 'wl2', a: { node: 'w-pc2' }, b: { node: 'w-sw1', port: 'Gi1/0/2' } },
      { id: 'wl3', a: { node: 'w-sw1', port: 'Gi1/0/24' }, b: { node: 'w-sw2', port: 'Gi1/0/24' }, label: 'トランク(10, 20)', style: 'bold' },
      { id: 'wl4', a: { node: 'w-sw2', port: 'Gi1/0/1' }, b: { node: 'w-pc3' } },
      { id: 'wl5', a: { node: 'w-sw2', port: 'Gi1/0/2' }, b: { node: 'w-pc4' } },
      { id: 'wl6', a: { node: 'w-sw2', port: 'Gi1/0/23' }, b: { node: 'w-l3', port: 'Gi1/0/1' }, label: 'トランク(10, 20)', style: 'bold' },
    ],
    groups: [{ id: 'wg1', label: 'VLAN 10', nodes: ['w-pc1'] }, { id: 'wg2', label: 'VLAN 20', nodes: ['w-pc2'] }],
  };
  const DEMOS = {
    'layout-serial': { title: '見本: 型 serial(R1〜R3)', text: '型の見本(serial)。PC1 のデフォルトゲートウェイをタップ。', answerKind: 'tap', tap: { mode: 'one' }, diagram: DEMO_SERIAL },
    'layout-triangle': { title: '見本: 型 triangle', text: '型の見本(triangle)。PC1 から PC2 へ通る機器を順にタップ。', answerKind: 'tap', tap: { mode: 'order' }, diagram: DEMO_TRIANGLE },
    'layout-two-switches': { title: '見本: 型 two-switches', text: '型の見本(two-switches)。PC1 と同じ VLAN の PC を全部タップ。', answerKind: 'tap', tap: { mode: 'many' }, diagram: DEMO_TWO_SWITCHES },
    'tap-one': { title: '見本: 機器を 1 つタップ', text: 'PC1 のデフォルトゲートウェイになる機器はどれか。図の機器をタップして「答える」。', answerKind: 'tap', tap: { mode: 'one' }, diagram: DEMO_DIAGRAM },
    'tap-many': { title: '見本: いくつかタップ', text: 'PC1 と同じ LAN(同じ網)にいる機器を全部タップして「答える」。', answerKind: 'tap', tap: { mode: 'many' }, diagram: DEMO_DIAGRAM },
    'tap-order': { title: '見本: 通る順にタップ', text: 'PC1 から SRV1 へのパケットが通る機器を、通る順にタップして「答える」。', answerKind: 'tap', tap: { mode: 'order' }, diagram: DEMO_DIAGRAM },
    'tap-port': { title: '見本: ポートをタップ', text: 'ACL を当てるポートをタップして「答える」(機器を押すとポートの一覧が出る)。', answerKind: 'tap', tap: { mode: 'port' }, diagram: DEMO_DIAGRAM },
    'tap-link': { title: '見本: 線をタップ', text: '切れると PC1 から SRV1 に届かなくなる線をタップして「答える」。', answerKind: 'tap', tap: { mode: 'link' }, diagram: DEMO_DIAGRAM },
    config: { title: '見本: 設定を書く', text: 'PC1 から SRV1 に往復で届くように、R1 と R2 に静的経路を書け。', answerKind: 'config', diagram: DEMO_DIAGRAM, editable: ['R1', 'R2'], configView: { R1: ['interface Gi0/0', ' ip address 10.1.1.1/24', 'interface Gi0/1', ' ip address 10.0.12.1/30'], R2: ['interface Gi0/0', ' ip address 10.0.12.2/30', 'interface Gi0/1', ' ip address 10.3.3.1/24'] }, requirementsText: [{ id: 1, text: 'PC1 から SRV1 に ping が往復で届く' }, { id: 2, text: 'R1 の経路表に 10.3.3.0/24 がある' }], terminal: { devices: ['PC1', 'R1', 'R2'], start: 'PC1' } },
    terminal: { title: '見本: 模擬ターミナルで調べて答える', text: 'PC1 で ipconfig を打ち、PC1 の IPv4 アドレスを答えよ(見本なので判定はしない)。', answerKind: 'text', fields: [{ name: 'ip', label: 'PC1 のアドレス', format: 'ipv4', hint: '例: 192.0.2.1' }], terminal: { devices: ['PC1', 'R1'], start: 'PC1' } },
  };
  // 見本のターミナル: サーバーが無いので決まった返事だけ(本物は server/sim が出力を作る)
  function demoTerm(line) {
    const [cmd, arg] = line.trim().split(/\s+/);
    if (cmd === 'connect' && arg) return { out: `=> ${arg}(見本: つないだことにする)`, device: arg };
    if (cmd === 'ipconfig' || cmd === 'ip') return 'Eth0  address 10.1.1.10/24  gateway 10.1.1.1  dns 10.1.1.53(見本)';
    if (cmd === 'ping') return `ping ${arg || ''}(見本)\n 4 回送って 4 回返事(TTL 63)`;
    if (cmd === 'help' || cmd === '?') return '使える語(見本): connect ipconfig ping traceroute arp nslookup show configure end';
    return `(見本)「${line}」はサーバーが読んで出力を作ります`;
  }
  window.PCDemo = { DEMOS, DEMO_DIAGRAM, DEMO_SERIAL, DEMO_TRIANGLE, DEMO_TWO_SWITCHES };

  async function loadLevels() {
    try {
      const res = await fetch('/cl-preview/levels');
      if (!res.ok) throw new Error('見本のページの口が開いていません(サーバーを CL_PREVIEW=1 で起動してください)');
      const { levels, samples = [] } = await res.json();
      const opt = (l, label) => { const o = document.createElement('option'); o.value = l.level; o.textContent = label; return o; };
      const g1 = document.createElement('optgroup'); g1.label = '新しい番号の問題';
      g1.append(...levels.map((l) => opt(l, `Lv${l.level} ${l.title}(${l.kind})`)));
      const g2 = document.createElement('optgroup'); g2.label = '画面の形の見本(ゲームでは出さない)';
      g2.append(...samples.map((l) => opt(l, l.title)));
      const g3 = document.createElement('optgroup'); g3.label = '画面だけの見本(図・設定・ターミナル。判定しない)';
      g3.append(...Object.entries(DEMOS).map(([k, v]) => opt({ level: `demo:${k}` }, v.title)));
      $('pvLevel').replaceChildren(...[g1, g2, g3].filter((g) => g.children.length));
      if (!levels.length) showError('新しい番号の問題はまだありません');
      const want = new URLSearchParams(location.search).get('level');
      if (want && [...levels, ...samples].some((l) => String(l.level) === want)) $('pvLevel').value = want;
    } catch (e) {
      showError(e.message);
      const g3 = document.createElement('optgroup'); g3.label = '画面だけの見本(図・設定・ターミナル。判定しない)';
      g3.append(...Object.entries(DEMOS).map(([k, v]) => { const o = document.createElement('option'); o.value = `demo:${k}`; o.textContent = v.title; return o; }));
      $('pvLevel').replaceChildren(g3);
    }
    const demo = new URLSearchParams(location.search).get('demo');
    if (demo && DEMOS[demo]) { $('pvLevel').value = `demo:${demo}`; askDemo(demo); }
  }

  function askDemo(key) {
    const d = DEMOS[key]; if (!d) return;
    showError('');
    S.demo = key;
    S.question = { t: 'question', qid: `demo-${key}-${Date.now()}`, level: `demo:${key}`, seed: 0, title: d.title, clKind: '見本', ...d, hint: null, firstStep: null, hintLocked: false, card: null };
    S.result = null; S.chosen = null;
    render();
  }
  async function ask(seedText) {
    showError('');
    const v = $('pvLevel').value;
    if (v.startsWith('demo:')) { askDemo(v.slice(5)); return; }
    S.demo = null;
    const level = /^\d+$/.test(v) ? Number(v) : v; // 形の見本は 'demo-…'
    const seed = /^\d+$/.test(seedText || '') ? Number(seedText) : undefined;
    try {
      const q = await post('/cl-preview/ask', { level, seed, hints: !$('pvOthers').checked });
      S.question = q; S.result = null; S.chosen = null;
      render();
    } catch (e) { showError(e.message); }
  }

  function render() {
    const q = S.question, d = $('qDialog');
    if (!q) { if (d.open) d.close(); return; }
    d.dataset.size = PCQ.size(q);
    if (!d.open) d.showModal();
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '見本';
    $('qMode').replaceChildren(tag, document.createTextNode(q.title || ''));
    $('qDiff').textContent = (typeof q.level === 'number' ? `新しい番号 Lv${q.level} / seed ${q.seed}` : S.demo ? '画面だけの見本(判定しない)' : '画面の形の見本') + ($('pvOthers').checked ? ' / ほかの人の拠点' : ' / 中立の拠点');
    const r = S.result && S.result.qid === q.qid ? S.result : null;
    PCQ.render(q, r, { chosen: S.chosen, onChoose: choose, onSubmit: submit, onTerm: term, onIncomplete: () => showError(q.answerKind === 'tap' ? '図の中から選んでください' : q.answerKind === 'config' ? '設定を 1 行以上書いてください(行数と長さの上限も確かめてください)' : 'すべての欄を入れてください') });
    $('qNext').hidden = !r;
  }
  async function send(body) {
    try { S.result = await post('/cl-preview/answer', body); }
    catch (e) { S.chosen = null; showError(e.message); }
    render();
  }
  function choose(i) {
    const q = S.question;
    if (!q || q.answerKind !== 'choice' && q.answerKind || S.result || S.chosen != null || i < 0 || i >= (q.options || []).length) return;
    S.chosen = i; render();
    if (S.demo) { S.result = { qid: q.qid, correct: null, explanation: `送る形: ${JSON.stringify({ qid: q.qid, choice: i })}` }; render(); return; }
    send({ qid: q.qid, choice: i });
  }
  // 入力式は inputs(文字列の配列)、図のタップは { ids }、設定は { configs }(qdialog.js が渡す形)
  function submit(payload) {
    const q = S.question;
    if (!q || S.result || S.chosen) return;
    let body;
    if (Array.isArray(payload)) { if (q.answerKind !== 'text') return; body = { qid: q.qid, inputs: payload }; S.chosen = { qid: q.qid, inputs: payload }; }
    else if (payload && Array.isArray(payload.ids)) { if (q.answerKind !== 'tap') return; body = { qid: q.qid, ids: payload.ids }; S.chosen = { qid: q.qid, ids: payload.ids }; }
    else if (payload && Array.isArray(payload.configs)) { if (q.answerKind !== 'config') return; body = { qid: q.qid, configs: payload.configs }; S.chosen = { qid: q.qid, configs: payload.configs }; }
    else return;
    render();
    if (S.demo) { S.result = { qid: q.qid, correct: null, explanation: `送る形(サーバーへ): ${JSON.stringify(body)}`, failed: body.configs ? [2] : undefined }; render(); return; }
    send(body);
  }
  // ターミナルの 1 行。サーバーが出力を作る。見本のときは決まった返事
  async function term(line) {
    const q = S.question; if (!q) return '';
    if (S.demo) return demoTerm(line);
    const r = await post('/cl-preview/term', { qid: q.qid, line });
    return { out: r.out || '', device: r.device || null };
  }

  $('pvAsk').onclick = () => ask($('seed').value.trim());
  $('qNext').onclick = () => ask(''); // 同じレベルの別の問題
  $('qClose').onclick = () => $('qDialog').close();
  $('qDialog').addEventListener('close', () => { S.question = null; S.result = null; S.chosen = null; });
  document.addEventListener('keydown', (e) => {
    if (!$('qDialog').open) return;
    const i = PCQ.keyIndex(e, S.question); if (i !== null) choose(i);
  });
  loadLevels();
})();
