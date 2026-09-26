import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { browserPaths, browserCases, pendingJourney, runJourney, validateJourneys } from '../lib/surface-tests/journeys.mjs'

// Run the actual driver orchestration, replacing only filesystem/process/browser
// boundaries. These tests prove ordering and failure handling, not rendered UI.
const sourceUrl = new URL('../surface-browser.mjs', import.meta.url)
const source = fs.readFileSync(sourceUrl, 'utf8')
const body = source.replace(/^#!.*\n/, '').replace(/^import .*\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(sourceUrl.href))
const out = path.resolve('inert-browser-proof.json')
function harness({ failAction, failClose = false, failBrowserClose = false } = {}) {
  const state = { files: new Map(), calls: [], activePages: 0, created: 0, launches: 0, finished: 0 }
  const browser = {
    newContext: async () => {
      const id = state.created++
      return {
        newPage: async () => {
          assert.equal(state.activePages, 0, 'another page cannot open before owned cleanup')
          state.activePages++
          return { setDefaultTimeout() {}, on() {}, async screenshot() {} }
        },
        close: async () => {
          state.calls.push('close:' + id)
          if (failClose) throw Error('Context cleanup uncertain')
          state.activePages--; state.finished++
        },
      }
    },
    close: async () => {
      state.calls.push('browser-close')
      if (failBrowserClose) throw Error('Browser cleanup uncertain')
    },
  }
  const engines = Object.fromEntries(['chromium', 'webkit'].map(name => [name, { launch: async () => { state.launches++; return browser } }]))
  const sterile = {
    prepareSterileProfile: x => x, sterileProfileDirectories: x => x, sterileLaunchEnvironment: () => ({}),
  }
  const proc = { argv: ['node', 'driver', '--release', path.resolve('inert-release'), '--out', out, '--matrix', 'mobile', '--profile', 'full'],
    env: { TESTKIT_PLAYWRIGHT_ROOT: path.resolve('inert-kit') }, platform: process.platform, stdout: { write() {} } }
  const context = {
    fs: { existsSync: () => false, mkdirSync() {}, writeFileSync: (p, data) => state.files.set(p, data) },
    path, fileURLToPath, process: proc, console,
    createRequire: () => name => name === 'playwright' ? engines : sterile,
    browserPaths, browserCases, pendingJourney, runJourney, validateJourneys,
    fenceGeometryContext: async () => [],
    serveCandidateRenderer: async () => ({ origin: 'http://inert.invalid', staticPath: '/', provenance: { fixture: true }, close: async () => state.calls.push('server-close') }),
    browserActions: () => Object.fromEntries(browserPaths('mobile').flatMap(p => p.steps.map(s => [s.id, async () => {
      state.calls.push(s.id)
      if (s.id === failAction) throw Error('Control unreachable at ' + s.id)
      return { verified: true, observed: 'Inert observation for ' + s.id }
    }]))),
  }
  return {
    state, proc,
    run: () => vm.runInNewContext('(async () => {\n' + body + '\n})()', context, { filename: sourceUrl.pathname }),
    report: () => JSON.parse(state.files.get(out)),
  }
}

test('actual browser driver completes every ordered path and closes before the next page', async () => {
  const h = harness()
  await h.run()
  const r = h.report()
  // Global check() is intentionally never replaced by a fabricated UI count.
  // Our inert actions only exercise journey state; the driver must not claim
  // overall rendered success without its independent positive geometry checks.
  assert.equal(r.ok, false)
  assert.equal(r.tests, 0)
  assert.equal(r.cleanupConfirmed, true)
  assert.equal(h.state.created, 8)
  assert.equal(h.state.finished, 8)
  assert.equal(h.state.activePages, 0)
  for (const c of r.cases) assert.equal(validateJourneys(browserPaths('mobile'), c.journeys), null)
  const onePath = browserPaths('mobile').flatMap(p => p.steps.map(s => s.id))
  assert.deepEqual(h.state.calls.slice(0, onePath.length), onePath)
})

test('actual driver stops after unconfirmed context cleanup and preserves future NOT_RUN paths', async () => {
  const h = harness({ failClose: true })
  await h.run()
  const r = h.report()
  assert.equal(h.proc.exitCode, 1)
  assert.equal(h.state.created, 1)
  assert.equal(h.state.launches, 1)
  assert.equal(r.cleanupConfirmed, false)
  assert.equal(r.cases[0].cleanupConfirmed, false)
  assert.equal(r.cases[0].status, 'FAIL')
  assert.match(r.cases[0].cleanupError, /uncertain/)
  assert.ok(r.cases.slice(1).every(c => c.status === 'NOT_RUN' && c.journeys.every(j => j.status === 'NOT_RUN')))
})

test('actual driver never launches another engine after browser-close failure', async () => {
  const h = harness({ failBrowserClose: true })
  await h.run()
  assert.equal(h.report().cleanupConfirmed, false)
  assert.equal(h.state.launches, 1)
  assert.equal(h.state.created, 4)
  assert.ok(h.report().cases.slice(4).every(c => c.status === 'NOT_RUN'))
  assert.ok(h.report().errors.some(e => /Browser cleanup uncertain/.test(e.error)))
})

test('actual driver captures failure and leaves dependent steps unexecuted', async () => {
  const h = harness({ failAction: 'no-agent' })
  await h.run()
  assert.equal(h.proc.exitCode, 1)
  assert.equal(h.state.calls.includes('clear-agent'), false)
  assert.equal(h.state.calls.includes('return-home'), false)
  assert.equal(h.state.finished, 8)
  const j = h.report().cases[0].journeys.find(p => p.id === 'pg2-agent-return')
  assert.equal(j.status, 'FAIL')
  assert.match(j.steps.find(s => s.id === 'no-agent').failureCapture.screenshot, /no-agent-failure\.png$/)
  assert.ok(j.steps.slice(j.steps.findIndex(s => s.id === 'no-agent') + 1).every(s => s.status === 'NOT_RUN'))
})
