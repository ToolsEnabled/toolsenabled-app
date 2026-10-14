// THE FOLDER MENU MUST SHOW WHAT IS PERSISTED, NOT THE DEFAULT.
//
// Removing a folder in Settings removes the profile and leaves every tree that
// used it pointing at it: profileRemove() in src/views/computers.js re-mounts
// the panel and nothing anywhere sets a tree's profileId back to null. The
// pointer outlives the folder, by design -- parseFleetTrees is deliberately
// forgiving about a dangling id.
//
// What the menu did with it was the defect. It marked an option selected only
// where `profile.id === current`; a dangling pointer matched nothing, nothing
// was marked, and the first option stood -- "the product's own workspace". So
// the menu showed the default over a record that said otherwise, and a start
// did not use what the menu showed either: startProfileId() passes the dangling
// id on and the main process refuses it by name. Three answers, one question.
//
// Reproduced at 6909208e by W-root/B13-repro-folder-dangling.mjs:
//
//   persisted treeProfile after reload = profile-research
//   option the menu marks selected     = NONE
//   SHOWN TO THE PERSON : the product's own workspace
//   ACTUALLY PERSISTED  : profile-research      AGREE? NO
//
// WHY THE RULE IS A FUNCTION. The view is an Electron-mounted closure and this
// suite has no DOM that models option selectedness -- there is no jsdom,
// linkedom or happy-dom here and tools/test/lib/dom-stand-in.mjs gives Element a
// plain `value` with no select/option relationship. Left inline the rule could
// only be pinned as text; made a value it can be proven. The last two tests are
// still source-pinned, because the wiring is the part that lives in the view.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Namespace import on purpose: at the base the export does not exist, and a
   named import would fail to link and take the whole file down with it. This
   way the absence is reported by the tests that are about it. */
import * as fleetTrees from '../../src/fleet-trees.js'
import { PROFILE_PANEL } from '../../src/fleet-tree-copy.js'

const here = fileURLToPath(import.meta.url)
const SRC = join(dirname(dirname(dirname(here))), 'src')
const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')

test('the menu rule exists as something that can be proven', () => {
  assert.equal(typeof fleetTrees.treeFolderMenuChoice, 'function',
    'treeFolderMenuChoice is missing, so the rule is still buried in the view')
})

test('a folder this computer still has is selected, and is not reported missing', () => {
  const choice = fleetTrees.treeFolderMenuChoice({
    current: 'profile-research',
    folders: [{ id: 'profile-notes', name: 'Notes' }, { id: 'profile-research', name: 'Research' }],
  })
  assert.equal(choice.selectedId, 'profile-research')
  assert.equal(choice.missing, false)
})

test('a folder this computer no longer has is still selected, and IS reported missing', () => {
  /* The heart of it. The pointer is kept -- the person chose it and nothing
     here may quietly rewrite that -- and the gap is reported instead. */
  const choice = fleetTrees.treeFolderMenuChoice({
    current: 'profile-research',
    folders: [{ id: 'profile-notes', name: 'Notes' }],
  })
  assert.equal(choice.selectedId, 'profile-research', 'the saved choice must not be silently dropped')
  assert.equal(choice.missing, true, 'a folder that is gone must be reported, not shown as the default')
})

test('a tree that names no folder is not reported missing', () => {
  for (const current of [null, undefined, '', '   ']) {
    const choice = fleetTrees.treeFolderMenuChoice({ current, folders: [] })
    assert.equal(choice.selectedId, null, `${JSON.stringify(current)} should select nothing`)
    assert.equal(choice.missing, false, `${JSON.stringify(current)} is not a missing folder, it is no folder`)
  }
})

test('an unreadable folder list is not mistaken for a folder that exists', () => {
  /* mcAgent.profiles() can answer with nothing at all. That must read as "this
     computer offers none", never as "the saved one is fine". */
  for (const folders of [undefined, null, 'not a list', [null], [{}]]) {
    const choice = fleetTrees.treeFolderMenuChoice({ current: 'profile-research', folders })
    assert.equal(choice.missing, true, `${JSON.stringify(folders)} must not satisfy the saved pointer`)
  }
})

test('the copy names the gap without showing an id', () => {
  assert.equal(typeof PROFILE_PANEL.missingFolderOption, 'string')
  assert.equal(typeof PROFILE_PANEL.missingFolder, 'string')
  for (const [name, words] of [['missingFolderOption', PROFILE_PANEL.missingFolderOption], ['missingFolder', PROFILE_PANEL.missingFolder]]) {
    assert.ok(words.length > 0, `${name} is empty`)
    assert.equal(/profile-[a-z]/.test(words), false, `${name} shows a profile id, which means nothing to a person`)
  }
  assert.match(PROFILE_PANEL.missingFolder, /refused|pick another/i,
    'the line must say what it means for a start, not merely that something is missing')
})

test('the view asks the rule, and marks the gap instead of leaving the default standing', () => {
  const at = view.indexOf("bridgeForProfiles.profiles().then")
  assert.notEqual(at, -1, 'the folder menu no longer reads the profile list where this test expects')
  const body = view.slice(at, at + 2400)
  assert.ok(body.includes('treeFolderMenuChoice({ current, folders: answer.profiles })'),
    'the menu must ask the rule about the list it just drew')
  assert.ok(body.includes('PROFILE_PANEL.missingFolderOption'), 'the gap needs a row of its own')
  assert.ok(body.includes('PROFILE_PANEL.missingFolder'), 'the gap needs its sentence')
})

test('the missing row is appended AFTER the real folders, so it cannot be outranked', () => {
  const at = view.indexOf("bridgeForProfiles.profiles().then")
  const body = view.slice(at, at + 2400)
  const loop = body.indexOf('for (const profile of answer.profiles)')
  const gap = body.indexOf('menuChoice.missing')
  assert.ok(loop > -1 && gap > -1, 'both the folder loop and the gap branch must exist')
  assert.ok(gap > loop,
    'a selected row appended before the real options can be overridden by a later selected one')
})
