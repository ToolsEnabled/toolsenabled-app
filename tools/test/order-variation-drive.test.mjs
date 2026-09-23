import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.ORDER_VARIATION_DRIVE_TEST = '1'
const { decodeFiledGroups } = await import('../order-variation-drive.mjs')

test('filed groups distinguish absence from a value that could not be decoded without latching failure', () => {
  assert.deepEqual(decodeFiledGroups(''), { code: 'ABSENT', groups: [] },
    'control: a genuinely absent stored value remains the legitimately empty list')

  const unreadable = decodeFiledGroups('{')
  assert.equal(unreadable.code, 'COULD_NOT_DECODE_OPEN_GROUPS')
  assert.equal(unreadable.groups, null)
  assert.match(unreadable.detail, /not claiming that no groups were filed/i)

  assert.deepEqual(decodeFiledGroups('["access","agents"]'), {
    code: 'OK',
    groups: ['access', 'agents'],
  }, 'a later valid read succeeds, proving the could-not-tell result was not cached or latched')
})
