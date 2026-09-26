import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  machineRecordEnvironmentFor,
  machineRecordProductDirectory,
  resolveMachineServicesRoot,
  servicesRootForProfile,
  userDataFor,
} from '../test-account-harness.mjs'

test('machineRecordProductDirectory tracks whatever userDataFor actually resolves to, not a literal', () => {
  const profile = path.resolve('scratch', 'some-profile')

  // openWindow() launches with --user-data-dir=userDataFor(profile), and
  // resolveProductDirectory() (capability/src/lib/durable-memory-file.js)
  // derives the LOCALAPPDATA subdirectory name from the basename of whatever
  // userData Electron actually resolved to under that switch. Seeding a
  // machine record anywhere else is invisible to a window opened this way --
  // this pins seedMachineRecord()'s directory choice to the same source
  // openWindow() launches with, so the two cannot drift apart again.
  assert.equal(
    machineRecordProductDirectory(profile),
    path.basename(userDataFor(profile)),
    'the seeded directory name must be derived from userDataFor(), not a hardcoded literal'
  )

  // Concrete pin on today's known value, so a change to userDataFor()'s own
  // folder name shows up here as an intentional review point, not a silent drift.
  assert.equal(userDataFor(profile), path.join(profile, 'userdata'))
  assert.equal(machineRecordProductDirectory(profile), 'userdata')
})

test('the machine-record environment carries the same selected userData identity as the packaged launch', () => {
  const profile = path.resolve('scratch', 'ordinary-product')
  assert.deepEqual(machineRecordEnvironmentFor(profile), {
    LOCALAPPDATA: path.join(profile, 'local'),
    TOOLSENABLED_STATE_ROOT: path.join(userDataFor(profile), 'capability'),
  })
  assert.equal(servicesRootForProfile(profile), path.join(profile, 'local', 'userdata'))
})

test('a renamed selected userData survives different parent roots and the payload resolver remains authoritative', () => {
  const root = path.resolve('scratch', 'identity-oracle')
  const profile = path.join(root, 'profile')
  const selectedUserData = path.join(root, 'selected-machine', 'Renamed Preview')
  const localAppData = path.join(root, 'owner-machine', 'local')
  let observed = null
  const payload = {
    resolveServicesRoot({ env }) {
      observed = { ...env }
      return path.join(env.LOCALAPPDATA, path.basename(path.dirname(env.TOOLSENABLED_STATE_ROOT)))
    },
  }

  const actual = resolveMachineServicesRoot(profile, payload, { selectedUserData, localAppData })
  assert.equal(actual, path.join(localAppData, 'Renamed Preview'))
  assert.deepEqual(observed, {
    LOCALAPPDATA: localAppData,
    TOOLSENABLED_STATE_ROOT: path.join(selectedUserData, 'capability'),
  })
})

test('a payload/launch identity disagreement fails instead of falling back to ToolsEnabled', () => {
  const root = path.resolve('scratch', 'identity-refusal')
  const profile = path.join(root, 'profile')
  const selectedUserData = path.join(root, 'selected', 'Renamed Preview')
  const localAppData = path.join(root, 'local')
  assert.throws(
    () => resolveMachineServicesRoot(profile, {
      resolveServicesRoot: () => path.join(localAppData, 'ToolsEnabled'),
    }, { selectedUserData, localAppData }),
    /payload resolved .*ToolsEnabled.*launch selects .*Renamed Preview/i,
  )
})
