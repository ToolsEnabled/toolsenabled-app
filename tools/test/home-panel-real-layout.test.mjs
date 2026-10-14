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

// T1546 uses the production Home view and its own routing. The example case
// exercises paintPanelMode's sampleChat -> buildChat branch. The local case is
// separate and exercises createHomeAgentWorkspacePool -> Computers. No chat
// markup or viewport-specific geometry is copied into this fixture.
const app = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'https://home-panel-layout.test'
const computerId = 'this-computer'
const nodeId = 'home-proof-agent'
const sessionId = 'home-proof-ended-session'
// The two short sizes are where the panel squeezed the reading window below
// 120px before the Home chat panel scrolled its own excess content; the five
// taller sizes alone pass with or without that rule.
const sizes = [[1440, 900], [1366, 768], [1280, 800], [1280, 720], [1024, 768], [1280, 640], [1024, 600]]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const entry = [
  "import { homeView } from './src/views/home.js'",
  "import { fleetTreesStorageKey } from './src/fleet-trees.js'",
  "import { createTranscriptStore } from './src/session-transcript-store.js'",
  "const mode = new URL(location.href).searchParams.get('mode') || 'example'",
  "const computerId = 'this-computer'",
  "const nodeId = 'home-proof-agent'",
  "const sessionId = 'home-proof-ended-session'",
  "const stamp = new Date().toISOString()",
  "window.proofUnexpectedWrites = []",
  "const refuseWrite = name => async () => { window.proofUnexpectedWrites.push(name); return { ok: false, code: 'HOME_PANEL_PROOF_HOST_WRITE_REFUSED', message: 'This fixture does not start, send, or close an agent.' } }",
  "window.mcShell = { getBridgeProof: async () => ({ ok: true, proof: 'fixture' }), getBridgeTransport: async () => null, deviceClaim: { status: async () => ({ ok: true, connected: false }) } }",
  "window.mcProviders = { presence: async () => ({ ok: true, providers: [] }) }",
  "window.mcAccount = { current: async () => ({ ok: true, signedIn: false }) }",
  "window.mcAgent = { availability: async () => ({ ok: true, ready: true }), history: async () => ({ ok: true, entries: [",
  "  { action: 'agent_session_start', at: stamp, sequence: 1, sessionId, agent: nodeId, details: { agentId: nodeId, agentName: 'Saved home agent', role: 'worker' } },",
  "  { action: 'agent_session_outcome', at: stamp, sequence: 2, sessionId, outcome: { result: 'started', resolves: 1 } },",
  "] }), usage: async () => ({ ok: true, entries: [] }), sessionPresence: async () => ({ ok: true, sessionIds: [sessionId] }),",
  "  start: refuseWrite('start'), send: refuseWrite('send'), close: refuseWrite('close'), onEvent: () => () => {},",
  "}",
  "if (mode === 'example') {",
  "  localStorage.setItem('mc.example', 'on')",
  "} else {",
  "  localStorage.removeItem('mc.example')",
  "  localStorage.setItem(fleetTreesStorageKey(computerId), JSON.stringify({ version: 1, computerId,",
  "    trees: [{ id: 'home-proof-tree', name: 'Home proof', createdAt: stamp, updatedAt: stamp, profileId: null }],",
  "    nodes: [{ id: nodeId, treeId: 'home-proof-tree', status: 'finished', createdAt: stamp, updatedAt: stamp, role: 'worker', name: 'Saved home agent',",
  "      message: 'Review the saved Home conversation.', statusNote: '', sessionId, parentId: null, agent: { role: 'worker', state: 'finished' } }],",
  "  }))",
  "  const transcripts = createTranscriptStore({ computerId, storage: { read: key => localStorage.getItem(key), write: (key, value) => { localStorage.setItem(key, JSON.stringify(value)); return true } } })",
  "  if (!transcripts.save(nodeId, { lines: Array.from({ length: 6 }, (_, i) => ({ who: i % 2 ? 'agent' : 'you', text: 'Saved Home message ' + (i + 1) + ': this conversation remains readable after the session has finished.', at: Date.now() + i })) })) throw new Error('Home fixture transcript was not saved')",
  "}",
  "document.documentElement.dataset.theme = 'white'",
  "const view = homeView()",
  "const wrap = document.createElement('div')",
  "wrap.className = 'view'",
  "wrap.append(view.el)",
  "document.querySelector('#stage').append(wrap)",
  "window.closeHomeProof = () => { view.destroy?.(); wrap.remove() }",
].join('\n')

async function bundleFixture(profile) {
  const main = await readFile(join(app, 'src/main.js'), 'utf8')
  const imports = [...main.matchAll(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/gm)]
    .map(match => match[1])
    .filter(name => name.endsWith('.css') || name.startsWith('@fontsource'))
  const beforeViews = imports.findIndex(name => name === './morphs.css')
  assert.ok(beforeViews >= 0, 'could not locate the production stylesheet boundary')
  const asImports = values => values
    .map(name => 'import ' + JSON.stringify(name.startsWith('.') ? './src/' + name.slice(2) : name))
    .join('\n')
  const result = await build({
    stdin: {
      contents: asImports(imports.slice(0, beforeViews)) + '\n' + entry + '\n' + asImports(imports.slice(beforeViews)),
      resolveDir: app,
      sourcefile: 'home-panel-proof.js',
    },
    absWorkingDir: app,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    outdir: join(profile, 'bundle'),
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    assetNames: '[name]-[hash]',
  })
  stop()
  const inputs = {}
  for (const name of Object.keys(result.metafile.inputs)) {
    if (name === 'home-panel-proof.js') continue
    inputs[name] = sha(await readFile(resolve(app, name)))
  }
  inputs['index.html'] = sha(await readFile(join(app, 'index.html')))
  inputs['tools/test/home-panel-real-layout.test.mjs'] = sha(await readFile(fileURLToPath(import.meta.url)))
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
  html = html.replace('</head>', '<link rel="stylesheet" href="' + style + '"></head>')
    .replace('</body>', '<script src="' + script + '"></script></body>')
  assets.set('/', Buffer.from(html))
  await writeFile(join(profile, 'inputs.json'), JSON.stringify({ inputs, generatedEntry: sha(entry) }, null, 2))
  return assets
}

function frameTwice(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function inspectControl(control) {
  return control.evaluate(el => {
    const r = el.getBoundingClientRect()
    let top = Math.max(0, r.top)
    let bottom = Math.min(innerHeight, r.bottom)
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowY !== 'visible') {
        const box = parent.getBoundingClientRect()
        top = Math.max(top, box.top)
        bottom = Math.min(bottom, box.bottom)
      }
    }
    const x = r.left + r.width / 2
    const y = (top + bottom) / 2
    const hit = document.elementFromPoint(x, y)
    const body = el.closest('.home-feed[data-mode="chat"]')
    const bodyRect = body?.getBoundingClientRect()
    const viewportClipped = r.top < 0 || r.bottom > innerHeight
    return {
      name: el.className,
      ancestors: [...(function* () { for (let parent = el.parentElement; parent; parent = parent.parentElement) yield parent })()].map(parent => {
        const box = parent.getBoundingClientRect(), style = getComputedStyle(parent)
        return { name: parent.className || parent.id || parent.tagName, top: box.top, bottom: box.bottom, overflowY: style.overflowY, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight, scrollTop: parent.scrollTop }
      }),
      height: r.height,
      visibleHeight: Math.max(0, bottom - top),
      direction: r.top < top ? -1 : 1,
      pointerX: Math.max(1, Math.min(innerWidth - 2, bodyRect ? bodyRect.right - 12 : x)),
      pointerY: Math.max(1, Math.min(innerHeight - 2, bodyRect ? (r.top < top ? bodyRect.top + 3 : bodyRect.bottom - 3) : y)),
      hostScrollTop: body?.scrollTop, hostClientHeight: body?.clientHeight, hostScrollHeight: body?.scrollHeight,
      reachable: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
        && (hit === el || el.contains(hit)),
    }
  })
}

async function assertWheelReachable(page, control, requiredHeight) {
  let state = await inspectControl(control)
  const minimum = () => requiredHeight ?? state.height
  for (let attempt = 0; attempt < 16 && (!state.reachable || state.visibleHeight < minimum() - 1); attempt++) {
    await page.mouse.move(state.pointerX, state.pointerY)
    await page.mouse.wheel(0, state.direction * 180)
    await frameTwice(page)
    state = await inspectControl(control)
  }
  assert.equal(state.reachable, true, 'Home chat control is not reachable through product scrolling: ' + state.name)
  assert.ok(state.visibleHeight >= minimum() - 1, 'Home chat control is clipped: ' + JSON.stringify(state))
  return state
}

async function runMode(mode) {
  const profile = await mkdtemp(join(tmpdir(), 'home-panel-real-layout-'))
  console.log('RETAINED_HOME_PANEL_PROFILE ' + profile + ' mode=' + mode)
  let context
  let contextClosed = false
  let watch
  const observed = new Set()
  const errors = []
  const measurements = []
  const alive = pid => {
    try { process.kill(pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  try {
    const assets = await bundleFixture(profile)
    assets.set('/data/fleet.json', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      domain: 'fleet',
      generatedAt: new Date().toISOString(),
      ok: true,
      reason: null,
      sources: [],
      data: { computers: [{ id: computerId, label: 'This computer', sourceKind: 'observed', activeSessions: 0, services: [] }], graph: { revision: 1, contentHash: '0'.repeat(64), nodes: [], edges: [] } },
    })))
    assets.set('/data/schema/fleet.schema.json', await readFile(join(app, 'public/data/schema/fleet.schema.json')))
    const base = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|DISPLAY|XAUTHORITY|LANG|LC_ALL)$/i.test(key)))
    const env = sterile.sterileLaunchEnvironment(
      sterile.prepareSterileProfile(sterile.sterileProfileDirectories(profile)),
      base,
    )
    if (process.platform === 'linux') {
      env.XDG_RUNTIME_DIR = join(profile, 'runtime')
      await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
      env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + join(profile, 'absent-session-bus')
      env.DBUS_SYSTEM_BUS_ADDRESS = 'unix:path=' + join(profile, 'absent-system-bus')
    }
    context = await chromium.launchPersistentContext(join(profile, 'browser'), {
      ...(process.env.HOME_PANEL_BROWSER ? { executablePath: process.env.HOME_PANEL_BROWSER } : {}),
      headless: true,
      chromiumSandbox: true,
      env,
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 900 },
      timeout: 12_000,
    })
    context.on('close', () => { contextClosed = true })
    const snapshot = () => { for (const pid of processTree.descendantPids(process.pid)) observed.add(pid) }
    snapshot()
    watch = setInterval(() => {
      try { snapshot() } catch (error) { errors.push(error.message) }
    }, 1000)
    await fenceGeometryContext(context, { origin, staticPath: () => false })
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== origin || request.method() !== 'GET') return route.abort('blockedbyclient')
      const bytes = assets.get(url.pathname)
      if (!bytes) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Absent from isolated source fixture.' })
      const contentType = url.pathname.endsWith('.js') ? 'text/javascript'
        : url.pathname.endsWith('.css') ? 'text/css'
          : url.pathname.endsWith('.json') ? 'application/json'
            : /\.woff2?$/.test(url.pathname) ? 'font/woff2' : 'text/html'
      console.log('HOME_FIXTURE_RESPONSE ' + JSON.stringify({ path: url.pathname, bytes: bytes.length, contentType }))
      return route.fulfill({ contentType, body: bytes })
    })
    const page = context.pages()[0]
    assert.equal(context.pages().length, 1, 'one browser page only')
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(7000)
    await page.goto(origin + '/?mode=' + mode + '#/home', { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => document.fonts.ready)
    const picker = page.locator('.home-agent-pick')
    await picker.locator('option[data-kind="agent"]').first().waitFor({ state: 'attached' })
    const agentValue = mode === 'local' ? nodeId : await picker.locator('option[data-kind="agent"]').first().getAttribute('value')
    assert.ok(agentValue, mode + ' Home picker did not expose an agent choice')
    await picker.selectOption(agentValue)
    const chatHost = page.locator('[data-home-chat]')
    await chatHost.locator('.chat-log').waitFor({ state: 'visible' })
    const messageCount = await chatHost.locator('.msg').count()
    assert.ok(messageCount >= 4, mode + ' Home chat did not render the retained conversation')
    const composer = chatHost.locator('.chat-composer-dock')
    await composer.waitFor({ state: 'visible' })
    const input = chatHost.locator('.chat-input textarea')
    await input.waitFor({ state: 'visible' })
    const chips = chatHost.locator('.chat-chips [data-chat-chip]')
    if (mode === 'local') {
      assert.ok(await chips.count() >= 3, 'local Home agent path did not expose the real chat chips')
    } else {
      assert.equal(await chips.count(), 0, 'example path changed its documented disabled buildChat surface')
      assert.equal(await input.isDisabled(), true, 'example composer must visibly refuse sending')
      assert.ok(await chatHost.locator('.chat-nosend').isVisible(), 'example composer refusal must be visible')
    }
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height })
      await frameTwice(page)
      const row = await chatHost.evaluate(host => {
        const box = element => {
          const r = element.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
        const log = host.querySelector('.chat-log')
        const dock = host.querySelector('.chat-composer-dock')
        const h = host.getBoundingClientRect()
        const visibleChips = [...host.querySelectorAll('.chat-chips [data-chat-chip]')]
          .filter(el => !el.closest('[hidden]') && el.getBoundingClientRect().width > 0)
        return {
          viewport: [innerWidth, innerHeight],
          log: box(log),
          composer: box(dock),
          chips: visibleChips.map(el => ({ text: el.textContent.trim(), ...box(el) })),
          chipOverflow: visibleChips.some(el => {
            const r = el.getBoundingClientRect()
            return r.left < h.left - 1 || r.right > h.right + 1
          }),
        }
      })
      const measurement = { mode, width, height, row }
      measurements.push(measurement)
      console.log('HOME_PANEL_BEFORE_ASSERT ' + JSON.stringify(measurement))
      assert.ok(row.log.height >= 120, mode + ' ' + width + 'x' + height + ' Home reading window is below 120px')
      assert.ok(row.composer.height > 0, mode + ' ' + width + 'x' + height + ' composer is not visible')
      if (mode === 'local') assert.equal(row.chipOverflow, false, mode + ' ' + width + 'x' + height + ' chips overflow the Home panel')
      const logState = await assertWheelReachable(page, chatHost.locator('.chat-log'), Math.min(120, row.log.height))
      const composerState = await assertWheelReachable(page, composer)
      const chipStates = []
      for (const chip of await chips.all()) {
        if (!await chip.isVisible()) continue
        chipStates.push(await assertWheelReachable(page, chip))
      }
      const keyboardStart = chatHost.locator('button:visible:enabled').first()
      await keyboardStart.focus()
      assert.equal(await keyboardStart.evaluate(el => document.activeElement === el), true, 'keyboard starting control must actually receive focus')
      await page.keyboard.press('Tab')
      const keyboardAfter = await keyboardStart.evaluate(el => ({
        tag: document.activeElement?.tagName,
        moved: document.activeElement !== el,
        inside: Boolean(document.querySelector('[data-home-chat]')?.contains(document.activeElement)),
      }))
      assert.equal(keyboardAfter.moved, true, mode + ' keyboard Tab did not move focus')
      assert.equal(keyboardAfter.inside, true, mode + ' keyboard Tab left the chat controls')
      Object.assign(measurement, { logState, composerState, chipStates, keyboardAfter })
      console.log('HOME_PANEL_REAL_GEOMETRY ' + JSON.stringify(measurements[measurements.length - 1]))
    }
    assert.deepEqual(await page.evaluate(() => window.proofUnexpectedWrites), [], mode + ' Home view attempted an agent write')
    assert.deepEqual(errors, [], mode + ' Home view raised a page error')
    await page.evaluate(() => window.closeHomeProof())
  } finally {
    stop()
    if (watch) clearInterval(watch)
    for (const pid of processTree.descendantPids(process.pid)) observed.add(pid)
    try { await context?.close() } finally {
      let remaining = [...observed].filter(alive)
      for (let attempt = 0; remaining.length && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        remaining = [...observed].filter(alive)
      }
      const closure = { mode, profile, contextCreated: Boolean(context), contextClosed, observed: [...observed], remaining }
      await writeFile(join(profile, 'closure.json'), JSON.stringify(closure, null, 2))
      await writeFile(join(profile, 'measurements.json'), JSON.stringify(measurements, null, 2))
      console.log('HOME_PANEL_BROWSER_CLOSURE ' + JSON.stringify(closure))
      if (context) assert.equal(contextClosed, true, mode + ' browser context did not close')
      assert.deepEqual(remaining, [], mode + ' owned descendants remain after browser close')
    }
  }
}

test('Home example agent panel uses buildChat and keeps readable controls at seven laptop sizes', { timeout: 45_000 }, () => runMode('example'))
test('Home saved local agent panel uses the workspace pool and keeps chips reachable at seven laptop sizes', { timeout: 45_000 }, () => runMode('local'))
