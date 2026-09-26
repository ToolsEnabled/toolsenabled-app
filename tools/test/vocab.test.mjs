/* THE SMALL VOCABULARY THAT THE SIMULATED FLEET PUTS ON SCREEN.
 *
 * These are behavioural checks against the shapes consumed by components.js,
 * agent-roster.js, fleet-tree-copy.js, and metrics-charts.js.  Copy is checked
 * for the meaning/slot its caller needs, not for exact wording or markup.
 *
 * Run: node --test tools/test/vocab.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/* Import-time profile resolution is part of this module's observable result.
   Make the read fail, as a browser privacy setting or damaged storage layer
   can, before importing it.  The failure must remain distinguishable from an
   ordinary first run even though vocab still supplies the safe sample. */
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem() { throw new Error('test storage is unreadable') },
  },
})

const vocab = await import('../../src/vocab.js')
const { FLEET, FLEET_PROFILE_RESOLUTION } = await import('../../src/fleet-profile.js')
const { roleColorCss, roleColorHex, applyRoleColors } = await import('../../src/role-colors.js')

test.after(() => {
  delete globalThis.localStorage
})

test('an unreadable profile remains a reported failure while vocab exposes the safe fallback', () => {
  assert.equal(FLEET_PROFILE_RESOLUTION.kind, 'invalid',
    'an unreadable profile was collapsed into an ordinary unconfigured first run')
  assert.match(FLEET_PROFILE_RESOLUTION.errors[0]?.message || '', /could not be read/i,
    'the profile failure no longer says that storage could not be read')
  assert.strictEqual(vocab.CHAT, FLEET.chat,
    'CHAT did not expose the profile resolver\'s safe fallback after a read failure')
  assert.ok(vocab.CHAT.length > 0,
    'the safe fallback left a user with no simulated chat after a read failure')
})

test('profile-owned chat and account pools are exported without stale copies', () => {
  assert.strictEqual(vocab.CHAT_REPLIES, FLEET.chatReplies,
    'CHAT_REPLIES is not the active fleet profile collection')
  assert.strictEqual(vocab.CHAT_CONTEXT_REPLIES, FLEET.chatContextReplies,
    'CHAT_CONTEXT_REPLIES is not the active fleet profile collection')
  assert.strictEqual(vocab.POOLS, FLEET.pools,
    'POOLS is not the active fleet profile collection')
})

test('chat records and reply templates carry the semantic slots their callers render', () => {
  for (const [index, line] of vocab.CHAT.entries()) {
    assert.ok(line?.from === 'me' || line?.from === 'them',
      `CHAT entry ${index} has no renderable speaker`)
    assert.ok(typeof line.text === 'string' && line.text.trim(),
      `CHAT entry ${index} has no user-visible sentence`)
  }
  for (const [kind, replies] of Object.entries(vocab.CHAT_CONTEXT_REPLIES)) {
    assert.ok(replies.length > 0, `${kind} has no contextual replies`)
    assert.ok(replies.every(reply => typeof reply === 'string' && reply.includes('{{context}}')),
      `${kind} replies do not all preserve the caller's context slot`)
  }
})

test('role fallbacks and colours retain the contracts used by roster and graph callers', () => {
  for (const key of ['coordinator', 'helper', 'shadow', 'manager', 'default', 'spawned']) {
    const role = vocab.ROLES[key]
    assert.ok(role && typeof role.label === 'string' && role.label.trim(),
      `ROLES.${key} has no user-facing label`)
    assert.equal(role.color, roleColorCss(key),
      `ROLES.${key} no longer points at its CSS role token`)
    assert.match(role.hex, /^#[0-9a-f]{6}$/i,
      `ROLES.${key}.hex is not usable by SVG and chart callers`)
  }
})

test('existing role vocabulary follows saved colors and theme changes without recreation', () => {
  const role = vocab.ROLES.manager
  const initial = role.hex
  const properties = new Map()
  const documentRef = { documentElement: { dataset: { theme: 'black' }, style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) } } }
  const storage = { getItem: () => JSON.stringify({ version: 1, colors: { manager: '#ffffff' } }) }
  try {
    assert.equal(applyRoleColors({ documentRef, storage }).ok, true)
    assert.equal(role.hex, '#ffffff')
    assert.notEqual(role.hex, initial)
    assert.equal(role.hex, properties.get('--role-accent-manager'))
    documentRef.documentElement.dataset.theme = 'white'
    applyRoleColors({ documentRef, storage })
    assert.notEqual(role.hex, '#ffffff', 'a white chosen swatch must retain visible ink on White')
    assert.equal(role.hex, roleColorHex('manager'))
    assert.equal(role.hex, properties.get('--role-accent-manager'))
    assert.equal(role.color, roleColorCss('manager'))
  } finally {
    applyRoleColors({ documentRef, storage: { getItem: () => null } })
  }
})

test('provider chart vocabulary has unique join keys and renderable labels and colours', () => {
  assert.equal(new Set(vocab.PROVIDERS.map(provider => provider.id)).size, vocab.PROVIDERS.length,
    'PROVIDERS contains duplicate chart join keys')
  for (const [index, provider] of vocab.PROVIDERS.entries()) {
    assert.ok(typeof provider.label === 'string' && provider.label.trim(),
      `PROVIDERS entry ${index} has no chart label`)
    assert.match(provider.color, /^#[0-9a-f]{6}$/i,
      `PROVIDERS entry ${index} has no chart-safe colour`)
  }
})

test('pick uses the caller-supplied random draw without changing its input', () => {
  const choices = Object.freeze(['first', 'middle', 'last'])
  assert.equal(vocab.pick(choices, () => 0), 'first',
    'pick did not select the first item for the lowest draw')
  assert.equal(vocab.pick(choices, () => 0.5), 'middle',
    'pick did not map an interior draw to its array bucket')
  assert.equal(vocab.pick(choices, () => 0.999999), 'last',
    'pick did not select the last item for a draw just below one')
  assert.deepEqual(choices, ['first', 'middle', 'last'],
    'pick changed the caller\'s choices')
})
