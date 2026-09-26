/* c4 review, P5 (1.0.48 candidate 4). HIGH, pre-existing: any account-scoped
 * settings write -- a tree's Boxes/Circles, the card size, the theme, the Tools
 * page -- broke every open New agent tab. Its next message was refused
 * IMAGE_OWNER_CHANGED ("this copy could not work out why").
 *
 * mc-account:setting-put ran through withAccountMutation, which begins an
 * image-owner mutation: the owner context is nulled, "invalidated" is published
 * to every window (which also drops every image draft and ended-session
 * recovery authority), and the next read mints a NEW epoch for the same person.
 * A New agent tab captures the owner object at start and compares it by
 * identity before each send (src/agent-session.js continueSession), so the
 * re-read owner no longer matched.
 *
 * The fence itself is a security boundary and stays whole. What it protects,
 * and why each case below is on its side of the line, is written out in the P5
 * commit and in the round-2 note. Each case drives main.cjs's OWN account
 * channels (withAccountMutation and the ipcMain.handle bodies, taken from the
 * source by AST, as account-mutation-finalization-review does) over the REAL
 * owner context (shell/image-owner-context.cjs) and the REAL page client
 * (src/image-owner-client.js) through an IPC stand-in that delivers notices
 * after the read answers, as Electron does.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r-settings-write-keeps-image-owner.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rollup/parseAst'

const require = createRequire(import.meta.url)
const { createImageOwnerContext } = require('../../shell/image-owner-context.cjs')
const { createImageOwnerClient } = await import('../../src/image-owner-client.js')
const source = readFileSync(fileURLToPath(new URL('../../shell/main.cjs', import.meta.url)), 'utf8')
const ast = parseAst(source)
const fn = name => {
  const node = ast.body.find(item => item.type === 'FunctionDeclaration' && item.id?.name === name)
  return node ? source.slice(node.start, node.end) : null
}
const channel = name => {
  const node = ast.body.find(item => item.type === 'ExpressionStatement' && item.expression.type === 'CallExpression'
    && item.expression.callee.type === 'MemberExpression' && item.expression.callee.object.name === 'ipcMain'
    && item.expression.callee.property.name === 'handle' && item.expression.arguments[0]?.value === name)
  assert.ok(node, 'main.cjs registers ' + name)
  return source.slice(node.start, node.end)
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate) }

const SIGNED_OUT = Object.freeze({ principal: 'unauthenticated', signedIn: false })
const signedIn = (name, session = 'session-' + name) => ({ principal: 'account:' + name, signedIn: true, session: { id: session, issuedAtMs: 1 } })

function harness({ initial = signedIn('a'), signOutGate = null } = {}) {
  let state = initial
  const notices = [], pages = new Set(), writes = []
  const gate = createImageOwnerContext({ scope: 'c4r-owned-installation', readState: () => state,
    publish: value => { notices.push(value); for (const page of pages) setImmediate(() => page(value)) } })
  const deps = {
    trustedFleetProfileSender: () => true,
    accountResetStarted: false,
    getImageOwnerContext: () => gate,
    mirrorUninstallRetention: () => ({ ok: true }),
    accountMutations: new Set(),
    accountPrincipal: () => state.principal,
    auditedAccountAction: ({ run }) => run(),
    getAccountStore: () => ({
      // The store's own settings write: the signed-in account's settings partition, nothing else.
      putSetting: request => { writes.push(request); return Object.freeze({ ok: true, key: request.key, removed: request.value === null }) },
      current: () => state,
    }),
    getHostedAccountController: () => ({
      signOut: async () => { if (signOutGate) await signOutGate; state = SIGNED_OUT; return { ok: true } },
      signIn: async ({ username }) => { state = signedIn(username, 'session-' + username); return { ok: true } },
    }),
  }
  const handlers = new Map()
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler) }
  const body = ['withAccountMutation', 'withFleetProfileSender', 'fleetFailure', 'accountResetRefusal'].map(fn).join('\n')
    + '\n' + ['mc-account:setting-put', 'mc-account:sign-out', 'mc-account:sign-in'].map(channel).join('\n')
  new Function('deps', 'ipcMain', `
    const { trustedFleetProfileSender, accountResetStarted, getImageOwnerContext, mirrorUninstallRetention,
      accountMutations, accountPrincipal, auditedAccountAction, getAccountStore, getHostedAccountController } = deps;
    ${body}
  `)(deps, ipcMain)
  const bridge = {
    ownerContext: async () => gate.read(),
    onOwnerContextChanged: listener => { pages.add(listener); return () => pages.delete(listener) },
  }
  const client = createImageOwnerClient({ bridge })
  const call = (name, value) => handlers.get(name)({ sender: {} }, value)
  return { gate, client, notices, writes, call, setState: next => { state = next } }
}

test('P5: a same-account settings write keeps the owner a New agent tab captured', async () => {
  const h = harness()
  await h.client.start()
  const captured = h.client.capture()
  const context = h.gate.read()
  const answer = await h.call('mc-account:setting-put', { key: 'mc.tree.style', value: 'boxes' })
  await settle()
  assert.equal(answer.ok, true, 'the setting was written')
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.notices, [], 'THE DEFECT: a settings write announced an owner change to every window')
  assert.equal(h.gate.authenticate(context).authenticated, true, 'THE DEFECT: the same person\'s owner context was refused after a settings write')
  assert.equal(h.client.isCurrent(captured), true, 'THE DEFECT: the tab\'s captured owner is no longer current, so its next send is refused')
  h.client.dispose()
})

test('P5: a sign-out still ends the owner context', async () => {
  const h = harness()
  await h.client.start()
  const captured = h.client.capture(), context = h.gate.read()
  await h.call('mc-account:sign-out')
  await settle()
  assert.throws(() => h.gate.authenticate(context), { code: 'IMAGE_OWNER_CHANGED' })
  assert.equal(h.gate.read().kind, 'local')
  assert.equal(h.client.isCurrent(captured), false)
  assert.equal(h.notices.some(notice => notice.invalidated === true), true, 'every window is told before the change')
  h.client.dispose()
})

test('P5: switching to another account still ends the owner context', async () => {
  const h = harness()
  await h.client.start()
  const captured = h.client.capture(), context = h.gate.read()
  await h.call('mc-account:sign-in', { username: 'b', password: 'x' })
  await settle()
  assert.throws(() => h.gate.authenticate(context), { code: 'IMAGE_OWNER_CHANGED' })
  assert.notEqual(h.gate.read().ownerId, context.ownerId, 'another account is another owner')
  assert.equal(h.client.isCurrent(captured), false)
  h.client.dispose()
})

test('P5: signing out and back in to the same account still ends the old context (ABA)', async () => {
  const h = harness()
  const context = h.gate.read()
  await h.call('mc-account:sign-out')
  await h.call('mc-account:sign-in', { username: 'a', password: 'x' })
  assert.equal(h.gate.read().ownerId, context.ownerId, 'the same person again')
  assert.throws(() => h.gate.authenticate(context), { code: 'IMAGE_OWNER_CHANGED' }, 'but not the same custody: the gap is fenced')
})

test('P5: a settings write during a sign-out neither ends nor shortens the sign-out\'s fence', async () => {
  let release
  const h = harness({ signOutGate: new Promise(resolve => { release = resolve }) })
  const context = h.gate.read()
  const signingOut = h.call('mc-account:sign-out')
  assert.throws(() => h.gate.read(), { code: 'IMAGE_OWNER_CHANGED' }, 'owner reads are refused while the sign-out runs')
  await h.call('mc-account:setting-put', { key: 'mc.theme', value: 'dark' })
  assert.throws(() => h.gate.read(), { code: 'IMAGE_OWNER_CHANGED' }, 'the settings write did not finish the sign-out\'s mutation')
  release()
  await signingOut
  assert.throws(() => h.gate.authenticate(context), { code: 'IMAGE_OWNER_CHANGED' })
  assert.equal(h.gate.read().kind, 'local')
})

test('P5: removing this computer\'s data ends the owner context for the rest of the run, signed in or not', async () => {
  const seal = fn('sealImageOwnerForReset')
  assert.ok(seal, 'main.cjs names the erase-time owner seal')
  for (const initial of [signedIn('a'), SIGNED_OUT]) {
    const notices = []
    const gate = createImageOwnerContext({ scope: 'c4r-owned-installation', readState: () => initial, publish: value => notices.push(value) })
    const context = gate.read()
    const run = new Function('getImageOwnerContext', `let imageOwnerSealedForReset = null\n${seal}\nreturn sealImageOwnerForReset`)(() => gate)
    run()
    run()
    assert.throws(() => gate.authenticate(context), { code: 'IMAGE_OWNER_CHANGED' }, `a ${initial.signedIn ? 'signed-in' : 'local'} owner context survived the erase`)
    assert.throws(() => gate.read(), { code: 'IMAGE_OWNER_CHANGED' }, 'no new owner is minted until ToolsEnabled restarts')
    assert.equal(notices.filter(notice => notice.invalidated === true).length, 1, 'windows are told once')
  }
  // The erase seals the owner before its first await, beside the other terminal flags.
  const erase = channel('mc-reset:erase')
  const sealAt = erase.indexOf('sealImageOwnerForReset()')
  assert.ok(sealAt > 0, 'mc-reset:erase seals the owner context')
  assert.ok(sealAt < erase.indexOf('await '), 'before anything can yield')
  assert.ok(sealAt > erase.indexOf('stopAccountAdmissionForReset()'), 'after account admission stops')
})
