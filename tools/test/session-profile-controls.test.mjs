/* THE FOLDER PANEL'S CONTROLS, AND THE VERB A BROWSER DOES NOT HAVE.
 *
 * `window.mcAgent` is published by TWO hosts and they do not carry the same
 * verbs. shell/fleet-profile-preload.cjs is the installed application's, over
 * IPC. The website's binding is the other, over the relay tunnel, and three
 * commands are absent from it BY DESIGN because each one opens a native dialog
 * on the machine and there is nobody in front of that screen:
 * shell/agent-facade.cjs names them in REMOTE_OMITTED and gives them no route.
 *
 * MEASURED, 2026-08-25, on the current tree. Two of the three -- pickAttachment
 * and pickMention -- are asked for by name before their control acts. The
 * third, profileCreate, was not: mountProfilePanel gated the WHOLE panel on
 * `profiles`, which the relay host does have, and then rendered an enabled
 * "Pick a folder…". Pressing it evaluated `bridge.profileCreate({ name })` on
 * an undefined verb, which throws while the call expression is being evaluated
 * -- so the `.catch()` written on that same line never attaches and never runs.
 * The handler's promise rejected, the panel's output line was never written,
 * and the button did nothing at all, forever, with nothing red anywhere.
 *
 * The two facts this file pins are therefore:
 *   1. the decision is made from the verbs the bridge really has, and
 *   2. no remote-omitted verb is reached from a control this window rendered
 *      without asking for it.
 *
 * Both are DERIVED at run time from the shipped shell files rather than
 * listed here, so a fourth dialog command added tomorrow is covered on the day
 * it is added, by name.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rollup/parseAst'

import { profileControls, profileRemoveOutcome, removeProfile, PROFILE_CONTROL_VERBS } from '../../src/session-profile-controls.js'
import { PROFILE_PANEL } from '../../src/fleet-tree-copy.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = rel => readFileSync(join(ROOT, ...rel.split('/')), 'utf8')

/* This codebase documents its boundaries in prose and its prose is full of
   `word:` and `verb()`. Comments come out before anything is parsed out of a
   shell file, exactly as tools/test/preload-namespace-parity.test.mjs does. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** The commands the facade refuses to route, read from the facade itself. */
function remoteOmittedCommands() {
  const code = withoutComments(read('shell/agent-facade.cjs'))
  const block = /const REMOTE_OMITTED\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(code)
  assert.ok(block, 'REMOTE_OMITTED is not where this test looks -- fix the test, not the shell')
  const names = [...block[1].matchAll(/'([a-z:-]+)'/g)].map(m => m[1])
  assert.ok(names.length > 0, 'REMOTE_OMITTED parsed empty; a parser that finds nothing proves nothing')
  return names
}

/** verb name on window.mcAgent -> the IPC command behind it, from the preload
 *  the shell actually loads. */
function preloadAgentVerbs() {
  const code = withoutComments(read('shell/fleet-profile-preload.cjs'))
  const map = new Map()
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*[^\n]*ipcRenderer\.invoke\(\s*'mc-(agent:[a-z-]+)'/g)) {
    map.set(m[1], m[2])
  }
  assert.ok(map.has('profiles') && map.has('profileCreate'),
    'the preload verb map came out empty-handed; this test cannot see its reference')
  return map
}

const OMITTED_COMMANDS = new Set(remoteOmittedCommands())
const AGENT_VERBS = preloadAgentVerbs()
/* The verbs only the machine's own window has. */
const MACHINE_ONLY_VERBS = new Set(
  [...AGENT_VERBS].filter(([, command]) => OMITTED_COMMANDS.has(command)).map(([verb]) => verb),
)

/* A bridge shaped like the host it names. The desktop one is every verb the
   loaded preload publishes; the relay one is that list minus the commands the
   facade will not route -- neither is hand-written, so neither can drift away
   from the product and stay green. */
function desktopBridge() {
  const bridge = {}
  for (const verb of AGENT_VERBS.keys()) bridge[verb] = async () => ({ ok: true })
  return bridge
}
function relayBridge() {
  const bridge = desktopBridge()
  for (const verb of MACHINE_ONLY_VERBS) delete bridge[verb]
  return bridge
}

test('the omitted set is real and profileCreate is in it', () => {
  assert.ok(MACHINE_ONLY_VERBS.size >= 3,
    `only ${MACHINE_ONLY_VERBS.size} machine-only verb(s) resolved; the derivation is broken`)
  assert.ok(MACHINE_ONLY_VERBS.has('profileCreate'))
  assert.ok(MACHINE_ONLY_VERBS.has('pickAttachment'))
  assert.ok(MACHINE_ONLY_VERBS.has('pickMention'))
  /* The control: a verb the facade DOES route must not be in the set, or the
     derivation is matching everything and every row below means nothing. */
  assert.ok(!MACHINE_ONLY_VERBS.has('profileRemove'))
  assert.ok(!MACHINE_ONLY_VERBS.has('profiles'))
})

test('on the installed application every folder control is offered', () => {
  const access = profileControls(desktopBridge())
  assert.equal(access.list.enabled, true)
  assert.equal(access.add.enabled, true)
  assert.equal(access.remove.enabled, true)
  for (const control of Object.values(access)) assert.equal(control.why, '', 'an enabled control must not carry an unsupported warning')
})

test('a failed list read disables edits even when their verbs exist', () => {
  const reason = 'The session folders could not be read.'
  const access = profileControls(desktopBridge(), { readProblem: reason })
  assert.equal(access.add.disabled, true)
  assert.equal(access.remove.disabled, true)
  assert.equal(access.add.why, reason)
  assert.equal(access.remove.why, reason)
})

test('driving the machine from a browser: the folders read, and only the picker refuses', () => {
  const access = profileControls(relayBridge())
  assert.equal(access.list.enabled, true, 'the panel went absent over a bridge that can list folders')
  assert.equal(access.remove.enabled, true, 'Remove is routed over the relay and must stay offered')
  assert.equal(access.add.disabled, true, 'the picker was offered on a host that has no picker')
  assert.equal(access.add.why, PROFILE_PANEL.addNeedsMachine)
  assert.match(access.add.why, /Open ToolsEnabled on the computer itself/,
    'the refusal names no way to get the folder added')
})

test('a page with no host at all is the panel\'s absent state, not a broken control', () => {
  for (const bridge of [null, undefined, {}]) {
    const access = profileControls(bridge)
    assert.equal(access.list.disabled, true)
    assert.equal(access.add.disabled, true)
    assert.equal(access.remove.disabled, true)
    assert.ok(access.list.why.length > 0)
  }
})

test('WHY THE GATE CANNOT BE A CATCH: the missing verb throws before .catch attaches', async () => {
  const bridge = relayBridge()
  assert.equal(typeof bridge.profileCreate, 'undefined', 'the relay shape grew a picker; this drive is void')
  let caught = null
  let reached = false
  try {
    /* The exact expression the panel used to run. `.catch` is written on the
       same line and is unreachable: the TypeError is raised while the call
       expression is evaluated, so there is no promise for it to be attached
       to. This is the mechanism behind "the button does nothing". */
    await bridge.profileCreate({ name: 'x' }).catch(() => { reached = true; return { ok: false } })
  } catch (error) { caught = error }
  assert.ok(caught instanceof TypeError, `the press failed as ${caught && caught.name}, not as a TypeError`)
  assert.equal(reached, false, 'the .catch ran, so this whole finding is about a different mechanism')

  /* The control: the same expression on the desktop shape resolves, and the
     catch is never needed. */
  const ok = await desktopBridge().profileCreate({ name: 'x' }).catch(() => null)
  assert.deepEqual(ok, { ok: true })
})

test('a Remove press that changed nothing is not reported as a removal', () => {
  assert.deepEqual(profileRemoveOutcome({ ok: true, removed: true }), { ok: true, sentence: '' })
  /* The machine answering "I did not have that folder": ok-shaped, and not a
     removal. It used to fall through to the panel redraw, which is exactly
     what this panel looks like when the removal DID happen. */
  assert.equal(profileRemoveOutcome({ ok: true, removed: false }).ok, false)
  assert.equal(profileRemoveOutcome({ ok: true, removed: false }).sentence, PROFILE_PANEL.removeFailed)
  assert.equal(profileRemoveOutcome({ ok: false, code: 'MC_AGENT_PRINCIPAL_READ_ONLY' }).ok, false)
  /* A thrown refusal reaches the caller as null through its .catch. */
  assert.equal(profileRemoveOutcome(null).ok, false)
  assert.match(profileRemoveOutcome(null).sentence, /Try it again/)
})

test('the Remove press itself, driven: every refusal comes back as a sentence', async () => {
  /* THE PRESS USED TO READ
       await bridge.profileRemove({ profileId }).catch(() => null)
       void mountProfilePanel(slot)
     -- the answer discarded and the panel redrawn, which is precisely what
     this panel looks like when the removal DID happen. Each row below is a
     press that changed nothing on the machine. */
  const asked = []
  const machine = verb => ({ profileRemove: async request => { asked.push(request); return verb } })

  assert.deepEqual(await removeProfile(machine({ ok: true, removed: true }), 'p1'),
    { ok: true, sentence: '' })
  assert.deepEqual(asked, [{ profileId: 'p1' }], 'the id did not reach the machine unchanged')

  for (const reply of [{ ok: true, removed: false }, { ok: false, code: 'MC_AGENT_PRINCIPAL_READ_ONLY' }, null]) {
    const outcome = await removeProfile(machine(reply), 'p1')
    assert.equal(outcome.ok, false, `${JSON.stringify(reply)} was reported as a removal`)
    assert.equal(outcome.sentence, PROFILE_PANEL.removeFailed)
  }

  /* A THROWN refusal -- what the relay actually does with web-drive off -- is
     the same press, and must not escape the handler either. */
  const thrown = await removeProfile({
    profileRemove: async () => { throw Object.assign(new Error('read only'), { code: 'MC_AGENT_PRINCIPAL_READ_ONLY' }) },
  }, 'p1')
  assert.equal(thrown.ok, false)
  assert.equal(thrown.sentence, PROFILE_PANEL.removeFailed)

  /* A bridge can also refuse synchronously, before returning a promise. The
     press must turn that refusal into the same outcome rather than reject its
     event handler. */
  const syncThrown = await removeProfile({
    profileRemove: () => { throw new Error('bridge is unavailable') },
  }, 'p1')
  assert.equal(syncThrown.ok, false)
  assert.equal(syncThrown.sentence, PROFILE_PANEL.removeFailed)

  /* And a host with no remove verb refuses before it calls anything. */
  const absent = await removeProfile({}, 'p1')
  assert.equal(absent.ok, false)
  assert.equal(absent.sentence, PROFILE_PANEL.needsApp)
})

/* ---------------------------------------------------------------------------
 * THE RATCHET. No machine-only verb may be reached from a control this window
 * drew without asking whether the verb is there.
 *
 * "Asking" is either door:
 *   1. a `typeof <anything>.<verb> === 'function'` test in the calling
 *      function or one containing it -- what views/computers.js does for the
 *      two pickers; or
 *   2. a call to a decision helper whose exported verb map names the verb --
 *      what the folder panel does through profileControls().
 * ------------------------------------------------------------------------ */

function rendererFiles(dir = join(ROOT, 'src'), out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) rendererFiles(path, out)
    else if (entry.name.endsWith('.js')) out.push(path)
  }
  return out
}

const DECISION_HELPERS = new Set(['profileControls'])
const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

function lineOf(source, offset) { return source.slice(0, offset).split('\n').length }

/** Does this subtree ask for `verb` by either door? */
function asksFor(node, verb) {
  let found = false
  ;(function walk(n) {
    if (!n || typeof n !== 'object' || found) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (!n.type) return
    if (n.type === 'UnaryExpression' && n.operator === 'typeof') {
      // `typeof bridge?.verb` wraps the same member read in a ChainExpression.
      // Optional invocation alone is still not a capability check.
      const argument = n.argument?.type === 'ChainExpression' ? n.argument.expression : n.argument
      if (argument?.type === 'MemberExpression'
          && !argument.computed && argument.property?.name === verb) { found = true; return }
    }
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier'
        && DECISION_HELPERS.has(n.callee.name)
        && Object.values(PROFILE_CONTROL_VERBS).includes(verb)) { found = true; return }
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      walk(n[key])
    }
  })(node)
  return found
}

function unguardedMachineCalls(source) {
  const ungated = []
  const ast = parseAst(source)
  ;(function walk(node, fnStack) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(n => walk(n, fnStack)); return }
    if (!node.type) return
    const stack = FN_TYPES.has(node.type) ? [...fnStack, node] : fnStack
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
        && !node.callee.computed && node.callee.property?.type === 'Identifier'
        && MACHINE_ONLY_VERBS.has(node.callee.property.name)) {
      const verb = node.callee.property.name
      const asked = stack.some(fn => asksFor(fn, verb))
      if (!asked) ungated.push({ line: lineOf(source, node.start), verb })
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      walk(node[key], stack)
    }
  })(ast, [])
  return ungated
}

test('no machine-only verb is called from a control that never asked for it', () => {
  const ungated = []
  for (const file of rendererFiles()) {
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const source = readFileSync(file, 'utf8')
    try {
      ungated.push(...unguardedMachineCalls(source).map(({ line, verb }) => `${rel}:${line}  ${verb}()`))
    } catch (error) {
      assert.fail(`${rel} did not parse (${error.message}); a scan that cannot read a file proves nothing`)
    }
  }
  assert.deepEqual(ungated, [], `a control can reach a verb this window may not have:\n${ungated.join('\n')}`)
})

test('the ratchet above can see a defect: an unasked call is reported', () => {
  /* THE CONTROL FOR THE CONTROL. Without this, an empty result reads the same
     whether the tree is clean or the walker never matched anything. */
  const source = [
    'const bridge = window.mcAgent',
    'export function press() { return bridge.profileCreate({ name: \'x\' }) }',
  ].join('\n')
  const hits = unguardedMachineCalls(source).map(({ verb }) => verb)
  assert.deepEqual(hits, ['profileCreate'], 'the walker did not report a call nobody gated')
})

test('the same machine-verb detector recognizes ordinary and optional-chain capability checks', () => {
  for (const member of ['bridge.profileCreate', 'bridge?.profileCreate']) {
    const source = `function mount() {
      return typeof ${member} === 'function'
        ? { onCreate: () => bridge.profileCreate({ name: 'fixture' }) } : {}
    }`
    assert.deepEqual(unguardedMachineCalls(source), [], member)
  }
})

test('optional invocation and checks for a different verb still report an unguarded machine command', () => {
  for (const source of [
    'function press() { return bridge?.profileCreate({ name: "fixture" }) }',
    'function press() { return bridge.profileCreate?.({ name: "fixture" }) }',
    'function press() { if (typeof bridge?.profiles === "function") return bridge.profileCreate({ name: "fixture" }) }',
  ]) {
    assert.deepEqual(unguardedMachineCalls(source).map(({ verb }) => verb), ['profileCreate'], source)
  }
})

test('the method-presence ratchet recognizes optional access without admitting another verb or an unasked call', () => {
  for (const member of ['bridge.profileCreate', 'bridge?.profileCreate', 'window.mcAgent?.profileCreate']) {
    const ast = parseAst(`function press() { if (typeof ${member} !== 'function') return; return bridge.profileCreate({ name: 'x' }) }`)
    assert.equal(asksFor(ast, 'profileCreate'), true, member)
    assert.equal(asksFor(ast, 'pickAttachment'), false, 'asking for one method does not ask for every machine-only method')
  }
  assert.equal(asksFor(parseAst('function press() { return bridge?.profileCreate({ name: "x" }) }'), 'profileCreate'), false,
    'an optional call is not an explicit capability question')
})
