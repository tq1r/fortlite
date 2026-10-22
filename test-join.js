#!/usr/bin/env node
/* Join test: a player who joins while a match is running must stay in the lobby
   (waiting for the next match) and must not be dropped into spectating.
   Starts its own fast server. */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

class WSClient {
  constructor(url, name) {
    this.name = name;
    this.msgs = [];
    this.waiters = [];
    this.closed = false;
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    this.sock = net.connect(+u.port, u.hostname, () => {
      this.sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.buf = Buffer.alloc(0);
    this.handshook = false;
    this.onopen = null;
    this.sock.on('data', d => {
      this.buf = Buffer.concat([this.buf, d]);
      if (!this.handshook) {
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        this.handshook = true;
        this.buf = this.buf.slice(idx + 4);
        if (this.onopen) this.onopen();
      }
      this.parse();
    });
    this.sock.on('close', () => this.closed = true);
    this.sock.on('error', () => this.closed = true);
  }
  parse() {
    while (true) {
      const buf = this.buf;
      if (buf.length < 2) break;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      const payload = buf.slice(off, off + len);
      this.buf = buf.slice(off + len);
      if (op === 1) {
        const m = JSON.parse(payload.toString());
        this.msgs.push(m);
        this.waiters = this.waiters.filter(w => {
          if (w.pred(m)) { w.resolve(m); return false; }
          return true;
        });
      } else if (op === 9) this.sendRaw(0xA, payload);
    }
  }
  sendRaw(op, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.allocUnsafe(2); header[1] = 0x80 | len; }
    else { header = Buffer.allocUnsafe(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    header[0] = 0x80 | op;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  send(o) { this.sendRaw(0x1, Buffer.from(JSON.stringify(o))); }
  wait(pred, timeout = 15000) {
    const existing = this.msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`[${this.name}] timeout waiting`)), timeout);
      this.waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); } });
    });
  }
  last(pred) { const arr = this.msgs.filter(pred); return arr[arr.length - 1]; }
}


let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log('  PASS', l); } else { failed++; console.log('  FAIL:', l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getPort() {
  return new Promise((res, rej) => {
    const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej);
  });
}

async function main() {
  const port = await getPort();
  console.log(`Join test on :${port} (fast, no bots fill beyond the humans)...`);
  const srv = spawn('node', ['server.js', '--port', String(port), '--fast'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
  const url = `ws://127.0.0.1:${port}/ws`;
  try {
    for (let i = 0; i < 50; i++) {
      const up = await new Promise(res => { const r = http.get(`http://127.0.0.1:${port}/health`, x => { x.resume(); res(true); }); r.on('error', () => res(false)); });
      if (up) break;
      await sleep(150);
    }
    const a = new WSClient(url, 'A');
    await new Promise(r => { a.onopen = r; });
    a.send({ t: 'hello', name: 'Alpha' });
    await a.wait(m => m.t === 'start', 20000);
    ok(true, 'first player starts a match');

    const b = new WSClient(url, 'B');
    await new Promise(r => { b.onopen = r; });
    b.send({ t: 'hello', name: 'Bravo' });
    const welcome = await b.wait(m => m.t === 'welcome', 5000);
    ok(welcome.state === 'lobby', 'late joiner is welcomed into the lobby');
    const lob = await b.wait(m => m.t === 'lobby' && m.waiting === true, 5000);
    ok(!!lob, 'late joiner is told it is waiting for the next match');
    await sleep(1500);
    ok(!b.msgs.some(m => m.t === 'start'), 'late joiner is not sent a match start (no spectating)');
    ok(!b.msgs.some(m => m.t === 'snap'), 'late joiner receives no live snapshots yet');
    ok(b.msgs.some(m => m.t === 'lobby' && m.waiting === true && m.state !== 'lobby'), 'waiting flag stays set while the match runs');
    a.sock.destroy(); b.sock.destroy();
  } catch (e) {
    failed++; console.log('  FAIL: exception', e.message);
  } finally {
    srv.kill('SIGTERM');
  }
  console.log(`\n=== JOIN RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}
main();
