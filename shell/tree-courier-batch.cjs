'use strict'

function treeMessageText(message) {
  return typeof message === 'string' ? message : message.text
}

// Include waiting corrections in the same turn as the work they correct.
// Keep each already-framed peer message intact, ordered, and below the host's
// turn limit. A large individual message retains its existing single-turn path.
function takeTreeBatch(queue, retry = null) {
  const retryMatches = retry?.messages?.length > 0
    && retry.messages.every((message, index) => queue[index] === message)
  if (retryMatches) {
    queue.splice(0, retry.messages.length)
    return retry
  }
  let count = 0
  let length = 0
  while (count < queue.length && count < 16) {
    const added = treeMessageText(queue[count]).length + (count ? 2 : 0)
    if (count && length + added > 64_000) break
    length += added
    count += 1
  }
  return { messages: queue.splice(0, count), failures: 0 }
}

module.exports = { takeTreeBatch, treeMessageText }
