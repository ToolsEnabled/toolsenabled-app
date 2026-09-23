// Development-only control of the explicitly isolated Accessibility test.
// Uses the production renderer/preload APIs, never direct main-process calls.
let expression = ''
for await (const chunk of process.stdin) expression += chunk
const pages = await (await fetch('http://127.0.0.1:9339/json/list')).json()
const page = pages.find(row => row.type === 'page' && /^http:\/\/127\.0\.0\.1:46\d\d\//.test(row.url))
if (!page) throw new Error('The isolated Accessibility test renderer is not available.')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test renderer operation timed out')), 55000)
    socket.onmessage = event => {
      const packet = JSON.parse(event.data)
      if (packet.id !== 1) return
      clearTimeout(timer); resolve(packet)
    }
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    } }))
  })
  console.log(JSON.stringify(result))
} finally { socket.close() }
