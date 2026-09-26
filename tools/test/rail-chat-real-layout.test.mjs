import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { chromium } from 'playwright'
import sterile from '../lib/sterile-launch.cjs'
import { fenceGeometryContext } from '../lib/qa-candidate-browser.mjs'
import processTree from '../process-tree.cjs'

// Source renderer proof only. Actual Computers, buildChat, tree/transcript
// stores, application chrome, fonts and CSS. Only host data/bridges are inert.
// No copied chat markup, viewport-derived rail dimensions or geometry overrides.
const app = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'https://rail-layout.test'
const computerId = 'rail-proof-computer'
const nodeId = 'rail-proof-manager'
const sizes = [[1440, 900], [1280, 800], [1100, 800], [1024, 768], [800, 900]]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const entry = `
import { computersView } from './src/views/computers.js'
import { fleetTreesStorageKey } from './src/fleet-trees.js'
import { createTranscriptStore } from './src/session-transcript-store.js'
import { mountAppNavigation } from './src/app-navigation.js'
const computerId = ${JSON.stringify(computerId)}, nodeId = ${JSON.stringify(nodeId)}
const stamp = new Date().toISOString()
window.proofUnexpectedWrites = []
const refuseWrite = name => async () => {
  window.proofUnexpectedWrites.push(name)
  return { ok: false, code: 'RAIL_PROOF_HOST_WRITE_REFUSED', message: 'This source fixture starts and sends nothing.' }
}
window.mcShell = { getBridgeProof: async () => ({ ok: true, proof: 'fixture' }), getBridgeTransport: async () => null }
window.mcAgent = {
  sessionPresence: async () => ({ ok: true, sessionIds: [] }),
  start: refuseWrite('start'), send: refuseWrite('send'), close: refuseWrite('close'),
}
localStorage.setItem(fleetTreesStorageKey(computerId), JSON.stringify({
  version: 1, computerId,
  trees: [{ id: 'rail-proof-tree', name: 'Rail proof', createdAt: stamp, updatedAt: stamp, profileId: null }],
  nodes: [{ id: nodeId, treeId: 'rail-proof-tree', status: 'finished', createdAt: stamp, updatedAt: stamp,
    role: 'manager', name: 'Manager', message: 'Review the saved conversation.', statusNote: '',
    sessionId: 'rail-proof-ended-session', parentId: null }],
}))
const transcripts = createTranscriptStore({ computerId, storage: {
  read: key => localStorage.getItem(key),
  write: (key, value) => { localStorage.setItem(key, JSON.stringify(value)); return true },
}})
const lines = Array.from({ length: 6 }, (_, i) => ({ who: i % 2 ? 'agent' : 'you',
  text: 'Saved message ' + (i + 1) + ': this conversation remains readable after the session has finished.',
  at: Date.now() + i }))
if (!transcripts.save(nodeId, { lines })) throw new Error('Rail fixture transcript was not saved')
document.documentElement.dataset.theme = 'white'
const navigation = mountAppNavigation()
const view = computersView({ initialComputer: computerId, navigate() {} })
const wrap = document.createElement('div')
wrap.className = 'view'
wrap.append(view.el)
document.querySelector('#stage').append(wrap)
window.closeRailProof = () => { view.destroy?.(); navigation.destroy(); wrap.remove() }
`

async function bundleFixture(profile) {
  // Keep all side-effect font/CSS imports in main.js order. Imported view CSS
  // comes from computersView itself; the production sheets resolve cascade.
  const main = await readFile(join(app, 'src/main.js'), 'utf8')
  const imports = [...main.matchAll(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/gm)]
    .map(match => match[1]).filter(name => name.endsWith('.css') || name.startsWith('@fontsource'))
  const beforeViews = imports.findIndex(name => name === './morphs.css')
  assert.ok(beforeViews >= 0, 'could not locate the production post-view stylesheet boundary')
  const asImports = values => values.map(name => `import ${JSON.stringify(name.startsWith('.') ? './src/' + name.slice(2) : name)}`).join('\n')
  const result = await build({ stdin: { contents: asImports(imports.slice(0, beforeViews)) + '\n' + entry + '\n' + asImports(imports.slice(beforeViews)), resolveDir: app, sourcefile: 'rail-proof.js' },
    absWorkingDir: app, bundle: true, write: false, metafile: true, platform: 'browser', format: 'iife', logLevel: 'silent',
    outdir: join(profile, 'bundle'), loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: '[name]-[hash]' })
  stop()
  const inputs = {}
  for (const name of Object.keys(result.metafile.inputs)) {
    if (name === 'rail-proof.js') continue
    const file = resolve(app, name)
    inputs[name] = sha(await readFile(file))
  }
  inputs['index.html'] = sha(await readFile(join(app, 'index.html')))
  inputs['tools/test/rail-chat-real-layout.test.mjs'] = sha(await readFile(fileURLToPath(import.meta.url)))
  const assets = new Map()
  for (const output of result.outputFiles) {
    const name = relative(join(profile, 'bundle'), output.path).replaceAll('\\', '/')
    assets.set('/' + name, Buffer.from(output.contents))
  }
  let html = await readFile(join(app, 'index.html'), 'utf8')
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const script = [...assets.keys()].find(name => name.endsWith('.js'))
  const style = [...assets.keys()].find(name => name.endsWith('.css'))
  assert.ok(script && style, 'renderer bundle must include script and stylesheet')
  html = html.replace('</head>', `<link rel="stylesheet" href="${style}"></head>`)
    .replace('</body>', `<script src="${script}"></script></body>`)
  assets.set('/', Buffer.from(html))
  await writeFile(join(profile, 'inputs.json'), JSON.stringify({ inputs, generatedEntry: sha(entry) }, null, 2))
  return assets
}

test('Computers saved rail keeps a readable conversation and reachable controls at five laptop sizes', { timeout: 45_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'rail-real-layout-'))
  console.log('RETAINED_RAIL_LAYOUT_PROFILE ' + profile)
  let context, contextClosed = false, watch
  const observed = new Set(), errors = [], measurements = []
  const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  try {
    const assets = await bundleFixture(profile)
    const stamp = new Date().toISOString()
    const fleet = { schemaVersion: 1, domain: 'fleet', generatedAt: stamp, ok: true, reason: null, sources: [], data: {
      computers: [{ id: computerId, label: 'This computer', sourceKind: 'observed', observedAt: stamp, activeSessions: 0, services: [] }],
      graph: { revision: 1, contentHash: '0'.repeat(64), nodes: [{ id: 'fixture-seat', label: 'Seat', role: 'builder', provider: 'claude', enabled: true }], edges: [] },
    } }
    assets.set('/data/fleet.json', Buffer.from(JSON.stringify(fleet)))
    assets.set('/data/schema/fleet.schema.json', await readFile(join(app, 'public/data/schema/fleet.schema.json')))
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|DISPLAY|XAUTHORITY|LANG|LC_ALL)$/i.test(key)))
    const env = sterile.sterileLaunchEnvironment(sterile.prepareSterileProfile(sterile.sterileProfileDirectories(profile)), base)
    if (process.platform === 'linux') {
      env.XDG_RUNTIME_DIR = join(profile, 'runtime'); await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
      env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + join(profile, 'absent-session-bus')
      env.DBUS_SYSTEM_BUS_ADDRESS = 'unix:path=' + join(profile, 'absent-system-bus')
    }
    context = await chromium.launchPersistentContext(join(profile, 'browser'), { headless: true, chromiumSandbox: true,
      env, serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, timeout: 12_000 })
    context.on('close', () => { contextClosed = true })
    const snapshot = () => { for (const pid of processTree.descendantPids(process.pid)) observed.add(pid) }
    snapshot()
    watch = setInterval(() => { try { snapshot() } catch (error) { errors.push(error.message) } }, 1000)
    await fenceGeometryContext(context, { origin, staticPath: () => false })
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin || request.method() !== 'GET') return route.abort('blockedbyclient')
      const bytes = assets.get(url.pathname)
      if (!bytes) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Absent from isolated source fixture.' })
      const contentType = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css'
        : url.pathname.endsWith('.json') ? 'application/json' : /\.woff2?$/.test(url.pathname) ? 'font/woff2' : 'text/html'
      console.log('RAIL_FIXTURE_RESPONSE ' + JSON.stringify({ path: url.pathname, bytes: bytes.length, contentType }))
      return route.fulfill({ contentType, body: bytes })
    })
    const page = context.pages()[0]
    assert.equal(context.pages().length, 1, 'one browser page only')
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(5000)
    await page.goto(origin + '/#/computers/' + computerId, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => document.fonts.ready)
    const node = page.locator('.static-tree-node[data-agent-id="' + nodeId + '"]')
    await node.waitFor({ state: 'visible' })
    await node.focus()
    await node.press('Shift+Enter')
    const host = page.locator('.ctl-page.board-page .rail-chat-host')
    await host.locator('.chat-log').waitFor({ state: 'visible' })
    assert.equal(await host.locator('.msg').count(), 6, 'fixture must show the six retained messages')
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const row = await host.evaluate(host => {
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
        const rail = host.closest('.rail'), log = host.querySelector('.chat-log')
        const chips = [...host.querySelectorAll('.chat-chips button, .chat-chips select, [data-chat-chip]')]
          .filter(el => el.getBoundingClientRect().width && !el.closest('[hidden]'))
        const h = host.getBoundingClientRect()
        return { viewport: [innerWidth, innerHeight], log: rect(log), rail: rect(rail),
          header: rect(host.querySelector('.chat-head')), chips: chips.map(el => ({ text: el.textContent.trim(), ...rect(el) })),
          chipOverflow: chips.some(el => { const b = el.getBoundingClientRect(); return b.left < h.left - 1 || b.right > h.right + 1 }) }
      })
      assert.ok(row.chips.length >= 3, 'the real chip row must be present before measuring overflow')
      // Scroll through product ancestors; an offscreen bounding box alone
      // does not establish that a person can reach the conversation/composer.
      const controls = [host.locator('.chat-log'), host.locator('.chat-input input, .chat-input textarea').first()]
      const chips = host.locator('.chat-chips button, .chat-chips select, [data-chat-chip]')
      for (let i = 0; i < await chips.count(); i++) if (await chips.nth(i).isVisible()) controls.push(chips.nth(i))
      row.reachability = []
      for (const control of controls) {
        const inspect = () => control.evaluate(el => {
          const r = el.getBoundingClientRect()
          let top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom)
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            if (getComputedStyle(parent).overflowY !== 'visible') {
              const box = parent.getBoundingClientRect()
              top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom)
            }
          }
          const x = r.left + r.width / 2, y = (top + bottom) / 2
          const hit = document.elementFromPoint(x, y)
          const body = el.closest('.rail-chat-body'), host = body.getBoundingClientRect(), rail = body.closest('.rail').getBoundingClientRect()
          const direction = r.top < top ? -1 : 1
          /* Where a person would put the wheel. While the page itself can still
             carry the control into the window (the rail stacks under the canvas
             on a narrow window), the rail's edge scrolls the page. Once the page
             is at its end, only the chat body's own scroll is left, and that
             takes the pointer over the chat. */
          let pageRoom = false
          for (let parent = body.closest('.rail')?.parentElement; parent; parent = parent.parentElement) {
            if (!/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) continue
            pageRoom = direction > 0 ? parent.scrollTop < parent.scrollHeight - parent.clientHeight - 1 : parent.scrollTop > 0
            if (pageRoom) break
          }
          const viewportClipped = (r.top < 0 || r.bottom > innerHeight) && pageRoom
          return { name: el.className, height: r.height, visibleHeight: Math.max(0, bottom - top),
            direction,
            pointerX: Math.max(1, Math.min(innerWidth - 2, viewportClipped ? rail.left + 2 : host.right - 12)),
            bodyScrollTop: body.scrollTop, bodyClientHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight,
            pointerY: viewportClipped ? Math.max(80, Math.min(innerHeight - 20, r.top < 0 ? 80 : innerHeight - 20))
              : Math.max(1, Math.min(innerHeight - 2, r.top < top ? Math.max(0, host.top) + 3 : Math.min(innerHeight, host.bottom) - 3)),
            reachable: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === el || el.contains(hit)) }
        })
        let visible = await inspect()
        const required = value => value.name.split(' ').includes('chat-log') ? Math.min(150, value.height) : value.height
        // Use user wheel input. scrollIntoView can programmatically scroll
        // overflow:hidden ancestors that a person cannot scroll.
        for (let attempt = 0; attempt < 16 && (!visible.reachable || visible.visibleHeight < required(visible) - 1); attempt++) {
          await page.mouse.move(visible.pointerX, visible.pointerY)
          await page.mouse.wheel(0, visible.direction * 180)
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          visible = await inspect()
        }
        row.reachability.push(visible)
        if (!visible.reachable || visible.visibleHeight < required(visible) - 1) console.log('RAIL_UNREACHABLE_CONTROL ' + JSON.stringify({ viewport: [width, height], ...visible }))
        assert.equal(visible.reachable, true, `${width}x${height}: ${visible.name} cannot be reached through product scrolling`)
        if (visible.name.split(' ').includes('chat-log')) {
          assert.ok(visible.visibleHeight >= Math.min(150, visible.height) - 1,
            `${width}x${height}: the reading window is clipped by a scroll ancestor`)
        } else assert.ok(visible.visibleHeight >= visible.height - 1, `${width}x${height}: composer control is clipped`)
      }
      measurements.push(row)
      console.log('RAIL_REAL_GEOMETRY ' + JSON.stringify(row))
    }
    assert.deepEqual(await page.evaluate(() => window.proofUnexpectedWrites), [], 'view must not start/send/close an agent')
    assert.deepEqual(errors, [], 'real mounted view raised a page error')
    assert.deepEqual(measurements.filter(row => row.log.height < 150 || row.chipOverflow), [], 'conversation must be at least 150px high without clipped chips')
    await page.evaluate(() => window.closeRailProof())
  } finally {
    stop()
    if (watch) clearInterval(watch)
    for (const pid of processTree.descendantPids(process.pid)) observed.add(pid)
    try { await context?.close() } finally {
      let remaining = [...observed].filter(alive)
      for (let attempt = 0; remaining.length && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50)); remaining = [...observed].filter(alive)
      }
      const closure = { profile, contextCreated: Boolean(context), contextClosed, observed: [...observed], remaining }
      await writeFile(join(profile, 'closure.json'), JSON.stringify(closure, null, 2))
      await writeFile(join(profile, 'measurements.json'), JSON.stringify(measurements, null, 2))
      console.log('RAIL_REAL_BROWSER_CLOSURE ' + JSON.stringify(closure))
      console.log('RAIL_SOURCE_PAGE_ERRORS ' + JSON.stringify(errors))
      if (context) assert.equal(contextClosed, true, 'browser context did not close')
      assert.deepEqual(remaining, [], 'owned descendants remain after browser close')
    }
  }
})
