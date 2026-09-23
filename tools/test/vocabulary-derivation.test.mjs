import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { ROLES, PROVIDERS } from '../../src/vocab.js'
import { NODE_STATUS_WORDS, PALETTE_PANEL } from '../../src/fleet-tree-copy.js'
import { EXAMPLE_BADGE } from '../../src/comms-copy.js'
import { NO_SENDER_WIRED, UPTIME_UNITS } from '../../src/chat-copy.js'

// Remove comments without mistaking comment markers inside strings for comments.
function stripComments(source) {
  let result = ''
  let quote = null
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (quote) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      result += char
    } else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      result += '\n'
    } else if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 1
    } else {
      result += char
    }
  }
  return result
}

const identifierFor = value => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function production(path) {
  return stripComments(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'))
}

async function assertDerived(path, owner, badValues) {
  const source = await production(path)
  assert.match(source, new RegExp(`import\\s*\\{[^}]*\\b${owner}\\b[^}]*\\}\\s*from`), `${path} must import owner export ${owner}`)

  for (const badValue of badValues) {
    const quoted = new RegExp(`(['"\\\`])${escapeRegExp(badValue)}\\1`)
    assert.doesNotMatch(source, quoted, `${path} must reject exact re-typing of ${JSON.stringify(badValue)}`)

    const identifier = identifierFor(badValue)
    const localIdentifier = new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*['\"\\\`[]`, 'i')
    assert.doesNotMatch(source, localIdentifier, `${path} must reject identifier re-typing of ${JSON.stringify(badValue)} as ${identifier}`)

    const constructed = badValue.split(' ').map(escapeRegExp).join(`(?:['"\\\`]\\s*\\+\\s*['"\\\`]|\\s+)`)
    assert.doesNotMatch(source, new RegExp(`(['"\\\`])${constructed}\\1`), `${path} must reject a constructed re-typing of ${JSON.stringify(badValue)}`)
  }
}

test('coordinator labels derive from ROLES', async () => {
  await assertDerived('src/home-chat-takeover.js', 'ROLES', [ROLES.coordinator.label])
})

test('home activity status and unanswered copy derive from fleet-tree copy', async () => {
  await assertDerived('src/local-activity.js', 'NODE_STATUS_WORDS', [NODE_STATUS_WORDS.failed])
  await assertDerived('src/local-activity.js', 'PALETTE_PANEL', [PALETTE_PANEL.whyNoReply])
})

test('example badges derive from comms copy', async () => {
  await assertDerived('src/local-activity.js', 'EXAMPLE_BADGE', [EXAMPLE_BADGE])
  await assertDerived('src/approvals-example.js', 'EXAMPLE_BADGE', [EXAMPLE_BADGE])
})

test('agent no-sender refusal derives from chat copy', async () => {
  await assertDerived('src/views/agent.js', 'NO_SENDER_WIRED', [NO_SENDER_WIRED])
})

test('home uptime labels derive from chat copy', async () => {
  await assertDerived('src/views/home.js', 'UPTIME_UNITS', Object.values(UPTIME_UNITS))
})

test('local metrics provider labels derive from vocab without changing the local concept', async () => {
  await assertDerived('src/local-metrics.js', 'PROVIDERS', PROVIDERS.filter(({ id }) => id !== 'local').map(({ label }) => label))
})

/* THE ONE THAT MAY NOT DERIVE, AND IS STILL HELD TO THE SAME WORDS.
 *
 * metrics-live-charts.js types these labels out. Importing them would be the
 * consistent move everywhere else in this file, and here it is forbidden:
 * tools/test/metrics-live-charts.test.mjs fences that module off from vocab.js
 * at any import depth, because vocab.js is the declared fleet the demonstration
 * builds its series out of and a path to it is a path a simulated series could
 * travel into a measured chart. That fence caught this exact import and is the
 * reason the duplicate stands.
 *
 * So the defect the derivation rule exists to stop -- two copies drifting apart
 * -- is caught by VALUE instead. The bad value: editing either table alone. This
 * reads the module's own map out of its source and compares it to vocab's, so a
 * label changed in one place and not the other turns this red without either
 * file importing the other. */
test('the fenced chart module may not import vocab, and must still agree with it word for word', async () => {
  const source = await readFile(new URL('../../src/metrics-live-charts.js', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /from\s+['"]\.\/vocab\.js['"]/,
    'metrics-live-charts.js must not import vocab.js -- the simulation fence in metrics-live-charts.test.mjs forbids it at any depth')

  const literal = source.match(/const PROVIDER_LABELS = Object\.freeze\(\{([^}]*)\}\)/)
  assert.ok(literal, 'PROVIDER_LABELS is no longer a frozen object literal in metrics-live-charts.js, so this comparison read nothing')
  const typed = new Map()
  for (const [, id, label] of literal[1].matchAll(/(\w[\w-]*)\s*:\s*'([^']*)'/g)) typed.set(id, label)
  assert.ok(typed.size >= 2, `the map parsed to ${typed.size} entries, which cannot be right`)

  for (const { id, label } of PROVIDERS) {
    if (id === 'local') continue // deliberately a different concept here: the computer, not the vendor
    if (!typed.has(id)) continue // an id this chart does not carry is not drift
    assert.equal(typed.get(id), label,
      `metrics-live-charts.js calls ${id} ${JSON.stringify(typed.get(id))} while vocab.js calls it ${JSON.stringify(label)}`)
  }

  /* The local label is the one that must NOT match vocab's, or the exemption
     above has quietly stopped being true. */
  assert.notEqual(typed.get('local'), PROVIDERS.find(({ id }) => id === 'local').label,
    'the local label now matches the vocab label, so it is no longer the separate concept this exemption is written for')
})
