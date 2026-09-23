/* Activity's presentation contract, driven through the actual row builders.
 * The lightweight DOM below tests values, disclosures and focus eligibility,
 * not geometry. The full-page layout additionally needs a browser check.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const { restore } = installDomStandIn(globalThis)
after(restore)
const { el, ownDisclosure } = await import('../../src/components.js')
const { TAKEOVER_COPY, takeoverFocusStops } = await import('../../src/home-chat-takeover.js')
const { ACTIVITY_LABELS, activityContext, activityDisclosure, activityMatches, activityPreview } = await import('../../src/home-activity.js')
const { setChatMessageBody, addChatMessageCopy } = await import('../../src/chat-message-body.js')
const { COPY, describeRun, summariseRunWork } = await import('../../src/local-activity.js')
const { actionForLive, actionLabel, sampleAction } = await import('../../src/home-circle-action.js')
const source = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../src/home-chat.css', import.meta.url), 'utf8')

function sourceBetween(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `actual Home implementation is missing: ${start}`)
  return source.slice(from, to)
}
function compile(code, context, tail) {
  return new Function(...Object.keys(context), `${code}\n${tail}`)(...Object.values(context))
}

function fixture() {
  const nowMs = Date.parse('2026-09-04T12:00:00Z')
  const run = { sequence: 888, sessionId: 'activity-test', result: 'started', atMs: nowMs - 60_000 }
  const saved = {
    role: 'Reviewer', asked: 'Review the current changes', reply: 'The review is complete.', nodeId: 'reviewer-node',
    turns: [
      { who: 'you', text: 'Review the current changes' },
      { who: 'action', text: 'Read the changed files\n' + 'full tool detail\n'.repeat(100) },
      { who: 'agent', text: 'The review is complete.' },
    ],
  }
  const choices = new Map()
  const runOpen = { recall: key => choices.get(key) ?? null, remember: (key, open) => choices.set(key, open ? 'open' : 'closed') }
  const conversations = new Map([[run.sessionId, saved]])
  const liveSessions = new Map()
  const usageBySession = new Map()
  const putText = compile(declaredFunctionSource(source, 'putText'), {}, 'return putText')
  const context = { el, ownDisclosure, putText, FOLD_MARK: '<span class="chat-action-mark"></span>',
    runOpen, runOpenKey: value => value.sessionId || `seq:${value.sequence}`,
    ACTIVITY_LABELS,
    activityContext, activityDisclosure, activityMatches, activityPreview, setChatMessageBody, addChatMessageCopy, autoContext: true, runRows: new Map(), runLocations: new Map(), paintRunScope() {}, document: { activeElement: null },
    // The lane name is a control that scopes the panel to that lane; these are
    // what it reaches for when pressed.
    agentFilter: '', agentPick: { value: '' }, logEl: { scrollTop: 0 }, readingControls: null,
    resolveChoice() {}, rememberAgentPick() {}, keepForChoice: () => true, scopeTitle: '', oneLaneSelected: () => false,
    liveSessions, usageBySession, summariseRunWork, describeRun, conversations, state: { nowMs }, COPY, TAKEOVER_COPY, sample: false,
    // The row's "doing" words come from the circle's vocabulary (home-circle-action.js).
    actionForLive, actionLabel, sampleAction, SAMPLE_HEARTBEAT_MS: 45_000,
    // The turn renderer has its own markdown/speaker tests. This seam keeps
    // every supplied word, so this suite can detect loss or rebuilds of it.
    runTurnNode: line => { const node = el('<span class="test-turn"></span>'); node.textContent = line.text; return node },
  }
  const build = compile(sourceBetween('  function buildRunRow(', '\n  /* A line carries'), context, 'return buildRunRow')
  const setLine = compile(sourceBetween('  function setLine(', '\n  /* One line of the saved'), context, 'return setLine')
  const paint = compile(sourceBetween('  function paintRunRow(', '\n  let runsSignature'), { ...context, setLine }, 'return paintRunRow')
  return { run, saved, choices, runOpen, liveSessions, conversations, build, paint }
}

test('a full-page run has separate identity, work, status and time without replacing the recorded verdict', () => {
  const f = fixture()
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  assert.equal(row.el.querySelector('.run-identity').textContent, 'ReviewerAgent run 888')
  assert.equal(row.result.textContent, 'started')
  assert.equal(row.live.hidden, true, 'a start record is not evidence of current activity')
  assert.equal(row.when.textContent, 'a minute ago')
  assert.equal(row.summaryWork.textContent, row.did.textContent, 'the collapsed summary must not drop the recorded work')
  assert.equal(row.door.hidden, false, 'the real chat door remains reachable')
})

test('long transcript detail starts closed while the newest run and its summary remain open', () => {
  const f = fixture()
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  assert.equal(row.fold.open, true)
  assert.equal(Boolean(row.transcript.open), false)
  assert.equal(row.transcript.hidden, false)
  assert.equal(row.transcriptLabel.textContent, 'Conversation details · 1 entry')
  assert.equal(row.turns.textContent, f.saved.turns[1].text, 'collapsing must never truncate tool detail')
  assert.match(row.asked.textContent, /Review the current changes/)
  assert.match(row.said.textContent, /The review is complete/)
})

test('conversation expansion is independent of the run disclosure and is preserved across live repaint', () => {
  const f = fixture()
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  const turn = row.turns.firstChild
  const summary = row.transcript.querySelector('summary')
  row.transcript.dispatch('click', { target: summary })
  row.fold.dispatch('click', { target: summary })
  assert.equal(row.transcript.open, true)
  assert.equal(row.fold.open, true, 'a click on a nested transcript must not close its run')
  f.liveSessions.set(f.run.sessionId, { working: true, text: 'A fresh live answer.' })
  f.paint(row, f.run)
  assert.equal(row.transcript.open, true)
  assert.equal(row.turns.firstChild, turn, 'a live answer must not rebuild unchanged transcript nodes')
  assert.match(row.said.textContent, /A fresh live answer/)
  assert.equal(row.live.hidden, false)
  assert.equal(row.el.dataset.working, 'true')
})

test('empty transcript detail is absent, not a dead expansion control', () => {
  const f = fixture()
  f.saved.turns = []
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  assert.equal(row.transcript.hidden, true)
  assert.equal(row.turns.hidden, true)
})

test('remembered open and closed choices still override newest-run defaults', () => {
  const f = fixture()
  f.choices.set(f.run.sessionId, 'closed')
  assert.equal(f.build(f.run, 0).fold.open, false)
  f.choices.set(f.run.sessionId, 'open')
  assert.equal(f.build(f.run, 10).fold.open, true)
})

test('the overview counts displayed rows and observed live work, never signed start records', () => {
  const f = fixture()
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  const runRows = new Map([[f.run.sequence, row]])
  const activityOverview = el('<div></div>')
  const activityCount = el('<span></span>')
  const activityWorking = el('<span></span>')
  const paint = compile(sourceBetween('  function paintActivityOverview(', "  collapseDetails.addEventListener('click'"),
    { runRows, activityOverview, activityCount, activityWorking, activityFilters: [], TAKEOVER_COPY }, 'return paintActivityOverview')
  paint()
  assert.equal(activityCount.textContent, '1 recent run')
  assert.equal(activityWorking.hidden, true)
  f.liveSessions.set(f.run.sessionId, { working: true })
  f.paint(row, f.run)
  paint()
  assert.equal(activityWorking.textContent, '1 working now')
  assert.equal(activityWorking.hidden, false)
  runRows.clear()
  paint()
  assert.equal(activityOverview.hidden, true)
})

test('Collapse details remembers a user choice without dropping text or auto-reopening on live work', () => {
  const f = fixture()
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  row.transcript.open = true
  const text = row.el.textContent
  const collapseDetails = el('<button></button>')
  compile(sourceBetween("  collapseDetails.addEventListener('click'", '\n  function renderRuns('),
    { collapseDetails, runRows: new Map([[f.run.sequence, row]]), runOpen: f.runOpen }, '')
  collapseDetails.dispatch('click')
  assert.equal(row.fold.open, false)
  assert.equal(row.transcript.open, false)
  assert.equal(row.el.textContent, text)
  assert.equal(f.choices.get(f.run.sessionId), 'closed')
  f.liveSessions.set(f.run.sessionId, { working: true })
  f.paint(row, f.run)
  assert.equal(row.fold.open, false)
})

test('focus wrapping excludes closed transcript descendants even when Chromium reports their geometry', () => {
  const surface = el('<div><select></select><details><summary class="outer"></summary><details><summary class="inner"></summary><button></button></details></details><button class="close"></button></div>')
  const outer = surface.querySelector('details')
  const inner = outer.querySelector('details')
  const candidates = [surface.querySelector('select'), outer.querySelector('.outer'), inner.querySelector('.inner'), inner.querySelector('button'), surface.querySelector('.close')]
  surface.querySelectorAll = () => candidates
  for (const node of candidates) { node.tabIndex = 0; node.getClientRects = () => [{}] }
  outer.open = false
  inner.open = false
  assert.deepEqual(takeoverFocusStops(surface), [candidates[0], candidates[1], candidates[4]])
  outer.open = true
  assert.deepEqual(takeoverFocusStops(surface), [candidates[0], candidates[1], candidates[2], candidates[4]])
  inner.open = true
  assert.deepEqual(takeoverFocusStops(surface), candidates)
  candidates[3].disabled = true
  candidates[0].getClientRects = () => []
  assert.deepEqual(takeoverFocusStops(surface), [candidates[1], candidates[2], candidates[4]])
})

test('the full page has one named Activity dialog and no duplicate expand action on it', () => {
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby="\$\{panelTitleId\}-activity"/)
  assert.match(source, /<h1 id="\$\{panelTitleId\}-activity">\$\{escText\(TAKEOVER_COPY\.title\)\}/)
  assert.match(css, /\.home-takeover \.session-expand\s*\{\s*display:\s*none/)
  assert.match(css, /\.home-takeover-bar\s*\{[^}]*flex:\s*none/, 'a wrapped header must not shrink over the run list')
  assert.match(source, /const controls = takeoverFocusStops\(takeoverEl\)/)
})

/* WHOSE RUN IT WAS, ON EVERY ROW THAT CAN KNOW. The lane used to be read only
   off the saved conversation, so a run recorded a beat before its conversation
   landed rendered as "Agent run 55" and nothing else -- and that is the newest
   row, the one being read. The start record carries the lane; the row uses it. */
test('a run with no saved conversation still names the lane from its own record', () => {
  const f = fixture()
  const orphan = { ...f.run, sessionId: 'not-in-the-map', agentId: 'gem-lane-2' }
  const row = f.build(orphan, 0)
  f.paint(row, orphan)
  assert.equal(row.agent.hidden, false, 'the lane is on the row')
  assert.equal(row.agent.textContent, 'gem-lane-2')
  assert.equal(row.agentKey, 'gem-lane-2')
  assert.equal(row.el.dataset.lane, 'gem-lane-2')
})

test('a record that names no lane says nothing rather than inventing one', () => {
  const f = fixture()
  const nameless = { ...f.run, sessionId: 'not-in-the-map', agentId: null }
  const row = f.build(nameless, 0)
  f.paint(row, nameless)
  assert.equal(row.agent.hidden, true, 'no name is shown where none was recorded')
  assert.equal(row.agent.textContent, '')
  assert.equal(row.what.textContent, 'Agent run 888', 'the run number is the identity instead')
})

test('the lane name is the control that follows that lane', () => {
  const f = fixture()
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  assert.equal(row.agent.tagName, 'BUTTON', 'it is a real control, not text with a handler')
  assert.equal(row.agent.getAttribute('aria-pressed'), 'false')
  assert.match(row.agent.title, /^Show only Reviewer$/)
  /* Pressing it must not also fold the row: ownDisclosure claims every press
     inside the head, so the lane press has to be taken off that path. */
  const wasOpen = row.fold.open
  row.agent.dispatch('click')
  assert.equal(row.fold.open, wasOpen, 'following a lane does not collapse the run being read')
})

/* ONE ABSENCE, NOT A LIST OF THEM. A run with nothing recorded used to spend
   two lines saying one thing. */
test('a run with nothing recorded says so once', () => {
  const f = fixture()
  const bare = { ...f.run, sessionId: 'not-in-the-map', agentId: 'gem-lane-2' }
  const row = f.build(bare, 0)
  f.paint(row, bare)
  assert.equal(row.gap.textContent, COPY.runNothingSaved)
  assert.equal(row.gap.textContent.split(' ').length <= 8, true, `"${row.gap.textContent}" is brief`)
  assert.equal(row.did.hidden, true, 'the work absence does not repeat the same silence')
  assert.equal(row.summaryWork.hidden, true)
})

/* PROMPT C. THE ROW MUST NOT SAY ONE THING TWICE. A run still going already
   prints its state in words; the absence "it has not answered yet" repeated
   that state a line below it, and in a panel where three runs fill the glass a
   wasted line per live run is most of the reason the owner cannot follow it.
   The suppression is the surface's, not the record's: the same reading still
   reaches a surface that draws no status line. */
test('a run whose status line already reports it is live prints no absence under it', () => {
  const f = fixture()
  f.saved.status = 'running'
  f.saved.reply = ''
  f.saved.turns = []
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  assert.equal(row.statusLabel.textContent, ACTIVITY_LABELS.running, 'the state is still on the row, in words')
  assert.equal(row.gap.textContent, '', 'and is not repeated as an absence below itself')
  assert.equal(row.gap.hidden, true, 'so the line is gone, not merely blank')
})

test('the same suppression applies while this window is watching the run work', () => {
  const f = fixture()
  f.saved.reply = ''
  f.saved.turns = []
  f.liveSessions.set(f.run.sessionId, { working: true, text: '' })
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  assert.equal(row.el.dataset.working, 'true')
  assert.equal(row.gap.textContent, '', 'a watched run is the same repetition by another route')
})

test('an absence nothing else on the row reports is still printed in full', () => {
  const f = fixture()
  f.saved.status = 'finished'
  f.saved.reply = ''
  f.saved.turns = []
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  assert.equal(row.gap.textContent, COPY.runNoAnswerSaved,
    'a finished run with no saved answer has no other line saying so, so the row keeps saying it')
  assert.equal(row.gap.hidden, false)
})

test('a live run with nothing else to show still identifies itself rather than going blank', () => {
  // Suppressing the absence must not empty the collapsed row: what it carried
  // was the repetition, and the identity and state are what actually place it.
  const f = fixture()
  f.saved.status = 'running'
  f.saved.asked = ''
  f.saved.reply = ''
  f.saved.turns = []
  const row = f.build(f.run, 0)
  f.paint(row, f.run)
  assert.equal(row.brief.textContent, '', 'the brief holds no repeated state')
  assert.match(row.el.querySelector('.run-identity').textContent, /Agent run 888/)
  assert.equal(row.statusLabel.textContent, ACTIVITY_LABELS.running)
})
