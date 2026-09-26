/* THE REFUSAL A BROWSER ACTUALLY MEETS WHEN IT TRIES TO DRIVE A MACHINE.
 *
 * A machine only accepts changes from a browser if it has been told it may be
 * driven from one. The switch lives on that computer, its ruled default is OFF,
 * and nothing over the relay can turn it on -- otherwise a stolen session could
 * grant itself the permission the switch exists to withhold. So this refusal is
 * correct, expected, and the single most likely thing a real person will hit on
 * the whole web journey.
 *
 * Measured on production on 2026-08-22, the first time a browser tried to start
 * an agent on a real machine: the facade answered 403
 * MC_AGENT_PRINCIPAL_READ_ONLY, the code survived the relay and the bridge
 * intact, and the app had no sentence for it -- so it said "this copy was not
 * told why. Try once more. If it refuses again, close ToolsEnabled, open it."
 * A loop with no exit, ending in the one action that guarantees failure,
 * because a closed app cannot be reached from a browser at all. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { startRefusalSentence, START_REFUSAL } = await import(
  new URL('../../src/fleet-tree-copy.js', import.meta.url).href
)
const { CONNECT_SECTION, WEB_DRIVE_CONTROL_LABEL } = await import(
  new URL('../../src/device-claim-flow.js', import.meta.url).href
)
const { createConnectComputerSettings, forgetRememberedClaim } = await import(
  new URL('../../src/connect-computer-settings.js', import.meta.url).href
)

const REFUSED = { ok: false, code: 'MC_AGENT_PRINCIPAL_READ_ONLY' }

test('the web-drive refusal has a sentence of its own', () => {
  const said = startRefusalSentence(REFUSED)
  assert.notEqual(said, START_REFUSAL.noReasonGiven, 'the code arrives intact; it must not fall through')
  assert.ok(said.length > 40, said)
})

test('it does not send the person round the loop that cannot end', () => {
  const said = startRefusalSentence(REFUSED)
  assert.ok(!/Try once more/i.test(said), 'pressing Start again can never clear this')
  assert.ok(
    !/close ToolsEnabled/i.test(said),
    'closing the app is the one action that guarantees failure -- a closed app cannot be reached from a browser',
  )
})

test('it says where the remedy is, since it is not here', () => {
  const said = startRefusalSentence(REFUSED)
  assert.ok(/on (that|the) computer/i.test(said), 'the remedy lives on the machine, and the sentence must say so')
})

test('it says why the remedy is there, because that is the whole design', () => {
  const said = startRefusalSentence(REFUSED)
  assert.ok(
    /password|on purpose|itself/i.test(said),
    'a permission you cannot grant from here reads as a bug unless the reason is given',
  )
})

/* DRIFT LOCK. Before 2026-08-22 the sentence said "turn on being driven from
   the web" and no control by any name existed (Findings: zero writers of the
   key in src/). The sentence and the screen now read the same two constants,
   and this holds them together: the refusal names the section and the control,
   and the connected screen draws that control under that name. */
test('the sentence names the switch, and the switch exists under that name', async () => {
  const said = startRefusalSentence(REFUSED)
  assert.ok(said.includes('Settings'), said)
  assert.ok(said.includes(CONNECT_SECTION), `the section is not named: ${said}`)
  assert.ok(said.includes(WEB_DRIVE_CONTROL_LABEL), `the control is not named: ${said}`)

  forgetRememberedClaim()
  const connected = createConnectComputerSettings({
    now: () => 0,
    schedule: () => ({}),
    cancelTimer: () => {},
    resolveBridge: () => ({
      status: async () => ({ ok: true, connected: true, name: 'Desk', deviceId: 'd', pairId: 'p' }),
      begin: async () => ({ ok: false }),
      poll: async () => ({ ok: true, state: 'none' }),
      cancel: async () => ({ ok: true }),
    }),
    readWebDrive: () => false,
    writeWebDrive: () => {},
  })
  await connected.checkStatus()
  const html = connected.markup()
  assert.ok(html.includes(WEB_DRIVE_CONTROL_LABEL), 'the connected screen must draw the control the sentence names')
  assert.ok(html.includes(CONNECT_SECTION))
  assert.match(html, /data-connect-field="web-drive"/)
  connected.destroy()

  /* And a computer that is not on an account draws neither the switch nor
     the question: there is no browser that could drive it yet. */
  forgetRememberedClaim()
  for (const bridge of [null, {
    status: async () => ({ ok: true, connected: false }),
    begin: async () => ({ ok: false }),
    poll: async () => ({ ok: true, state: 'none' }),
    cancel: async () => ({ ok: true }),
  }]) {
    const idle = createConnectComputerSettings({
      now: () => 0,
      schedule: () => ({}),
      cancelTimer: () => {},
      resolveBridge: () => bridge,
      readWebDrive: () => false,
      writeWebDrive: () => {},
    })
    await idle.checkStatus()
    const drawn = idle.markup()
    assert.equal(drawn.includes(WEB_DRIVE_CONTROL_LABEL), false, `${idle.getState().phase} drew the switch`)
    assert.equal(/data-connect-field="web-drive"|One question/.test(drawn), false)
    idle.destroy()
  }
})
