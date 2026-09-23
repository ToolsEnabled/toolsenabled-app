/* THE PANEL THAT COLLECTS A ROLE AND A BRIEF, PROVEN WITHOUT A BROWSER.
 *
 * src/agent-compose-panel.js is the right-side panel a person fills in after
 * pressing an empty node in the fleet tree. Everything interesting about it is
 * a REFUSAL or an EMPTY STATE -- no role picked, no message written, the
 * caller's start failing halfway -- and those are exactly the states a
 * screenshot is worst at catching and a unit test is best at.
 *
 * THE SUITE'S SHARPEST ASSERTION IS ABOUT THE WORDS. src/fleet-tree-copy.js owns
 * every sentence in this flow, and a panel that quietly writes its own is how a
 * flow ends up with six voices. So one test walks the rendered panel and refuses
 * any text that is not one of that module's strings. It is written against the
 * RENDERED OUTPUT rather than the source, because a copy test that reads source
 * text passes when the table is right and the lookup is wrong.
 *
 * WHAT THIS SUITE CANNOT SEE, said plainly so nobody reads more into a green
 * run than is there: it cannot tell whether the panel is ever MOUNTED in the
 * shipped application, and it cannot measure a real focus ring or a real tab
 * order. The first belongs to whichever view wires it up; the second belongs to
 * tools/a11y-keyboard-qa.mjs, which drives the packaged window with real key
 * events. What is proven here is that every control is a real focusable element
 * with a label bound to it, which is the part a harness cannot repair later.
 *
 * THE FAKE DOM IS SMALL ON PURPOSE, in the idiom of
 * tools/test/settings-recovery-notice.test.mjs: it supports exactly what the
 * module uses, so a call to anything else fails loudly instead of being absorbed
 * by a permissive stub. It does implement event BUBBLING, because the panel's
 * Escape handler sits on the root and reads a key press that happened in the
 * message box -- a fake without bubbling would let that test pass while the real
 * panel ignored the key.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { findingsInText } from '../check-plain-language.mjs'
import { visibleTextFrom, withoutComments } from '../lib/user-visible-strings.mjs'
import { ROLES } from '../../src/vocab.js'
import {
  DEFAULT_TIER,
  FIRST_ROLE_SUGGESTION,
  ROLE_CHOICES,
  START_PANEL,
  START_REFUSAL,
  TIER_CHOICES,
  TREE_DEFAULT_STARTABLE_TIERS,
  startableTierIds,
  tierChoicesFor,
  signedOutProviderIds,
  notInstalledProviderIds,
  EFFORT_CHOICES,
  effortOptionLabel,
  roleLabel,
  startingLine,
} from '../../src/fleet-tree-copy.js'
import {
  assignableRoles,
  composeDraftProblems,
  composeDraftRole,
  mountAgentComposePanel,
} from '../../src/agent-compose-panel.js'
/* The confinement sentences are NOT this flow's copy and are deliberately not
   added to APPROVED_WORDS: they arrive as a caller-supplied line, the same door
   the refusal sentence uses, and the panel renders nothing of them by default.
   Imported here so the assertions run the real copy module rather than a
   literal that could drift away from what ships. */
import {
  FAIL_CLOSED_CLAUSE,
  SANDBOX_EFFECT,
  UNKNOWN_CONFINEMENT,
  startControlLine,
} from '../../src/agent-confinement-copy.js'

const MODULE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'agent-compose-panel.js',
)

/* The name of the pressed node, wherever a test needs one. It is the only piece
   of caller text this panel renders, and it is rendered only inside the copy
   module's own sentence. */
const PRESSED_NODE_NAME = 'Nova'

/* Every string this flow is allowed to say, flattened out of the copy module.
   Assembled from its exports rather than retyped: a sentence reworded there
   must not be able to fail this suite. START_PANEL.underNamed is a FUNCTION --
   a name goes in and a whole sentence comes out -- so it is called rather than
   listed, which is also the proof that a bare name could never match. */
const APPROVED_WORDS = new Set([
  ...Object.values(START_PANEL).filter(value => typeof value === 'string'),
  START_PANEL.underNamed(PRESSED_NODE_NAME),
  ...Object.values(START_REFUSAL),
  FIRST_ROLE_SUGGESTION.line,
  ...ROLE_CHOICES.map(choice => choice.label),
  ...ROLE_CHOICES.map(choice => choice.summary),
  ...ROLE_CHOICES.map(choice => startingLine(choice.role)),
  ...TIER_CHOICES.map(choice => choice.label),
  ...EFFORT_CHOICES.map(choice => choice.label),
  /* The depth rows read "<provider name> — <provider sentence>", composed by
     the copy module so the panel still writes none of it. */
  ...EFFORT_CHOICES.map(choice => effortOptionLabel(choice)),
])

class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.value = ''
    this.disabled = false
    this.type = ''
    this._text = ''
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  get textContent() {
    return this.children.length ? this.children.map(child => child.textContent).join('') : this._text
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute(name) { this.attributes.delete(name) }
  hasAttribute(name) { return this.attributes.has(name) }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    this.children = this.children.filter(entry => entry !== child)
    child.parentNode = null
    return child
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(listener)
  }

  /* Fires on this node and then on every ancestor, which is what a real event
     does and what the panel's root-level Escape handler depends on. */
  dispatch(name, event = {}) {
    let node = this
    while (node) {
      for (const listener of node.listeners.get(name) || []) listener(event)
      node = node.parentNode
    }
  }

  /* A real browser refuses focus on a disabled control -- the call simply does
     nothing and focus stays where it was. Without modelling that, a focus()
     aimed at a switched-off field reads as landing, and the suite would bless
     a panel whose Escape is dead exactly when the form ships disabled. */
  focus() { if (this.disabled) return; this.ownerDocument.activeElement = this }

  /* RECORDED, NEVER PERFORMED. The panel brings a freshly opened form into view
     on a page that scrolls, and there is no page here -- so the fake keeps the
     calls and the suite reads them. The calls are collected on the DOCUMENT
     rather than on the element, because every re-render builds a brand new root
     and a counter living on the root would reset with it. What this cannot
     model is the third of the panel's three conditions -- `block: 'nearest'` is
     the browser doing nothing when the element is already fully visible -- so
     the suite pins the option instead of the outcome. */
  scrollIntoView(options) { this.ownerDocument.scrollCalls.push({ target: this, options }) }

  find(predicate) {
    if (predicate(this)) return this
    for (const child of this.children) {
      const hit = child.find(predicate)
      if (hit) return hit
    }
    return null
  }

  findAll(predicate, into = []) {
    if (predicate(this)) into.push(this)
    for (const child of this.children) child.findAll(predicate, into)
    return into
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement(this, 'body')
    this.activeElement = null
    /* Every scrollIntoView any element in this document received, in order. */
    this.scrollCalls = []
  }

  createElement(tagName) { return new FakeElement(this, tagName) }
}

function open(options = {}) {
  const doc = new FakeDocument()
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const calls = { submitted: [], cancelled: 0 }
  const handle = mountAgentComposePanel({
    doc,
    container,
    onSubmit: draft => { calls.submitted.push(draft); return options.answer },
    onCancel: () => { calls.cancelled += 1 },
    ...options,
  })
  return { doc, container, handle, calls }
}

const fieldNamed = (handle, name) => handle.element().find(node => node.getAttribute('data-compose-field') === name)
const problemFor = (handle, name) => handle.element().find(node => node.getAttribute('data-compose-problem') === name)
const actionNamed = (handle, name) => handle.element().find(node => node.getAttribute('data-compose-action') === name)
const noticeLine = handle => handle.element().find(node => node.getAttribute('data-compose-notice') === 'panel')
const statusLine = handle => handle.element().find(node => node.getAttribute('data-compose-status') === 'panel')
const confinementLineOf = handle => handle.element().find(node => node.getAttribute('data-compose-confinement') === 'panel')
const summaryLine = handle => handle.element().find(node => node.getAttribute('data-compose-summary') === 'role')

function fill(handle, { role, tier, message }) {
  if (role !== undefined) fieldNamed(handle, 'role').value = role
  if (tier !== undefined) fieldNamed(handle, 'tier').value = tier
  if (message !== undefined) fieldNamed(handle, 'message').value = message
}

/* Every word on screen, leaf by leaf. Elements with children are skipped
   because their text is their children's, counted already. */
const wordsOnScreen = handle => handle.element()
  .findAll(node => node.children.length === 0)
  .map(node => node.textContent.trim())
  .filter(Boolean)


/* Research is a tree scope selected independently from its optional role. */
const RESEARCH_PROJECTS = [
  { projectId: 'rp-a111', name: 'Lean Bench', status: 'active' },
  { projectId: 'rp-b222', name: 'Replication', status: 'active' },
  { projectId: 'rp-c333', name: 'Archived study', status: 'archived' },
]
const RESEARCH_ROLES = [{ id: 'researcher', label: 'Researcher' }, { id: 'worker', label: 'Worker' }]
function chooseResearch(handle, projectId = '') {
  const scope = fieldNamed(handle, 'workspace-kind')
  scope.value = 'research'
  scope.dispatch('change')
  fieldNamed(handle, 'research-project').value = projectId
}

test('research root scope starts on working folder and keeps the ordinary draft contract', () => {
  const { handle } = open({ researchProjects: RESEARCH_PROJECTS, roles: RESEARCH_ROLES,
    folders: [{ id: 'work-a', name: 'Code' }], folderSelectedId: 'work-a' })
  const scope = fieldNamed(handle, 'workspace-kind')
  assert.deepEqual(scope.children.map(option => option.value), ['folder', 'research'])
  assert.equal(scope.value, 'folder')
  assert.equal(fieldNamed(handle, 'research-project').parentNode.hidden, true)
  assert.equal(fieldNamed(handle, 'profile').parentNode.hidden, false)
  fill(handle, { message: 'Keep ordinary folder work.' })
  assert.deepEqual(handle.draft(), { mode: undefined, role: '', tier: DEFAULT_TIER,
    effort: 'medium', message: 'Keep ordinary folder work.', parentId: null, profileId: 'work-a' })
})

test('research scope offers active projects and keeps role selection optional', () => {
  const { handle, calls } = open({ researchProjects: RESEARCH_PROJECTS, roles: RESEARCH_ROLES })
  chooseResearch(handle, 'rp-a111')
  assert.equal(fieldNamed(handle, 'research-project').parentNode.hidden, false)
  assert.equal(fieldNamed(handle, 'profile').parentNode.hidden, true)
  assert.deepEqual(fieldNamed(handle, 'research-project').children.map(option => option.value),
    ['', 'rp-a111', 'rp-b222'])
  assert.equal(fieldNamed(handle, 'role').value, '')
  fill(handle, { message: 'Inspect the original prompts.' })
  actionNamed(handle, 'set').dispatch('click')
  assert.deepEqual(calls.submitted, [{ mode: 'set', role: '', tier: DEFAULT_TIER, effort: 'medium',
    message: 'Inspect the original prompts.', parentId: null, profileId: null,
    workspaceKind: 'research', researchProjectId: 'rp-a111', researchProjectName: 'Lean Bench' }])
})

test('research project selection is required before setting or starting a root', () => {
  for (const mode of ['set', 'start']) {
    const { handle, calls, doc } = open({ researchProjects: RESEARCH_PROJECTS })
    chooseResearch(handle)
    fill(handle, { message: 'Review the study.' })
    actionNamed(handle, mode).dispatch('click')
    assert.deepEqual(calls.submitted, [], mode)
    assert.match(noticeLine(handle).textContent, /choose.*project/i)
    assert.equal(doc.activeElement, fieldNamed(handle, 'research-project'))
    assert.equal(fieldNamed(handle, 'message').value, 'Review the study.')
  }
})

test('research availability refuses only the research scope and preserves folder work', () => {
  const { handle, calls } = open({ researchProjects: RESEARCH_PROJECTS,
    researchUnavailableReason: 'Research projects are still loading.' })
  chooseResearch(handle, 'rp-a111')
  fill(handle, { message: 'Preserve this request.' })
  actionNamed(handle, 'set').dispatch('click')
  assert.deepEqual(calls.submitted, [])
  assert.equal(fieldNamed(handle, 'research-project').disabled, true)
  assert.equal(noticeLine(handle).textContent, 'Research projects are still loading.')
  fieldNamed(handle, 'workspace-kind').value = 'folder'
  fieldNamed(handle, 'workspace-kind').dispatch('change')
  actionNamed(handle, 'set').dispatch('click')
  assert.equal(calls.submitted.length, 1)
  assert.equal(Object.hasOwn(calls.submitted[0], 'workspaceKind'), false)
})

test('research children inherit their tree scope without a second scope selector', () => {
  const { handle, calls } = open({ parent: { id: 'node-parent' }, researchProjects: RESEARCH_PROJECTS,
    roles: RESEARCH_ROLES })
  for (const name of ['workspace-kind', 'research-project', 'profile']) assert.equal(fieldNamed(handle, name), null)
  fill(handle, { message: 'Read the assigned composition.' })
  actionNamed(handle, 'set').dispatch('click')
  assert.equal(calls.submitted[0].parentId, 'node-parent')
  assert.equal(calls.submitted[0].role, '')
  assert.equal(Object.hasOwn(calls.submitted[0], 'researchProjectId'), false)
  assert.equal(Object.hasOwn(calls.submitted[0], 'workspaceKind'), false)
})

test('research readiness repaint preserves the typed draft, project, role choice and focus', () => {
  const { handle, doc } = open({ researchProjects: RESEARCH_PROJECTS, roles: RESEARCH_ROLES })
  const text = '  Preserve this draft.\nStill typing. '
  chooseResearch(handle, 'rp-b222')
  fill(handle, { role: 'worker', tier: 'terra', message: text })
  fieldNamed(handle, 'effort').value = 'high'
  fieldNamed(handle, 'message').focus()
  handle.open({ tiers: tierChoicesFor(['luna', 'terra']), researchProjects: [...RESEARCH_PROJECTS] })
  handle.open({ confinementLine: UNKNOWN_CONFINEMENT })
  assert.equal(fieldNamed(handle, 'message').value, text)
  assert.equal(doc.activeElement, fieldNamed(handle, 'message'))
  assert.equal(fieldNamed(handle, 'workspace-kind').value, 'research')
  assert.equal(fieldNamed(handle, 'research-project').parentNode.hidden, false)
  assert.deepEqual(handle.draft(), { mode: undefined, role: 'worker', tier: 'terra', effort: 'high',
    message: text.trim(), parentId: null, profileId: null, workspaceKind: 'research',
    researchProjectId: 'rp-b222', researchProjectName: 'Replication' })
})

test('research refresh clears a removed or archived project without discarding the brief', () => {
  for (const researchProjects of [
    RESEARCH_PROJECTS.filter(project => project.projectId !== 'rp-b222'),
    RESEARCH_PROJECTS.map(project => project.projectId === 'rp-b222' ? { ...project, status: 'archived' } : project),
  ]) {
    const { handle, calls } = open({ researchProjects: RESEARCH_PROJECTS, roles: RESEARCH_ROLES })
    chooseResearch(handle, 'rp-b222')
    fill(handle, { message: 'Keep this draft.' })
    handle.open({ researchProjects })
    assert.equal(fieldNamed(handle, 'workspace-kind').value, 'research')
    assert.equal(fieldNamed(handle, 'research-project').value, '')
    assert.equal(handle.draft().message, 'Keep this draft.')
    assert.equal(handle.draft().role, '')
    actionNamed(handle, 'set').dispatch('click')
    assert.deepEqual(calls.submitted, [])
  }
})

test('research submission locks scope and project through readiness updates until refusal', async () => {
  const pending = deferred()
  const { handle, calls } = open({ researchProjects: RESEARCH_PROJECTS, roles: RESEARCH_ROLES, answer: pending.promise })
  chooseResearch(handle, 'rp-a111')
  fill(handle, { message: 'Start one study agent.' })
  actionNamed(handle, 'start').dispatch('click')
  handle.open({ tiers: TIER_CHOICES, researchProjects: [...RESEARCH_PROJECTS] })
  for (const name of ['workspace-kind', 'research-project', 'profile', 'role', 'tier', 'effort', 'message']) {
    assert.equal(fieldNamed(handle, name).disabled, true, name)
  }
  for (const name of ['set', 'start', 'cancel']) assert.equal(actionNamed(handle, name).disabled, true, name)
  actionNamed(handle, 'start').dispatch('click')
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.submitted[0].researchProjectId, 'rp-a111')
  pending.resolve({ ok: false, message: 'The original start was refused.' })
  await pending.promise
  for (const name of ['workspace-kind', 'research-project', 'role', 'message']) assert.equal(fieldNamed(handle, name).disabled, false, name)
  assert.equal(handle.draft().researchProjectId, 'rp-a111')
  assert.equal(handle.draft().message, 'Start one study agent.')
  assert.equal(handle.draft().role, '')
  assert.equal(noticeLine(handle).textContent, 'The original start was refused.')
})

/* ---------- the words are the copy module's, and nobody else's ---------- */

test('every word this panel puts on screen comes from the flow’s own copy', () => {
  for (const parent of [null, { id: 'node-17' }, { id: 'node-17', name: PRESSED_NODE_NAME }]) {
    const { handle } = open({ parent })
    const strays = wordsOnScreen(handle).filter(words => !APPROVED_WORDS.has(words))
    assert.deepEqual(strays, [], 'these sentences were written in the panel instead of src/fleet-tree-copy.js')
    assert.ok(wordsOnScreen(handle).length >= 6, 'nothing was read, so nothing was measured')
  }
})

test('the refusals and the picked role’s line are the copy module’s too', () => {
  const { handle } = open()
  actionNamed(handle, 'start').dispatch('click')

  /* ONE REFUSAL, NOT TWO. The role stopped being required on 2026-08-19
     (owner: "users shouldnt be forced to choose a role"), so the role field has
     no problem line at all any more -- not an empty one. */
  assert.equal(problemFor(handle, 'role'), null, 'the role field can no longer be refused, so it must not carry a refusal line')
  assert.equal(problemFor(handle, 'message').textContent, START_PANEL.needMessage)
  assert.deepEqual(wordsOnScreen(handle).filter(words => !APPROVED_WORDS.has(words)), [])

  fill(handle, { role: 'manager' })
  fieldNamed(handle, 'role').dispatch('change')
  assert.deepEqual(wordsOnScreen(handle).filter(words => !APPROVED_WORDS.has(words)), [])
})

test('the panel’s own labels and buttons are the flow’s, word for word', () => {
  const { handle } = open()

  /* The title lives in the nav row's title slot (2026-08-14: the separate h3
     was ~30px that pushed Start below the fold of an 832px window). Found via
     the root's own aria-labelledby, the same wiring the screen-reader test
     follows, so this assertion survives any future re-homing of the words. */
  const titleId = handle.element().getAttribute('aria-labelledby')
  assert.equal(handle.element().find(node => node.getAttribute('id') === titleId).textContent, START_PANEL.title)
  assert.equal(handle.element().find(node => node.className === 'agent-compose-intro').textContent, START_PANEL.intro)
  assert.equal(actionNamed(handle, 'start').textContent, START_PANEL.submitStart)
  assert.equal(actionNamed(handle, 'cancel').textContent, START_PANEL.cancel)
  assert.equal(fieldNamed(handle, 'message').getAttribute('placeholder'), START_PANEL.messagePlaceholder)
})

/* ---------- the roles come from the product, and only labels are shown ---------- */

test('the roles offered are the flow’s own pick list, labelled from the product’s vocabulary', () => {
  const roles = assignableRoles()

  assert.deepEqual(roles.map(role => role.id), ROLE_CHOICES.map(choice => choice.role))
  for (const role of roles) {
    assert.equal(role.label, ROLES[role.id].label, 'a label was invented instead of read from the vocabulary')
  }
  // "Agent spawned" is what an agent BECOMES when another agent starts it. The
  // copy module leaves it out of the picker on purpose, and this panel defers.
  assert.ok(!roles.some(role => role.id === 'spawned'))
})

test('a caller may narrow the list, by key alone, and no key is ever printed for it', () => {
  const narrowed = assignableRoles(['manager', 'helper'])
  assert.deepEqual(narrowed.map(role => role.label), [roleLabel('manager'), roleLabel('helper')])

  // A role this build has no entry for is named by the product's own fallback
  // word, never by its key.
  const unknown = assignableRoles([{ id: 'admiral' }])
  assert.deepEqual(unknown.map(role => role.label), ['Agent'])
  assert.doesNotMatch(unknown[0].label, /admiral/)
})

test('a caller that hands over nothing gets the product’s list rather than an empty menu', () => {
  // A form nobody can complete would need a sentence saying why, and that
  // sentence does not exist in the copy module. A caller passing nothing is a
  // wiring fault, not a state a person can press their way into.
  assert.deepEqual(assignableRoles([]), assignableRoles(ROLE_CHOICES))
  assert.deepEqual(assignableRoles(null), assignableRoles(ROLE_CHOICES))
})

test('every choice on screen is a label, and no role key is anywhere in the panel’s text', () => {
  const { handle } = open()
  const options = handle.element().findAll(node => node.tagName === 'OPTION')

  // A root chooses folder or Research scope. With no supplied folders or
  // projects, those menus contain one prompt/default row each.
  assert.equal(options.length, ROLE_CHOICES.length + 1 + TIER_CHOICES.length + EFFORT_CHOICES.length + 1 + 2 + 1,
    'every role plus its prompt, every tier and effort, folder default, scope choices and project prompt')
  const roleOptions = fieldNamed(handle, 'role').children
  assert.equal(roleOptions[0].textContent, START_PANEL.rolePrompt)
  assert.equal(roleOptions[0].value, '', 'the panel opens with nothing chosen, so a press cannot pass a role nobody picked')
  assert.deepEqual(roleOptions.slice(1).map(option => option.textContent), ROLE_CHOICES.map(choice => choice.label))
  // The key travels on the value, where only the program reads it.
  assert.deepEqual(roleOptions.slice(1).map(option => option.value), ROLE_CHOICES.map(choice => choice.role))

  /* KEY-AS-A-WORD IS NOT KEY-AS-A-KEY, and the difference decides this test.
     The suggestion line reads "A coordinator sits at the top of a tree" -- that
     is the English word inside a sentence somebody wrote, and banning it would
     be banning the copy module's own prose. What must never happen is a key
     STANDING IN FOR A LABEL, which is a whole piece of text that IS the key. */
  for (const words of wordsOnScreen(handle)) {
    assert.ok(!Object.keys(ROLES).includes(words), `the key ${words} is standing where a label should be`)
    assert.ok(!TIER_CHOICES.some(choice => choice.id === words), `the tier id ${words} is standing where a label should be`)
  }
})

test('choosing a role shows that role’s own line, and only that one', () => {
  const { handle } = open()
  assert.equal(summaryLine(handle).textContent, '', 'nothing is chosen, so nothing is claimed')

  fill(handle, { role: 'manager' })
  fieldNamed(handle, 'role').dispatch('change')
  assert.equal(summaryLine(handle).textContent, ROLE_CHOICES.find(choice => choice.role === 'manager').summary)

  fill(handle, { role: 'shadow' })
  fieldNamed(handle, 'role').dispatch('change')
  assert.equal(summaryLine(handle).textContent, ROLE_CHOICES.find(choice => choice.role === 'shadow').summary)
})

/* ---------- which node was pressed ---------- */

test('an empty tree is offered the suggestion about shape, and nothing is pre-picked', () => {
  const { handle } = open({ parent: null })
  const suggestion = handle.element().find(node => node.getAttribute('data-compose-suggestion') === 'first-role')

  assert.equal(suggestion.textContent, FIRST_ROLE_SUGGESTION.line)
  assert.equal(fieldNamed(handle, 'role').value, '', 'a suggestion that picks for you is not a suggestion')
})

test('a tree that already has agents is not given the first-agent suggestion', () => {
  const { handle } = open({ parent: { id: 'node-17' } })

  assert.equal(handle.element().find(node => node.getAttribute('data-compose-suggestion') === 'first-role'), null)
})

test('a named node is named, inside the flow’s own sentence', () => {
  const { handle } = open({ parent: { id: 'node-17', name: PRESSED_NODE_NAME } })
  const under = handle.element().find(node => node.getAttribute('data-compose-under') === 'parent')

  assert.equal(under.textContent, START_PANEL.underNamed(PRESSED_NODE_NAME))
  // A bare name is a fragment a reader has to guess the meaning of. It never
  // appears without the sentence around it.
  assert.notEqual(under.textContent, PRESSED_NODE_NAME)
})

test('a node this app cannot name gets the sentence written for that, never a blank line', () => {
  const { handle } = open({ parent: { id: 'node-17' } })
  const under = handle.element().find(node => node.getAttribute('data-compose-under') === 'parent')

  assert.equal(under.textContent, START_PANEL.underUnnamed)
})

test('the pressed node’s id travels in the draft and is never rendered', () => {
  const { handle, calls } = open({ parent: { id: 'node-17', name: PRESSED_NODE_NAME } })
  assert.doesNotMatch(handle.element().textContent, /node-17/, 'an id in a sentence is the defect the gate exists to catch')

  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')
  assert.deepEqual(calls.submitted, [{ mode: 'start', role: 'manager', tier: DEFAULT_TIER, effort: 'medium', message: 'Take the packaging work.', parentId: 'node-17', profileId: null }])
})

test('a node’s name is put on the page as text, never as markup', () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const { handle } = open({ parent: { id: 'node-17', name: hostile } })
  const under = handle.element().find(node => node.getAttribute('data-compose-under') === 'parent')

  // A node name is chosen by nobody on this team. The panel builds elements and
  // assigns textContent rather than concatenating markup, so these are
  // characters.
  assert.equal(under.textContent, START_PANEL.underNamed(hostile))
  assert.equal(under.children.length, 0)
})

test('an empty tree is told nothing about a parent it does not have', () => {
  const { handle } = open({ parent: null })

  assert.equal(handle.element().find(node => node.getAttribute('data-compose-under') === 'parent'), null)
})

test('no parent at all means this begins a new tree, and the draft carries no parent', () => {
  const { handle, calls } = open({ parent: null })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  assert.deepEqual(calls.submitted, [{ mode: 'start', role: 'manager', tier: DEFAULT_TIER, effort: 'medium', message: 'Take the packaging work.', parentId: null, profileId: null }])
})

/* ---------- SET AND START, PERSON-CHOSEN (owner: "ITS SUPPOSED TO HAVE SET
   OR START AS OPTIONS") ---------- */

test('pressing Set hands the draft over with mode "set", the same fields Start would carry', () => {
  const { handle, calls } = open({ parent: { id: 'node-17' } })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'set').dispatch('click')

  assert.deepEqual(calls.submitted, [{ mode: 'set', role: 'manager', tier: DEFAULT_TIER, effort: 'medium', message: 'Take the packaging work.', parentId: 'node-17', profileId: null }])
  /* Set closes the panel exactly like Start does -- the caller decides what
     happens with the draft, this panel's job ends at handing it over either
     way. */
  assert.equal(handle.element(), null, 'a handed-over Set draft must close the panel, the same as Start')
})

test('Set carries its own label, never the Start wording, and both buttons say a real word', () => {
  const { handle } = open()
  assert.equal(actionNamed(handle, 'set').textContent, START_PANEL.submitSet)
  assert.equal(actionNamed(handle, 'start').textContent, START_PANEL.submitStart)
  assert.notEqual(START_PANEL.submitSet, START_PANEL.submitStart, 'the two options must read as two different presses')
})

test('the real action row is Set then Start with the layout QA classes and button semantics', () => {
  const { handle } = open()
  const actions = handle.element().find(node => String(node.className).includes('agent-compose-actions'))
  assert.deepEqual(actions.children.map(node => ({
    action: node.getAttribute('data-compose-action'),
    classes: node.className,
    type: node.type,
  })), [
    { action: 'set', classes: 'ctl-btn agent-compose-set', type: 'button' },
    { action: 'start', classes: 'ctl-btn agent-compose-start agent-compose-submit', type: 'button' },
  ])
})

test('a tier this computer cannot run yet blocks Start but never blocks Set', () => {
  const refusedTiers = tierChoicesFor(['luna'], ['codex'])
  const { handle, calls } = open({ tiers: refusedTiers })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })

  assert.equal(actionNamed(handle, 'start').disabled, true, 'Start must be disabled against a tier nothing can launch')
  assert.equal(actionNamed(handle, 'set').disabled, false, 'Set records a draft; it does not need this computer to be able to launch the tier right now')

  actionNamed(handle, 'set').dispatch('click')
  assert.equal(calls.submitted.length, 1, 'Set must still reach the caller even while the chosen tier is refused for launching')
  assert.equal(calls.submitted[0].mode, 'set')
  assert.equal(calls.submitted[0].tier, refusedTiers[0].id, 'the refused tier is still recorded honestly, for a later Start to judge on its own terms')
})

test('a caller unavailable reason disables both Set and Start, not only one', () => {
  const { handle } = open({ unavailableReason: START_REFUSAL.assistantProgramMissing })
  assert.equal(actionNamed(handle, 'set').disabled, true)
  assert.equal(actionNamed(handle, 'start').disabled, true)
})

test('a Start-only unavailable reason leaves Set and every field usable', () => {
  const reason = 'Starting an assistant is switched off for this computer.'
  const { handle, calls } = open({ startUnavailableReason: reason })

  assert.equal(noticeLine(handle).textContent, reason)
  assert.equal(actionNamed(handle, 'start').disabled, true)
  assert.equal(actionNamed(handle, 'set').disabled, false)
  for (const name of ['role', 'tier', 'effort', 'profile', 'message']) {
    assert.equal(fieldNamed(handle, name).disabled, false, `${name} was blocked by a Start-only reason`)
  }

  fill(handle, { role: 'manager', message: 'Keep this draft for later.' })
  actionNamed(handle, 'set').dispatch('click')
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.submitted[0].mode, 'set')
})

test('reopening can clear a Start-only reason', () => {
  const { handle } = open({ startUnavailableReason: 'Starting is unavailable.' })
  handle.open({ startUnavailableReason: '' })
  assert.equal(noticeLine(handle).textContent, '')
  assert.equal(actionNamed(handle, 'start').disabled, false)
  assert.equal(actionNamed(handle, 'set').disabled, false)
})

/* ---------- handing the draft back ---------- */

test('a complete draft is handed to the caller as role, message and parent', () => {
  const { handle, calls } = open({ parent: { id: 'node-17' } })
  fill(handle, { role: 'shadow', message: '  Watch the release branch.\nReport twice a day.  ' })
  actionNamed(handle, 'start').dispatch('click')

  assert.deepEqual(calls.submitted, [{
    mode: 'start',
    role: 'shadow',
    /* The tier the person did not touch is the default, stated -- never absent.
       An absent tier would make the model choice fall to whatever the engine
       happens to be set to, silently, which is the pre-4204332 defect. */
    tier: DEFAULT_TIER,
    effort: 'medium',
    // Trimmed at the ends and nowhere else: the line break is the person's.
    message: 'Watch the release branch.\nReport twice a day.',
    parentId: 'node-17',
    /* A start UNDER an existing agent draws no folder menu -- that tree already
       has a folder, and one nested start must not re-point it. Null here is
       that absence, and it is the same null the caller has always sent. */
    profileId: null,
  }])
})

test('a picked model rides in the draft, Claude rows included', () => {
  /* The three Claude rows are offered so a chosen model can never quietly
     become Codex; the shell refuses them by name (AGENT_TIER_NO_LAUNCHER) and
     the refusal only exists if the picked id actually reaches the draft. */
  const { handle, calls } = open({
    parent: { id: 'node-17' },
    tiers: tierChoicesFor(['luna', 'terra', 'sol', 'claude-fable']),
  })
  fill(handle, { role: 'manager', tier: 'claude-fable', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  assert.deepEqual(calls.submitted, [{ mode: 'start', role: 'manager', tier: 'claude-fable', effort: 'medium', message: 'Take the packaging work.', parentId: 'node-17', profileId: null }])
})

test('the model menu preselects the default and offers the six tiers by label', () => {
  const { handle } = open()
  const menu = fieldNamed(handle, 'tier')
  assert.equal(menu.value, DEFAULT_TIER)
  const options = menu.children
  assert.deepEqual(options.map(option => option.value), TIER_CHOICES.map(choice => choice.id))
  assert.deepEqual(options.map(option => option.textContent), TIER_CHOICES.map(choice => choice.label))
})

test('a complete draft closes the panel, so the same work cannot be handed over twice', () => {
  const { handle, container } = open({ parent: { id: 'node-17' } })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  assert.equal(handle.element(), null)
  assert.equal(container.children.length, 0)
})

test('re-opening over another node starts from an empty draft', () => {
  const { handle, calls } = open({ parent: { id: 'node-17' } })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })

  handle.open({ parent: { id: 'node-18' } })
  /* Empty means unanswered questions are unanswered again; the model question
     arrives answered by the product default, so the default IS its empty. */
  assert.deepEqual(handle.draft(), { mode: undefined, role: '', tier: DEFAULT_TIER, effort: 'medium', message: '', parentId: 'node-18', profileId: null })

  fill(handle, { role: 'helper', message: 'Second brief.' })
  actionNamed(handle, 'start').dispatch('click')
  assert.deepEqual(calls.submitted, [{ mode: 'start', role: 'helper', tier: DEFAULT_TIER, effort: 'medium', message: 'Second brief.', parentId: 'node-18', profileId: null }])
})

/* ---------- refusing an incomplete draft ---------- */

/* OWNER, 2026-08-19: "users shouldnt be forced to choose a role."
 *
 * This test is the inversion of the one that stood here, and the inversion is
 * the point: the panel used to refuse a draft with no role and now hands it
 * over. WHAT MAKES THAT SAFE is traced rather than assumed: fleet-trees.js
 * stores the honest empty string, and computers.js sends no roleBinding for an
 * empty role. A chosen role now binds its authoritative saved directions, but
 * choosing none still changes nothing about the session, engine, confinement,
 * or permission level. */
test('an empty role is handed over rather than refused, and nothing else is accused', () => {
  const { handle, calls } = open()
  fill(handle, { role: '', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  assert.deepEqual(calls.submitted, [{
    mode: 'start',
    role: '',
    tier: DEFAULT_TIER,
    effort: 'medium',
    message: 'Take the packaging work.',
    parentId: null,
    profileId: null,
  }], 'the draft is handed over carrying no role, which is an answer and not a gap')
  /* A handover the caller accepted closes the panel, which is the same ending a
     draft WITH a role has always had. Nothing is left standing to be refused. */
  assert.equal(handle.element(), null, 'the panel is still open, so the press was refused after all')
})

test('the role menu is still offered first and still opens on nothing', () => {
  /* Optional is not hidden (and not demoted). The menu keeps its place at the
     top of the form, keeps every role on it, and still opens with none chosen
     -- a pre-picked role would answer the panel's question for the person, and
     that reasoning survived the refusal being removed. */
  const { handle } = open()
  const roleOptions = fieldNamed(handle, 'role').children

  assert.equal(roleOptions[0].value, '')
  assert.equal(roleOptions[0].textContent, START_PANEL.rolePrompt)
  assert.equal(fieldNamed(handle, 'role').value, '')
  assert.equal(roleOptions.length, ROLE_CHOICES.length + 1)
  /* The row a person leaves alone must not read as an instruction to do
     something the panel no longer requires. */
  assert.doesNotMatch(START_PANEL.rolePrompt, /choose|pick|select/i)
})

test('a role on the offered list survives draft normalization', () => {
  assert.equal(
    composeDraftRole('manager', ROLE_CHOICES),
    'manager',
    'a valid selection was dropped from the draft',
  )
})

test('an empty message is refused by its own sentence', () => {
  const { handle, calls } = open()
  fill(handle, { role: 'manager', message: '   \n  ' })
  actionNamed(handle, 'start').dispatch('click')

  assert.deepEqual(calls.submitted, [])
  assert.equal(problemFor(handle, 'message').textContent, START_PANEL.needMessage)
  assert.equal(fieldNamed(handle, 'role').getAttribute('aria-invalid'), null, 'a role that was chosen must not be marked wrong by the brief’s refusal')
})

test('an empty panel is refused for the brief alone, and focus lands there', () => {
  const { doc, handle, calls } = open()
  actionNamed(handle, 'start').dispatch('click')

  assert.deepEqual(calls.submitted, [])
  assert.equal(problemFor(handle, 'message').textContent, START_PANEL.needMessage)
  /* Focus goes to the ONE thing a person has to fix. It used to land on the
     role menu, which is now already answered by its first row. */
  assert.equal(doc.activeElement, fieldNamed(handle, 'message'))
})

test('with only the message missing, focus goes to the message box', () => {
  const { doc, handle } = open()
  fill(handle, { role: 'manager', message: '' })
  actionNamed(handle, 'start').dispatch('click')

  assert.equal(doc.activeElement, fieldNamed(handle, 'message'))
})

/* A ROLE OFF THE MENU IS STILL NEVER HANDED ON, and dropping the refusal is
   what made that worth a function of its own. The old answer was to refuse the
   press; refusing is no longer available, and the wrong answer would be to let
   `admiral` through to the store, where roleLabel() has no word for it and
   every surface would print the product's fallback over a key somebody set from
   outside the menu. So the panel resolves the draft's role to the roles it
   actually offers, and anything else resolves to NO role -- the same honest
   absence a person gets by leaving the first row alone. In a real browser this
   is unreachable (a <select> assigned a value with no matching option reports
   ''), which is exactly why it is pinned by a unit test rather than a drive. */
test('a role that is not on the list resolves to no role rather than travelling', () => {
  assert.equal(composeDraftRole('admiral'), '')
  assert.equal(composeDraftRole('manager'), 'manager')
  assert.equal(composeDraftRole(''), '')
  assert.equal(composeDraftRole('  manager  '), 'manager')
  assert.equal(composeDraftRole('manager', ['helper']), '', 'a caller may narrow the list, and the narrowing is what counts')

  const { handle, calls } = open()
  fill(handle, { role: 'admiral', message: 'Do the thing.' })
  actionNamed(handle, 'start').dispatch('click')
  assert.deepEqual(calls.submitted.map(draft => draft.role), [''])
  assert.deepEqual(calls.submitted.map(draft => draft.message), ['Do the thing.'])
})

test('a complete draft has nothing to say about it', () => {
  assert.deepEqual(composeDraftProblems({ role: 'manager', message: 'Take the packaging work.' }), [])
})

test('editing a field clears the refusal about that field only', () => {
  const { handle } = open()
  actionNamed(handle, 'start').dispatch('click')
  assert.notEqual(problemFor(handle, 'message').textContent, '')

  /* Choosing a role is not an answer to the refusal about the BRIEF, and it
     must not clear it. */
  fieldNamed(handle, 'role').value = 'manager'
  fieldNamed(handle, 'role').dispatch('change')
  assert.equal(problemFor(handle, 'message').textContent, START_PANEL.needMessage, 'the message is still empty and still says so')

  fieldNamed(handle, 'message').value = 'Take the packaging work.'
  fieldNamed(handle, 'message').dispatch('input')
  assert.equal(problemFor(handle, 'message').textContent, '')
  assert.equal(fieldNamed(handle, 'message').getAttribute('aria-invalid'), null)
})

/* ---------- discarding the draft ---------- */

test('cancel discards the draft, takes the panel off the page and tells the caller', () => {
  const { handle, container, calls } = open({ parent: { id: 'node-17' } })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })

  actionNamed(handle, 'cancel').dispatch('click')

  assert.equal(calls.cancelled, 1)
  assert.equal(handle.element(), null)
  assert.equal(container.children.length, 0)

  handle.open({ parent: { id: 'node-17' } })
  assert.deepEqual(handle.draft(), { mode: undefined, role: '', tier: DEFAULT_TIER, effort: 'medium', message: '', parentId: 'node-17', profileId: null })
})

test('Escape from inside the panel discards the draft the same way', () => {
  const { handle, calls } = open()
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })

  // Pressed in the message box, handled on the root. A person typing a brief
  // must not have to go and find the Cancel button with the Tab key.
  fieldNamed(handle, 'message').dispatch('keydown', { key: 'Escape', preventDefault() {} })

  assert.equal(calls.cancelled, 1)
  assert.equal(handle.element(), null)
})

test('an ordinary key press is not a cancel', () => {
  const { handle, calls } = open()
  fieldNamed(handle, 'message').dispatch('keydown', { key: 'e', preventDefault() {} })

  assert.equal(calls.cancelled, 0)
  assert.notEqual(handle.element(), null)
})

/* THE MOUSE-OPEN ORDERING, measured dead on the packaged build 2026-08-20
 * (order-drive lane): press the empty tree slot with the MOUSE, press Escape --
 * the panel stayed standing, because the view moved focus into the panel only
 * for keyboard opens, so the key landed on the page body and never bubbled
 * through this root. The panel's own contract says Escape cancels; that has to
 * hold however the panel was opened. The fix is focus placement, and these two
 * tests pin the pieces this module owns: a root a browser will accept focus on,
 * a way to focus it without moving the caret into a field, and a focus() that
 * still lands INSIDE the panel when the form ships switched off (a disabled
 * select refuses focus, and focus left outside is Escape left dead). */

test('a pointer-opened panel can hear Escape: the root takes focus and cancels', () => {
  const { doc, handle, calls } = open()
  assert.equal(handle.element().getAttribute('tabindex'), '-1',
    'the root is not programmatically focusable; a real browser would bounce focus off it')
  handle.focusRoot()
  assert.equal(doc.activeElement, handle.element(), 'focusRoot() did not move focus to the panel root')
  doc.activeElement.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  assert.equal(calls.cancelled, 1)
  assert.equal(handle.element(), null)
})

test('focus() with the form switched off still lands inside the panel', () => {
  const { doc, handle } = open({ unavailableReason: 'Starting an assistant is switched off for this computer.' })
  assert.equal(fieldNamed(handle, 'role').disabled, true, 'this test is about the switched-off form')
  handle.focus()
  const inside = handle.element().find(node => node === doc.activeElement)
  assert.ok(inside, 'focus landed outside the panel; Escape would be dead there')
})

test('closing is not cancelling, so the caller is not told twice', () => {
  const { handle, calls } = open()
  handle.close()

  assert.equal(handle.element(), null)
  assert.equal(calls.cancelled, 0)
})

/* ---------- while the caller is starting, and when it fails ---------- */

function deferred() {
  let settle
  const promise = new Promise(resolve => { settle = resolve })
  return { promise, resolve: settle }
}

test('while the agent is starting, nothing can be pressed and the wait names the role', () => {
  const pending = deferred()
  const { handle, calls } = open({ answer: pending.promise })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  assert.equal(actionNamed(handle, 'start').disabled, true)
  assert.equal(actionNamed(handle, 'cancel').disabled, true, 'cancelling mid-start would discard a draft whose agent is already starting')
  assert.equal(fieldNamed(handle, 'message').disabled, true)
  assert.equal(fieldNamed(handle, 'effort').disabled, true)
  assert.equal(statusLine(handle).textContent, startingLine('manager'))

  actionNamed(handle, 'start').dispatch('click')
  assert.equal(calls.submitted.length, 1, 'a second press does not start the same agent twice')
})

test('a caller that refuses puts its own refusal sentence on the panel and keeps the draft', async () => {
  const pending = deferred()
  const { handle } = open({ answer: pending.promise })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  pending.resolve({ ok: false, message: START_REFUSAL.everyAgentBusy })
  await pending.promise

  assert.notEqual(handle.element(), null, 'the panel stays, because the person has to be able to try again')
  assert.equal(noticeLine(handle).textContent, START_REFUSAL.everyAgentBusy)
  assert.equal(noticeLine(handle).getAttribute('role'), 'alert')
  assert.equal(actionNamed(handle, 'start').disabled, false)
  assert.deepEqual(handle.draft(), { mode: undefined, role: 'manager', tier: DEFAULT_TIER, effort: 'medium', message: 'Take the packaging work.', parentId: null, profileId: null })
})

test('a refusal that arrives with no words still gets the flow’s sentence', async () => {
  const pending = deferred()
  const { handle } = open({ answer: pending.promise })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  pending.resolve({ ok: false })
  await pending.promise

  assert.equal(noticeLine(handle).textContent, START_REFUSAL.noReasonGiven)
})

test('a caller that throws is reported as a sentence, never as the error’s own words', async () => {
  const { handle } = open({ onSubmit: () => { throw new Error('ENOENT: agent runner is not a function') } })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')
  await Promise.resolve()

  assert.equal(noticeLine(handle).textContent, START_REFUSAL.noReasonGiven)
  assert.doesNotMatch(noticeLine(handle).textContent, /ENOENT/)
  assert.notEqual(handle.element(), null)
})

test('a promise that rejects says the same sentence and lets the person try again', async () => {
  const rejection = Promise.reject(new Error('the connection closed'))
  const { handle } = open({ answer: rejection })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')
  await rejection.catch(() => {})
  await Promise.resolve()

  assert.equal(noticeLine(handle).textContent, START_REFUSAL.noReasonGiven)
  assert.equal(actionNamed(handle, 'start').disabled, false)
})

test('with nothing wired to receive the draft, the person is told it is a fault and not their doing', () => {
  const { handle } = open({ onSubmit: null })

  assert.equal(noticeLine(handle).textContent, START_REFUSAL.notWired)
  assert.equal(actionNamed(handle, 'start').disabled, true)
  /* NOT the sentence for a start that failed. That one says "try once more",
     and pressing again against a panel with no receiver can never work -- a
     loop with no exit is the dead end this flow's copy exists to remove. */
  assert.notEqual(noticeLine(handle).textContent, START_REFUSAL.noReasonGiven)
  assert.doesNotMatch(noticeLine(handle).textContent, /Try once more/)
})

test('the first row is a real answer now, and its own words are still not a role', () => {
  const { handle, calls } = open()
  // Leaving the first row alone is a way THROUGH, not a way past a refusal.
  fill(handle, { role: '', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  assert.deepEqual(calls.submitted.map(draft => draft.role), [''])
  // The row's own words are copy, not a role key: a caller that echoed them
  // back would still be handing over something no role list contains.
  assert.equal(composeDraftRole(START_PANEL.rolePrompt), '', 'the row’s own words are not a role either')
  assert.deepEqual(composeDraftProblems({ role: START_PANEL.rolePrompt, message: 'x' }), [])
})

test('a caller may report a failure later, through the handle', () => {
  const { handle } = open()
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })

  handle.showProblem(START_REFUSAL.enginePartMissing)

  assert.equal(noticeLine(handle).textContent, START_REFUSAL.enginePartMissing)
  assert.equal(noticeLine(handle).getAttribute('role'), 'alert')
})

test('a failure reported through the handle is not undone by a late success', async () => {
  const pending = deferred()
  const { handle } = open({ answer: pending.promise })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  handle.showProblem(START_REFUSAL.everyAgentBusy)
  pending.resolve(undefined)
  await pending.promise

  // The panel closing out from under a failure the person is reading is the
  // worst version of this: they see the words, then the form vanishes.
  assert.notEqual(handle.element(), null)
  assert.equal(noticeLine(handle).textContent, START_REFUSAL.everyAgentBusy)
})

test('a late answer about a node the person has moved on from is dropped', async () => {
  const pending = deferred()
  const { handle } = open({ parent: { id: 'node-17' }, answer: pending.promise })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')

  handle.open({ parent: { id: 'node-18' } })
  pending.resolve({ ok: false, message: START_REFUSAL.everyAgentBusy })
  await pending.promise

  // A refusal about the previous node, painted onto a panel the person has
  // since opened over a different one, is a sentence about the wrong tree.
  assert.equal(noticeLine(handle).textContent, '')
  assert.deepEqual(handle.draft(), { mode: undefined, role: '', tier: DEFAULT_TIER, effort: 'medium', message: '', parentId: 'node-18', profileId: null })
})

test('late readiness answers retain the typed brief, chosen controls and focus', () => {
  const { handle, doc } = open({ folders: [{ id: 'work-a', name: 'First' }, { id: 'work-b', name: 'Second' }] })
  const text = '  Keep this draft exactly.\nThe person is still typing. '
  fill(handle, { role: 'manager', tier: 'terra', message: text })
  fieldNamed(handle, 'effort').value = 'high'
  fieldNamed(handle, 'profile').value = 'work-b'
  fieldNamed(handle, 'message').focus()
  handle.open({ tiers: tierChoicesFor(['luna', 'terra']) })
  handle.open({ confinementLine: UNKNOWN_CONFINEMENT })
  assert.equal(fieldNamed(handle, 'message').value, text)
  assert.equal(doc.activeElement, fieldNamed(handle, 'message'))
  assert.deepEqual(handle.draft(), { mode: undefined, role: 'manager', tier: 'terra', effort: 'high',
    message: text.trim(), parentId: null, profileId: 'work-b' })
})

test('readiness changes keep the brief but cannot retain choices removed from the menus', () => {
  const { handle } = open({ folders: [{ id: 'work-a', name: 'First' }] })
  fill(handle, { role: 'manager', tier: 'terra', message: 'Keep my work.' })
  fieldNamed(handle, 'profile').value = 'work-a'
  handle.open({ roles: ['helper'], tiers: tierChoicesFor(['luna']).filter(t => t.id === 'luna'), folders: [] })
  assert.equal(handle.draft().role, '')
  assert.equal(handle.draft().tier, 'luna')
  assert.equal(handle.draft().profileId, null)
  assert.equal(handle.draft().message, 'Keep my work.')
})

test('a readiness repaint during a start keeps it busy and receives its eventual answer', async () => {
  const pending = deferred()
  const { handle, calls } = open({ answer: pending.promise })
  fill(handle, { role: 'worker', message: 'One start only.' })
  actionNamed(handle, 'start').dispatch('click')
  handle.open({ tiers: TIER_CHOICES })
  assert.equal(actionNamed(handle, 'start').disabled, true)
  assert.equal(actionNamed(handle, 'set').disabled, true)
  actionNamed(handle, 'start').dispatch('click')
  assert.equal(calls.submitted.length, 1)
  pending.resolve({ ok: false, message: START_REFUSAL.everyAgentBusy })
  await pending.promise
  assert.equal(noticeLine(handle).textContent, START_REFUSAL.everyAgentBusy)
  assert.equal(actionNamed(handle, 'start').disabled, false)
  assert.equal(handle.draft().message, 'One start only.')
})

/* ---------- stated absences ---------- */

test('a caller’s reason switches the fields off, keeps cancel live, and refuses to submit', () => {
  const { handle, calls } = open({ unavailableReason: START_REFUSAL.assistantProgramMissing })

  assert.equal(noticeLine(handle).textContent, START_REFUSAL.assistantProgramMissing)
  assert.equal(actionNamed(handle, 'start').disabled, true)
  assert.equal(fieldNamed(handle, 'role').disabled, true)
  assert.equal(fieldNamed(handle, 'tier').disabled, true)
  assert.equal(fieldNamed(handle, 'effort').disabled, true)
  assert.equal(fieldNamed(handle, 'profile').disabled, true)
  assert.equal(actionNamed(handle, 'cancel').disabled, false, 'a panel a person cannot close is worse than the refusal')

  actionNamed(handle, 'start').dispatch('click')
  assert.deepEqual(calls.submitted, [])

  actionNamed(handle, 'cancel').dispatch('click')
  assert.equal(calls.cancelled, 1)
})

test('a reason that has cleared lets the panel work again', () => {
  const { handle } = open({ unavailableReason: START_REFUSAL.assistantProgramMissing })
  handle.open({ unavailableReason: '' })

  assert.equal(noticeLine(handle).textContent, '')
  assert.equal(actionNamed(handle, 'start').disabled, false)
  assert.equal(fieldNamed(handle, 'role').disabled, false)
})

/* ---------- it is a component, and it can be worked with a keyboard ---------- */

test('every field is a real control with its own label bound by id', () => {
  const { handle } = open()
  const labels = handle.element().findAll(node => node.tagName === 'LABEL')

  for (const name of ['role', 'message']) {
    const field = fieldNamed(handle, name)
    const id = field.getAttribute('id')
    assert.ok(id, `${name} has no id, so no label can point at it`)
    const label = labels.find(entry => entry.getAttribute('for') === id)
    assert.ok(label, `${name} has no label bound to it`)
    assert.notEqual(label.textContent.trim(), '', `${name} has an empty label`)
  }

  /* THE BRIEF IS THE ONLY FIELD THAT CAN BE REFUSED, so it is the only one
     whose description carries a refusal line. A screen reader reads the problem
     when focus lands on the field that has it. The role menu names its hint
     alone -- pointing it at a problem element that can never be filled would be
     describing a field by a sentence nothing will ever write. */
  const message = fieldNamed(handle, 'message')
  const messageId = message.getAttribute('id')
  assert.equal(message.getAttribute('aria-describedby'), `${messageId}-hint ${messageId}-problem`)
  assert.equal(problemFor(handle, 'message').getAttribute('id'), `${messageId}-problem`)
  assert.equal(problemFor(handle, 'message').getAttribute('role'), 'alert')

  const role = fieldNamed(handle, 'role')
  assert.equal(role.getAttribute('aria-describedby'), `${role.getAttribute('id')}-hint`)
  assert.equal(problemFor(handle, 'role'), null)

  assert.equal(fieldNamed(handle, 'role').tagName, 'SELECT')
  assert.equal(fieldNamed(handle, 'message').tagName, 'TEXTAREA')
  for (const name of ['set', 'start', 'cancel']) {
    const button = actionNamed(handle, name)
    assert.equal(button.tagName, 'BUTTON', `${name} must be a button, not a div wearing a click handler`)
    assert.equal(button.getAttribute('type'), 'button')
    assert.notEqual(button.textContent.trim(), '')
  }
})

/* ---------- the tips went behind hover; the facts did not -----------------
 *
 * Owner, 2026-08-19, on this panel for the second time: "pg 2 right pnel STILL
 * reads ugly and messy. Make some of the tips only show on hover ... so it
 * isnt so messy".
 *
 * THE LINE THESE TESTS DEFEND is not "fewer paragraphs". It is which paragraph
 * is allowed to go: text that EXPLAINS a control may hide, text that states a
 * FACT about this computer may not. Hiding a warning behind a gesture would
 * undo the honesty work this whole panel is made of, and it is exactly the
 * mistake a later "tidy it up further" pass would make -- so the classification
 * is pinned here rather than described in a commit message nobody re-reads.
 *
 * WHAT THESE PROVE AND WHAT THEY CANNOT. They prove the DOM contract: which
 * elements are marked as tips, which are not, and that a hidden tip is still in
 * the page and still named by its field's description so a screen reader is
 * unaffected. They cannot prove a pointer can summon one -- opacity, hover and
 * the 1s delay live in src/agent-compose-panel.css and are proven by driving a
 * real window with a real mouse.
 * ------------------------------------------------------------------------- */

const tipped = handle => handle.element()
  .findAll(node => node.getAttribute('data-compose-tip') === 'hover')
const markedLabels = handle => handle.element()
  .findAll(node => node.className === 'tip-mark')

test('the five field hints are the only things behind hover, and they are all tips', () => {
  const { handle } = open({ folders: [{ id: 'f1', name: 'Work' }] })
  const behindHover = tipped(handle).map(node => node.textContent)

  assert.deepEqual(behindHover.sort(), [
    START_PANEL.effortHelp,
    START_PANEL.folderHelp,
    START_PANEL.messageHelp,
    START_PANEL.roleHelp,
    START_PANEL.tierHelp,
  ].sort(), 'the set of hidden sentences changed; every one of them must be text that EXPLAINS a control')

  // Each one is offered rather than merely gone: its label carries the mark.
  assert.equal(markedLabels(handle).length, behindHover.length)
  for (const mark of markedLabels(handle)) {
    assert.equal(mark.textContent, START_PANEL.tipMark)
    assert.equal(mark.getAttribute('aria-hidden'), 'true', 'the mark is decoration, and a screen reader must not read it as a control')
  }
})

test('a hidden tip is still in the page and still describes its own field', () => {
  /* THE HALF THAT IS NOT VISUAL. These paragraphs are named by
     aria-describedby, so a screen reader reads them when focus lands on the
     field -- exactly as it did before they were hidden. If a later pass ever
     reaches for `display: none` or `visibility: hidden` the sentence leaves the
     accessibility tree too, and this is what says so out loud. */
  const { handle } = open()
  for (const name of ['role', 'tier', 'effort', 'message']) {
    const field = fieldNamed(handle, name)
    const hintId = `${field.getAttribute('id')}-hint`
    const hint = handle.element().find(node => node.getAttribute('id') === hintId)
    assert.ok(hint, `${name} has no hint element, so its description points at nothing`)
    assert.equal(hint.getAttribute('data-compose-tip'), 'hover')
    assert.notEqual(hint.textContent.trim(), '', `${name}'s tip was emptied instead of hidden`)
    assert.ok(String(field.getAttribute('aria-describedby')).includes(hintId),
      `${name} no longer names its own explanation, so a screen reader lost it`)
    assert.ok(hint.getAttribute('hidden') === null, 'a hidden attribute takes it out of the accessibility tree too')
  }
})

test('every sentence that states a fact about this computer stays on the page', () => {
  /* THE ONE THAT MUST NOT REGRESS. Each of these is a fact rather than a
     lesson: a stated absence, a refusal, what a session would be allowed to do,
     what is happening right now. None of them may be behind a gesture. */
  const { handle } = open({
    unavailableReason: START_REFUSAL.assistantProgramMissing,
    confinementLine: startControlLine({ ok: true, level: 'recommended' }),
  })
  const facts = [
    noticeLine(handle),
    confinementLineOf(handle),
    statusLine(handle),
    problemFor(handle, 'message'),
  ]
  for (const element of facts) {
    assert.ok(element, 'a fact-bearing line is missing from the panel entirely')
    assert.equal(element.getAttribute('data-compose-tip'), null,
      `this line states something about THIS computer and was put behind hover: ${element.textContent}`)
    assert.ok(!String(element.className).includes('tip-box'),
      `this line states something about THIS computer and was given the tip treatment: ${element.textContent}`)
  }

  const under = open({ parent: { id: 'node-17', name: PRESSED_NODE_NAME } }).handle
    .element().find(node => node.getAttribute('data-compose-under') === 'parent')
  assert.equal(under.getAttribute('data-compose-tip'), null, 'where this agent is going is a fact about the press, not a lesson')
})

test('the folder line hides only while it is help, and never while it is an empty state', () => {
  /* ONE ELEMENT, TWO KINDS OF SENTENCE. With named folders it explains the
     menu. With none it says none exist and names where a start would really
     land -- an honest empty state, and an empty state a person must hover to
     find is one that is not being told. */
  const withFolders = open({ folders: [{ id: 'f1', name: 'Work' }] }).handle
  const folderHint = handle => handle.element().find(node => node.getAttribute('id')?.endsWith('-folder-hint'))
  assert.equal(folderHint(withFolders).textContent, START_PANEL.folderHelp)
  assert.equal(folderHint(withFolders).getAttribute('data-compose-tip'), 'hover')

  const noFolders = open({ folders: [] }).handle
  assert.equal(folderHint(noFolders).textContent, START_PANEL.folderNone)
  assert.equal(folderHint(noFolders).getAttribute('data-compose-tip'), null,
    'the empty state was put behind hover, so nobody is told there are no folders')
  assert.ok(!String(folderHint(noFolders).className).includes('tip-box'))

  const setupFolder = open({ folders: [], defaultFolder: 'C:\\Work' }).handle
  assert.equal(folderHint(setupFolder).textContent, START_PANEL.folderNoneChosen('C:\\Work'))
  assert.equal(folderHint(setupFolder).getAttribute('data-compose-tip'), null,
    'where a start would actually land was put behind hover')
})

test('a press on a tipped label holds its tip open, and a second press puts it away', () => {
  /* THE THIRD REVEAL, and the only one a finger has. Both press-throughs
     (2026-08-27) measured the four "?" marks answering nothing on the exact
     panel a new person reads first: the preview ships every field disabled,
     hover was suppressed for disabled forms, focus cannot land on a disabled
     control, and touch has no hover at all. The label now toggles `tip-open`
     on its field; the CSS pins below hold the class's reveal rule and the
     death of the disabled suppression. Asserted on a DISABLED panel on
     purpose — that is where all the other reveals are dead. */
  const { handle } = open({ unavailableReason: START_REFUSAL.assistantProgramMissing })
  for (const name of ['role', 'tier', 'effort', 'message']) {
    const control = fieldNamed(handle, name)
    assert.equal(control.disabled, true, `${name} must be disabled under a panel-wide refusal for this test to mean anything`)
    const field = control.parentNode
    const label = field.children.find(child => child.tagName === 'LABEL')
    assert.ok(label, `${name} has no label to press`)
    label.dispatch('click')
    assert.ok(String(field.className).split(/\s+/).includes('tip-open'),
      `${name}: pressing the label did not open its tip`)
    label.dispatch('click')
    assert.ok(!String(field.className).split(/\s+/).includes('tip-open'),
      `${name}: a second press did not put the tip away`)
    assert.ok(String(field.className).includes('agent-compose-field'),
      `${name}: the toggle destroyed the field's own class`)
  }
})

test('the stylesheet reveals a pressed tip and no longer suppresses tips on disabled forms', () => {
  /* The CSS half of the press reveal, pinned by source because the fake DOM
     computes no styles. Three facts: the press class reveals; the hover reveal
     survives; the `:disabled` suppression — the rule that made the marks dead
     exactly where they are read first — stays gone. */
  const sheet = readFileSync(path.resolve(path.dirname(MODULE_PATH), 'agent-compose-panel.css'), 'utf8')
  assert.match(sheet, /\.agent-compose-field\.tip-open > \.agent-compose-hint\.tip-box \{[^}]*opacity:\s*1/,
    'the press-reveal rule is gone; the label toggles a class no stylesheet reads')
  assert.match(sheet, /\.agent-compose-field > \.cl:hover ~ \.agent-compose-hint\.tip-box/,
    'the hover reveal is gone')
  assert.doesNotMatch(sheet, /:disabled ~ \.agent-compose-hint\.tip-box/,
    'the disabled-form suppression is back; on the preview every field is disabled, so this makes the marks dead again')
})

test('a tipped hint comes after its control, because the reveal is a sibling rule', () => {
  /* NOT COSMETIC. src/agent-compose-panel.css reveals a tip with
     `.cl:hover ~ .agent-compose-hint` and `select:focus-visible ~ ...`, and a
     sibling combinator only reaches LATER siblings. Move the hint back above
     the control and the tip becomes unreachable by pointer AND by keyboard,
     with every unit test still green -- which is exactly the kind of silent
     break this assertion exists to stop. */
  const { handle } = open()
  for (const name of ['role', 'tier', 'effort', 'message']) {
    const field = fieldNamed(handle, name).parentNode
    const order = field.children.map(child => child.getAttribute('data-compose-field')
      || child.getAttribute('data-compose-tip')
      || child.tagName)
    const control = order.indexOf(name)
    const hint = order.indexOf('hover')
    assert.ok(control !== -1 && hint !== -1, `${name}: control or hint missing from the field`)
    assert.ok(hint > control, `${name}: the hint sits before its control, so no sibling rule can reveal it`)
  }
})

test('the panel is named for a screen reader by its own title', () => {
  const { handle } = open()
  const root = handle.element()
  const titleId = root.getAttribute('aria-labelledby')

  assert.ok(titleId)
  assert.equal(root.find(node => node.getAttribute('id') === titleId).textContent, START_PANEL.title)
})

test('two panels on one page do not share an id', () => {
  const first = open()
  const second = open()

  assert.notEqual(
    fieldNamed(first.handle, 'role').getAttribute('id'),
    fieldNamed(second.handle, 'role').getAttribute('id'),
  )
})

test('focus can be handed to the panel by a caller that opened it from a key press', () => {
  const { doc, handle } = open()
  handle.focus()

  assert.equal(doc.activeElement, fieldNamed(handle, 'role'))
})

test('destroy takes it off the page for good', () => {
  const { handle, container } = open()
  handle.destroy()

  assert.equal(container.children.length, 0)
  assert.equal(handle.open({ parent: null }), null, 'a destroyed panel does not come back')
})

test('with nowhere to mount, it builds nothing rather than choosing a page for itself', () => {
  assert.equal(mountAgentComposePanel({ doc: new FakeDocument(), container: null }), null)
  assert.equal(mountAgentComposePanel({ doc: null, container: {} }), null)
})

test('it is a pure component: no window, no starting, nothing outside the document it was given', () => {
  // The suite itself is the proof that it runs with no browser globals at all.
  assert.equal(typeof globalThis.window, 'undefined')
  assert.equal(typeof globalThis.document, 'undefined')

  // Comments blanked first. The header NAMES the things this panel must not
  // reach, so a scan over raw source would find the promise and call it the
  // breach -- the same trap tools/lib/user-visible-strings.mjs exists to avoid.
  const code = withoutComments(readFileSync(MODULE_PATH, 'utf8'))
  for (const forbidden of ['mcAgent', 'ipcRenderer', 'localStorage', 'globalThis.window', 'fetch(']) {
    assert.ok(!code.includes(forbidden), `${forbidden} has no business in this panel`)
  }
})

/* ---------- the fold ---------- */

test('the form scrolls, so Start can always be reached', () => {
  /* Owner, verbatim: "I also cant scroll down to even press start." The rail
     clips (`.rail { overflow: hidden }`) and its pages are absolutely
     positioned, so this panel can never make the rail taller — it can only
     overflow and be cut off. Twice now the answer was to buy pixels back by
     deleting content (a heading, once), and the next field spent them. The
     fix that cannot be spent is a scroller, and the class is the one every
     other rail page already scrolls with. */
  const { handle } = open()
  const body = handle.element().find(node => node.getAttribute('data-compose-body') === 'form')
  assert.ok(body, 'the panel body is gone; the form is unscrollable again')
  assert.ok(String(body.className).includes('rail-scroll'),
    'the panel body lost .rail-scroll — the class that carries flex:1, min-height:0 and overflow-y:auto')
  /* START IS PINNED BESIDE THE SCROLLER, AND BOTH FAILURES ARE PINNED HERE.
     This assertion used to demand the opposite -- that Start live INSIDE the
     scroller -- because the earlier defect was a panel that overflowed the
     clipping rail and cut the button off. Putting it in the scroller fixed
     reachability and lost VISIBILITY: measured on installed 1.0.21, the form
     wants ~765px against a rail of 560-700, so Start began ~100px below the
     fold and the owner reported, again, "there is no way to start an agent".
     A control that is off-screen at first paint is absent to the person
     looking at it.
     Beside the scroller is safe precisely because of the two rules asserted
     below: the root is a bounded flex column, so a `flex: none` row after a
     `flex: 1; min-height: 0` scroller is laid out inside the rail rather than
     past it. Keep all four assertions together -- each one alone permits one
     of the two defects. */
  const submit = actionNamed(handle, 'start')
  assert.ok(submit, 'the Start button vanished')
  assert.ok(!body.find(node => node === submit),
    'Start went back inside the scroller, which is how it fell below the fold and read as missing')
  assert.ok(handle.element().find(node => node === submit),
    'Start left the panel entirely')
  const css = readFileSync(path.resolve(path.dirname(MODULE_PATH), 'agent-compose-panel.css'), 'utf8')
  const rootRule = css.slice(css.indexOf('.agent-compose {'), css.indexOf('.agent-compose {') + 400)
  assert.match(rootRule, /flex-direction: column/, 'the panel root stopped being a column; the body cannot own the scroll')
  assert.match(rootRule, /min-height: 0/, 'the panel root lost min-height:0 and will push its body past the clip')
  /* The pinned row is only safe while it refuses to be squeezed: without
     `flex: none` a tall form pushes it back off the bottom of the rail. */
  const actionsRule = css.slice(css.indexOf('.agent-compose-actions {'), css.indexOf('.agent-compose-actions {') + 300)
  assert.match(actionsRule, /flex: none/, 'the action row can be squeezed again; Start returns to below the fold')
  assert.ok(!/\.agent-compose-text \{[^}]*resize: vertical/s.test(css),
    'the message box can be dragged taller again, which only deepens the clip')
})

/* WHAT THE PANEL IS MADE OF, IN ORDER, so a later lane cannot be helpful with
   it. Each row is named by the attribute or class the panel already carries --
   nothing is added to the module to make this readable. */
const panelRows = handle => handle.element().children.map(child => {
  if (String(child.className).includes('rail-title-row')) return 'nav'
  if (child.getAttribute('data-compose-body') === 'form') return 'body'
  if (String(child.className).includes('agent-compose-actions')) return 'actions'
  if (child.getAttribute('data-compose-confinement') === 'panel') return 'confinement'
  if (child.getAttribute('data-compose-status') === 'panel') return 'status'
  return `unnamed:${child.className || child.tagName.toLowerCase()}`
})

test('the order is the form, then Start, then what the session may do, then progress', () => {
  /* THE WARNING GOES UNDER START AND NOWHERE ELSE, and this assertion is the
     only thing standing between that order and the next lane that reads the
     confinement sentence, thinks "this belongs above the button" and moves it.
     Owner-reported TWICE: a block placed ahead of Start pushes Start down by
     exactly its own height and back below the fold, which is the defect the
     comments above the action row in src/agent-compose-panel.js record. Under
     the button, Start does not move at all, and the sentence is still outside
     the scroller so it cannot be scrolled away from the control it describes.
     Pinned as the WHOLE tail rather than as a pair of comparisons, because a
     new block quietly inserted between Start and the sentence is the same
     defect wearing a different hat. */
  for (const parent of [null, { id: 'node-17', name: PRESSED_NODE_NAME }]) {
    const { handle } = open({ parent })
    assert.deepEqual(panelRows(handle), ['nav', 'body', 'actions', 'confinement', 'status'],
      'the panel’s children moved; Start is only safe while it comes before the confinement line and after the form')
  }
})

test('a panel opening brings itself into view, and a re-render of an open one does not', async () => {
  /* THE PANEL CAN OPEN BELOW THE FOLD, and on a phone it always does: the
     computers page stacks under 1024, the rail sits beneath the tree canvas,
     and a press on an empty node builds this form several hundred pixels down
     a page nobody has scrolled. So it asks to be brought into view.
     THE HAZARD IS THE SECOND CALL. open() is how the shell answers every
     question this panel asked -- the startable engines, the folders, the line
     about what the session may do -- and each answer re-renders the whole
     form. Scrolling on those would yank the page out from under somebody
     half-way through reading it, which is worse than the defect being fixed. */
  const { doc, handle } = open({ parent: { id: 'node-17', name: PRESSED_NODE_NAME } })
  await Promise.resolve()
  assert.equal(doc.scrollCalls.length, 1, 'a panel that just opened did not ask to be shown')
  assert.equal(doc.scrollCalls[0].target, handle.element(), 'something other than the panel was scrolled to')
  /* `nearest` is the third guard and it is the browser's own: it does nothing
     when the element is already fully visible, which is every ordinary desktop
     window. Pinned as the option because a fake DOM has no viewport to prove
     the outcome with. */
  assert.deepEqual(doc.scrollCalls[0].options, { block: 'nearest', inline: 'nearest' })

  handle.open({ tiers: TIER_CHOICES })
  handle.open({ folders: [] })
  handle.open({ parent: { id: 'node-18' } })
  await Promise.resolve()
  assert.equal(doc.scrollCalls.length, 1,
    're-rendering an open panel scrolled the page; the shell answering a question is not the person opening anything')

  handle.close()
  handle.open({ parent: { id: 'node-19' } })
  await Promise.resolve()
  assert.equal(doc.scrollCalls.length, 2,
    'a panel that was closed and opened again did not bring itself into view')
})

test('at phone width the page is the only scroller, and the stylesheet says so', () => {
  /* A SOURCE PIN, STANDING IN FOR A BROWSER MEASUREMENT. What this is really
     about was measured by hand on the live site at 390x844: the rail is a fixed
     440px there, so the panel got a 201px window onto a ~399px form, Start was
     cut by the fold and the confinement sentence was entirely past it -- two
     scrollers, and the sentence about what the agent may do off screen at the
     moment the person presses the button. `node --test` has no layout engine
     and cannot re-measure any of that, so what it can hold is the rule: the
     narrow-width block exists, it is on the page's own breakpoint, and it says
     the four things that turn two scrollers into one. Reasoning is in the
     stylesheet's own comment above the block. */
  const css = readFileSync(path.resolve(path.dirname(MODULE_PATH), 'agent-compose-panel.css'), 'utf8')
  const start = css.indexOf('@media (max-width: 1023px)')
  assert.ok(start > -1,
    'the narrow-width block is gone, so the phone gets the desktop rail’s 440px again')
  const narrow = css.slice(start)
  assert.match(narrow, /\.computers \.rail-page\.compose-page\.is-active \{[^}]*position: relative/s,
    'the compose page went back out of flow, and an absolutely positioned page cannot make the rail taller')
  assert.match(narrow, /\.computers \.rail:has\(> \.rail-page\.compose-page\.is-active\) \{[^}]*align-self: start/s,
    'the rail is stretched to its 440px row again, so the panel is back inside a height it never asked for')
  assert.match(narrow, /\.computers \.rail-page\.compose-page \.agent-compose \{[^}]*flex: none/s,
    'the panel is dividing up a fixed height again instead of taking its own')
  const bodyRule = narrow.slice(narrow.indexOf('.agent-compose-body {'))
  assert.match(bodyRule, /flex: none/, 'the panel body is a flexible row again and will be squeezed')
  assert.match(bodyRule, /overflow-y: visible/, 'the second scroller is back')
  assert.match(bodyRule, /overflow-x: clip/,
    'without the sideways clip the visible y-axis computes back to auto and the second scroller returns anyway')

  /* AND THE DESKTOP RULES ARE UNTOUCHED. The panel's own scroller and its
     pinned Start bar were measured into place on a 1512x945 window; this fix
     is a narrow-width one and must stay one. */
  const desktop = css.slice(0, start)
  assert.match(desktop, /\.agent-compose-body \{[^}]*flex: 1 1 0%/s,
    'the desktop panel body lost its scroller, which is how Start fell below the fold on a real rail')
  assert.match(desktop, /\.agent-compose-body \{[^}]*overflow-y: auto/s,
    'the desktop panel body lost its scroller, which is how Start fell below the fold on a real rail')
  assert.ok(!/@media/.test(desktop), 'a media rule crept in above the narrow block; this pin no longer measures what it says')
})

/* ---------- the gate ---------- */

test('every string in this module passes the plain-language gate', () => {
  const source = readFileSync(MODULE_PATH, 'utf8')
  const extracted = visibleTextFrom(source)

  assert.ok(extracted.visible.length > 0, 'nothing was extracted, so nothing was measured')
  const findings = []
  for (const entry of extracted.visible) findings.push(...findingsInText(entry.text, entry.sourceLine))
  assert.deepEqual(findings, [], findings.map(finding => `${finding.rule}: ${finding.detail}`).join('\n'))
})

/* ------------------------------------------------------------------------
   WHICH ENGINES THE MENU SAYS IT CAN START, AND WHO DECIDES.

   The renderer used to decide this itself, from a frozen ['codex'] in
   src/fleet-tree-copy.js. The shell's tier gate now opens on the payload
   genuinely carrying an engine, so a build WITH the Claude engine would start a
   Claude tier while these rows went on saying it could not -- a menu
   contradicting the button, which is worse than either answer alone. These pin
   the renderer's whole half of that: believe the shell, and refuse to believe
   anything else.
   ------------------------------------------------------------------------ */

test('the menu believes the shell about which engines can start', () => {
  const rows = tierChoicesFor(startableTierIds({ ok: true, tiers: ['luna', 'terra', 'sol', 'claude-fable'] }))
  const claude = rows.find(row => row.id === 'claude-fable')
  const luna = rows.find(row => row.id === 'luna')
  const local = rows.find(row => row.id === 'local')
  assert.ok(claude, 'the Claude row vanished from the menu instead of being relabelled')
  assert.ok(!/cannot start/i.test(claude.label),
    `a tier the shell says it can start is still labelled unstartable: ${claude.label}`)
  assert.ok(!/cannot start/i.test(luna.label), luna.label)
  /* The one that proves it reads real launchers rather than provider names. */
  assert.ok(/cannot start/i.test(local.label),
    `local was not in the shell's list and must still say so: ${local.label}`)
})

test('the Start control follows the selected tier choice enabled state', () => {
  const { handle } = open({ tiers: tierChoicesFor(['terra']) })
  assert.equal(fieldNamed(handle, 'tier').value, 'terra',
    'mutation `omit enabled from a refused default choice` survived: expected the first startable tier to be selected')
  assert.equal(actionNamed(handle, 'start').disabled, false,
    'mutation `treat an enabled tier choice as refused` survived: expected Start to remain enabled for a startable tier')

  fieldNamed(handle, 'tier').value = 'luna'
  fieldNamed(handle, 'tier').dispatch('change')
  assert.equal(actionNamed(handle, 'start').disabled, true,
    'mutation `omit enabled from a refused choice` survived: expected Start to be disabled for an unstartable tier')
})

test('a shell that answers nothing leaves the menu exactly where it was', () => {
  /* Every one of these learned NOTHING about what this copy can start -- no
     bridge, no channel, a rejected call, a malformed reply, a tier table from
     some other product. None of them may widen the menu, and none of them may
     narrow it either: the fallback is this copy's complete default startable
     tier set, including Astra. */
  for (const reply of [null, undefined, {}, { ok: false }, { ok: true }, { ok: true, tiers: 'luna' },
    { ok: true, tiers: ['not-a-tier', 'also-not'] }]) {
    assert.deepEqual([...startableTierIds(reply)], [...TREE_DEFAULT_STARTABLE_TIERS],
      `an unusable reply changed the menu: ${JSON.stringify(reply)}`)
  }
})

test('an empty answer is an answer, and is not read as "everything starts"', () => {
  /* {ok:true, tiers:[]} means the shell resolved every tier and none can start.
     Falling back to the Codex three here would be the renderer overruling the
     shell on the one question it was asked, and would put "startable" under a
     row that refuses. */
  const rows = tierChoicesFor(startableTierIds({ ok: true, tiers: [] }))
  assert.ok(rows.every(row => /cannot start/i.test(row.label)),
    `an empty answer left some row claiming it can start: ${JSON.stringify(rows.map(row => row.label))}`)
})

/* ---- "EACH ROW SAYS SO IF THIS COPY CANNOT START IT" IS A GUARANTEE ---------
 *
 * START_PANEL.tierHelp promises it, and a person who reads it stops looking --
 * which is why a promise that is not kept is worse than no warning at all.
 *
 * startableTiers() answers only "does this payload carry a launcher":
 * shell/agent-host.cjs resolveStartTier() returns the row for any codex tier
 * unconditionally, so it structurally cannot see a missing sign-in -- and a
 * missing sign-in is exactly what refuses the press, as
 * AGENT_CONFINEMENT_SIGNED_OUT.
 *
 * MEASURED ON THE PACKAGED BUILD, cold install, one machine, one moment:
 *   presence: codex installed yes, signedIn "no" | startableTiers: luna,terra,sol
 *   rows drawn: "Luna · Codex"                   | press: "needs a Codex sign-in"
 * Re-read after the press (a completed round trip) -- identical. Same build with
 * presence flipped to "yes" -- byte-identical rows. So the rows were not a
 * function of it at all.
 * ------------------------------------------------------------------------- */

const ALL_START = ['luna', 'terra', 'sol', 'claude-fable', 'claude-sonnet', 'claude-opus']

test('a provider nobody is signed in to says so on its own rows', () => {
  const rows = tierChoicesFor(ALL_START, signedOutProviderIds({
    ok: true,
    providers: [{ id: 'codex', installed: 'yes', signedIn: 'no' },
      { id: 'claude', installed: 'yes', signedIn: 'unknown' }],
  }))
  for (const id of ['luna', 'terra', 'sol']) {
    assert.match(rows.find(row => row.id === id).label, /nobody is signed in to Codex/,
      `a Codex row stayed silent on a computer with no Codex sign-in: ${rows.find(row => row.id === id).label}`)
  }
  /* 'unknown' IS NEVER ROUNDED UP -- the same rule setup-review-readiness.js
     states. A Claude row must not acquire a warning from an "I could not tell". */
  for (const id of ['claude-fable', 'claude-sonnet', 'claude-opus']) {
    assert.ok(!/nobody is signed in/.test(rows.find(row => row.id === id).label),
      `an "unknown" sign-in reading was rounded up into a warning: ${rows.find(row => row.id === id).label}`)
  }
})

test('a signed-in computer draws exactly the rows it always drew', () => {
  /* THE DISCRIMINATING ARM, as a test. Without it the one above also passes on a
     build that simply warns on every row, which would be the same defect wearing
     the other sign. */
  const signedIn = tierChoicesFor(ALL_START, signedOutProviderIds({
    ok: true, providers: [{ id: 'codex', installed: 'yes', signedIn: 'yes' }],
  }))
  assert.deepEqual(signedIn.map(row => row.label), tierChoicesFor(ALL_START).map(row => row.label),
    'a working sign-in changed the menu, which means the warning is not about the sign-in')
  assert.ok(signedIn.every(row => !/nobody is signed in/.test(row.label)))
})

test('nothing learned about sign-in leaves the rows exactly where they were', () => {
  /* No bridge, a rejected call, a malformed reply, a provider row without the
     word: none of them may put a terminal command in front of somebody who is
     already signed in. The same discipline startableTierIds() applies. */
  const plain = tierChoicesFor(ALL_START).map(row => row.label)
  for (const reply of [null, undefined, {}, { ok: false }, { ok: true },
    { ok: true, providers: 'codex' }, { ok: true, providers: [{ id: 'codex', signedIn: 'unknown' }] },
    { ok: true, providers: [{ signedIn: 'no' }] }]) {
    assert.deepEqual([...signedOutProviderIds(reply)].length === 0 ? plain
      : tierChoicesFor(ALL_START, signedOutProviderIds(reply)).map(row => row.label), plain,
      `an unusable presence reply changed the menu: ${JSON.stringify(reply)}`)
  }
})

test('no launcher outranks no sign-in, because signing in would not fix it', () => {
  const rows = tierChoicesFor(['luna'], ['codex'])
  assert.match(rows.find(row => row.id === 'luna').label, /nobody is signed in to Codex/)
  assert.match(rows.find(row => row.id === 'terra').label, /cannot start from a tree yet/,
    'a row this copy carries no launcher for must not be told to sign in')
  assert.ok(!/nobody is signed in/.test(rows.find(row => row.id === 'terra').label))
})

test('the panel puts the sign-in warning on the glass, where the person reads it', () => {
  /* The rows are computed in the copy module and RENDERED here; a test of the
     first alone cannot see a panel that draws a list of its own. */
  const handed = tierChoicesFor(ALL_START, ['codex'])
  const { handle } = open({ tiers: handed })
  const labels = fieldNamed(handle, 'tier').children.map(option => option.textContent)
  assert.deepEqual(labels, handed.map(choice => choice.label))
  assert.ok(labels.some(label => /nobody is signed in to Codex/.test(label)),
    'the warning was computed and never reached the screen')
})

/* ---- AND THE MACHINE THAT NEVER HAD THE PROGRAM AT ALL ---------------------
 *
 * The warning above is right for a computer that HAS Codex and nobody signed
 * in. On a computer that never had it, the same warning is a dead end: `codex
 * login` is a SUBCOMMAND OF THE PROGRAM THAT IS MISSING, so a person who
 * follows it gets "'codex' is not recognized" -- which is, verbatim, what the
 * product's first external user hit on 1.0.20.
 *
 * IT IS NOT A HYPOTHETICAL SHAPE. shell/provider-cli-presence.cjs gives Codex
 * `signInProves: 'absence'`, so a machine with no Codex reports BOTH
 * installed:'no' AND signedIn:'no' -- the sign-in file cannot be there when the
 * program never was. Measured against the landed rows, that machine drew
 * "Luna · Codex — nobody is signed in to Codex on this computer" and said
 * nothing about installing anything.
 *
 * THE ORDER IS THE FIX, AND IT IS ALREADY THIS CODEBASE'S RULE.
 * codexCommandIsMissing() in shell/agent-host.cjs checks the program BEFORE the
 * sign-in and says why: "Reporting the CLI first yields the only sequence that
 * terminates: install, then sign in, each step true when it is shown." The row
 * now follows the same order as the refusal a press would give.
 * ------------------------------------------------------------------------- */

const NO_CODEX_AT_ALL = Object.freeze({
  ok: true,
  providers: Object.freeze([Object.freeze({ id: 'codex', installed: 'no', signedIn: 'no' })]),
})

test('a computer that never had the program is told to install it, not to sign in', () => {
  const rows = tierChoicesFor(ALL_START, signedOutProviderIds(NO_CODEX_AT_ALL),
    notInstalledProviderIds(NO_CODEX_AT_ALL))
  for (const id of ['luna', 'terra', 'sol']) {
    const label = rows.find(row => row.id === id).label
    assert.match(label, /Codex is not installed on this computer/, label)
    assert.ok(!/nobody is signed in/.test(label),
      `the row sent a person to a subcommand of a program that is not there: ${label}`)
  }
})

test('a program that IS installed still gets the sign-in sentence, not the install one', () => {
  /* The discriminating arm for the pair above: without it, "install" could be
     printed on every unstartable Codex row and this suite would not notice. */
  const installed = { ok: true, providers: [{ id: 'codex', installed: 'yes', signedIn: 'no' }] }
  const label = tierChoicesFor(ALL_START, signedOutProviderIds(installed),
    notInstalledProviderIds(installed)).find(row => row.id === 'luna').label
  assert.match(label, /nobody is signed in to Codex/, label)
  assert.ok(!/not installed/.test(label), label)
})

test('an install reading that proves nothing puts no install warning on a row', () => {
  /* 'unknown' means this copy could not read PATH, which is not the same as an
     empty PATH -- turning it into "you have not installed it" would tell a
     person to redo an install that worked. The rule presence() already states. */
  for (const reply of [null, undefined, {}, { ok: false }, { ok: true },
    { ok: true, providers: 'codex' }, { ok: true, providers: [{ id: 'codex', installed: 'unknown' }] },
    { ok: true, providers: [{ installed: 'no' }] }]) {
    const rows = tierChoicesFor(ALL_START, [], notInstalledProviderIds(reply))
    assert.deepEqual(rows.filter(row => /not installed/.test(row.label)).map(row => row.label), [],
      `an unusable presence reply claimed a program was missing: ${JSON.stringify(reply)}`)
  }
})

test('no launcher still outranks a missing program', () => {
  /* Installing Codex does not add a launcher to a build that carries none, so
     that row keeps the sentence about the thing an install would not fix. */
  const rows = tierChoicesFor(['luna'], [], ['codex'])
  assert.match(rows.find(row => row.id === 'luna').label, /Codex is not installed on this computer/)
  assert.match(rows.find(row => row.id === 'terra').label, /cannot start from a tree yet/)
  assert.ok(!/not installed/.test(rows.find(row => row.id === 'terra').label))
})

test('the compose panel renders the engine rows it is handed, not a list of its own', () => {
  const handed = tierChoicesFor(['luna', 'claude-opus'])
  const { handle } = open({ tiers: handed })
  const labels = fieldNamed(handle, 'tier').children.map(option => option.textContent)
  assert.deepEqual(labels, handed.map(choice => choice.label),
    'the panel drew its own tier list instead of the one it was given')
})

/* ---------------------------------------------------------------------------
 * THE FOLDER A TREE'S AGENTS WORK IN, ASKED WHERE THE TREE IS STARTED.
 *
 * Owner, 2026-08-16: "when a user starts a tree they should select a folder,
 * they can have a default folder, where the agents spawn". Owner again,
 * 2026-08-19, having gone looking for it: "what happened to sessions and
 * choosing a folder for each tree and such?" It existed only AFTER the fact, on
 * an existing tree's rail, 614px down a 3825px scroll (driven, packaged,
 * tools/rail-inventory-drive.mjs).
 * ------------------------------------------------------------------------- */

const FOLDERS = [{ id: 'p-1', name: 'Client work' }, { id: 'p-2', name: 'The website' }]

test('starting a TREE asks which folder its agents work in', () => {
  const { handle } = open({ folders: FOLDERS })
  const folder = fieldNamed(handle, 'profile')
  assert.ok(folder, 'a panel that would start a tree must ask for its folder')
  /* The first row is a real answer, not a prompt: before folders existed every
     tree ran in the product's own workspace, and that is still what it means. */
  assert.equal(folder.children[0].value, '', 'the first row must be the product’s own workspace, and must carry no id')
  assert.equal(folder.children[0].textContent, START_PANEL.folderWorkspace)
  assert.deepEqual(folder.children.slice(1).map(option => option.textContent), ['Client work', 'The website'],
    'the menu shows the NAMES a person gave their folders')
  assert.deepEqual(folder.children.slice(1).map(option => option.value), ['p-1', 'p-2'],
    'the id travels on the value, where only the program reads it')
})

test('a start UNDER an existing agent asks nothing, because that tree already has a folder', () => {
  /* The hazard this closes: a tree's folder is a property of the TREE. Offering
     the menu on a nested start would let one press silently re-point every
     agent in the tree, including ones already running. */
  const { handle } = open({ parent: { id: 'node-17', name: 'Manager' }, folders: FOLDERS })
  assert.equal(fieldNamed(handle, 'profile'), null, 'a nested start must not offer to change the tree’s folder')
})

test('the chosen folder rides in the draft, and an untouched menu means the product’s own workspace', () => {
  const { handle, calls } = open({ folders: FOLDERS })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')
  assert.equal(calls.submitted[0].profileId, null, 'an unanswered menu is the product’s own workspace, sent as null')

  const second = open({ folders: FOLDERS })
  fill(second.handle, { role: 'manager', message: 'Take the packaging work.' })
  fieldNamed(second.handle, 'profile').value = 'p-2'
  actionNamed(second.handle, 'start').dispatch('click')
  assert.equal(second.calls.submitted[0].profileId, 'p-2', 'the folder the person chose must reach the caller')
})

test('the menu opens on the folder this person used last', () => {
  const { handle } = open({ folders: FOLDERS, folderSelectedId: 'p-2' })
  assert.equal(fieldNamed(handle, 'profile').value, 'p-2', 'a remembered folder pre-fills the menu')
})

test('a remembered folder that no longer exists falls back, it does not point at nothing', () => {
  /* A person removes a profile between two starts. The id is remembered posture,
     not a promise, so it simply stops matching a row. */
  const { handle } = open({ folders: FOLDERS, folderSelectedId: 'p-gone' })
  assert.equal(fieldNamed(handle, 'profile').value, '', 'a folder that is gone leaves the product’s own workspace selected')
})

test('refreshing folder choices preserves an in-flight submit and its disabled controls', async () => {
  const pending = deferred()
  const { handle, calls } = open({ folders: FOLDERS, answer: pending.promise })
  fill(handle, { role: 'manager', message: 'Keep the pending start attached.' })
  fieldNamed(handle, 'profile').value = 'p-2'
  const root = handle.element()
  actionNamed(handle, 'start').dispatch('click')
  handle.updateFolders([...FOLDERS, { id: 'p-new', name: 'New folder' }])
  assert.equal(handle.element(), root)
  assert.equal(fieldNamed(handle, 'profile').value, 'p-2')
  assert.equal(fieldNamed(handle, 'message').value, 'Keep the pending start attached.')
  assert.equal(actionNamed(handle, 'start').disabled, true)
  assert.equal(actionNamed(handle, 'cancel').disabled, true)
  assert.equal(fieldNamed(handle, 'message').disabled, true)
  assert.equal(fieldNamed(handle, 'profile').disabled, true)
  actionNamed(handle, 'start').dispatch('click')
  assert.equal(calls.submitted.length, 1)
  pending.resolve({ ok: false, message: 'The original start was refused.' })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(handle.element(), root)
  assert.equal(noticeLine(handle).textContent, 'The original start was refused.')
  assert.equal(fieldNamed(handle, 'message').disabled, false)
})

test('folder refresh changes visible empty-state help without replacing the form or its selection', () => {
  const { handle, doc } = open({ folders: [], defaultFolder: CHOSEN })
  const root = handle.element()
  const field = fieldNamed(handle, 'profile')
  field.focus()
  const hint = () => root.find(node => node.getAttribute('id')?.endsWith('-folder-hint'))
  handle.updateFolders(FOLDERS)
  assert.equal(hint().textContent, START_PANEL.folderHelp)
  assert.equal(hint().getAttribute('data-compose-tip'), 'hover')
  field.value = 'p-2'
  handle.updateFolders([FOLDERS[1]])
  assert.equal(field.value, 'p-2')
  handle.updateFolders([])
  assert.equal(handle.element(), root)
  assert.equal(doc.activeElement, field)
  assert.equal(field.value, '')
  assert.equal(hint().textContent, START_PANEL.folderNoneChosen(CHOSEN))
  assert.equal(hint().getAttribute('data-compose-tip'), null)
  assert.ok(!hint().className.includes('tip-box'))
})

test('with no folders set up, the panel says where to make one and still starts', () => {
  const { handle, calls } = open({ folders: [] })
  const folder = fieldNamed(handle, 'profile')
  assert.equal(folder.children.length, 1, 'only the product’s own workspace is offered')
  const words = wordsOnScreen(handle)
  assert.ok(words.includes(START_PANEL.folderNone), 'the panel must say where folders are made')
  /* NOT A REFUSAL. Starting works fine without a profile. */
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')
  assert.equal(calls.submitted.length, 1, 'no folders is not a reason to refuse a start')
})

/* ---- WHERE "NAME NO FOLDER" ACTUALLY LANDS, WHICH IS NOT ALWAYS THE SAME PLACE
 *
 * shell/main.cjs resolves a start with no profileId through chosenWorkspaceCwd()
 * -- the folder the person answered the setup question with -- and falls back to
 * <userData>\workspace only on a machine where nobody was ever asked. The panel
 * said the fallback unconditionally, and on the happy path that was false.
 *
 * MEASURED ON THE PACKAGED BUILD, two runs, same panel, same sentence, two
 * different signed spawn records:
 *   finished setup, took the suggested folder   details.cwd = that folder
 *   skipped setup, nobody was ever asked        details.cwd = null
 * So the person who had answered the folder question two screens earlier was
 * told their agent would work somewhere else, and pointed at a control to "add
 * one" for work they had already done -- four lines above this same panel's
 * footer saying "It may change files only inside the folder you chose."
 * ------------------------------------------------------------------------- */

const CHOSEN = 'C:\\Users\\someone\\Documents\\AI Workspace'

test('when setup recorded a folder, the first row names IT and not the product’s workspace', () => {
  const { handle } = open({ folders: [], defaultFolder: CHOSEN })
  const folder = fieldNamed(handle, 'profile')
  assert.equal(folder.children[0].value, '', 'it is still the same null answer on the wire')
  assert.equal(folder.children[0].textContent, START_PANEL.folderWorkspaceChosen,
    'the row a start with no named folder uses must not claim the product’s own workspace')
  const words = wordsOnScreen(handle)
  /* wordsOnScreen is a list of WHOLE strings, one per leaf, so the path is
     looked for inside them rather than as an element of its own -- the first
     version of this assertion compared the two directly and failed against a
     panel that was rendering the path correctly. */
  assert.ok(words.some(line => line.includes(CHOSEN)),
    'and the folder itself must be on the page, not merely alluded to')
  assert.ok(words.includes(START_PANEL.folderNoneChosen(CHOSEN)),
    'the hint must be the copy module’s sentence for this case, whole')
  assert.ok(!words.includes(START_PANEL.folderNone),
    'the pre-2026-08-18 sentence must not be shown on a computer where somebody answered the question')
})

test('with no setup folder recorded, the panel says the product’s own workspace, as it always did', () => {
  /* THE POSITIVE CONTROL for the test above. Without it that assertion would
     also pass on a panel that had simply stopped saying anything. */
  const { handle } = open({ folders: [], defaultFolder: '' })
  const folder = fieldNamed(handle, 'profile')
  assert.equal(folder.children[0].textContent, START_PANEL.folderWorkspace)
  assert.ok(wordsOnScreen(handle).includes(START_PANEL.folderNone))
})

test('the setup folder survives a re-open that does not mention it', () => {
  /* Same hazard as the folders and the confinement line: the ordinary re-open is
     `{ parent }` alone, and readStartableTiers() re-opens with `{ tiers }`. */
  const { handle } = open({ folders: [], defaultFolder: CHOSEN })
  handle.open({ tiers: tierChoicesFor(['luna']) })
  assert.equal(fieldNamed(handle, 'profile').children[0].textContent, START_PANEL.folderWorkspaceChosen)
  assert.ok(wordsOnScreen(handle).some(line => line.includes(CHOSEN)),
    'the reading of this computer must not be lost on a re-open')
})

test('a recorded setup folder is still not a reason to refuse a start, and still sends null', () => {
  const { handle, calls } = open({ folders: [], defaultFolder: CHOSEN })
  fill(handle, { role: 'manager', message: 'Take the packaging work.' })
  actionNamed(handle, 'start').dispatch('click')
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.submitted[0].profileId, null,
    'the wire is unchanged: the shell resolves the folder, this panel only says which')
})

test('re-opening with only tiers keeps the folder menu that was already read', () => {
  /* readStartableTiers() re-opens an open panel with `{ tiers }` alone the
     moment the shell answers. A merge that reset the folders would empty the
     menu out from under somebody reading it. */
  const { handle } = open({ folders: FOLDERS, folderSelectedId: 'p-1' })
  handle.open({ tiers: tierChoicesFor(['luna']) })
  const folder = fieldNamed(handle, 'profile')
  assert.equal(folder.children.length, 3, 'the folders survived a re-open that did not mention them')
  assert.equal(folder.value, 'p-1', 'and so did the remembered choice')
})

/* ---------- WHAT A SESSION STARTED HERE WOULD ACTUALLY BE ALLOWED TO DO ------
 *
 * THE DEFECT THESE PIN. A driver walked the whole happy path on a scratch
 * install at the RECOMMENDED level and the last step failed: the agent's first
 * write was refused by the operating system, and the only thing on screen about
 * it was the agent's own prose. src/agent-confinement-copy.js has owned the
 * honest sentence for that state since it was written -- SANDBOX_EFFECT
 * 'read-only', "It can read files, and this computer refuses any attempt it
 * makes to change one" -- and src/agent-session.js renders it under ITS Start
 * button. This panel is the OTHER Start button, the one a first-time person
 * actually presses, and it said nothing at all.
 *
 * THE PANEL STILL WRITES NO WORDS OF ITS OWN. The sentence arrives as a
 * caller-supplied line, which is the same door the refusal sentence already
 * comes through (header rule 4). So these assertions run the REAL copy module
 * rather than a literal: a panel that rendered an invented sentence, or a copy
 * module that started saying something reassuring, both fail here.
 *
 * BOTH DIRECTIONS, because a line that always says "it cannot write" would
 * satisfy the first assertion and be a new lie at the two levels that do ask
 * for write access. */

test('the start control says what a session started here would be allowed to do', () => {
  const line = startControlLine({
    ok: true, tier: 'guided', sandbox: 'read-only', failedClosed: false,
  })
  const { handle } = open({ confinementLine: line })
  const said = confinementLineOf(handle)

  assert.ok(said, 'the panel a first-time person presses Start on must carry this line')
  assert.equal(said.textContent, line)
  assert.ok(
    said.textContent.includes(SANDBOX_EFFECT['read-only']),
    'the refusal a person is about to meet must be stated in the confinement module’s own words',
  )
})

test('the line is pinned with Start, so it cannot be scrolled away from the button it qualifies', () => {
  const { handle } = open({
    confinementLine: startControlLine({ ok: true, tier: 'guided', sandbox: 'read-only', failedClosed: false }),
  })
  const said = confinementLineOf(handle)
  const scroller = handle.element().find(node => node.className.includes('agent-compose-body'))

  assert.ok(scroller, 'the form still scrolls')
  assert.equal(scroller.findAll(node => node === said).length, 0, 'a disclosure inside the scroller is a disclosure nobody reads')
  /* AFTER the action row, never before it: the panel's own header records that
     Start below the fold was an owner-reported defect twice, and a block added
     ABOVE the button moves the button down. */
  const root = handle.element()
  const actions = root.find(node => node.className.includes('agent-compose-actions'))
  assert.ok(root.children.indexOf(said) > root.children.indexOf(actions), 'Start must not move down to make room for this')
})

test('a panel with no reading of this computer says nothing, rather than something reassuring', () => {
  const { handle } = open()
  const said = confinementLineOf(handle)
  assert.ok(said, 'the element exists so a later answer has somewhere to land')
  assert.equal(said.textContent, '')
  assert.equal(said.getAttribute('hidden'), 'hidden', 'an empty line must not leave a gap that reads as a fault')
  assert.deepEqual(wordsOnScreen(handle).filter(words => !APPROVED_WORDS.has(words)), [], 'and it must not invent a sentence of its own')
})

test('an unreadable computer is answered as unreadable, never as read-only and never as write', () => {
  for (const reading of [null, undefined, { ok: false, code: 'AGENT_CONFINEMENT_UNAVAILABLE' }, { ok: true, tier: 'guided', sandbox: 'nonsense' }]) {
    const line = startControlLine(reading)
    assert.ok(line.includes(UNKNOWN_CONFINEMENT), `${JSON.stringify(reading)} must be answered as unknown`)
    assert.equal(line.includes(SANDBOX_EFFECT['read-only']), false)
    assert.equal(line.includes(SANDBOX_EFFECT['workspace-write']), false)
    assert.equal(line.includes(SANDBOX_EFFECT['danger-full-access']), false)
  }
})

test('a level that asks for write access says so, and the fail-closed case says why', () => {
  const writing = startControlLine({ ok: true, tier: 'standard', sandbox: 'workspace-write', failedClosed: false })
  assert.ok(writing.includes(SANDBOX_EFFECT['workspace-write']))
  assert.equal(writing.includes(SANDBOX_EFFECT['read-only']), false, 'a hardcoded refusal sentence would be a new lie here')

  const unrecorded = startControlLine({ ok: true, tier: 'guided', sandbox: 'read-only', failedClosed: true })
  assert.ok(unrecorded.includes(FAIL_CLOSED_CLAUSE), 'a person whose answer was never recorded is entitled to know that')
})

/* T1437: with a Role library the menu has no Coordinator (the top of a tree is
   the Controller, the role marked orgRoot), so the first-agent line must name
   the role the menu really offers; a library with no top-of-tree role gets no
   suggestion rather than advice about a role that is not there. The shipped
   list (the browser preview) keeps its own coordinator line. */
test('the first-agent suggestion names the Role library role that sits at the top of a tree', () => {
  const library = [
    { id: 'controller', label: 'Controller', orgRoot: true },
    { id: 'coordinator-assistant', label: 'Coordinator assistant', orgRoot: false },
    { id: 'manager', label: 'Manager', orgRoot: false },
    { id: 'worker', label: 'Worker', orgRoot: false },
  ]
  const suggestionOf = handle => handle.element().find(node => node.getAttribute('data-compose-suggestion') === 'first-role')
  const { handle } = open({ parent: null, roles: library })
  assert.equal(suggestionOf(handle).textContent, 'A Controller sits at the top of a tree, so it is an easy first choice.')
  assert.doesNotMatch(suggestionOf(handle).textContent, /coordinator/i)
  assert.equal(fieldNamed(handle, 'role').value, '', 'still a suggestion, not a pick')

  const { handle: noRoot } = open({ parent: null, roles: library.map(role => ({ ...role, orgRoot: false })) })
  assert.equal(suggestionOf(noRoot), null, 'no top-of-tree role in the menu, no suggestion')

  const { handle: shipped } = open({ parent: null })
  assert.equal(suggestionOf(shipped).textContent, FIRST_ROLE_SUGGESTION.line, 'the shipped list keeps its coordinator line')
})

/* T1471: the empty-brief refusal is shown after Set this agent too, and must
   not send a person who only wanted a draft to the button that starts one. */
test('an empty brief after Set this agent is refused without telling the person to press Start', () => {
  for (const action of ['set', 'start']) {
    const { handle, calls } = open()
    fill(handle, { message: '   ' })
    actionNamed(handle, action).dispatch('click')
    const line = problemFor(handle, 'message').textContent
    assert.equal(line, START_PANEL.needMessage)
    assert.doesNotMatch(line, /press Start/i, action + ': the refusal names a button the person did not press')
    assert.equal(calls.submitted.length, 0)
  }
})

// T1511: pasting a screenshot into the New chat brief did nothing and said
// nothing; the agent would start on a brief that names a picture it never got.
test('a picture pasted into the brief is not dropped silently: the brief says where it can go', () => {
  const { handle } = open()
  const brief = fieldNamed(handle, 'message')
  brief.value = 'Please fix what this screenshot shows'
  let prevented = false
  const picture = { type: 'image/png', kind: 'file', getAsFile: () => ({ name: 'shot.png', arrayBuffer: async () => new ArrayBuffer(4) }) }
  brief.dispatch('paste', { clipboardData: { items: [picture] }, preventDefault() { prevented = true } })
  assert.equal(prevented, true, 'the picture paste is claimed, not let fall into the box as text')
  assert.equal(problemFor(handle, 'message').textContent, START_PANEL.pictureInBrief)
  assert.equal(brief.value, 'Please fix what this screenshot shows', 'the brief is unchanged')
  let textPrevented = false
  brief.dispatch('paste', { clipboardData: { items: [{ type: 'text/plain', kind: 'string' }] }, preventDefault() { textPrevented = true } })
  assert.equal(textPrevented, false, 'a text paste is left to the browser')
  brief.dispatch('input', {})
  assert.equal(problemFor(handle, 'message').textContent, '', 'typing clears the line, as for any refusal about the brief')
})
