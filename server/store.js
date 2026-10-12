'use strict';
// 保存口。World はここを通してだけ保存・読み込みを行う。
// いまはメモリだけ(再起動で消える)。手順5で Cosmos DB 版(nodes / players / questions コンテナー)を追加し、
// 環境変数で切り替える。どちらも同じメソッドを持つ。

class MemoryStore {
  constructor() { this.nodes = new Map(); this.players = new Map(); this.questions = new Map(); }
  async loadNodes() { return [...this.nodes.values()]; }
  async loadPlayers() { return [...this.players.values()]; }
  async saveNode(n) { this.nodes.set(n.id, { ...n }); }
  async savePlayer(p) { this.players.set(p.id, { ...p }); }
  // Lv5 以上の固定問題(設計書 8.6)。フェーズ2で中身を作る
  async loadQuestion(nodeId, level) { return this.questions.get(`${nodeId}:${level}`) || null; }
}

function createStore() {
  // 手順5: process.env.COSMOS_CONNECTION_STRING があれば CosmosStore を返す
  return new MemoryStore();
}

module.exports = { MemoryStore, createStore };
