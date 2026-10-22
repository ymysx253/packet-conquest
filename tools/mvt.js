'use strict';
// Mapbox Vector Tile(pbf)を読む小さな部品(2026-10-22。川の取り込み tools/import-rivers.js で国土地理院の最適化ベクトルタイルを読むのに使う)。
// npm のパッケージを足さないため、使う分だけ(層・地物・属性・線と面の座標)を自前で読む。gzip されたタイルは先にほどく。
//
// 使い方: const { decodeTile } = require('./mvt');
//   decodeTile(buf, z, x, y) → [{ name, features: [{ type: 1 点 | 2 線 | 3 面, props, rings: [[[経度, 緯度], …], …] }] }]
//   座標はタイルの中の位置(extent 分の 1)を経度・緯度に直したもの(Web メルカトル)
const zlib = require('zlib');

// ---------- protobuf の最小限の読み手 ----------
function reader(buf, pos = 0, end = buf.length) {
  return {
    pos, end,
    more() { return this.pos < this.end; },
    varint() { let v = 0, s = 0, b; do { b = buf[this.pos++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return v; },
    key() { const k = this.varint(); return { field: Math.floor(k / 8), wire: k & 7 }; },
    bytes() { const n = this.varint(); const r = reader(buf, this.pos, this.pos + n); this.pos += n; return r; },
    string() { const n = this.varint(); const s = buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return s; },
    skip(wire) { if (wire === 0) this.varint(); else if (wire === 1) this.pos += 8; else if (wire === 2) this.pos += this.varint(); else if (wire === 5) this.pos += 4; else throw new Error(`知らない wire type ${wire}`); },
    packed() { const r = this.bytes(), out = []; while (r.more()) out.push(r.varint()); return out; },
    double() { const v = buf.readDoubleLE(this.pos); this.pos += 8; return v; },
    float() { const v = buf.readFloatLE(this.pos); this.pos += 4; return v; },
  };
}
const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function readValue(r) {
  let v = null;
  while (r.more()) {
    const { field, wire } = r.key();
    if (field === 1) v = r.string();
    else if (field === 2) v = r.float();
    else if (field === 3) v = r.double();
    else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = zigzag(r.varint());
    else if (field === 7) v = !!r.varint();
    else r.skip(wire);
  }
  return v;
}

// 線と面の命令(MoveTo / LineTo / ClosePath)を輪の並びにする
function geometry(cmds) {
  const rings = []; let cur = null, x = 0, y = 0, i = 0;
  while (i < cmds.length) {
    const c = cmds[i++], id = c & 7, count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(cmds[i++]); y += zigzag(cmds[i++]);
        if (id === 1) { cur = [[x, y]]; rings.push(cur); } else cur.push([x, y]);
      }
    } else if (id === 7 && cur && cur.length) cur.push([cur[0][0], cur[0][1]]);
  }
  return rings;
}

function decodeTile(buf0, z, tx, ty) {
  const buf = buf0[0] === 0x1f && buf0[1] === 0x8b ? zlib.gunzipSync(buf0) : buf0;
  const r = reader(buf), layers = [];
  while (r.more()) {
    const { field, wire } = r.key();
    if (field !== 3) { r.skip(wire); continue; }
    const L = r.bytes(); let name = '', extent = 4096; const keys = [], values = [], feats = [];
    while (L.more()) {
      const k = L.key();
      if (k.field === 1) name = L.string();
      else if (k.field === 2) feats.push(L.bytes());
      else if (k.field === 3) keys.push(L.string());
      else if (k.field === 4) values.push(readValue(L.bytes()));
      else if (k.field === 5) extent = L.varint();
      else L.skip(k.wire);
    }
    const n = 2 ** z;
    const toLL = ([px, py]) => {
      const lon = ((tx + px / extent) / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) * 180) / Math.PI;
      return [lon, lat];
    };
    const features = feats.map((F) => {
      let type = 0, tags = [], cmds = [];
      while (F.more()) {
        const k = F.key();
        if (k.field === 2) tags = F.packed();
        else if (k.field === 3) type = F.varint();
        else if (k.field === 4) cmds = F.packed();
        else F.skip(k.wire);
      }
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      return { type, props, rings: geometry(cmds).map((ring) => ring.map(toLL)) };
    });
    layers.push({ name, extent, features });
  }
  return layers;
}

module.exports = { decodeTile };
