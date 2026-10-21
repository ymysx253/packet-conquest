'use strict';
// 説明書のページ(public/manual.html)を docs/MANUAL.md から作る(2026-10-21 ユーザー決定: 説明書のページは要る。右の欄の「あなたの番」の説明はここへ移した)。
// 規則を変えて docs/MANUAL.md を直したら、これを流してページも作り直す。npm.cmd test は --check で作り直し忘れを見つける。
//
// 使い方:
//   node tools/build-manual.js          # public/manual.html を書く
//   node tools/build-manual.js --check  # 今の public/manual.html が MANUAL.md と合っているか(合っていなければ終了コード 1)
//
// 書き方は MANUAL.md で使っているものだけ: 見出し(## / ###)、段落、箇条書き(- と 2 文字下げの入れ子)、番号付き(1.)、表、**太字**、`コード`、[文字](リンク)。
// 冒頭の「## 1.」より前(作る人向けの注意書き)は出さない
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs/MANUAL.md');
const OUT = path.join(ROOT, 'public/manual.html');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => (/^(https?:|[a-z0-9._-]+\.html)/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t));

function render(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## /.test(l));
  const body = start >= 0 ? lines.slice(start) : lines;
  const out = [];
  let i = 0;
  const toc = [];
  while (i < body.length) {
    const l = body[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{2,4}) (.*)$/.exec(l))) {
      const lv = m[1].length, id = `s${out.length}`;
      if (lv === 2) toc.push({ id, text: m[2] });
      out.push(`<h${lv} id="${id}">${inline(m[2])}</h${lv}>`); i++; continue;
    }
    if (/^\|/.test(l)) { // 表
      const rows = [];
      while (i < body.length && /^\|/.test(body[i])) { rows.push(body[i]); i++; }
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const rest = rows.slice(1).filter((r) => !/^\|[\s:|-]+\|$/.test(r));
      out.push(`<div class="manual-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^(\s*)(- |\d+\. )/.test(l)) { // 箇条書き(入れ子は 2 文字下げ)
      const items = [];
      while (i < body.length && (/^(\s*)(- |\d+\. )/.test(body[i]) || (/^\s{2,}\S/.test(body[i]) && items.length))) { items.push(body[i]); i++; }
      const build = (arr, depth) => {
        const ordered = /^\s*\d+\. /.test(arr[0]);
        const tag = ordered ? 'ol' : 'ul';
        let html = `<${tag}>`;
        let k = 0;
        while (k < arr.length) {
          const text = arr[k].replace(/^\s*(- |\d+\. )/, '');
          k++;
          const sub = [];
          while (k < arr.length && arr[k].search(/\S/) > depth * 2) { sub.push(arr[k]); k++; }
          html += `<li>${inline(text)}${sub.length ? build(sub, depth + 1) : ''}</li>`;
        }
        return html + `</${tag}>`;
      };
      out.push(build(items, 0));
      continue;
    }
    // 段落(空行まで)
    const para = [];
    while (i < body.length && body[i].trim() && !/^(#{2,4} |\||\s*(- |\d+\. ))/.test(body[i])) { para.push(body[i].trim()); i++; }
    out.push(`<p>${inline(para.join(''))}</p>`);
  }
  return { html: out.join('\n'), toc };
}

function page(md) {
  const { html, toc } = render(md);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>説明書 | パケット陣取り</title>
<link rel="stylesheet" href="style.css">
</head>
<body class="manual-page">
<!-- このページは tools/build-manual.js が docs/MANUAL.md から作る。直接書き換えない -->
<header class="manual-head">
  <h1>パケット陣取り 説明書</h1>
  <p class="hint">ネットワークの問題に正解して、陣地を広げる学習ゲームの遊び方です。</p>
  <nav class="manual-toc" aria-label="目次"><ul>${toc.map((t) => `<li><a href="#${t.id}">${inline(t.text)}</a></li>`).join('')}</ul></nav>
</header>
<main class="manual">
${html}
</main>
</body>
</html>
`;
}

const html = page(fs.readFileSync(SRC, 'utf8'));
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== html) { console.error('public/manual.html が docs/MANUAL.md と合っていません。node tools/build-manual.js で作り直してください'); process.exit(1); }
  console.log('manual ok');
} else {
  fs.writeFileSync(OUT, html);
  console.log(`public/manual.html を書いた(${html.length} 字)`);
}
