import assert from 'node:assert/strict'
import test from 'node:test'

import { sampleOpsEnvelope, sampleCommsJournal } from '../../src/sample-comms.js'
import { readSchema, validateAgainstSchema } from '../gen-projection-lib.mjs'

/* A fixed instant, so a failure reproduces byte-for-byte on any machine. The
   module itself must not care what the instant is; determinism is asserted
   separately below. */
const NOW = Date.parse('2026-08-20T12:00:00.000Z')

test('the channel demonstration exercises real recipient, reply, and delivery metadata', () => {
  const data = sampleCommsJournal(NOW), byId = new Map(data.messages.value.map(message => [message.id, message]))
  assert.equal(data.messages.ok, true)
  assert.equal(data.messages.value.filter(message => message.deliveryState === 'unconfirmed').length, 1)
  for (const message of data.messages.value) {
    assert.ok(message.senderId && message.recipientId)
    assert.ok(message.sender && message.recipient)
    assert.ok(Date.parse(message.at) <= NOW)
    if (message.causalParent) assert.equal(byId.get(message.causalParent)?.kind, 'ask')
    assert.equal(message.grantsAuthority, false)
  }
})

const OPS_SCHEMA = readSchema('ops')

/* The legal channel states are read FROM the schema rather than copied into
   this file, so the assertion can never drift from the authority. The sanity
   check that the enum still contains 'healthy' guards against the read
   silently landing on the wrong node after a schema refactor. */
const LEGAL_CHANNEL_STATES = OPS_SCHEMA.$defs?.channel?.properties?.state?.enum
assert.ok(Array.isArray(LEGAL_CHANNEL_STATES) && LEGAL_CHANNEL_STATES.includes('healthy'),
  'ops.schema.json no longer carries the channel state enum where this suite reads it')

test('envelope carries all four parts, each readable, each the right element shape', () => {
  const envelope = sampleOpsEnvelope(NOW)

  assert.deepEqual(Object.keys(envelope).sort(), ['channels', 'declaredServices', 'mcp', 'messages'])

  assert.ok(Array.isArray(envelope.declaredServices), 'declaredServices is an array')
  assert.ok(envelope.declaredServices.length >= 2, 'a couple of services on record')
  for (const service of envelope.declaredServices) {
    assert.equal(typeof service.id, 'string')
    assert.ok(service.id.length > 0)
    assert.equal(typeof service.displayName, 'string')
    assert.ok(service.displayName.length > 0)
    assert.equal(typeof service.transport, 'string')
    assert.ok(Number.isInteger(service.port) && service.port >= 1 && service.port <= 65535)
    assert.ok(['fixed', 'peer', 'self', 'loopback'].includes(service.resolution))
  }

  assert.equal(envelope.channels.ok, true)
  assert.equal(envelope.channels.reason, null)
  assert.ok(Array.isArray(envelope.channels.value), 'channels observed')
  assert.ok(envelope.channels.value.length > 0)
  for (const channel of envelope.channels.value) {
    assert.equal(typeof channel.id, 'string')
    assert.equal(typeof channel.name, 'string')
    assert.ok(LEGAL_CHANNEL_STATES.includes(channel.state),
      `channel ${channel.id} state '${channel.state}' is outside the schema's enum`)
    assert.ok(channel.observedAt === null || Number.isFinite(Date.parse(channel.observedAt)))
    assert.ok(channel.detail === null || typeof channel.detail === 'string')
  }

  assert.equal(envelope.mcp.ok, true)
  assert.equal(envelope.mcp.reason, null)
  assert.ok(Array.isArray(envelope.mcp.value.live), 'live tool links')
  assert.ok(Array.isArray(envelope.mcp.value.dead), 'dead tool links')
  assert.ok(envelope.mcp.value.live.length >= 2, 'a couple live')
  assert.ok(envelope.mcp.value.dead.length >= 1, 'one dead')
  for (const name of [...envelope.mcp.value.live, ...envelope.mcp.value.dead]) {
    assert.equal(typeof name, 'string')
    assert.ok(name.length > 0)
  }

  assert.equal(envelope.messages.ok, true)
  assert.equal(envelope.messages.reason, null)
  assert.ok(Array.isArray(envelope.messages.value), 'messages read')
  assert.ok(envelope.messages.value.length > 0)
  /* Messages must land in a channel the envelope itself declares:
     applyLiveProjection's messageRows filters by the declared-service id and
     the observed-channel id, so a channelId outside both sets renders
     nowhere -- prose that silently vanishes from the page. */
  const landings = new Set([
    ...envelope.channels.value.map((channel) => channel.id),
    ...envelope.declaredServices.map((service) => service.id),
  ])
  for (const message of envelope.messages.value) {
    assert.equal(typeof message.sender, 'string')
    assert.ok(message.sender.length > 0)
    assert.equal(typeof message.text, 'string')
    assert.ok(message.text.length > 0)
    assert.equal(typeof message.id, 'string')
    assert.ok(message.id.length > 0)
    assert.ok(Number.isFinite(Date.parse(message.at)), `message ${message.id} carries a parseable at`)
    assert.ok(landings.has(message.channelId),
      `message ${message.id} lands in undeclared channel '${message.channelId}'`)
    assert.equal(message.contentTrust, 'untrusted')
    assert.equal(message.grantsAuthority, false)
  }
})

test('envelope validates against the ops schema data contract', () => {
  /* The contract circulated for this module described messages as
     {sender, t, at, channelId}; the schema and the consumer both say `text`
     (comms.js messageRows reads message.text) plus id/contentTrust/
     grantsAuthority, with `at` a date-time string. The schema is the
     authority, so that is what this suite enforces. */
  const errors = validateAgainstSchema(sampleOpsEnvelope(NOW), { $ref: '#/$defs/data' }, OPS_SCHEMA, '$.data')
  assert.deepEqual(errors, [], 'ops.schema.json $defs/data accepts the envelope')
})

test('same nowMs, same envelope', () => {
  assert.deepEqual(sampleOpsEnvelope(NOW), sampleOpsEnvelope(NOW))
  /* And a fresh structure each call, not a shared one a consumer could
     mutate into the next render. */
  const a = sampleOpsEnvelope(NOW)
  const b = sampleOpsEnvelope(NOW)
  assert.notEqual(a, b)
  assert.notEqual(a.messages.value, b.messages.value)
})

test('every timestamp derives from nowMs, in the past, newest-last', () => {
  const envelope = sampleOpsEnvelope(NOW)

  const stamps = envelope.messages.value.map((message) => Date.parse(message.at))
  for (const stamp of stamps) assert.ok(stamp <= NOW, 'no message from the future')
  /* Newest-LAST, because that is the order the render expects: on the live
     path nothing sorts (messageRows filters in envelope order; the only
     .sort in comms.js belongs to the non-live board seeder) and renderLog
     appends in array order then pins the scroll to the bottom, so the last
     element is the one presented as the latest word. */
  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok(stamps[i] >= stamps[i - 1], `messages ascend by at (index ${i})`)
  }

  for (const part of [envelope.channels, envelope.mcp, envelope.messages]) {
    const stamp = Date.parse(part.observedAt)
    assert.ok(Number.isFinite(stamp) && stamp <= NOW, 'observation stamps sit in the past')
  }
  for (const channel of envelope.channels.value) {
    if (channel.observedAt !== null) assert.ok(Date.parse(channel.observedAt) <= NOW)
  }

  /* Shifting nowMs shifts the record with it: nothing inside is pinned to a
     wall-clock date that would age out of "the past". */
  const shifted = sampleOpsEnvelope(NOW + 60_000)
  assert.equal(
    Date.parse(shifted.messages.value[0].at) - Date.parse(envelope.messages.value[0].at),
    60_000,
  )

  /* The zero-argument form stays usable, mirroring sample-activity.js. */
  assert.equal(sampleOpsEnvelope().messages.ok, true)
})

test('no sample message opens with an UPPERCASE key', () => {
  /* "BLOCKER: …" was the one line on the example board written like a log
     level rather than a sentence a person would say; the rest of the sample
     fleet's prose is plain speech. A shouted key teaches the reader that the
     board is console output. */
  for (const message of sampleOpsEnvelope(NOW).messages.value) {
    assert.doesNotMatch(message.text, /^[A-Z]{2,}:/, `${message.id} opens with an uppercase key`)
  }
})
