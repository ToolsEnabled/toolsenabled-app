#!/usr/bin/env node
// The real desktop shell, an isolated profile, and automatic renderer rebuilds.
// Native IPC, projection authentication and the renderer sandbox remain intact.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null
const label = value('--label') || 'ToolsEnabled Dev'
const privateRoot = path.join(os.homedir(), '.toolsenabled-native-dev')
mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
const profile = path.resolve(value('--profile') || mkdtempSync(path.join(privateRoot, 'instance-')))
mkdirSync(profile, { recursive: true, mode: 0o700 })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE
let child, socket, endpoint, ready = false, stopped = false, sequence = 0
const pending = new Map()
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 10000)
  pending.set(id, result => { clearTimeout(timeout); result.error ? reject(new Error(result.error.message)) : resolve(result.result) })
  socket.send(JSON.stringify({ id, method, params }))
})
async function connect() {
  const address = new URL(endpoint)
  const pages = await fetch(`http://${address.host}/json/list`).then(response => response.json())
  const page = pages.find(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'))
  if (!page) return false
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let identify = ''
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    else if (message.method === 'Page.loadEventFired' && ready && identify) {
      void command('Runtime.evaluate', { expression: identify }).catch(error => console.error(error.message))
    }
  }
  // Wait for the app's initial route restore before selecting the dev page.
  const state = await command('Runtime.evaluate', { expression: "document.readyState === 'complete' && !!document.querySelector('nav, .setup-page')", returnByValue: true })
  if (state.result?.value !== true) { socket.close(); return false }
  identify = `(() => {
    const prefix = ${JSON.stringify(label + ' · ')};
    const name = () => { if (!document.title.startsWith(prefix)) document.title = prefix + document.title };
    const observe = () => { name(); new MutationObserver(name).observe(document.head, { childList: true, subtree: true, characterData: true }) };
    if (document.querySelector('title')) observe(); else document.addEventListener('DOMContentLoaded', observe, { once: true });
  })()`
  await command('Page.enable')
  await command('Page.addScriptToEvaluateOnNewDocument', { source: identify })
  await command('Runtime.evaluate', { expression: identify })
  await command('Runtime.evaluate', { expression: "location.hash = '#/computers'" })
  await command('Page.bringToFront')
  writeFileSync(path.join(profile, 'native-dev.json'), JSON.stringify({ pid: child.pid, supervisorPid: process.pid, label, root, profile, debugOrigin: `http://${address.host}`, url: page.url }, null, 2))
  console.log(`Native dev app ready. Profile: ${profile}`)
  ready = true
  return true
}
const watcher = await build({ root, build: { watch: {}, emptyOutDir: false } })
watcher.on('event', async event => {
  if (event.code === 'ERROR') { console.error(event.error); return }
  if (event.code !== 'END' || stopped) return
  if (child) {
    if (ready) try { await command('Page.reload', { ignoreCache: true }); console.log('Native dev app reloaded.') } catch (error) { console.error(error.message) }
    return
  }
  child = spawn(createRequire(import.meta.url)('electron'), [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', root,
  ], { cwd: root, env, stdio: ['ignore', 'inherit', 'pipe'] })
  child.stderr.on('data', data => {
    process.stderr.write(data)
    endpoint ||= String(data).match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1]
  })
  child.on('error', error => { console.error(error.message); void stop(1) })
  child.on('exit', code => void stop(code ?? 0))
  const started = Date.now()
  while (!stopped && !ready && Date.now() - started < 60000) {
    if (endpoint) try { if (await connect()) break } catch { /* renderer is still booting */ }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  if (!ready && !stopped) console.error('Native window launched, but automatic reload could not attach. See the startup log.')
})
async function stop(code = 0) {
  if (stopped) return
  stopped = true
  socket?.close()
  child?.kill('SIGTERM')
  await watcher.close()
  process.exit(code)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
