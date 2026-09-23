/* THE THREE NEW VERBS ON THE SAME window.mcProviders BRIDGE: detectLocal(),
 * installRuntime(), pullModel() (exposed to the renderer as pullLocalModel).
 * Added to shell/provider-login.cjs rather than a parallel bridge, on the
 * owner ruling (via fleet-B) that a local runtime should extend the existing
 * provider surface, never duplicate it -- confirmed necessary by three
 * concrete misfits in the EXISTING verbs:
 *
 *   installStart()  hardcodes `npm install -g <package>` and refuses without
 *                   npm on PATH. Ollama/LM Studio/llama.cpp/vLLM install via
 *                   winget or pip, never npm.
 *   loginStart()    opens a terminal for a program's OWN interactive sign-in.
 *                   A local runtime has no sign-in step at all
 *                   (local-node-runtime.js: "NO CREDENTIAL, ANYWHERE ON THIS
 *                   PATH").
 *   presence()      -> provider-cli-presence.cjs, filesystem/PATH-only BY
 *                   DESIGN (never spawns, never makes a network call). Local
 *                   readiness is inherently a live network probe.
 *
 * So this file tests the three NEW verbs directly, reusing the exact harness
 * shape tools/test/provider-login.test.mjs already established for the
 * existing ones (same fake spawnHidden/statSync/lstatSync/env/platform
 * injection), plus a fake `localNodeRuntime` module standing in for the
 * engine's src/lib/providers/local-node-runtime.js.
 *
 * Run: node --test tools/test/local-model-bridge.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE_FILE = path.join(REPO_ROOT, 'shell', 'provider-login.cjs')

const {
  createProviderLoginService,
  splitCommandLine,
  LOCAL_MODEL_NAME_RE,
  WINGET_UNATTENDED_ARGS,
} = require_(MODULE_FILE)

const norm = value => String(value).replace(/\\/g, '/').toLowerCase()
function enoent() {
  const error = new Error('ENOENT')
  error.code = 'ENOENT'
  throw error
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true; child.emit('exit', null); return true }
  return child
}

/* A minimal, honest stand-in for the engine's local-node-runtime.js. Shaped
   exactly like the real module's exports the shell reads: RUNTIMES,
   CURATED_MODELS, detect(). Real command strings, copied from the engine
   source read for this task (not invented), so a test that depends on their
   exact shape (space-separated, single executable) is testing the real
   contract. */
function fakeLocalNodeRuntime({ detectResult = null, detectError = null } = {}) {
  const RUNTIMES = {
    ollama: {
      id: 'ollama', displayName: 'Ollama', port: 11434,
      installCommand: 'winget install Ollama.Ollama',
      installCommandPosix: 'curl -fsSL https://ollama.com/install.sh | sh',
      pullCommand: model => `ollama pull ${model}`,
    },
    'lm-studio': {
      id: 'lm-studio', displayName: 'LM Studio', port: 1234,
      installCommand: 'winget install ElementLabs.LMStudio',
      installCommandPosix: 'See lmstudio.ai (no single-command installer on this platform)',
      pullCommand: model => `lms get ${model}`,
    },
    'llama-cpp': {
      id: 'llama-cpp', displayName: 'llama.cpp (llama-server)', port: 8080,
      installCommand: 'winget install ggml.llamacpp',
      installCommandPosix: 'brew install llama.cpp',
      pullCommand: model => `llama-server -hf ${model}`,
    },
    vllm: {
      id: 'vllm', displayName: 'vLLM', port: 8000,
      installCommand: 'pip install vllm',
      installCommandPosix: 'pip install vllm',
      pullCommand: model => `vllm serve ${model}`,
    },
  }
  const CURATED_MODELS = [
    { id: 'qwen2.5:3b-instruct', label: 'Qwen 2.5 3B Instruct', minFreeVramBytes: 3 * 1024 ** 3, capabilities: ['chat', 'tools'] },
  ]
  return {
    RUNTIMES,
    CURATED_MODELS,
    async detect() {
      if (detectError) throw detectError
      return detectResult || { ready: false, runtimes: [], selected: null, reason: 'nothing listening', nextCommand: 'winget install Ollama.Ollama' }
    },
  }
}

/* These fictional files exhaust the explicitly completed fixture search.
   Incomplete snapshots below must never mean an absent installer/runtime. */
function completeSearchPath({ env, platform }) {
  const fallback = platform === 'win32' ? 'C:/fixture/programs' : '/fixture/programs'
  return Object.freeze({
    directories: Object.freeze((env.PATH || fallback).split(platform === 'win32' ? ';' : ':').filter(Boolean)),
    complete: true,
  })
}
const incompleteSearchPath = options => Object.freeze({ ...completeSearchPath(options), complete: false })

/* `links` are Windows app execution aliases (how winget.exe normally sits in
   %LOCALAPPDATA%\Microsoft\WindowsApps): statSync throws EACCES on them and
   lstatSync answers, the same measured shape provider-login.test.mjs uses. */
function harness({ files = [], links = [], env = {}, platform = 'win32', localNodeRuntime = fakeLocalNodeRuntime(), localNodeProcess = null, readSearchPath = completeSearchPath } = {}) {
  const plain = new Set(files.map(norm))
  const linked = new Set(links.map(norm))
  const spawns = []
  const child = fakeChild()
  const service = createProviderLoginService({
    spawnHidden: (command, args, options) => { spawns.push({ command, args, options }); return child },
    openTerminal: () => {},
    providerSpawnRefused: () => false,
    env: { APPDATA: 'C:/u/AppData/Roaming', SystemRoot: 'C:/Windows', PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env },
    platform,
    readSearchPath,
    statSync: target => {
      if (plain.has(norm(target))) return { isFile: () => true }
      if (linked.has(norm(target))) { const error = new Error('EACCES'); error.code = 'EACCES'; throw error }
      return enoent()
    },
    lstatSync: target => { if (linked.has(norm(target))) return { isSymbolicLink: () => true }; return enoent() },
    localNodeRuntime,
    localNodeProcess,
  })
  return { service, spawns, child }
}

const WINGET = 'C:/Windows/System32/winget.exe'
const OLLAMA = 'C:/u/AppData/Roaming/ollama.exe'
const PIP = 'C:/u/AppData/Roaming/pip.exe'
const ROAMING_PATH = { PATH: 'C:/u/AppData/Roaming' }

test('an incomplete Windows search keeps local installer absence unknown', () => {
  const { service, spawns } = harness({ readSearchPath: incompleteSearchPath })
  assert.equal(service.installRuntime('ollama', () => {}).code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
  assert.equal(spawns.length, 0)
})

test('an incomplete Windows search keeps local runtime absence unknown', () => {
  const { service, spawns } = harness({ readSearchPath: incompleteSearchPath })
  assert.equal(service.pullModel({ runtime: 'ollama', model: 'qwen2.5:3b-instruct' }, () => {}).code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
  assert.equal(spawns.length, 0)
})

test('an incomplete Windows search still accepts a known local installer and runtime', () => {
  const { service, spawns, child } = harness({
    files: [WINGET, OLLAMA], env: { PATH: 'C:/Windows/System32;C:/u/AppData/Roaming' },
    readSearchPath: incompleteSearchPath,
  })
  assert.equal(service.installRuntime('ollama', () => {}).ok, true)
  assert.equal(service.pullModel({ runtime: 'ollama', model: 'qwen2.5:3b-instruct' }, () => {}).ok, true)
  assert.equal(spawns.length, 2)
  child.emit('exit', 0)
})

// ------------------------------------------------------------------
// splitCommandLine -- pure, real execution.
// ------------------------------------------------------------------

test('splitCommandLine splits a table command into an executable and its args', () => {
  assert.deepEqual(splitCommandLine('winget install Ollama.Ollama'), ['winget', 'install', 'Ollama.Ollama'])
  assert.deepEqual(splitCommandLine('pip install vllm'), ['pip', 'install', 'vllm'])
  assert.deepEqual(splitCommandLine('  extra   spaces   collapse  '), ['extra', 'spaces', 'collapse'])
  assert.deepEqual(splitCommandLine(''), [])
  assert.deepEqual(splitCommandLine(undefined), [])
})

test('LOCAL_MODEL_NAME_RE accepts real model ids and refuses garbage', () => {
  for (const good of ['qwen2.5:3b-instruct', 'llama3.1:8b-instruct', 'qwen2.5-coder:7b']) {
    assert.ok(LOCAL_MODEL_NAME_RE.test(good), `${good} should be a valid model id`)
  }
  for (const bad of ['', ' ', 'has a space', '-starts-with-dash', 'x'.repeat(201)]) {
    assert.ok(!LOCAL_MODEL_NAME_RE.test(bad), `"${bad}" should not be a valid model id`)
  }
})

// ------------------------------------------------------------------
// detectLocal()
// ------------------------------------------------------------------

test('detectLocal answers LOCAL_MODEL_UNAVAILABLE when the engine module was never resolved', async () => {
  const { service } = harness({ localNodeRuntime: null })
  const answer = await service.detectLocal()
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_UNAVAILABLE')
})

test('detectLocal does not call a generic runtime ready until the interactive adapter proves it can start', async () => {
  const ready = { ready: true, runtimes: [{ runtime: 'ollama', listening: true }], selected: { runtime: 'ollama', displayName: 'Ollama' }, reason: null, nextCommand: null }
  const { service } = harness({ localNodeRuntime: fakeLocalNodeRuntime({ detectResult: ready }) })
  const answer = await service.detectLocal()
  assert.equal(answer.ok, true)
  assert.equal(answer.ready, false)
  assert.equal(answer.code, 'LOCAL_MODEL_LAUNCHER_UNAVAILABLE')
  assert.deepEqual(answer.selected, ready.selected)
  assert.equal(answer.curatedModels[0].id, 'qwen2.5:3b-instruct', 'the curated list must ride along on the same call')
})

test('detectLocal uses the interactive resolver and refuses a discovered non-Ollama runtime', async () => {
  const ready = { ready: true, runtimes: [{ runtime: 'lm-studio', listening: true }], selected: { runtime: 'lm-studio' }, reason: null, nextCommand: null }
  const runtime = fakeLocalNodeRuntime({ detectResult: ready })
  const { service } = harness({ localNodeRuntime: runtime, localNodeProcess: {
    resolveLocalTarget: async () => { throw Object.assign(new Error('unsupported'), { code: 'LOCAL_NODE_RUNTIME_UNSUPPORTED' }) }
  } })
  const answer = await service.detectLocal()
  assert.equal(answer.ok, true)
  assert.equal(answer.ready, false)
  assert.equal(answer.code, 'LOCAL_NODE_RUNTIME_UNSUPPORTED')
})

test('detectLocal reports ready only after the interactive resolver returns a target', async () => {
  const ready = { ready: true, runtimes: [{ runtime: 'ollama', listening: true }], selected: { runtime: 'ollama' }, reason: null, nextCommand: null }
  let calls = 0
  const { service } = harness({ localNodeRuntime: fakeLocalNodeRuntime({ detectResult: ready }), localNodeProcess: {
    resolveLocalTarget: async () => { calls += 1; return { runtime: 'ollama', model: 'qwen2.5:3b-instruct' } }
  } })
  const answer = await service.detectLocal()
  assert.equal(answer.ready, true)
  assert.equal(calls, 1)
})

test('detectLocal answers a named failure rather than throwing when detect() itself throws', async () => {
  const { service } = harness({ localNodeRuntime: fakeLocalNodeRuntime({ detectError: new Error('ECONNRESET') }) })
  const answer = await service.detectLocal()
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_DETECT_FAILED')
})

// ------------------------------------------------------------------
// installRuntime()
// ------------------------------------------------------------------

test('installRuntime refuses an unknown runtime id by name', () => {
  const { service } = harness()
  const answer = service.installRuntime('not-a-real-runtime', () => {})
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_RUNTIME_UNKNOWN')
})

test('installRuntime refuses to execute on a non-win32 platform and names the POSIX command', () => {
  const { service, spawns } = harness({ platform: 'darwin' })
  const answer = service.installRuntime('ollama', () => {})
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_INSTALL_UNSUPPORTED')
  assert.match(answer.reason, /curl -fsSL https:\/\/ollama\.com\/install\.sh \| sh/, 'the refusal must name the real POSIX command')
  assert.equal(spawns.length, 0, 'nothing may be spawned on a platform this cannot run unattended')
})

test('installRuntime refuses when the resolved executable is not on PATH, naming the fix', () => {
  const { service, spawns } = harness({ files: [] }) // winget nowhere on PATH
  const answer = service.installRuntime('ollama', () => {})
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_INSTALLER_MISSING')
  assert.match(answer.reason, /winget install Ollama\.Ollama/)
  assert.equal(spawns.length, 0)
})

/* The exact winget line a local runtime installs with: the named package id
   only (no fuzzy name search), from the winget source only (never the Store),
   for this user only (LM Studio's own package also carries an all-users
   installer), with no prompt left open. The same shape Codex's WinGet install
   already uses. */
const wingetLine = id => ['install', '--id', id, '--exact', '--source', 'winget',
  '--scope', 'user', '--disable-interactivity', ...WINGET_UNATTENDED_ARGS]

test('installRuntime spawns winget for this user, by exact package id, with its unattended flags, on win32', () => {
  const { service, spawns } = harness({ files: [WINGET], env: { PATH: 'C:/Windows/System32' } })
  const answer = service.installRuntime('ollama', () => {})
  assert.equal(answer.ok, true)
  assert.equal(spawns.length, 1)
  assert.equal(norm(spawns[0].command), norm(WINGET))
  assert.deepEqual(spawns[0].args, wingetLine('Ollama.Ollama'))
})

test('every winget runtime installs for this user only, never for the whole computer', () => {
  for (const [runtime, id] of [['ollama', 'Ollama.Ollama'], ['lm-studio', 'ElementLabs.LMStudio'], ['llama-cpp', 'ggml.llamacpp']]) {
    const { service, spawns, child } = harness({ files: [WINGET], env: { PATH: 'C:/Windows/System32' } })
    assert.equal(service.installRuntime(runtime, () => {}).ok, true, runtime)
    assert.deepEqual(spawns[0].args, wingetLine(id), runtime)
    assert.ok(!spawns[0].args.includes('machine'), `${runtime} must never ask for a machine-wide install`)
    child.emit('exit', 0)
  }
})

test('installRuntime finds winget through the Windows app execution alias it normally is', () => {
  const alias = 'C:/u/AppData/Local/Microsoft/WindowsApps/winget.exe'
  const { service, spawns } = harness({ links: [alias], env: { PATH: 'C:/u/AppData/Local/Microsoft/WindowsApps' } })
  const answer = service.installRuntime('ollama', () => {})
  assert.equal(answer.ok, true, `winget behind an app execution alias must be found, got ${answer.code}`)
  assert.equal(spawns.length, 1)
  assert.equal(norm(spawns[0].command), norm(alias))
  assert.deepEqual(spawns[0].args, wingetLine('Ollama.Ollama'))
})

test('installRuntime never runs pip for vLLM: it shows the command as text and changes no Python', () => {
  // pip is right there on PATH; the person's first Python is still not ours to change.
  const { service, spawns } = harness({ files: [PIP, WINGET], env: { PATH: 'C:/u/AppData/Roaming;C:/Windows/System32' } })
  const answer = service.installRuntime('vllm', () => {})
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_INSTALL_UNSUPPORTED')
  assert.match(answer.reason, /pip install vllm/, 'the refusal must still name the real command to run by hand')
  assert.match(answer.reason, /Python/, 'the refusal says why: it would change a Python on this computer')
  assert.match(answer.reason, /WSL/, 'vLLM has no native Windows build; the refusal says where it does run')
  assert.equal(spawns.length, 0, 'nothing may be spawned for a pip install')
})

test('installRuntime runs only a winget install from the table; any other command is shown, never run', () => {
  const runtime = fakeLocalNodeRuntime()
  runtime.RUNTIMES.ollama = { ...runtime.RUNTIMES.ollama, installCommand: 'powershell -c irm https://ollama.com/install.ps1 | iex' }
  runtime.RUNTIMES['lm-studio'] = { ...runtime.RUNTIMES['lm-studio'], installCommand: 'winget install ElementLabs.LMStudio --scope machine' }
  const { service, spawns } = harness({ files: [WINGET, 'C:/Windows/System32/powershell.exe'], env: { PATH: 'C:/Windows/System32' }, localNodeRuntime: runtime })
  for (const id of ['ollama', 'lm-studio']) {
    const answer = service.installRuntime(id, () => {})
    assert.equal(answer.ok, false, id)
    assert.equal(answer.code, 'LOCAL_MODEL_INSTALL_UNSUPPORTED', id)
    assert.ok(answer.reason.includes(runtime.RUNTIMES[id].installCommand), `${id}: the refusal names the command to run by hand`)
  }
  assert.equal(spawns.length, 0)
})

test('installRuntime refuses a second install for the same runtime while one is already running', () => {
  const { service } = harness({ files: [WINGET], env: { PATH: 'C:/Windows/System32' } })
  assert.equal(service.installRuntime('ollama', () => {}).ok, true)
  const again = service.installRuntime('ollama', () => {})
  assert.equal(again.ok, false)
  assert.equal(again.code, 'LOCAL_MODEL_INSTALL_RUNNING')
})

test('installRuntime for one runtime does not block installRuntime for a different one', () => {
  const { service } = harness({ files: [WINGET], env: { PATH: 'C:/Windows/System32' } })
  assert.equal(service.installRuntime('ollama', () => {}).ok, true)
  assert.equal(service.installRuntime('lm-studio', () => {}).ok, true, 'a second, DIFFERENT runtime install must not be blocked by the first')
})

test('installRuntime answers LOCAL_MODEL_UNAVAILABLE with no engine module, and starts nothing', () => {
  const { service, spawns } = harness({ files: [WINGET], localNodeRuntime: null })
  const answer = service.installRuntime('ollama', () => {})
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_UNAVAILABLE')
  assert.equal(spawns.length, 0)
})

test('installRuntime forwards bounded, colour-stripped lines and an exit code through fly()', () => {
  const { service, child } = harness({ files: [WINGET], env: { PATH: 'C:/Windows/System32' } })
  const events = []
  service.installRuntime('ollama', event => events.push(event))
  child.stdout.emit('data', 'Downloading Ollama...\n')
  child.emit('exit', 0)
  assert.deepEqual(events.map(e => e.kind), ['line', 'exit'])
  assert.equal(events[0].text, 'Downloading Ollama...')
  assert.equal(events[0].op, 'install')
  assert.equal(events[1].code, 0)
})

// ------------------------------------------------------------------
// pullModel()
// ------------------------------------------------------------------

test('pullModel refuses an unknown runtime id', () => {
  const { service } = harness()
  const answer = service.pullModel({ runtime: 'not-real', model: 'qwen2.5:3b-instruct' }, () => {})
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_RUNTIME_UNKNOWN')
})

test('pullModel refuses a malformed model name before touching the runtime table', () => {
  const { service, spawns } = harness({ files: [OLLAMA] })
  for (const bad of ['', 'has a space', undefined, 42]) {
    const answer = service.pullModel({ runtime: 'ollama', model: bad }, () => {})
    assert.equal(answer.ok, false, `"${bad}" must be refused`)
    assert.equal(answer.code, 'LOCAL_MODEL_INPUT_INVALID')
  }
  assert.equal(spawns.length, 0)
})

test('pullModel is scoped to ollama: the other three runtimes are refused by name, with their real command shown', () => {
  const { service, spawns } = harness({ files: [OLLAMA] })
  const cases = [
    ['lm-studio', /lms get qwen2\.5:3b-instruct/],
    ['llama-cpp', /llama-server -hf qwen2\.5:3b-instruct/],
    ['vllm', /vllm serve qwen2\.5:3b-instruct/],
  ]
  for (const [runtime, expectedCommand] of cases) {
    const answer = service.pullModel({ runtime, model: 'qwen2.5:3b-instruct' }, () => {})
    assert.equal(answer.ok, false, `${runtime} must be refused in this pass`)
    assert.equal(answer.code, 'LOCAL_MODEL_PULL_UNSUPPORTED')
    assert.match(answer.reason, expectedCommand, `the refusal for ${runtime} must name its real pull command`)
  }
  assert.equal(spawns.length, 0, 'none of the three unsupported runtimes may spawn anything')
})

test('pullModel refuses when ollama itself is not on PATH', () => {
  const { service, spawns } = harness({ files: [] })
  const answer = service.pullModel({ runtime: 'ollama', model: 'qwen2.5:3b-instruct' }, () => {})
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'LOCAL_MODEL_RUNTIME_NOT_INSTALLED')
  assert.equal(spawns.length, 0)
})

test('pullModel spawns "ollama pull <model>" directly, no shell, when ollama is found', () => {
  const { service, spawns } = harness({ files: [OLLAMA], env: ROAMING_PATH })
  const answer = service.pullModel({ runtime: 'ollama', model: 'qwen2.5:3b-instruct' }, () => {})
  assert.equal(answer.ok, true)
  assert.equal(spawns.length, 1)
  assert.equal(norm(spawns[0].command), norm(OLLAMA))
  assert.deepEqual(spawns[0].args, ['pull', 'qwen2.5:3b-instruct'])
  assert.equal(spawns[0].options.shell, undefined, 'no shell option may be set -- spawnHidden refuses one')
})

test('pullModel refuses a second download of the SAME model while it is running, but allows a different one', () => {
  const { service } = harness({ files: [OLLAMA], env: ROAMING_PATH })
  assert.equal(service.pullModel({ runtime: 'ollama', model: 'qwen2.5:3b-instruct' }, () => {}).ok, true)
  const again = service.pullModel({ runtime: 'ollama', model: 'qwen2.5:3b-instruct' }, () => {})
  assert.equal(again.ok, false)
  assert.equal(again.code, 'LOCAL_MODEL_PULL_RUNNING')
  const different = service.pullModel({ runtime: 'ollama', model: 'llama3.1:8b-instruct' }, () => {})
  assert.equal(different.ok, true, 'a DIFFERENT model must not be blocked by another one downloading')
})

test('pullModel does not collide with installRuntime\'s flight key for the same runtime', () => {
  const { service } = harness({ files: [WINGET, OLLAMA], env: { PATH: 'C:/Windows/System32;C:/u/AppData/Roaming' } })
  assert.equal(service.installRuntime('ollama', () => {}).ok, true)
  assert.equal(service.pullModel({ runtime: 'ollama', model: 'qwen2.5:3b-instruct' }, () => {}).ok, true,
    'an install in flight for ollama must not block a pull for ollama -- they are different flight keys')
})

// ------------------------------------------------------------------
// stop()/stopAll() already generic -- confirm they really do cover the new
// flight keys without any change on their part.
// ------------------------------------------------------------------

test('the existing generic stop() and stopAll() already cover local-model flights, by construction', () => {
  const { service, child } = harness({ files: [WINGET], env: { PATH: 'C:/Windows/System32' } })
  service.installRuntime('ollama', () => {})
  assert.equal(service.running('local-install:ollama'), true)
  const stopped = service.stop('local-install:ollama')
  assert.equal(stopped.ok, true)
  assert.equal(stopped.stopped, true)
  assert.equal(child.killed, true)
})

test('stopAll kills a running local-model flight the same as a CLI-provider one', () => {
  const { service, spawns } = harness({ files: [WINGET, OLLAMA], env: { PATH: 'C:/Windows/System32;C:/u/AppData/Roaming' } })
  service.installRuntime('ollama', () => {})
  service.pullModel({ runtime: 'ollama', model: 'qwen2.5:3b-instruct' }, () => {})
  assert.equal(spawns.length, 2)
  assert.equal(service.running('local-install:ollama'), true)
  assert.equal(service.running('local-pull:ollama:qwen2.5:3b-instruct'), true)
  service.stopAll()
  /* Both flights in this harness share ONE fakeChild() (spawnHidden always
     returns the same fake), so killing it once cascades to both -- which is
     exactly stopAll()'s own generic loop calling flight.child.kill() for
     every flight it owns; two flights on one child prove the loop ran twice,
     not that it ran once and got lucky. */
  assert.equal(service.running('local-install:ollama'), false)
  assert.equal(service.running('local-pull:ollama:qwen2.5:3b-instruct'), false)
})
