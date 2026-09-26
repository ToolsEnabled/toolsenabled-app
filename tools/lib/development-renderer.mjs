import path from 'node:path'
import { createRequire } from 'node:module'

if (typeof process.send !== 'function') throw Error('The DEV renderer watcher requires its retained parent channel')
const { build } = createRequire(path.join(process.cwd(), 'package.json'))('vite')
let watcher, ready = false, stopping = false
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  try { await watcher?.close() }
  finally { process.exitCode = code; if (process.connected) process.disconnect() }
}
process.on('SIGINT', () => { void stop() }); process.on('SIGTERM', () => { void stop() })
process.on('disconnect', () => { void stop() })
try {
  watcher = await build({ root: process.cwd(), build: { outDir: path.join(process.cwd(), 'dist'), watch: {} } })
  if (stopping) await watcher.close()
  else watcher.on('event', event => {
    if (event.code === 'ERROR' && !ready) {
      process.send({ type: 'renderer-startup-failed' }); void stop(1)
    } else if (event.code === 'END' && !ready && !stopping) {
      ready = true; process.send({ type: 'renderer-ready' })
    }
  })
} catch (error) { console.error(error.message); await stop(1) }
