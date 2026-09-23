import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import { setBridgeTransport } from '../../src/mission-bridge.js'
import { fleetFetch, installWorld, settle } from './lib/tree-command-real-mount.mjs'

register('./css-loader.mjs', import.meta.url)

test('late belongings from the previous sign-in cannot paint under the next account', async (t) => {
  const world = await installWorld(fleetFetch())
  const originalAccount = Object.getOwnPropertyDescriptor(globalThis, 'mcAccount')
  let view
  let releaseOldData
  let signedIn = 'first'
  const bridge = {
    availability: async () => ({ ok: true, accountCount: 2 }),
    current: async () => signedIn ? { signedIn: true, account: {
      id: (signedIn === 'first' ? 'a' : 'b').repeat(32), username: `${signedIn}-account`, displayName: `${signedIn}-account`,
    } } : { signedIn: false },
    signOut: async () => { signedIn = null; return { ok: true } },
    signIn: async () => { signedIn = 'second'; return { ok: true } },
    googleAvailability: async () => ({ ok: false }),
    data: async () => signedIn === 'first'
      ? new Promise(resolve => { releaseOldData = () => resolve({ ok: true, settingCount: 888 }) })
      : { ok: true, settingCount: 2 },
    paymentPresence: async () => ({ ok: true, attached: false }),
  }
  Object.defineProperty(globalThis, 'mcAccount', { configurable: true, writable: true, value: bridge })
  setBridgeTransport(async () => ({ ok: false, reason: 'No purchase service in this fixture.' }))
  t.after(() => {
    releaseOldData?.()
    view?.destroy()
    setBridgeTransport(null)
    if (originalAccount) Object.defineProperty(globalThis, 'mcAccount', originalAccount)
    else delete globalThis.mcAccount
    world.restore()
  })
  const { accountView } = await import('../../src/views/account.js')
  view = accountView({ navigate() {} })
  document.body.append(view.el)
  await settle(5)
  assert.equal(typeof releaseOldData, 'function', 'the old account must have a real read outstanding')
  const section = view.el.querySelector('[data-account-section]')
  section.dispatchEvent({ type: 'click', target: section.querySelector('[data-account-sign-out]'), preventDefault() {} })
  await settle(5)
  const form = section.querySelector('[data-account-form="sign-in"]')
  assert.ok(form, 'signing out must show the real sign-in form')
  form.querySelector('[name="username"]').value = 'second-account'
  form.querySelector('[name="password"]').value = 'fixture-only-password'
  section.dispatchEvent({ type: 'submit', target: form, preventDefault() {} })
  await settle(5)
  assert.match(section.textContent, /second-account/)
  assert.match(section.textContent, /2 recorded against this account/)

  releaseOldData()
  await settle(5)
  assert.match(section.textContent, /second-account/, 'the second account must remain the active identity')
  assert.doesNotMatch(section.textContent, /888 recorded against this account/,
    'the previous account belongings were displayed as belonging to the newly signed-in person')
  assert.match(section.textContent, /2 recorded against this account/)
})
