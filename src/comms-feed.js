// A bounded reader of the owner journal. Only the current source/request may
// publish; a failed or abandoned read never replaces the last successful data.
export const COMMS_POLL_MS = 4000
export const COMMS_READ_MS = 12000
const MAX_MESSAGES = 2000

/* SAME NAME, DIFFERENT AGENT (T1513). Circle names are per tree, so two trees
   each hold a "Manager" and a "Builder", and the Messages page listed both
   exchanges as "Builder ↔ Manager", wrote "Manager → Builder" on rows from both
   trees and offered one "Manager" in its Agent filter for two agents. A name
   that more than one agent answers to is shown with the tree its agent is in:
   the owner journal names each side's saved circle (senderNodeKey,
   recipientNodeKey) and `treeOf` turns that into the tree's name. Where no tree
   can be named, or two share a name, the agents are numbered in the order they
   first appear. A name only one agent answers to is left exactly as it was. */
export function labelSameNamedAgents(messages, treeOf = () => null) {
  const list = Array.isArray(messages) ? messages : []
  const sides = message => [
    [message.sender, message.senderNodeKey || message.senderId || null, message.senderNodeKey || null],
    [message.recipient, message.recipientNodeKey || message.recipientId || null, message.recipientNodeKey || null],
  ]
  const agentsByName = new Map()
  for (const message of list) {
    for (const [name, identity, nodeKey] of sides(message)) {
      if (!name || !identity) continue
      if (!agentsByName.has(name)) agentsByName.set(name, new Map())
      if (!agentsByName.get(name).has(identity)) agentsByName.get(name).set(identity, nodeKey)
    }
  }
  const labels = new Map()
  for (const [name, agents] of agentsByName) {
    if (agents.size < 2) continue
    const trees = [...agents].map(([, nodeKey]) => {
      try { const tree = nodeKey ? treeOf(nodeKey) : null; return typeof tree === 'string' && tree.trim() ? tree.trim() : null } catch { return null }
    })
    const named = trees.every((tree, index) => tree && trees.indexOf(tree) === index)
    ;[...agents.keys()].forEach((identity, index) => labels.set(`${name}\n${identity}`,
      named ? { text: trees[index], tree: trees[index] } : { text: String(index + 1), tree: null }))
  }
  if (!labels.size) return list
  return list.map(message => {
    const [[sender, senderIdentity], [recipient, recipientIdentity]] = sides(message)
    const senderLabel = labels.get(`${sender}\n${senderIdentity}`) || null
    const recipientLabel = recipient ? labels.get(`${recipient}\n${recipientIdentity}`) || null : null
    if (!senderLabel && !recipientLabel) return message
    return { ...message,
      sender: senderLabel ? `${sender} · ${senderLabel.text}` : sender,
      recipient: recipientLabel ? `${recipient} · ${recipientLabel.text}` : recipient,
      /* A tree name, never a number, may be said once for a pair. */
      shortNames: { sender, recipient, senderTree: senderLabel?.tree || null, recipientTree: recipientLabel?.tree || null } }
  })
}

export function channelGroups(messages, declared = []) {
  const groups = new Map(declared.map(channel => [channel.id, {
    id: channel.id, name: channel.name || channel.id, messages: [],
  }]))
  for (const message of messages) {
    const pair = message.recipient ? [message.sender, message.recipient].sort((a, b) => a.localeCompare(b)) : null
    // Identity, when available, keeps identically named agents in different
    // trees apart. Sorting makes both directions of an exchange one channel.
    const identities = message.senderId && message.recipientId
      ? [message.senderId, message.recipientId].sort() : pair
    const id = message.channelId || (pair ? `direct:${JSON.stringify(identities)}` : 'agent-tree')
    /* Both sides in the same named tree: the tree is said once, after the pair. */
    const short = message.shortNames
    const sameTree = pair && short && short.senderTree && short.senderTree === short.recipientTree
      ? `${[short.sender, short.recipient].sort((a, b) => a.localeCompare(b)).join(' ↔ ')} · ${short.senderTree}` : null
    if (!groups.has(id)) groups.set(id, { id, name: sameTree || (pair ? pair.join(' ↔ ') : 'Agent tree'), messages: [] })
    groups.get(id).messages.push(message)
  }
  const channels = [...groups.values()].sort((a, b) => {
    const at = group => Date.parse(group.messages.at(-1)?.at) || 0
    return at(b) - at(a) || a.name.localeCompare(b.name)
  })
  return [{ id: 'all', name: 'All messages', messages }, ...channels]
}

export function messageMatches(message, query) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const text = [message.sender, message.recipient, message.text].filter(Boolean).join(' ').toLocaleLowerCase()
  return words.every(word => text.includes(word))
}

export function createCommsFeed({ resolveSource, readMessages, sample, paint,
  pollMs = COMMS_POLL_MS, deadlineMs = COMMS_READ_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
}) {
  let disposed = false, revision = 0, timer = null, flight = null, cursor, sourceReady = false, recheckAfter = 0, windowLimited = false, earliestCursor
  let snapshot = { phase: 'loading', example: false, messages: [], channels: [], notice: null, updatedAt: null }
  const deadlines = new Set()
  const publish = patch => { snapshot = { ...snapshot, ...patch }; paint(snapshot) }
  const bounded = operation => new Promise((resolve, reject) => {
    const cancel = () => { clearTimer(timeout); deadlines.delete(cancel); reject(new Error('Message read cancelled.')) }
    const timeout = setTimer(() => {
      deadlines.delete(cancel)
      reject(new Error('Messages are taking too long to arrive. Retrying automatically.'))
    }, deadlineMs)
    deadlines.add(cancel)
    Promise.resolve().then(operation).then(resolve, reject).finally(() => {
      clearTimer(timeout); deadlines.delete(cancel)
    })
  })
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null }
  function validate(answer, position) {
    if (answer?.ok !== true || !Array.isArray(answer.messages)) throw new Error(answer?.reason || 'The program did not return a readable message history. Retrying automatically.')
    if (answer.messages.some(message => !message || typeof message.id !== 'string' || !message.id || typeof message.text !== 'string')) {
      throw new Error('The message history was incomplete. Retrying automatically.')
    }
    const history = answer.history
    if (history && (!Number.isSafeInteger(history.nextCursor) || !Number.isSafeInteger(history.headSequence)
      || !Number.isSafeInteger(history.floorSequence) || history.floorSequence < 1
      || history.nextCursor < 0 || history.headSequence < history.floorSequence - 1)) {
      throw new Error('The message history returned an invalid position. Retrying automatically.')
    }
    // A head behind the reader means the journal reset; refresh handles it.
    if (history && !(cursor !== undefined && history.headSequence < cursor)
      && (history.nextCursor > history.headSequence || (position !== undefined && history.nextCursor < position)
        || (position !== undefined && position < history.headSequence && history.nextCursor === position))) {
      throw new Error('The message history did not advance correctly. Retrying automatically.')
    }
  }
  function schedule(version) {
    stopTimer()
    if (!disposed && version === revision && !snapshot.example) timer = setTimer(() => { timer = null; void refresh() }, pollMs)
  }
  async function refresh({ earlier = false } = {}) {
    if (disposed || snapshot.example || !sourceReady) return
    if (flight) return flight
    if (earlier && !snapshot.hasEarlier) return
    const version = revision
    const requestCursor = earlier ? Math.max((snapshot.history?.floorSequence || 1) - 1, earliestCursor - 200) : cursor
    stopTimer()
    const operation = (async () => {
      try {
        let answer = await bounded(() => readMessages({ limit: 200, ...(requestCursor === undefined ? {} : { cursor: requestCursor }) }))
        if (disposed || version !== revision) return
        validate(answer, requestCursor)
        let history = answer.history
        // A restarted/reset journal cannot strand a reader beyond its head.
        if (history && cursor !== undefined && history.headSequence < cursor) {
          cursor = undefined
          earliestCursor = undefined
          publish({ messages: [], hasEarlier: false, prepending: false, notice: 'The message history restarted. Reading its current messages…' })
          return
        }
        // A byte-limited response may contain fewer than 200 messages. Finish
        // that older interval before moving its start, or a gap would become
        // unreachable the next time the user asks for earlier history.
        if (earlier) {
          const startCursor = history?.startCursor ?? requestCursor
          while (history && history.nextCursor < earliestCursor) {
            const position = history.nextCursor
            const next = await bounded(() => readMessages({ cursor: position, limit: Math.min(200, earliestCursor - position) }))
            if (disposed || version !== revision) return
            validate(next, position)
            if (!next.history || next.history.nextCursor <= position) throw new Error('Earlier messages could not be read. Please try again.')
            answer = { ...next, messages: [...answer.messages, ...next.messages] }
            history = { ...next.history, startCursor }
          }
        }
        const pending = snapshot.messages.filter(message => message.deliveryState === 'unconfirmed'
          && Number.isSafeInteger(message.sequence) && message.sequence >= (history?.floorSequence || 1))
        const recheck = pending.find(message => message.sequence > recheckAfter) || pending[0]
        let repaired = null
        // Reconcile a pending write without letting it hold the forward cursor
        // behind newer traffic. One bounded extra read per caught-up poll.
        if (!earlier && recheck && history && history.nextCursor === history.headSequence) {
          try {
            const result = await bounded(() => readMessages({ cursor: recheck.sequence - 1, limit: 1 }))
            if (result?.ok === true) repaired = result.messages?.find(message => message.id === recheck.id
              && message.sequence === recheck.sequence && message.deliveryState === 'available')
          } catch { /* Keep the explicit unconfirmed status and revisit later. */ }
          if (disposed || version !== revision) return
          recheckAfter = recheck.sequence
        }
        const merged = new Map(snapshot.messages.map(message => [message.id, message]))
        for (const message of answer.messages) merged.set(message.id, message)
        if (repaired) merged.set(repaired.id, repaired)
        const messages = [...merged.values()].sort((a, b) => {
          if (Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence)) return a.sequence - b.sequence
          return (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)
        })
        if (!earlier) cursor = history?.nextCursor
        const start = Number.isSafeInteger(history?.startCursor) ? history.startCursor
          : answer.messages.length && Number.isSafeInteger(answer.messages[0].sequence) ? answer.messages[0].sequence - 1 : undefined
        if (start !== undefined) earliestCursor = earliestCursor === undefined ? start : Math.min(earliestCursor, start)
        windowLimited ||= messages.length > MAX_MESSAGES
        const notice = [answer.notice, windowLimited ? 'Showing the latest 2,000 loaded messages.' : null].filter(Boolean).join(' ')
        publish({ phase: 'ready', messages: messages.slice(-MAX_MESSAGES), notice: notice || null,
          updatedAt: now(), history, reason: null, catchingUp: Boolean(history && cursor < history.headSequence),
          prepending: earlier, hasEarlier: Boolean(history && earliestCursor > history.floorSequence - 1 && messages.length < MAX_MESSAGES) })
        // Drain retained bursts at the next short tick without parallel reads.
        if (!earlier && history && cursor < history.headSequence) {
          timer = setTimer(() => { timer = null; void refresh() }, 0)
        }
      } catch (error) {
        if (!disposed && version === revision) publish({ phase: snapshot.updatedAt === null ? 'unavailable' : 'stale', prepending: false, reason: error.message || String(error) })
      }
    })()
    flight = operation
    try { await operation } finally {
      if (version === revision && flight === operation) {
        flight = null
        if (timer === null) schedule(version)
      }
    }
  }
  async function start({ reask = false } = {}) {
    if (disposed) return
    const version = ++revision
    sourceReady = false
    stopTimer()
    flight = null
    for (const cancel of [...deadlines]) cancel()
    cursor = undefined
    earliestCursor = undefined; recheckAfter = 0; windowLimited = false
    publish({ phase: 'loading', example: false, messages: [], channels: [], notice: null, reason: null, history: null, updatedAt: null, hasEarlier: false, prepending: false })
    try {
      const source = await bounded(() => resolveSource({ reask }))
      if (disposed || version !== revision) return
      if (source === 'mock') {
        const data = sample(now())
        publish({ phase: 'ready', example: true, messages: data.messages.value, channels: data.channels.value, updatedAt: now() })
      } else { sourceReady = true; await refresh() }
    } catch (error) {
      if (!disposed && version === revision) {
        publish({ phase: 'unavailable', reason: error.message || String(error) })
        timer = setTimer(() => { timer = null; void start({ reask: true }) }, pollMs)
      }
    }
  }
  return { start, refresh, loadEarlier: () => refresh({ earlier: true }), destroy() {
    disposed = true; revision++; stopTimer()
    for (const cancel of [...deadlines]) cancel()
  } }
}
