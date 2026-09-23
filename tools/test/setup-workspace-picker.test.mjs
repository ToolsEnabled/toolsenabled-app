import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseAst } from 'rollup/parseAst'

// Execute the actual IPC registration without booting Electron. Only the OS
// dialog, known-folder lookup, and existing sender/workspace boundaries are
// injected; the production async ordering and error propagation stay intact.
const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const registrations = parseAst(source).body.filter(node =>
  node.type === 'ExpressionStatement'
  && node.expression.type === 'CallExpression'
  && node.expression.callee.object?.name === 'ipcMain'
  && node.expression.callee.property?.name === 'handle'
  && node.expression.arguments[0]?.value === 'mc-setup:choose-workspace')
assert.equal(registrations.length, 1)
const registration = source.slice(registrations[0].start, registrations[0].end)

function picker({ documents = '/known/Documents', pathError, dialogError,
  choice = { canceled: false, filePaths: ['/selected/folder'] },
  verdict = { ok: true, resolved: '/selected/folder' }, checkError } = {}) {
  let invoke
  const calls = []
  const owner = {}
  const window = {}
  runInNewContext(registration, {
    ipcMain: { handle(channel, handler) { assert.equal(channel, 'mc-setup:choose-workspace'); invoke = handler } },
    withFleetProfileSender(event, action) {
      if (event !== owner) throw new Error('SENDER_REFUSED')
      return action()
    },
    win: window,
    app: { getPath(name) {
      calls.push({ kind: 'known-folder', name })
      if (pathError) throw pathError
      return documents
    } },
    dialog: { async showOpenDialog(parent, options) {
      assert.equal(parent, window)
      calls.push({ kind: 'dialog', options: JSON.parse(JSON.stringify(options)) })
      if (dialogError) throw dialogError
      return choice
    } },
    checkWorkspace(selected) {
      calls.push({ kind: 'validate', selected })
      if (checkError) throw checkError
      return verdict
    },
  })
  return { calls, invoke: (event = owner) => invoke(event) }
}

test('a missing Documents hint still opens the native picker and validates the actual selection', async () => {
  const probe = picker({ pathError: new Error("Failed to get 'documents' path") })
  const result = await probe.invoke()
  assert.equal(result.ok, true)
  assert.equal(result.path, '/selected/folder')
  const dialog = probe.calls.find(call => call.kind === 'dialog')
  assert.equal(Object.hasOwn(dialog.options, 'defaultPath'), false)
  assert.deepEqual(dialog.options.properties, ['openDirectory', 'createDirectory'])
  assert.deepEqual(probe.calls.at(-1), { kind: 'validate', selected: '/selected/folder' })
})

test('a resolved Documents location remains the exact optional dialog hint', async () => {
  const probe = picker({ documents: '/redirected/Documents' })
  await probe.invoke()
  assert.equal(probe.calls.find(call => call.kind === 'dialog').options.defaultPath, '/redirected/Documents')
  assert.deepEqual(probe.calls[0], { kind: 'known-folder', name: 'documents' })
})

test('cancel after an unavailable hint performs no workspace validation or write', async () => {
  const probe = picker({ pathError: new Error('known folder unavailable'), choice: { canceled: true, filePaths: [] } })
  const result = await probe.invoke()
  assert.equal(result.ok, true)
  assert.equal(result.canceled, true)
  assert.deepEqual(probe.calls.map(call => call.kind), ['known-folder', 'dialog'])
})

test('a refused selected folder retains the original refusal', async () => {
  const verdict = { ok: false, code: 'WORKSPACE_REFUSED', reason: 'Selected folder is not allowed' }
  const probe = picker({ verdict })
  const result = await probe.invoke()
  assert.equal(result.ok, false)
  assert.equal(result.code, verdict.code)
  assert.equal(result.reason, verdict.reason)
  assert.equal(result.canceled, false)
})

test('an actual native dialog error is not swallowed with the optional hint', async () => {
  const error = new Error('Native dialog failed')
  const probe = picker({ dialogError: error })
  await assert.rejects(probe.invoke(), caught => caught === error)
  assert.equal(probe.calls.some(call => call.kind === 'validate'), false)
})

test('an actual selected-folder validation error is still propagated', async () => {
  const error = new Error('Workspace validation failed')
  await assert.rejects(picker({ checkError: error }).invoke(), caught => caught === error)
})

test('the sender boundary runs before known-folder lookup or opening a dialog', () => {
  const probe = picker()
  assert.throws(() => probe.invoke({}), /SENDER_REFUSED/)
  assert.deepEqual(probe.calls, [])
})
