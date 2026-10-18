'use strict';
// 保存口。World はここを通してだけ保存・読み込みを行う(設計書 第 13 章、docs/DB.md)。
// 全件をまとめて読まず、画面に見えているタイルの拠点だけを読む。メモリ版と Cosmos 版が同じメソッドを持つ。
//   loadTiles(country, tiles, minLevel)  タイル id の一覧(同じ段)に含まれる拠点。レベルが minLevel 以上のもの
//   loadNode(id) / saveNode(doc)          拠点 1 件
//   nearestMasters(country, lat, lon, k)  周辺の固定拠点(プレイヤーの拠点の接続先)
//   countNodes() / seedNodes(docs)        初回のシード
//   loadPlayer(id) / findPlayerByToken(token) / savePlayer(doc) / topPlayers(n)
//   loadQuestion(nodeId, level)           固定問題(フェーズ 2)
//   countRegions() / seedRegions(docs) / loadRegions() / loadRegion(id) / saveRegion(doc) / loadRegionChildren(parent)
//   countOwners(country, region)          区・市の中のハック可の固定拠点を所有者ごとに数える(地域の支配。第 14 章)
//   searchNodes(country, text, limit)     開始地点の検索(名前の一部。ハック可の公開の固定拠点)
//   countStarters(nodeIds)                各拠点から始めた人数(players.startNodeId)
//   findIdlePlayers(beforeUp) / nodesOwnedBy(playerId) / deleteNode(id) / deletePlayer(id)  休眠アカウントの回収(稼働時計 lastSeenUp で判定)
//   loadMeta(id) / saveMeta(doc)          小さな設定・状態(稼働時計 clock など)
//   topPlayers(n, field, filter)          ランキング(score / points / nodesOwned / weekPoints。filter は { weekKey })
//   topTeams(n) / loadTeam(id) / saveTeam(doc) / deleteTeam(id)  チーム(合計点・累計・拠点数・人数)

const { parseTile, distanceKm, tilesAround, tileOf } = require('./map/geo');

class MemoryStore {
  constructor() {
    this.nodes = new Map();
    this.byTile = new Map(); // タイル id → Set<nodeId>(全段)
    this.players = new Map();
    this.questions = new Map();
    this.regions = new Map();
    this.meta = new Map();
    this.teams = new Map();
  }
  _index(n) {
    for (let z = 0; z <= 4; z++) {
      const t = n[`t${z}`]; if (!t) continue;
      if (!this.byTile.has(t)) this.byTile.set(t, new Set());
      this.byTile.get(t).add(n.id);
    }
  }
  async countNodes() { return this.nodes.size; }
  async seedNodes(docs) { for (const d of docs) { this.nodes.set(d.id, { ...d }); this._index(d); } }
  async loadTiles(country, tiles, minLevel = 1) {
    const out = [];
    for (const t of tiles) {
      for (const id of this.byTile.get(t) || []) {
        const n = this.nodes.get(id);
        if (n && n.country === country && n.level >= minLevel) out.push({ ...n });
      }
    }
    return out;
  }
  async loadNode(id) { const n = this.nodes.get(id); return n ? { ...n } : null; }
  async saveNode(doc) {
    const prev = this.nodes.get(doc.id);
    if (!prev) this._index(doc);
    this.nodes.set(doc.id, { ...doc });
  }
  async nearestMasters(country, lat, lon, k = 2) {
    const cands = await this.loadTiles(country, tilesAround(tileOf(lat, lon, 0), 2), 1);
    return cands.filter((n) => !n.isPlayerNode && n.hackable !== false && n.status === 'public')
      .map((n) => ({ n, d: distanceKm({ lat, lon }, n) })).sort((a, b) => a.d - b.d).slice(0, k).map((x) => x.n);
  }
  async loadPlayer(id) { const p = this.players.get(id); return p ? { ...p } : null; }
  async findPlayerByToken(token) { for (const p of this.players.values()) if (p.token === token) return { ...p }; return null; }
  async savePlayer(doc) { this.players.set(doc.id, { ...doc }); }
  async topPlayers(n = 15, field = 'score', filter = {}) {
    let list = [...this.players.values()];
    if (filter.weekKey) list = list.filter((p) => p.weekKey === filter.weekKey);
    return list.sort((a, b) => (b[field] || 0) - (a[field] || 0) || (b.points || 0) - (a.points || 0)).slice(0, n).map((p) => ({ ...p }));
  }
  async topTeams(n = 15) {
    const agg = new Map();
    for (const p of this.players.values()) {
      if (!p.team) continue;
      const t = agg.get(p.team) || { team: p.team, score: 0, points: 0, nodes: 0, members: 0 };
      t.score += p.score || 0; t.points += p.points || 0; t.nodes += p.nodesOwned || 0; t.members++;
      agg.set(p.team, t);
    }
    return [...agg.values()].sort((a, b) => b.score - a.score || b.points - a.points).slice(0, n);
  }
  async loadTeam(id) { const t = this.teams.get(id); return t ? { ...t } : null; }
  async teamMembers(teamId, n = 20) { return [...this.players.values()].filter((p) => p.team === teamId).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(0, n).map((p) => ({ ...p })); }
  async saveTeam(doc) { this.teams.set(doc.id, { ...doc }); }
  async deleteTeam(id) { this.teams.delete(id); }
  async loadQuestion(nodeId, level) { return this.questions.get(`${nodeId}:${level}`) || null; }
  // ---------- 地域 ----------
  async countRegions() { return this.regions.size; }
  async seedRegions(docs) { for (const d of docs) this.regions.set(d.id, { ...d }); }
  async loadRegions() { return [...this.regions.values()].map((r) => ({ ...r })); }
  async loadRegion(id) { const r = this.regions.get(id); return r ? { ...r } : null; }
  async saveRegion(doc) { this.regions.set(doc.id, { ...doc }); }
  async loadRegionChildren(parent) { return [...this.regions.values()].filter((r) => r.parent === parent).map((r) => ({ ...r })); }
  async searchNodes(country, text, limit = 10) {
    return [...this.nodes.values()]
      .filter((n) => n.country === country && !n.isPlayerNode && n.hackable !== false && n.status === 'public' && n.name.includes(text))
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name, 'ja')).slice(0, limit).map((n) => ({ ...n }));
  }
  async findIdlePlayers(beforeUp) { return [...this.players.values()].filter((p) => Number.isFinite(p.lastSeenUp) && p.lastSeenUp < beforeUp && !p.plan).map((p) => ({ ...p })); }
  async loadMeta(id) { const m = this.meta.get(id); return m ? { ...m } : null; }
  async saveMeta(doc) { this.meta.set(doc.id, { ...doc }); }
  async nodesOwnedBy(playerId) { return [...this.nodes.values()].filter((n) => n.owner === playerId).map((n) => ({ ...n })); }
  async deleteNode(id) { const n = this.nodes.get(id); if (!n) return; for (let z = 0; z <= 4; z++) { const s = this.byTile.get(n[`t${z}`]); if (s) s.delete(id); } this.nodes.delete(id); }
  async deletePlayer(id) { this.players.delete(id); }
  async countStarters(nodeIds) {
    const want = new Set(nodeIds); const out = {};
    for (const p of this.players.values()) if (p.startNodeId && want.has(p.startNodeId)) out[p.startNodeId] = (out[p.startNodeId] || 0) + 1;
    return out;
  }
  async countOwners(country, region) {
    let total = 0; const byOwner = {};
    for (const n of this.nodes.values()) {
      if (n.country !== country || n.region !== region || n.isPlayerNode || n.hackable === false || n.status !== 'public') continue;
      total++; if (n.owner) byOwner[n.owner] = (byOwner[n.owner] || 0) + 1;
    }
    return { total, byOwner };
  }
}

function createStore() {
  // STORE=memory なら .env があってもメモリ版(手元の見た目の確認用。本番 DB に書かない)
  if (process.env.STORE === 'memory') return new MemoryStore();
  // Cosmos 版: 環境変数 COSMOS_CONNECTION_STRING があれば server/store-cosmos.js を使う
  if (process.env.COSMOS_CONNECTION_STRING) {
    const { CosmosStore } = require('./store-cosmos');
    return new CosmosStore({
      connectionString: process.env.COSMOS_CONNECTION_STRING,
      database: process.env.COSMOS_DATABASE || 'packet-conquest',
    });
  }
  return new MemoryStore();
}

module.exports = { MemoryStore, createStore, parseTile };
