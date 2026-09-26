import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardNativeInput, assertNativeSelection, readNativeWindowState } from '../lib/page2-native-input.cjs'

test('native readiness is checked before chained locator and keyboard input without affecting read assertions', async () => {
  const actions = []
  const locator = { getByRole() { return this }, nth() { return this }, click() { actions.push('click') }, innerText() { return 'observed text' } }
  const page = guardNativeInput({ locator: () => locator, keyboard: { press: key => actions.push(key) } }, async () => actions.push('ready'))
  assert.equal(await page.locator('button').innerText(), 'observed text')
  assert.deepEqual(actions, [])
  await page.locator('section').getByRole('button').nth(0).click()
  await page.keyboard.press('Enter')
  assert.deepEqual(actions, ['ready', 'click', 'ready', 'Enter'])
})

test('an unhandled native modal prevents the intended input from being dispatched', async () => {
  let clicked = false
  const page = guardNativeInput({ locator: () => ({ click() { clicked = true } }) }, async () => { throw new Error('Native modal still blocks this window') })
  await assert.rejects(page.locator('button').click(), /Native modal/)
  assert.equal(clicked, false)
})

const selected = (value, trusted = true) => ['input', 'change'].map(type => ({ type, value, trusted }))

test('a one-shot native select needs the intended trusted change before it resets', () => {
  assertNativeSelection({ requested: 'child', before: '', after: '', resetsAfterSelection: true, events: selected('child') })
  assert.throws(() => assertNativeSelection({ requested: 'child', before: '', after: '', resetsAfterSelection: true, events: selected('parent') }), /requested visible choice/)
  assert.throws(() => assertNativeSelection({ requested: 'child', before: '', after: '', resetsAfterSelection: true, events: [] }), /requested visible choice/)
})

test('native selection rejects intermediate changes and dispatched fixture events', () => {
  const receipt = { requested: 'max', before: 'low', after: 'max', resetsAfterSelection: false }
  assert.throws(() => assertNativeSelection({ ...receipt, events: [...selected('medium'), ...selected('max')] }), /intermediate/)
  assert.throws(() => assertNativeSelection({ ...receipt, events: selected('max', false) }), /requested visible choice/)
  assertNativeSelection({ ...receipt, events: selected('max') })
})

test('selecting the same retained native value may emit no change, but a wrong final value cannot pass', () => {
  assertNativeSelection({ requested: 'max', before: 'max', after: 'max', resetsAfterSelection: false, events: [] })
  assert.throws(() => assertNativeSelection({ requested: 'max', before: 'max', after: 'low', resetsAfterSelection: false, events: selected('max') }), /retain its requested value/)
})

const collected = () => new Error('electronApplication.evaluate: Resulting promise was garbage collected.')

test('a collected readiness read is recorded and repeated before exactly one native input', async () => {
  let reads = 0
  let inputs = 0
  const receipts = []
  const page = guardNativeInput({ locator: () => ({ click() { inputs++ } }) }, async () => {
    assert.equal(await readNativeWindowState(() => { if (++reads === 1) throw collected(); return true }, row => receipts.push(row)), true)
  })
  await page.locator('button').click()
  assert.equal(reads, 2)
  assert.equal(inputs, 1)
  assert.deepEqual(receipts, [{ kind: 'native-read-retry', operation: 'window-readiness', attempt: 1, limit: 3, reason: collected().message }])
})

test('repeated collected reads stop after three attempts without sending input', async () => {
  let reads = 0
  let inputs = 0
  const receipts = []
  const page = guardNativeInput({ locator: () => ({ click() { inputs++ } }) }, () => readNativeWindowState(() => { reads++; throw collected() }, row => receipts.push(row)))
  await assert.rejects(page.locator('button').click(), /Resulting promise was garbage collected/)
  assert.equal(reads, 3)
  assert.equal(inputs, 0)
  assert.deepEqual(receipts.map(row => row.attempt), [1, 2])
})

test('a disabled native window remains a refusal after a successful repeated read', async () => {
  let reads = 0
  let inputs = 0
  const page = guardNativeInput({ locator: () => ({ click() { inputs++ } }) }, async () => {
    assert.equal(await readNativeWindowState(() => { if (++reads === 1) throw collected(); return false }, () => {}), true, 'Native window remains disabled')
  })
  await assert.rejects(page.locator('button').click(), /Native window remains disabled/)
  assert.equal(reads, 2)
  assert.equal(inputs, 0)
})

test('other inspector failures and an ordinary false readiness are never retried', async () => {
  let reads = 0
  const original = new Error('Execution context was destroyed')
  await assert.rejects(readNativeWindowState(() => { reads++; throw original }, () => assert.fail('must not retry')), error => error === original)
  assert.equal(reads, 1)
  assert.equal(await readNativeWindowState(() => false, () => assert.fail('must not retry')), false)
})
