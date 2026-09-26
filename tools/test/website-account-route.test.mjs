import test from 'node:test'
import assert from 'node:assert/strict'
import { websiteAccountHref } from '../../src/website-account-route.js'

const website = () => ({
  location: { protocol: 'https:' },
  mcAccount: { current() {}, signIn() {}, machines() {}, machineInUse() {} },
})

test('the website account route uses the existing same-origin hosted Account page', () => {
  assert.equal(websiteAccountHref(website()), '/account/')
  const localSite = website()
  localSite.location.protocol = 'http:'
  assert.equal(websiteAccountHref(localSite), '/account/')
})

test('native account screens retain their own account controls even with extra bridge methods', () => {
  const native = website()
  native.mcShell = { getBridgeProof() {} }
  assert.equal(websiteAccountHref(native), null)
  native.location.protocol = 'file:'
  assert.equal(websiteAccountHref(native), null)
})

test('an absent or partial web bridge cannot redirect a standalone app preview', () => {
  assert.equal(websiteAccountHref({}), null)
  for (const method of ['current', 'signIn', 'machines', 'machineInUse']) {
    const preview = website()
    delete preview.mcAccount[method]
    assert.equal(websiteAccountHref(preview), null, method)
  }
})

test('opaque and non-web documents do not acquire a hosted account route', () => {
  for (const protocol of ['file:', 'data:', 'about:', 'javascript:', undefined]) {
    const context = website()
    context.location.protocol = protocol
    assert.equal(websiteAccountHref(context), null, String(protocol))
  }
})
