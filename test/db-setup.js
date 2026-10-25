'use strict';
// tools/db-setup.js の --force の計画(planNodes)を確かめる(2026-10-26)。DB には触らない。
// 同じ id の古い写しが残っている場合(本番で烏場山・摩耶山に見つかった)も消えること、ゲームの状態を引き継ぐことを見る
const assert = require('assert');
const { planNodes } = require('../tools/db-setup');

const d = (id, region, hash, extra = {}) => ({ id, country: 'japan', region, masterHash: hash, name: id, ...extra });
const r = (id, region, hash, extra = {}) => ({ id, country: 'japan', region, masterHash: hash, updatedAt: 0, ...extra });

// 1. 変わらない拠点は書かない。指紋が違えば書く。新しい拠点は書く
{
  const p = planNodes([d('a', 'x', 'h1'), d('b', 'x', 'h2'), d('c', 'x', 'h3')], [r('a', 'x', 'h1'), r('b', 'x', 'old', { owner: 'p1', defense: 2 })]);
  assert.strictEqual(p.unchanged, 1); assert.strictEqual(p.added, 1); assert.strictEqual(p.deletes.length, 0);
  const b = p.upserts.find((u) => u.id === 'b');
  assert.strictEqual(b.owner, 'p1'); assert.strictEqual(b.defense, 2); assert.strictEqual(b.masterHash, 'h2', 'マスターの中身で書く');
}
// 2. 地域が変わった拠点: 古い地域の文書を消し、状態を引き継いで新しい地域に書く
{
  const p = planNodes([d('a', 'new', 'h1')], [r('a', 'old', 'h0', { owner: 'p1' })]);
  assert.deepStrictEqual(p.deletes.map((x) => x.region), ['old']); assert.strictEqual(p.moved, 1); assert.strictEqual(p.movedDeletes, 1);
  assert.strictEqual(p.upserts[0].region, 'new'); assert.strictEqual(p.upserts[0].owner, 'p1');
}
// 3. 同じ id が 2 つ(古い地域に写しが残っている。今の地域は指紋も同じ): 古い写しだけ消し、書き直さない
{
  const p = planNodes([d('a', 'new', 'h1')], [r('a', 'old', 'h0', { updatedAt: 1 }), r('a', 'new', 'h1', { updatedAt: 2 })]);
  assert.deepStrictEqual(p.deletes.map((x) => x.region), ['old']); assert.strictEqual(p.dupDeletes, 1); assert.strictEqual(p.upserts.length, 0);
}
// 4. 同じ id が 2 つで、持ち主が古い写しの方にいる: 古い写しを消し、その状態を新しい地域へ引き継いで書く
{
  const p = planNodes([d('a', 'new', 'h1')], [r('a', 'old', 'h0', { owner: 'p9', defense: 3 }), r('a', 'new', 'h1')]);
  assert.deepStrictEqual(p.deletes.map((x) => x.region), ['old']);
  assert.strictEqual(p.upserts.length, 1); assert.strictEqual(p.upserts[0].owner, 'p9'); assert.strictEqual(p.upserts[0].defense, 3); assert.strictEqual(p.upserts[0].region, 'new');
}
// 5. マスターから消えた固定拠点: 持ち主がいなければ消す、いれば残す。プレイヤーの拠点は触らない
{
  const p = planNodes([d('a', 'x', 'h1')], [r('a', 'x', 'h1'), r('gone', 'x', 'h'), r('kept', 'x', 'h', { owner: 'p1' }), r('home-1', 'x', null, { isPlayerNode: true })]);
  assert.deepStrictEqual(p.deletes.map((x) => x.id), ['gone']); assert.deepStrictEqual(p.kept.map((x) => x.id), ['kept']); assert.strictEqual(p.staleDeletes, 1);
}
console.log('db-setup ok: 計画(変わらない・変わった・新規・地域の移動・同じ id の古い写し・消えた拠点)');
