#!/usr/bin/env node
'use strict';
/**
 * The research toolset, as an MCP server over stdio.
 *
 * Read only by construction: there is no write path here at all. Calls go to
 * the Scribe server on loopback, which forwards them to the Python retrieval
 * host, so tool use is supervised and observable like everything else.
 *
 * Every result carries its source path AND its modification date. That is not
 * decoration. This corpus states the determinacy count two different ways
 * across drafts (3 of 20 in the deck, 1 of 20 in one draft), and an answer that
 * does not say which file it came from and when will re-introduce a settled
 * error with total confidence.
 */

const http = require('http');

const PORT = Number(process.env.SCRIBE_PORT || 4610);
const HOST = process.env.SCRIBE_HOST || '127.0.0.1';
const configuredTimeout = Number(process.env.SCRIBE_MCP_TIMEOUT_MS);
const REQUEST_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout >= 100
  ? Math.min(configuredTimeout, 300000)
  : 30000;
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024;
const isRecord = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function ask(cmd, args) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ cmd, args });
    let settled = false;
    let deadline = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(result);
    };
    const req = http.request({ host: HOST, port: PORT, path: '/api/research', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let out = '';
        let outBytes = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          outBytes += Buffer.byteLength(c);
          if (outBytes > MAX_HTTP_RESPONSE_BYTES) {
            req.destroy(new Error(`response exceeded ${MAX_HTTP_RESPONSE_BYTES} bytes`));
            return;
          }
          out += c;
        });
        res.on('aborted', () => finish({
          status: 0,
          body: { error: 'Scribe closed the research response before it completed.' },
        }));
        res.on('error', (e) => finish({
          status: 0,
          body: { error: `Scribe research response failed: ${e.message}` },
        }));
        res.on('end', () => {
          let b = {};
          try {
            const value = JSON.parse(out || '{}');
            b = isRecord(value)
              ? value
              : { error: 'Scribe returned a malformed JSON response.' };
          } catch (_) {
            b = { error: out || 'Scribe returned invalid JSON.' };
          }
          finish({ status: res.statusCode, body: b });
        });
      });
    deadline = setTimeout(() => {
      req.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    deadline.unref();
    req.on('error', (e) => finish({
      status: 0,
      body: { error: `Scribe unreachable: ${e.message}` },
    }));
    req.write(data);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'corpus_search',
    description:
      'Search everything Scribe can read: the drop folder, the paper drafts, the audit ' +
      'reports, the prompt specs, and the reference papers. Returns matching files with ' +
      'their modification date and surrounding snippets.\n' +
      'This is your FIRST move when the human asks what something says, what was actually ' +
      'done, or what a number is. Do not answer from memory.\n' +
      'Results are ordered by trust: the drop folder first, then the audit, then the ' +
      'drafts, then the wider tree. Duplicate copies of the same file are collapsed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to find. Try the exact phrase first, then a distinctive word.' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
        scope: { type: 'string', description: 'Limit to one root: drafts, presentation, context, audit, prompts, spikes, papers.' },
        limit: { type: 'number', description: 'Max files, default 12.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_source',
    description:
      'Read the full text of a file that corpus_search returned. Use this before quoting ' +
      'anything: a snippet is enough to find a source, never enough to trust it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A path from corpus_search. A bare filename works too.' },
        from: { type: 'number', description: 'Start character offset, default 0.' },
        to: { type: 'number', description: 'End character offset. Default is from + 6000.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'db_query',
    description:
      'Run a read-only SELECT against the evidence databases.\n' +
      'DATABASES: "leanbench" (the benchmark harness: calls, turns, prompts) and ' +
      '"generator" (the question generator: backtests, questions, agent_runs).\n' +
      'THINGS THAT WILL BITE YOU, and the tool will refuse or warn about:\n' +
      '- `trade_pass IS NULL` means the gate was NEVER REACHED, not that it failed. ' +
      'COALESCE-ing it to 0 inflates the failure rate 2.12x. Use ' +
      'SUM(trade_pass=0)/SUM(trade_pass IS NOT NULL). The same applies to backtest_pass, ' +
      'judge_pass, schema_pass and overall_pass.\n' +
      '- Never SELECT * FROM calls: one column is 107.9 MB.\n' +
      '- Always filter status=\'completed\' AND excluded_reason IS NULL, and pin ' +
      'benchmark_version. The table mixes v1.0 and v2.0 and the judge rubric changed ' +
      'between them.\n' +
      '- This database is 264 calls and $2.65 of compute. It is a PILOT. Never describe ' +
      'it as large scale, and never let it settle the 3-of-20 determinacy question, which ' +
      'lives in the audit files and not here.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A SELECT (or WITH ... SELECT) statement.' },
        db: { type: 'string', description: '"leanbench" (default) or "generator".' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'list_sources',
    description: 'What Scribe can read, and what each database contains. Cheap. Call it if you are unsure where to look.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

async function call(name, a = {}) {
  if (name === 'corpus_search') {
    const r = await ask('search', { query: a.query, regex: a.regex, scope: a.scope, limit: a.limit });
    if (r.status !== 200) return fail(`Search failed: ${r.body.error}`);
    const { hits, total_matches, searched } = r.body;
    if (!hits.length) {
      return text(`No match for ${JSON.stringify(a.query)} across ${searched} files.\n` +
        `Try a shorter or more distinctive phrase, or call list_sources to see what is indexed.`);
    }
    const lines = hits.map((h) => {
      const dup = h.duplicates ? ` (+${h.duplicates} identical copies elsewhere)` : '';
      return `${h.name}  [${h.root}]  modified ${h.mtime}  ${h.matches} match(es)${dup}\n` +
             `  path: ${h.path}\n` +
             h.snippets.map((s) => `  … ${s} …`).join('\n');
    });
    return text(
      `${total_matches} file(s) matched, showing ${hits.length}, ordered by trust then relevance.\n` +
      `Modification dates matter: when two files disagree, say so and note which is newer.\n\n` +
      lines.join('\n\n'));
  }

  if (name === 'read_source') {
    const r = await ask('read', { path: a.path, from: a.from, to: a.to });
    if (r.status !== 200) return fail(r.body.error || 'read failed');
    const b = r.body;
    return text(`${b.path}\n[${b.root}, modified ${b.mtime}, ${b.chars} chars, showing ${b.from}-${b.to}]\n\n${b.text}` +
      (b.truncated ? `\n\n…truncated. Call read_source again with from=${b.to} for more.` : ''));
  }

  if (name === 'db_query') {
    const r = await ask('db', { sql: a.sql, db: a.db });
    if (r.status !== 200) return fail(r.body.error || 'query failed');
    const b = r.body;
    const head = [];
    if (b.note) head.push(`NOTE: ${b.note}`);
    for (const w of (b.warnings || [])) head.push(`WARNING: ${w}`);
    if (!b.rows.length) return text(`${head.join('\n')}\n\n0 rows.`);
    const cols = b.columns;
    const table = [cols.join(' | '), cols.map(() => '---').join(' | ')]
      .concat(b.rows.map((row) => cols.map((c) => String(row[c] === null ? 'NULL' : row[c])).join(' | ')));
    return text(`${head.join('\n')}${head.length ? '\n\n' : ''}${b.row_count} row(s)${b.truncated ? ' (truncated at 200)' : ''}\n\n${table.join('\n')}`);
  }

  if (name === 'list_sources') {
    const r = await ask('sources', {});
    if (r.status !== 200) return fail(r.body.error || 'failed');
    const s = r.body;
    const stats = await ask('stats', {});
    const idx = stats.status === 200 ? stats.body : {};
    return text(
      `Indexed: ${idx.files || '?'} files, ${idx.chars || '?'} chars` +
      (idx.duplicates_skipped ? `, ${idx.duplicates_skipped} duplicate copies collapsed` : '') + '\n\n' +
      'ROOTS (higher priority is trusted more when sources disagree):\n' +
      s.roots.map((x) => `  ${String(x.priority).padStart(3)}  ${x.name.padEnd(14)} ${x.path}`).join('\n') +
      '\n\nDATABASES:\n' + s.databases.map((d) => `  ${d.name}: ${d.note || ''}`).join('\n'));
  }

  return fail(`Unknown tool: ${name}`);
}

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

let buf = '';
let discardingOversize = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  let textChunk = chunk;
  if (discardingOversize) {
    const end = textChunk.indexOf('\n');
    if (end < 0) return;
    discardingOversize = false;
    textChunk = textChunk.slice(end + 1);
  }
  buf += textChunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (Buffer.byteLength(raw) > MAX_PROTOCOL_FRAME_BYTES) {
      send({ jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'protocol frame too large' } });
      continue;
    }
    const line = raw.trim();
    if (line) void handle(line);
  }
  if (Buffer.byteLength(buf) > MAX_PROTOCOL_FRAME_BYTES) {
    buf = '';
    discardingOversize = true;
    send({ jsonrpc: '2.0', id: null,
      error: { code: -32600, message: 'protocol frame too large' } });
  }
});

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) {
    return send({ jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'invalid JSON' } });
  }
  if (!isRecord(msg)) {
    return send({ jsonrpc: '2.0', id: null,
      error: { code: -32600, message: 'request must be an object' } });
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'scribe-research', version: '0.1.0' },
    } });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const result = await call(params && params.name, (params && params.arguments) || {});
      return send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: fail(`Tool crashed: ${e.message}`) });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
}
