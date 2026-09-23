#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  read,
  recordPid,
  clearPid,
  sweepStalePids,
} = require('../pid-registry');

const ROOT = path.join(__dirname, '..');
const TMP = path.resolve(__dirname, '_tmp_pid_registry');
const FILE = path.join(TMP, 'pids.json');
if (!TMP.startsWith(path.resolve(ROOT) + path.sep)) {
  throw new Error(`refusing temp path outside workspace: ${TMP}`);
}

const PASS = [], FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + detail : ''}`);
};

try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  console.log('\n[record and retire]');
  check('records a child identity',
    recordPid(FILE, 'agent', 101, {
      ownerPid: 77,
      commandIncludes: path.join(ROOT, 'data', 'agent', 'mcp.json'),
    }) === true);
  const recorded = read(FILE).agent;
  check('record carries its owner and command fingerprint',
    recorded.pid === 101 && recorded.ownerPid === 77 &&
    /agent[\\/]mcp\.json$/i.test(recorded.commandIncludes),
    JSON.stringify(recorded));
  check('a stale exit cannot clear a replacement pid',
    clearPid(FILE, 'agent', 999) === false && read(FILE).agent.pid === 101);
  check('the matching child exit clears its own role',
    clearPid(FILE, 'agent', 101) === true && !read(FILE).agent);

  console.log('\n[identity-checked boot sweep]');
  const records = {
    server: { pid: 201, at: new Date().toISOString() },
    dochost: {
      pid: 202, ownerPid: 77,
      commandIncludes: path.join(ROOT, 'engine', 'dochost.py'),
    },
    agent: {
      pid: 203, ownerPid: 77,
      commandIncludes: path.join(ROOT, 'data', 'agent', 'mcp.json'),
    },
    research: { pid: 204, at: new Date().toISOString() },
    stt: { pid: 205, ownerPid: 77, commandIncludes: path.join(ROOT, 'engine', 'stt.py') },
  };
  fs.writeFileSync(FILE, JSON.stringify(records));
  const terminated = [];
  const inspected = [];
  const info = {
    202: {
      parentPid: 77,
      executablePath: 'C:\\Python\\python.exe',
      commandLine: `"python" -u "${path.join(ROOT, 'engine', 'dochost.py')}"`,
    },
    // Same PID record shape, wrong owner and command: this is PID reuse.
    203: {
      parentPid: 999,
      executablePath: 'C:\\Windows\\notepad.exe',
      commandLine: 'notepad.exe notes.txt',
    },
    // Legacy record: accepted only by its Scribe-specific role fingerprint.
    204: {
      parentPid: 55,
      executablePath: 'C:\\Python\\python.exe',
      commandLine: `"python" -u "${path.join(ROOT, 'engine', 'research.py')}"`,
    },
    // Missing process.
    205: null,
  };
  const result = sweepStalePids(FILE, {
    root: ROOT,
    inspectPid: (pid) => {
      inspected.push(pid);
      return info[pid] || null;
    },
    terminatePid: (pid) => terminated.push(pid),
  });
  check('only proven Scribe children are terminated',
    JSON.stringify(terminated.sort()) === JSON.stringify([202, 204]),
    JSON.stringify(terminated));
  check('the prior server pid is never inspected or killed',
    !inspected.includes(201) && !terminated.includes(201),
    JSON.stringify(inspected));
  check('a reused pid with the wrong identity is left untouched',
    inspected.includes(203) && !terminated.includes(203));
  check('gone children are harmless',
    result.gone === 1 && inspected.includes(205), JSON.stringify(result));
  check('sweep reports verified and skipped records honestly',
    result.swept === 2 && result.skipped === 2, JSON.stringify(result));
  check('every inspected old record is disarmed after one boot',
    Object.keys(read(FILE)).length === 0, JSON.stringify(read(FILE)));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
process.exit(FAIL.length ? 1 : 0);
