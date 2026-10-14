import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUpdateSettings } from '../../src/update-settings.js'

function view(searchResult = false) {
  const paints = []
  const statuses = []
  const status = { set textContent(value) { statuses.push(value) } }
  const row = {
    querySelector: () => searchResult ? {} : null,
    set outerHTML(value) { paints.push(value) },
  }
  return { paints, statuses, addEventListener() {}, removeEventListener() {},
    querySelectorAll: selector => selector === '[data-update-runtime-version]' ? [status] : [row] }
}

test('the running window version is visible independently of updater support and remote selection', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const isPackaged of [true, false]) {
      const settings = createUpdateSettings({ platform, readPolicy: () => 'never', readingOverRelay: () => true,
        readRuntimeIdentity: async () => ({ ok: true, version: '8.7.6', isPackaged,
          userData: '/private/owner-data', execPath: '/private/launcher' }) })
      const root = view(true)
      await settings.bind(root)
      const html = settings.markup({ searchResult: true })
      assert.match(html, /This window is running ToolsEnabled 8\.7\.6/)
      assert.match(root.statuses.at(-1), /This window is running ToolsEnabled 8\.7\.6/)
      assert.equal(root.paints.length, 0, 'the asynchronous read does not replace focused policy controls')
      assert.equal(html.includes('development copy'), !isPackaged)
      assert.doesNotMatch(html, /private\/owner-data|private\/launcher/)
      assert.match(html, /System · updates/)
      assert.equal(html.includes('data-update-policy="never"'), platform === 'win32')
      for (const query of ['app version', 'running version', 'build', 'about', '8.7.6']) assert.equal(settings.matches(query), true, query)
      settings.destroy()
    }
  }
})

test('missing, refused, thrown and malformed identity reads never invent a version', async () => {
  for (const read of [() => null, () => ({ ok: false, version: '8.7.6', isPackaged: true }),
    () => { throw new Error('private diagnostic') }, () => Promise.reject(new Error('private rejection')),
    () => ({ ok: true, version: '', isPackaged: true }), () => ({ ok: true, version: '8.7.6' })]) {
    const settings = createUpdateSettings({ readPolicy: () => 'always', readRuntimeIdentity: read })
    const root = view()
    await settings.bind(root)
    const html = settings.markup()
    assert.match(html, /App version could not be read in this window/)
    assert.match(root.statuses.at(-1), /App version could not be read in this window/)
    assert.doesNotMatch(html, /8\.7\.6|private diagnostic|private rejection|development copy/)
    assert.match(html, /Checks on its own at launch/)
    settings.destroy()
  }
})

test('the existing shell identity method is called without arguments and only once per mount', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let calls = 0
  const shell = { runtimeIdentity(...args) {
    assert.equal(this, shell)
    assert.equal(args.length, 0)
    calls += 1
    return Promise.resolve({ ok: true, version: '8.7.6-<img src=x>', isPackaged: false })
  } }
  try {
    globalThis.window = { mcShell: shell }
    const settings = createUpdateSettings({ readPolicy: () => 'ask', writePolicy() {} })
    const root = view()
    await settings.bind(root)
    await settings.afterRender(root)
    settings.setPolicy('never')
    assert.equal(calls, 1)
    assert.match(settings.markup(), /8\.7\.6-&lt;img src=x&gt;/)
    assert.doesNotMatch(settings.markup(), /<img src=x>/)
    settings.destroy()
    delete globalThis.window
    const browser = createUpdateSettings({ readPolicy: () => null })
    await browser.bind(view())
    assert.match(browser.markup(), /App version could not be read in this window/)
    browser.destroy()
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior)
    else delete globalThis.window
  }
})

test('a late identity reply cannot repaint a destroyed view or replace a newer mount', async () => {
  const resolve = []
  const settings = createUpdateSettings({ readPolicy: () => 'ask',
    readRuntimeIdentity: () => new Promise(done => resolve.push(done)) })
  const oldRoot = view()
  const oldRead = settings.bind(oldRoot)
  await Promise.resolve()
  settings.destroy()
  const newRoot = view()
  const newRead = settings.bind(newRoot)
  await Promise.resolve()
  assert.equal(resolve.length, 2)
  resolve[1]({ ok: true, version: '8.7.7', isPackaged: true })
  await newRead
  resolve[0]({ ok: true, version: '8.7.6', isPackaged: true })
  await oldRead
  assert.equal(oldRoot.paints.length + oldRoot.statuses.length, 0)
  assert.equal(newRoot.statuses.length, 1)
  assert.match(settings.markup(), /8\.7\.7/)
  assert.doesNotMatch(settings.markup(), /8\.7\.6/)
  settings.destroy()
})
