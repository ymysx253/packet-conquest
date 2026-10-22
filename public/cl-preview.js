'use strict';
// 新しい番号の問題の見本のページ(cl-preview.html。2026-10-22)。サーバーの口は server/cl-preview.js(CL_PREVIEW=1 のときだけ開く)。
// レベルと seed をサーバーに頼み、ゲームと同じダイアログ(qdialog.js)で出す。答えはサーバーへ送り、判定もサーバー(画面は正解を持たない)
(() => {
  const $ = (id) => document.getElementById(id);
  const PCQ = window.PCQuestion;
  const S = { question: null, result: null, chosen: null };

  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (res) => { const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || `エラー(${res.status})`); return j; });
  const showError = (m) => { $('pvError').textContent = m || ''; $('pvDlgError').textContent = m || ''; }; // ダイアログが開いていれば、その中にも出す

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
      $('pvLevel').replaceChildren(...[g1, g2].filter((g) => g.children.length));
      if (!levels.length) showError('新しい番号の問題はまだありません');
      const want = new URLSearchParams(location.search).get('level');
      if (want && [...levels, ...samples].some((l) => String(l.level) === want)) $('pvLevel').value = want;
    } catch (e) { showError(e.message); }
  }

  async function ask(seedText) {
    showError('');
    const v = $('pvLevel').value, level = /^\d+$/.test(v) ? Number(v) : v; // 形の見本は 'demo-…'
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
    $('qDiff').textContent = (typeof q.level === 'number' ? `新しい番号 Lv${q.level} / seed ${q.seed}` : '画面の形の見本') + ($('pvOthers').checked ? ' / ほかの人の拠点' : ' / 中立の拠点');
    const r = S.result && S.result.qid === q.qid ? S.result : null;
    PCQ.render(q, r, { chosen: S.chosen, onChoose: choose, onSubmit: submit, onIncomplete: () => showError('すべての欄を入れてください') });
    $('qNext').hidden = !r;
  }
  async function send(body) {
    try { S.result = await post('/cl-preview/answer', body); }
    catch (e) { S.chosen = null; showError(e.message); }
    render();
  }
  function choose(i) {
    const q = S.question;
    if (!q || q.answerKind === 'text' || S.result || S.chosen != null || i < 0 || i >= (q.options || []).length) return;
    S.chosen = i; render(); send({ qid: q.qid, choice: i });
  }
  function submit(inputs) {
    const q = S.question;
    if (!q || q.answerKind !== 'text' || S.result || S.chosen) return;
    S.chosen = { qid: q.qid, inputs }; render(); send({ qid: q.qid, inputs });
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
