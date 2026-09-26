import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIVITY_MARKS, activityContext, activityDisclosure, activityMatches, activityStatus } from '../../src/home-activity.js'
import { describeRun } from '../../src/local-activity.js'
import { buildSubjectChoices, subjectMatchesRun } from '../../src/home-chat-takeover.js'

const run = { sessionId: 's1', sequence: 1, result: 'started', atMs: 1 }
const saved = { asked: 'Review this change', reply: 'The review passed.', status: 'finished', turns: [] }
const context = (savedValue = saved, live) => activityContext(run, savedValue, live,
  describeRun(run, new Map([[run.sessionId, savedValue]]), Date.now(), { live }))

test('a start or stored running state cannot become a live Working status', () => {
  assert.equal(activityStatus(run).label, 'Started')
  assert.equal(activityStatus(run, { status: 'running' }).kind, 'other')
  assert.equal(activityStatus(run, saved, { working: true }).kind, 'working')
  assert.equal(activityStatus(run, saved).label, 'Finished')
  assert.equal(activityStatus({ ...run, result: 'refused' }, saved).kind, 'attention')
})

test('approval, interrupted turn and exited session remain distinct from completed work', () => {
  assert.equal(activityStatus(run, saved, { working: false, waiting: true }).label, 'Needs approval')
  assert.equal(activityStatus(run, saved, { status: 'failed' }).label, 'Interrupted')
  assert.equal(activityStatus(run, saved, { status: 'success' }).label, 'Finished')
  assert.equal(activityStatus(run, saved, { ended: true }).label, 'Session ended')
  assert.equal(activityStatus(run, { status: 'failed' }).label, 'Failed')
})

test('new context opens an automatic fold, while a manually closed fold gets an unread update', () => {
  const before = context(), after = context(saved, { working: true, text: 'A new finding', turnId: 't2' })
  const automatic = activityDisclosure({ previous: before.revision, context: after, open: false })
  assert.equal(automatic.open, true)
  assert.equal(automatic.unread, false)
  const manual = activityDisclosure({ previous: before.revision, context: after, open: false, manual: true })
  assert.equal(manual.open, false)
  assert.equal(manual.unread, true)
})

test('completion and failure reopen automatic context after a previous working turn', () => {
  const working = context(saved, { working: true, text: 'Reviewing', turnId: 't1' })
  for (const status of ['success', 'error']) {
    const final = context(saved, { working: false, text: 'Review ended', status, turnId: 't1' })
    assert.equal(activityDisclosure({ previous: working.revision, context: final, open: false }).open, true)
  }
})

test('turning off automatic expansion still identifies updates and preserves an open row', () => {
  const before = context(), after = context({ ...saved, reply: 'New output' })
  const closed = activityDisclosure({ previous: before.revision, context: after, open: false, auto: false })
  assert.equal(closed.open, false)
  assert.equal(closed.unread, true)
  assert.equal(activityDisclosure({ previous: before.revision, context: after, open: true, auto: false }).open, true)
  assert.equal(activityDisclosure({ previous: after.revision, context: after, open: false, unread: true }).unread, true)
})

test('initial history and timestamp-only refreshes are not new context', () => {
  const first = context({ ...saved, turns: [{ who: 'agent', text: 'An observation', at: 1 }] })
  const refreshed = context({ ...saved, turns: [{ who: 'agent', text: 'An observation', at: 2 }] })
  assert.equal(first.revision, refreshed.revision)
  assert.equal(activityDisclosure({ context: first, open: false }).open, false)
  assert.equal(activityDisclosure({ previous: first.revision, context: refreshed, open: false }).unread, false)
})

test('expanded answers and prompts retain all formatting and text beyond the old preview limit', () => {
  const answer = '## Results\n\n' + 'A paragraph. '.repeat(1000) + '\n\n```js\nconst final = true\n```'
  const asked = 'Keep every detail.\n' + 'A constraint. '.repeat(200)
  const result = context({ ...saved, asked, reply: answer })
  assert.equal(result.answer, answer)
  assert.equal(result.asked, asked)
  assert.match(result.answer, /const final = true/)
})

test('attention previews show the actual reason rather than an old successful reply', () => {
  const result = context(saved, { waiting: true, detail: 'Allow the test command?', text: 'An earlier update' })
  assert.equal(result.preview, 'Allow the test command?')
  assert.equal(result.answer, 'An earlier update')
})

test('the filters select exactly the requested state without hiding other states in All runs', () => {
  for (const kind of ['working', 'attention', 'finished', 'other']) {
    assert.equal(activityMatches('all', kind, false), true)
    assert.equal(activityMatches('working', kind, false), kind === 'working')
    assert.equal(activityMatches('updated', kind, true), true)
    assert.equal(activityMatches('updated', kind, false), false)
  }
})

test('saved agent scopes include local nodes and distinguish identical names on different computers', () => {
  const rows = [
    { nodeId: 'n1', computerId: 'c1', displayName: 'Reviewer' },
    { nodeId: 'n1', computerId: 'c2', displayName: 'Reviewer' },
  ]
  const choices = buildSubjectChoices({ machines: [{ id: 'c1', name: 'Studio' }, { id: 'c2', name: 'Laptop' }],
    conversations: new Map(rows.map((value, index) => [`s${index}`, value])) })
  const scoped = choices.filter(choice => choice.savedConversation)
  assert.equal(scoped.length, 2)
  assert.notEqual(scoped[0].id, scoped[1].id)
  assert.equal(scoped[0].label, 'Reviewer · Studio')
  assert.equal(subjectMatchesRun(scoped[0], run, rows[0]), true)
  assert.equal(subjectMatchesRun(scoped[0], run, rows[1]), false)
})

/* The column has to be readable down its left edge: a reader learns the marks
   once, and each one means exactly one thing about what is wanted of them. */
test('every status wears the one mark its kind wears, and no two kinds share one', () => {
  const cases = [
    [[run, saved, { waiting: true }], 'attention'],
    [[run, saved, { ended: true }], 'attention'],
    [[run, saved, { working: true }], 'working'],
    [[run, saved, { status: 'success' }], 'finished'],
    [[run, saved, { status: 'failed' }], 'attention'],
    [[{ ...run, result: 'refused' }, saved], 'attention'],
    [[run, { status: 'failed' }], 'attention'],
    [[run, { status: 'cancelled' }], 'attention'],
    [[run, { status: 'paused' }], 'attention'],
    [[run, { status: 'blocked' }], 'attention'],
    [[run, saved], 'finished'],
    [[run, { reply: 'Done.' }], 'other'],
    [[run, { status: 'running' }], 'other'],
    [[run, { status: 'starting' }], 'other'],
    [[run], 'other'],
    [[{ ...run, result: null }], 'other'],
  ]
  const marks = new Map()
  for (const [args, kind] of cases) {
    const status = activityStatus(...args)
    assert.equal(status.kind, kind, `${status.label} belongs to ${kind}`)
    assert.equal(status.mark, ACTIVITY_MARKS[kind], `${status.label} wears its kind's mark`)
    marks.set(status.kind, status.mark)
  }
  assert.equal(new Set(marks.values()).size, marks.size, 'no two kinds share a mark')
})

test('the status words read as one vocabulary rather than as several', () => {
  const labels = [
    activityStatus(run).label,
    activityStatus({ ...run, result: null }).label,
    activityStatus(run, { status: 'running' }).label,
    activityStatus(run, { status: 'starting' }).label,
    activityStatus(run, { reply: 'Done.' }).label,
    activityStatus(run, saved).label,
    activityStatus(run, saved, { working: true }).label,
    activityStatus(run, saved, { status: 'failed' }).label,
    activityStatus({ ...run, result: 'refused' }, saved).label,
  ]
  for (const label of labels) {
    // Three words is the ceiling because "Did not start" is the word this
    // product already uses for a refusal on the metrics screen, and one screen
    // renaming it would split the vocabulary rather than settle it.
    assert.ok(label.split(' ').length <= 3, `"${label}" is a state, not a sentence about one`)
    assert.equal(/[.!]$/.test(label), false, `"${label}" does not punctuate`)
    assert.equal(label, label.trim())
    assert.match(label, /^[A-Z]/)
  }
  assert.equal(new Set(labels).size, labels.length, 'each of these states keeps its own word')
})
