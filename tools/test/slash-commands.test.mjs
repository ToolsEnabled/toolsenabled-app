import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseSlashCommand,
  queuedMessageEditRefusal,
  requestConfirmationSentence,
  requestUsageSentence,
  slashHelpSentence,
  SLASH_COMMANDS,
  loopUsageSentence,
} from '../../src/slash-commands.js'

test('every user-facing action command maps real caller input to its advertised action', () => {
  const callerActions = new Map([
    ['interrupt', 'interrupt'], ['stop', 'stop'], ['queue', 'queue'], ['move', 'move'],
    ['copy', 'copy-reply'], ['model', 'switch-model'], ['attach', 'attach'], ['mention', 'mention'],
    ['clear', 'clear'], ['rewind', 'rewind'],
  ])
  assert.equal(SLASH_COMMANDS.length, callerActions.size, 'the exported command catalog must contain every caller-supported action once')
  for (const [name, action] of callerActions) {
    assert.deepEqual(
      parseSlashCommand(`  /${name.toUpperCase()}   words from the composer  `),
      { kind: 'action', action, rest: 'words from the composer' },
      `/${name} must dispatch the action its real caller handles and preserve the trimmed argument`,
    )
  }
})

test('only command-shaped input is intercepted, while a typo is refused rather than sent', () => {
  for (const input of [undefined, null, {}, '', 'ordinary message', '/', '/usr/bin/node', '/copy/file', 'C:/notes']) {
    assert.equal(
      parseSlashCommand(input),
      null,
      `non-command input ${JSON.stringify(input)} must remain an ordinary message`,
    )
  }

  const typo = parseSlashCommand('/interupt now')
  assert.equal(typo?.kind, 'unknown', 'a command-shaped typo must produce an explicit refusal')
  assert.match(typo.sentence, /nothing was sent/i, 'the typo refusal must tell the user their words were not sent')
  assert.match(typo.sentence, /\/interrupt\b/, 'the typo refusal must offer the valid command vocabulary')
})

test('help describes every available action and distinguishes other text from commands', () => {
  const help = parseSlashCommand('/help')
  assert.equal(help?.kind, 'help', '/help must produce help instead of becoming a message')
  assert.equal(help.sentence, slashHelpSentence(), '/help must use the exported help sentence')
  for (const command of SLASH_COMMANDS) {
    assert.match(help.sentence, new RegExp(`/${command.name}\\b`), `help must name the available /${command.name} command`)
  }
  assert.match(help.sentence, /everything else sends as a message/i, 'help must explain that non-command text is still sent')
})

test('a waiting message cannot be rewritten into a command, and ordinary words still pass', () => {
  /* THE PARSE MUST HOLD ON THE THIRD DOOR TOO. The up-arrow walk
     (src/composer-queue-recall.js) writes into the session outbox, and a
     queued message is drained STRAIGHT TO THE MODEL when the turn ends -- so a
     command written into a waiting message would reach the agent as ordinary
     text with every check those words exist to trigger skipped. The other two
     doors (treeCardSend and the busy composer's queue.add) already parse. */
  for (const command of [
    '/interrupt', '/stop', '/queue do the thing', '/clear', '/rewind',
    '/goal R-42 rebuild the payload', '/Request never touch the vault',
    '/loop', '/loop 5',
    '/RequestThread keep it short', '/help', '/notacommand',
    '  /INTERRUPT  ',
  ]) {
    const refusal = queuedMessageEditRefusal(command)
    assert.equal(typeof refusal, 'string', `${command} was allowed into a waiting message`)
    assert.match(refusal, /not a waiting message/, `${command} must be refused in words, never silently rewritten`)
    assert.match(refusal, /Unqueue/, 'the refusal must name the way through -- a dead end is the defect this gate keeps re-finding')
  }

  for (const ordinary of [
    'read the report and summarise it',
    'C:/Users/ToolsEnabled-Dev/notes.md is the file',
    '/usr/bin/thing is the path I meant',
    'use the / key for commands',
    '',
  ]) {
    assert.equal(queuedMessageEditRefusal(ordinary), null,
      `an ordinary message was refused: ${JSON.stringify(ordinary)}`)
  }
})

test('loop opens setup with an optional minute interval, including the supported boundaries', () => {
  assert.deepEqual(parseSlashCommand('/loop'), { kind: 'loop', minutes: null })
  for (const [input, minutes] of [
    ['/loop 1', 1], ['/loop 5', 5], ['/LOOP 7m', 7],
    ['/loop 30 min', 30], ['/loop 120 minutes', 120], ['/loop 240', 240],
  ]) assert.deepEqual(parseSlashCommand(input), { kind: 'loop', minutes })
  assert.match(slashHelpSentence(), /Common functions: \/goal[^.]*\/loop/)
})

test('loop refuses invalid intervals instead of silently changing or sending them', () => {
  for (const input of ['/loop 0', '/loop -5', '/loop 1.5', '/loop 241', '/loop Infinity', '/loop 5 check files', '/loop 1h']) {
    assert.deepEqual(parseSlashCommand(input), { kind: 'loop', sentence: loopUsageSentence() }, input)
  }
})

test('request copy states non-filing, usage, identifier, and the selected reach', () => {
  const scopes = [
    ['global', '/Request', 'every agent on this computer'],
    ['session', '/RequestSession', 'this working session'],
    ['tree', '/RequestTree', 'under it'],
    ['thread', '/RequestThread', 'this conversation'],
  ]

  for (const [scope, spoken, reach] of scopes) {
    const usage = requestUsageSentence(scope)
    assert.match(usage, /nothing was filed/i, `${spoken} empty-input copy must say that no rule was filed`)
    assert.match(usage, new RegExp(spoken), `${spoken} empty-input copy must show the command to retry`)

    const confirmation = requestConfirmationSentence(scope, 'R-42')
    assert.match(confirmation, /R-42/, `${spoken} confirmation must name the filed rule identifier`)
    assert.match(confirmation, new RegExp(reach), `${spoken} confirmation must explain the rule's reach`)
  }
})
