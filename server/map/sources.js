'use strict';
// 出典の台帳(docs/DATA-FORMAT.md 第 2 章)。台帳に無い出典の記録は読み込まない。
// usable(id) が「ゲームに使ってよいか」を機械的に決める: 商用可・継承条件なし・status active・契約なら期限内。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'sources.json');
const KINDS = new Set(['government', 'community', 'partner', 'commercial', 'internal']);
const STATUSES = new Set(['active', 'planned', 'retired']);

function validateSources(data) {
  if (!data || data.schema !== 'pc.sources/1' || !Array.isArray(data.sources)) throw new Error('出典の台帳: schema pc.sources/1 と sources が要る');
  const byId = new Map();
  for (const s of data.sources) {
    const where = `出典の台帳 ${s && s.id}`;
    if (!s || typeof s.id !== 'string' || !/^src-[a-z0-9-]+$/.test(s.id)) throw new Error(`${where}: id は src- で始まる英小文字・数字・ハイフン`);
    if (byId.has(s.id)) throw new Error(`${where}: id が重複`);
    for (const k of ['title', 'publisher', 'license']) if (typeof s[k] !== 'string' || !s[k]) throw new Error(`${where}: ${k} が要る`);
    if (!KINDS.has(s.kind)) throw new Error(`${where}: kind が不正 ${s.kind}`);
    if (!STATUSES.has(s.status)) throw new Error(`${where}: status が不正 ${s.status}`);
    for (const k of ['commercialUse', 'shareAlike', 'attribution']) if (typeof s[k] !== 'boolean') throw new Error(`${where}: ${k} は true/false`);
    if (s.attribution && s.status === 'active' && !(s.attributionText && s.attributionText.ja)) throw new Error(`${where}: 表示が要る出典は attributionText.ja が要る`);
    if (s.kind === 'partner' && !(s.contract && s.contract.id && s.contract.validUntil)) throw new Error(`${where}: 協力企業の出典は contract(id、validUntil)が要る`);
    byId.set(s.id, s);
  }
  return byId;
}

let cache = null;
function loadSources() {
  if (cache) return cache;
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const byId = validateSources(data);
  cache = { SOURCES: data.sources, byId, usable: (id, today) => usableIn(byId, id, today) };
  return cache;
}

// ゲームに使ってよいか。理由も返す(取り込みの一覧に出すため)
function usableIn(byId, id, today = new Date().toISOString().slice(0, 10)) {
  const s = byId.get(id);
  if (!s) return { ok: false, reason: '台帳に無い出典' };
  if (s.status !== 'active') return { ok: false, reason: `出典の状態が ${s.status}` };
  if (!s.commercialUse) return { ok: false, reason: '使用許諾が非商用' };
  if (s.shareAlike) return { ok: false, reason: '継承条件つき(派生データの公開義務)' };
  if (s.contract && s.contract.validUntil && s.contract.validUntil < today) return { ok: false, reason: `契約の期限切れ(${s.contract.validUntil})` };
  return { ok: true, reason: '' };
}

module.exports = { loadSources, validateSources, usableIn };
