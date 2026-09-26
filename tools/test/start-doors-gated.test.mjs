/* EVERY DOOR THAT STARTS AN AGENT MUST ASK WHETHER STARTING IS ALLOWED.
 *
 * WHAT SHIPPED. The agent page's Chat box called window.mcAgent.start() -- a
 * real CLI child process on the person's machine, reading their files and
 * spending their assistant quota -- behind one gate: `canStart = live &&
 * window.mcAgent`, which asks whether an application is behind the page and
 * never whether the person allowed agent sessions. src/views/agent.js did not
 * import write-flags at all.
 *
 * Every other start door asks. computers.js gates at several sites, and the
 * agent page's OWN session surface gates at agent-session.js:122. So on a
 * default install the panel six inches above the Chat box rendered "Running
 * agents is switched off" and the box beneath it started an agent.
 *
 * WHY A CLASS RULE AND NOT A CASE. The product keeps growing start surfaces,
 * and pinning the one that was wrong would not catch the next. This finds every
 * real call and requires each to be gated.
 *
 * TWO THINGS THIS GUARD LEARNED THE HARD WAY, written in because both cost a
 * wrong answer while it was being built:
 *
 *   1. COMMENTS MUST BE STRIPPED, and the reason is not hypothetical. A grep
 *      for "mcAgent.start(" reports four modules; three of those hits are
 *      PROSE -- agent-session-controls.js:23, orchestration-controls.js:207 and
 *      computers.js:449 all discuss starting without doing it. A comment-blind
 *      rule would have named three innocent files forever, and the first person
 *      to "fix" one would have added a gate to a module that starts nothing.
 *
 *   2. THE CALL IS NOT SPELLED ONE WAY. The renderer starts an agent through
 *      `mcAgent.start(` on the agent page and through `bridge.start(` in
 *      computers.js and agent-session.js. A rule that knew only the first
 *      spelling passed while finding a single door, which is why the first test
 *      below refuses to run on a suspiciously small number of them.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { startControlOffBecause, startControlOffReason } from '../../src/setup-profile.js'
import { parseAst } from 'rollup/parseAst'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', '..', 'src')

/* Both spellings of "start an agent on this machine". `this.start()` in sim.js
   is a simulation's own loop and is deliberately not one of these. */
const START_CALL = /\b(?:mcAgent|bridge|agentBridge)\s*\.\s*start\s*\(/

/* A start door gated by the module that MOUNTS it rather than by itself. Each
   entry must name where the gate is, so a reviewer can check the claim instead
   of trusting it. Adding a line here is a deliberate assertion, not a way to
   silence the guard -- and the third test below fails if one goes stale.

   AN ENTRY MUST CARRY A STRUCTURAL PROOF OF THE GATE IT VOUCHES FOR, OR IT IS
   AN EXEMPTION WITH NO TEETH. `why` says where the mount injects the reader;
   `gate` is the expression that must still be present INSIDE the exempted file
   itself. Both are checked. Without the second, this list exempts a file from
   the class rule on the strength of a sentence -- and a mutation that replaced
   the coordinator's `if (!explicitlyAllowed(canStart)) throw` with
   `if (false) throw` left this whole suite GREEN while the consent gate was
   gone, because every assertion here was looking at the INJECTION in
   views/computers.js and nothing was looking at the gate being injected into.

   AND THE STRUCTURAL CHECK HAS A LIMIT, WHICH IS WHY `behaviouralTest` EXISTS.
   Stated plainly so nobody reads more assurance into it than it carries: the
   gate check is STRUCTURAL, NOT DATAFLOW. It proves the gate expression exists
   and precedes the start. IT WOULD NOT CATCH A GATE PRESENT BUT UNREACHABLE --
   a startAllowed() rewritten to return true, or a condition made permanently
   false somewhere else, passes it.

   Only running the module against real values catches that, so each entry also
   names the test that does. Both modules had such coverage already; nothing
   forced it to STAY, which made it exactly the kind of protection that can be
   deleted without anything going red. `behaviouralTest` and `behaviouralSymbol`
   make its disappearance a failure. */
const GATED_AT_MOUNT = new Map([
  [
    'fresh-start-existing-node.js',
    {
      why: 'views/computers.js freshStartExistingNodeUnguarded injects live canStart: () => isWriteEnabled(START_CONTROL_FLAG); the helper defaults canStart to () => false so it fails closed, and requires explicit true initially, after closing and before bridge.start. tree-node-command-fresh-start-behavior.test.mjs verifies held-close revocation preserves the saved work',
      mount: { file: 'views/computers.js', functionName: 'freshStartExistingNodeUnguarded', callee: 'executeFreshStartExistingNode' },
      gate: /if\s*\(\s*!\s*startAllowed\s*\(\s*\)\s*\)/,
      gateSays: 'if (!startAllowed()) -- three times: initially, after the close, and immediately before bridge.start',
      behaviouralTest: 'tree-node-command-fresh-start-behavior.test.mjs',
      behaviouralSymbol: 'canStart',
    },
  ],
  [
    'account-recovery-coordinator.js',
    {
      why: 'views/computers.js recoveryCoordinator injects a live canStart callback reading isWriteEnabled(START_CONTROL_FLAG); the coordinator requires explicit true before close and again immediately before start after the close await. account-recovery-coordinator.test.mjs exercises denied, absent and revoked consent against the actual coordinator.',
      mount: { file: 'views/computers.js', functionName: 'recoveryCoordinator', callee: 'createAccountRecoveryCoordinator' },
      gate: /if\s*\(\s*!\s*explicitlyAllowed\s*\(\s*canStart\s*\)\s*\)\s*throw/,
      gateSays: 'if (!explicitlyAllowed(canStart)) throw',
      behaviouralTest: 'account-recovery-coordinator.test.mjs',
      behaviouralSymbol: 'canStart',
    },
  ],
])

/* Some start calls live in a bridge wrapper that deliberately has no consent
   policy of its own. Keep that delegation narrow: the wrapper must still
   contain a real bridge.start call, and every named caller must expose a
   value-tested consent gate before its own start call. These are caller-owned
   doors, not a blanket exemption for the wrapper module. */
const DELEGATED_STARTS = new Map([
  [
    'research-tree-session.js',
    {
      why: 'withResearchTreeBinding delegates the native start; consent belongs to the mounted caller that owns the user action',
      wrapper: { file: 'research-tree-session.js', functionName: 'withResearchTreeBinding' },
      callers: [
        { file: 'views/computers.js', functionName: 'startAgentForNode', behaviouralTest: 'research-start-consent.test.mjs' },
        { file: 'views/computers.js', functionName: 'freshStartExistingNodeUnguarded', behaviouralTest: 'tree-start-cleanup-retention.test.mjs' },
        { file: 'views/computers.js', functionName: 'resumeNodeSessionUnguarded', behaviouralTest: 'tree-start-cleanup-retention.test.mjs' },
      ],
    },
  ],
])

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function jsFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) jsFilesUnder(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

function startDoors() {
  return jsFilesUnder(SRC).filter(file => START_CALL.test(stripComments(readFileSync(file, 'utf8'))))
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (['type', 'start', 'end', 'loc', 'extra'].includes(key)) continue
    if (Array.isArray(value)) value.forEach(child => walkAst(child, visit))
    else if (value && typeof value === 'object') walkAst(value, visit)
  }
}

function callerDeclaration(source, functionName) {
  const withoutExports = source.replace(/(^[ \t]*)export[ \t]+(?=(?:async[ \t]+)?function[ \t])/gm, '$1')
  return declaredFunctionSource(withoutExports, functionName)
}

function hasConsentRead(node) {
  let found = false
  walkAst(node, candidate => {
    if (found || candidate.type !== 'CallExpression'
      || candidate.callee?.type !== 'Identifier'
      || candidate.callee.name !== 'isWriteEnabled') return
    if (candidate.arguments.some(argument =>
      argument?.type === 'Identifier' && argument.name === 'START_CONTROL_FLAG')) found = true
  })
  return found
}

function standaloneConsentTest(node) {
  let valid = true
  walkAst(node, candidate => {
    if (!valid) return
    if (candidate.type === 'Identifier'
      && !['isWriteEnabled', 'START_CONTROL_FLAG'].includes(candidate.name)) valid = false
    if (candidate.type === 'CallExpression'
      && !(candidate.callee?.type === 'Identifier'
        && candidate.callee.name === 'isWriteEnabled'
        && candidate.arguments.length === 1
        && candidate.arguments[0]?.type === 'Identifier'
        && candidate.arguments[0].name === 'START_CONTROL_FLAG')) valid = false
  })
  return valid
}

function consentConditions(declaration) {
  const conditions = []
  walkAst(parseAst(declaration), node => {
    if (node.type === 'IfStatement' && hasConsentRead(node.test)
      && standaloneConsentTest(node.test)) conditions.push(node.test)
  })
  return conditions
}

function startCalls(declaration) {
  const calls = []
  walkAst(parseAst(declaration), node => {
    if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression'
      || node.callee.computed || node.callee.property?.type !== 'Identifier'
      || node.callee.property.name !== 'start') return
    calls.push(node)
  })
  return calls
}

function callerProbe(source, functionName) {
  let consent
  let starts = 0
  const postGate = new Error('POST_GATE_SENTINEL')
  const bridgeError = new Error('BRIDGE_START_REACHED')
  const node = { id: 'probe-node', treeId: 'probe-tree', createdAt: 1, sessionId: 'saved-session', tier: null }
  const bridge = {
    async start() { starts++; throw bridgeError },
    async send() { return { ok: true } },
    async sendAutomatic() { return { ok: true } },
  }
  const scope = {
    currentDataSource: () => 'local',
    window: { mcAgent: bridge },
    withRetainedStartIdentity: candidate => {
      if (functionName === 'freshStartExistingNodeUnguarded') throw postGate
      return candidate
    },
    isWriteEnabled: () => consent,
    START_CONTROL_FLAG: 'agent-session',
    startControlOffReason: () => 'Starting is off.',
    refusalCode: () => { throw postGate },
    nodeCleanupPending: () => functionName === 'resumeNodeSessionUnguarded' ? (() => { throw postGate })() : false,
    treeStore: {
      getTree: () => ({}),
      getNode: () => node,
    },
    slotAccountStartOptions: () => ({ ok: true, options: {} }),
    LAUNCH_TIERS: [],
    savedResearchRestrictionRefusal: () => null,
    transcriptStore: { ready: Promise.resolve(), readLatest: async () => null, get: () => null },
    destroyed: false,
  }
  assert.ok(['startAgentForNode', 'freshStartExistingNodeUnguarded', 'resumeNodeSessionUnguarded'].includes(functionName),
    'unexpected delegated caller ' + functionName)
  const compile = declaration => {
    const factory = new Function(...Object.keys(scope),
      declaration + '\nreturn ' + functionName)
    return factory(...Object.values(scope))
  }
  const declaration = callerDeclaration(source, functionName)
  const out = { textContent: '' }
  const conditions = consentConditions(declaration)
  const calls = startCalls(declaration)
  assert.ok(calls.length > 0, functionName + ' must contain a native start call')
  const gate = conditions.find(condition => condition.start < calls[0].start)
  assert.ok(gate, functionName + ' must decide consent before its first native start')
  return { functionName, scope, node, out, postGate, bridge, get consent() { return consent }, set consent(value) { consent = value },
    starts: () => starts, declaration, gate, compile }
}

async function invokeProbe(probe, declaration, value) {
  probe.consent = value
  probe.out.textContent = ''
  const fn = probe.compile(declaration)
  if (probe.functionName === 'resumeNodeSessionUnguarded') return fn(probe.node, { out: probe.out })
  return fn(probe.node)
}

async function assertCallerBehavior(probe) {
  for (const value of [false, undefined]) {
    const result = await invokeProbe(probe, probe.declaration, value)
    assert.equal(probe.starts(), 0,
      probe.functionName + ' must not start when consent is ' + String(value))
    if (probe.functionName === 'resumeNodeSessionUnguarded') {
      assert.equal(result, false, 'resume must refuse before any native start')
      assert.equal(probe.out.textContent, 'Starting is off.',
        'resume must publish the shared consent-off sentence')
    } else {
      assert.equal(result?.code, 'MC_TREE_COMMAND_START_DISABLED',
        probe.functionName + ' must return the consent-specific refusal code')
    }
  }
  await assert.rejects(() => invokeProbe(probe, probe.declaration, true),
    error => error === probe.postGate,
    probe.functionName + ' true consent must reach the explicit post-gate sentinel')
}

test('delegated start wrappers retain caller-owned consent evidence', async () => {
  for (const [name, entry] of DELEGATED_STARTS) {
    const wrapperPath = path.join(SRC, ...entry.wrapper.file.split('/'))
    assert.ok(existsSync(wrapperPath), name + ' delegated wrapper source is missing')
    const wrapper = callerDeclaration(readFileSync(wrapperPath, 'utf8'), entry.wrapper.functionName)
    assert.ok(startCalls(wrapper).length > 0,
      name + ' delegated wrapper must still delegate a native start call')
    assert.ok(entry.why.includes(entry.wrapper.functionName),
      name + ' delegated evidence must explain the wrapper delegation')

    for (const caller of entry.callers) {
      const callerPath = path.join(SRC, ...caller.file.split('/'))
      const callerSource = readFileSync(callerPath, 'utf8')
      const probe = callerProbe(callerSource, caller.functionName)
      await assertCallerBehavior(probe)
      const behaviouralPath = path.join(HERE, caller.behaviouralTest)
      assert.ok(existsSync(behaviouralPath),
        caller.functionName + ' delegated consent evidence is missing ' + caller.behaviouralTest)
      assert.ok(readFileSync(behaviouralPath, 'utf8').includes('assert'),
        caller.behaviouralTest + ' has no assertions for the delegated consent behavior')
    }
  }
})

test('the guard finds the start doors it is about', () => {
  /* THE VACUITY CHECK, AND IT EARNED ITS PLACE. While this suite was being
     written the pattern knew only one spelling of the call, so it found a
     single door and the gating assertion below passed over an empty list --
     green, and measuring nothing. */
  const files = jsFilesUnder(SRC)
  assert.ok(files.length > 100, `only ${files.length} source files found -- the walk is broken`)
  const doors = startDoors()
  assert.ok(doors.length >= 3,
    `only ${doors.length} start doors found (${doors.map(d => path.relative(SRC, d)).join(', ')}). `
    + 'That is fewer than this product has. If starting moved behind a new helper, teach START_CALL its name.')
})

test('every module that starts an agent is gated on the consent switch', () => {
  const ungated = []
  for (const file of startDoors()) {
    const name = path.basename(file)
    if (GATED_AT_MOUNT.has(name) || DELEGATED_STARTS.has(name)) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    const gated = /isWriteEnabled\s*\(/.test(code)
      && /START_CONTROL_FLAG|'agent-session'|"agent-session"/.test(code)
    if (!gated) ungated.push(path.relative(SRC, file))
  }
  assert.deepEqual(ungated, [],
    'These modules start a real agent process without asking whether the person allowed it:\n  '
    + ungated.join('\n  ')
    + '\nGate with isWriteEnabled(START_CONTROL_FLAG); mount-owned doors need GATED_AT_MOUNT, while '
    + 'delegated wrappers need DELEGATED_STARTS with caller value and mutation evidence.')
})

function assertMountedConsent(source, { functionName, callee }) {
  const declaration = declaredFunctionSource(source, functionName)
  const readers = []
  ;(function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === callee) {
      const options = node.arguments[0]
      if (options?.type === 'ObjectExpression') {
        for (const property of options.properties) {
          if (property.type === 'Property' && !property.computed && property.key?.name === 'canStart') readers.push(property.value)
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      walk(node[key])
    }
  })(parseAst(declaration))
  assert.equal(readers.length, 1, `${functionName} must pass exactly one canStart reader to ${callee}`)
  const reader = readers[0]
  assert.ok(['ArrowFunctionExpression', 'FunctionExpression'].includes(reader.type),
    `${functionName} must inject a callback, not a captured consent value`)
  const reads = []
  let consent
  const canStart = new Function('isWriteEnabled', 'START_CONTROL_FLAG',
    `return (${declaration.slice(reader.start, reader.end)})`)(flag => { reads.push(flag); return consent }, 'agent-session')
  for (const current of [false, true, false, undefined]) {
    consent = current
    reads.length = 0
    assert.equal(canStart(), current, `${functionName} must read current consent on every invocation`)
    assert.deepEqual(reads, ['agent-session'], `${functionName} must read the agent-session consent switch exactly once`)
  }
}

test('the mount-gated allowlist has not gone stale', () => {
  /* A file that stopped starting agents, or that gained its own gate, must
     leave this list -- otherwise the list slowly becomes the place real ungated
     doors hide. Empty is the healthy state. */
  const doors = new Set(startDoors().map(file => path.basename(file)))
  for (const [name, { why, mount }] of GATED_AT_MOUNT) {
    assert.ok(doors.has(name),
      `${name} is on the mount-gated list but no longer starts an agent -- take it off`)
    assert.ok(why.includes(mount.file) && why.includes(mount.functionName),
      `the reason for ${name} must identify its declaring function`)
    const source = readFileSync(path.join(SRC, ...mount.file.split('/')), 'utf8')
    assertMountedConsent(source, mount)
  }
})

test('mount consent evidence survives unrelated lines but refuses missing or constant readers', () => {
  for (const { mount } of GATED_AT_MOUNT.values()) {
    const source = readFileSync(path.join(SRC, ...mount.file.split('/')), 'utf8')
    const declaration = declaredFunctionSource(source, mount.functionName)
    assertMountedConsent(`/* unrelated source growth */\n\n${declaration}`, mount)
    for (const replacement of ['canStart: () => true', 'differentSetting: () => isWriteEnabled(START_CONTROL_FLAG)']) {
      const changed = declaration.replace('canStart: () => isWriteEnabled(START_CONTROL_FLAG)', replacement)
      assert.notEqual(changed, declaration, 'the mutation must reach the reviewed injection')
      assert.throws(() => assertMountedConsent(changed, mount),
        /current consent|canStart reader/, 'a broken consent injection must fail the same proof used for the source tree')
    }
  }
})

test('every exempted file still contains its own gate', () => {
  /* THE HOLE THIS CLOSES, AND IT WAS FOUND BY MUTATION, NOT BY READING.
     Replacing the coordinator's `if (!explicitlyAllowed(canStart)) throw` with
     `if (false) throw` -- deleting the consent gate outright -- left this
     entire suite GREEN. Only the coordinator's own unit tests went red.

     Every assertion here looked at the INJECTION in views/computers.js and
     none looked at the gate being injected INTO, so an allowlist entry vouched
     for a gate that no longer existed. The mount can hand a module a perfect
     live reader and the module can ignore it.

     Read comment-stripped, for the reason in this file's header: a gate
     DISCUSSED in prose is not a gate. */
  for (const [name, { gate, gateSays }] of GATED_AT_MOUNT) {
    const file = path.join(SRC, name)
    const code = stripComments(readFileSync(file, 'utf8'))
    assert.match(code, gate,
      `${name} is exempt from the primary door check because this list says it gates itself, `
      + `but its gate is gone.\n  expected to still find: ${gateSays}\n`
      + '  Either the gate was removed -- in which case this file starts agents without asking -- '
      + 'or it was rewritten, and this entry must be updated to match.')

    /* And it must sit in front of the door, not merely somewhere in the file. */
    const startAt = code.search(START_CALL)
    assert.ok(startAt > 0, `${name} no longer contains a start call -- take it off the list`)
    assert.ok(code.search(gate) < startAt,
      `${name} has its gate AFTER the start call, so the start is not behind it`)
  }
})

test('every exempted file still has a behavioural test exercising its gate', () => {
  /* THE STRUCTURAL CHECK ABOVE CANNOT SEE AN UNREACHABLE GATE -- see the
     GATED_AT_MOUNT header. A gate that is present, precedes the start, and
     always evaluates true passes it. Only driving the module with real values
     catches that.

     Both modules already had that coverage. NOTHING REQUIRED IT TO REMAIN,
     which is the same defect shape as the allowlist itself: protection resting
     on something no test asserts. Deleting the behavioural test, or gutting its
     assertions, would have left this suite green and the exemption standing. */
  for (const [name, { behaviouralTest, behaviouralSymbol }] of GATED_AT_MOUNT) {
    assert.ok(behaviouralTest && behaviouralSymbol,
      `${name} is exempt from the primary door check, so its entry must name the behavioural `
      + 'test that exercises its gate and the symbol that test drives it through')

    const file = path.join(HERE, behaviouralTest)
    assert.ok(existsSync(file),
      `${name} is exempt from the primary door check on the strength of ${behaviouralTest}, `
      + 'and that file does not exist. Either restore it, or take the entry off the list -- '
      + 'the exemption is not valid without it.')

    /* Comment-stripped for the reason in this file's header: a symbol named
       only in prose is not coverage. */
    const code = stripComments(readFileSync(file, 'utf8'))
    assert.ok(new RegExp(`\\b${behaviouralSymbol}\\b`).test(code),
      `${behaviouralTest} no longer drives ${name} through ${behaviouralSymbol}, so it is not `
      + 'exercising the consent gate any more, whatever else it still checks.')
    assert.match(code, /\bassert\b/,
      `${behaviouralTest} contains no assertions, so it cannot be what vouches for ${name}.`)
  }
})

test('the recovery mount supplies a live consent reader rather than a captured value', () => {
  const source = stripComments(readFileSync(path.join(SRC, 'views', 'computers.js'), 'utf8'))
  const at = source.indexOf('accountRecoveryCoordinator = createAccountRecoveryCoordinator({')
  assert.ok(at > 0)
  assert.match(source.slice(at, at + 400), /canStart:\s*\(\)\s*=>\s*isWriteEnabled\(START_CONTROL_FLAG\)/)
})

test('the fresh-start mount supplies a live consent reader rather than a captured value', () => {
  /* THE OTHER HALF OF THE ALLOWLIST, AND IT HAD NO TEST AT ALL.
     GATED_AT_MOUNT exempts two files from the primary door check. The
     coordinator's exemption is verified directly above; this one was taken on
     trust, so the only thing standing behind fresh-start-existing-node.js was a
     sentence -- and that sentence's line number had already drifted by ninety
     lines without anything noticing.

     fresh-start-existing-node.js defaults `canStart = () => false`, so it fails
     closed and is safe on its own; what this checks is that the mount actually
     hands it the LIVE reader. A captured boolean would be read once when the
     view was built and would keep starting agents after the person switched
     consent off -- the exact defect the coordinator assertion exists to catch. */
  const source = stripComments(readFileSync(path.join(SRC, 'views', 'computers.js'), 'utf8'))
  const at = source.indexOf('await executeFreshStartExistingNode({')
  assert.ok(at > 0,
    'the fresh-start call site was not found -- if it moved behind a helper, teach this guard its name')
  assert.match(source.slice(at, at + 400), /canStart:\s*\(\)\s*=>\s*isWriteEnabled\(START_CONTROL_FLAG\)/,
    'freshStartExistingNodeUnguarded must inject a live canStart reader, not a value captured at mount')
})

test('the agent page chat box asks at press time, not only at mount', () => {
  /* The flag can be turned on from Settings, or from the one-press control on
     the panel directly above this box, while the page is open. A gate evaluated
     when the composer was built would leave the box refusing until the person
     navigated away and back -- and would equally keep it live after they
     switched it off. */
  const agent = stripComments(readFileSync(path.join(SRC, 'views', 'agent.js'), 'utf8'))
  const at = agent.indexOf('startOrContinue = async')
  assert.ok(at > 0, 'startOrContinue not found -- rewrite this guard with it')
  const head = agent.slice(at, at + 700)
  assert.match(head, /isWriteEnabled\s*\(\s*START_CONTROL_FLAG\s*\)/,
    'the consent check must be inside startOrContinue, so it is read at the moment of the press')

  /* THE REFUSAL MUST BE INSIDE THE GATE'S OWN BRANCH, and this assertion is
     narrow because a wider one did not work. Written first as "the window
     contains fail(", it stayed GREEN when the sentence was deleted and a bare
     `return` left behind -- because startOrContinue calls fail() several times
     further down for unrelated reasons. That mutation is precisely the defect
     this file is about: a control that refuses in silence is indistinguishable
     from a broken product, and it is worse than one that refuses loudly. So the
     branch is cut out and checked on its own. */
  const gate = head.slice(head.indexOf('isWriteEnabled'))
  const branch = gate.slice(0, gate.indexOf('}') + 1)
  assert.match(branch, /fail\s*\(/,
    'the consent branch must say why it refused; a press that silently does nothing is the worse defect')
  assert.match(branch, /startControlOffReason/,
    'and it must say it in the shared words, not a sentence invented here')

  /* And it must refuse BEFORE anything is started or recorded. */
  const gateAt = head.indexOf('isWriteEnabled')
  const startAt = head.indexOf('mcAgent.start')
  assert.ok(startAt === -1 || gateAt < startAt,
    'the consent check must come before the start call')
})

test('the refusal is the same sentence the rest of the product uses', () => {
  /* Two surfaces describing one switch two ways is how a person comes to
     believe there are two switches. */
  const agent = stripComments(readFileSync(path.join(SRC, 'views', 'agent.js'), 'utf8'))
  assert.match(agent, /startControlOffReason/,
    'the chat box must use the shared off-reason, not a sentence of its own')
  const scope = { localStorage: { getItem: () => null } }
  const because = startControlOffBecause(scope)
  const reason = startControlOffReason(scope)
  assert.ok(reason.startsWith(because) && reason.length > because.length,
    'the shared off-reason must give the stored setup reason and explain how to change the switch')
})
