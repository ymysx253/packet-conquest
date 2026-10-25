'use strict';
// 問題のダイアログの中身(2026-10-22)。ゲームの画面(app.js)と、新しい番号の問題の見本のページ(cl-preview.js)で同じものを使う。
// 入れ物(qDialog)は 1 つ。説明カード・問題文・表・答えの欄・ヒント・結果を、問題ごとに描き直す。答えは持たない(判定はサーバー)。
//   PCQuestion.size(q)               → ダイアログの大きさ 'normal' | 'wide' | 'full'
//   PCQuestion.render(q, r, opts)     → 中身を描く。r は結果(答えたあと)。opts: { chosen, onChoose(i), onSubmit(inputs) }
//   PCQuestion.keyIndex(e, q)        → 数字キー(1〜4)で選べる選択肢の番号。選べなければ null
// 答えの欄は答え方(answerKind)ごと。入力式の欄は format ごとにスマホ向けの部品を使い、最後は今までと同じ文字列にして送る:
//   ipv4 → 4 つの欄(数字のキーボード)、ipv4cidr → 4 つの欄 + 長さ、bin(digits あり)→ 0/1 の切り替えボタン、number / prefixlen → 数字のキーボード
(() => {
  const $ = (id) => document.getElementById(id);

  // tap(構成図をタップ)と config(設定を書く)は 2026-10-25(docs/questions/SIM-API.md 第 5 章)。図は diagram.js、設定の欄とターミナルは terminal.js が描く
  const ANSWER_VIEWS = {
    choice: { size: () => 'normal' },
    text: { size: (q) => (q.fields || []).some((f) => f.format === 'prefixplan') || (q.fields || []).length > 4 ? 'wide' : 'normal' },
    tap: { size: () => 'wide' },
    config: { size: () => 'wide' },
  };
  const tablesOf = (q) => (Array.isArray(q.tables) && q.tables.length ? q.tables : (q.table ? [q.table] : []));
  function size(q) {
    const v = ANSWER_VIEWS[q.answerKind || 'choice'];
    const wideTable = tablesOf(q).length > 1 || tablesOf(q).some((t) => (t.headers || []).length > 4);
    let s = v ? (wideTable && v.size(q) === 'normal' ? 'wide' : v.size(q)) : 'full';
    if (q.diagram && q.terminal) s = 'full'; else if ((q.diagram || q.terminal) && s === 'normal') s = 'wide';
    return s;
  }
  const isTF = (q) => Array.isArray(q.options) && q.options.length === 2 && q.options[0] === '○' && q.options[1] === '×';

  let cur = { qid: null, opts: {}, widgets: [], hintShown: false, diag: null, tapIds: [], cfg: null, term: null };

  // 図・設定・ターミナルの入れ物。index.html / cl-preview.html に無ければ作って差し込む(古い HTML でも落ちない)
  function slot(id, after) {
    let e = $(id);
    if (e) return e;
    const ref = $(after); if (!ref || !ref.parentNode) return null;
    e = document.createElement('div'); e.id = id; e.hidden = true;
    ref.parentNode.insertBefore(e, ref.nextSibling);
    return e;
  }
  const sentOf = (q, r, opts) => !!r || !!(opts.chosen && typeof opts.chosen === 'object' && opts.chosen.qid === q.qid);

  function render(q, r, opts = {}) {
    if (cur.qid !== q.qid) cur = { qid: q.qid, opts, widgets: [], hintShown: false, fresh: true, diag: null, tapIds: [], cfg: null, term: null };
    cur.opts = opts;
    renderCard(q);
    const textNodes = [];
    String(q.text || '').split('\n').forEach((line, i) => { if (i) textNodes.push(document.createElement('br')); textNodes.push(...highlightIps(line)); });
    $('qText').replaceChildren(...textNodes);
    renderDiagram(q, r, opts);
    $('qTables').replaceChildren(...tablesOf(q).map(makeTable));
    const isText = q.answerKind === 'text' && Array.isArray(q.fields);
    const isTap = q.answerKind === 'tap', isConfig = q.answerKind === 'config';
    const known = !q.answerKind || !!ANSWER_VIEWS[q.answerKind];
    $('qOptions').hidden = isText || isTap || isConfig || !known; $('qFields').hidden = !isText;
    if (!known) { const p = document.createElement('p'); p.className = 'unsupported'; p.textContent = 'この形の問題は、まだ画面が対応していません'; $('qTables').append(p); }
    if (isText) renderFields(q, r, opts);
    renderTap(q, r, opts);
    renderConfig(q, r, opts);
    renderTerminal(q, r, opts);
    renderOptions(isText || isTap || isConfig || !known ? null : q, r, opts);
    renderHint(q);
    $('qResult').hidden = !r;
    if (r) {
      $('qVerdict').textContent = r.correct === null ? '送る形の見本' : r.correct ? '正解' : '不正解';
      $('qVerdict').className = `verdict ${r.correct === null ? 'demo' : r.correct ? 'ok' : 'ng'}`;
      $('qExplain').textContent = r.explanation || ''; $('qOutcome').textContent = r.outcome || '';
      const showAnswers = isText && Array.isArray(r.answers) && !r.correct;
      $('qAnswers').hidden = !showAnswers;
      if (showAnswers) $('qAnswers').textContent = '正解: ' + q.fields.map((f, i) => `${f.label}: ${r.answers[i]}`).join(' / ');
      $('qDefense').hidden = !r.defenseNote;
      if (r.defenseNote) $('qDefense').textContent = `守る側なら: ${r.defenseNote}`;
    }
    cur.fresh = false;
  }

  // ---------- 構成図(diagram)とタップの答え(tap) ----------
  function renderDiagram(q, r, opts) {
    const box = slot('qDiagram', 'qText'); if (!box) return;
    const DG = window.PCDiagram;
    if (!q.diagram || !DG) { box.hidden = true; box.replaceChildren(); cur.diag = null; return; }
    box.hidden = false;
    const mode = q.answerKind === 'tap' && q.tap ? q.tap.mode : 'view';
    const sent = sentOf(q, r, opts);
    if (!cur.diag || box.dataset.qid !== q.qid) {
      box.dataset.qid = q.qid;
      const initial = opts.chosen && typeof opts.chosen === 'object' && opts.chosen.qid === q.qid && Array.isArray(opts.chosen.ids) ? opts.chosen.ids : [];
      cur.tapIds = initial.slice();
      cur.diag = DG.render(box, q.diagram, { mode, selected: initial, tables: q.diagram.tables, disabled: sent, onChange: (ids) => { cur.tapIds = ids; updateTapBar(q); } });
    }
    cur.diag.setDisabled(sent);
    if (r && Array.isArray(r.correctIds)) cur.diag.mark(r.correctIds); // サーバーが正解の id を返したときだけ印を付ける
  }
  function renderTap(q, r, opts) {
    const bar = slot('qTapBar', 'qDiagram'); if (!bar) return;
    if (q.answerKind !== 'tap') { bar.hidden = true; bar.replaceChildren(); return; }
    bar.hidden = false;
    const sent = sentOf(q, r, opts);
    if (bar.dataset.qid !== q.qid) {
      bar.dataset.qid = q.qid;
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn primary'; btn.id = 'qTapSubmit'; btn.textContent = '答える';
      btn.onclick = () => { if (!cur.tapIds.length) { if (cur.opts.onIncomplete) cur.opts.onIncomplete(); return; } if (cur.opts.onSubmit) cur.opts.onSubmit({ ids: cur.tapIds.slice() }); };
      const note = document.createElement('span'); note.className = 'hint'; note.id = 'qTapNote';
      note.textContent = ({ one: '機器を 1 つ選んで「答える」。選び直せます', many: '当てはまるものを全部選んで「答える」。もう一度押すと外れます', order: '通る順に押して「答える」。もう一度押すと外れて番号が振り直されます', port: 'ポートを 1 つ選んで「答える」', link: '線を 1 つ選んで「答える」' }[(q.tap || {}).mode] || '選んで「答える」');
      bar.replaceChildren(btn, note);
    }
    updateTapBar(q, sent);
  }
  function updateTapBar(q, sent) {
    const btn = $('qTapSubmit'); if (!btn) return;
    const done = sent !== undefined ? sent : btn.disabled && btn.dataset.sent === '1';
    btn.dataset.sent = done ? '1' : '';
    btn.disabled = done || !cur.tapIds.length;
  }

  // ---------- 設定を書く(config) ----------
  function renderConfig(q, r, opts) {
    const box = slot('qConfig', 'qTapBar') || slot('qConfig', 'qTables'); if (!box) return;
    const T = window.PCTerminal;
    if (q.answerKind !== 'config' || !T) { box.hidden = true; box.replaceChildren(); cur.cfg = null; return; }
    box.hidden = false;
    const sent = sentOf(q, r, opts);
    if (!cur.cfg || box.dataset.qid !== q.qid) {
      box.dataset.qid = q.qid;
      box.replaceChildren();
      const form = document.createElement('div'); form.className = 'cfg-form';
      cur.cfg = T.configForm(form, { editable: q.editable || [], configView: q.configView || {}, requirementsText: q.requirementsText || [], disabled: sent, onChange: () => updateCfgBtn() });
      const foot = document.createElement('div'); foot.className = 'fields-foot';
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn primary'; btn.id = 'qCfgSubmit'; btn.textContent = '答える';
      btn.onclick = () => { if (!cur.cfg.filled()) { if (cur.opts.onIncomplete) cur.opts.onIncomplete(); return; } if (cur.opts.onSubmit) cur.opts.onSubmit({ configs: cur.cfg.values() }); };
      const note = document.createElement('span'); note.className = 'hint'; note.textContent = '書き方が違っても、設定した結果が要件を満たせば正解です。1 台 40 行まで';
      foot.append(btn, note);
      box.append(form, foot);
    }
    cur.cfg.setDisabled(sent);
    updateCfgBtn(sent);
    if (r && Array.isArray(r.failed)) cur.cfg.markFailed(r.failed);
  }
  function updateCfgBtn(sent) {
    const btn = $('qCfgSubmit'); if (!btn || !cur.cfg) return;
    const done = sent !== undefined ? sent : btn.dataset.sent === '1';
    btn.dataset.sent = done ? '1' : '';
    btn.disabled = done || !cur.cfg.filled();
  }

  // ---------- 模擬ターミナル(terminal が付いた問題。答え方は answerKind のとおり) ----------
  function renderTerminal(q, r, opts) {
    const box = slot('qTerm', 'qConfig') || slot('qTerm', 'qTables'); if (!box) return;
    const T = window.PCTerminal;
    if (!q.terminal || !T) { box.hidden = true; box.replaceChildren(); cur.term = null; return; }
    box.hidden = false;
    const sent = sentOf(q, r, opts);
    if (!cur.term || box.dataset.qid !== q.qid) {
      box.dataset.qid = q.qid;
      cur.term = T.terminal(box, { devices: q.terminal.devices || [], start: q.terminal.start, completions: q.terminal.completions || [], disabled: sent, onLine: (line) => (cur.opts.onTerm ? cur.opts.onTerm(line) : Promise.resolve('この画面ではターミナルを使えません')) });
    }
    cur.term.setDisabled(sent);
  }

  // 説明カード(入門。CL.md 第 3 章): 問題文の前に出す。新しい問題では開いて出し、たためる
  function renderCard(q) {
    const box = $('qCard'); if (!box) return;
    box.hidden = !q.card;
    if (!q.card) return;
    if (cur.fresh) { box.open = true; $('qCardText').textContent = q.card; }
  }

  // ヒント(初級の hint・中級の firstStep): ボタンを押すと見せる。ほかの人の拠点を攻めるときはサーバーが送らない(hintLocked だけが来る)
  function renderHint(q) {
    const box = $('qHintBox'); if (!box) return;
    const items = [q.hint && ['ヒント', q.hint], q.firstStep && ['最初の 1 手', q.firstStep]].filter(Boolean);
    box.hidden = !items.length && !q.hintLocked;
    if (box.hidden) return;
    const btn = $('qHintBtn'), text = $('qHintText'), lock = $('qHintLock');
    lock.hidden = !q.hintLocked || items.length > 0;
    btn.hidden = !items.length;
    if (!items.length) { text.hidden = true; return; }
    btn.textContent = q.firstStep && !q.hint ? 'ヒント(最初の 1 手)' : 'ヒント';
    btn.setAttribute('aria-expanded', String(cur.hintShown));
    btn.disabled = cur.hintShown;
    text.hidden = !cur.hintShown;
    if (cur.hintShown) text.replaceChildren(...items.map(([k, v]) => { const p = document.createElement('p'); const b = document.createElement('b'); b.textContent = `${k}: `; p.append(b, document.createTextNode(v)); return p; }));
    btn.onclick = () => { cur.hintShown = true; renderHint(q); };
  }

  // 選ぶ問題: ○× は大きな 2 つのボタン、2 択・3 択・4 択は数に合わせて並べる。数字キー 1〜4 でも選べる
  function renderOptions(q, r, opts) {
    const box = $('qOptions');
    const list = q ? (q.options || []) : [];
    box.className = 'options' + (q && isTF(q) ? ' tf' : '') + ` n${list.length}`;
    box.replaceChildren(...list.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'opt'; b.id = `opt${i}`;
      const k = document.createElement('span'); k.className = 'k'; k.textContent = i + 1;
      const v = document.createElement('span'); v.className = 'v'; v.textContent = o;
      b.append(k, v);
      if (isTF(q)) b.setAttribute('aria-label', `${i + 1}: ${o === '○' ? '正しい(○)' : '誤り(×)'}`);
      if (r) { b.disabled = true; if (i === r.answerIndex) b.classList.add('correct'); else if (i === opts.chosen) b.classList.add('wrong'); }
      else if (Number.isInteger(opts.chosen)) { b.disabled = true; if (i === opts.chosen) b.classList.add('picked'); }
      b.onclick = () => { if (opts.onChoose) opts.onChoose(i); };
      return b;
    }));
  }
  function keyIndex(e, q) {
    if (!q || q.answerKind === 'text' || q.answerKind === 'tap' || q.answerKind === 'config' || q.terminal) return null;
    const t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA') return null;
    const n = Number(e.key);
    return Number.isInteger(n) && n >= 1 && n <= Math.min(4, (q.options || []).length) ? n - 1 : null;
  }

  // ---------- 入力式の欄(COMMON.md 第 2 章) ----------
  const toHalf = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[．。]/g, '.').replace(/／/g, '/');
  const bitsOf = (f) => (f.format === 'bin' && Number.isInteger(f.digits) && f.digits >= 1 && f.digits <= 16 ? f.digits : 0);

  // 1 つの欄の部品。{ el, value(), filled(), disable(b), focus() }
  function widgetFor(f, i) {
    if (f.format === 'ipv4' || f.format === 'ipv4cidr') return octetWidget(f, i, f.format === 'ipv4cidr');
    if (bitsOf(f)) return bitWidget(f, i, bitsOf(f));
    const inp = document.createElement(f.format === 'prefixplan' ? 'textarea' : 'input');
    inp.id = `fld${i}`; inp.name = f.name; inp.placeholder = f.hint || ''; inp.maxLength = f.format === 'prefixplan' ? 1000 : 200;
    if (inp.tagName === 'INPUT') { inp.type = 'text'; inp.inputMode = ['number', 'prefixlen'].includes(f.format) ? 'numeric' : 'text'; inp.autocapitalize = 'off'; inp.spellcheck = false; inp.autocomplete = 'off'; }
    else inp.rows = 4;
    inp.addEventListener('input', updateSubmit);
    return { el: inp, value: () => inp.value, filled: () => !!inp.value.trim(), disable: (b) => { inp.disabled = b; }, focus: () => inp.focus() };
  }

  // IPv4 アドレス: 4 つの欄(数字のキーボード)。「.」や空白で次の欄へ、3 けたで次の欄へ。貼り付けた「192.0.2.1」は 4 つに分ける。
  // withLen(ipv4cidr)なら「/」のあとに長さの欄を足す。送るのは「a.b.c.d」(「a.b.c.d/n」)
  function octetWidget(f, i, withLen) {
    const wrap = document.createElement('div'); wrap.className = 'ip4'; wrap.setAttribute('role', 'group');
    const parts = [];
    const count = withLen ? 5 : 4;
    for (let k = 0; k < count; k++) {
      if (k) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = k === 4 ? '/' : '.'; wrap.append(sep); }
      const inp = document.createElement('input');
      inp.type = 'text'; inp.inputMode = 'numeric'; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.id = k ? `fld${i}_${k}` : `fld${i}`; inp.maxLength = 15; inp.className = k === 4 ? 'len' : 'oct';
      inp.setAttribute('aria-label', k === 4 ? `${f.label || f.name} の長さ(/ のあと)` : `${f.label || f.name} の ${k + 1} つ目`);
      inp.placeholder = k === 4 ? '24' : '0';
      parts.push(inp); wrap.append(inp);
    }
    const max = (k) => (k === 4 ? 2 : 3);
    const clean = (k, s) => s.replace(/\D/g, '').slice(0, max(k));
    parts.forEach((inp, k) => {
      inp.addEventListener('input', () => {
        const raw = toHalf(inp.value);
        if (/[.\/\s,]/.test(raw)) { // 区切りを打った・貼り付けた: 区切りごとに次の欄へ分ける(空の区切りのあとは次の欄を消さない)
          const segs = raw.split(/[.\/\s,]+/);
          if (segs.every((s) => s === '')) { inp.value = ''; updateSubmit(); return; } // 3 けたで自動で進んだあとの「.」など: 空の欄で区切りだけ打ったら、そこにとどまる
          let last = k;
          segs.forEach((s, j) => { const t = k + j; if (t < parts.length && (j === 0 || s !== '')) { parts[t].value = clean(t, s); last = t; } });
          const endsWithSep = segs[segs.length - 1] === '';
          parts[Math.min(parts.length - 1, endsWithSep ? k + segs.length - 1 : last)].focus();
        } else {
          inp.value = clean(k, raw);
          if (inp.value.length >= max(k) && k + 1 < parts.length) { parts[k + 1].focus(); parts[k + 1].select(); }
        }
        updateSubmit();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && k > 0) { e.preventDefault(); parts[k - 1].focus(); }
        else if (e.key === 'ArrowLeft' && inp.selectionStart === 0 && k > 0) { e.preventDefault(); parts[k - 1].focus(); }
        else if (e.key === 'ArrowRight' && inp.selectionStart === inp.value.length && k + 1 < parts.length) { e.preventDefault(); parts[k + 1].focus(); }
      });
    });
    const value = () => parts.slice(0, 4).map((p) => p.value).join('.') + (withLen ? `/${parts[4].value}` : '');
    return { el: wrap, value, filled: () => parts.every((p) => p.value !== ''), disable: (b) => parts.forEach((p) => { p.disabled = b; }), focus: () => parts[0].focus() };
  }

  // 2 進数(けた数が決まっている欄): 0/1 の切り替えボタンをけた数だけ。押すたびに 0 ⇄ 1。ボタンの上で 0・1 を押してもよい。送るのは「01011010」
  function bitWidget(f, i, digits) {
    const wrap = document.createElement('div'); wrap.className = 'bits'; wrap.setAttribute('role', 'group');
    const bits = [];
    for (let k = 0; k < digits; k++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bit'; b.id = k ? `fld${i}_${k}` : `fld${i}`;
      b.dataset.v = '0'; b.textContent = '0'; b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', `${f.label || f.name} の左から ${k + 1} けた目`);
      if (k && k % 4 === 0) b.classList.add('gap');
      const set = (v) => { b.dataset.v = v; b.textContent = v; b.setAttribute('aria-pressed', String(v === '1')); };
      b.onclick = () => set(b.dataset.v === '1' ? '0' : '1');
      b.addEventListener('keydown', (e) => {
        if (e.key === '0' || e.key === '1') { e.preventDefault(); e.stopPropagation(); set(e.key); if (k + 1 < digits) bits[k + 1].focus(); }
        else if (e.key === 'ArrowLeft' && k > 0) { e.preventDefault(); bits[k - 1].focus(); }
        else if (e.key === 'ArrowRight' && k + 1 < digits) { e.preventDefault(); bits[k + 1].focus(); }
      });
      bits.push(b); wrap.append(b);
    }
    return { el: wrap, value: () => bits.map((b) => b.dataset.v).join(''), filled: () => true, disable: (d) => bits.forEach((b) => { b.disabled = d; }), focus: () => bits[0].focus() };
  }

  function renderFields(q, r, opts) {
    const list = $('qFieldList');
    const sent = !!r || (opts.chosen && opts.chosen.qid === q.qid);
    if (list.dataset.qid !== q.qid) {
      list.dataset.qid = q.qid;
      cur.widgets = q.fields.map((f, i) => widgetFor(f, i));
      list.replaceChildren(...q.fields.map((f, i) => {
        const box = document.createElement('div'); box.className = 'field';
        const w = cur.widgets[i];
        const lab = document.createElement(w.el.tagName === 'DIV' ? 'span' : 'label'); lab.className = 'flabel'; lab.textContent = f.label || f.name;
        if (lab.tagName === 'LABEL') lab.htmlFor = `fld${i}`; else { lab.id = `fldl${i}`; w.el.setAttribute('aria-labelledby', lab.id); }
        box.append(lab, w.el);
        if (w.el.tagName === 'DIV' && f.hint && w.el.className !== 'bits') { const h = document.createElement('span'); h.className = 'fhint'; h.textContent = f.hint; box.append(h); }
        return box;
      }));
      $('qFieldNote').textContent = q.fields.some((f) => bitsOf(f)) ? 'ボタンを押すと 0 と 1 が切り替わります。' : q.fields.some((f) => f.format === 'ipv4' || f.format === 'ipv4cidr') ? 'アドレスは 4 つの欄に分けて入れます(「.」でも次の欄へ進みます)。' : '';
      setTimeout(() => { const first = cur.widgets[0]; if (first && !matchMedia('(pointer: coarse)').matches) first.focus(); }, 0);
    }
    cur.widgets.forEach((w) => w.disable(sent));
    $('qSubmit').disabled = sent || !allFilled();
    list.querySelectorAll('.field').forEach((box) => { box.classList.remove('ok', 'ng'); if (r && Array.isArray(r.answers)) box.classList.add(r.correct ? 'ok' : 'ng'); });
  }
  function allFilled() { return cur.widgets.length > 0 && cur.widgets.every((w) => w.filled()); }
  function updateSubmit() { $('qSubmit').disabled = !allFilled(); }

  function bindForm() {
    const form = $('qFields'); if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!allFilled()) { if (cur.opts.onIncomplete) cur.opts.onIncomplete(); return; }
      if (cur.opts.onSubmit) cur.opts.onSubmit(cur.widgets.map((w) => w.value()));
    });
  }

  function makeTable(t) {
    const tbl = document.createElement('table'); tbl.className = 'qtable';
    if (t.title) { const cap = document.createElement('caption'); cap.textContent = t.title; tbl.append(cap); }
    const thead = document.createElement('thead'); const hr = document.createElement('tr');
    (t.headers || []).forEach((h) => { const th = document.createElement('th'); th.textContent = h; hr.append(th); });
    thead.append(hr);
    const tbody = document.createElement('tbody');
    (t.rows || []).forEach((row) => { const tr = document.createElement('tr'); row.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.append(td); }); tbody.append(tr); });
    tbl.append(thead, tbody); return tbl;
  }
  function highlightIps(text) {
    return text.split(/(\d+\.\d+\.\d+\.\d+(?:\/\d+)?|\/\d+)/).filter(Boolean).map((part) => {
      if (/^(\d+\.\d+\.\d+\.\d+(\/\d+)?|\/\d+)$/.test(part)) { const s = document.createElement('span'); s.className = 'ip'; s.textContent = part; return s; }
      return document.createTextNode(part);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindForm); else bindForm();
  window.PCQuestion = { size, render, keyIndex, isTF, ANSWER_KINDS: Object.keys(ANSWER_VIEWS) };
})();
