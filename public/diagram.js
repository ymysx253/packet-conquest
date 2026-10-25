'use strict';
// 構成図(2026-10-25。docs/questions/SIM-API.md 第 5 章、DIAGRAM-CONFIG.md 3.2・3.3)。
// サーバーから受け取った図(w・h・nodes・links・groups・tables)を SVG で描き、タップを受ける。画像ファイルは使わない。
//   PCDiagram.render(container, diagram, { mode, selected, onChange, disabled, tables }) → 操作の口 { selected(), set(ids), setDisabled(b), mark(ids), el }
//     mode: 'one'(機器を 1 つ)| 'many'(いくつか)| 'order'(通る順。番号が付く)| 'port'(ポートを 1 つ)| 'link'(線を 1 つ)| 'view'(タップしない。表を見るだけ)
//     onChange(ids): 選びが変わるたびに呼ぶ。ids は port なら '<nodeId>:<port>'、link なら線の id
//   PCDiagram.toggleSelect(mode, selected, id) → 新しい selected(純粋な関数。テスト用)
// 色は style.css の CSS 変数(.dg の中のクラスで付ける)。色だけに頼らず、線の種類(実線・点線・太線)と形でも区別する。
// タップの当たりは記号より広い透明の形(viewBox 1000 幅でスマホ 320 px でも 44 px 以上になるよう 140 単位)。
// 読み上げ・キーボード用に、図と同じ中身の一覧(ボタン)を <details> で出す。正解は持たない(判定はサーバー)。
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HIT_R = 70;      // 機器の当たりの半径(viewBox の単位)
  const PORT_HIT_R = 30; // ポートの当たりの半径(機器の中心(半径 70 の当たり)を押したときは機器のポートの一覧が出るので、こちらは小さめ)
  const KIND_LABEL = { router: 'ルーター', switch: 'スイッチ', l3switch: 'L3 スイッチ', host: 'PC', server: 'サーバー', firewall: 'ファイアウォール', internet: '外の網', 'cloud-subnet': 'サブネット', cloud: 'クラウド', ap: '無線 AP' };

  // 選びの決まり(純粋な関数): one/port/link は 1 つだけ(選び直し可)、many は反転、order は押した順(もう一度押すと外れる)
  function toggleSelect(mode, selected, id) {
    const cur = Array.isArray(selected) ? selected.slice() : [];
    if (mode === 'view' || !id) return cur;
    if (mode === 'many' || mode === 'order') { const i = cur.indexOf(id); if (i >= 0) cur.splice(i, 1); else cur.push(id); return cur; }
    return cur.length === 1 && cur[0] === id ? [] : [id];
  }
  const selectableKind = (mode) => (mode === 'port' ? 'port' : mode === 'link' ? 'link' : mode === 'view' ? null : 'node');

  function el(name, attrs = {}, children = []) {
    const e = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
    for (const c of children) e.append(c);
    return e;
  }
  function html(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  // 機器の記号(中心 0,0)。種類ごとに簡単な形。全部 .dg-shape(塗りは surface・線は ink)
  function icon(kind) {
    const g = el('g', { class: `dg-icon dg-${kind}` });
    const shape = (n, a) => g.append(el(n, { class: 'dg-shape', ...a }));
    const stroke = (n, a) => g.append(el(n, { class: 'dg-mark', ...a }));
    if (kind === 'router') {
      shape('circle', { r: 26 });
      stroke('path', { d: 'M-14 -6 H10 M4 -12 L10 -6 L4 0 M14 6 H-10 M-4 0 L-10 6 L-4 12' });
    } else if (kind === 'switch' || kind === 'l3switch') {
      shape('rect', { x: -32, y: -17, width: 64, height: 34, rx: 5 });
      stroke('path', { d: 'M-22 -6 H18 M12 -12 L18 -6 L12 0 M22 6 H-18 M-12 0 L-18 6 L-12 12' });
      if (kind === 'l3switch') { shape('circle', { cx: 26, cy: -14, r: 10 }); stroke('path', { d: 'M22 -14 H30 M26 -18 V-10' }); }
    } else if (kind === 'host') {
      shape('rect', { x: -22, y: -20, width: 44, height: 30, rx: 3 });
      stroke('path', { d: 'M0 10 V18 M-12 18 H12' });
    } else if (kind === 'server') {
      shape('rect', { x: -16, y: -24, width: 32, height: 48, rx: 3 });
      stroke('path', { d: 'M-10 -12 H10 M-10 0 H10 M-10 12 H4' });
    } else if (kind === 'firewall') {
      shape('rect', { x: -28, y: -18, width: 56, height: 36, rx: 3 });
      stroke('path', { d: 'M-28 -6 H28 M-28 6 H28 M-10 -18 V-6 M10 -18 V-6 M0 -6 V6 M-18 -6 V6 M18 -6 V6 M-10 6 V18 M10 6 V18' });
    } else if (kind === 'internet' || kind === 'cloud' || kind === 'cloud-subnet') {
      shape('path', { d: 'M-30 14 a14 14 0 0 1 2 -27 a18 18 0 0 1 34 -6 a14 14 0 0 1 22 12 a12 12 0 0 1 -2 21 z' });
      if (kind === 'cloud-subnet') stroke('rect', { x: -14, y: -4, width: 28, height: 12, rx: 2 });
    } else if (kind === 'ap') {
      shape('circle', { r: 20 });
      stroke('path', { d: 'M-10 -2 a14 14 0 0 1 20 0 M-5 3 a7 7 0 0 1 10 0 M0 8 v1' });
    } else {
      shape('rect', { x: -24, y: -18, width: 48, height: 36, rx: 6 });
    }
    return g;
  }

  function render(container, diagram, opts = {}) {
    if (!container) return null;
    const d = diagram || {};
    const W = Number(d.w) || 1000, H = Number(d.h) || 600;
    const mode = opts.mode || 'view';
    const nodes = Array.isArray(d.nodes) ? d.nodes : [];
    const links = Array.isArray(d.links) ? d.links : [];
    const groups = Array.isArray(d.groups) ? d.groups : [];
    const tables = opts.tables || d.tables || {};
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const state = { selected: Array.isArray(opts.selected) ? opts.selected.slice() : [], disabled: !!opts.disabled, marked: [], openTable: null, portPick: null };

    container.replaceChildren();
    container.classList.add('dg');
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: `dg-svg dg-mode-${mode}`, role: 'img', 'aria-label': `構成図(機器 ${nodes.length}、線 ${links.length})`, focusable: 'false' });
    const gGroups = el('g', { class: 'dg-groups' }), gLinks = el('g', { class: 'dg-links' }), gNodes = el('g', { class: 'dg-nodes' }), gPorts = el('g', { class: 'dg-ports' }), gBadges = el('g', { class: 'dg-badges' });
    svg.append(gGroups, gLinks, gNodes, gPorts, gBadges);

    // ---- 文字の置き場所(重ならないように)。先に機器の名前・note・ポートの文字の箱を集め、線のラベルはその箱を避けて置く ----
    const boxes = []; // { x0, y0, x1, y1 }
    const textW = (s, size) => [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? size * 1.05 : size * 0.7), 0); // 文字の幅の見積もり(少し広め)
    const boxOf = (x, y, text, size, anchor) => { const w = textW(text, size), h = size * 1.25; const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2; return { x0: x0 - 4, y0: y - h * 0.8, x1: x0 + w + 4, y1: y + h * 0.3 }; };
    const overlaps = (b) => boxes.some((o) => !(b.x1 < o.x0 || o.x1 < b.x0 || b.y1 < o.y0 || o.y1 < b.y0));
    const place = (x, y, text, size, anchor) => { const b = boxOf(x, y, text, size, anchor); boxes.push(b); return b; };
    const FS = { name: 16, note: 13, port: 13, link: 13 }; // viewBox 1000 幅のときの文字の大きさ(スマホでも読めるように大きめ)
    // 図の重心(文字は図の外側へ出す向きを優先する)
    const cx = nodes.length ? nodes.reduce((a, n) => a + n.x, 0) / nodes.length : W / 2, cy = nodes.length ? nodes.reduce((a, n) => a + n.y, 0) / nodes.length : H / 2;
    const outward = (x, y, vx, vy) => (x - cx) * vx + (y - cy) * vy; // 正なら外向き
    // 線そのものの箱(線の上に文字を置かないため。12 単位ごとの小さな箱)
    const lineBoxes = [];
    const lineHits = (b) => lineBoxes.some((o) => !(b.x1 < o.x0 || o.x1 < b.x0 || b.y1 < o.y0 || o.y1 < b.y0));
    const endOf = (e) => { const n = byId.get(e && e.node); if (!n) return null; const p = e.port && (n.ports || []).find((x) => x.name === e.port); return p ? { x: p.x, y: p.y, n } : { x: n.x, y: n.y, n }; };
    // ポートにつながる線の向き(ラベルを線と直角にずらすため)
    const linkDirOf = (n, p) => {
      const l = links.find((x) => (x.a && x.a.node === n.id && x.a.port === p.name) || (x.b && x.b.node === n.id && x.b.port === p.name));
      let fx, fy;
      if (l) { const other = l.a.node === n.id && l.a.port === p.name ? endOf(l.b) : endOf(l.a); if (other) { fx = other.x - p.x; fy = other.y - p.y; } }
      if (fx === undefined || (!fx && !fy)) { fx = p.x - n.x; fy = p.y - n.y; }
      const len = Math.hypot(fx, fy) || 1; return { x: fx / len, y: fy / len };
    };
    for (const l of links) { const a = endOf(l.a), b = endOf(l.b); if (!a || !b) continue; const len = Math.hypot(b.x - a.x, b.y - a.y) || 1; for (let s = 0; s <= len; s += 12) { const x = a.x + (b.x - a.x) * s / len, y = a.y + (b.y - a.y) * s / len; lineBoxes.push({ x0: x - 5, y0: y - 5, x1: x + 5, y1: y + 5 }); } }
    // 機器の記号の箱と、名前・note(1 行ずつ縦に。「a / b」は分ける)
    const nodeLabels = new Map();
    for (const n of nodes) {
      boxes.push({ x0: n.x - 34, y0: n.y - 28, x1: n.x + 34, y1: n.y + 28 });
      // 真下にポートがある機器(線が下へ出る)は、名前と note を記号の上に置く
      const noteLines = String(n.note || '').split(/\s*\/\s+|\n/).map((s) => s.trim()).filter(Boolean);
      const above = (n.ports || []).some((p) => p.y - n.y > 20 && Math.abs(p.x - n.x) < 16);
      const base = Math.max(14, n.y - 38 - noteLines.length * 17); // 上に置くとき、図の上端からはみ出さない所まで
      const name = { x: n.x, y: above ? base : n.y + 47, text: n.name || '', size: FS.name, anchor: 'middle' };
      place(name.x, name.y, name.text, name.size, name.anchor);
      const notes = noteLines.map((text, i) => { const y = above ? base + 17 * (i + 1) + 4 : n.y + 65 + i * 17; place(n.x, y, text, FS.note, 'middle'); return { x: n.x, y, text }; });
      nodeLabels.set(n.id, { name, notes, above });
    }
    // ポートの名前と note(IF のアドレス): 丸から線と直角の向きに離し、文字は線に沿って機器から離れる向きに流す。
    // 上側を先に試し(線のラベルは下側を先にするので、ぶつかりにくい)、重なれば反対側・さらに外・線に沿って少し先、の順
    const portLabels = new Map();
    for (const n of nodes) for (const p of n.ports || []) {
      const pid = p.id || `${n.id}:${p.name}`;
      const d = linkDirOf(n, p); // 機器から離れる向き
      let px = -d.y, py = d.x; // 直角
      const ow = outward(p.x, p.y, px, py);
      if (Math.abs(ow) > 8 ? ow < 0 : py > 0) { px = -px; py = -py; } // 図の外側を先に(どちらでもなければ上側)
      const lines = [p.name, p.note].filter(Boolean);
      const horiz = Math.abs(d.x) > 0.5; // 横向きの線: 文字は線に沿って外へ流す(左のポートなら左へ)
      const anchor = horiz ? (d.x > 0 ? 'start' : 'end') : (px > 0.3 ? 'start' : px < -0.3 ? 'end' : 'middle');
      const tryAt = (sx, sy, off, along) => {
        const x = p.x + sx * off + d.x * along + (horiz ? d.x * 6 : 0), y = p.y + sy * off + d.y * along + (sy > 0.3 ? 11 : sy < -0.3 ? -2 : 5);
        const bs = lines.map((t, i) => boxOf(x, y + i * 15, t, FS.port, anchor));
        return { x, y, anchor, boxes: bs, bad: bs.some((b) => overlaps(b) || lineHits(b)) };
      };
      const cands = [tryAt(px, py, 16, 0), tryAt(-px, -py, 16, 0), tryAt(px, py, 32, 0), tryAt(-px, -py, 32, 0), tryAt(px, py, 16, 34), tryAt(-px, -py, 16, 34), tryAt(px, py, 48, 0), tryAt(-px, -py, 48, 0)];
      const pick = cands.find((c) => !c.bad) || cands[0];
      pick.boxes.forEach((b) => boxes.push(b));
      portLabels.set(pid, { ...pick, lines });
    }
    // 線のラベル: 中点から線と直角に離す(下側を先に)。重なれば反対側、少し先、と順に試す
    const linkLabels = new Map();
    for (const l of links) {
      if (!l.label) continue;
      const a = endOf(l.a), b = endOf(l.b); if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1; const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      let px = -uy, py = ux; { const ow = outward(mx, my, px, py); if (Math.abs(ow) > 8 ? ow < 0 : py < 0) { px = -px; py = -py; } } // 図の外側を先に(どちらでもなければ下側)
      const cands = [[0, 16], [0, -16], [0.22, 16], [-0.22, 16], [0.22, -16], [-0.22, -16], [0, 36], [0, -36], [0.3, 36], [-0.3, 36], [0.3, -36], [-0.3, -36], [0, 56], [0, -56]];
      let pick = null;
      for (const [t, off] of cands) {
        const x = mx + ux * len * t + px * off, y = my + uy * len * t + py * off + (py * off > 0 ? 11 : py * off < 0 ? -2 : 5);
        const bx = boxOf(x, y, l.label, FS.link, 'middle');
        if (!overlaps(bx) && !lineHits(bx)) { pick = { x, y, box: bx }; break; }
        if (!pick) pick = { x, y, box: bx };
      }
      boxes.push(pick.box);
      linkLabels.set(l.id, pick);
    }

    // 囲み(VLAN・拠点): 中の機器の名前・note の下まで入れる
    for (const g of groups) {
      const ms = (g.nodes || []).map((id) => byId.get(id)).filter(Boolean);
      if (!ms.length) continue;
      const xs = ms.map((n) => n.x), ys = ms.map((n) => n.y);
      const bottom = Math.max(...ms.map((n) => { const lab = nodeLabels.get(n.id); return lab.above ? n.y + 40 : lab.notes.length ? lab.notes[lab.notes.length - 1].y + 10 : n.y + 56; }));
      const top = Math.min(...ms.map((n) => { const lab = nodeLabels.get(n.id); return lab.above ? lab.name.y - 20 : n.y - 40; }));
      const x0 = Math.min(...xs) - 70, y0 = top - 20, x1 = Math.max(...xs) + 70, y1 = bottom + 6;
      gGroups.append(el('rect', { class: 'dg-group', x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 14 }));
      gGroups.append(el('text', { class: 'dg-group-label', x: x0 + 10, y: y0 + 20 }, [document.createTextNode(g.label || '')]));
    }
    // 線
    const linkEls = new Map();
    for (const l of links) {
      const a = endOf(l.a), b = endOf(l.b); if (!a || !b) continue;
      const g = el('g', { class: `dg-link dg-link-${l.style || 'solid'}`, 'data-link': l.id });
      g.append(el('line', { class: 'dg-link-line', x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
      if (mode === 'link') g.append(el('line', { class: 'dg-hit', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'data-sel': l.id, 'data-kind': 'link' }));
      const lab = linkLabels.get(l.id);
      if (lab) g.append(el('text', { class: 'dg-link-label', x: lab.x, y: lab.y, 'text-anchor': 'middle' }, [document.createTextNode(l.label)]));
      gLinks.append(g); linkEls.set(l.id, g);
    }
    // 機器
    const nodeEls = new Map();
    for (const n of nodes) {
      const g = el('g', { class: `dg-node dg-kind-${n.kind || 'other'}`, transform: `translate(${n.x} ${n.y})`, 'data-node': n.id });
      g.append(el('circle', { class: 'dg-halo', r: 44 }));
      g.append(icon(n.kind));
      const lab = nodeLabels.get(n.id);
      g.append(el('text', { class: 'dg-name', y: lab.name.y - n.y, 'text-anchor': 'middle' }, [document.createTextNode(n.name || '')]));
      for (const t of lab.notes) g.append(el('text', { class: 'dg-note', y: t.y - n.y, 'text-anchor': 'middle' }, [document.createTextNode(t.text)]));
      const hit = el('circle', { class: 'dg-hit', r: HIT_R, 'data-sel': n.id, 'data-kind': 'node' });
      g.append(hit);
      gNodes.append(g); nodeEls.set(n.id, g);
      for (const p of n.ports || []) {
        const pid = p.id || `${n.id}:${p.name}`;
        const pg = el('g', { class: 'dg-port', 'data-port': pid });
        pg.append(el('circle', { class: 'dg-port-dot', cx: p.x, cy: p.y, r: 8 }));
        const lab2 = portLabels.get(pid);
        lab2.lines.forEach((t, i) => pg.append(el('text', { class: i === 0 ? 'dg-port-name' : 'dg-port-note', x: lab2.x, y: lab2.y + i * 15, 'text-anchor': lab2.anchor }, [document.createTextNode(t)])));
        if (mode === 'port') pg.append(el('circle', { class: 'dg-hit', cx: p.x, cy: p.y, r: PORT_HIT_R, 'data-sel': pid, 'data-kind': 'port' }));
        gPorts.append(pg);
      }
    }

    // 図の下: 選んだものの印と「表を見る」とポートの小窓と一覧
    const bar = html('div', 'dg-bar');
    const status = html('span', 'dg-status');
    bar.append(status);
    const tableBtns = html('div', 'dg-tables-bar');
    const tableBox = html('div', 'dg-table-box'); tableBox.hidden = true;
    const portPick = html('div', 'dg-portpick'); portPick.hidden = true;
    const list = document.createElement('details'); list.className = 'dg-list';
    const sum = html('summary', null, '図の一覧(読み上げ・キーボード用)'); list.append(sum);
    const ul = html('ul'); list.append(ul);
    const scroll = html('div', 'dg-scroll'); scroll.append(svg); // 狭い画面では横にスクロールして大きさを保つ(記号が小さくなりすぎないように)
    container.append(scroll, bar, portPick, tableBtns, tableBox, list);

    const nameOf = (id) => {
      if (byId.has(id)) return byId.get(id).name;
      const i = id.indexOf(':'); if (i > 0 && byId.has(id.slice(0, i))) return `${byId.get(id.slice(0, i)).name} の ${id.slice(i + 1)}`;
      const l = links.find((x) => x.id === id); if (l) { const a = byId.get(l.a.node), b = byId.get(l.b.node); return `${a ? a.name : '?'} と ${b ? b.name : '?'} の間の線`; }
      return id;
    };
    function makeTable(t) {
      const tbl = html('table', 'qtable');
      if (t.title) tbl.append(html('caption', null, t.title));
      const thead = html('thead'), tr = html('tr'); (t.headers || []).forEach((h) => tr.append(html('th', null, h))); thead.append(tr);
      const tbody = html('tbody'); (t.rows || []).forEach((r) => { const row = html('tr'); r.forEach((c) => row.append(html('td', null, c))); tbody.append(row); });
      tbl.append(thead, tbody); return tbl;
    }
    function showTable(nodeId) {
      const ts = tables[nodeId];
      if (!ts || !ts.length || state.openTable === nodeId) { state.openTable = null; tableBox.hidden = true; tableBox.replaceChildren(); return; }
      state.openTable = nodeId;
      tableBox.replaceChildren(html('p', 'dg-table-title', `${nameOf(nodeId)} の表`), ...ts.map(makeTable));
      tableBox.hidden = false;
      refreshTableBtns();
    }
    function refreshTableBtns() {
      tableBtns.replaceChildren();
      const ids = nodes.map((n) => n.id).filter((id) => Array.isArray(tables[id]) && tables[id].length);
      if (!ids.length) return;
      tableBtns.append(html('span', 'dg-tables-label', '表を見る:'));
      for (const id of ids) {
        const b = html('button', 'btn small' + (state.openTable === id ? ' on' : ''), nameOf(id));
        b.type = 'button'; b.setAttribute('aria-pressed', String(state.openTable === id));
        b.onclick = () => showTable(id);
        tableBtns.append(b);
      }
    }
    function showPortPick(nodeId) { // port のとき機器を押したら、そのポートを大きなボタンで選べる小窓
      const n = byId.get(nodeId);
      if (!n || !(n.ports || []).length || state.portPick === nodeId) { state.portPick = null; portPick.hidden = true; portPick.replaceChildren(); return; }
      state.portPick = nodeId;
      portPick.replaceChildren(html('span', 'dg-portpick-label', `${n.name} のポート:`));
      for (const p of n.ports) {
        const pid = p.id || `${n.id}:${p.name}`;
        const b = html('button', 'btn small', p.name); b.type = 'button';
        b.onclick = () => select(pid);
        portPick.append(b);
      }
      portPick.hidden = false;
    }
    function badge(x, y, text, cls) {
      const g = el('g', { class: `dg-badge ${cls || ''}`, transform: `translate(${x} ${y})` });
      g.append(el('circle', { r: 14 }));
      g.append(el('text', { 'text-anchor': 'middle', dy: 5 }, [document.createTextNode(text)]));
      return g;
    }
    const posOf = (id) => {
      const n = byId.get(id); if (n) return { x: n.x + 30, y: n.y - 30 };
      const i = id.indexOf(':'); if (i > 0) { const nn = byId.get(id.slice(0, i)); const p = nn && (nn.ports || []).find((x) => x.name === id.slice(i + 1)); if (p) return { x: p.x + 14, y: p.y - 14 }; }
      const l = links.find((x) => x.id === id); if (l) { const a = endOf(l.a), b = endOf(l.b); if (a && b) return { x: (a.x + b.x) / 2 + 16, y: (a.y + b.y) / 2 + 14 }; }
      return null;
    };
    function refresh() {
      svg.classList.toggle('dg-disabled', state.disabled);
      for (const [id, g] of nodeEls) { g.classList.toggle('sel', state.selected.includes(id)); g.classList.toggle('mark', state.marked.includes(id)); }
      for (const [id, g] of linkEls) { g.classList.toggle('sel', state.selected.includes(id)); g.classList.toggle('mark', state.marked.includes(id)); }
      for (const pg of gPorts.querySelectorAll('.dg-port')) { const id = pg.getAttribute('data-port'); pg.classList.toggle('sel', state.selected.includes(id)); pg.classList.toggle('mark', state.marked.includes(id)); }
      gBadges.replaceChildren();
      if (mode === 'order') state.selected.forEach((id, i) => { const p = posOf(id); if (p) gBadges.append(badge(p.x, p.y, String(i + 1), 'sel')); });
      else if (mode !== 'view') state.selected.forEach((id) => { const p = posOf(id); if (p) gBadges.append(badge(p.x, p.y, '✓', 'sel')); });
      state.marked.forEach((id) => { const p = posOf(id); if (p) gBadges.append(badge(p.x - 32, p.y, '○', 'mark')); });
      status.textContent = mode === 'view' ? '' : state.selected.length ? `選んだもの: ${state.selected.map((id, i) => (mode === 'order' ? `${i + 1}. ` : '') + nameOf(id)).join('、')}` : ({ one: '機器を 1 つタップ', many: '当てはまる機器を全部タップ', order: '通る順にタップ(押した順に番号が付く)', port: 'ポートの丸をタップ(機器を押すとポートの一覧が出る)', link: '線をタップ' }[mode] || '');
      for (const b of ul.querySelectorAll('button[data-sel]')) { const on = state.selected.includes(b.dataset.sel); b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); b.disabled = state.disabled; }
    }
    function select(id) {
      if (state.disabled || mode === 'view') return;
      state.selected = toggleSelect(mode, state.selected, id);
      refresh();
      if (opts.onChange) opts.onChange(state.selected.slice());
    }
    function onTap(target) {
      const hit = target.closest ? target.closest('[data-sel]') : null;
      if (hit) {
        const id = hit.getAttribute('data-sel'), kind = hit.getAttribute('data-kind');
        if (mode === 'view') { if (kind === 'node') showTable(id); return; }
        if (mode === 'port' && kind === 'node') { showPortPick(id); return; }
        if (mode === 'link' && kind === 'node') return;
        if (selectableKind(mode) === kind) select(id);
        return;
      }
      const nodeG = target.closest ? target.closest('[data-node]') : null;
      if (nodeG && mode === 'view') showTable(nodeG.getAttribute('data-node'));
    }
    svg.addEventListener('click', (e) => onTap(e.target));

    // 一覧(読み上げ・キーボード)
    const selKind = selectableKind(mode);
    for (const n of nodes) {
      const li = html('li');
      const label = `${n.name}(${KIND_LABEL[n.kind] || n.kind || '機器'}${n.note ? `、${n.note}` : ''})`;
      if (selKind === 'node') { const b = html('button', 'dg-list-btn', label); b.type = 'button'; b.dataset.sel = n.id; b.setAttribute('aria-pressed', 'false'); b.onclick = () => select(n.id); li.append(b); }
      else li.append(document.createTextNode(label));
      if (Array.isArray(tables[n.id]) && tables[n.id].length) { const tb = html('button', 'btn small', '表を見る'); tb.type = 'button'; tb.onclick = () => showTable(n.id); li.append(' ', tb); }
      if (selKind === 'port' && (n.ports || []).length) {
        const sub = html('ul');
        for (const p of n.ports) { const pid = p.id || `${n.id}:${p.name}`; const b = html('button', 'dg-list-btn', `ポート ${p.name}`); b.type = 'button'; b.dataset.sel = pid; b.setAttribute('aria-pressed', 'false'); b.onclick = () => select(pid); const pli = html('li'); pli.append(b); sub.append(pli); }
        li.append(sub);
      }
      ul.append(li);
    }
    for (const l of links) {
      const a = byId.get(l.a && l.a.node), b = byId.get(l.b && l.b.node); if (!a || !b) continue;
      const li = html('li');
      const label = `線: ${a.name}${l.a.port ? ` ${l.a.port}` : ''} — ${b.name}${l.b.port ? ` ${l.b.port}` : ''}${l.label ? `(${l.label})` : ''}`;
      if (selKind === 'link') { const btn = html('button', 'dg-list-btn', label); btn.type = 'button'; btn.dataset.sel = l.id; btn.setAttribute('aria-pressed', 'false'); btn.onclick = () => select(l.id); li.append(btn); }
      else li.append(document.createTextNode(label));
      ul.append(li);
    }
    refreshTableBtns();
    refresh();

    const api = {
      el: container,
      selected: () => state.selected.slice(),
      set(ids) { state.selected = Array.isArray(ids) ? ids.slice() : []; refresh(); },
      setDisabled(b) { state.disabled = !!b; refresh(); },
      mark(ids) { state.marked = Array.isArray(ids) ? ids.slice() : []; refresh(); }, // 答えたあとに正解の印(サーバーが送ってきたときだけ)
    };
    return api;
  }

  const api = { render, toggleSelect, selectableKind, KIND_LABEL, HIT_R, PORT_HIT_R };
  if (typeof window !== 'undefined') window.PCDiagram = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
