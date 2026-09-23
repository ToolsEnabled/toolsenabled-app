#!/usr/bin/env node
// Probe 2: (a) do custom MCP tools work and stream like native tools?
//          (b) is subagent (Task) activity attributable via parent_tool_use_id?
//          (c) what does the final `result` event look like?

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolveExecutable } = require('./live-input');

const HERE = __dirname;
const MCP = path.join(HERE, 'mcp-docx-probe.js').replace(/\\/g, '/');

// Write the MCP config to a real file. Inline JSON on the command line is
// destroyed by Windows shell quoting; a file path has no such hazard.
const MCP_CFG = path.join(HERE, 'mcp-config.json');
fs.writeFileSync(MCP_CFG, JSON.stringify({
  mcpServers: { doc: { command: process.execPath, args: [MCP] } },
}, null, 1));
const mcpConfig = MCP_CFG;

// Resolve only an explicit override or a native binary already on PATH.
const CLAUDE_EXE = resolveExecutable('SCRIBE_CLAUDE_EXE',
  process.platform === 'win32' ? ['claude.exe'] : ['claude']);

const agents = JSON.stringify({
  factchecker: {
    description: 'Checks a claim against the document text',
    prompt: 'You verify claims. Use the doc_outline tool to read the document, then answer in one sentence.',
    tools: ['mcp__doc__doc_outline'],
  },
});

const args = [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
  '--mcp-config', mcpConfig,
  '--strict-mcp-config',
  '--agents', agents,
  '--allowed-tools', 'mcp__doc__doc_outline', 'mcp__doc__doc_replace', 'Task',
  '--model', 'claude-haiku-4-5-20251001',
  '--system-prompt', 'You edit a research paper through the doc_* tools only. Be terse.',
];

// shell:false is mandatory. With shell:true, Windows strips the quotes out of
// any JSON argument and the CLI sees garbage.
const child = spawn(CLAUDE_EXE, args, { cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'], shell: false });

const t0 = process.hrtime.bigint();
const ms = () => Number((process.hrtime.bigint() - t0) / 1000000n);
const out = [];
const sigs = new Map();
const toolCalls = [];

function send(text) {
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
}

let buf = '';
child.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    onEvent(ev);
  }
});

function onEvent(ev) {
  const sig = [ev.type, ev.subtype, ev.event && ev.event.type].filter(Boolean).join('/');
  sigs.set(sig, (sigs.get(sig) || 0) + 1);

  // Track every tool_use and tool_result with its parentage.
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'tool_use') {
        toolCalls.push({
          t: ms(), kind: 'CALL', name: b.name, id: b.id,
          caller: JSON.stringify(b.caller),
          parent: ev.parent_tool_use_id,
          input: JSON.stringify(b.input).slice(0, 200),
        });
      }
    }
  }
  if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'tool_result') {
        toolCalls.push({
          t: ms(), kind: 'RESULT', id: b.tool_use_id, parent: ev.parent_tool_use_id,
          isError: b.is_error,
          text: (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 200),
        });
      }
    }
  }
  if (ev.type === 'result') {
    out.push('\n=== RESULT EVENT ===\n' + JSON.stringify(ev, null, 1).slice(0, 2500));
  }
  if (ev.type === 'system' && ev.subtype === 'init') {
    out.push('\n=== INIT ===\nmcp_servers: ' + JSON.stringify(ev.mcp_servers) +
      '\nagents: ' + JSON.stringify(ev.agents) +
      '\ntools containing "doc": ' + JSON.stringify((ev.tools || []).filter(t => /doc|Task/i.test(t))));
  }
}

child.stderr.on('data', (d) => {
  const s = d.toString();
  if (/\[mcp\]/.test(s)) out.push('[mcp stderr] ' + s.trim());
  else if (s.trim()) out.push('[stderr] ' + s.trim().slice(0, 300));
});

child.on('close', (code) => {
  console.log('=== EVENT SIGNATURES ===');
  [...sigs.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(4), k));
  console.log('\n=== TOOL CALL / RESULT TIMELINE (parent = subagent attribution) ===');
  for (const c of toolCalls) {
    if (c.kind === 'CALL') console.log(`[${String(c.t).padStart(6)}ms] CALL   ${c.name}  id=${c.id}\n              caller=${c.caller} parent_tool_use_id=${c.parent}\n              input=${c.input}`);
    else console.log(`[${String(c.t).padStart(6)}ms] RESULT id=${c.id} parent_tool_use_id=${c.parent} isError=${c.isError}\n              ${c.text}`);
  }
  console.log(out.join('\n'));
  console.log('\nexit:', code);
});

send([
  'Do these three things in order:',
  '1. Call doc_outline to see the document.',
  '2. Use the Task tool to launch the "factchecker" subagent and ask it whether the introduction overstates the claim.',
  '3. Call doc_replace on paragraph 2 to change the phrase "very largely" to "in substantial part". Give a why.',
].join('\n'));

setTimeout(() => { try { child.stdin.end(); } catch {} }, 90000);
setTimeout(() => { try { child.kill(); } catch {} }, 150000);
