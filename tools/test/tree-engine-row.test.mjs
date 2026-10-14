/* THE ENGINE ROW ON A TREE NODE'S PANEL NAMES WHAT THIS BUILD REALLY STARTS.
 *
 * THE SENTENCE THIS GUARDS, and the owner's report about it. The node panel's
 * Setup box carried two hardcoded strings in src/views/computers.js:
 *
 *     Engine: Codex
 *     "Agents you start from this tree run on Codex. You pick the model in the
 *      start panel; the Claude choices are listed there and say so when they
 *      cannot start yet."
 *
 * Both were true when Codex was the only engine in the payload.
 * capability/src/lib/agent-engine/claude-cli-process.js ships now, and the
 * post-cut-truth lane measured a real Claude agent starting from a tree, on a
 * profile with a Claude sign-in and NO Codex credential, answering 391 to a
 * question whose answer was nowhere in the prompt. It also measured the tier
 * menu: exactly one row carries "cannot start from a tree yet", and it is the
 * local one, not a Claude one. So the panel named Codex as THE engine on a
 * build that starts Claude, and told people the Claude rows were marked when
 * they are not.
 *
 * WHY THIS ASSERTS NO WORDING, borrowed wholesale from
 * tools/test/refusal-engine-honesty.test.mjs and from the lane that wrote it:
 * every false version of this claim was already covered by a test, and each of
 * those tests REQUIRED the false version. One pinned /Pick Luna, Terra or Sol/
 * on the exact day the payload changed underneath it. A test that pins what a
 * sentence says about what a build carries is a test that fails the day the
 * build becomes right.
 *
 * So this asks the SHELL what the payload starts -- createAgentHost()'s
 * startableTiers() runs the same resolveStartTier() a press runs -- and then
 * requires the panel's own copy functions to name exactly those providers and
 * no others, whatever words they choose.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import {
  TREE_ENGINE,
  startableProviderWords,
  tierProviderWord,
} from '../../src/fleet-tree-copy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)
const { createAgentHost } = require_(path.join(ROOT, 'shell', 'agent-host.cjs'))
const PAYLOAD_ENGINE = path.join(ROOT, 'capability', 'src', 'lib', 'agent-engine', 'codex-process.js')

function shellStartableTierIds() {
  const host = createAgentHost({ enginePath: PAYLOAD_ENGINE, defaultCwd: ROOT })
  const answer = host.startableTiers()
  assert.equal(answer.ok, true, 'the shell could not answer what this build can start')
  return answer.tiers
}

const STARTABLE = shellStartableTierIds()

test('the panel names every provider the shell can start, and no other', () => {
  const words = startableProviderWords(STARTABLE)
  const expected = []
  for (const tier of LAUNCH_TIERS) {
    if (!STARTABLE.includes(tier.id)) continue
    const word = tierProviderWord(tier.id)
    assert.ok(word, `no word for the ${tier.provider} provider, which this build can start`)
    if (!expected.includes(word)) expected.push(word)
  }
  assert.deepEqual([...words], expected,
    'the Engine row does not name the same providers the shell says this build can start')

  /* And a provider the shell did NOT list must not appear. This is the half
     that catches the defect: naming Claude when it cannot start is the same
     class of error as omitting it when it can. */
  const absent = LAUNCH_TIERS
    .filter(tier => !STARTABLE.includes(tier.id))
    .map(tier => tierProviderWord(tier.id))
    .filter(word => word && !expected.includes(word))
  const sentence = TREE_ENGINE.note(words)
  for (const word of new Set(absent)) {
    assert.ok(!sentence.includes(word),
      `the Engine note names ${word}, which the shell says this build cannot start from a tree`)
  }
  for (const word of expected) {
    assert.ok(sentence.includes(word), `the Engine note does not name ${word}, which this build starts`)
  }
})

test('a node that already ran says what IT ran on, from its own record', () => {
  for (const tier of LAUNCH_TIERS) {
    const word = tierProviderWord(tier.id)
    assert.ok(word, `${tier.id} has no provider word; a node that ran on it would print a raw id`)
    assert.match(TREE_ENGINE.ran(word), new RegExp(word), 'the ran sentence dropped the provider')
  }
  assert.equal(tierProviderWord('no-such-tier'), null,
    'an unknown tier resolves to a provider; an older record would be given a name nobody wrote')
  assert.ok(TREE_ENGINE.unrecorded.length > 0, 'a record with no tier has nothing to print')
})

test('the view holds no hardcoded engine name', () => {
  /* AUDIT DISPOSITION — REPORTED, NOT CONVERTED. Every assertion below reads
     implementation text and a correct refactor can break it: the constants
     can become differently named bindings, treeEngineFace can become an arrow
     or be renamed, the provider-word call can use an alias or an intermediate,
     and the shell reply can be assigned through a callback or reducer. The
     observable requirement is that computersView renders the providers from
     the shell reply (and a recorded node's own provider), but treeEngineFace is
     closure-private. Exercising that requirement therefore needs a view/DOM
     harness or a sibling-module seam; changing computers.js is outside this
     audit's one-file scope. These pins remain only as reported coverage debt,
     rather than being relabelled as behavioural assertions without a mutation
     check that reaches the rendered row. */
  const view = readFileSync(path.join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  const code = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(!/TREE_ENGINE_LABEL\s*=/.test(code),
    'the engine label is a constant again; it will be wrong the next time the payload changes')
  assert.ok(!/TREE_ENGINE_NOTE\s*=/.test(code),
    'the engine note is a constant again; it cannot follow what the shell answers')
  assert.match(code, /function treeEngineFace\(node\)/, 'the panel no longer derives its engine row')
  /* Since T1279 the row names the startable tiers whose provider is installed
     (the start panel's own rule), so the words are built from a filter of the
     shell's list rather than from the list itself. Both halves are pinned: the
     shell's list is still what is read, and the filtered list is what is named. */
  assert.match(code, /installedTiers = startableTierIdList\.filter\(/,
    'the engine row stopped reading what the shell answered')
  assert.match(code, /startableProviderWords\(installedTiers\)/,
    'the engine row stopped naming the providers it filtered from the shell answer')
  /* The list the row reads must be the one the SHELL filled, not the
     pessimistic default left standing because nobody assigned it.
     Two pins rather than one since 906ea9d0: that commit split the reading in
     two so a row could tell "the shell said no launcher" from "the shell never
     spoke", and the single expression this used to match
     (`startableTierIdList = startableTierIds(reply)`, computers.js at
     a96ca17e) no longer exists. The requirement did not change and neither did
     the strength of the check -- the reply still has to be read, and its tiers
     still have to be the thing assigned -- so both halves are pinned. */
  assert.match(code, /const answer = startableTierAnswer\(reply\)/,
    'nothing reads the shell reply, so the row would show the fallback forever')
  assert.match(code, /startableTierIdList = answer\.tiers/,
    'nothing writes the startable tier ids from the shell reply, so the row would show the fallback forever')
})

test('the mounted Engine row shows only installed providers from the shell answer', async t => {
  const { register } = await import('node:module')
  register('./helpers/css-stub-loader.mjs', import.meta.url)
  const { mountComputers } = await import('./helpers/t1308-computers-fixture.mjs')
  const startable = LAUNCH_TIERS.map(row => row.id)
  const installed = LAUNCH_TIERS.find(row => row.provider !== 'local').provider
  const fixture = await mountComputers(t, { nodes: [{ id: 'node-engine-audit' }], tiers: startable,
    presence: { ok: true, providers: [...new Set(LAUNCH_TIERS.map(row => row.provider))]
      .map(id => ({ id, installed: id === installed ? 'yes' : 'no', signedIn: 'unknown' })) } })
  await fixture.openNode('node-engine-audit')
  const setup = fixture.view.el.querySelector('[data-tree-move]')
  assert.ok(setup, 'the real Details Setup section mounted')
  const expected = [...new Set(LAUNCH_TIERS.filter(row => row.provider === installed || row.provider === 'local')
    .map(row => tierProviderWord(row.id)))]
  assert.equal(setup.querySelector('.ctl-row .cv').textContent, expected.join(' · '))
  const note = setup.querySelector('.board-absent-copy').textContent
  for (const word of new Set(LAUNCH_TIERS.map(row => tierProviderWord(row.id)))) {
    assert.equal(note.includes(word), expected.includes(word), 'Engine note provider: ' + word)
  }
  assert.deepEqual(fixture.operations, [])
})
