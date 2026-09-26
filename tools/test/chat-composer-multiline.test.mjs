import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdtemp, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import sterile from '../lib/sterile-launch.cjs'
import { fenceGeometryContext } from '../lib/qa-candidate-browser.mjs'
import processTree from '../process-tree.cjs'
import { chromium } from 'playwright'

// Real browser input sanitization and clipboard default actions are essential:
// a DOM stand-in that assigns strings to .value cannot expose this loss.
// One retained, isolated browser profile and one page; no provider or network.
const app = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'https://composer.test'
let context, page, profile
let contextClosed = false
const text = 'Traceback (most recent call last):\n  File "run.py", line 3\n    main()\nValueError: bad input'
const entry = `
import { buildChat } from './src/components.js'
import * as outbox from './src/session-outbox.js'
window.mountComposer = (busy = false) => {
  window.chat?.dispose()
  document.body.replaceChildren()
  outbox.clearSession('multiline-proof')
  const sent = [], listeners = new Set()
  let stops = 0
  const queue = {
    list: () => outbox.list('multiline-proof'),
    add: text => { const result = outbox.enqueue('multiline-proof', text); for (const f of listeners) f(); return result },
    replace: (id, text) => outbox.replace('multiline-proof', id, text),
    cancel: id => outbox.cancel('multiline-proof', id),
    subscribe: f => { listeners.add(f); return () => listeners.delete(f) },
  }
  const chat = buildChat({ title: 'Multiline proof', seed: 0,
    status: { busy: () => busy }, queue,
    onStop: async () => { stops++; busy = false; return { ok: true, settled: true } },
    onSend: (text, handlers) => { sent.push(text); handlers?.done?.(); return { ok: true } },
  })
  document.body.append(chat)
  window.chat = chat
  window.proof = { sent, queue, stops: () => stops,
    drain: () => { const row = queue.list()[0]; outbox.cancel('multiline-proof', row.id); for (const f of listeners) f(); return row.text },
  }
}
`
before(async () => {
  const bundle = await build({ stdin: { contents: entry, resolveDir: app, sourcefile: 'multiline-proof.js' },
    bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' })
  stop()
  profile = await mkdtemp(join(tmpdir(), 'composer-browser-'))
  console.log('RETAINED_COMPOSER_BROWSER_PROFILE ' + profile)
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|DISPLAY|XAUTHORITY|LANG|LC_ALL)$/i.test(key)))
  const env = sterile.sterileLaunchEnvironment(sterile.prepareSterileProfile(sterile.sterileProfileDirectories(profile)), base)
  if (process.platform === 'linux') {
    env.XDG_RUNTIME_DIR = join(profile, 'runtime'); await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
    env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + join(profile, 'absent-session-bus')
    env.DBUS_SYSTEM_BUS_ADDRESS = 'unix:path=' + join(profile, 'absent-system-bus')
  }
  context = await chromium.launchPersistentContext(join(profile, 'browser'), {
    headless: true, chromiumSandbox: true, env, serviceWorkers: 'block', viewport: { width: 1000, height: 800 },
  })
  context.on('close', () => { contextClosed = true })
  await fenceGeometryContext(context, { origin, staticPath: () => false })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await context.route('**/*', route => route.request().url() === origin + '/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    : route.abort())
  page = context.pages()[0]
  page.setDefaultTimeout(4000)
  await page.goto(origin)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.addStyleTag({ content: await readFile(join(app, 'src/styles.css'), 'utf8') })
})
after(async () => {
  // Match the existing browser driver's awaited closure and also observe the
  // actual child PIDs. The retained profile is never removed by this test.
  const descendants = context ? processTree.descendantPids(process.pid) : []
  await context?.close()
  const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e } }
  let remaining = descendants.filter(alive)
  for (let attempt = 0; remaining.length && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50)); remaining = descendants.filter(alive)
  }
  console.log('COMPOSER_BROWSER_CLOSURE ' + JSON.stringify({ profile, contextClosed, descendants, remaining }))
  if (context) assert.equal(contextClosed, true)
  assert.deepEqual(remaining, [], 'owned browser child processes must be closed')
})
const input = () => page.locator('.chat-input').getByRole('textbox')
async function mount(busy = false) { await page.evaluate(busy => window.mountComposer(busy), busy) }
async function paste(value) {
  await page.evaluate(value => navigator.clipboard.writeText(value), value)
  await input().focus()
  await page.keyboard.press('Control+V')
  await page.waitForFunction(() => document.querySelector('.chat-input').querySelector('input, textarea').value.length > 0)
}
async function sentExactly(value) {
  await page.waitForFunction(() => window.proof.sent.length === 1)
  assert.deepEqual(await page.evaluate(() => window.proof.sent), [value])
  assert.equal(await input().inputValue(), '', 'Enter must not leave a native newline after sending')
  assert.equal(await page.locator('.msg.me .chat-msg-text').textContent(), value)
}

test('pasted traceback retains every line through Enter and the visible owner message', async () => {
  await mount(); await paste(text)
  assert.equal(await input().inputValue(), text)
  await input().press('Enter'); await sentExactly(text)
})
test('pasted text keeps its lines through Shift+Enter and interrupts once', async () => {
  await mount(true); await paste(text)
  await input().press('Shift+Enter'); await sentExactly(text)
  assert.equal(await page.evaluate(() => window.proof.stops()), 1)
})
test('ordinary Enter queues multiline text without interrupting or adding a newline', async () => {
  await mount(true); await paste(text); await input().press('Enter')
  assert.deepEqual(await page.evaluate(() => window.proof.queue.list().map(row => row.text)), [text])
  assert.deepEqual(await page.evaluate(() => window.proof.sent), [])
  assert.equal(await page.evaluate(() => window.proof.stops()), 0)
  assert.equal(await input().inputValue(), '')
})
test('recall edits preserve lines and Enter updates the queued message once', async () => {
  await mount(true); await page.evaluate(text => window.proof.queue.add(text), text)
  await input().press('ArrowUp')
  assert.equal(await input().inputValue(), text)
  const edit = text + '\nAdditional context'
  await input().fill(edit); await input().press('Enter')
  assert.deepEqual(await page.evaluate(() => window.proof.queue.list().map(row => row.text)), [edit])
  assert.deepEqual(await page.evaluate(() => window.proof.sent), [])
  assert.equal(await input().inputValue(), '')
})
test('multiline draft export and remount preserve text, selection and an attachment descriptor', async () => {
  await mount(); await paste(text)
  const draft = await page.evaluate(() => {
    const value = window.chat.exportDraft()
    value.attachments = [{ path: 'fixture-image.png', name: 'fixture-image.png', mime: 'image/png' }]
    value.start = 3; value.end = 12
    window.chat.importDraft(value)
    return window.chat.exportDraft()
  })
  await mount()
  await page.evaluate(draft => window.chat.importDraft(draft), draft)
  assert.equal(await input().inputValue(), text)
  assert.deepEqual(await page.evaluate(() => window.chat.exportDraft()), draft)
})
test('single-line Enter and Shift+Enter still send once with an empty composer afterward', async () => {
  for (const chord of ['Enter', 'Shift+Enter']) {
    await mount(); await input().fill('single line'); await input().press(chord)
    await sentExactly('single line')
  }
})
