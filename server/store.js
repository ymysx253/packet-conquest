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

const { parseTile, distanceKm, tilesAround, tileOf } = require('./map/geo');

class MemoryStore {
  constructor() {
    this.nodes = new Map();
    this.byTile = new Map(); // タイル id → Set<nodeId>(全段)
    this.players = new Map();
    this.questions = new Map();
    this.regions = new Map();
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
  async topPlayers(n = 15) { return [...this.players.values()].sort((a, b) => (b.score || 0) - (a.score || 0) || (b.points || 0) - (a.points || 0)).slice(0, n).map((p) => ({ ...p })); }
  async loadQuestion(nodeId, level) { return this.questions.get(`${nodeId}:${level}`) || null; }
  // ---------- 地域 ----------
  async countRegions() { return this.regions.size; }
  async seedRegions(docs) { for (const d of docs) this.regions.set(d.id, { ...d }); }
  async loadRegions() { return [...this.regions.values()].map((r) => ({ ...r })); }
  async loadRegion(id) { const r = this.regions.get(id); return r ? { ...r } : null; }
  async saveRegion(doc) { this.regions.set(doc.id, { ...doc }); }
  async loadRegionChildren(parent) { return [...this.regions.values()].filter((r) => r.parent === parent).map((r) => ({ ...r })); }
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
