import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

import { PROVIDER_SIGN_IN } from '../../src/account-panel-copy.js'
import { driveMachineTab, MACHINE_TAB_NOT_CHECKED } from '../../src/machine-tabs.js'

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: 'data:text/javascript,export default {}', shortCircuit: true }
    return nextResolve(specifier, context)
  }
`)}`)

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

function guideHarness(mcProviders) {
  const status = { role: '', textContent: '' }
  const stop = {
    disabled: false,
    hidden: true,
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener) },
    async click() { await this.listeners.get('click')?.() },
  }
  const panel = {
    dataset: { signinProgram: 'Codex' },
    hidden: true,
    set innerHTML(markup) {
      stop.disabled = /data-signin-stop hidden[^>]*\bdisabled\b/.test(markup)
      const renderedStatus = /<output[^>]*role="status"[^>]*data-signin-status>([\s\S]*?)<\/output>/.exec(markup)
      status.role = renderedStatus ? 'status' : ''
      status.textContent = renderedStatus?.[1] || ''
    },
    querySelector(selector) {
      if (selector === '[data-signin-status]') return status
      if (selector === '[data-signin-stop]') return stop
      return { addEventListener() {} }
    },
  }
  const presenceSlot = { dataset: {}, hidden: true, textContent: '' }
  const root = {
    isConnected: true,
    dataset: {}, // a real element carries one; the section stamps its released flag on it
    querySelector(selector) {
      if (selector.includes('.guide-signin')) return panel
      if (selector.includes('.guide-presence')) return presenceSlot
      return null
    },
    querySelectorAll() { return [] },
  }
  globalThis.window = { mcProviders }
  globalThis.document = {
    createElement(name) {
      assert.equal(name, 'template')
      return { content: { firstElementChild: root }, set innerHTML(_markup) {} }
    },
  }
  return { root, panel, status, stop }
}

test('a missing Stop verb disables Stop and puts its named reason on the rendered panel', async () => {
  const harness = guideHarness({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'yes', signedIn: 'no' }] }),
    loginStart: async () => ({ ok: true }),
    installStart: async () => ({ ok: true }),
  })
  // The provider panel now lives in the Settings section module (2026-09-10); it paints the same .guide-signin panel.
  const { createThisComputerSettings } = await import('../../src/this-computer-settings.js')
  createThisComputerSettings()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(harness.stop.disabled, true, 'Stop remains enabled when the bridge has no stop operation')
  assert.equal(harness.stop.listeners.has('click'), false, 'the unavailable Stop control still invokes a handler')
  assert.equal(harness.status.role, 'status', 'the missing-Stop reason is not in a live status region')
  assert.equal(harness.status.textContent, PROVIDER_SIGN_IN.stopUnavailable,
    'the missing-Stop reason is not exposed by the rendered status for assistive technology')
})

test('a missing workspace writer disables Finish and remains a handler refusal backstop', () => {
  const setup = read('src/views/setup.js')
  assert.match(setup, /const workspaceWriteMissing = roots\.length > 0[\s\S]*typeof globalThis\.mcSetup\?\.recordWorkspaces !== 'function'/)
  assert.match(setup, /next: 'finish'[\s\S]*nextDisabled: workspaceWriteMissing[\s\S]*nextReason: finishReason/)
  assert.match(setup, /This installed copy cannot record the chosen folder\. Update ToolsEnabled, then finish setup again\./)

  const finish = setup.slice(setup.indexOf('async function finish()'), setup.indexOf('/**\n   * Skip:'))
  assert.match(finish, /typeof globalThis\.mcSetup\?\.recordWorkspaces !== 'function'[\s\S]*MC_SETUP_WORKSPACE_UNAVAILABLE[\s\S]*return/)
  assert.ok(finish.indexOf('MC_SETUP_WORKSPACE_UNAVAILABLE') < finish.indexOf('applyDerived()'),
    'Finish applies the profile before refusing the missing folder writer')
})

test('an absent liveness question is reported as unknown, not verified success', async () => {
  const row = { relayPairId: 'relay-test', devicePairId: 'device-test' }
  const scope = {
    mcAccount: {
      machines: async () => ({ ok: true, machines: [] }),
      machineInUse: async () => ({ ok: true }),
      chooseMachine: async () => ({ ok: true }),
    },
  }
  const result = await driveMachineTab(scope, row)
  assert.deepEqual(result, { ok: true, verified: false, sentence: MACHINE_TAB_NOT_CHECKED })

  /* COUNTING, NOT MATCHING, AND THE DIFFERENCE IS THE WHOLE TEST.
     This was assert.match on the source for setMachineNote(result.sentence).
     That spelling appears TWICE in views/computers.js -- once in the failure
     branch under `if (!result.ok)` and once on the success path -- so the regex
     could not tell which one existed. PROVEN by deleting ONLY the success-path
     call and re-running: this file stayed 3/3 GREEN while a person switching
     machines was left looking at a stale "Opening..." for ever.
     Both calls are required and neither is optional, so the honest assertion is
     that BOTH are present. A count still pins a spelling -- this file reads
     source rather than mounting a view -- but it can no longer be satisfied by
     the wrong one of the pair, which is the failure that was live. */
  const view = read('src/views/computers.js')
  const noteCalls = view.match(/setMachineNote\(result\.sentence\)/g) || []
  assert.equal(noteCalls.length, 2,
    'both the refusal path and the success path must set the machine note; one alone leaves a stale sentence on screen')
})
