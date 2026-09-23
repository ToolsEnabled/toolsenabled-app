// Read-only command reconciliation. Never execute a package script to discover
// what it does. A source file census does not account for command-line modes,
// non-test checks, lifecycle aliases or a runner's own work.
const portable = value => value.replaceAll('\\', '/');
const safeRelative = value => typeof value === 'string' && value.length > 0 &&
  !/^(?:[a-z]:|\/)/i.test(value) && !/[\x00-\x20:*?"<>|]/.test(value) &&
  portable(value).split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));

// Execution requirements, never skip waivers. These exact cases retain their
// place in the full census. A companion platform must execute the same case
// against the same source/harness; a named omission is still an obligation.
const NATIVE_LINUX_CASES = Object.freeze([
  ['tools/test/owner-administration.test.mjs', 'trusted native actions read fixed private context and a matching signed-reply inbox'],
  ['tools/test/owner-administration.test.mjs', 'native pairing reads current consent instead of accepting it from the renderer'],
  ['tools/test/owner-administration.test.mjs', 'missing malformed wrong-profile unknown-field and unsafe-permission configs refuse without calls'],
  ['tools/test/owner-administration.test.mjs', 'symlink hardlink directory and oversized inbox refuse without reading their contents into replies'],
  ['tools/test/owner-administration.test.mjs', 'native identity discovery permits only a null public-key pin'],
  ['tools/test/owner-administration-process.test.mjs', 'Linux actual owned lifetime delivers bounded private input and writes only metadata terminal receipts'],
].map(Object.freeze));

export function requiredNativeSourceCases(suite, files) {
  return suite === 'app' ? NATIVE_LINUX_CASES.filter(([file]) => files.includes(file))
    .map(([file, testName]) => ({ suite, file, testName, requiredPlatform: 'linux' })) : [];
}
const INTERACTIVE_CASES = Object.freeze([
  ['tools/test/accessibility-desktop.test.mjs', 'the owned native fixture becomes visible before readiness even from an explicitly hidden launch', 'TOOLSENABLED_NIGHTLY'],
  ['tools/test/accessibility-desktop.test.mjs', 'real Windows UI Automation: opaque targets, confirmed click/text, stale and stopped refusal', 'TOOLSENABLED_NIGHTLY'],
  ['tools/test/accessibility-desktop.test.mjs', 'real Windows window management is owner-confirmed and normal close never force-terminates', 'TOOLSENABLED_NIGHTLY'],
  ['tools/test/canonical-audit-thread.test.mjs', 'a record that blocks its thread for half a second does not stop the main thread', 'TOOLSENABLED_NIGHTLY'],
  ['tools/test/hand-controls-ui.test.mjs', 'native camera permissions, pinch clicks, background pause, and complete off cleanup', 'TOOLSENABLED_NIGHTLY'],
  ['tools/test/accessibility-speech.test.mjs', 'real CUDA speech, WebRTC, local consent broker and native controls', 'TOOLSENABLED_RUN_GPU_SPEECH_PROOF'],
  ['tools/test/screen-control-native.test.mjs', 'actual desktop input and capture', 'MC_SCREEN_CONTROL_NATIVE_TEST'],
].map(Object.freeze));

export function sourceCaseExecutionRequirement({ suite, files, testName, platform }) {
  if (!['win32', 'linux', 'darwin'].includes(platform) || !Array.isArray(files) ||
      files.some(file => !safeRelative(file)) || typeof testName !== 'string' || !testName) {
    throw new Error('Invalid source case execution scope');
  }
  if (suite === 'app') {
    const native = NATIVE_LINUX_CASES.find(([file, name]) => files.includes(file) && name === testName);
    if (native) return { kind: platform === 'linux' ? 'native-prerequisite-unmet' : 'companion-platform-required',
      suite, file: native[0], testName, requiredPlatform: 'linux', status: 'unexecuted' };
    const interactive = INTERACTIVE_CASES.find(([file, name]) => files.includes(file) && name === testName);
    if (interactive) return { kind: 'explicit-prerequisite-unmet', suite, file: interactive[0], testName,
      prerequisite: { environmentVariable: interactive[2], value: '1', authority: 'allocated native desktop/device or quiet timing scope' },
      status: 'unexecuted' };
  }
  // Neither a candidate's skip reason nor a substring such as "Linux" grants
  // a platform classification to an unreviewed case.
  return { kind: 'unmapped-execution-prerequisite', suite, testName, status: 'unexecuted' };
}

export function reconcileSourceCommands({ aliases, selectedFiles, coveredCommands = [], contextCommands = [], readSuiteList }) {
  const selected = new Set(selectedFiles.map(portable));
  const covered = new Set(coveredCommands.map(command => JSON.stringify(command.map(portable))));
  const actions = [], obligations = [], lists = new Map();
  const problem = (id, alias, detail) => obligations.push({ id, alias, ...detail });
  const add = (alias, command) => {
    const normalized = command.map(portable);
    const key = JSON.stringify(normalized);
    if (!actions.some(action => JSON.stringify(action.command) === key)) actions.push({ alias, command: normalized });
    // This wrapper takes mandatory execution context and does work beyond the
    // leaf census. A generic covered command (or a selected filename) cannot
    // discharge it. Only the fixed context-aware executor can bind it.
    if (normalized[0] === 'node' && normalized[1] === 'tools/test-strict.mjs') {
      if (normalized.length === 2 && contextCommands.some(action =>
        action.context === 'app-strict-engine-scratch' && JSON.stringify(action.command) === key)) return;
      problem('unmapped-required-command', alias, { command: normalized });
      return;
    }
    if (normalized[0] === 'node' && normalized[1] === 'tools/qa/page2-role-studio-interaction.cjs') {
      if (normalized.length === 2 && contextCommands.some(action =>
        action.context === 'app-role-studio-component' && JSON.stringify(action.command) === key)) return;
      problem('unmapped-required-command', alias, { command: normalized });
      return;
    }
    if (normalized[0] === 'node' && ['tools/cold-start-check.js', 'tools/idle-cpu-check.js'].includes(normalized[1])) {
      if (normalized.length === 2 && contextCommands.some(action =>
        action.context === 'engine-isolated-performance' && JSON.stringify(action.command) === key)) return;
      problem('unmapped-required-command', alias, { command: normalized });
      return;
    }
    if (covered.has(key)) return;
    if (normalized[0] === 'node' && normalized.length === 2 && selected.has(normalized[1])) return;
    if (normalized[0] === 'python' && normalized.length === 2 && selected.has(normalized[1])) return;
    if (normalized[0] === 'node' && normalized[1] === '--test') {
      const files = normalized.slice(2).filter(value => !['--test-reporter=tap', '--test-concurrency=1'].includes(value));
      if (files.length && files.every(file => selected.has(file)) && !files.some(file => file.startsWith('-'))) return;
    }
    problem('unmapped-required-command', alias, { command: normalized });
  };
  const expand = (alias, ancestry = []) => {
    if (ancestry.includes(alias)) { problem('cyclic-required-alias', alias, { ancestry }); return; }
    if (!Object.hasOwn(aliases, alias)) { problem('missing-required-alias', alias, {}); return; }
    const source = aliases[alias];
    if (typeof source !== 'string' || !source.trim()) { problem('empty-required-command', alias, {}); return; }
    if (/[\r\n\x00"'`$;|<>]/.test(source) || source.replaceAll('&&', '').includes('&')) {
      problem('unsupported-required-command-syntax', alias, {}); return;
    }
    for (const part of source.split('&&')) visit(alias, part.trim().split(/\s+/), [...ancestry, alias]);
  };
  const visit = (alias, tokens, ancestry) => {
    if (tokens[0] === 'npm' && tokens[1] === 'run' && tokens.length === 3) { expand(tokens[2], ancestry); return; }
    if (tokens[0] === 'node' && portable(tokens[1] || '') === 'tools/check-chain-runner.js') {
      const first = tokens.indexOf('--then');
      const prefix = tokens.slice(2, first);
      const name = prefix.indexOf('--name');
      if (first < 0 || name < 0 || !prefix[name + 1] || prefix.some((value, index) => value !== '--strict' && index !== name && index !== name + 1)) {
        problem('unsupported-required-chain', alias, { command: tokens }); return;
      }
      for (let start = first + 1; start <= tokens.length;) {
        const next = tokens.indexOf('--then', start);
        const step = tokens.slice(start, next < 0 ? tokens.length : next);
        if (step[0] === '--id' && step[1]) step.splice(0, 2);
        if (!step.length || step[0].startsWith('--')) problem('unsupported-required-chain-step', alias, { command: step });
        else visit(alias, step, ancestry);
        if (next < 0) break;
        start = next + 1;
      }
      return;
    }
    if (tokens[0] === 'node' && portable(tokens[1] || '') === 'tests/run-isolated.js') {
      const files = [];
      for (let index = 2; index < tokens.length; index++) {
        const item = tokens[index];
        if (['--continue', '--config-integrity'].includes(item)) continue;
        if (item === '--from') {
          const file = tokens[++index];
          if (!safeRelative(file) || typeof readSuiteList !== 'function') { problem('unmeasured-required-suite-list', alias, { file }); continue; }
          try {
            const content = readSuiteList(portable(file));
            if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw new Error('invalid suite-list bytes');
            const entries = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
            if (!entries.length || entries.some(entry => !safeRelative(entry))) throw new Error('empty or invalid suite list');
            lists.set(portable(file), content);
            files.push(...entries.map(portable));
          } catch { problem('unmeasured-required-suite-list', alias, { file }); }
          continue;
        }
        if (item.startsWith('-') || !safeRelative(item)) { problem('unmapped-required-runner-mode', alias, { argument: item }); continue; }
        files.push(portable(item));
      }
      if (!files.length) problem('empty-required-command', alias, { command: tokens });
      for (const file of files) {
        if (selected.has(file)) continue;
        // A named runner is not an assertion file, but an independently run
        // fixed action can account for it. Do not extend this to unknown
        // helpers/workers or erase arguments on mode-bearing invocations.
        const command = ['node', file];
        if (covered.has(JSON.stringify(command))) add(alias, command);
        else problem('unselected-required-test', alias, { file });
      }
      return;
    }
    add(alias, tokens);
  };
  for (const alias of Object.keys(aliases).sort()) expand(alias);
  const unique = [...new Map(obligations.map(row => [JSON.stringify(row), row])).values()];
  return { actions, suiteLists: [...lists].map(([file, content]) => ({ file, content })), obligations: unique, complete: unique.length === 0 };
}
