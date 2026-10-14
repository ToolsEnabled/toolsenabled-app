import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const start = main.indexOf('function serveDist()')
const end = main.indexOf('\nipcMain.', start)
assert.ok(start >= 0 && end > start, 'find the actual shell HTTP handler')

async function fixture(paths) {
  const dist = paths.resolve('fixture', 'dist')
  const sibling = paths.resolve('fixture', 'dist-private')
  const files = new Map([
    [paths.join(dist, 'index.html'), 'APP_INDEX'],
    [paths.join(dist, 'assets', 'app.js'), 'APP_ASSET'],
    [paths.join(sibling, 'secret.txt'), 'SIBLING_SECRET'],
  ])
  let handler
  const sandbox = {
    path: paths, URL, DIST: dist, app: { isPackaged: true }, shellOrigin: 'http://127.0.0.1:4610',
    MIME: { '.html': 'text/html', '.js': 'text/javascript', '.txt': 'text/plain' },
    http: { createServer(fn) { handler = fn; return { on() {} } } },
    fs: { readFile(file, callback) {
      queueMicrotask(() => files.has(file)
        ? callback(null, Buffer.from(files.get(file)))
        : callback(Object.assign(new Error('missing'), { code: 'ENOENT' })))
    } },
    serveOwnerPurchaseList: () => false, serveResearchWorkspacePointer: () => false,
    serveConfiguredProjection: async () => false, serveSignup: () => false, serveFeedback: () => false,
    SHELL_PORTS: [4610], SHELL_HOST: '127.0.0.1',
    preferredPortFirst: ports => ports, readState: () => ({}), writeState() {},
    listenOnFirstFreePort: async () => 4610, fatalStartup: error => { throw error },
  }
  await vm.runInNewContext(`${main.slice(start, end)}\nserveDist()`, sandbox)
  return url => new Promise((resolve, reject) => {
    let status = 200
    const response = {
      setHeader() {},
      writeHead(code) { status = code },
      end(body = '') { resolve({ status, body: String(body) }) },
    }
    Promise.resolve(handler({ url, headers: { host: '127.0.0.1:4610' } }, response)).catch(reject)
  })
}

for (const [name, paths, encodedParent] of [
  ['POSIX', path.posix, '/..%2Fdist-private%2Fsecret.txt'],
  ['Windows', path.win32, '/..%5Cdist-private%5Csecret.txt'],
]) {
  test(`${name} static paths stay inside dist even when a sibling shares its prefix`, async () => {
    const request = await fixture(paths)
    assert.deepEqual(await request('/assets/app.js'), { status: 200, body: 'APP_ASSET' })
    const escaped = await request(encodedParent)
    assert.equal(escaped.status, 403)
    assert.doesNotMatch(escaped.body, /SIBLING_SECRET/)
  })
}
