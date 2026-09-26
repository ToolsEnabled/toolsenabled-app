#!/usr/bin/env node
// Apply explicitly labeled, memory-only status examples to this checkout's
// own native development window. No fleet/session/provider record is written.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2), index = args.indexOf('--record')
if (index < 0 || !args[index + 1]) throw new Error('Use --record /path/to/native-dev.json, optionally --clear. Open Computers in that native dev app first.')
const record = JSON.parse(readFileSync(args[index + 1], 'utf8'))
const root = fileURLToPath(new URL('../', import.meta.url))
assert.equal(path.resolve(record.root), path.resolve(root), 'The development instance must belong to this checkout')
assert.equal(new URL(record.debugOrigin).hostname, '127.0.0.1')
const pages = await fetch(`${record.debugOrigin}/json/list`, { signal: AbortSignal.timeout(5000) }).then(response => response.json())
const page = pages.find(page => page.type === 'page' && page.url.startsWith(record.url))
assert.ok(page, 'The recorded native development window is running')

function exampleIndicators(clear) {
  window.__page2IndicatorExample?.clear()
  if (clear) return { cleared: true }
  const graph = window.__mcGraph
  if (!graph || graph._destroyed) throw new Error('Open Computers in this native dev app first')
  if (graph.editMode || graph._linkMode) throw new Error('Finish editing or linking before opening the example')
  const ids = [...new Set((graph.windowBoard?.windows || [{ graph }]).flatMap(frame =>
    frame.graph.visibleAgents().filter(agent => !agent.treeScope?.group).map(agent => agent.id)))].slice(0, 6)
  if (!ids.length) throw new Error('Zoom in until an actual agent is visible')
  const variants = [
    { running: true, tokens: 400_000, drift: 'drifting' },
    { running: true, tokens: 2_000_000 },
    { running: true, tokens: 7_000_000, drift: 'off-course' },
    { running: true, tokens: 12_000_000 },
    { running: true },
    { running: false, drift: 'drifting' },
  ]
  const base = graph.computer
  const example = { ...base, agents: base.agents.map(agent => {
    const index = ids.indexOf(agent.id)
    return index < 0 ? agent : { ...agent, cloudLane: variants[index] }
  }) }
  const banner = document.createElement('div')
  banner.className = 'tree-indicator-example'
  banner.style.cssText = 'pointer-events:auto;display:flex;align-items:center;gap:8px;margin-left:auto;max-width:100%;min-width:0;color:var(--ink-2);font:12px/1.4 var(--font-ui)'
  const navigation = graph.zoomHost.closest('.tree-window')?.querySelector('.tree-window-navigation')
  const previousWrap = navigation?.style.flexWrap
  const label = document.createElement('span')
  label.textContent = 'Example indicators · visual preview only'
  const button = document.createElement('button')
  button.type = 'button'; button.textContent = 'Clear examples'
  button.style.cssText = 'flex:none;color:inherit;background:var(--sheet);border:1px solid var(--line-2);border-radius:3px;padding:3px 6px;font:inherit;cursor:pointer'
  banner.append(label, button)
  let monitor
  const state = {
    clear() {
      clearInterval(monitor)
      if (!graph._destroyed && graph.computer === example) {
        graph.computer = base
        graph.refresh()
      }
      banner.remove()
      if (navigation?.style.flexWrap === 'wrap') navigation.style.flexWrap = previousWrap
      if (window.__page2IndicatorExample === state) delete window.__page2IndicatorExample
    },
  }
  button.addEventListener('click', event => { event.stopPropagation(); state.clear() })
  window.__page2IndicatorExample = state
  graph.computer = example
  graph.refresh()
  if (navigation) {
    navigation.style.flexWrap = 'wrap'
    navigation.append(banner)
  } else {
    banner.style.cssText += ';position:absolute;top:8px;right:8px;padding:8px;background:var(--sheet);z-index:25'
    graph.zoomHost.append(banner)
  }
  // Discard the example when navigation or an authoritative fleet refresh
  // replaces this view. Never restore an old fleet over a newer update.
  monitor = setInterval(() => {
    if (graph._destroyed || graph.computer !== example || !graph.zoomHost.isConnected) state.clear()
  }, 500)
  for (const frame of graph.windowBoard?.windows || [{ graph }]) {
    for (const mark of frame.graph.container.querySelectorAll('.node-lane-box, .node-drift-light')) {
      mark.title = `Example · ${mark.title}`
      mark.setAttribute('aria-label', `Example · ${mark.getAttribute('aria-label') || ''}`)
    }
  }
  return { example: true, markedAgents: ids.length, persisted: false, startedJobs: 0 }
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native dev connection timed out')), 5000)
    socket.onopen = () => { clearTimeout(timeout); resolve() }
    socket.onerror = () => { clearTimeout(timeout); reject(new Error('Native dev connection failed')) }
  })
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native dev preview timed out')), 10000)
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timeout)
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)))
      else resolve(message.result.result.value)
    }
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(${exampleIndicators.toString()})(${args.includes('--clear')})`, returnByValue: true,
    } }))
  })
  console.log(JSON.stringify(result))
} finally { socket.close() }
