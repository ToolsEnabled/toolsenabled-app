#!/usr/bin/env node
'use strict';
/*
 * cdp.js — minimal raw CDP (Chrome DevTools Protocol) client.
 *
 * Extracted after being independently rewritten from scratch in at least 6
 * passes verifying frontend changes (app.js/studio.js) against a real
 * running headless Chrome: same ~100 lines of WebSocket framing retyped
 * each time, with the same small mistakes occasionally recurring along the
 * way (e.g. POST /json/new getting rejected by newer Chrome with "unsafe
 * HTTP verb", it wants PUT). No puppeteer/ws package, matching this
 * project's own "Node built-ins only" convention (see agents.js) — just raw
 * WebSocket framing over `net`.
 *
 * Usage:
 *   const { openTarget, evalJs } = require('./test-helpers/cdp');
 *   const target = await openTarget(9222, 'http://127.0.0.1:4599/studio');
 *   try {
 *     const title = await evalJs(target, 'document.title');
 *   } finally {
 *     await target.closeTarget(); // closes the tab and its SSE viewer
 *   }
 *
 * This module only SPEAKS the protocol once a --remote-debugging-port is
 * already up; it does not launch or kill Chrome itself. That stays the
 * caller's job, deliberately: capture the exact spawned pid (e.g. via
 * `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` matching the
 * chosen port in its own command line) and kill only that pid when done,
 * never `taskkill /IM chrome.exe` — that kills every Chrome window on the
 * machine, a documented past mistake in this project.
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');

// Low-level: upgrade an http(s) URL's ws:// counterpart into a raw CDP
// connection, returning {send(method, params), close()}. send() resolves
// with the raw CDP response message once its id comes back and rejects if the
// target/socket closes first.
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const socket = net.connect(u.port, u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write([
        `GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.hostname}:${u.port}`,
        'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13', '', ''
      ].join('\r\n'));
    });
    let buf = Buffer.alloc(0), upgraded = false, msgId = 1;
    let connectionSettled = false, closed = false;
    const pending = new Map();

    function send(method, params) {
      return new Promise((res, rej) => {
        if (closed || socket.destroyed) {
          rej(new Error(`CDP connection is closed (${method})`));
          return;
        }
        const id = msgId++;
        pending.set(id, { resolve: res, reject: rej, method });
        try {
          writeFrame(JSON.stringify({ id, method, params: params || {} }));
        } catch (err) {
          pending.delete(id);
          rej(err);
        }
      });
    }
    function writeFrame(payload, opcode) {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
      const maskKey = crypto.randomBytes(4);
      let header;
      if (data.length < 126) {
        header = Buffer.alloc(2); header[1] = 0x80 | data.length;
      } else if (data.length <= 0xffff) {
        header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2);
      } else {
        header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2);
      }
      header[0] = 0x80 | (opcode == null ? 0x1 : opcode);
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ maskKey[i % 4];
      socket.write(Buffer.concat([header, maskKey, masked]));
    }
    function failPending(err) {
      for (const item of pending.values()) item.reject(err);
      pending.clear();
    }
    function failConnection(err) {
      const error = err instanceof Error ? err : new Error(String(err || 'CDP connection closed'));
      if (!upgraded && !connectionSettled) {
        connectionSettled = true;
        reject(error);
      }
      failPending(error);
    }
    function close() {
      if (closed) return;
      closed = true;
      failPending(new Error('CDP connection closed by client'));
      socket.end();
    }

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const head = buf.slice(0, headerEnd).toString('latin1');
        if (!/^HTTP\/1\.[01] 101\b/.test(head)) {
          failConnection(new Error(`CDP WebSocket upgrade failed: ${head.split('\r\n')[0] || 'empty response'}`));
          socket.destroy();
          return;
        }
        upgraded = true;
        buf = buf.slice(headerEnd + 4);
        connectionSettled = true;
        resolve({ send, close });
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = !!(buf[1] & 0x80);
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2); offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          const wide = buf.readBigUInt64BE(2);
          if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
            failConnection(new Error('CDP WebSocket frame is too large'));
            socket.destroy();
            return;
          }
          len = Number(wide); offset = 10;
        }
        const maskOffset = masked ? 4 : 0;
        if (buf.length < offset + maskOffset + len) break;
        let payload = buf.slice(offset + maskOffset, offset + maskOffset + len);
        if (masked) {
          const mask = buf.slice(offset, offset + 4);
          const plain = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) plain[i] = payload[i] ^ mask[i % 4];
          payload = plain;
        }
        buf = buf.slice(offset + maskOffset + len);
        if (opcode === 0x8) {
          closed = true;
          failPending(new Error('CDP target closed before replying'));
          socket.end();
          continue;
        }
        if (opcode === 0x9) {
          try { writeFrame(payload, 0xA); } catch (_) {}
          continue;
        }
        if (opcode !== 0x1) continue;
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.id && pending.has(msg.id)) {
            const item = pending.get(msg.id);
            pending.delete(msg.id);
            item.resolve(msg);
          }
        } catch (_) {}
      }
    });
    socket.on('error', (err) => failConnection(err));
    socket.on('close', () => {
      closed = true;
      failConnection(new Error('CDP connection closed before the command replied'));
    });
  });
}

function httpRequest(url, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: method || 'GET' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function httpPut(url) {
  const r = await httpRequest(url, 'PUT');
  if (r.status < 200 || r.status >= 300) throw new Error(`DevTools HTTP ${r.status}: ${r.body}`);
  return r.body;
}

async function closeTarget(devtoolsPort, targetId) {
  const r = await httpRequest(`http://127.0.0.1:${devtoolsPort}/json/close/${encodeURIComponent(targetId)}`, 'GET');
  if (r.status === 404) return false; // already gone is already clean
  if (r.status < 200 || r.status >= 300) throw new Error(`Could not close DevTools target (${r.status}): ${r.body}`);
  return true;
}

// Opens a new tab at targetUrl via the devtools HTTP endpoint, connects to
// it over CDP, enables the Page domain, and waits briefly for the page's
// own scripts to finish their initial run before handing back the
// connection. settleMs defaults to 1500 (long enough for this project's own
// pages to boot + make their first fetch/SSE connect in every prior pass
// that timed it by hand); pass 0 to skip the wait entirely.
async function openTarget(devtoolsPort, targetUrl, settleMs) {
  const info = JSON.parse(await httpPut(`http://127.0.0.1:${devtoolsPort}/json/new?${targetUrl}`));
  const ws = await connect(info.webSocketDebuggerUrl);
  ws.targetId = info.id;
  ws.devtoolsPort = devtoolsPort;
  let closing = null;
  ws.closeTarget = () => {
    if (!closing) {
      closing = closeTarget(devtoolsPort, info.id).finally(() => ws.close());
    }
    return closing;
  };
  try {
    await ws.send('Page.enable');
    const wait = settleMs == null ? 1500 : settleMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  } catch (err) {
    await ws.closeTarget().catch(() => {});
    throw err;
  }
  return ws;
}

// Runtime.evaluate wrapper: throws on a real page-side exception (a typo'd
// expression, a thrown error) instead of silently returning undefined, and
// unwraps returnByValue's nested result shape down to the plain JS value.
async function evalJs(ws, expression) {
  const r = await ws.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.error) throw new Error(`CDP Runtime.evaluate failed: ${JSON.stringify(r.error)}`);
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}

module.exports = { connect, httpPut, closeTarget, openTarget, evalJs };
