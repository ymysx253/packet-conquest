'use strict';
// 保存口の Cosmos DB 版(docs/DB.md)。メモリ版(store.js)と同じメソッドを持つ。
//   データベース: packet-conquest(手元は pc-dev)。スループットはデータベース全体で共有 1000 RU/s
//   nodes: 階層パーティションキー [/country, /region] / regions: /parent / players: /id / questions: /nodeId
// 全件をまとめて読まず、country + タイル id で画面の範囲だけ読む。
const { CosmosClient } = require('@azure/cosmos');
const { tilesAround, tileOf, parseTile, distanceKm } = require('./map/geo');

const CONTAINERS = [
  { id: 'nodes', partitionKey: { paths: ['/country', '/region'], kind: 'MultiHash', version: 2 } },
  { id: 'regions', partitionKey: { paths: ['/parent'] } },
  { id: 'players', partitionKey: { paths: ['/id'] } },
  { id: 'questions', partitionKey: { paths: ['/nodeId'] } },
];
const SHARED_RU = 1000;
const CHUNK = 60; // IN 句に並べるタイル数の上限

class CosmosStore {
  constructor({ connectionString, database = 'packet-conquest' }) {
    if (!connectionString) throw new Error('COSMOS_CONNECTION_STRING がありません');
    this.client = new CosmosClient(connectionString);
    this.dbName = database;
    this.ready = null;
  }
  // データベースとコンテナーは「あれば使う、なければ作る」
  async ensure() {
    if (!this.ready) {
      this.ready = (async () => {
        const { database } = await this.client.databases.createIfNotExists({ id: this.dbName, throughput: SHARED_RU });
        this.db = database;
        this.c = {};
        for (const def of CONTAINERS) {
          const { container } = await database.containers.createIfNotExists({ id: def.id, partitionKey: def.partitionKey });
          this.c[def.id] = container;
        }
      })();
    }
    return this.ready;
  }
  async query(container, spec, options = {}) {
    await this.ensure();
    const { resources } = await this.c[container].items.query(spec, options).fetchAll();
    return resources;
  }
  strip(doc) { if (!doc) return doc; const { _rid, _self, _etag, _attachments, _ts, ...rest } = doc; return rest; }

  // ---------- 拠点 ----------
  async countNodes() {
    const [n] = await this.query('nodes', { query: 'SELECT VALUE COUNT(1) FROM c' });
    return n || 0;
  }
  async seedNodes(docs) {
    await this.ensure();
    // 同時 10 件ずつ(無料枠の 1000 RU/s に収める。SDK が 429 を自動で再試行する)
    for (let i = 0; i < docs.length; i += 10) {
      await Promise.all(docs.slice(i, i + 10).map((d) => this.c.nodes.items.upsert(d)));
    }
  }
  async loadTiles(country, tiles, minLevel = 1) {
    if (!tiles.length) return [];
    const z = (parseTile(tiles[0]) || { z: 0 }).z;
    const field = `t${z}`;
    const out = [];
    for (let i = 0; i < tiles.length; i += CHUNK) {
      const chunk = tiles.slice(i, i + CHUNK);
      const rows = await this.query('nodes', {
        // 階層パーティションキーの前半(country)だけを options.partitionKey に渡すと 400 になるので、WHERE 句の c.country で絞る
        query: `SELECT * FROM c WHERE c.country = @country AND ARRAY_CONTAINS(@tiles, c.${field}) AND c.level >= @min`,
        parameters: [{ name: '@country', value: country }, { name: '@tiles', value: chunk }, { name: '@min', value: minLevel }],
      });
      out.push(...rows.map((r) => this.strip(r)));
    }
    return out;
  }
  async loadNode(id) {
    const rows = await this.query('nodes', { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] });
    return rows.length ? this.strip(rows[0]) : null;
  }
  async saveNode(doc) {
    await this.ensure();
    await this.c.nodes.items.upsert(doc);
  }
  async nearestMasters(country, lat, lon, k = 2) {
    const cands = await this.loadTiles(country, tilesAround(tileOf(lat, lon, 0), 2), 1);
    return cands.filter((n) => !n.isPlayerNode && n.hackable !== false && n.status === 'public')
      .map((n) => ({ n, d: distanceKm({ lat, lon }, n) })).sort((a, b) => a.d - b.d).slice(0, k).map((x) => x.n);
  }

  // ---------- 地域 ----------
  async seedRegions(docs) {
    await this.ensure();
    for (let i = 0; i < docs.length; i += 10) await Promise.all(docs.slice(i, i + 10).map((d) => this.c.regions.items.upsert(d)));
  }
  async loadRegions() { return (await this.query('regions', { query: 'SELECT * FROM c' })).map((r) => this.strip(r)); }
  async countRegions() { const [n] = await this.query('regions', { query: 'SELECT VALUE COUNT(1) FROM c' }); return n || 0; }
  async loadRegion(id) {
    const rows = await this.query('regions', { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] });
    return rows.length ? this.strip(rows[0]) : null;
  }
  async saveRegion(doc) { await this.ensure(); await this.c.regions.items.upsert(doc); }
  async loadRegionChildren(parent) {
    const rows = await this.query('regions', { query: 'SELECT * FROM c WHERE c.parent = @p', parameters: [{ name: '@p', value: parent }] }, { partitionKey: parent });
    return rows.map((r) => this.strip(r));
  }
  // 開始地点の検索(名前の一部)。country は WHERE 句で絞る(階層キーの前半だけを options に渡すと 400 になる)
  async searchNodes(country, text, limit = 10) {
    const rows = await this.query('nodes', {
      query: 'SELECT TOP @n c.id, c.name, c.area, c.level, c.genre, c.lat, c.lon FROM c WHERE c.country = @c AND c.isPlayerNode = false AND c.hackable = true AND c.status = "public" AND CONTAINS(c.name, @q) ORDER BY c.level DESC',
      parameters: [{ name: '@n', value: limit }, { name: '@c', value: country }, { name: '@q', value: text }],
    });
    return rows;
  }
  // 休眠アカウントの回収
  async findIdlePlayers(before) {
    const rows = await this.query('players', { query: 'SELECT * FROM c WHERE c.lastSeen < @t AND (NOT IS_DEFINED(c.plan) OR IS_NULL(c.plan))', parameters: [{ name: '@t', value: before }] });
    return rows.map((r) => this.strip(r));
  }
  async nodesOwnedBy(playerId) {
    const rows = await this.query('nodes', { query: 'SELECT * FROM c WHERE c.owner = @id', parameters: [{ name: '@id', value: playerId }] });
    return rows.map((r) => this.strip(r));
  }
  async deleteNode(id) {
    const n = await this.loadNode(id);
    if (!n) return;
    try { await this.c.nodes.item(id, [n.country, n.region]).delete(); } catch (e) { if (e.code !== 404) throw e; }
  }
  async deletePlayer(id) {
    await this.ensure();
    try { await this.c.players.item(id, id).delete(); } catch (e) { if (e.code !== 404) throw e; }
  }
  async countStarters(nodeIds) {
    if (!nodeIds.length) return {};
    const rows = await this.query('players', {
      query: 'SELECT c.startNodeId, COUNT(1) AS n FROM c WHERE ARRAY_CONTAINS(@ids, c.startNodeId) GROUP BY c.startNodeId',
      parameters: [{ name: '@ids', value: nodeIds }],
    });
    const out = {}; for (const r of rows) out[r.startNodeId] = r.n; return out;
  }
  // 区・市の中のハック可の固定拠点を所有者ごとに数える(地域の支配。第 14 章)
  async countOwners(country, region) {
    const rows = await this.query('nodes', {
      query: 'SELECT c.owner, COUNT(1) AS n FROM c WHERE c.country = @c AND c.region = @r AND c.isPlayerNode = false AND c.hackable = true AND c.status = "public" GROUP BY c.owner',
      parameters: [{ name: '@c', value: country }, { name: '@r', value: region }],
    });
    let total = 0; const byOwner = {};
    for (const row of rows) { total += row.n; if (row.owner) byOwner[row.owner] = (byOwner[row.owner] || 0) + row.n; }
    return { total, byOwner };
  }

  // ---------- プレイヤー ----------
  async loadPlayer(id) {
    await this.ensure();
    try { const { resource } = await this.c.players.item(id, id).read(); return this.strip(resource) || null; } catch (e) { if (e.code === 404) return null; throw e; }
  }
  async findPlayerByToken(token) {
    const rows = await this.query('players', { query: 'SELECT * FROM c WHERE c.token = @t', parameters: [{ name: '@t', value: token }] });
    return rows.length ? this.strip(rows[0]) : null;
  }
  async savePlayer(doc) {
    await this.ensure();
    await this.c.players.items.upsert(doc);
  }
  async topPlayers(n = 15) {
    const rows = await this.query('players', { query: 'SELECT TOP @n * FROM c ORDER BY c.score DESC', parameters: [{ name: '@n', value: n }] });
    return rows.map((r) => this.strip(r));
  }

  // ---------- 固定問題(フェーズ 2) ----------
  async loadQuestion(nodeId, level) {
    const rows = await this.query('questions', {
      query: 'SELECT TOP 1 * FROM c WHERE c.nodeId = @n AND c.level = @l AND c.status = "active"',
      parameters: [{ name: '@n', value: nodeId }, { name: '@l', value: level }],
    }, { partitionKey: nodeId });
    return rows.length ? this.strip(rows[0]) : null;
  }
}

module.exports = { CosmosStore, CONTAINERS };
