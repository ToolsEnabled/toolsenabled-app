import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { typeExactText, waitForSettingsCategory } from '../test-account-harness.mjs'
import { checkoutFixtureReady } from '../account-isolation-leak-qa.mjs'

const readTool = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

test('account isolation opens the one settings category that owns each measured row', () => {
  const source = readTool('account-isolation-leak-qa.mjs')
  assert.match(source, /OWNER_SETTING = Object\.freeze\(\{ id: 'theme', category: 'Appearance'/)
  assert.match(source, /TESTER_SETTING = Object\.freeze\(\{ id: 'uninstall_data', category: 'Data & Privacy'/)
  assert.match(source, /openSettingsCategory\(window, OWNER_SETTING\.category\)/)
  assert.match(source, /openSettingsCategory\(window, TESTER_SETTING\.category\)/)
  assert.doesNotMatch(source, /ledger\.check\('the settings drawer's "all settings" link/,
    'the redundant hidden link on Settings is not an account boundary')
})

test('settings navigation waits for the requested category DOM rather than trusting a fixed delay', async () => {
  const seen = ['System', 'System', 'Appearance']
  let clock = 0
  const result = await waitForSettingsCategory({
    evaluate: async () => seen.shift() ?? 'Appearance',
  }, 'Appearance', {
    timeoutMs: 1_000,
    pause: async milliseconds => { clock += milliseconds },
    now: () => clock,
  })
  assert.equal(result, 'clicked')
  assert.equal(clock, 500, 'the helper must keep polling past stale category DOM')
})

test('checkout fixture readiness requires both exact enabled controls', () => {
  const ready = {
    rowStates: [
      { id: 'qa-line-one', pickPresent: true, pickDisabled: false, choosable: true },
      { id: 'qa-line-two', pickPresent: true, pickDisabled: false, choosable: true },
    ],
  }
  assert.equal(checkoutFixtureReady(ready), true)
  assert.equal(checkoutFixtureReady({ rowStates: ready.rowStates.slice(0, 1) }), false)
  assert.equal(checkoutFixtureReady({
    rowStates: ready.rowStates.map(row => row.id === 'qa-line-two' ? { ...row, pickDisabled: true } : row),
  }), false)
  assert.equal(checkoutFixtureReady(null), false)
})

test('account refusals settle promptly on the markup the current account page emits', () => {
  const source = readTool('test-account-harness.mjs')
  assert.match(source, /\.fleet-profile-status\[role="alert"\]/,
    'a refused account mutation must stop the wait instead of burning the full minute')
})

test('failed account runs keep evidence and missing replay prerequisites do not throw ENOENT', () => {
  const leak = readTool('account-isolation-leak-qa.mjs')
  const session = readTool('account-isolation-session-qa.mjs')
  assert.match(leak, /completed && !failed/)
  assert.match(session, /completed && !failed/)
  assert.match(session, /function restoreEvidence\(source, destination\)/)
  assert.doesNotMatch(session, /^\s*copyFileSync\(stolen(?:AfterSignIn|BeforePasswordChange), sessionFile\)/m)
})

test('a missing product account file is a checked prerequisite failure, not an ENOENT escape', () => {
  const source = readTool('account-isolation-session-qa.mjs')
  const phaseStart = source.indexOf('const accountsFile = accountsFileFor(profile)')
  const phaseEnd = source.indexOf('completed = true', phaseStart)
  const finish = source.indexOf("ledger.finish('account boundary')", phaseEnd)
  assert.ok(phaseStart >= 0 && phaseEnd > phaseStart && finish > phaseEnd,
    'the account-file phase must complete before the ledger is finished')

  const phase = source.slice(phaseStart, phaseEnd)
  const read = phase.indexOf('intact = readFileSync(accountsFile)')
  const absentOnly = phase.indexOf("if (error?.code !== 'ENOENT') throw error")
  const prerequisite = phase.indexOf("ledger.check('the product account file exists before its corrupt-file behavior is tested'")
  const guard = phase.indexOf('if (intact !== null) {', prerequisite)
  assert.ok(read >= 0 && absentOnly > read && prerequisite > absentOnly && guard > prerequisite,
    'ENOENT must become a ledger check before any corrupt-file assertion is attempted')
  assert.match(phase, /product-accounts\.json was not created; account creation did not establish the prerequisite/)

  const guardedAssertions = phase.slice(guard)
  for (const claim of [
    'A CORRUPT ACCOUNT FILE RESOLVES TO SIGNED OUT, never to a signed-in user',
    'the application still opens a usable window rather than failing to start',
    'and the sign-in screen SAYS the account file could not be read',
    'rather than offering to create a first account over the one it could not read',
    'restoring the account file makes the account usable again, so the refusal was about the damage',
  ]) {
    assert.ok(guardedAssertions.includes(claim), `the existing corrupt-file assertion must remain guarded and intact: ${claim}`)
  }
  assert.doesNotMatch(phase.slice(0, guard), /A CORRUPT ACCOUNT FILE RESOLVES|writeFileSync\(accountsFile/,
    'no corruption may be attempted before the prerequisite is known to exist')
})

test('typeExactText replaces a prefilled value and returns only an exact boolean verdict', async () => {
  const secret = 'qa-secret-never-return-this'
  const calls = []
  let fieldValue = 'browser-prefilled-value'
  let selectedAll = false
  let inputListener = null
  const evaluateExpressions = []
  let readback = null
  const field = {
    get value() { return fieldValue },
    set value(value) { fieldValue = String(value) },
    addEventListener(type, listener, options) {
      assert.equal(type, 'input')
      assert.equal(options?.once, true)
      inputListener = listener
    },
  }
  const document = { querySelector: selector => selector === '#password' ? field : null }
  const runPageProgram = async expression => {
    evaluateExpressions.push(expression)
    const invoke = Function('document', 'crypto', 'TextEncoder', `return ${expression}`)
    return await invoke(document, webcrypto, TextEncoder)
  }

  const session = {
    async send(method, payload) {
      calls.push({ method, payload })
      if (method === 'Input.dispatchKeyEvent' && payload.type === 'rawKeyDown' && payload.key === 'a' && payload.modifiers === 2) {
        selectedAll = true
      } else if (method === 'Input.dispatchKeyEvent' && payload.type === 'rawKeyDown' && payload.key === 'Backspace') {
        if (selectedAll) fieldValue = ''
        selectedAll = false
      } else if (method === 'Input.insertText') {
        fieldValue += payload.text
        assert.equal(typeof inputListener, 'function', 'the boolean proof must be armed before plaintext is inserted')
        const listener = inputListener
        inputListener = null
        listener({ data: payload.text })
      }
    },
  }

  const result = await typeExactText({
    clickVisible: async selector => {
      assert.equal(selector, '#password')
      return 'clicked'
    },
    session,
    evaluate: async expression => (readback = await runPageProgram(expression)),
    pause: async () => {},
  }, '#password', secret)

  assert.equal(fieldValue, secret, 'the inserted text must replace, not append to, the prefilled value')
  assert.equal(result, 'typed')
  assert.deepEqual(calls.map(call => call.method), [
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
  ])
  assert.deepEqual(calls[0].payload, {
    type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  })
  assert.equal(calls[2].payload.key, 'Backspace')
  assert.equal(calls[4].payload.text, secret)
  assert.equal(evaluateExpressions.length, 2, 'one expression arms the event proof and one reads its boolean')
  assert.match(evaluateExpressions[0], /crypto\.subtle\.digest\('SHA-256',[\s\S]*event\.data/,
    'the input event must retain only a digest without receiving a second plaintext copy')
  assert.match(evaluateExpressions[1], /new TextEncoder\(\)\.encode\(field\.value\)/,
    'readback must digest the final field value so a later autofill change cannot reuse stale proof')
  for (const expression of evaluateExpressions) {
    assert.equal(expression.includes(secret), false,
      'the generated credential must appear only in Input.insertText, never in Runtime.evaluate source')
    assert.doesNotMatch(expression, /value:\s*field\.value/,
      'a generated credential must not come back in a mismatch diagnostic')
  }
  assert.deepEqual(readback, { found: true, matches: true })
  assert.equal(JSON.stringify({ result, readback }).includes(secret), false,
    'the helper result and readback must contain booleans/status only, never the credential')

  let changedValue = 'prefilled-again'
  let changedListener = null
  const changedField = {
    get value() { return changedValue },
    set value(value) { changedValue = String(value) },
    addEventListener(_type, listener) { changedListener = listener },
  }
  const changedDocument = { querySelector: () => changedField }
  const mismatch = await typeExactText({
    clickVisible: async () => 'clicked',
    session: {
      async send(method, payload) {
        if (method === 'Input.dispatchKeyEvent' && payload.type === 'rawKeyDown' && payload.key === 'Backspace') changedValue = ''
        if (method === 'Input.insertText') {
          changedValue += payload.text
          const listener = changedListener
          changedListener = null
          listener({ data: payload.text })
        }
      },
    },
    evaluate: async expression => {
      const invoke = Function('document', 'crypto', 'TextEncoder', `return ${expression}`)
      return await invoke(changedDocument, webcrypto, TextEncoder)
    },
    pause: async () => { changedValue = 'autofill-changed-it-after-the-input-event' },
  }, '#password', secret)
  assert.equal(mismatch, 'value-mismatch')
  assert.equal(mismatch.includes(secret), false, 'a mismatch must not echo the credential')
})

test('the synthetic purchase catalogue is selectable and every claimed tick is read back from row state', () => {
  const source = readTool('account-isolation-leak-qa.mjs')
  const start = source.indexOf('function syntheticCatalog()')
  const end = source.indexOf('/* Every stop on the ring', start)
  assert.ok(start >= 0 && end > start, 'the synthetic catalogue fixture is missing')
  const catalog = source.slice(start, end)

  assert.match(catalog, /priceVerified:\s*true/,
    'unverified catalogue rows are intentionally read-only and cannot exercise account-scoped selection')
  assert.match(catalog, /priceVerifiedDate:\s*'\d{4}-\d{2}-\d{2}'/)
  assert.match(catalog, /defaultSelected:\s*false/,
    'the test must create selection through the UI rather than seed the expected state')
  assert.match(catalog, /item\('qa-line-one'/)
  assert.match(catalog, /item\('qa-line-two'/)

  assert.match(source, /ticked === 'clicked' && ownerSelection\.selected\.includes\('qa-line-one'\)/,
    'the first selection claim must require both the click and row-state readback')
  assert.match(source, /testerPicked\.selected\.includes\('qa-line-two'\)/,
    'the second selection claim must be verified from data-selected state')
  assert.match(source, /ownerSelectionBack\.selected\.includes\('qa-line-one'\)/,
    'the reverse-direction isolation claim must re-read the original selection')
  assert.match(source, /requireCheckoutFixture\(ledger, ownerFixture, 'the first person'\)/,
    'the first click must be preceded by an exact fixture precondition')
  assert.match(source, /requireCheckoutFixture\(ledger, testerFixture, 'the second person'\)/,
    'the second click must be preceded by an exact fixture precondition')
  assert.match(source, /document\.body\.classList\.add\('reduce-motion'\)/,
    'the headless lane must use the synchronous route-swap path')
})
