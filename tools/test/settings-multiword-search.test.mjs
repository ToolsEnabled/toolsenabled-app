import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsDraft } from '../../src/settings-draft.js'
import { createTranscriptSettings } from '../../src/transcript-settings.js'
import { createActionPermissionSettings } from '../../src/action-permission-settings.js'
import { createFleetProfileSettings } from '../../src/fleet-profile-settings.js'
import { createSetupProfileSettings } from '../../src/setup-profile-settings.js'
import { createChatboxSettings } from '../../src/chatbox-settings.js'
import { createUpdateSettings } from '../../src/update-settings.js'
import { createRoleColorSettings } from '../../src/role-color-settings.js'
import { createHandControlSettings } from '../../src/hand-control-settings.js'
import { createConnectComputerSettings } from '../../src/connect-computer-settings.js'

test('every legacy settings controller finds words in either order, ignores case/spacing, and requires every word without writing', () => {
  let writes = 0
  const storage = { getItem: () => null, setItem: () => { writes++ } }
  const draft = createSettingsDraft()
  const cases = [
    ['transcript archive', createTranscriptSettings({ draft }), 'archive quota'],
    ['agent permissions', createActionPermissionSettings({ draft, storage }), 'agent permission'],
    ['computer profile', createFleetProfileSettings(), 'machine account'],
    ['setup profile', createSetupProfileSettings(), 'folder editor'],
    ['home chatbox', createChatboxSettings(), 'context home'],
    ['updates', createUpdateSettings({ readPolicy: () => 'ask', writePolicy: () => { writes++ } }), 'download automatically'],
    ['role colors', createRoleColorSettings({ storage }), 'theme role'],
    ['hand controls', createHandControlSettings({ getControl: () => { throw new Error('Searching must not start camera controls') } }), 'pinch camera'],
    ['connect computer', createConnectComputerSettings({ resolveBridge: () => { throw new Error('Searching must not start pairing') } }), 'computer account'],
  ]
  for (const [name, controller, query] of cases) {
    assert.equal(controller.matches(query), true, name + ': ' + query)
    assert.equal(controller.matches(query.split(' ').reverse().join(' ')), true, name + ': reversed words')
    assert.equal(controller.matches('  ' + query.toUpperCase().replace(' ', '   ') + '  '), true, name + ': case and spacing')
    assert.equal(controller.matches(query + ' quartz-unrelated-phrase'), false, name + ': all words required')
    assert.equal(controller.matches('quartz-unrelated-phrase'), false, name + ': unrelated query')
    assert.equal(controller.matches('   '), true, name + ': empty query')
    controller.destroy()
  }
  assert.equal(writes, 0)
  assert.equal(draft.dirty, false)
})
