/* THE TOOLS PAGE'S ROWS, WALKED AS VALUES.
 *
 * The rows are built by src/agent-tools-markup.js, which is a function from a
 * tool and a state to markup, so these assertions drive the real builders
 * rather than describing the view's source. What they pin is the pair of
 * defects the page exists to close:
 *
 *   1. A TOOL HAS THREE ANSWERS ON SCREEN, not a checkbox with two.
 *   2. A TOOL THE LEVEL WITHHOLDS IS SHOWN. The drawer this replaced counted
 *      them -- "N more tools are withheld" -- with no name, no reason a person
 *      could act on, and nowhere to go. So a withheld row has to carry its own
 *      name, why it is unavailable, and where that was decided.
 *
 * The words themselves come from src/permission-guidance.js through
 * src/guided-step.js, and that is asserted here too: a page that wrote its own
 * withheld paragraph would be a second wording to keep true.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { TOOL_STATES, TOOL_STATE_LABELS } from '../../src/agent-tool-states.js'
import {
  WITHHELD_REASON,
  countLine,
  stateSentence,
  toolRowMarkup,
  withheldRowMarkup,
} from '../../src/agent-tools-markup.js'
import { describeSubject } from '../../src/permission-guidance.js'

const read = relative => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

const GATED = Object.freeze({ name: 'host.exec', allowed: true, gated: true })
const UNGATED = Object.freeze({ name: 'drive.upload', allowed: true, gated: false })
const WITHHELD = Object.freeze({ name: 'screen.capture', allowed: false, gated: false })

test('every switchable tool offers all three answers, with exactly one of them pressed', () => {
  for (const state of TOOL_STATES) {
    const markup = toolRowMarkup(GATED, { [GATED.name]: state }, true)
    for (const option of TOOL_STATES) {
      assert.match(markup, new RegExp(`data-tool-state="${option}"`), `the "${option}" answer is missing from a row`)
      assert.ok(markup.includes(TOOL_STATE_LABELS[option]), `the "${option}" answer has no label a person can read`)
    }
    assert.doesNotMatch(markup, / disabled(?:[ >])/, `state "${state}" makes a writable row unusable`)
    const pressed = markup.match(/aria-pressed="true"/g) || []
    assert.equal(pressed.length, 1, `state "${state}" left ${pressed.length} answers pressed`)
    assert.match(markup, new RegExp(`data-tool-state="${state}"[^>]*class="on"`),
      `state "${state}" is stored but not shown as the chosen answer`)
  }
})

test('the middle answer says which of its two outcomes this tool actually gets', () => {
  const asking = stateSentence(GATED, 'ask')
  const held = stateSentence(UNGATED, 'ask')
  assert.notEqual(asking, held,
    'a tool this program cannot ask about is being described exactly like one it can, which is the comfortable answer rather than the true one')
  assert.match(asking, /Ledger/i, 'a gated tool does not say where the question will reach the person')
  assert.match(held, /held back/i, 'an ungated tool does not say that it is held back rather than used')
  /* Within one tool the three answers read as three answers, so a person can
     tell the state from the words without reading the control beside them. Off
     is deliberately the SAME sentence for both tools: a tool that is off is off
     whether or not this program could have asked about it. */
  for (const tool of [GATED, UNGATED]) {
    const sentences = new Set(TOOL_STATES.map(state => stateSentence(tool, state)))
    assert.equal(sentences.size, 3, `two of ${tool.name}'s three answers are described with one sentence`)
  }
  assert.equal(stateSentence(GATED, 'disabled'), stateSentence(UNGATED, 'disabled'))
})

test('a control nobody may write is offered as unusable rather than as a live choice', () => {
  const markup = toolRowMarkup(GATED, {}, false)
  assert.equal((markup.match(/ disabled/g) || []).length, TOOL_STATES.length,
    'a read-only page still offers pressable answers')
})

test('a withheld tool is SHOWN, with its name, why it is unavailable, and where that is decided', () => {
  const markup = withheldRowMarkup(WITHHELD)
  assert.ok(markup.includes(WITHHELD.name), 'a withheld tool has no name on screen, which is the defect this page closes')
  assert.ok(markup.includes(WITHHELD_REASON), 'a withheld tool does not say why it is unavailable')
  const guidance = describeSubject('agent_tool')
  assert.equal(guidance.declared, true, 'the tools page has no declared statement, so its withheld rows would say nothing')
  assert.ok(markup.includes(guidance.turnOnAt), 'a withheld tool does not say where that answer is changed')
  for (const statement of guidance.capabilities) {
    assert.ok(markup.includes(statement), 'a withheld tool does not say what having it would let you do')
  }
  for (const statement of guidance.risks) {
    assert.ok(markup.includes(statement), 'a withheld tool does not say what having it would risk')
  }
  assert.doesNotMatch(markup, /data-tool-state=/,
    'a withheld tool offers an answer the permission level would refuse')
})

test('the page asks the shared module for the withheld wording rather than writing its own', () => {
  const markup = read('src/agent-tools-markup.js')
  assert.match(markup, /from '\.\/guided-step\.js'/, 'the tools page no longer uses the shared withheld block')
  assert.match(markup, /withheldMarkup\(/, 'the tools page stopped calling the shared withheld block')
  const view = read('src/views/tools.js')
  assert.match(view, /from '\.\.\/agent-tools-markup\.js'/, 'the view stopped using the testable row builders')
  assert.match(view, /from '\.\.\/agent-tool-states\.js'/, 'the view stopped using the shared three-state model')
})

test('the count line reports every group, so nothing is hidden inside a total', () => {
  const line = countLine({
    allowed: ['a', 'b'], asking: ['a'], heldBack: ['c'], off: ['d'], withheld: ['e', 'f'],
  }, 6)
  for (const fragment of ['6 tools', '2 on', '1 asking first', '1 held back', '1 off', '2 need a wider level']) {
    assert.ok(line.includes(fragment), `the count line does not report "${fragment}"`)
  }
})

test('caller-supplied text cannot become markup', () => {
  const markup = toolRowMarkup({ name: '<script>x</script>', allowed: true, gated: false }, {}, true)
  assert.ok(!markup.includes('<script>'), 'a tool name is rendered as markup rather than as text')
  assert.ok(markup.includes('&lt;script&gt;'))
})
