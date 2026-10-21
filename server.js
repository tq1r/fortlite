#!/usr/bin/env node
/* ============================================================
   FORTLITE — server.js
   Zero-dependency multiplayer server:
     • HTTP static file server (serves ./public)
     • WebSocket server (hand-rolled, no npm packages)
     • Authoritative game simulation @ 20 Hz
     • Fortnite-style building, harvesting, loot, storm, bots
   Run:  node server.js          (http://localhost:3000)
         PORT=8080 node server.js
         node server.js --bots 8 --fast
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./shared.js');
const { createGame } = require('./core.js');

// ---------------- config (command-line flags) ----------------
const args = process.argv.slice(2);
const FLAG = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  return (v && !v.startsWith('--')) ? (isNaN(+v) ? v : +v) : true;
};
const PORT = process.env.PORT || FLAG('port', 3000);
const FAST = !!FLAG('fast', false);
const NO_STORM = !!FLAG('nostorm', false);
const NO_BUS = !!FLAG('nobus', false);
let BOT_FILL = FLAG('bots', S.BOT_FILL);
if (typeof BOT_FILL !== 'number') BOT_FILL = S.BOT_FILL;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const game = createGame({ fast: FAST, nostorm: NO_STORM, nobus: NO_BUS, bots: BOT_FILL });

// ============================================================
//  HTTP static server
// ============================================================
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (urlPath === '/' || urlPath === '/shared.js') {
    const f = urlPath === '/' ? path.join(PUB, 'index.html') : path.join(__dirname, 'shared.js');
    return fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': urlPath === '/' ? MIME['.html'] : MIME['.js'], 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }
  const file = path.normalize(path.join(PUB, urlPath));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ============================================================
//  Minimal WebSocket server (RFC 6455, text frames)
// ============================================================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConn {
  constructor(socket) {
    this.sock = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.alive = true;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', d => this._onData(d));
    socket.on('error', () => this._close());
    socket.on('close', () => this._close());
    socket.on('end', () => this._close());
  }
  _onData(chunk) {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 1 << 20) return this._close(); // 1MB guard
    while (true) {
      const frame = this._readFrame();
      if (!frame) break;
      const { op, fin, payload } = frame;
      if (op === 0x8) { // close
        this.sendRaw(0x8, payload.slice(0, 2));
        return this._close();
      } else if (op === 0x9) { // ping -> pong
        this.sendRaw(0xA, payload);
      } else if (op === 0xA) { // pong
        this.alive = true;
      } else if (op === 0x1 || op === 0x2 || op === 0x0) { // text / binary / continuation
        if (!fin) {
          this.frag = this.frag ? Buffer.concat([this.frag, payload]) : payload;
          if (this.frag.length > 1 << 20) return this._close();
          continue;
        }
        const full = this.frag ? Buffer.concat([this.frag, payload]) : payload;
        this.frag = null;
        if (this.onmessage) {
          try { this.onmessage(full.toString('utf8')); }
          catch (e) { log('onmessage error:', e.message); }
        }
      }
    }
  }
  _readFrame() {
    const buf = this.buf;
    if (buf.length < 2) return null;
    const b0 = buf[0], b1 = buf[1];
    const fin = !!(b0 & 0x80), op = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return null; const big = buf.readBigUInt64BE(2); if (big > 1n << 20) { this._close(); return null; } len = Number(big); off = 10; }
    let mask = null;
    if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
    if (buf.length < off + len) return null;
    let payload = buf.slice(off, off + len);
    if (mask) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this.buf = buf.slice(off + len);
    return { op, fin, payload };
  }
  sendRaw(op, payload) {
    if (this.closed || this.sock.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.allocUnsafe(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.allocUnsafe(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | op;
    this.sock.write(Buffer.concat([header, payload]));
  }
  send(str) { this.sendRaw(0x1, Buffer.from(str, 'utf8')); }
  ping() { this.alive = false; this.sendRaw(0x9, Buffer.alloc(0)); }
  slow() { return this.sock.bufferSize > 4 * 1024 * 1024; }
  _close() {
    if (this.closed) return;
    this.closed = true;
    try { this.sock.destroy(); } catch (_) { }
    if (this.onclose) this.onclose();
  }
}


httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || !req.headers.upgrade || req.headers.upgrade.toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  game.acceptSocket(new WSConn(socket));
});

// ============================================================
//  GO
// ============================================================
httpServer.listen(PORT, '0.0.0.0', () => {
  log(`FORTLITE server running on http://0.0.0.0:${PORT}`);
  log(`  bots fill to: ${BOT_FILL} players | fast mode: ${FAST}`);
  game.start();
});
process.on('uncaughtException', e => console.error('UNCAUGHT', e));
