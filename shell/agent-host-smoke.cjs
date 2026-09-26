'use strict'

const path = require('node:path')
const { createAgentHost } = require('./agent-host.cjs')

const TURN_TIMEOUT_MS = 120_000

async function run() {
  const sessionId = 'agent-host-smoke-' + process.pid + '-' + Date.now()
  const host = createAgentHost({ defaultCwd: path.resolve(__dirname, '..') })
  let unsubscribe = null
  let timer = null

  try {
    let assembledReply = ''
    let sawStreamedDelta = false
    const observedEvents = []
    let finishTurn
    let failTurn
    const turnCompleted = new Promise((resolve, reject) => {
      finishTurn = resolve
      failTurn = reject
    })

    unsubscribe = host.onEvent((packet) => {
      if (!packet || packet.sessionId !== sessionId || !packet.event) return
      const event = packet.event
      if (event.type !== 'assistant_text_delta') observedEvents.push(event)
      if (event.type === 'assistant_text_delta' && typeof event.text === 'string') {
        assembledReply += event.text
        if (event.text.length > 0) sawStreamedDelta = true
      }
      if (event.type === 'turn_completed') finishTurn(event.status)
    })

    await host.startSession({ sessionId, cwd: path.resolve(__dirname, '..') })
    timer = setTimeout(() => {
      failTurn(new Error('Timed out after ' + TURN_TIMEOUT_MS + 'ms waiting for turn_completed'))
    }, TURN_TIMEOUT_MS)

    const sendTurn = host.sendTurn({
      sessionId,
      text: 'Reply with exactly the word: PONG',
    })
    const status = await Promise.race([
      turnCompleted,
      sendTurn.then(() => turnCompleted),
    ])
    clearTimeout(timer)
    timer = null

    const reply = assembledReply.trim()
    console.log('reply: ' + reply)
    console.log('turn_completed: ' + status)

    if (status !== 'completed') {
      console.error('events: ' + JSON.stringify(observedEvents, null, 2))
    }
    if (status !== 'completed') throw new Error('Turn did not complete successfully: ' + String(status))
    if (!sawStreamedDelta) throw new Error('No assistant_text_delta events were received')
    if (reply !== 'PONG') throw new Error('Expected exactly PONG, received: ' + JSON.stringify(reply))
  } finally {
    if (timer) clearTimeout(timer)
    if (unsubscribe) unsubscribe()
    await host.closeAll()
  }
}

run().catch((error) => {
  console.error('agent-host smoke failed:', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
