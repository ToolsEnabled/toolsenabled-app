import assert from 'node:assert/strict'
import test from 'node:test'

import {
  distinctAccountCheckoutBindings,
  distinctAccountThemeBindings,
  hasTwoDistinctAccountIds,
  ownerIdentityPatterns,
  readPartitionFiles,
  readPrefs,
} from '../account-isolation-leak-qa.mjs'

const inaccessible = code => Object.assign(new Error(`injected ${code}`), { code })

test('only ENOENT becomes an absent answer; indeterminate reads are coded and never cached', () => {
  const readers = [
    ['preferences', read => readPrefs('/profile', read), 'QA_COULD_NOT_READ_PREFS'],
    ['owner identity', read => ownerIdentityPatterns(read), 'QA_COULD_NOT_READ_OWNER_IDENTITY'],
    ['account partition', read => readPartitionFiles('/accounts', read), 'QA_COULD_NOT_READ_ACCOUNT_PARTITION'],
  ]

  for (const [subject, invoke, expectedCode] of readers) {
    assert.equal(invoke(() => { throw inaccessible('ENOENT') }), null, `${subject}: ENOENT means absent`)

    let calls = 0
    const busy = () => {
      calls += 1
      throw inaccessible('EMFILE')
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => invoke(busy),
        error => error.code === expectedCode && /NOT claiming that it is absent/.test(error.message),
        `${subject}: EMFILE must be indeterminate`,
      )
    }
    assert.equal(calls, 2, `${subject}: an indeterminate result must not be cached`)
  }
})

test('different-account proof requires two present ids, not one id compared with absence', () => {
  const first = '11111111111111111111111111111111'
  const second = '22222222222222222222222222222222'

  assert.equal(hasTwoDistinctAccountIds(first, second), true)
  assert.equal(hasTwoDistinctAccountIds(first, first), false, 'one account compared with itself is not two accounts')
  assert.equal(hasTwoDistinctAccountIds(undefined, second), false, 'an absent first account must not pass by differing from the second')
  assert.equal(hasTwoDistinctAccountIds(first, undefined), false, 'an absent second account must not pass')
  assert.equal(hasTwoDistinctAccountIds('', second), false, 'an empty first id must not pass')
  assert.equal(hasTwoDistinctAccountIds(first, ''), false, 'an empty second id must not pass')
})

test('theme partition proof counts distinct canonical account bindings and never the device theme', () => {
  const first = '11111111111111111111111111111111'
  const second = '22222222222222222222222222222222'
  const firstKey = `acct:${first}:mc.theme`
  const secondKey = `acct:${second}:mc.theme`

  assert.deepEqual(distinctAccountThemeBindings([
    'mc.theme',
    firstKey,
    firstKey,
    secondKey,
    `acct:${first}:mc.set.uninstall_data`,
    'acct:short:mc.theme',
    `acct:${second}:mc.theme.extra`,
  ]), [firstKey, secondKey])

  assert.equal(
    distinctAccountThemeBindings(['mc.theme', firstKey]).length,
    1,
    'one account binding plus the device fallback must not be reported as two per-account bindings',
  )
  assert.deepEqual(distinctAccountThemeBindings(null), [], 'a missing key list must not invent bindings')
})

test('checkout partition proof counts distinct canonical account bindings and never the device selection', () => {
  const first = '11111111111111111111111111111111'
  const second = '22222222222222222222222222222222'
  const firstKey = `acct:${first}:mc.checkout.v1`
  const secondKey = `acct:${second}:mc.checkout.v1`

  assert.deepEqual(distinctAccountCheckoutBindings([
    'mc.checkout.v1',
    firstKey,
    firstKey,
    secondKey,
    `acct:${first}:mc.theme`,
    'acct:short:mc.checkout.v1',
    `acct:${second}:mc.checkout.v1.extra`,
  ]), [firstKey, secondKey])

  assert.equal(
    distinctAccountCheckoutBindings(['mc.checkout.v1', firstKey]).length,
    1,
    'one account binding plus the device fallback must not be reported as two per-account bindings',
  )
  assert.deepEqual(distinctAccountCheckoutBindings(null), [], 'a missing key list must not invent bindings')
})
