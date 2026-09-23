/* THE DECLARED ORGANISATION'S OWN ROLES MUST NOT DEGRADE TO "Default"/"Agent".
 *
 * Measured by Builder 4, re-measured against this commit by Controller 3: the
 * organisation's declared Role library (ENGINE_ROLES in
 * src/orchestration-controls.js) has nine roles with their own colours and
 * names in ROLE_COLOR_NAMES/ROLE_COLOR_DEFAULTS (src/role-colors.js), but
 * src/vocab.js's ROLES carried only six legacy keys. Every direct consumer of
 * ROLES -- rimRole(), two sites in src/views/computers.js, three in
 * src/phone-ledger.js, the subtitle in src/tree-graph.js, and roleLabel() in
 * src/fleet-tree-copy.js -- degraded any of the other roles to a generic
 * caption and an uncoloured ring, because ROLES had no entry for them.
 * roleAppearance() was never affected: it already fell through to
 * ROLE_COLOR_NAMES for an unlisted key.
 *
 * This file imports the organisation's own role list from its source
 * (src/orchestration-controls.js's ENGINE_ROLES) rather than a copy planted
 * here, so a role added to or removed from the declared organisation changes
 * what this test checks without anyone having to remember to update a second
 * list.
 *
 * Run: node --test tools/test/vocab-role-badges.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const vocab = await import('../../src/vocab.js')
const { ROLE_COLOR_NAMES } = await import('../../src/role-colors.js')
const { ENGINE_ROLES } = await import('../../src/orchestration-controls.js')

test('the organisation\'s own role list is not empty, or this suite would pass by checking nothing', () => {
  assert.ok(Array.isArray(ENGINE_ROLES) && ENGINE_ROLES.length > 0,
    'ENGINE_ROLES is empty or not an array; every assertion below would vacuously pass')
})

test('every declared org role has a ROLES entry, a stable rim class, and its declared name', () => {
  for (const id of ENGINE_ROLES) {
    assert.ok(Object.hasOwn(vocab.ROLES, id),
      `ROLES has no entry for the declared org role "${id}", so any direct ROLES[id] lookup degrades it`)
    assert.equal(vocab.rimRole(id), id,
      `rimRole("${id}") did not return the role itself -- a canvas node for this role would still lose its own ring colour`)
    assert.equal(vocab.roleAppearance(id).label, ROLE_COLOR_NAMES[id],
      `roleAppearance("${id}").label does not match the name the Role library declares for it`)
  }
})

test('the six legacy role labels are kept exactly, not the different wording ROLE_COLOR_NAMES spells two of them with', () => {
  /* This is the one place the fix could silently regress: building ROLES by
     spreading ROLE_COLOR_NAMES's own labels first and applying the legacy six
     afterward only keeps the legacy wording if the override genuinely runs
     last. helper/shadow are the two ROLE_COLOR_NAMES spells differently
     ("Coordinator's helper" / "Shadow manager (legacy)"), so they are the
     pair that would silently change if the override were dropped or
     reordered; coordinator/manager would not, because both spellings agree. */
  assert.equal(vocab.ROLES.helper.label, "Coordinator's Helper")
  assert.equal(vocab.ROLES.shadow.label, 'Shadow Manager')
  assert.notEqual(vocab.ROLES.helper.label, ROLE_COLOR_NAMES.helper,
    'ROLES.helper now uses ROLE_COLOR_NAMES\' wording instead of its own long-standing label')
  assert.notEqual(vocab.ROLES.shadow.label, ROLE_COLOR_NAMES.shadow,
    'ROLES.shadow now uses ROLE_COLOR_NAMES\' wording instead of its own long-standing label')
})

test('a worker node\'s caption path yields "Worker", not "Default"', () => {
  /* Mirrors the exact expression src/views/computers.js uses at its two
     direct ROLES[...] lookups (showTreeNodeControls, showProjectionControls):
     `ROLES[node.role] || ROLES.default`, then `.label` is what a person reads.
     Before this fix, ROLES had no "worker" entry, so this expression fell to
     ROLES.default and captioned every spawned worker "Default". */
  const captioned = (vocab.ROLES.worker || vocab.ROLES.default).label
  assert.equal(captioned, 'Worker')
})
