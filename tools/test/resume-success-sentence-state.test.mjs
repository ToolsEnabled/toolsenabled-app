// A RESUME THAT WORKED MUST NOT BE PAINTED AS A REFUSAL, AND MUST NOT STICK.
//
// MEASURED 2026-09-24 on the installed 1.0.46 build (/opt/ToolsEnabled), a
// tree node started from "Start this agent", halted mid-turn, then resumed
// from the Actions palette's "Resume with a fresh agent". The resume SUCCEEDED
// in the best way it can: the engine still held the thread, so the same agent
// came back with its own memory and nothing was re-sent and nothing charged.
// The app said so -- and said it in the failure style. Read off the live page:
//
//   document.querySelector('.org-status').dataset.state  -> "refuse"
//   .textContent -> "Back. This is the same agent, with everything it already
//                    remembered — nothing had to be re-sent."
//
// and, because statusSink makes every 'refuse' sticky, that banner was still
// on screen minutes later with nothing left running to clear it.
//
// WHY, AND IT IS ONE CHARACTER OF REACH, NOT A WORDING MISTAKE. statusSink in
// src/views/computers.js decides the state by comparing the sentence against a
// hand-written list of the success sentences it knows:
//
//   const state = sentence === RESUME_PANEL.done || sentence === PALETTE_PANEL.cleared ? 'ok' : 'refuse'
//
// A resume has TWO success sentences, not one. resumeNodeSessionUnguarded
// writes `engineResumed ? RESUME_PANEL.continued : RESUME_PANEL.done`, and the
// list holds only `done`. So the CHEAPER and better outcome -- the thread was
// still there, the conversation did not have to be re-sent -- is the one the
// product reports as a failure.
//
// WHY IT MATTERS MORE THAN A COLOUR. RESUME_PANEL.underway right above it
// exists because "a second press while the first resume is mid-flight used to
// start a SECOND agent... Both agents would then be live, only the last one to
// answer would own the node, and the other would keep working and spending
// with no control on screen able to reach it." A sticky red banner over a
// resume that actually worked is exactly the thing that makes a person press
// Resume again.
//
// WHAT THIS SUITE PINS, and it is the rule rather than today's two names: every
// sentence the resume SUCCESS path can write must be one statusSink reports as
// 'ok'. It reads both sides out of the real source, so a third success sentence
// added later without widening the list fails here rather than shipping as a
// refusal.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO, relative), 'utf8')

const VIEW = 'src/views/computers.js'

/* statusSink's whole body, brace-matched from its declaration -- the same
   technique tools/test/start-refusal-copy-honesty.test.mjs uses, and the
   reason this does not read a fixed number of characters: the decision below
   carries a comment, and a window would cut it in half. */
function statusSinkBody(source) {
  const at = source.indexOf('function statusSink(')
  assert.notEqual(at, -1, `${VIEW} no longer declares statusSink`)
  const open = source.indexOf('{', source.indexOf(')', at))
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new assert.AssertionError({ message: 'statusSink has no brace-matched body' })
}

/* The `? 'ok' : 'refuse'` decision inside statusSink, read across newlines so a
   list long enough to wrap still counts. Anchored on the function so a
   similarly-shaped ternary elsewhere in a 17k-line file cannot stand in. */
function statusSinkOkBranch(source) {
  const body = statusSinkBody(source)
  const at = body.indexOf("? 'ok' : 'refuse'")
  assert.notEqual(at, -1, "statusSink no longer decides its state with a ? 'ok' : 'refuse' ternary")
  const from = body.lastIndexOf('const state =', at)
  assert.notEqual(from, -1, "statusSink's 'ok'/'refuse' decision is no longer assigned to `const state`")
  return body.slice(from, at)
}

/* The sentence the resume writes to its caller's sink once it has succeeded.
   resumeNodeSessionUnguarded's last word on a resume that happened. */
function resumeSuccessSentenceNames(source) {
  const line = source.split('\n').find(row => /out\.textContent = engineResumed \?/.test(row))
  assert.ok(line, 'the resume success path no longer writes its sentence through `out.textContent = engineResumed ? ...`')
  const names = [...line.matchAll(/RESUME_PANEL\.([A-Za-z0-9_]+)/g)].map(match => match[1])
  assert.ok(names.length >= 2, `expected both resume outcomes on that line, read: ${line.trim()}`)
  return names
}

test('every sentence a successful resume writes is one statusSink reports as ok', () => {
  const source = read(VIEW)
  const okBranch = statusSinkOkBranch(source)
  for (const name of resumeSuccessSentenceNames(source)) {
    assert.ok(
      okBranch.includes(`RESUME_PANEL.${name}`),
      `a successful resume writes RESUME_PANEL.${name}, and statusSink does not report it as ok, so the person`
      + ` reads a resume that worked in the refusal style, stuck on screen. statusSink's ok branch is:\n  ${okBranch.trim()}`,
    )
  }
})

/* The half that makes the one above worth having: 'refuse' is what pins the
   banner open, so mis-classing a success is not a colour, it is a sentence
   that never clears. */
test('statusSink keeps only refusals on screen, so a mis-classed success would never clear', () => {
  assert.match(
    statusSinkBody(read(VIEW)),
    /setOrgStatus\(sentence, state, \{ sticky: state === 'refuse' \}\)/,
    'statusSink no longer makes exactly the refusals sticky; re-read whether a mis-classed success still stays on screen',
  )
})

/* Both names this fixes today really are distinct sentences, so the list above
   cannot be satisfied by them having quietly become the same string. */
test('the two resume outcomes say different things', () => {
  const copy = read('src/fleet-tree-copy.js')
  const pick = name => {
    const match = copy.match(new RegExp(`^\\s*${name}: '([^']*)'`, 'm'))
    assert.ok(match, `RESUME_PANEL.${name} is no longer a plain single-quoted sentence in src/fleet-tree-copy.js`)
    return match[1]
  }
  assert.notEqual(pick('continued'), pick('done'))
  assert.match(pick('continued'), /nothing had to be re-sent/)
})
