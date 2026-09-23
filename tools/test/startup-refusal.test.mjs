import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import startupRefusal from '../../shell/startup-refusal.cjs'

const { reportStartupRefusal } = startupRefusal

function harness(environment) {
  let dialogCalls = 0
  let stderr = ''
  const result = reportStartupRefusal({
    code: 'EXACT_REFUSAL_CODE',
    message: 'The exact refusal message.',
    environment,
    dialog: { showErrorBox: () => { dialogCalls += 1 } },
    stderr: { write: text => { stderr += text } },
  })
  return { dialogCalls, stderr, result }
}

test("the exact headless marker reports the refusal to stderr without opening a modal dialog", () => {
  const observed = harness({ MC_SMOKE_HEADLESS: '1' })
  assert.equal(observed.dialogCalls, 0)
  assert.equal(observed.stderr, 'EXACT_REFUSAL_CODE: The exact refusal message.\n')
  assert.deepEqual(observed.result, { headless: true, surface: 'stderr' })
})

test('the production stderr fd is written synchronously before the caller exits', () => {
  const chunks = []
  let streamWrites = 0
  let calls = 0
  const expected = Buffer.from('SYNC_REFUSAL: Écrit before exit.\n', 'utf8')
  reportStartupRefusal({
    code: 'SYNC_REFUSAL',
    message: 'Écrit before exit.',
    environment: { MC_SMOKE_HEADLESS: '1' },
    dialog: { showErrorBox: () => assert.fail('headless refusal opened a dialog') },
    stderr: { fd: 2, write: () => { streamWrites += 1 } },
    writeSync: (fd, bytes, offset, length) => {
      assert.equal(fd, 2)
      assert.ok(Buffer.isBuffer(bytes))
      const size = Math.min(3, length)
      chunks.push(Buffer.from(bytes.subarray(offset, offset + size)))
      calls += 1
      return size
    },
  })
  assert.equal(streamWrites, 0)
  assert.deepEqual(Buffer.concat(chunks), expected,
    'short writes reconstructed characters rather than the exact UTF-8 bytes')
  assert.equal(calls, Math.ceil(expected.length / 3))
})

test('a zero or throwing synchronous write stops safely without retrying forever', () => {
  for (const outcome of ['zero', 'throw']) {
    let calls = 0
    assert.doesNotThrow(() => reportStartupRefusal({
      code: 'STOPPED_WRITE',
      message: outcome,
      environment: { MC_SMOKE_HEADLESS: '1' },
      dialog: { showErrorBox: () => assert.fail('headless refusal opened a dialog') },
      stderr: { fd: 2, write: () => assert.fail('fd-backed stderr used its stream writer') },
      writeSync: () => {
        calls += 1
        if (outcome === 'throw') throw new Error('stderr unavailable')
        return 0
      },
    }))
    assert.equal(calls, 1, `${outcome} write was retried without making progress`)
  }
})

test('interactive and near-miss headless values preserve the modal refusal', () => {
  for (const value of [undefined, '', '0', 'true', ' 1', 1]) {
    const environment = value === undefined ? {} : { MC_SMOKE_HEADLESS: value }
    const observed = harness(environment)
    assert.equal(observed.dialogCalls, 1, `unexpected headless handling for ${JSON.stringify(value)}`)
    assert.equal(observed.stderr, '')
    assert.deepEqual(observed.result, { headless: false, surface: 'dialog' })
  }
})

test('an unavailable interactive dialog falls back to the same coded stderr refusal', () => {
  let stderr = ''
  const result = reportStartupRefusal({
    code: 'DIALOG_FAILED',
    message: 'The dialog was unavailable.',
    environment: {},
    dialog: { showErrorBox: () => { throw new Error('no desktop') } },
    stderr: { write: text => { stderr += text } },
  })
  assert.equal(stderr, 'DIALOG_FAILED: The dialog was unavailable.\n')
  assert.deepEqual(result, { headless: false, surface: 'stderr' })
})

test('all early profile and environment refusals use the headless-safe reporter', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const earlyChecks = [
    ['installProfileCheck', 1],
    ['runtimeProfileCheck', 1],
    ['devUserDataCheck', 1],
    ['accountEnvironmentCheck', 1],
    ['ELECTRON_NODE_HANDOFF', 2],
  ]
  assert.equal([...main.matchAll(/reportStartupRefusal\(\{/g)].length, earlyChecks.length + 1)
  const storage = /prepareLinuxAccountState\(SHELL_USER_DATA_PATH\)\n\} catch \(error\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || ''
  assert.match(storage, /reportStartupRefusal\(\{ code: error.code, message: error.message, environment: process.env, dialog, stderr: process.stderr \}\)/)
  assert.match(storage, /process\.exit\(1\)/)
  assert.doesNotMatch(main, /dialog\.showErrorBox\('ToolsEnabled could not start'/,
    'an early refusal can still block a headless QA launch in a modal dialog')
  for (const [check, exitCode] of earlyChecks) {
    const condition = check === 'ELECTRON_NODE_HANDOFF'
      ? 'ELECTRON_NODE_HANDOFF\\?\\.ok === false'
      : `${check}\\.ok !== true`
    const block = new RegExp(`if \\(${condition}\\) \\{([\\s\\S]*?)\\n\\}`).exec(main)?.[1] || ''
    assert.match(block, new RegExp(`reportStartupRefusal\\(\\{ \\.\\.\\.${check},`),
      `${check} bypasses the headless-safe refusal reporter`)
    assert.match(block, new RegExp(`process\\.exit\\(${exitCode}\\)`),
      `${check} reports a refusal but does not exit immediately`)
  }
})

// Exercise the shell's real HTTP handler without starting Electron, binding a
// socket, or reading/writing an owner profile. Both path dialects are values;
// these cases are not native Windows or on-screen acceptance evidence.
async function sourcePageFixture({ paths, packaged = false, files = new Map(), readError } = {}) {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const start = main.indexOf('function serveDist()')
  const end = main.indexOf('\nipcMain.', start)
  assert.ok(start >= 0 && end > start, 'locate the shell HTTP handler for behavioral execution')
  const dist = paths.resolve('source-fixture', 'dist')
  const origin = new URL('http://127.0.0.1:1')
  let handler
  const sandbox = {
    path: paths, URL, DIST: dist, app: { isPackaged: packaged }, shellOrigin: origin.origin,
    MIME: { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' },
    http: { createServer(fn) { handler = fn; return { on() {} } } },
    fs: { readFile(file, callback) {
      queueMicrotask(() => {
        const value = files.get(paths.relative(dist, file).split(paths.sep).join('/'))
        if (readError) callback(Object.assign(new Error('fixture read refused'), { code: readError }))
        else if (value === undefined) callback(Object.assign(new Error('fixture file missing'), { code: 'ENOENT' }))
        else callback(null, Buffer.from(value))
      })
    } },
    serveOwnerPurchaseList: () => false, serveResearchWorkspacePointer: () => false,
    serveConfiguredProjection: async () => false, serveSignup: () => false, serveFeedback: () => false,
    SHELL_PORTS: [Number(origin.port)], SHELL_HOST: origin.hostname,
    preferredPortFirst: ports => ports, readState: () => ({}), writeState() {},
    listenOnFirstFreePort: async () => Number(origin.port), fatalStartup: error => { throw error },
  }
  await vm.runInNewContext(`${main.slice(start, end)}\nserveDist()`, sandbox)
  return {
    files,
    request(url = '/', host = origin.host) {
      return new Promise((resolve, reject) => {
        const headers = {}
        let status
        const response = {
          setHeader(name, value) { headers[name.toLowerCase()] = value },
          writeHead(code, reasonOrHeaders, extraHeaders) {
            status = code
            Object.assign(headers, typeof reasonOrHeaders === 'object' ? reasonOrHeaders : extraHeaders)
          },
          end(body = '') { resolve({ status, headers, body: String(body) }) },
        }
        Promise.resolve(handler({ url, headers: { host } }, response)).catch(reject)
      })
    },
  }
}

// The window preload paints over whatever the shell answers: a fixed title
// strip across the top, and a report of the body's computed colours that the
// shell uses to repaint the window behind the page. Both are read from their
// own source here, so the page is checked against the real strip and the real
// theme seeds rather than a copy of their numbers.
const PRELOAD_SOURCE = readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
const SHELL_SOURCE = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const TITLE_STRIP_HEIGHT = Number(/const TITLEBAR_HEIGHT = (\d+)/.exec(PRELOAD_SOURCE)?.[1])
const THEME_SEEDS = Object.fromEntries([...(/const THEME_SEED = \{([\s\S]*?)\n\}/.exec(SHELL_SOURCE)?.[1] || '')
  .matchAll(/(\w+): \{ bg: '(#[0-9a-f]{6})', ink: '(#[0-9a-f]{6})' \}/gi)]
  .map(([, theme, bg, ink]) => [theme, { bg: bg.toLowerCase(), ink: ink.toLowerCase() }]))

function relativeLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(first, second) {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

// Every declaration of every rule whose selector list names the element.
function declarationsFor(css, element) {
  const found = {}
  for (const [, selectors, block] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!selectors.split(',').map(selector => selector.trim()).includes(element)) continue
    for (const declaration of block.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon > 0) found[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
    }
  }
  return found
}

for (const [platform, paths] of [['Linux', path.posix], ['Windows', path.win32]]) {
  test(`${platform} the source startup explanation paints its own readable colours below the shell title strip`, { timeout: 5000 }, async () => {
    // A text/plain answer has a transparent body. The preload reported it as
    // #000000, so a real window showed default black text on black: blank.
    assert.ok(TITLE_STRIP_HEIGHT > 0, 'read the preload title strip height')
    assert.ok(THEME_SEEDS.white, 'read the shell theme seeds')
    const cases = [[new Map(), undefined], [new Map([['index.html', '']]), undefined], [new Map(), 'EACCES']]
    for (const [files, readError] of cases) {
      const page = await (await sourcePageFixture({ paths, files, readError })).request()
      assert.equal(page.status, 503)
      assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
      const theme = /<html\b[^>]*\sdata-theme="([a-z]+)"/.exec(page.body)?.[1]
      assert.ok(THEME_SEEDS[theme], `the page names a theme the shell accepts, not ${theme}`)
      const css = [...page.body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n')
      const body = declarationsFor(css, 'body')
      assert.equal(body.background?.toLowerCase(), THEME_SEEDS[theme].bg, 'the body paints its seeded background itself')
      assert.equal(body.color?.toLowerCase(), THEME_SEEDS[theme].ink, 'the body paints its seeded text colour itself')
      assert.ok(contrastRatio(body.background, body.color) >= 7, 'the text is readable on its own background')
      const main = declarationsFor(css, 'main')
      const top = Number(/^(\d+)px\b/.exec(main['padding-top'] || main.padding || '')?.[1])
      assert.ok(top > TITLE_STRIP_HEIGHT, `the text starts below the ${TITLE_STRIP_HEIGHT}px title strip, not at ${top}px`)
      const words = (/<main>([\s\S]*?)<\/main>/.exec(page.body)?.[1] || '').replace(/<[^>]*>/g, '')
      assert.match(words, readError
        ? /^ToolsEnabled could not read its built app page\. Check access to dist\/index\.html/
        : /^This source copy is missing its built app page, or that page is empty\. .*run npm run build, then reopen ToolsEnabled\.$/)
    }
  })

  test(`${platform} source startup names the build command for missing and empty renderer output`, { timeout: 5000 }, async () => {
    // Missing dist and an empty dist have the same ENOENT read result. Also
    // cover an interrupted build that wrote an empty index successfully.
    for (const files of [new Map(), new Map([['index.html', '']])]) {
      const fixture = await sourcePageFixture({ paths, files })
      for (const url of ['/', '/index.html', '/unknown-route']) {
        const page = await fixture.request(url)
        assert.equal(page.status, 503)
        assert.match(page.headers['content-type'], /text\/(plain|html)/)
        assert.equal(page.headers['cache-control'], 'no-store')
        assert.match(page.body, /npm run build/)
        assert.match(page.body, /source copy.*app folder/i)
        assert.match(page.body, /reopen ToolsEnabled/)
        assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'")
      }
    }
  })

  test(`${platform} source startup distinguishes unreadable output from an absent build`, { timeout: 5000 }, async () => {
    for (const readError of ['EACCES', 'EPERM', 'EIO', 'EISDIR', 'ENOTDIR']) {
      const fixture = await sourcePageFixture({ paths, readError })
      const page = await fixture.request()
      assert.equal(page.status, 503)
      assert.match(page.body, /could not read/i)
      assert.match(page.body, /dist\/index\.html/)
      assert.doesNotMatch(page.body, /npm run build/)
    }
  })

  test(`${platform} a built source copy and an installed copy keep serving their renderer bytes`, { timeout: 5000 }, async () => {
    const html = '<!doctype html><title>Built renderer</title><main>Ready</main>'
    for (const packaged of [false, true]) {
      const files = new Map([['index.html', html], ['assets/app.js', 'export const ready = true']])
      const fixture = await sourcePageFixture({ paths, packaged, files })
      for (const url of ['/', '/index.html', '/unknown-route']) {
        const page = await fixture.request(url)
        assert.equal(page.status, 200)
        assert.equal(page.body, html)
        assert.equal(page.headers['content-type'], 'text/html')
      }
      const script = await fixture.request('/assets/app.js')
      assert.equal(script.body, files.get('assets/app.js'))
      assert.equal(script.headers['content-type'], 'text/javascript')
    }
    const installedMissing = await sourcePageFixture({ paths, packaged: true })
    const page = await installedMissing.request()
    assert.equal(page.status, 404, 'preserve the installed missing-file response')
    assert.doesNotMatch(page.body, /npm run build/, 'installed users must not receive source-build advice')
  })

  test(`${platform} a build completed after the explanation loads on the next request`, { timeout: 5000 }, async () => {
    const fixture = await sourcePageFixture({ paths })
    assert.equal((await fixture.request()).status, 503)
    fixture.files.set('index.html', '<main>Newly built app</main>')
    const page = await fixture.request()
    assert.equal(page.status, 200)
    assert.equal(page.body, '<main>Newly built app</main>')
  })

  test(`${platform} missing-build handling preserves JSON failures and origin/path refusals`, { timeout: 5000 }, async () => {
    const fixture = await sourcePageFixture({ paths })
    const data = await fixture.request('/data/missing.json')
    assert.equal(data.status, 404)
    assert.equal(data.headers['content-type'], 'application/json')
    assert.equal(JSON.parse(data.body).ok, false)
    const wrongHost = await fixture.request('/', 'untrusted.invalid')
    assert.equal(wrongHost.status, 421)
    assert.equal(wrongHost.headers['content-security-policy'], "frame-ancestors 'none'")
    assert.equal((await fixture.request('/%')).status, 400)
    assert.equal((await fixture.request('/../../elsewhere')).status, 403)
    const preview = await fixture.request('/preview')
    assert.equal(preview.headers['content-security-policy'], "frame-ancestors 'self'")
  })
}
