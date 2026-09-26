import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { canonicalRootForTests, ENGINE_MARKER } from '../canonical-root.mjs'
import {
  PROVIDER_FREE_MODEL,
  providerFreeCompletionCount,
  startProviderFreeLocalRuntime,
  waitForProviderFreeCompletion,
} from '../lib/provider-free-local-runtime.mjs'

// WHY THIS REQUIRES THE REAL ENGINE MODULE RATHER THAN A STAND-IN.
//
// CF32 / F3 is "the free local objective starts and writes a launch record but
// never posts its provider-free completion" -- measured by
// tools/agent-dispatch-packaged-qa.mjs, which spawns the real
// tools/local-node-lane-runner.js against this rig. That runner calls exactly
// one function to get an answer: providers/local-node-runtime.js#complete().
// A re-implementation here would only prove the re-implementation works. This
// test drives the SAME function, with the SAME defaults an unconfigured
// machine resolves (see `{ settings: {} }` below), so a fix that only
// satisfies a stand-in cannot pass it.
const require_ = createRequire(import.meta.url)
const REAL_CANONICAL = canonicalRootForTests()
const RUNTIME_FILE = path.join(REAL_CANONICAL, 'src', 'lib', 'providers', 'local-node-runtime.js')
const GPU_FILE = path.join(REAL_CANONICAL, 'src', 'lib', 'ollama-gpu.js')

function canonicalReadersMissing() {
  return !existsSync(path.join(REAL_CANONICAL, ENGINE_MARKER)) || !existsSync(RUNTIME_FILE) || !existsSync(GPU_FILE)
}

const SKIP_REASON =
  `Configured ToolsEnabled engine not found at ${REAL_CANONICAL}: this test dispatches a real local ` +
  'completion through its actual src/lib/providers/local-node-runtime.js#complete(). Set MC_CANONICAL_ROOT to run it.'

// A minimal RUNTIMES-shaped file, only so startProviderFreeLocalRuntime()
// has something to patch -- the actual behaviour under test comes from
// requiring RUNTIME_FILE (the real engine module) directly, below.
function stagePortStub(root) {
  const directory = path.join(root, 'src', 'lib', 'providers')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'local-node-runtime.js'), [
    'const RUNTIMES = {',
    '  ollama: { port: 11434, id: "ollama" },',
    '  lmStudio: { port: 1234, id: "lm-studio" },',
    '  llamaCpp: { port: 8080, id: "llama-cpp" },',
    '  vllm: { port: 8000, id: "vllm" },',
    '}',
    '',
  ].join('\n'))
}

test('a local turn dispatched against the deterministic provider-free rig actually posts its completion',
  { skip: canonicalReadersMissing() ? SKIP_REASON : false },
  async () => {
    const rigRoot = mkdtempSync(path.join(tmpdir(), 'local-lane-completion-'))
    let localRuntime = null
    try {
      stagePortStub(rigRoot)
      localRuntime = await startProviderFreeLocalRuntime(rigRoot)

      const runtime = require_(RUNTIME_FILE)
      // Exactly what tools/local-node-lane-runner.js sends: no explicit
      // runtimeOptions, and a settings object standing in for a first-run
      // machine, so the module's own default policy (gpuPolicy: 'Require
      // GPU') applies. 'ollama' is the runtime detect() would select first
      // when several runtimes answer /v1/models -- the free local lane's
      // default case.
      const completion = await runtime.complete({
        prompt: 'Packaged dispatch check. If this is the free local worker, exit immediately without tools.',
        model: PROVIDER_FREE_MODEL,
        runtime: 'ollama',
        host: '127.0.0.1',
        port: localRuntime.port,
        system: 'Answer with a single line "VERDICT: PASSED".',
      }, { settings: {} })

      assert.match(completion.text, /VERDICT: PASSED/)
      assert.equal(
        await waitForProviderFreeCompletion(localRuntime, { timeoutMs: 50 }),
        true,
        `providerFreeCompletionCount=${providerFreeCompletionCount(localRuntime)} requests=${JSON.stringify(localRuntime.requests)}`,
      )
    } finally {
      if (localRuntime) await localRuntime.close()
      rmSync(rigRoot, { recursive: true, force: true })
    }
  })
