import assert from 'node:assert/strict'
import { register } from 'node:module'
import { createTranscriptStore } from '../../../src/session-transcript-store.js'
import { enqueue as enqueueOutbox, list as listOutbox, clearSession as clearOutbox } from '../../../src/session-outbox.js'
import {
  COMPUTER_ID,
  fleetFetch,
  installWorld,
  mountView,
  seedTreeNode,
  settle,
} from './tree-command-real-mount.mjs'

register('../helpers/css-stub-loader.mjs', import.meta.url)

export const T1174_NODE = 't1174-image-node'
export const T1174_PREDECESSOR = 't1174-image-predecessor'
export const T1174_SUCCESSOR = 't1174-image-successor'
export const T1174_START_THREAD = 't1174-start-thread'
export const T1174_THREAD = 't1174-accepted-thread'
export const T1174_UNKNOWN_ENVELOPE = 't1174-unknown-envelope'
export const T1174_ORDINARY_ENVELOPE = 't1174-ordinary-envelope'
export const T1174_OWNER = Object.freeze({
  version: 1,
  ownerId: 't1174-synthetic-owner',
  currentEpoch: 't1174-synthetic-epoch-1',
  kind: 'local',
})

const CREATED_AT = '2026-09-06T04:51:00.000Z'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function snapshot(destinationSessionId, generation, entries) {
  return {
    version: 1,
    generation,
    destinationSessionId,
    automaticSend: false,
    entries: entries.map(entry => ({ ...entry })),
  }
}

function transcriptStorage(world) {
  return {
    read(key) {
      const raw = world.storage.getItem(key)
      return raw ? JSON.parse(raw) : null
    },
    write(key, value) {
      world.storage.setItem(key, JSON.stringify(value))
      return true
    },
  }
}

function makeTranscriptBridge({ image, holdSave = false, mutateDuringTranscriptSave = null } = {}) {
  const records = new Map()
  let held = false
  const recordFor = nodeId => records.get(nodeId) || {
    nodeId,
    threadId: null,
    effort: null,
    provider: null,
    account: null,
    lines: [],
  }
  return {
    onError() { return () => {} },
    async list() {
      return {
        ok: true,
        records: [...records.values()].map(({ lines, ...metadata }) => ({ ...metadata })),
      }
    },
    async read({ nodeId }) {
      const record = recordFor(nodeId)
      return {
        ok: true,
        metadata: { ...record, lines: undefined },
        entries: record.lines.map(line => ({ ...line })),
        before: null,
      }
    },
    async append({ nodeId, entries = [], metadata = {} }) {
      const prior = recordFor(nodeId)
      records.set(nodeId, {
        ...prior,
        ...metadata,
        nodeId,
        lines: [...prior.lines, ...entries.map(line => ({ ...line }))],
      })
      // The coordinator's pre-start save has no threadId. The later recording
      // save still calls append with an empty changed-line set, but carries the
      // distinct native-start threadId. Hold that awaited save so the fixture
      // can invalidate the prepared owner before handoff publication.
      if (holdSave && !held && metadata.threadId === T1174_START_THREAD) {
        held = true
        return image.holdTranscriptSave(mutateDuringTranscriptSave)
      }
      return { ok: true }
    },
    async bind() { return { ok: true } },
  }
}

function nodeFromStorage(world) {
  const raw = world.storage.getItem('mc.fleet.trees.v1:' + COMPUTER_ID)
  const document = raw ? JSON.parse(raw) : null
  return document?.nodes?.find(node => node.id === T1174_NODE) || null
}

function statusNote(view) {
  return [...(view?.el?.querySelectorAll?.('[data-tree-status-note]') || [])]
    .map(element => element.textContent || '')
    .join(' ')
    .trim()
}

async function until(check, message) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

function queueEntry(id, text = 'retained synthetic image') {
  return {
    envelopeId: id,
    state: 'not-sent',
    text,
    imageReceipts: [{ imageCount: 1, imageId: id + '-bytes' }],
  }
}

function makeBridge(world, {
  mode,
  initialEntries,
  mutateDuringStart = null,
  mutateDuringTranscriptSave = null,
  onPrepareRead = null,
} = {}) {
  let queue = snapshot(T1174_PREDECESSOR, 'generation-source', initialEntries)
  let owner = T1174_OWNER
  let transcriptSavePending = false
  let releaseTranscriptSave = null
  const ownerListeners = new Set()
  const eventListeners = new Set()
  const gate = deferred()
  const imageCalls = []
  const starts = []
  const closes = []
  const handoffSends = []
  const dispatches = []
  const unknownResponses = []
  const identityResponses = []
  const authorityResponses = []
  const incompleteResponses = []
  let prepareReadTriggered = false

  const changeOwner = next => {
    owner = next
    for (const listener of [...ownerListeners]) listener(owner)
  }

  const holdTranscriptSave = mutate => new Promise(resolve => {
    transcriptSavePending = true
    releaseTranscriptSave = () => {
      releaseTranscriptSave = null
      transcriptSavePending = false
      mutate?.({ changeOwner })
      resolve({ ok: true })
    }
  })

  const bridge = world.bridge
  bridge.ownerContext = async () => owner
  bridge.onOwnerContextChanged = listener => {
    ownerListeners.add(listener)
    return () => ownerListeners.delete(listener)
  }
  bridge.onEvent = listener => {
    eventListeners.add(listener)
    return () => eventListeners.delete(listener)
  }
  bridge.close = async request => {
    closes.push({ ...request })
    return { ok: true, closed: true, sessionId: request.sessionId }
  }
  bridge.start = async request => {
    starts.push({ ...request, threadId: T1174_START_THREAD })
    mutateDuringStart?.({
      queue: structuredClone(queue),
      replaceQueue(next) { queue = next },
      changeOwner,
      emit(packet) {
        for (const listener of [...eventListeners]) listener(packet)
      },
    })
    await gate.promise
    return { ok: true, sessionId: T1174_SUCCESSOR, threadId: T1174_START_THREAD }
  }
  bridge.send = async () => ({ ok: true, turnId: 't1174-person-turn' })
  bridge.sendAutomatic = async request => {
    handoffSends.push({ ...request })
    if (mode === 'handoff-refusal') {
      return {
        ok: false,
        code: 'AGENT_AUTOMATIC_DELIVERY_REFUSED',
        deliveryDisposition: 'not-sent',
        result: { ok: false },
      }
    }
    return {
      ok: true,
      deliveryDisposition: 'accepted',
      result: { ok: true, threadId: T1174_THREAD },
    }
  }
  bridge.updateTreeAddress = async () => ({ ok: true })
  bridge.sessionActivity = async () => ({ ok: true, busy: false, closing: false, turnsCompleted: 0 })
  bridge.models = async () => ({ provider: 'claude', catalogSupported: true, models: [] })
  bridge.history = async () => ({ ok: true, entries: [] })
  bridge.availability = async () => ({ ok: true, available: true })
  bridge.ledger = async () => ({ ok: true, records: [] })
  bridge.imageQueue = async request => {
    imageCalls.push({
      operation: request.operation,
      conversationId: request.conversationId,
      sourceSessionId: request.sourceSessionId,
      destinationSessionId: request.destinationSessionId || request.sessionId || null,
      envelopeId: request.envelopeId || null,
    })
    if (request.operation === 'binding') {
      return {
        ok: true,
        operation: 'binding',
        result: {
          sessionId: request.sessionId,
          conversationId: T1174_NODE,
          ownerContext: T1174_OWNER,
        },
      }
    }
    if (request.operation === 'read') {
      if (!prepareReadTriggered) {
        const prepared = await onPrepareRead?.()
        if (prepared !== false) prepareReadTriggered = true
      }
      return { ok: true, operation: 'read', result: structuredClone(queue) }
    }
    if (request.operation === 'preview') {
      const entry = queue.entries.find(row => row.envelopeId === request.envelopeId)
      assert.ok(entry, 'the mounted image row must retain its envelope')
      return {
        ok: true,
        operation: 'preview',
        result: {
          version: 1,
          envelopeId: entry.envelopeId,
          automaticSend: false,
          thumbnail: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
          imageCount: entry.imageReceipts?.[0]?.imageCount || 1,
        },
      }
    }
    if (request.operation === 'transfer') {
      if (mode === 'currentness-refusal') {
        return { ok: false, code: 'IMAGE_RECOVERY_STALE' }
      }
      assert.equal(request.expectedDestinationSessionId, T1174_PREDECESSOR)
      assert.equal(request.destinationSessionId, T1174_SUCCESSOR)
      assert.equal(request.expectedGeneration, queue.generation)
      queue = snapshot(T1174_SUCCESSOR, 'generation-successor', queue.entries)
      return { ok: true, operation: 'transfer', result: structuredClone(queue) }
    }
    if (request.operation === 'dispatch') {
      const entry = queue.entries.find(row => row.envelopeId === request.envelopeId)
      assert.ok(entry, 'the mounted coordinator must name a retained image envelope')
      assert.equal(entry.state, 'not-sent')
      assert.equal(request.sessionId, T1174_SUCCESSOR)
      if (mode === 'unknown-refusal' && entry.envelopeId === T1174_UNKNOWN_ENVELOPE) {
        const response = {
          ok: false,
          operation: 'dispatch',
          code: 'IMAGE_DELIVERY_UNKNOWN',
          deliveryDisposition: 'unknown',
          dispatchStarted: false,
          retryable: false,
          retained: true,
          replay: false,
          ownerContext: T1174_OWNER,
          conversationId: T1174_NODE,
          sessionId: T1174_SUCCESSOR,
          envelopeId: entry.envelopeId,
          result: structuredClone(queue),
        }
        unknownResponses.push({
          envelopeId: entry.envelopeId,
          code: response.code,
          replay: response.replay,
          state: entry.state,
        })
        return response
      }
      if (mode === 'authority-terminal-refusal') {
        // This is a native-style terminal response with a valid not-sent
        // snapshot and matching identity. The authority code must remain
        // fatal; terminal disposition fields cannot turn it into a queue-only
        // refusal. It travels through the real binder/transfer path.
        const response = {
          ok: false,
          operation: 'dispatch',
          code: 'IMAGE_CUSTODY_CANDIDATE_REFUSED',
          deliveryDisposition: 'not-sent',
          dispatchStarted: false,
          candidateCreated: false,
          retryable: false,
          retained: true,
          replay: false,
          ownerContext: T1174_OWNER,
          conversationId: T1174_NODE,
          sessionId: T1174_SUCCESSOR,
          envelopeId: entry.envelopeId,
          result: structuredClone(queue),
        }
        authorityResponses.push({
          envelopeId: entry.envelopeId,
          responseCode: response.code,
          responseSessionId: response.sessionId,
          deliveryDisposition: response.deliveryDisposition,
          dispatchStarted: response.dispatchStarted,
          candidateCreated: response.candidateCreated,
          replay: response.replay,
        })
        return response
      }
      if (mode === 'dispatch-identity-refusal') {
        const response = {
          ok: false,
          operation: 'dispatch',
          code: 'IMAGE_DELIVERY_NOT_SENT',
          deliveryDisposition: 'not-sent',
          dispatchStarted: false,
          retryable: false,
          retained: true,
          replay: false,
          ownerContext: T1174_OWNER,
          conversationId: T1174_NODE,
          sessionId: T1174_PREDECESSOR,
          envelopeId: entry.envelopeId,
          result: structuredClone(queue),
        }
        identityResponses.push({
          envelopeId: entry.envelopeId,
          responseCode: response.code,
          responseSessionId: response.sessionId,
          replay: response.replay,
          retained: response.retained,
        })
        return response
      }
      if (mode === 'drain-incomplete-refusal' || mode === 'source-changed-incomplete-drain-refusal') {
        const response = {
          ok: false,
          operation: 'dispatch',
          code: mode === 'source-changed-incomplete-drain-refusal'
            ? 'IMAGE_RECOVERY_SOURCE_CHANGED' : 'IMAGE_RECOVERY_DRAIN_REFUSED',
        }
        incompleteResponses.push({
          envelopeId: entry.envelopeId,
          responseCode: response.code,
          hasDisposition: Object.prototype.hasOwnProperty.call(response, 'deliveryDisposition'),
          hasResult: Object.prototype.hasOwnProperty.call(response, 'result'),
        })
        return response
      }
      if (mode === 'drain-refusal') {
        return {
          ok: false,
          operation: 'dispatch',
          code: 'IMAGE_RECOVERY_DRAIN_REFUSED',
          deliveryDisposition: 'not-sent',
          dispatchStarted: false,
          retryable: false,
          retained: true,
          replay: false,
          ownerContext: T1174_OWNER,
          conversationId: T1174_NODE,
          sessionId: T1174_SUCCESSOR,
          envelopeId: entry.envelopeId,
          result: structuredClone(queue),
        }
      }
      entry.state = 'accepted'
      dispatches.push({
        envelopeId: entry.envelopeId,
        sessionId: request.sessionId,
        operationId: request.operationId,
      })
      queue = snapshot(T1174_SUCCESSOR, 'generation-dispatch-' + dispatches.length, queue.entries)
      return {
        ok: true,
        operation: 'dispatch',
        deliveryDisposition: 'accepted',
        dispatchStarted: true,
        attemptId: 't1174-image-attempt-' + dispatches.length,
        ownerContext: T1174_OWNER,
        conversationId: T1174_NODE,
        sessionId: T1174_SUCCESSOR,
        envelopeId: entry.envelopeId,
        result: structuredClone(queue),
      }
    }
    throw new Error('unexpected imageQueue operation: ' + request.operation)
  }

  return {
    gate,
    starts,
    closes,
    handoffSends,
    imageCalls,
    dispatches,
    unknownResponses,
    identityResponses,
    authorityResponses,
    incompleteResponses,
    holdTranscriptSave,
    get transcriptSavePending() { return transcriptSavePending },
    get prepareReadTriggered() { return prepareReadTriggered },
    releaseTranscriptSave() { releaseTranscriptSave?.() },
    changeOwner,
    emit(packet) { for (const listener of [...eventListeners]) listener(packet) },
    get queue() { return structuredClone(queue) },
  }
}

export async function runMountedImageRecovery({
  mode = 'control',
  initialEntries = [queueEntry('t1174-envelope-1')],
  mutateDuringStart = null,
  mutateDuringTranscriptSave = null,
} = {}) {
  clearOutbox(T1174_PREDECESSOR)
  clearOutbox(T1174_SUCCESSOR)
  enqueueOutbox(T1174_PREDECESSOR, 'words the person queued before the limit')

  const world = await installWorld(fleetFetch({ computerId: COMPUTER_ID }), { asyncFrames: true })
  seedTreeNode(world.storage, {
    nodeId: T1174_NODE,
    sessionId: T1174_PREDECESSOR,
    status: 'running',
    computerId: COMPUTER_ID,
  })
  let replacementView = null
  let prepareReadArmed = false
  const image = makeBridge(world, {
    mode,
    initialEntries,
    mutateDuringStart,
    mutateDuringTranscriptSave,
    onPrepareRead: mode === 'host-replaced-during-prepare'
      ? async () => {
        if (!prepareReadArmed) return false
        // Use the real Computers registration seam: a second mounted view
        // installs a replacement host while the producer's prepare read is
        // awaiting. The coordinator must retain the producer object, not
        // silently bind this replacement.
        replacementView = await mountView(world, { computerId: COMPUTER_ID })
        return true
      }
      : null,
  })
  const hadTranscriptBridge = Object.prototype.hasOwnProperty.call(globalThis.window, 'mcTranscripts')
  const previousTranscriptBridge = globalThis.window.mcTranscripts
  if (mode === 'transcript-authority-refusal') {
    globalThis.window.mcTranscripts = makeTranscriptBridge({
      image,
      holdSave: true,
      mutateDuringTranscriptSave,
    })
  }
  let view = null
  try {
    view = await mountView(world, { computerId: COMPUTER_ID })
    assert.ok(view.el.classList.contains('computers'), 'the actual Computers view must mount')
    prepareReadArmed = true
    image.emit({
      sessionId: T1174_PREDECESSOR,
      event: {
        type: 'account_recovery_needed',
        recoveryId: 't1174-image-recovery-' + mode,
        handoff: 'Continue the synthetic retained-image conversation.',
      },
    })
    const transcriptAuthorityLoss = mode === 'transcript-authority-refusal'
    const hostReplacementDuringPrepare = mode === 'host-replaced-during-prepare'
    if (!hostReplacementDuringPrepare) {
      await until(() => image.starts.length === 1, 'the mounted coordinator never reached successor start')
      image.gate.resolve()
      if (transcriptAuthorityLoss) {
        await until(() => image.transcriptSavePending,
          'the mounted coordinator did not expose the awaited recording save')
        image.releaseTranscriptSave()
      }
    }
    const fatalImageModes = [
      'authority-refusal',
      'currentness-refusal',
      'transcript-authority-refusal',
      'unknown-refusal',
      'dispatch-identity-refusal',
      'authority-terminal-refusal',
      'drain-incomplete-refusal',
      'source-changed-incomplete-drain-refusal',
      'host-replaced-during-prepare',
    ]
    await until(() => fatalImageModes.includes(mode)
      ? nodeFromStorage(world)?.status === 'turn-failed'
      : image.handoffSends.length === 1,
      'the mounted coordinator did not settle handoff or explicit refusal')
    await settle(12)
    const card = view.el.querySelectorAll('.static-tree-node')
      .find(row => row.dataset.agentId === T1174_NODE)
    assert.ok(card, 'the actual mounted tree must retain the recovering node')
    card.dispatch('keydown', { key: 'Enter', shiftKey: true })
    await until(() => view.el.querySelector('[data-rail-chat-host] .chat'),
      'the actual mounted node chat did not open for retained-image inspection')
    await settle(12)
    const visibleImageRows = [...(view.el.querySelectorAll('.chat-image-queue-row') || [])]
      .map(row => ({
        envelopeId: row.dataset.envelopeId,
        deliveryState: row.dataset.deliveryState,
        text: row.querySelector('.chat-image-queue-text')?.textContent || '',
        buttons: [...(row.querySelectorAll('button') || [])].map(button => button.textContent),
      }))
    const transcripts = createTranscriptStore({
      computerId: COMPUTER_ID,
      storage: transcriptStorage(world),
    })
    const node = nodeFromStorage(world)
    const result = {
      node,
      starts: image.starts.map(row => ({
        sessionId: row.sessionId,
        replacesSessionId: row.replacesSessionId,
        threadId: row.threadId,
      })),
      closes: image.closes.map(row => row.sessionId),
      handoffSends: image.handoffSends.map(row => row.sessionId),
      imageCalls: image.imageCalls.map(row => ({ ...row })),
      dispatches: image.dispatches.map(row => ({ ...row })),
      unknownResponses: image.unknownResponses.map(row => ({ ...row })),
      identityResponses: image.identityResponses.map(row => ({ ...row })),
      authorityResponses: image.authorityResponses.map(row => ({ ...row })),
      incompleteResponses: image.incompleteResponses.map(row => ({ ...row })),
      prepareReadTriggered: image.prepareReadTriggered,
      hostReplacementMounted: Boolean(replacementView),
      queue: image.queue,
      predecessorOutbox: listOutbox(T1174_PREDECESSOR).map(row => row.text),
      successorOutbox: listOutbox(T1174_SUCCESSOR).map(row => row.text),
      transcript: transcripts.get(T1174_NODE),
      visibleImageRows,
      visibleStatusNote: statusNote(view),
    }
    return result
  } finally {
    try { view?.destroy?.() } catch { /* retained fixture cleanup cannot mask evidence */ }
    try { replacementView?.destroy?.() } catch { /* retained replacement cleanup cannot mask evidence */ }
    if (hadTranscriptBridge) globalThis.window.mcTranscripts = previousTranscriptBridge
    else delete globalThis.window.mcTranscripts
    clearOutbox(T1174_PREDECESSOR)
    clearOutbox(T1174_SUCCESSOR)
    world.restore()
  }
}

export { queueEntry }
