import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { parseAst } from 'rollup/parseAst'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import * as copy from '../../src/fleet-tree-copy.js'

// Execute the actual command factory, Page 2 callback, complete Actions
// handler and mounted composer. Only the native dialog/host and outer view
// presentation are controlled; this does not open Electron or start an agent.
const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
after(() => dom.restore())
const require = createRequire(import.meta.url)
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
const viewSource = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

function oneNode(ast, predicate, label) {
  const found = []
  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (predicate(value)) found.push(value)
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(ast)
  assert.equal(found.length, 1, `exactly one ${label} must be exercised`)
  return found[0]
}
const viewAst = parseAst(viewSource)
const mentionNode = oneNode(viewAst, node => node.type === 'Property' && node.key.name === 'onMention', 'Page 2 Mention callback')
const actionsNode = oneNode(viewAst, node => node.type === 'FunctionDeclaration' && node.id.name === 'runPaletteAction', 'Actions handler')
const mainAst = parseAst(mainSource)
const mainNames = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentSessionCommand', 'rendererSafeAgentError']
const mainHelpers = mainNames.map(name => {
  const node = oneNode(mainAst, node => node.type === 'FunctionDeclaration' && node.id.name === name, name)
  return mainSource.slice(node.start, node.end)
}).join('\n')
const maximumNode = oneNode(mainAst, node => node.type === 'VariableDeclarator' && node.id.name === 'MAX_SESSION_ID_LENGTH', 'session ID bound')
const helpers = new Function(`const MAX_SESSION_ID_LENGTH = ${mainSource.slice(maximumNode.init.start, maximumNode.init.end)};
  ${mainHelpers}
  return { ${mainNames.join(', ')} };
`)()

// Path values are data only. No file is created or read, and no inherited
// profile/temp setting chooses a fixture destination.
const ROOT = process.platform === 'win32'
  ? 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp\\chat-mention-refusal-fixture'
  : '/tmp/chat-mention-refusal-fixture'
const FILE = join(ROOT, 'Folder With Spaces', 'Example File.txt')
const IMAGE = join(ROOT, 'Existing image.png')
const DRAFT = '  Keep my draft exactly.  '
const CLOSED = 'This session is not open here. Use an open agent’s chat to mention a file. Your message here is unchanged.'
const FAILED = 'A file could not be mentioned. Your message is unchanged. Try Mention a file again.'
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture(t, { door = 'toolbar', state = 'ready', foreign = false, relay = false, dialogResult, dialogError, onMention } = {}) {
  const owner = {}
  const sessionId = 'mention-owned-session'
  const principal = { kind: relay ? 'relay' : 'window', owner, mayWrite: true, label: 'Mention fixture' }
  const session = { owner: foreign ? {} : owner, state, attachments: new Set([IMAGE]) }
  const sessions = new Map([[sessionId, session]])
  const calls = { dialog: [], errors: [], hostClose: [], end: [], render: [], send: [], picker: [] }
  const host = { closeSession: async request => {
    calls.hostClose.push(request)
    return { ok: true, closed: true, sessionId: request.sessionId }
  } }
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([name, kind]) => [name,
    kind === 'function' ? () => null : kind === 'number' ? 160 : kind === 'string' ? ROOT : {},
  ]))
  Object.assign(deps, helpers, {
    agentSessions: sessions, currentAgentHost: () => host,
    AGENT_EFFORT_VALUES: [], WORKSPACE_ROOT: ROOT,
    recordSessionEnd: (...args) => calls.end.push(args),
    dialog: { showOpenDialog: async options => {
      calls.dialog.push(options)
      if (dialogError) throw dialogError
      return dialogResult || { canceled: false, filePaths: [FILE] }
    } },
  })
  const surface = createAgentCommandSurface(deps)
  const pickMention = async request => {
    calls.picker.push(request)
    try { return await surface.run('agent:pick-mention', request, principal) }
    catch (error) {
      calls.errors.push(error.code)
      // Electron invoke reconstructs Error.message and drops custom .code.
      throw new Error(`Error invoking remote method 'mc-agent:pick-mention': Error: ${error.message}`)
    }
  }
  const node = { id: 'mention-node', sessionId, status: 'stopped' }
  const adapter = new Function('pickMention', 'node', 'mentionRefusalSentence', 'liveSessionId',
    `return (${viewSource.slice(mentionNode.value.start, mentionNode.value.end)})`)(pickMention, node, copy.mentionRefusalSentence, () => node.sessionId)
  const root = buildChat({ title: 'Mention fixture', seed: 0, onMention: onMention || adapter,
    onAttach: async () => ({ ok: true, path: IMAGE, size: 8 }),
    onSend: (...args) => { calls.send.push(args) },
  })
  dom.document.body.appendChild(root)
  t.after(() => { root.dispose(); root.remove() })
  const input = root.querySelector('.chat-input input')
  const out = { textContent: '' }
  const runActions = new Function('window', 'PALETTE_PANEL', 'mentionRefusalSentence', 'START_NEEDS_APP_TEXT', 'showTreeNodeControls', 'controlsPage',
    `const chatWorkspace = false;
     const closePersonNode = () => { throw new Error('Mention must not close the session') };
     return (${viewSource.slice(actionsNode.start, actionsNode.end)})`)(
    { mcAgent: { pickMention } }, copy.PALETTE_PANEL, copy.mentionRefusalSentence,
    () => 'Use the installed app.', current => calls.render.push(current),
    { querySelector: selector => {
      assert.equal(selector, '[data-rail-chat-host] .chat-input input')
      return input
    } },
  )
  return { root, input, out, calls, surface, sessions, session, sessionId, principal,
    async prepare() {
      root.querySelector('[data-chat-attach]').click(); await tick()
      input.value = DRAFT
      assert.equal(root.querySelectorAll('.chat-attachment-chip').length, 1)
    },
    async press() {
      if (door === 'actions') await runActions('mention', node, out)
      else { root.querySelector('[data-chat-mention]').click(); await tick() }
    },
    said() {
      return door === 'actions' ? out.textContent : root.querySelectorAll('.msg')
        .filter(row => row.classList.contains('note')).map(row => row.textContent).join('\n')
    },
  }
}

function kept(f) {
  assert.equal(f.input.value, DRAFT)
  assert.deepEqual(f.root.exportDraft().attachments, [{ ok: true, path: IMAGE, size: 8 }])
  assert.equal(f.root.querySelectorAll('.chat-attachment-chip').length, 1)
  assert.deepEqual([...f.session.attachments], [IMAGE], 'Mention must not grant attachment rights')
  assert.deepEqual(f.calls.send, [], 'Mention must not send or resume an agent')
}

for (const door of ['toolbar', 'actions']) {
  test(`${door}: real full close then Mention shows a refusal and retains draft/attachments`, async t => {
    const f = fixture(t, { door }); await f.prepare()
    const result = await f.surface.run('agent:close', { sessionId: f.sessionId }, f.principal)
    assert.equal(result.closed, true)
    assert.equal(f.sessions.has(f.sessionId), false)
    await f.press()
    kept(f)
    assert.deepEqual(f.calls.errors, ['MC_AGENT_UNKNOWN_SESSION'])
    assert.equal(f.calls.dialog.length, 0)
    assert.equal(f.calls.hostClose.length, 1)
    assert.equal(f.calls.render.length, 0)
    assert.ok(f.said().includes(CLOSED), 'a rejected session must be visibly explained, not swallowed or called Cancel')
  })

  for (const [label, options, code, sentence] of [
    ['ended binding', { state: 'ended' }, 'MC_AGENT_SESSION_ENDED', CLOSED],
    ['foreign binding', { foreign: true }, 'MC_AGENT_UNKNOWN_SESSION', CLOSED],
    // The outer admission gate does not put its code in Error.message.
    // A message-only wrapper must still show a safe generic refusal.
    ['relay principal with a message-only refusal', { relay: true }, 'MC_AGENT_DIALOG_REQUIRES_WINDOW', FAILED],
  ]) test(`${door}: ${label} is refused before opening the picker and is visible`, async t => {
    const f = fixture(t, { door, ...options }); await f.prepare(); await f.press()
    kept(f)
    assert.deepEqual(f.calls.errors, [code])
    assert.equal(f.calls.dialog.length, 0)
    assert.equal(f.calls.render.length, 0)
    assert.ok(f.said().includes(sentence))
    assert.ok(!f.said().includes(code))
    assert.ok(!f.said().includes(copy.PALETTE_PANEL.mentionCancelled))
  })

  test(`${door}: native dialog rejection is visible without exposing its text`, async t => {
    const f = fixture(t, { door, dialogError: new Error('Cannot read private/untrusted-picker-file <script>') })
    await f.prepare(); await f.press(); kept(f)
    assert.equal(f.calls.dialog.length, 1)
    assert.ok(f.said().includes(FAILED))
    assert.doesNotMatch(f.said(), /private|untrusted|<script>|AGENT_SESSION_FAILED/)
    assert.equal(f.calls.render.length, 0)
  })

  test(`${door}: actual Cancel retains draft/attachments and is never shown as failure`, async t => {
    const f = fixture(t, { door, dialogResult: { canceled: true, filePaths: [] } })
    await f.prepare(); await f.press(); kept(f)
    assert.equal(f.calls.dialog.length, 1)
    assert.deepEqual(f.calls.errors, [])
    assert.equal(f.said(), door === 'actions' ? copy.PALETTE_PANEL.mentionCancelled : '')
    assert.equal(f.calls.render.length, 0)
  })

  test(`${door}: a retained ready binding may mention despite a stopped node label`, async t => {
    const f = fixture(t, { door }); await f.prepare(); await f.press()
    assert.equal(f.calls.dialog.length, 1)
    assert.equal(f.calls.dialog[0].title, 'Mention a file in this message')
    assert.deepEqual(f.calls.dialog[0].properties, ['openFile'])
    assert.equal(f.input.value, `${DRAFT} ${FILE}`)
    assert.deepEqual(f.root.exportDraft().attachments, [{ ok: true, path: IMAGE, size: 8 }])
    assert.deepEqual([...f.session.attachments], [IMAGE])
    assert.deepEqual(f.calls.errors, [])
    assert.deepEqual(f.calls.send, [])
    assert.equal(f.said(), door === 'actions' ? copy.PALETTE_PANEL.mentionWritten : '')
  })
}

test('toolbar: empty draft selection uses the existing mention sentence', async t => {
  const f = fixture(t); await f.press()
  assert.equal(f.input.value, `Read ${FILE} and use it for what I ask next.`)
})

test('toolbar: a rejected callback is visible even without the Page 2 adapter', async t => {
  const f = fixture(t, { onMention: async () => { throw new Error('Do not display this private error') } })
  await f.prepare(); await f.press(); kept(f)
  assert.ok(f.said().includes(FAILED))
  assert.doesNotMatch(f.said(), /private error/)
})

test('toolbar: a synchronous picker refusal is also visible and retains the draft', async t => {
  const f = fixture(t, { onMention: () => { throw new Error('Do not display this private error') } })
  await f.prepare(); await f.press(); kept(f)
  assert.ok(f.said().includes(FAILED))
})

test('toolbar: an absent picker response is not mistaken for Cancel', async t => {
  const f = fixture(t, { onMention: async () => null })
  await f.prepare(); await f.press(); kept(f)
  assert.ok(f.said().includes(FAILED))
})

test('toolbar: an explicit refusal with a path never inserts or attaches it', async t => {
  const f = fixture(t, { onMention: async () => ({ ok: false, path: FILE, sentence: FAILED }) })
  await f.prepare(); await f.press(); kept(f)
  assert.ok(f.said().includes(FAILED))
})

test('toolbar: disposing while the picker is pending prevents late notes and draft changes', async t => {
  let reject
  const f = fixture(t, { onMention: () => new Promise((resolve, no) => { reject = no }) })
  await f.prepare()
  f.root.querySelector('[data-chat-mention]').click()
  f.root.dispose()
  reject(new Error('Late refusal'))
  await tick()
  assert.equal(f.input.value, DRAFT)
  assert.equal(f.said(), '')
})

test('Mention copy classifies exact Electron refusal tokens and never displays error text', () => {
  for (const code of ['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED']) {
    for (const error of [{ code }, new Error(code), new Error(`Error invoking remote method 'mc-agent:pick-mention': Error: ${code}`)]) {
      assert.equal(copy.mentionRefusalSentence(error), CLOSED)
    }
    for (const error of [new Error(`PREFIX_${code}`), new Error(`${code}_EXTRA`), { code: 'OTHER', message: code }]) {
      assert.equal(copy.mentionRefusalSentence(error), FAILED)
    }
  }
  assert.equal(copy.mentionRefusalSentence(new Error('MC_AGENT_DIALOG_REQUIRES_WINDOW')), copy.PALETTE_PANEL.whyNoPicker)
  for (const error of [null, undefined, {}, { code: 7 }, new Error('private/path <script>')]) {
    assert.equal(copy.mentionRefusalSentence(error), FAILED)
  }
})
