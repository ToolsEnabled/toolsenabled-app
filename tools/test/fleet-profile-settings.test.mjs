import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FLEET_PROFILE_SETTING_COUNT,
  createFleetProfileSettings,
} from '../../src/fleet-profile-settings.js'
import { resolveDataSource } from '../../src/data-source.js'
import { setBridgeTransport } from '../../src/mission-bridge.js'

function boundRoot() {
  const listeners = new Map()
  const section = {
    outerHTML: '',
    querySelector(selector) {
      return selector === '.settings-prefix' ? null : null
    },
  }
  return {
    section,
    listeners,
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    contains() { return true },
    querySelector(selector) {
      return selector === '[data-profile-system]' ? section : null
    },
    querySelectorAll() { return [] },
  }
}

test('exports the complete System settings surface with honest browser limitations', () => {
  assert.equal(
    FLEET_PROFILE_SETTING_COUNT,
    6,
    'the exported setting count must continue to describe all six profile controls',
  )

  const html = createFleetProfileSettings().markup()
  assert.match(
    html,
    /Machine roster[\s\S]*Add a machine only if you want to connect another/,
    'the roster must tell single-computer users that adding another machine is optional',
  )
  assert.match(
    html,
    /<button[^>]*data-profile-action="choose-directory"[^>]*disabled[^>]*>Choose folder<\/button>/,
    'a browser must render folder selection as disabled rather than implying it can read a local folder',
  )
  assert.match(
    html,
    /Reachability not checked yet[\s\S]*separate from saved configuration/,
    'an unchecked connection must be described as unknown, not as reachable',
  )
})

test('a browser copy says the data folder is chosen in the desktop app, an installed copy says to update', () => {
  // T1527: a browser read 'This installed copy cannot choose a local data folder. Update the app, then try again.'
  const browser = createFleetProfileSettings().markup()
  assert.match(browser, /Choose a local data folder in the ToolsEnabled desktop app\./)
  assert.doesNotMatch(browser, /This installed copy cannot choose a local data folder/)
  const oldWindow = globalThis.window
  globalThis.window = { mcShell: { getBridgeProof() {} } }
  try {
    const installed = createFleetProfileSettings().markup()
    assert.match(installed, /This installed copy cannot choose a local data folder\. Update the app, then try again\./,
      'an installed copy without the chooser keeps the update sentence')
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  }
})

test('names the account sign-in computer for both desk and relay readers', async () => {
  const desk = createFleetProfileSettings().markup()
  assert.match(
    desk,
    /A name for whoever is at this computer\. Your account lives on this computer and nowhere else\./,
    'a local reader must keep the established desk wording byte for byte',
  )

  setBridgeTransport(async () => ({ ok: true }))
  try {
    assert.equal(await resolveDataSource({ reask: true }), 'relay')
    const relay = createFleetProfileSettings().markup()
    assert.match(
      relay,
      /A name for whoever is at the computer you are driving\. Your account lives on the computer you are driving and nowhere else\./,
      'a relay reader must be told that the local sign-in belongs to the driven computer',
    )
    assert.doesNotMatch(
      relay,
      /A name for whoever is at this computer\. Your account lives on this computer and nowhere else\./,
      'the desk-only twin must not leak into the relay rendering',
    )
  } finally {
    setBridgeTransport(null)
    await resolveDataSource({ reask: true })
  }
})

test('matches the vocabulary real settings searches use', () => {
  const settings = createFleetProfileSettings()
  assert.equal(settings.matches('login'), true, 'login searches must find the System account guidance')
  assert.equal(settings.matches('projection directory'), true, 'data-folder searches must find System settings')
  assert.equal(settings.matches('wallpaper typography'), false, 'unrelated searches must not claim the System section')
})

test('a desktop import read failure remains an explicit unknown and keeps the draft', async () => {
  const previousBridge = globalThis.mcFleetProfile
  globalThis.mcFleetProfile = {
    importFile: async () => ({ ok: false, error: { message: 'fixture could not be read' } }),
  }
  try {
    const settings = createFleetProfileSettings()
    const before = settings.markup()
    const root = boundRoot()
    settings.bind(root)

    await root.listeners.get('click')({
      target: {
        closest: selector => selector === '[data-profile-action]'
          ? { dataset: { profileAction: 'load' } }
          : null,
      },
    })

    assert.match(
      root.section.outerHTML,
      /Profile was not loaded[\s\S]*fixture could not be read/,
      'a could-not-read result must report that loading failed instead of resolving it as a profile answer',
    )
    assert.match(
      root.section.outerHTML,
      /data-profile-field="label" value="([^\"]*)"/,
      'the failed import must leave a renderable existing draft in place',
    )
    const previousLabel = before.match(/data-profile-field="label" value="([^\"]*)"/)?.[1]
    const currentLabel = root.section.outerHTML.match(/data-profile-field="label" value="([^\"]*)"/)?.[1]
    assert.equal(currentLabel, previousLabel, 'the failed import must not replace the existing draft')

    settings.destroy()
    assert.equal(root.listeners.size, 0, 'destroy must remove every DOM listener installed by bind')
  } finally {
    if (previousBridge === undefined) delete globalThis.mcFleetProfile
    else globalThis.mcFleetProfile = previousBridge
  }
})
test('editing a fleet field joins the Settings draft instead of persisting immediately', () => {
  const staged = []
  const controller = createFleetProfileSettings({ stageWrite: (...args) => staged.push(args) })
  const root = boundRoot()
  controller.bind(root)
  const input = { dataset: { profileField: 'label' }, value: 'Draft fleet' }
  root.listeners.get('input')({ target: { closest: () => input } })
  assert.equal(staged.length, 1)
  assert.equal(staged[0][0], 'fleet:profile')
  assert.equal(staged[0][1].label, 'Draft fleet')
  assert.match(controller.markup(), /data-profile-action="save" hidden/)
  controller.destroy()
})

test('a one-computer install is told before and at once that saving a Profile name needs a machine', () => {
  // T1427: typing a Profile name on an empty roster staged normally and Save then
  // failed with the raw 'machines must contain at least one machine'.
  const staged = [], errors = []
  const controller = createFleetProfileSettings({ stageWrite: (...args) => staged.push(args), setStageError: (key, message) => errors.push({ key, message }) })
  assert.match(controller.markup(), /Profile name[\s\S]*Saving it needs at least one machine in the Machine roster below\./, 'the row does not say so before editing')
  const root = boundRoot()
  controller.bind(root)
  const input = { dataset: { profileField: 'label' }, value: 'Rig check' }
  root.listeners.get('input')({ target: { closest: () => input } })
  assert.equal(errors.length, 1, 'Save is not held for a draft that cannot be saved')
  assert.equal(errors[0].key, 'fleet:profile')
  assert.match(errors[0].message, /Add a machine to the Machine roster first/)
  assert.doesNotMatch(errors[0].message, /must contain at least one machine/, 'the raw validator text reaches the person')
  controller.destroy()
})
