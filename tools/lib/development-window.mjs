import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readDevelopmentSession, developmentSessionEnvironment, ordinaryPath } from './development-session.mjs'
import { assertPrivateDependencyTree } from '../release-packager/lib/node-modules-reuse.mjs'
import { readDevelopmentSocketTemp } from './development-socket-temp.mjs'

const args = process.argv.slice(2)
if (args[0] !== '--session' || !args[1] || args.slice(2).some(arg => !['--watch', '--inspect'].includes(arg))
    || new Set(args.slice(2)).size !== args.length - 2) throw Error('Invalid DEV window invocation')
const session = readDevelopmentSession(args[1])
if (session.kind !== 'dev') throw Error('Only a DEV session can open this window')
const { paths } = session
ordinaryPath(path.join(paths.app, 'capability'))
const payload = JSON.parse(fs.readFileSync(path.join(paths.app, 'capability/PAYLOAD.json'), 'utf8'))
if (payload.sourceRef !== session.sources.engine.ref || (!args.includes('--watch') && !fs.existsSync(path.join(paths.app, 'dist/index.html')))) throw Error('Prepare this DEV session before opening it')
const require = createRequire(import.meta.url)
const appProtocol = JSON.parse(fs.readFileSync(path.join(paths.app, 'package.json'), 'utf8')).developmentSessionProtocol
const isolationPath = path.join(paths.app, 'capability/src/lib/provider-session-isolation.js')
if (appProtocol?.providerIsolationVersion !== 1 || !fs.existsSync(isolationPath)) {
  throw Error('This DEV snapshot lacks the paired provider-isolation protocol. Create a new session from updated app and engine sources.')
}
const isolationModule = ordinaryPath(isolationPath, { directory: false })
if (require(isolationModule).PROVIDER_SESSION_ISOLATION_VERSION !== 1) {
  throw Error('This DEV snapshot lacks the paired provider-isolation protocol. Create a new session from updated app and engine sources.')
}
const { sterileLaunchEnvironment, sterileProfileDirectories, prepareSterileProfile } = require('./sterile-launch.cjs')
const profile = prepareSterileProfile(sterileProfileDirectories(paths.runtimeProfile))
const env = sterileLaunchEnvironment(profile, developmentSessionEnvironment(session))
const socketTemp = readDevelopmentSocketTemp(session)
if (socketTemp) for (const key of ['TMPDIR', 'TMP', 'TEMP']) env[key] = socketTemp.directory
const electron = ordinaryPath(path.join(paths.app, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), { directory: false })
ordinaryPath(path.join(paths.app, 'node_modules'))
assertPrivateDependencyTree(path.join(paths.app, 'node_modules'))
const children = new Set()
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
}
function start(command, childArgs, environment, { ipc = false, visible = false } = {}) {
  // libuv also passes SW_HIDE through Windows STARTUPINFO. Only the intended
  // Electron GUI may request a visible first window; Node helpers stay hidden.
  const child = spawn(command, childArgs, { cwd: paths.app, env: environment, windowsHide: !visible, stdio: ['ignore', 'inherit', 'inherit', ...(ipc ? ['ipc'] : [])] })
  children.add(child)
  child.once('error', error => { console.error(error.message); process.exitCode = 1; stop() })
  child.once('close', () => children.delete(child))
  return child
}
if (args.includes('--watch')) {
  const watcher = start(process.execPath, [fileURLToPath(new URL('./development-renderer.mjs', import.meta.url))], developmentSessionEnvironment(session, { phase: 'build' }), { ipc: true })
  watcher.once('close', code => { if (!stopping) { process.exitCode = code || 1; stop() } })
  // A watcher's initial build empties dist. Do not race Electron's first page
  // request against that rebuild or open an unbuilt/failed renderer.
  await new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); watcher.off('message', message); watcher.off('close', closed); watcher.off('error', finish); error ? reject(error) : resolve() }
    const message = value => {
      if (value?.type === 'renderer-ready') finish()
      else if (value?.type === 'renderer-startup-failed') finish(Error('The initial DEV renderer build failed; see this session\'s process log'))
    }
    const closed = () => finish(Error('The DEV renderer watcher closed before its initial build completed'))
    const timer = setTimeout(() => { stop(); finish(Error('The initial DEV renderer build timed out')) }, 120_000)
    watcher.on('message', message); watcher.once('close', closed); watcher.once('error', finish)
  })
  if (!fs.existsSync(path.join(paths.app, 'dist/index.html'))) throw Error('The DEV renderer watcher did not produce its index')
}
console.log('Opening DEV session ' + session.id + ' at ' + paths.userData)
const gui = start(electron, [path.join(paths.app, 'shell/main.cjs'), '--user-data-dir=' + paths.userData,
  ...(args.includes('--inspect') ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] : [])], env, { visible: true })
gui.once('close', code => { process.exitCode = code ?? 1; stop() })
process.on('SIGINT', stop); process.on('SIGTERM', stop)
// The enclosing native guardian owns this root, watcher, GUI and descendants.
