/* THE /TASK AND /ASK FAMILIES IN THE CHAT BOX — built the same way as the
 * /Request family (see request-commands.test.mjs), for the ledger's T and A
 * subsets (Controller 3's shared interface, 2026-09-07, quoting the owner:
 * "T for tasks, these can be recurring loop tasks or tasks that have a
 * definitve completion - these tasks can be completed and removed by
 * agents; Asks for things agents need from the owner"). Four scopes each,
 * eight commands, typed right where the person is already talking to an
 * agent. The PRODUCT files the words; the agent needs no tool for it and
 * just sees the confirmation.
 *
 * What these tests hold:
 *   - the eight commands parse to kind:'task' / kind:'ask' with the right
 *     scope and the person's words untouched;
 *   - an empty task or ask refuses with a usage sentence and files nothing;
 *   - the confirmation sentence states the SCOPE honestly, the same way the
 *     /Request confirmations do;
 *   - the help sentence teaches both families;
 *   - the chat dispatch seams in src/views/computers.js route kind:'task' and
 *     kind:'ask' before anything queues or sends (source pin, same style as
 *     the /Request pin — the view imports stylesheets and cannot load under
 *     node).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  parseSlashCommand,
  slashHelpSentence,
  TASK_COMMANDS,
  ASK_COMMANDS,
  taskUsageSentence,
  taskConfirmationSentence,
  askUsageSentence,
  askConfirmationSentence,
} from '../../src/slash-commands.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = file => readFileSync(resolve(ROOT, file), 'utf8')

test('the four task commands parse to their scopes with the words untouched', () => {
  assert.deepEqual(parseSlashCommand('/Task Write up the release notes.'),
    { kind: 'task', scope: 'global', rest: 'Write up the release notes.' })
  assert.deepEqual(parseSlashCommand('/TaskSession clear the test scratch folder'),
    { kind: 'task', scope: 'session', rest: 'clear the test scratch folder' })
  assert.deepEqual(parseSlashCommand('/TaskTree rotate the staging credentials'),
    { kind: 'task', scope: 'tree', rest: 'rotate the staging credentials' })
  assert.deepEqual(parseSlashCommand('/TaskThread Check the build every morning.'),
    { kind: 'task', scope: 'thread', rest: 'Check the build every morning.' })
  /* Case-insensitive like every command here. */
  assert.equal(parseSlashCommand('/taskthread task').scope, 'thread')
})

test('the four ask commands parse to their scopes with the words untouched', () => {
  assert.deepEqual(parseSlashCommand('/Ask Which cloud account should this use?'),
    { kind: 'ask', scope: 'global', rest: 'Which cloud account should this use?' })
  assert.deepEqual(parseSlashCommand('/AskSession Should this session keep going overnight?'),
    { kind: 'ask', scope: 'session', rest: 'Should this session keep going overnight?' })
  assert.deepEqual(parseSlashCommand('/AskTree Is this tree allowed to spend money?'),
    { kind: 'ask', scope: 'tree', rest: 'Is this tree allowed to spend money?' })
  assert.deepEqual(parseSlashCommand('/AskThread Should this conversation wait for review?'),
    { kind: 'ask', scope: 'thread', rest: 'Should this conversation wait for review?' })
  assert.equal(parseSlashCommand('/askthread question').scope, 'thread')
})

test('an empty task or ask refuses with usage, and unknown input keeps its refusal', () => {
  const emptyTask = parseSlashCommand('/TaskTree')
  assert.equal(emptyTask.kind, 'task')
  assert.equal(emptyTask.rest, '')
  const taskUsage = taskUsageSentence('tree')
  assert.match(taskUsage, /\/TaskTree/, 'the usage sentence does not name the command that was typed')
  assert.match(taskUsage, /[Nn]othing was filed/, 'the usage sentence does not say nothing was filed')

  const emptyAsk = parseSlashCommand('/AskTree')
  assert.equal(emptyAsk.kind, 'ask')
  assert.equal(emptyAsk.rest, '')
  const askUsage = askUsageSentence('tree')
  assert.match(askUsage, /\/AskTree/, 'the usage sentence does not name the command that was typed')
  assert.match(askUsage, /[Nn]othing was filed/, 'the usage sentence does not say nothing was filed')

  const unknownTask = parseSlashCommand('/tasktrees be careful')
  assert.equal(unknownTask.kind, 'unknown', 'a near-miss must stay the honest refusal, not file into a guessed scope')
  assert.match(unknownTask.sentence, /not a command here/)
  const unknownAsk = parseSlashCommand('/asktrees be careful')
  assert.equal(unknownAsk.kind, 'unknown')
  assert.match(unknownAsk.sentence, /not a command here/)
})

test('the help sentence teaches both families', () => {
  assert.match(slashHelpSentence(), /\/Task\b/, 'help never names /Task')
  assert.match(slashHelpSentence(), /\/TaskThread/, 'help never names the scoped task commands')
  assert.match(slashHelpSentence(), /\/Ask\b/, 'help never names /Ask')
  assert.match(slashHelpSentence(), /\/AskThread/, 'help never names the scoped ask commands')
})

test('each task confirmation sentence states its scope honestly', () => {
  const said = {
    global: taskConfirmationSentence('global', 'T2003'),
    session: taskConfirmationSentence('session', 'TS1'),
    tree: taskConfirmationSentence('tree', 'TT1'),
    thread: taskConfirmationSentence('thread', 'TTH1'),
  }
  assert.match(said.global, /T2003/)
  assert.match(said.global, /every agent on this computer/, 'the global sentence must say how far it reaches')
  assert.match(said.session, /TS1/)
  assert.match(said.session, /this working session/, 'the session sentence must not read as global')
  assert.match(said.tree, /TT1/)
  assert.match(said.tree, /under it/, 'the tree sentence must say it reaches downward only')
  assert.match(said.thread, /TTH1/)
  assert.match(said.thread, /this conversation/, 'the thread sentence must name the conversation and nothing wider')
  for (const sentence of Object.values(said)) {
    assert.ok(!/\n/.test(sentence) && (sentence.match(/\. /g) || []).length <= 1,
      'the chat confirms in ONE sentence — this is a contract, not a style note')
  }
  assert.deepEqual(new Set(TASK_COMMANDS.map(command => command.scope)),
    new Set(['global', 'session', 'tree', 'thread']),
    'the task command family must cover each supported scope')
})

test('each ask confirmation sentence states its scope honestly', () => {
  const said = {
    global: askConfirmationSentence('global', 'A2003'),
    session: askConfirmationSentence('session', 'AS1'),
    tree: askConfirmationSentence('tree', 'AT1'),
    thread: askConfirmationSentence('thread', 'ATH1'),
  }
  assert.match(said.global, /A2003/)
  assert.match(said.global, /every agent on this computer/, 'the global sentence must say how far it reaches')
  assert.match(said.session, /AS1/)
  assert.match(said.session, /this working session/, 'the session sentence must not read as global')
  assert.match(said.tree, /AT1/)
  assert.match(said.tree, /under it/, 'the tree sentence must say it reaches downward only')
  assert.match(said.thread, /ATH1/)
  assert.match(said.thread, /this conversation/, 'the thread sentence must name the conversation and nothing wider')
  for (const sentence of Object.values(said)) {
    assert.ok(!/\n/.test(sentence) && (sentence.match(/\. /g) || []).length <= 1,
      'the chat confirms in ONE sentence — this is a contract, not a style note')
  }
  assert.deepEqual(new Set(ASK_COMMANDS.map(command => command.scope)),
    new Set(['global', 'session', 'tree', 'thread']),
    'the ask command family must cover each supported scope')
})

test('both chat dispatch seams route a task or an ask before anything queues or sends', () => {
  const source = read('src/views/computers.js')
  const card = source.slice(source.indexOf('function treeCardSend'))
  assert.ok(card.indexOf("kind === 'task'") !== -1
    && card.indexOf("kind === 'task'") < card.indexOf('outboxEnqueue'),
    'treeCardSend never routes kind:\'task\' before the queue/send path')
  assert.ok(card.indexOf("kind === 'ask'") !== -1
    && card.indexOf("kind === 'ask'") < card.indexOf('outboxEnqueue'),
    'treeCardSend never routes kind:\'ask\' before the queue/send path')
  const queueAdd = source.slice(source.indexOf('add: text => {'))
  assert.ok(queueAdd.indexOf("kind === 'task'") !== -1
    && queueAdd.indexOf("kind === 'task'") < queueAdd.indexOf('outboxEnqueue'),
    'the busy composer path never routes kind:\'task\'')
  assert.ok(queueAdd.indexOf("kind === 'ask'") !== -1
    && queueAdd.indexOf("kind === 'ask'") < queueAdd.indexOf('outboxEnqueue'),
    'the busy composer path never routes kind:\'ask\'')
})

/* A TASK IS NOT A RULE (T1266): it is completed or deleted, never edited, so
   its confirmation says so and never borrows the standing rule's words. */
test('a task confirmation never promises an edit or calls the task a rule, and says where it is completed', () => {
  for (const scope of ['global', 'session', 'tree', 'thread']) {
    const sentence = taskConfirmationSentence(scope, 'T1')
    assert.doesNotMatch(sentence, /\bedit\b|\brule\b|until you/i, `${scope}: ${sentence}`)
    assert.match(sentence, /mark it complete or delete it on the Ledger page\.$/, `${scope}: ${sentence}`)
  }
})
