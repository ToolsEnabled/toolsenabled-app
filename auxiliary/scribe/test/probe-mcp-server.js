#!/usr/bin/env node
// Minimal stdio MCP server, to prove that a host app can hand the agent a
// custom, fine-grained document-op toolset and observe every call.
// JSON-RPC 2.0 over newline-delimited stdin/stdout. No dependencies.

const TOOLS = [
  {
    name: 'doc_outline',
    description: 'Return the paragraph outline of the document: index, style, and a text preview for each paragraph.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'First paragraph index (default 0)' },
        to: { type: 'number', description: 'Last paragraph index (default 20)' },
      },
    },
  },
  {
    name: 'doc_replace',
    description: 'Replace an exact text span inside one paragraph, preserving formatting.',
    inputSchema: {
      type: 'object',
      properties: {
        para: { type: 'number', description: 'Paragraph index' },
        find: { type: 'string', description: 'Exact text to find within that paragraph' },
        replace: { type: 'string', description: 'Replacement text' },
        why: { type: 'string', description: 'One line: why this edit' },
      },
      required: ['para', 'find', 'replace', 'why'],
    },
  },
];

// Fake document so the probe is self-contained and touches nothing real.
const DOC = [
  { style: 'Title', text: 'LEAN-Bench: What Evaluations of LLM-Generated Trading Code Actually Measure' },
  { style: 'Heading 1', text: 'Introduction' },
  { style: 'Normal', text: 'Recent benchmarks report that frontier models solve most trading-code tasks. We argue this result is very largely an artifact of how the tasks are specified.' },
  { style: 'Normal', text: 'We audit a published benchmark and find that scores track judge behavior and prompt vagueness more than model capability.' },
];

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function log(s) { process.stderr.write('[mcp] ' + s + '\n'); }

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  log('recv ' + method);

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        // Echo the client's protocol version back: safest across versions.
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'docx-probe', version: '0.0.1' },
      },
    });
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }
  if (method === 'tools/call') {
    const { name, arguments: a = {} } = params || {};
    log('CALL ' + name + ' ' + JSON.stringify(a));
    if (name === 'doc_outline') {
      const from = a.from ?? 0, to = Math.min(a.to ?? 20, DOC.length - 1);
      const lines = DOC.slice(from, to + 1).map((p, k) =>
        `[${from + k}] (${p.style}) ${p.text.slice(0, 120)}${p.text.length > 120 ? '…' : ''}`);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: lines.join('\n') }] } });
    }
    if (name === 'doc_replace') {
      const p = DOC[a.para];
      if (!p) return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `no paragraph ${a.para}` }] } });
      if (!p.text.includes(a.find)) {
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `text not found in paragraph ${a.para}. Current text: ${p.text}` }] } });
      }
      const before = p.text;
      p.text = p.text.replace(a.find, a.replace);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `OK. p${a.para} now reads: ${p.text}\n(was: ${before})` }] } });
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool ' + name } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method ' + method } });
}
