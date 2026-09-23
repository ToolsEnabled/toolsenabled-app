#!/usr/bin/env node
'use strict';

/**
 * MCP boundary regressions.
 *
 * These tests use a deliberately unresponsive loopback HTTP server. A model
 * tool call must fail promptly instead of waiting forever, and every document
 * mutation must require the stale-write hash advertised by doc_read/doc_find.
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCUMENT_TOKEN = 'test-document-token-0123456789';
const PASS = [];
const FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function launchMcp(script, port, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCRIBE_PORT: String(port),
      SCRIBE_MCP_TIMEOUT_MS: '150',
      SCRIBE_DOCUMENT_TOKEN: DOCUMENT_TOKEN,
      ...extraEnv,
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  let seq = 0;
  const pending = new Map();
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) {
        for (const [, waiter] of pending) waiter.reject(error);
        pending.clear();
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  const call = (method, params = {}, timeoutMs = 2000) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${script} did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  return {
    child,
    call,
    stderr,
    sendRaw(value) {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          child.stdin.off('drain', onDrain);
          reject(error);
        };
        const onDrain = () => {
          child.stdin.off('error', onError);
          resolve();
        };
        child.stdin.once('error', onError);
        if (child.stdin.write(value)) {
          child.stdin.off('error', onError);
          resolve();
        } else {
          child.stdin.once('drain', onDrain);
        }
      });
    },
    stop() {
      for (const [, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${script} stopped`));
      }
      pending.clear();
      try { child.stdin.end(); } catch (_) {}
      try { child.kill(); } catch (_) {}
    },
  };
}

const resultText = (message) =>
  (((message || {}).result || {}).content || []).map((part) => part.text || '').join('\n');

async function main() {
  const port = await availablePort();
  const sockets = new Set();
  const responseTimers = new Set();
  const requestBodies = [];
  let requests = 0;
  let responseMode = 'hang';
  const server = http.createServer((req, res) => {
    requests++;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => raw += chunk);
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch (_) {}
      requestBodies.push({ path: req.url, body });
      if (responseMode === 'invalid') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (responseMode === 'format-fixture') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          rev: 17,
          result: {
            paragraphs: [{
              pid: 'FORMAT01',
              style: 'Normal',
              text: 'A😀B body',
              hash: 'text01234567',
              format_hash: 'format012345',
              paragraph_format: { b: true, size: 16 },
              runs: [
                { text: 'A😀', b: true, size: 16 },
                { text: 'B body', b: true, size: 16, color: '008000' },
              ],
            }],
          },
        }));
        return;
      }
      if (responseMode === 'oversize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        const block = Buffer.alloc(1024 * 1024, 0x78);
        for (let i = 0; i < 5; i++) res.write(block);
        res.end();
        return;
      }
      if (responseMode === 'drip') {
        res.writeHead(200, { 'content-type': 'application/json' });
        const timer = setInterval(() => res.write(' '), 25);
        responseTimers.add(timer);
        const clear = () => {
          clearInterval(timer);
          responseTimers.delete(timer);
        };
        res.once('close', clear);
        return;
      }
      // Deliberately never answer. The MCP bridge owns the absolute timeout
      // and must turn this into a tool error.
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  let doc;
  let watch;
  let predict;
  let format;
  let invalidMode;
  let unbound;
  let research;
  try {
    console.log('\n[document tool contract]');
    doc = launchMcp('mcp-doc.js', port, { SCRIBE_MCP_MODE: 'edit' });
    const listed = await doc.call('tools/list');
    const tools = listed.result.tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    check('edit mode does not expose the watch-only assist tool',
      !byName.has('doc_assist'), [...byName.keys()].join(','));
    for (const name of ['doc_replace', 'doc_insert', 'doc_delete', 'doc_format']) {
      const required = byName.get(name).inputSchema.required || [];
      check(`${name} requires expect_hash`, required.includes('expect_hash'), required.join(','));
    }
    const insertRequired = byName.get('doc_insert').inputSchema.required || [];
    check('doc_insert requires an explicit paragraph style',
      insertRequired.includes('style'), insertRequired.join(','));
    const formatRequired = byName.get('doc_format').inputSchema.required || [];
    check('doc_format requires a formatting-sensitive stale-write guard',
      formatRequired.includes('expect_format_hash'), formatRequired.join(','));
    const formatProps = byName.get('doc_format').inputSchema.properties;
    check('format exposes every supported property',
      !!formatProps.u && !!formatProps.size, Object.keys(formatProps).sort().join(','));

    const before = requests;
    for (const [name, args] of [
      ['doc_replace', { pid: 'A', find: 'x', replace: 'y', why: 'test' }],
      ['doc_insert', { after_pid: 'A', text: 'x', why: 'test' }],
      ['doc_delete', { pid: 'A', why: 'test' }],
      ['doc_format', { pid: 'A', find: 'x', b: true, why: 'test' }],
    ]) {
      const answer = await doc.call('tools/call', { name, arguments: args });
      const text = resultText(answer);
      check(`${name} fails closed without a hash`,
        answer.result.isError === true && /expect_hash is required/i.test(text), text);
    }
    check('missing-hash calls never reach the edit API', requests === before,
      `${requests - before} request(s)`);

    const beforeSecondaryGuards = requests;
    const missingStyle = await doc.call('tools/call', {
      name: 'doc_insert',
      arguments: {
        after_pid: 'A', text: 'ordinary body prose', why: 'test',
        expect_hash: '0123456789ab',
      },
    });
    check('doc_insert fails closed when style is omitted after a fresh read',
      missingStyle.result.isError === true &&
        /style is required/i.test(resultText(missingStyle)),
      resultText(missingStyle));
    const missingFormatHash = await doc.call('tools/call', {
      name: 'doc_format',
      arguments: {
        pid: 'A', find: 'x', b: false, why: 'test',
        expect_hash: '0123456789ab',
      },
    });
    check('doc_format fails closed without a formatting-sensitive hash',
      missingFormatHash.result.isError === true &&
        /expect_format_hash is required/i.test(resultText(missingFormatHash)),
      resultText(missingFormatHash));
    check('secondary stale-write guard failures never reach the edit API',
      requests === beforeSecondaryGuards,
      `${requests - beforeSecondaryGuards} request(s)`);

    console.log('\n[role fail-closed boundaries]');
    watch = launchMcp('mcp-doc.js', port, { SCRIBE_MCP_MODE: 'watch' });
    const watchListed = await watch.call('tools/list');
    check('watch mode advertises only its read-only surface',
      watchListed.result.tools.map((tool) => tool.name).join(',') ===
        'doc_read,doc_find,doc_assist',
      watchListed.result.tools.map((tool) => tool.name).join(','));
    const beforeWatchWrite = requests;
    const refusedWatchWrite = await watch.call('tools/call', {
      name: 'doc_replace',
      arguments: {
        pid: 'A', find: 'x', replace: 'y', why: 'must be refused',
        expect_hash: '0123456789ab',
      },
    });
    check('watch mode rejects a directly named write tool',
      refusedWatchWrite.result.isError === true &&
        /unknown watch tool/i.test(resultText(refusedWatchWrite)),
      resultText(refusedWatchWrite));
    check('a refused watch write never reaches the API',
      requests === beforeWatchWrite, `${requests - beforeWatchWrite} request(s)`);

    console.log('\n[prediction tool boundary]');
    predict = launchMcp('mcp-doc.js', port, { SCRIBE_MCP_MODE: 'predict' });
    const predictListed = await predict.call('tools/list');
    check('prediction mode advertises only read tools',
      predictListed.result.tools.map((tool) => tool.name).join(',') === 'doc_read,doc_find',
      predictListed.result.tools.map((tool) => tool.name).join(','));
    const beforePredictWrite = requests;
    const refusedWrite = await predict.call('tools/call', {
      name: 'doc_replace',
      arguments: {
        pid: 'A',
        find: 'x',
        replace: 'y',
        why: 'must be refused',
        expect_hash: '0123456789ab',
      },
    });
    check('prediction mode rejects a directly named write tool',
      refusedWrite.result.isError === true &&
        /unknown prediction tool/i.test(resultText(refusedWrite)),
      resultText(refusedWrite));
    check('a refused prediction write never reaches the API',
      requests === beforePredictWrite, `${requests - beforePredictWrite} request(s)`);

    console.log('\n[format-planner tool boundary]');
    format = launchMcp('mcp-doc.js', port, { SCRIBE_MCP_MODE: 'format' });
    const formatListed = await format.call('tools/list');
    check('format mode advertises only document read and find',
      formatListed.result.tools.map((tool) => tool.name).join(',') ===
        'doc_read,doc_find',
      formatListed.result.tools.map((tool) => tool.name).join(','));
    check('format-mode read description treats document text as untrusted',
      /untrusted prose/i.test(formatListed.result.tools
        .find((tool) => tool.name === 'doc_read').description));
    const beforeFormatWrite = requests;
    const refusedFormatWrite = await format.call('tools/call', {
      name: 'doc_format',
      arguments: {
        pid: 'A',
        find: 'x',
        b: false,
        why: 'must be refused',
        expect_hash: '0123456789ab',
      },
    });
    check('format mode rejects a directly named formatting write',
      refusedFormatWrite.result.isError === true &&
        /unknown format tool/i.test(resultText(refusedFormatWrite)),
      resultText(refusedFormatWrite));
    check('a refused format write never reaches the API',
      requests === beforeFormatWrite, `${requests - beforeFormatWrite} request(s)`);

    responseMode = 'format-fixture';
    const formatRead = await format.call('tools/call', {
      name: 'doc_read',
      arguments: { from: 0, to: 0 },
    });
    const formatReadText = resultText(formatRead);
    check('format reads render both stale-write hashes and paragraph formatting',
      /text_hash=text01234567/.test(formatReadText) &&
      /format_hash=format012345/.test(formatReadText) &&
      /paragraph_format=\{"b":true,"size":16\}/.test(formatReadText),
      formatReadText);
    check('format reads render exact Unicode code-point run ranges and properties',
      /chars=0-2 props=\{"b":true,"size":16\} text="A😀"/.test(formatReadText) &&
      /chars=2-8 props=\{"b":true,"color":"008000","size":16\} text="B body"/.test(formatReadText),
      formatReadText);
    const formatPayload = requestBodies.at(-1);
    check('format reads identify the planner and carry its document token',
      formatPayload.body.who === 'format' &&
      formatPayload.body.op.expect_document_token === DOCUMENT_TOKEN,
      JSON.stringify(formatPayload.body));
    responseMode = 'hang';

    invalidMode = launchMcp('mcp-doc.js', port, { SCRIBE_MCP_MODE: 'watc' });
    const invalidListed = await invalidMode.call('tools/list');
    check('an unknown mode advertises no tools',
      Array.isArray(invalidListed.result.tools) && invalidListed.result.tools.length === 0);
    const beforeInvalidWrite = requests;
    const invalidWrite = await invalidMode.call('tools/call', {
      name: 'doc_replace',
      arguments: {
        pid: 'A', find: 'x', replace: 'y', why: 'must be refused',
        expect_hash: '0123456789ab',
      },
    });
    check('an unknown mode fails closed at dispatch',
      invalidWrite.result.isError === true &&
        /mode is missing or invalid/i.test(resultText(invalidWrite)),
      resultText(invalidWrite));
    check('an invalid-mode call never reaches the API',
      requests === beforeInvalidWrite, `${requests - beforeInvalidWrite} request(s)`);

    unbound = launchMcp('mcp-doc.js', port, {
      SCRIBE_MCP_MODE: 'edit',
      SCRIBE_DOCUMENT_TOKEN: '',
    });
    const beforeUnboundRead = requests;
    const unboundRead = await unbound.call('tools/call', {
      name: 'doc_read',
      arguments: { from: 0, to: 0 },
    });
    check('a document bridge without an ownership token fails closed',
      unboundRead.result.isError === true &&
        /document_token is missing or invalid/i.test(resultText(unboundRead)),
      resultText(unboundRead));
    check('an unbound document call never reaches the API',
      requests === beforeUnboundRead, `${requests - beforeUnboundRead} request(s)`);

    console.log('\n[bounded JSON-lines protocol]');
    await doc.sendRaw('null\n');
    const afterNull = await doc.call('tools/list');
    check('a valid non-object JSON frame does not crash the document bridge',
      Array.isArray(afterNull.result.tools));
    await doc.sendRaw('x'.repeat(1024 * 1024 + 1) + '\n');
    const afterOversizeFrame = await doc.call('tools/list');
    check('the document bridge drains an oversized frame and resynchronizes',
      Array.isArray(afterOversizeFrame.result.tools));

    console.log('\n[bounded document transport]');
    responseMode = 'hang';
    const started = Date.now();
    const timedOut = await doc.call('tools/call', {
      name: 'doc_read',
      arguments: { from: 0, to: 0 },
    });
    const elapsed = Date.now() - started;
    const timeoutText = resultText(timedOut);
    check('an unresponsive document API becomes a tool error',
      timedOut.result.isError === true && /timed out/i.test(timeoutText), timeoutText);
    check('the document timeout is bounded', elapsed < 1500, `${elapsed}ms`);
    const readPayload = [...requestBodies].reverse().find((entry) =>
      entry.path === '/api/edit');
    check('every MCP document read carries its bound document token',
      readPayload && readPayload.body && readPayload.body.op &&
      readPayload.body.op.expect_document_token === DOCUMENT_TOKEN,
      readPayload && JSON.stringify(readPayload.body));

    responseMode = 'drip';
    const dripStarted = Date.now();
    const dripTimedOut = await doc.call('tools/call', {
      name: 'doc_read',
      arguments: { from: 0, to: 0 },
    });
    const dripElapsed = Date.now() - dripStarted;
    check('continuous response bytes cannot evade the absolute deadline',
      dripTimedOut.result.isError === true &&
        /timed out/i.test(resultText(dripTimedOut)) && dripElapsed < 1500,
      `${dripElapsed}ms ${resultText(dripTimedOut)}`);

    responseMode = 'oversize';
    const oversizedResponse = await doc.call('tools/call', {
      name: 'doc_read',
      arguments: { from: 0, to: 0 },
    });
    check('an oversized HTTP response is bounded and refused',
      oversizedResponse.result.isError === true &&
        /response exceeded/i.test(resultText(oversizedResponse)),
      resultText(oversizedResponse));

    console.log('\n[malformed success responses]');
    responseMode = 'invalid';
    const invalidRead = await doc.call('tools/call', {
      name: 'doc_read', arguments: { from: 0, to: 0 },
    });
    check('an empty 200 edit response is not treated as success',
      invalidRead.result.isError === true &&
        /invalid edit response/i.test(resultText(invalidRead)),
      resultText(invalidRead));
    const invalidProposal = await doc.call('tools/call', {
      name: 'doc_propose',
      arguments: {
        anchor_pid: 'A',
        anchor_hash: '0123456789ab',
        mode: 'insert',
        intent: 'test',
        options: [{ text: 'one' }, { text: 'two' }],
      },
    });
    check('an empty 200 proposal response is not announced as success',
      invalidProposal.result.isError === true &&
        /did not confirm a valid proposal/i.test(resultText(invalidProposal)),
      resultText(invalidProposal));
    const invalidAssist = await watch.call('tools/call', {
      name: 'doc_assist',
      arguments: {
        review_id: 'r1', anchor_pid: 'A', title: 'test', text: 'test',
      },
    });
    check('an empty 200 assist response is not announced as success',
      invalidAssist.result.isError === true &&
        /did not confirm a valid watch note/i.test(resultText(invalidAssist)),
      resultText(invalidAssist));
    const proposalPayload = [...requestBodies].reverse().find((entry) =>
      entry.path === '/api/propose');
    const assistPayload = [...requestBodies].reverse().find((entry) =>
      entry.path === '/api/assist');
    check('proposal and assist MCP calls carry the same document token',
      proposalPayload && proposalPayload.body &&
      proposalPayload.body.expect_document_token === DOCUMENT_TOKEN &&
      assistPayload && assistPayload.body &&
      assistPayload.body.expect_document_token === DOCUMENT_TOKEN);

    console.log('\n[bounded research transport]');
    responseMode = 'hang';
    research = launchMcp('mcp-research.js', port);
    await research.sendRaw('null\n');
    const researchAfterNull = await research.call('tools/list');
    check('a valid non-object JSON frame does not crash the research bridge',
      Array.isArray(researchAfterNull.result.tools));
    await research.sendRaw('x'.repeat(1024 * 1024 + 1) + '\n');
    const researchAfterOversize = await research.call('tools/list');
    check('the research bridge drains an oversized frame and resynchronizes',
      Array.isArray(researchAfterOversize.result.tools));
    const researchStarted = Date.now();
    const researchTimedOut = await research.call('tools/call', {
      name: 'corpus_search',
      arguments: { query: 'determinacy' },
    });
    const researchElapsed = Date.now() - researchStarted;
    const researchText = resultText(researchTimedOut);
    check('an unresponsive research API becomes a tool error',
      researchTimedOut.result.isError === true && /timed out/i.test(researchText), researchText);
    check('the research timeout is bounded', researchElapsed < 1500, `${researchElapsed}ms`);
    check('MCP bridges write no protocol errors to stderr',
      doc.stderr.length === 0 && watch.stderr.length === 0 &&
        predict.stderr.length === 0 && format.stderr.length === 0 &&
        invalidMode.stderr.length === 0 &&
        research.stderr.length === 0,
      [...doc.stderr, ...watch.stderr, ...predict.stderr, ...format.stderr,
        ...invalidMode.stderr, ...research.stderr].join('').trim());
  } finally {
    if (doc) doc.stop();
    if (watch) watch.stop();
    if (predict) predict.stop();
    if (format) format.stop();
    if (invalidMode) invalidMode.stop();
    if (unbound) unbound.stop();
    if (research) research.stop();
    for (const timer of responseTimers) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log(`failed: ${FAIL.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
