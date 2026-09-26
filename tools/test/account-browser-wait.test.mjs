import assert from 'node:assert/strict'
import test from 'node:test'
import { watchBrowserSignInAddress } from '../../src/account-browser-wait.js'
import { formMarkup, setupAccountStepMarkup, statusMarkup } from '../../src/account-markup.js'
import { accountStep } from '../../src/account-state.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve() }
function clock() {
  let time = 0
  let next = null
  return {
    now: () => time,
    schedule(fn, delay) { assert.equal(next, null); next = { fn, at: time + delay }; return next },
    unschedule(handle) { if (next === handle) next = null },
    async tick() { assert.ok(next); const task = next; next = null; time = task.at; await task.fn() },
    advance(value) { time += value },
    pending: () => next !== null,
  }
}

test('a passkey browser address arriving after a slow password request is still shown', async () => {
  const timer = clock(), addresses = []
  let reads = 0
  watchBrowserSignInAddress({ ...timer, bridge: { async googleUrl() {
    reads++
    return timer.now() >= 20000 ? { ok: true, url: 'https://toolsenabled.ai/v1/desktop/auth/flow' } : { ok: false }
  } }, onAddress: value => addresses.push(value) })
  await settle()
  for (let i = 0; i < 20; i++) await timer.tick()
  assert.equal(reads, 21)
  assert.deepEqual(addresses, ['https://toolsenabled.ai/v1/desktop/auth/flow'])
  assert.equal(timer.pending(), false)
})

test('stopping while an address read is pending discards its late reply', async () => {
  const timer = clock(), read = deferred(), addresses = []
  const stop = watchBrowserSignInAddress({ ...timer, bridge: { googleUrl: () => read.promise },
    onAddress: value => addresses.push(value) })
  stop()
  read.resolve({ ok: true, url: 'https://toolsenabled.ai/old-attempt' })
  await settle()
  assert.deepEqual(addresses, [])
  assert.equal(timer.pending(), false)
})

test('disposing a waiting view clears the next read without cancelling native authentication', async () => {
  const timer = clock()
  let reads = 0, cancels = 0
  const stop = watchBrowserSignInAddress({ ...timer,
    bridge: { async googleUrl() { reads++; return { ok: false } }, googleCancel() { cancels++ } },
    onAddress() { assert.fail('no address') } })
  await settle()
  assert.equal(timer.pending(), true)
  stop()
  assert.equal(timer.pending(), false)
  assert.equal(reads, 1)
  assert.equal(cancels, 0)
})

test('the address observer has a deadline even when the bridge keeps answering unavailable', async () => {
  const timer = clock()
  let reads = 0
  watchBrowserSignInAddress({ ...timer, timeoutMs: 3000,
    bridge: { async googleUrl() { reads++; throw Error('temporarily unavailable') } },
    onAddress() { assert.fail('no address') } })
  await settle()
  while (timer.pending()) await timer.tick()
  assert.equal(reads, 3)
  assert.equal(timer.now(), 3000)
})

test('an address returned after the observer deadline is discarded', async () => {
  const timer = clock(), read = deferred()
  watchBrowserSignInAddress({ ...timer, timeoutMs: 1000, bridge: { googleUrl: () => read.promise },
    onAddress() { assert.fail('expired address') } })
  timer.advance(1001)
  read.resolve({ ok: true, url: 'https://toolsenabled.ai/expired-attempt' })
  await settle()
  assert.equal(timer.pending(), false)
})

test('missing address capability and empty addresses never become a fallback address', async () => {
  const timer = clock(), values = [{ ok: true, url: '' }, { ok: true, url: 'x'.repeat(8193) }, { ok: true }]
  const missing = watchBrowserSignInAddress({ ...timer, bridge: {}, onAddress() { assert.fail() } })
  missing()
  assert.equal(timer.pending(), false)
  const stop = watchBrowserSignInAddress({ ...timer, bridge: { async googleUrl() { return values.shift() } },
    onAddress() { assert.fail('malformed address') } })
  await settle()
  await timer.tick()
  await timer.tick()
  stop()
  assert.equal(timer.pending(), false)
})

const state = { available: true, signedIn: false, accountCount: 1, canPersistSession: true }
for (const [surface, render] of [
  ['account', args => formMarkup({ state, ...args })],
  ['setup', args => setupAccountStepMarkup({ accountState: state, ...args })],
]) {
  test(`${surface}: passkey progress and cancel survive unknown or unavailable Google`, () => {
    for (const google of [null, { available: false }, { available: true }]) {
      const markup = render({ google, busy: true, browserSignIn: {
        provider: 'password', canCancel: true, address: 'https://toolsenabled.ai/flow?x=<script>&y="x"',
      } })
      assert.match(markup, /Finish signing in in your browser/)
      assert.match(markup, /<button[^>]*data-account-signin-cancel>Cancel sign-in<\/button>/)
      assert.equal((markup.match(/data-account-signin-cancel/g) || []).length, 1)
      assert.doesNotMatch(markup, /data-google-signin-cancel|Waiting for your browser/)
      assert.match(markup, /data-account-notice-address/)
      assert.match(markup, /&lt;script&gt;&amp;y=&quot;x&quot;/)
      assert.doesNotMatch(markup, /<script>/)
    }
  })
  test(`${surface}: a local account operation does not claim it is waiting for a browser`, () => {
    const markup = render({ google: { available: true }, busy: true })
    assert.doesNotMatch(markup, /data-account-browser-wait|data-account-signin-cancel|Waiting for your browser/)
    assert.match(markup, /data-google-signin-start disabled/)
  })
  test(`${surface}: Google browser sign-in has one cancel control with its actual capability`, () => {
    for (const canCancel of [true, false]) {
      const markup = render({ google: { available: true }, busy: true,
        browserSignIn: { provider: 'google', canCancel } })
      assert.equal((markup.match(/data-account-signin-cancel/g) || []).length, 1)
      const button = markup.match(/<button[^>]*data-account-signin-cancel[^>]*>/)[0]
      assert.equal(/disabled/.test(button), !canCancel)
      assert.match(markup, /Finish signing in in your browser/)
    }
  })
}

test('setup reads browser progress and cancellation capability independently of Google availability', async () => {
  let reads = 0
  const adapter = accountStep({ mcAccount: {
    async signIn() {}, async current() {}, async googleAvailability() { return { available: false } },
    async googleUrl(...args) { assert.deepEqual(args, []); reads++; return { ok: true, url: 'https://toolsenabled.ai/flow' } },
    async googleCancel() {},
  } })
  assert.equal(adapter.canCancelSignIn, true)
  assert.deepEqual(await adapter.googleUrl(), { ok: true, url: 'https://toolsenabled.ai/flow' })
  assert.equal(reads, 1)
  assert.equal(accountStep({}).canCancelSignIn, false)
  assert.deepEqual(await accountStep({}).googleUrl(), { ok: false })
})

test('a Linux protected-storage refusal is not described as a Windows fault', () => {
  const markup = statusMarkup({ state: { ...state, canPersistSession: false } })
  assert.match(markup, /operating system/)
  assert.doesNotMatch(markup, /Windows/)
})
