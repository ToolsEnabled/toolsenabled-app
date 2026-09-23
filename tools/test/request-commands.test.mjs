/* THE /REQUEST FAMILY IN THE CHAT BOX — the user-side half of the standing
 * request contract.
 *
 * The owner's design (2026-08-15, verbatim in the engine's r-ledger module):
 * "/Request [request] saves to global R ledger ... it lies in the users hands
 * instead of some insane machinery". Four scopes, four commands, typed right
 * where the person is already talking to an agent. The PRODUCT files the
 * words; the agent needs no tool for it and just sees the confirmation.
 *
 * What these tests hold:
 *   - the four commands parse to kind:'request' with the right scope and the
 *     person's words untouched;
 *   - unknown /-input keeps its honest refusal (nothing new is swallowed);
 *   - an empty request refuses with a usage sentence and files nothing;
 *   - the confirmation sentence states the SCOPE honestly — the four scopes
 *     are the thing a person will get wrong, so each sentence must say who
 *     the rule reaches;
 *   - the chat dispatch seams in src/views/computers.js route kind:'request'
 *     before anything queues or sends (source pin, same style as the
 *     console-history pins — the view imports stylesheets and cannot load
 *     under node).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  parseSlashCommand,
  slashHelpSentence,
  REQUEST_COMMANDS,
  requestUsageSentence,
  requestConfirmationSentence,
} from '../../src/slash-commands.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = file => readFileSync(resolve(ROOT, file), 'utf8')

test('the four request commands parse to their scopes with the words untouched', () => {
  assert.deepEqual(parseSlashCommand('/Request Always ask before spending money.'),
    { kind: 'request', scope: 'global', rest: 'Always ask before spending money.' })
  assert.deepEqual(parseSlashCommand('/RequestSession keep answers short'),
    { kind: 'request', scope: 'session', rest: 'keep answers short' })
  assert.deepEqual(parseSlashCommand('/RequestTree use the staging server'),
    { kind: 'request', scope: 'tree', rest: 'use the staging server' })
  assert.deepEqual(parseSlashCommand('/RequestThread Always answer in one sentence.'),
    { kind: 'request', scope: 'thread', rest: 'Always answer in one sentence.' })
  /* Case-insensitive like every command here: the owner types /Request, the
     parser has always lowercased the word. */
  assert.equal(parseSlashCommand('/requestthread rule').scope, 'thread')
})

test('an empty request refuses with usage, and unknown input keeps its refusal', () => {
  const empty = parseSlashCommand('/RequestTree')
  assert.equal(empty.kind, 'request')
  assert.equal(empty.rest, '')
  const usage = requestUsageSentence('tree')
  assert.match(usage, /\/RequestTree/, 'the usage sentence does not name the command that was typed')
  assert.match(usage, /[Nn]othing was filed/, 'the usage sentence does not say nothing was filed')
  const unknown = parseSlashCommand('/requesttrees be careful')
  assert.equal(unknown.kind, 'unknown', 'a near-miss must stay the honest refusal, not file into a guessed scope')
  assert.match(unknown.sentence, /not a command here/)
})

test('the help sentence teaches the request family', () => {
  assert.match(slashHelpSentence(), /\/Request\b/, 'help never names /Request')
  assert.match(slashHelpSentence(), /\/RequestThread/, 'help never names the scoped commands')
})

test('each confirmation sentence states its scope honestly', () => {
  const said = {
    global: requestConfirmationSentence('global', 'R2003'),
    session: requestConfirmationSentence('session', 'RS1'),
    tree: requestConfirmationSentence('tree', 'RT1'),
    thread: requestConfirmationSentence('thread', 'RTH1'),
  }
  assert.match(said.global, /R2003/)
  assert.match(said.global, /every agent on this computer/, 'the global sentence must say how far it reaches')
  assert.match(said.session, /RS1/)
  assert.match(said.session, /this working session/, 'the session sentence must not read as global')
  assert.match(said.tree, /RT1/)
  assert.match(said.tree, /under it/, 'the tree sentence must say it reaches downward only')
  assert.match(said.thread, /RTH1/)
  assert.match(said.thread, /this conversation/, 'the thread sentence must name the conversation and nothing wider')
  for (const sentence of Object.values(said)) {
    assert.ok(!/\n/.test(sentence) && (sentence.match(/\. /g) || []).length <= 1,
      'the chat confirms in ONE sentence — this is a contract, not a style note')
  }
  assert.deepEqual(new Set(REQUEST_COMMANDS.map(command => command.scope)),
    new Set(['global', 'session', 'tree', 'thread']),
    'the request command family must cover each supported scope')
})

test('both chat dispatch seams route a request before anything queues or sends', () => {
  const source = read('src/views/computers.js')
  const card = source.slice(source.indexOf('function treeCardSend'))
  assert.ok(card.indexOf("kind === 'request'") !== -1
    && card.indexOf("kind === 'request'") < card.indexOf('outboxEnqueue'),
    'treeCardSend never routes kind:\'request\' before the queue/send path')
  const queueAdd = source.slice(source.indexOf('add: text => {'))
  assert.ok(queueAdd.indexOf("kind === 'request'") !== -1
    && queueAdd.indexOf("kind === 'request'") < queueAdd.indexOf('outboxEnqueue'),
    'the busy composer path never routes kind:\'request\' — a rule typed while the agent is busy is exactly when it matters')
})
