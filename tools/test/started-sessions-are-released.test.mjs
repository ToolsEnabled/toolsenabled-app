/* A VIEW THAT STARTS A SESSION MUST CLOSE IT WHEN IT GOES AWAY.
 *
 * THE OWNER'S REPORT: "then after a bunch of agents it starts failing agents".
 * A bunch is eight.
 *
 * WHAT WAS WRONG. The agent page has TWO things that start a session: the
 * session surface, and the Chat composer. destroy() closed the first and not
 * the second. chatSessionId was set when the composer started an agent and
 * nothing ever released it, so every visit that sent a message leaked one
 * session for the life of the application.
 *
 * WHY IT TAKES THE WHOLE PRODUCT DOWN AND NOT JUST THIS PAGE. The ceiling is
 * MAX_AGENT_SESSIONS = 8 in shell/main.cjs, and it is global. Once eight are
 * held, every agent start ANYWHERE refuses -- the computers page, the fleet
 * panel, all of it -- because the sessions are held by page visits that no
 * longer exist and no control can reach.
 *
 * WHY IT WAS INVISIBLE. A route change does not destroy the WebContents, so
 * nothing collected the session on its own; the product looked fine until the
 * eighth one. And the refusal it eventually produced told the person to "close
 * one on this page", which is an action no control could perform.
 *
 * WHY THIS IS A SOURCE READING. src/views/agent.js imports stylesheets, so
 * node cannot load it, and the session id lives in a closure with no seam. The
 * rule is checked structurally: anything that starts a session must appear in
 * the teardown. It would not catch a close that throws before it lands; that
 * belongs to the packaged drivers.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', '..', 'src')
const AGENT = path.join(SRC, 'views', 'agent.js')
const SOURCE = readFileSync(AGENT, 'utf8')
const SESSION_SOURCE = readFileSync(path.join(SRC, 'agent-session.js'), 'utf8')

/* Comments stripped: this defect is discussed at length in prose right beside
   the code, and a rule a comment can satisfy is not a rule. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

/* THIS FILE HAS MORE THAN ONE destroy(). An earlier draft of this suite took
   the FIRST one and asserted against a teardown that has nothing to do with the
   chat session -- it failed identically before and after the fix, which is the
   signature of a guard measuring the wrong thing. So every destroy() is
   brace-matched and the one that OWNS the chat session is selected by content. */
function destroyBodies(code) {
  const bodies = []
  let from = 0
  for (;;) {
    const at = code.indexOf('destroy() {', from)
    if (at < 0) return bodies
    const open = code.indexOf('{', at)
    let depth = 0
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1
      else if (code[i] === '}') {
        depth -= 1
        if (depth === 0) { bodies.push(code.slice(open, i + 1)); from = i + 1; break }
      }
    }
    if (depth !== 0) return bodies
  }
}

/** The teardown that owns the chat session, or null if none does. */
function destroyBody(code) {
  return destroyBodies(code).find(body => body.includes('destroyAgentSession')) || null
}

test('the guard can see the page and its teardown', () => {
  assert.ok(SOURCE.length > 20_000, 'agent.js did not load')
  assert.match(CODE, /chatSessionId/, 'the composer no longer tracks a session id; rewrite this guard with whatever replaced it')
  assert.ok(destroyBodies(CODE).length >= 1, 'no destroy() found at all -- rewrite this guard')
  assert.ok(destroyBody(CODE),
    `${destroyBodies(CODE).length} destroy() method(s) found and NONE disposes the mounted agent-session owner. `
    + 'That is the defect itself: the session the chat box starts is never released.')
})

test('the chat box starts a session, so the teardown must release it', () => {
  const body = destroyBody(CODE)
  /* STALE PATTERN, UPDATED RATHER THAN THE PRODUCT: 87bc4b14 (2026-09-17,
     "Resume: read the stored conversation directly") gave this page a second
     reason to mount the surface -- once immediately so the page is never
     blank, once more if a stored conversation arrives late -- so the single
     `const destroyAgentSession = mountAgentSessionSurface(...)` this guard
     used to look for became a reusable `mountSession` factory assigned into
     a mutable `agentSessionMount`, with `destroyAgentSession` as the stable
     wrapper that releases whichever mount is current. The property this
     guard exists to prove -- the surface's own release function is captured
     where teardown can reach it, not discarded -- did not change; only the
     source shape checking for it needed to. */
  assert.match(CODE, /const mountSession = history => mountAgentSessionSurface\(/,
    'the page no longer builds a reusable mount function for its composer session')
  assert.match(CODE, /agentSessionMount = mountSession\(/,
    'the surface a fresh mount returns is no longer captured where teardown can reach it')
  assert.match(CODE, /const destroyAgentSession = \(\) => \{ const release = agentSessionMount; agentSessionMount = null; release\?\.\(\) \}/,
    'the lifecycle owner no longer clears agentSessionMount before releasing it, so a later teardown could release it again')
  assert.match(body, /destroyAgentSession\(\)/,
    'destroy() never disposes the session-owning surface, so its child is held for the life of the application')
  const teardown = SESSION_SOURCE.slice(SESSION_SOURCE.lastIndexOf('return () => {'))
  assert.match(teardown, /void closeSession\(\)/,
    'the mounted surface teardown no longer closes the shell session it owns')
})

test('the reference is dropped as well as closed', () => {
  /* Closing without clearing would let a second teardown close the same id
     twice; clearing without closing is the original defect wearing a tidier
     coat. Both, in that order. */
  const closeStart = SESSION_SOURCE.indexOf('const closeSession = async () => {')
  const closeEnd = SESSION_SOURCE.indexOf('\n  }\n', closeStart)
  const close = SESSION_SOURCE.slice(closeStart, closeEnd)
  assert.match(close, /sessionId = null/,
    'the lifecycle owner must clear the id after close, or a later teardown closes it again')
})

test('the close cannot throw the rest of the teardown away', () => {
  /* destroy() removes listeners and stops surfaces after this point. An
     unguarded rejection here would strand all of it -- trading a session leak
     for a listener leak. */
  const closeStart = SESSION_SOURCE.indexOf('const closeSession = async () => {')
  const closeEnd = SESSION_SOURCE.indexOf('\n  }\n', closeStart)
  const close = SESSION_SOURCE.slice(closeStart, closeEnd)
  assert.match(close, /try \{ await bridge\.close\(/,
    'the close call is no longer guarded inside the lifecycle owner')
  assert.match(close, /catch \(error\)/,
    'a close rejection can now escape the fire-and-forget teardown')
})

test('there is no ceiling on running agents, so this suite guards a count rather than a cap', () => {
  /* THE CEILING IS GONE, and this test is the note that says why the rest of
     this suite still matters.

     It used to assert that a small global cap existed, on the reasoning that a
     leaked session was fatal because it consumed one of eight. The owner's
     ruling, 2026-09-03: the cap was never supposed to exist. So a leak no
     longer locks anybody out -- but it still makes the number a person reads
     wrong, and it still keeps a dead child's handles. Releasing a finished
     session is worth asserting for its own sake, which is what everything
     above this line does. */
  const main = readFileSync(path.join(HERE, '..', '..', 'shell', 'main.cjs'), 'utf8')
  assert.doesNotMatch(main, /MAX_AGENT_SESSIONS/,
    'a ceiling on running agents came back; it was removed deliberately and is not to return as a number nobody chose')
  const surface = readFileSync(path.join(HERE, '..', '..', 'shell', 'agent-command-surface.cjs'), 'utf8')
  assert.doesNotMatch(surface, /MC_AGENT_SESSION_LIMIT/,
    'the start path refuses for being the nth session again')
})
