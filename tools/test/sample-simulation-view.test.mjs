/* THE EXAMPLE AT WORK STAYS AN EXAMPLE (src/views/computers.js, the page's half
 * of src/sample-simulation.js).
 *
 * The simulation makes example agents LOOK alive, and a live-looking agent is
 * where every real door is: send, queue, attach, restart, stop, change model.
 * These tests hold the line the owner's example safeguards draw -- writes are
 * refused with the example sentence -- for every door the simulation could
 * have opened:
 *   - the page's half never names the session map the commands trust, the
 *     agent bridge, the outbox or the transcript store;
 *   - an example agent's chat has no sender, picker, queue or stop door, and
 *     its composer carries the example sentence;
 *   - the palette shows the real rows but only the two copy rows act;
 *   - the example lists no real folders and never restarts into one;
 *   - live-looking is the simulation's own set, only while its store is shown;
 *   - the chat's new note door paints the product's own line.
 *
 * Run: node --test tools/test/sample-simulation-view.test.mjs
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const view = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

function section() {
  const start = view.indexOf('  /* THE EXAMPLE, AT WORK (owner, 2026-09-11')
  const end = view.indexOf('  /* Open the saved trees for one computer.', start)
  assert.ok(start > 0 && end > start, 'the example simulation section moved')
  return strip(view.slice(start, end))
}

test('the page’s half of the simulation never reaches a real session, the bridge, the outbox or the transcripts', () => {
  const code = section()
  for (const banned of ['sessionNodeIds', 'RUN_SESSION_NODES', 'mcAgent', 'bridge', 'outbox', 'transcriptStore', 'persistTranscript',
    'treeCardSend', 'runPaletteAction', 'resumeNodeSession', 'startAgentForNode', 'localStorage', 'fetch(']) {
    assert.ok(!code.includes(banned), `the example simulation reaches ${banned}`)
  }
  for (const door of ['openStream', 'addAction', 'addThinking', 'addNote', 'addOwnerMessage']) {
    assert.ok(code.includes(`.${door}`), `the example no longer draws through the chat's own ${door} door`)
  }
  assert.match(code, /if \(destroyed \|\| !sampleRun \|\| treeStore !== sampleRunStore \|\| !mockSource\(\)\) \{ stopSampleRun\(\); return \}/,
    'the simulation must stop itself when the page stops showing its store')
})

test('an example agent’s chat has no door to a real agent and says why in the composer', () => {
  const config = strip(declaredFunctionSource(view, 'exampleChatConfigFor'))
  for (const door of ['onSend', 'onAttach', 'onMention', 'onPasteAttachment', 'queue:', 'onStop', 'onApprovalDecision']) {
    assert.ok(!config.includes(door), `the example chat config opens ${door}`)
  }
  assert.match(config, /composerReason: exampleBoardText\(\)/)
  assert.match(config, /onReady: root => registerSampleChat\(node\.id, root\)/)
  assert.match(config, /actions: \(\) => exampleOnlyRows\(chatActionRowsFor\(current\(\)\)\)/)
  assert.match(config, /commonActions: \(\) => exampleOnlyRows\(commonChatActionsFor\(current\(\)\)\)/)

  const router = strip(declaredFunctionSource(view, 'treeChatConfigFor'))
  const routed = router.indexOf('if (mockSource() && (node.sessionId || sampleRun?.owns(node.id))) return exampleChatConfigFor(node)')
  assert.ok(routed > 0, 'example agents with a session no longer get the example chat')
  assert.ok(routed < router.indexOf('onSend'), 'the example route must come before any live wiring')
})

test('the palette shows the real rows, and only the two copy rows act on the example', () => {
  const rows = declaredFunctionSource(view, 'exampleOnlyRows')
  const safe = /const SAMPLE_SAFE_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(view)
  assert.ok(safe, 'the example safe-row list moved')
  assert.deepEqual(safe[1].split(',').map(item => item.trim().replace(/'/g, '')).filter(Boolean), ['copy-brief', 'copy-reply'])
  const exampleOnlyRows = new Function('SAMPLE_SAFE_ACTIONS', 'exampleBoardText', `${rows}; return exampleOnlyRows`)(
    new Set(['copy-brief', 'copy-reply']), () => 'EXAMPLE SENTENCE')
  const mapped = exampleOnlyRows([
    { id: 'stop', enabled: true, run: () => 'stopped' },
    { id: 'effort', enabled: true, run: () => 'restarted' },
    { id: 'clear', enabled: true },
    { id: 'copy-reply', enabled: true, disabledHint: null },
  ])
  assert.deepEqual(mapped.map(row => [row.id, row.enabled, row.disabledHint ?? null]), [
    ['stop', false, 'EXAMPLE SENTENCE'], ['effort', false, 'EXAMPLE SENTENCE'], ['clear', false, 'EXAMPLE SENTENCE'], ['copy-reply', true, null],
  ])
})

test('the example lists no folders of yours and never restarts into one', () => {
  assert.match(view, /const bridgeForProfiles = typeof window === 'undefined' \|\| mockSource\(\) \? null : window\.mcAgent/)
  const restart = view.slice(view.indexOf("controlsPage.querySelector('[data-tree-profile-restart]')?.addEventListener('click'"))
  assert.match(restart.slice(0, 400), /if \(mockSource\(\)\) \{ profileOut\.textContent = exampleBoardText\(\); return \}\s*void resumeNodeSession/)
})

test('live-looking is the simulation’s own set, and only while its own store is on the page', () => {
  assert.match(view, /const ownedSessions = \(\) => \(sampleRun && treeStore && treeStore === sampleRunStore \? sampleRun\.liveSessions : sessionNodeIds\)/)
  /* Each reader passes the owned collection AND the expiring evidence. A
     sample run has no stamps of its own -- its sessions emit no packets -- so
     sessionEvidence() answers null for it and the rule falls through to its
     "no evidence means live" branch. That is why the simulation keeps reading
     live here while a real session that went quiet does not. */
  for (const reader of ['nodeSessionLive = node => sessionIsLive(node, ownedSessions(), sessionEvidence())',
    'nodeBusy = node => nodeIsBusy(node, ownedSessions(), sessionEvidence())',
    'nodeSessionEnded = node => sessionEndedWithApp(node, ownedSessions(), sessionEvidence())']) {
    assert.ok(view.includes(`const ${reader}`), `the liveness reader changed: ${reader}`)
  }
  assert.ok(view.indexOf('  let sampleRun = null') < view.indexOf('  const nodeSessionLive = '), 'the simulation state must exist before its first reader')
  assert.match(view, /treeStore = createSampleTreeStore\(\{ simulation: true \}\)/)
  assert.match(view, /if \(treeStore\) startSampleRun\(treeStore\)/)
})

test('the chat paints the product’s own line through its note door', () => {
  const { document, restore } = installDomStandIn(globalThis)
  after(restore)
  return import('../../src/components.js').then(({ buildChat }) => {
    const root = buildChat({ title: 'Builder 2', seed: 0, composerReason: 'EXAMPLE SENTENCE' })
    document.documentElement.appendChild(root)
    assert.equal(typeof root.addNote, 'function')
    const row = root.addNote('The Work account (Codex) reset. Retrying the turn automatically.')
    assert.ok(row, 'no note row was painted')
    assert.match(row.className, /\bnote\b/)
    assert.match(row.textContent, /Retrying the turn automatically/)
    assert.equal(root.addNote('   '), null, 'an empty note must paint nothing')
    root.dispose()
    root.remove()
  })
})
