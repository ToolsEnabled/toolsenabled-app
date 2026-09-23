#!/usr/bin/env node
'use strict';
/**
 * PreToolUse sandbox.
 *
 * Windows gives us no OS filesystem sandbox, so this hook is the only thing
 * standing between the agent and the rest of the machine. It is an ALLOWLIST and
 * it FAILS CLOSED: `decision` is initialized to deny before any parsing happens,
 * so every early return, throw, or unexpected shape denies rather than allows.
 *
 * Built on a hook rather than on canUseTool deliberately. canUseTool is silently
 * skipped for any call auto-approved by allowedTools or a permission mode, which
 * is exactly how Scribe runs the agent, so permission checks placed there would
 * never fire. Hooks run before every other step and a hook deny applies even in
 * bypassPermissions mode.
 *
 * Contract: hook JSON arrives on stdin, the decision goes to stdout, and the
 * process ALWAYS exits 0. A nonzero exit is a hook error, not a denial.
 */

const path = require('path');
const MAX_HOOK_BYTES = 1024 * 1024;

// Tools the agent may use. Anything absent is denied.
const ALLOW = new Set([
  // The document vocabulary. The only path to the .docx.
  'mcp__doc__doc_read', 'mcp__doc__doc_find', 'mcp__doc__doc_replace',
  'mcp__doc__doc_insert', 'mcp__doc__doc_delete', 'mcp__doc__doc_format',
  'mcp__doc__doc_propose', 'mcp__doc__doc_assist',
  // Research tools (Phase 6). Read only by construction.
  'mcp__research__corpus_search', 'mcp__research__db_query', 'mcp__research__read_source',
  'mcp__research__list_sources',
  // Subagent dispatch. BOTH spellings: the tool was renamed Task to Agent in
  // CLI v2.1.63 and current builds emit "Agent" while the init tools list still
  // says "Task". Matching only one silently breaks subagents.
  'Agent', 'Task', 'TaskOutput', 'TaskStop',
  // Harmless read-only helpers and bookkeeping.
  'Read', 'Glob', 'Grep', 'TodoWrite', 'ToolSearch', 'AskUserQuestion',
]);

// The watch sidecar is a separate process with a smaller, read-only surface.
// This is defense in depth behind its filtered MCP tool list.
const WATCH_ALLOW = new Set([
  'mcp__doc__doc_read', 'mcp__doc__doc_find', 'mcp__doc__doc_assist',
  'mcp__research__corpus_search', 'mcp__research__db_query',
  'mcp__research__read_source', 'mcp__research__list_sources',
]);

// The automatic formatter is a planner, not an editing agent. It can inspect
// the active document but must return its plan as text for the server to
// validate and apply atomically.
const FORMAT_ALLOW = new Set([
  'mcp__doc__doc_read', 'mcp__doc__doc_find',
]);

// Named explicitly so the denial reason can be specific and the agent stops
// trying, rather than rephrasing the same forbidden call.
const REASONS = {
  Edit: 'Use doc_replace. Direct file editing is disabled: it would bypass formatting preservation, checkpointing, and the change trail.',
  Write: 'Use doc_replace or doc_insert. Writing files is disabled.',
  NotebookEdit: 'Notebook editing is disabled in Scribe.',
  Bash: 'Shell access is disabled. Use doc_* to edit and the research tools to look things up.',
  PowerShell: 'Shell access is disabled. Use doc_* to edit and the research tools to look things up.',
  WebFetch: 'Network access is disabled. Everything you need is in the document and the local corpus.',
  WebSearch: 'Network access is disabled. Everything you need is in the document and the local corpus.',
};

let decision = 'deny';                                  // fail closed, before anything else
let reason = 'Scribe sandbox: tool not on the allowlist.';
let toolName = '(unknown)';
let emitted = false;
let deadline = null;

function emit() {
  if (emitted) return;
  emitted = true;
  if (deadline) clearTimeout(deadline);
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
  // Wait for the small decision frame to reach the pipe before exiting.
  // process.exit() immediately after write() can truncate redirected stdout.
  process.stdout.write(output, () => process.exit(0));
}

let raw = '';
let rawBytes = 0;
process.stdin.on('data', (c) => {
  if (emitted) return;
  rawBytes += Buffer.byteLength(c);
  if (rawBytes > MAX_HOOK_BYTES) {
    reason = 'Scribe sandbox: hook payload too large, denying by default.';
    emit();
    return;
  }
  raw += c;
});
process.stdin.on('error', () => {
  reason = 'Scribe sandbox: hook input failed, denying by default.';
  emit();
});
process.stdin.on('end', () => {
  if (emitted) return;
  try {
    const input = JSON.parse(raw || '{}');
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.tool_name !== 'string' || !input.tool_name) {
      throw new Error('invalid hook payload');
    }
    toolName = input.tool_name;

    const mode = process.env.SCRIBE_GUARD_MODE || 'edit';
    const allowed = mode === 'watch' || mode === 'predict'
      ? WATCH_ALLOW
      : mode === 'format'
        ? FORMAT_ALLOW
      : mode === 'edit'
        ? ALLOW
        : null;
    if (!allowed) {
      decision = 'deny';
      reason = `Scribe sandbox: invalid guard mode ${JSON.stringify(mode)}, denying by default.`;
    } else if (allowed.has(toolName)) {
      decision = 'allow';
      reason = 'allowed by the Scribe sandbox';
    } else if (REASONS[toolName]) {
      decision = 'deny';
      reason = REASONS[toolName];
    } else {
      decision = 'deny';
      reason = mode === 'format'
        ? `Scribe sandbox: ${toolName} is not available to the formatting planner. ` +
          'Only doc_read and doc_find are allowed.'
        : `Scribe sandbox: ${toolName} is not available. Allowed: the doc_* editing tools, ` +
          `the research tools, subagents, and read-only Read/Glob/Grep.`;
    }

    if (process.env.SCRIBE_GUARD_LOG) {
      try {
        require('fs').appendFileSync(process.env.SCRIBE_GUARD_LOG,
          JSON.stringify({ at: new Date().toISOString(), tool: toolName, decision,
                           agent_id: input.agent_id || null, agent_type: input.agent_type || null }) + '\n');
      } catch (_) { /* logging must never change the decision */ }
    }
  } catch (_) {
    decision = 'deny';
    reason = 'Scribe sandbox: could not parse the hook payload, denying by default.';
  }
  emit();
});

// If stdin never closes, deny rather than hang forever.
deadline = setTimeout(() => {
  reason = 'Scribe sandbox: hook timed out, denying by default.';
  emit();
}, 5000);
deadline.unref();

module.exports = { ALLOW, WATCH_ALLOW, FORMAT_ALLOW, REASONS, MAX_HOOK_BYTES };
