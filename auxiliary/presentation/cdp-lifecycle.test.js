#!/usr/bin/env node
'use strict';
/*
 * Raw protocol regression for the dependency-free CDP client: a target closing
 * mid-command must reject instead of hanging, and 64-bit WebSocket frame lengths
 * must work in both directions.
 */
const net = require('net');
const crypto = require('crypto');
const { connect } = require('./test-helpers/cdp');

function serverFrame(value) {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  let head;
  if (data.length < 126) {
    head = Buffer.from([0x81, data.length]);
  } else if (data.length <= 0xffff) {
    head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([head, data]);
}

function readClientFrame(buf) {
  if (buf.length < 2) return null;
  const masked = !!(buf[1] & 0x80);
  let len = buf[1] & 0x7f, offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); offset = 10;
  }
  const maskBytes = masked ? 4 : 0;
  if (buf.length < offset + maskBytes + len) return null;
  let payload = buf.slice(offset + maskBytes, offset + maskBytes + len);
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    const plain = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) plain[i] = payload[i] ^ mask[i % 4];
    payload = plain;
  }
  return { payload, rest: buf.slice(offset + maskBytes + len) };
}

function timeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function main() {
  let connection = 0;
  const server = net.createServer((socket) => {
    const number = ++connection;
    let upgraded = false, buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end).toString('latin1');
        const match = /^Sec-WebSocket-Key:\s*(.+)$/mi.exec(head);
        if (!match) return socket.destroy();
        const accept = crypto.createHash('sha1')
          .update(match[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '', '',
        ].join('\r\n'));
        upgraded = true;
        buf = buf.slice(end + 4);
      }
      const frame = readClientFrame(buf);
      if (!frame) return;
      buf = frame.rest;
      if (number === 1) {
        socket.destroy();
        return;
      }
      const request = JSON.parse(frame.payload.toString('utf8'));
      const sentLength = request.params && request.params.payload
        ? request.params.payload.length : 0;
      socket.write(serverFrame({
        id: request.id,
        result: { sentLength, padding: 'x'.repeat(70000) },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const checks = [];
  const check = (description, condition) => checks.push({ description, ok: !!condition });
  try {
    const first = await connect(`ws://127.0.0.1:${port}/devtools/page/closing`);
    let rejected = false;
    try {
      await timeout(first.send('Runtime.neverReplies'), 1000);
    } catch (err) {
      rejected = /closed|socket|ECONN/i.test(err.message);
    }
    check('a target close rejects an in-flight command instead of hanging', rejected);

    const second = await connect(`ws://127.0.0.1:${port}/devtools/page/wide`);
    const reply = await timeout(second.send('Runtime.wide', { payload: 'y'.repeat(70000) }), 2000);
    check('client requests larger than 65535 bytes use a valid 64-bit frame',
      reply.result.sentLength === 70000);
    check('server replies larger than 65535 bytes are decoded intact',
      reply.result.padding.length === 70000);
    second.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}
main().catch((err) => { console.error(err.stack || err); process.exit(1); });
