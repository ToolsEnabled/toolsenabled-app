#!/usr/bin/env node
'use strict';
/**
 * Sandbox tests. This is the only barrier between the agent and the machine, so
 * it is tested by running the real hook as a real subprocess with real stdin,
 * not by importing its logic. A guard that works when imported and fails when
 * spawned protects nothing.
 *
 * Run: node test/test_guard.js
 */

const { spawn } = require('child_process');
const path = require('path');

const GUARD = path.join(__dirname, '..', 'guard.js');
const PASS = [], FAIL = [];
const check = (n, c, d) => { (c ? PASS : FAIL).push(n); console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? '  ' + d : ''}`); };

/** Run the hook exactly as Claude Code runs it: JSON on stdin, JSON on stdout. */
function ask(payload, { raw = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [GUARD], {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...process.env, ...env },
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => out += c);
    p.stderr.on('data', (c) => err += c);
    p.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (_) {}
      const hs = parsed && parsed.hookSpecificOutput;
      resolve({ code, out, err, decision: hs && hs.permissionDecision, reason: hs && hs.permissionDecisionReason });
    });
    p.stdin.end(raw !== null ? raw : JSON.stringify(payload));
  });
}

const call = (tool, extra = {}) => ask({
  session_id: 's1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, ...extra,
});
const watchCall = (tool) => ask({
  session_id: 'w1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {},
}, { env: { SCRIBE_GUARD_MODE: 'watch' } });
const formatCall = (tool) => ask({
  session_id: 'f1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {},
}, { env: { SCRIBE_GUARD_MODE: 'format' } });

async function main() {
  console.log('\n[allowed]');
  for (const t of ['mcp__doc__doc_read', 'mcp__doc__doc_replace', 'mcp__doc__doc_insert',
                   'mcp__doc__doc_delete', 'mcp__doc__doc_format', 'mcp__doc__doc_find',
                   'mcp__doc__doc_assist', 'Read', 'Glob', 'Grep', 'ToolSearch', 'TodoWrite']) {
    const r = await call(t);
    check(`${t} allowed`, r.decision === 'allow', r.decision);
  }
  // Both spellings. The tool was renamed Task -> Agent in CLI v2.1.63 and current
  // builds are internally inconsistent about which name they emit.
  for (const t of ['Agent', 'Task']) {
    const r = await call(t);
    check(`${t} allowed (both spellings, the rename is not settled)`, r.decision === 'allow', r.decision);
  }

  console.log('\n[denied]');
  for (const t of ['Edit', 'Write', 'Bash', 'PowerShell', 'NotebookEdit', 'WebFetch', 'WebSearch']) {
    const r = await call(t);
    check(`${t} denied`, r.decision === 'deny', r.decision);
    check(`  ${t} explains why`, !!r.reason && r.reason.length > 20, (r.reason || '').slice(0, 50));
  }
  const edit = await call('Edit');
  check('Edit denial points at the right tool', /doc_replace/.test(edit.reason), edit.reason);

  console.log('\n[watch sidecar is independently read only]');
  for (const t of ['mcp__doc__doc_read', 'mcp__doc__doc_find', 'mcp__doc__doc_assist',
                   'mcp__research__corpus_search']) {
    const r = await watchCall(t);
    check(`watch allows ${t}`, r.decision === 'allow', r.decision);
  }
  for (const t of ['mcp__doc__doc_replace', 'mcp__doc__doc_insert',
                   'mcp__doc__doc_delete', 'mcp__doc__doc_format',
                   'mcp__doc__doc_propose', 'Agent', 'Bash']) {
    const r = await watchCall(t);
    check(`watch denies ${t}`, r.decision === 'deny', r.decision);
  }

  console.log('\n[format planner has an exact read-only surface]');
  for (const t of ['mcp__doc__doc_read', 'mcp__doc__doc_find']) {
    const r = await formatCall(t);
    check(`format allows ${t}`, r.decision === 'allow', r.decision);
  }
  for (const t of ['mcp__doc__doc_replace', 'mcp__doc__doc_insert',
                   'mcp__doc__doc_delete', 'mcp__doc__doc_format',
                   'mcp__doc__doc_propose', 'mcp__doc__doc_assist',
                   'mcp__research__corpus_search', 'Read', 'Agent', 'Bash']) {
    const r = await formatCall(t);
    check(`format denies ${t}`, r.decision === 'deny', r.decision);
  }

  console.log('\n[unknown tools are denied, not allowed]');
  for (const t of ['SomeFutureTool', 'mcp__evil__rm', '', 'Bash(rm -rf /)']) {
    const r = await call(t);
    check(`${JSON.stringify(t)} denied by default`, r.decision === 'deny', r.decision);
  }

  console.log('\n[fails closed]');
  const bad = await ask(null, { raw: 'not json at all' });
  check('unparseable payload denies', bad.decision === 'deny', bad.decision);
  check('  and still exits 0 (nonzero would be a hook error, not a denial)', bad.code === 0, bad.code);
  const empty = await ask(null, { raw: '' });
  check('empty payload denies', empty.decision === 'deny', empty.decision);
  const noTool = await ask({ hook_event_name: 'PreToolUse' });
  check('missing tool_name denies', noTool.decision === 'deny', noTool.decision);
  const weird = await ask({ tool_name: { nested: 'object' } });
  check('non-string tool_name denies', weird.decision === 'deny', weird.decision);

  console.log('\n[protocol]');
  const ok = await call('Read');
  check('always exits 0 on allow', ok.code === 0, ok.code);
  const no = await call('Bash');
  check('always exits 0 on deny', no.code === 0, no.code);
  check('emits hookEventName', /"hookEventName":"PreToolUse"/.test(no.out));
  check('writes nothing to stderr', no.err === '', JSON.stringify(no.err.slice(0, 60)));
  check('stdout is exactly one JSON object', (() => {
    try { JSON.parse(no.out); return true; } catch (_) { return false; }
  })());

  console.log('\n[no accidental allowlist drift]');
  const { ALLOW } = require('../guard.js');
  const mutating = [...ALLOW].filter((t) => /^(Edit|Write|Bash|PowerShell|NotebookEdit)$/.test(t));
  check('no filesystem or shell tool is on the allowlist', mutating.length === 0, mutating.join(','));
  const docTools = [...ALLOW].filter((t) => t.startsWith('mcp__doc__')).sort();
  check('exactly the eight document tools are allowed',
    docTools.join(',') === ['mcp__doc__doc_assist', 'mcp__doc__doc_delete', 'mcp__doc__doc_find', 'mcp__doc__doc_format',
                            'mcp__doc__doc_insert', 'mcp__doc__doc_propose', 'mcp__doc__doc_read',
                            'mcp__doc__doc_replace'].join(','),
    docTools.length + ': ' + docTools.map((t) => t.replace('mcp__doc__', '')).join(' '));
  const research = [...ALLOW].filter((t) => t.startsWith('mcp__research__'));
  check('the research tools are allowed and are all read-only by name',
    research.length === 4 && !research.some((t) => /write|edit|delete|insert/.test(t)),
    research.map((t) => t.replace('mcp__research__', '')).join(' '));
  const { WATCH_ALLOW, FORMAT_ALLOW } = require('../guard.js');
  check('the watch allowlist contains no document mutation or agent dispatch',
    ![...WATCH_ALLOW].some((t) => /replace|insert|delete|format|propose|^(Agent|Task)$/.test(t)),
    [...WATCH_ALLOW].join(' '));
  check('the format allowlist contains exactly document read and find',
    [...FORMAT_ALLOW].sort().join(',') ===
      ['mcp__doc__doc_find', 'mcp__doc__doc_read'].join(','),
    [...FORMAT_ALLOW].join(' '));

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
  process.exit(FAIL.length ? 1 : 0);
}

main();
