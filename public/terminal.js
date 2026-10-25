'use strict';
// 設定の欄と模擬ターミナルの画面(2026-10-25。docs/questions/SIM-API.md 第 5 章・第 7 章、DIAGRAM-CONFIG.md 4.4)。
//   PCTerminal.configForm(container, { editable, configView, requirementsText, onChange, disabled }) → { values(), filled(), setDisabled(b), markFailed(ids), el }
//     機器ごとの textarea(1 台 40 行・1 行 120 字。超えたら赤く)。今の設定の抜粋(configView)は読み取り専用で上に出す。要件の文は箇条書き
//   PCTerminal.terminal(container, { devices, start, onLine, disabled, completions }) → { setDisabled(b), append(text), device(), setCompletions(words), el }
//     入力行 1 つと出力の欄。Enter で onLine(line) → Promise<文字列 | { out, device }>。↑↓ で自分の履歴、Tab で補完(コマンドの語・IF 名・機器名だけ。答えになる値は補わない)
//     1 問 60 回まで(画面でも数える)。コマンドを選ぶボタンは作らない。打った字はサーバーが読むだけ(ここでは実行しない)
//   純粋な関数(テスト用): checkConfigText(text)、complete(partial, words)、LIMITS
(() => {
  const LIMITS = { lines: 40, lineChars: 120, cmdChars: 120, cmds: 60 };
  // よく使うコマンドの語(補完の候補。値は入れない)
  const WORDS = ['connect', 'exit', 'help', 'ipconfig', 'ip', 'addr', 'route', 'ping', 'traceroute', 'tracert', 'arp', 'nslookup', 'show', 'interface', 'brief', 'access-lists', 'nat', 'translations', 'ospf', 'neighbor', 'vrrp', 'dhcp', 'binding', 'snooping', 'running-config', 'vlan', 'interfaces', 'trunk', 'mac', 'address-table', 'spanning-tree', 'etherchannel', 'summary', 'configure', 'end', 'no', 'shutdown', 'address', 'gateway', 'dns', 'switchport', 'mode', 'access', 'allowed', 'native', 'encapsulation', 'dot1q', 'routing', 'router', 'network', 'area', 'cost', 'pool', 'exclude', 'relay', 'acl', 'standard', 'extended', 'permit', 'deny', 'any', 'host', 'eq', 'tcp', 'udp', 'icmp', 'inside', 'outside', 'source', 'static', 'overload', 'priority', 'edge', 'channel-group', 'active', 'passive', 'trust', 'ipv6'];

  // 設定の文字の形だけを調べる(文法はサーバー)。行数・1 行の長さ・空でないか
  function checkConfigText(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const errors = [];
    if (lines.length > LIMITS.lines) errors.push({ line: LIMITS.lines + 1, message: `1 台の設定は ${LIMITS.lines} 行までです(今 ${lines.length} 行)` });
    lines.forEach((l, i) => { if (l.length > LIMITS.lineChars) errors.push({ line: i + 1, message: `1 行は ${LIMITS.lineChars} 字までです` }); });
    const nonEmpty = lines.filter((l) => l.trim() !== '').length;
    return { ok: errors.length === 0, lines: lines.length, nonEmpty, errors };
  }
  // 最後の語を候補から補う。候補が 1 つなら入れ替えた行、複数なら共通の頭まで入れて候補の一覧を返す
  function complete(partial, words) {
    const s = String(partial || '');
    const m = /(\S*)$/.exec(s); const head = s.slice(0, s.length - m[1].length), last = m[1];
    const cands = [...new Set((words || []).filter((w) => typeof w === 'string' && w.toLowerCase().startsWith(last.toLowerCase())))].sort();
    if (!last || !cands.length) return { line: s, candidates: cands };
    if (cands.length === 1) return { line: `${head}${cands[0]} `, candidates: cands };
    let common = cands[0];
    for (const c of cands) { let k = 0; while (k < common.length && k < c.length && common[k].toLowerCase() === c[k].toLowerCase()) k++; common = common.slice(0, k); }
    return { line: `${head}${common.length > last.length ? common : last}`, candidates: cands };
  }

  function html(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  const reqList = (reqs) => (Array.isArray(reqs) ? reqs : []).map((r, i) => (typeof r === 'string' ? { id: i + 1, text: r } : { id: r.id ?? i + 1, text: r.text || String(r) }));

  // ---------- 設定の欄 ----------
  function configForm(container, opts = {}) {
    if (!container) return null;
    container.replaceChildren(); container.classList.add('cfg');
    const editable = Array.isArray(opts.editable) ? opts.editable : [];
    const view = opts.configView || {};
    const reqs = reqList(opts.requirementsText);
    const areas = new Map();
    if (reqs.length) {
      const box = html('div', 'cfg-reqs');
      box.append(html('p', 'cfg-reqs-title', '満たす要件'));
      const ol = html('ol');
      for (const r of reqs) { const li = html('li', null, r.text); li.dataset.req = String(r.id); ol.append(li); }
      box.append(ol); container.append(box);
    }
    for (const dev of editable) {
      const sec = html('section', 'cfg-dev');
      const h = html('h4', null, `${dev} の設定`); sec.append(h);
      const cur = Array.isArray(view[dev]) ? view[dev] : (typeof view[dev] === 'string' ? view[dev].split('\n') : null);
      if (cur && cur.length) { const pre = html('pre', 'cfg-view', cur.join('\n')); pre.setAttribute('aria-label', `${dev} の今の設定(読むだけ)`); sec.append(html('p', 'cfg-view-title', '今の設定(抜粋)'), pre); }
      const ta = document.createElement('textarea');
      ta.className = 'cfg-text'; ta.rows = 8; ta.spellcheck = false; ta.autocapitalize = 'off'; ta.setAttribute('autocomplete', 'off');
      ta.id = `cfg-${dev.replace(/[^A-Za-z0-9_-]/g, '')}`; ta.placeholder = `${dev} に足す設定を 1 行 1 つずつ(例: ip route 10.3.3.0/24 10.0.12.2)`;
      ta.setAttribute('aria-label', `${dev} に書く設定`);
      const foot = html('div', 'cfg-foot');
      const count = html('span', 'cfg-count', `0 / ${LIMITS.lines} 行`);
      const err = html('span', 'cfg-err'); err.setAttribute('role', 'alert');
      foot.append(count, err);
      ta.addEventListener('input', () => { update(); if (opts.onChange) opts.onChange(api.values()); });
      sec.append(ta, foot); container.append(sec);
      areas.set(dev, { ta, count, err, sec });
    }
    function update() {
      for (const [, a] of areas) {
        const c = checkConfigText(a.ta.value);
        a.count.textContent = `${c.lines} / ${LIMITS.lines} 行`;
        a.err.textContent = c.errors.length ? `行 ${c.errors[0].line}: ${c.errors[0].message}` : '';
        a.sec.classList.toggle('over', !c.ok);
      }
    }
    const api = {
      el: container,
      values: () => editable.map((dev) => ({ device: dev, text: areas.get(dev).ta.value.replace(/\r\n?/g, '\n').replace(/\s+$/, '') })),
      filled: () => editable.some((dev) => checkConfigText(areas.get(dev).ta.value).nonEmpty > 0) && editable.every((dev) => checkConfigText(areas.get(dev).ta.value).ok),
      setDisabled(b) { for (const [, a] of areas) a.ta.disabled = !!b; },
      // 答えたあと: 満たさなかった要件の番号を赤く(ほかは満たした印)。サーバーが failed を返したときだけ
      markFailed(ids) {
        const bad = new Set((Array.isArray(ids) ? ids : []).map(String));
        for (const li of container.querySelectorAll('.cfg-reqs li')) { li.classList.toggle('ng', bad.has(li.dataset.req)); li.classList.toggle('ok', !bad.has(li.dataset.req)); }
      },
    };
    api.setDisabled(!!opts.disabled);
    update();
    return api;
  }

  // ---------- 模擬ターミナル ----------
  function terminal(container, opts = {}) {
    if (!container) return null;
    container.replaceChildren(); container.classList.add('term');
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    let device = opts.start || devices[0] || 'PC1';
    let words = WORDS.concat(devices, Array.isArray(opts.completions) ? opts.completions : []);
    const hist = []; let hi = 0, draft = '', used = 0, busy = false, disabled = !!opts.disabled;
    const out = html('pre', 'term-out'); out.setAttribute('aria-live', 'polite'); out.setAttribute('aria-label', 'ターミナルの出力'); out.tabIndex = 0;
    const row = html('div', 'term-row');
    const prompt = html('span', 'term-prompt'); prompt.setAttribute('aria-hidden', 'true');
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'term-in'; inp.maxLength = LIMITS.cmdChars; inp.spellcheck = false; inp.autocapitalize = 'off'; inp.setAttribute('autocomplete', 'off'); inp.setAttribute('autocorrect', 'off');
    inp.setAttribute('aria-label', 'コマンドを打つ(Enter で送る。↑↓ で履歴、Tab で語の補完)');
    const note = html('p', 'term-note', `コマンドは手で打ちます。Enter で送り、↑↓ で履歴、Tab で語を補えます(1 問 ${LIMITS.cmds} 回まで)。`);
    const counter = html('span', 'term-count');
    row.append(prompt, inp);
    const top = html('div', 'term-top'); top.append(html('span', 'term-title', `ターミナル(${devices.length ? `つなげる機器: ${devices.join('・')}` : '模擬'})`), counter);
    container.append(top, out, row, note);
    const setPrompt = () => { prompt.textContent = `${device}>`; inp.placeholder = `${device} で打つコマンド`; counter.textContent = `${used} / ${LIMITS.cmds} 回`; };
    const append = (text) => { if (text === undefined || text === null || text === '') return; out.textContent += (out.textContent ? '\n' : '') + String(text); out.scrollTop = out.scrollHeight; };
    const lock = () => { inp.disabled = disabled || busy || used >= LIMITS.cmds; };
    async function send() {
      const line = inp.value.trim();
      if (!line || busy || disabled) return;
      if (used >= LIMITS.cmds) { append(`この問題で打てる回数(${LIMITS.cmds} 回)を使い切りました`); lock(); return; }
      hist.push(line); if (hist.length > 100) hist.shift(); hi = hist.length; draft = '';
      inp.value = '';
      append(`${device}> ${line}`);
      used++; busy = true; lock(); setPrompt();
      try {
        const r = opts.onLine ? await opts.onLine(line) : 'この画面ではターミナルを使えません';
        const text = r && typeof r === 'object' ? r.out : r;
        append(text);
        const nd = r && typeof r === 'object' && r.device ? r.device : (() => { const m = /^=> (\S+)\s*$/m.exec(String(text || '')); return m ? m[1] : null; })();
        if (nd) device = nd;
      } catch (e) { append(`エラー: ${(e && e.message) || e}`); }
      busy = false; lock(); setPrompt();
      if (!inp.disabled) inp.focus();
    }
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
      else if (e.key === 'ArrowUp') { if (!hist.length) return; e.preventDefault(); if (hi === hist.length) draft = inp.value; hi = Math.max(0, hi - 1); inp.value = hist[hi]; setTimeout(() => inp.setSelectionRange(inp.value.length, inp.value.length), 0); }
      else if (e.key === 'ArrowDown') { if (!hist.length) return; e.preventDefault(); hi = Math.min(hist.length, hi + 1); inp.value = hi === hist.length ? draft : hist[hi]; }
      else if (e.key === 'Tab') { e.preventDefault(); const c = complete(inp.value, words); inp.value = c.line; if (c.candidates.length > 1) append(`候補: ${c.candidates.join('  ')}`); }
    });
    const api = {
      el: container, append,
      device: () => device,
      setDisabled(b) { disabled = !!b; lock(); },
      setCompletions(ws) { words = WORDS.concat(devices, Array.isArray(ws) ? ws : []); },
      used: () => used,
    };
    setPrompt(); lock();
    return api;
  }

  const api = { configForm, terminal, checkConfigText, complete, LIMITS, WORDS };
  if (typeof window !== 'undefined') window.PCTerminal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
