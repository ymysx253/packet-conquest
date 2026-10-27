'use strict';
// 保存口の Cosmos DB 版(docs/DB.md)。メモリ版(store.js)と同じメソッドを持つ。
//   データベース: packet-conquest(手元は pc-dev)。スループットはデータベース全体で共有 1000 RU/s
//   nodes: 階層パーティションキー [/country, /region] / regions: /parent / players: /id / questions: /nodeId
// 全件をまとめて読まず、country + タイル id で画面の範囲だけ読む。
const { CosmosClient } = require('@azure/cosmos');
const { tilesAround, tileOf, parseTile, distanceKm } = require('./map/geo');
const { dayOf } = require('./events');

const CONTAINERS = [
  { id: 'nodes', partitionKey: { paths: ['/country', '/region'], kind: 'MultiHash', version: 2 } },
  { id: 'regions', partitionKey: { paths: ['/parent'] } },
  { id: 'players', partitionKey: { paths: ['/id'] } },
  { id: 'questions', partitionKey: { paths: ['/nodeId'] } },
  { id: 'meta', partitionKey: { paths: ['/id'] } }, // 小さな設定・状態(稼働時計 clock)。無ければ起動時に作る(共有スループット)
  { id: 'teams', partitionKey: { paths: ['/id'] } }, // チーム(第 3.11 節)。無ければ起動時に作る
  { id: 'chats', partitionKey: { paths: ['/room'] }, defaultTtl: 604800 }, // チャット(2026-10-21)。部屋(all / team:<id> / dm:<id>|<id>)ごと。7 日で自動で消える
  { id: 'routes', partitionKey: { paths: ['/source'] } }, // 航路の記録(docs/DATA-FORMAT.md 第 5・7 章)。管理と監査用で、ゲームは拠点の要約を使う。出典ごとに差し替える
  // 出来事の記録(docs/LOGS.md 第 3・7.7 節)。既定 TTL 90 日(ドキュメントの ttl で種類ごとに上書き)、インデックスは絞り込みに使う項目だけ。
  // createIfNotExists は既にあるコンテナーの設定を変えないので、本番(作成済み)の TTL とインデックスはポータルから合わせる(LOGS.md 7.7)
  {
    id: 'events', partitionKey: { paths: ['/day'] }, defaultTtl: 7776000,
    indexingPolicy: {
      indexingMode: 'consistent', automatic: true,
      includedPaths: ['/day/?', '/kind/?', '/at/?', '/playerId/?', '/teamId/?', '/nodeId/?', '/regionId/?', '/level/?', '/ok/?', '/sec/?', '/src/?'].map((path) => ({ path })),
      excludedPaths: [{ path: '/*' }],
      compositeIndexes: [
        [{ path: '/day', order: 'ascending' }, { path: '/kind', order: 'ascending' }, { path: '/at', order: 'descending' }],
        [{ path: '/playerId', order: 'ascending' }, { path: '/at', order: 'descending' }],
      ],
    },
  },
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
          const { container } = await database.containers.createIfNotExists({ ...def }); // id / partitionKey / defaultTtl / indexingPolicy
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
        query: `SELECT * FROM c WHERE c.country = @country AND ARRAY_CONTAINS(@tiles, c.${field}) AND ${minLevel === 'top' ? 'c.top = true' : 'c.level >= @min'}`, // top: 日本全体が見える段の拠点(geo.js の MIN_LEVEL_BY_Z)
        parameters: [{ name: '@country', value: country }, { name: '@tiles', value: chunk }, ...(minLevel === 'top' ? [] : [{ name: '@min', value: minLevel }])],
      });
      out.push(...rows.map((r) => this.strip(r)));
    }
    return out;
  }
  // 選んだ拠点のつながり先(名前と位置だけ)。1 回の問い合わせで引く
  async nodesBrief(ids) {
    if (!ids.length) return [];
    return this.query('nodes', { query: 'SELECT c.id, c.name, c.genre, c.lat, c.lon, c.status, c.owner, c.ownerIsTeam, c.isPlayerNode FROM c WHERE ARRAY_CONTAINS(@ids, c.id)', parameters: [{ name: '@ids', value: ids }] });
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
  async findIdlePlayers(beforeUp) {
    // lastSeenUp(稼働時計)が無い古いドキュメントは条件に合わないので対象にならない(次の接続で付く)
    const rows = await this.query('players', { query: 'SELECT * FROM c WHERE c.lastSeenUp < @t AND (NOT IS_DEFINED(c.plan) OR IS_NULL(c.plan))', parameters: [{ name: '@t', value: beforeUp }] });
    return rows.map((r) => this.strip(r));
  }
  async loadMeta(id) {
    await this.ensure();
    try { const { resource } = await this.c.meta.item(id, id).read(); return this.strip(resource) || null; } catch (e) { if (e.code === 404) return null; throw e; }
  }
  async saveMeta(doc) { await this.ensure(); await this.c.meta.items.upsert(doc); }
  async ownedNodes() { // 持ち主のいる拠点を全部(点数の数え直し用。点数に要る項目だけ)
    return this.query('nodes', { query: 'SELECT c.id, c.owner, c.ownerIsTeam, c.isPlayerNode, c["value"], c.defense, c.fortifiedAt FROM c WHERE IS_DEFINED(c.owner) AND NOT IS_NULL(c.owner)' });
  }
  async nodesOwnedBy(playerId) {
    const rows = await this.query('nodes', { query: 'SELECT * FROM c WHERE c.owner = @id', parameters: [{ name: '@id', value: playerId }] });
    return rows.map((r) => this.strip(r));
  }
  // 何人か(自分とチームの仲間)の持つ拠点。縮小表示に必ず出すため(2026-10-19)
  async nodesOwnedByAny(ids, limit = 3000) {
    if (!ids.length) return [];
    const rows = await this.query('nodes', { query: 'SELECT TOP @n * FROM c WHERE ARRAY_CONTAINS(@ids, c.owner)', parameters: [{ name: '@n', value: limit }, { name: '@ids', value: ids }] });
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
  async topPlayers(n = 15, field = 'score', filter = {}) {
    const f = ['score', 'points', 'nodesOwned', 'weekPoints'].includes(field) ? field : 'score';
    const where = filter.weekKey ? ' WHERE c.weekKey = @wk' : '';
    const params = [{ name: '@n', value: n }]; if (filter.weekKey) params.push({ name: '@wk', value: filter.weekKey });
    const rows = await this.query('players', { query: `SELECT TOP @n * FROM c${where} ORDER BY c.${f} DESC`, parameters: params });
    return rows.map((r) => this.strip(r));
  }
  // チームの合計(所属している人の score / points / nodesOwned を足す)
  async topTeams(n = 15) {
    const rows = await this.query('players', {
      query: 'SELECT c.team, SUM(c.score) AS score, SUM(c.points) AS points, SUM(c.nodesOwned) AS nodes, COUNT(1) AS members FROM c WHERE IS_DEFINED(c.team) AND c.team != null GROUP BY c.team',
    });
    return rows.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.points || 0) - (a.points || 0)).slice(0, n);
  }
  // ---------- チャット(server/chat.js) ----------
  async saveChat(doc) { await this.ensure(); await this.c.chats.items.create(doc); }
  async loadChats(room, since, n = 100) {
    const rows = await this.query('chats', { query: 'SELECT TOP @n * FROM c WHERE c.room = @r AND c.at >= @s ORDER BY c.at DESC', parameters: [{ name: '@n', value: n }, { name: '@r', value: room }, { name: '@s', value: since }] }, { partitionKey: room });
    return rows.map((r) => this.strip(r)).reverse();
  }
  async loadChat(room, id) {
    await this.ensure();
    try { const { resource } = await this.c.chats.item(id, room).read(); return this.strip(resource) || null; } catch (e) { if (e.code === 404) return null; throw e; }
  }
  async dmPartners(pid, since) {
    const rows = await this.query('chats', { query: 'SELECT c["from"] AS f, c["to"] AS t FROM c WHERE c.kind = "dm" AND c.at >= @s AND (c["from"] = @p OR c["to"] = @p)', parameters: [{ name: '@s', value: since }, { name: '@p', value: pid }] });
    return [...new Set(rows.map((r) => (r.f === pid ? r.t : r.f)))];
  }
  async loadTeam(id) {
    await this.ensure();
    try { const { resource } = await this.c.teams.item(id, id).read(); return this.strip(resource) || null; } catch (e) { if (e.code === 404) return null; throw e; }
  }
  async saveTeam(doc) { await this.ensure(); await this.c.teams.items.upsert(doc); }
  async teamMembers(teamId, n = 20) {
    const rows = await this.query('players', { query: 'SELECT TOP @n * FROM c WHERE c.team = @t ORDER BY c.createdAt ASC', parameters: [{ name: '@n', value: n }, { name: '@t', value: teamId }] });
    return rows.map((r) => this.strip(r));
  }
  async deleteTeam(id) { await this.ensure(); try { await this.c.teams.item(id, id).delete(); } catch (e) { if (e.code !== 404) throw e; } }

  // ---------- 固定問題(フェーズ 2) ----------
  async loadQuestion(nodeId, level) {
    const rows = await this.query('questions', {
      query: 'SELECT TOP 1 * FROM c WHERE c.nodeId = @n AND c.level = @l AND c.status = "active"',
      parameters: [{ name: '@n', value: nodeId }, { name: '@l', value: level }],
    }, { partitionKey: nodeId });
    return rows.length ? this.strip(rows[0]) : null;
  }

  // ---------- 出来事の記録(docs/LOGS.md) ----------
  async appendEvent(doc) { await this.appendEvents([doc]); }
  // 10 件ずつ並列に upsert(seedNodes と同じ形。件数が増えたら SDK の bulk に替える)
  async appendEvents(docs) {
    await this.ensure();
    for (let i = 0; i < docs.length; i += 10) await Promise.all(docs.slice(i, i + 10).map((d) => this.c.events.items.upsert(d)));
  }
  // ある日の出来事(単一パーティション)。条件は指定されたものだけ付ける
  async eventsByDay(day, { kind, playerId, nodeId, regionId, since, limit = 200 } = {}) {
    const where = ['c.day = @day']; const params = [{ name: '@day', value: day }, { name: '@limit', value: limit }];
    for (const [k, v] of Object.entries({ kind, playerId, nodeId, regionId })) if (v) { where.push(`c.${k} = @${k}`); params.push({ name: `@${k}`, value: v }); }
    if (since) { where.push('c.at >= @since'); params.push({ name: '@since', value: since }); }
    const rows = await this.query('events', { query: `SELECT * FROM c WHERE ${where.join(' AND ')} ORDER BY c.at DESC OFFSET 0 LIMIT @limit`, parameters: params }, { partitionKey: day });
    return rows.map((r) => this.strip(r));
  }
  // ある人の出来事。days は日付の配列か今日からの日数(該当する日のパーティションだけに問い合わせが送られる)
  async eventsOfPlayer(playerId, days = 7, limit = 200) {
    const list = Array.isArray(days) ? days : Array.from({ length: Math.max(1, Number(days) || 7) }, (_, i) => dayOf(Date.now() - i * 24 * 3600 * 1000));
    const rows = await this.query('events', {
      query: 'SELECT * FROM c WHERE ARRAY_CONTAINS(@days, c.day) AND c.playerId = @p ORDER BY c.at DESC OFFSET 0 LIMIT @limit',
      parameters: [{ name: '@days', value: list }, { name: '@p', value: playerId }, { name: '@limit', value: limit }],
    });
    return rows.map((r) => this.strip(r));
  }
  async countEventsByKind(day) {
    const rows = await this.query('events', { query: 'SELECT c.kind, COUNT(1) AS n FROM c WHERE c.day = @day GROUP BY c.kind', parameters: [{ name: '@day', value: day }] }, { partitionKey: day });
    const out = {}; for (const r of rows) out[r.kind] = r.n; return out;
  }
}

module.exports = { CosmosStore, CONTAINERS };
