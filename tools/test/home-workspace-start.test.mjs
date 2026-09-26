import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const world = installDomStandIn()
after(() => world.restore())
const { buildChat } = await import('../../src/components.js')
const { mountHomeChatLayout } = await import('../../src/home-chat-layout.js')
const { isWriteEnabled } = await import('../../src/write-flags.js')
const { startControlOffReason } = await import('../../src/setup-profile.js')
const { START_PANEL, CHAT_NOT_RUNNING, PALETTE_PANEL } = await import('../../src/fleet-tree-copy.js')
const { LAUNCH_TIERS } = await import('../../src/orchestration-controls.js')
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const functions = ['disposeWorkspaceChat', 'paintWorkspaceChat', 'paintWorkspaceStatus', 'setWorkspaceStatus',
  'workspaceStartReason', 'composeStartUnavailableReason', 'mountWorkspaceChat', 'treeChatConfigFor']
const runtime = functions.map(name => declaredFunctionSource(source, name)).join('\n')

// T1352: the real workspace mount and Commands layout share the real start()
// handler. Only the downstream launch, unrelated controls and stores are inert.
// This is a DOM stand-in boundary proof, not Home picker/provider/native proof.
function fixture(t, { enabled = true } = {}) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const saved = new Map([['mc.write.agent-session', enabled ? 'enabled' : 'disabled']])
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)) }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  const effects = { starts: [], sends: [], bridgeStarts: [] }
  const previousBridge = window.mcAgent
  window.mcAgent = {
    start: async payload => { effects.bridgeStarts.push(payload); return { ok: false } },
    send: async payload => { effects.sends.push(payload); return { ok: false } },
  }
  const draft = Object.freeze({ id: 'draft-under-test', treeId: 'tree-under-test', status: 'draft',
    sessionId: null, role: 'worker', message: 'Keep this exact saved task identity', tier: 'fixture-tier' })
  const decoy = Object.freeze({ ...draft, id: 'other-draft', message: 'Never start this other draft' })
  const nodes = new Map([[draft.id, draft], [decoy.id, decoy]])
  const launchResult = Object.freeze({ ok: false, message: 'Inert launch boundary reached; no session was started.' })
  const env = vm.createContext({
    document, window, setTimeout, clearTimeout,
    destroyed: false, workspaceChats: new Set(), workspacePendingStatus: new Map(), chatSurfaces: new Map(),
    treeStore: { getNode: id => nodes.get(id) }, transcriptStore: null, nodeReplies: new Map(),
    buildChat, START_PANEL, CHAT_NOT_RUNNING, PALETTE_PANEL, LAUNCH_TIERS,
    START_CONTROL_FLAG: 'agent-session', isWriteEnabled, startControlOffReason,
    START_NEEDS_APP_TEXT: () => { throw new Error('Unexpected missing bridge') },
    nodeStartReason: () => '', composeUnavailableReason: () => '', mockSource: () => false,
    treeChatHeaderMetaFor: () => null, treeNodeName: node => node.id,
    restoreDiffHistory: (_id, history) => history.slice(),
    sessionModelOverride: new Map(), sessionModelChoices: () => [], pendingModelChoice: () => null,
    accountRetryChipState: () => null, registerNodeStatusListener: () => () => {},
    chatActionRowsFor: () => [], commonChatActionsFor: () => [],
    mountTranscriptHistory: () => {},
    async startDraftNode(node) { effects.starts.push(node); return launchResult },
  })
  vm.runInContext(runtime, env)
  const shell = document.createElement('section')
  shell.innerHTML = '<div class="home-chat-pane-tabs"></div><button data-chat-commands>Commands</button>'
    + '<button data-chat-new>New</button><button data-chat-arrange>Arrange</button><select data-chat-layout></select>'
  const host = document.createElement('div'); shell.appendChild(host); document.body.appendChild(shell)
  let controller, layout
  t.after(async () => {
    layout?.destroy(); controller?.dispose(); shell.remove()
    await Promise.resolve()
    window.mcAgent = previousBridge
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
  })
  const subject = { id: 'selected-draft', kind: 'agent', treeNode: true, computerId: 'fixture-computer',
    agentId: draft.id, label: 'Saved draft' }
  layout = mountHomeChatLayout(host, { surface: shell, choices: [subject], subjectId: subject.id, live: true,
    renderAgent(body, selected) {
      controller = env.mountWorkspaceChat(body, { nodeId: selected.agentId })
      return () => controller.dispose()
    },
  })
  assert.ok(controller?.root, 'actual Computers workspace is mounted')
  const startSpy = t.mock.method(controller, 'start') // call through; neither handler nor result is replaced
  layout.attachController(layout.activeHost, controller)
  function commandsStart() {
    shell.querySelector('[data-chat-commands]').click()
    assert.equal(shell.querySelector('.home-chat-command-overlay').hidden, false)
    const row = [...shell.querySelectorAll('.home-chat-command-row')]
      .find(row => row.querySelector('.home-chat-command-label')?.textContent === 'Start this agent')
    assert.ok(row, 'Commands offers the existing controller Start action')
    return row
  }
  return { shell, controller, startSpy, draft, effects, launchResult, commandsStart,
    windowStart: () => shell.querySelector('[data-workspace-start]') }
}

for (const entry of ['window', 'Commands']) {
  test(`${entry} Start calls the existing workspace controller once with the selected draft identity`, async t => {
    const f = fixture(t)
    assert.equal(f.controller.canStart(), true)
    assert.equal(f.controller.startUnavailableReason(), '')
    const button = entry === 'window' ? f.windowStart() : f.commandsStart()
    assert.ok(button, 'Start control is mounted')
    assert.equal(button.disabled, false)
    assert.equal(f.effects.starts.length, 0, 'mounting does not start anything')
    button.click()
    assert.equal(f.startSpy.mock.callCount(), 1, 'one click calls the actual controller exactly once')
    const call = f.startSpy.mock.calls[0]
    assert.equal(call.this, f.controller, 'the selected controller receives the call')
    assert.equal(await call.result, f.launchResult)
    assert.equal(f.effects.starts.length, 1)
    assert.equal(f.effects.starts[0], f.draft, 'the exact store object crosses the inert launch boundary')
    assert.equal(f.effects.starts[0].id, 'draft-under-test')
    assert.equal(f.effects.starts[0].message, 'Keep this exact saved task identity')
    assert.deepEqual(f.effects.bridgeStarts, [])
    assert.deepEqual(f.effects.sends, [])
    assert.equal(f.controller.status.textContent, f.launchResult.message, 'downstream refusal stays visible')
    assert.equal(f.controller.status.dataset.state, 'refuse')
    if (entry === 'window') {
      assert.equal(button.disabled, true, 'the accepted click immediately disables the window control')
      button.click()
      assert.equal(f.startSpy.mock.callCount(), 1, 'a disabled repeated click cannot launch again')
    }
  })
}

test('Start switched off shows the authoritative sentence in both controls and refuses the real handler', async t => {
  const f = fixture(t, { enabled: false })
  const reason = startControlOffReason()
  assert.ok(reason.length > 0)
  assert.equal(f.controller.canStart(), false)
  assert.equal(f.controller.startUnavailableReason(), reason)
  const button = f.windowStart(), command = f.commandsStart()
  assert.ok(button)
  assert.equal(button.disabled, true)
  assert.equal(button.parentNode.querySelector('p').textContent, reason)
  assert.equal(command.disabled, true)
  assert.equal(command.querySelector('.home-chat-command-reason').textContent, reason)
  assert.equal(command.title, reason)
  button.click(); command.click()
  assert.equal(f.startSpy.mock.callCount(), 0, 'disabled controls do not call the controller')
  const refused = await f.controller.start() // stale/programmatic delivery still rechecks authority
  assert.equal(refused.ok, false)
  assert.equal(refused.message, reason)
  assert.equal(f.controller.status.textContent, reason)
  assert.equal(f.controller.status.dataset.state, 'refuse')
  assert.equal(f.controller.status.hidden, false)
  assert.deepEqual(f.effects, { starts: [], sends: [], bridgeStarts: [] })
})
