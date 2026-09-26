/* THE OPERATOR'S RESEARCH WORKSPACE POINTER COMES FROM THE INSTALL, NOT THE BUILD.
 *
 * The hotload lane put public/research-workspace.json ({url} of the person's
 * local research-data-server) into the tree, and check-renderer-payload rightly
 * refused to ship it: it names a port on one machine. The page still needs it
 * (src/research-data-workspace.js asks /research-workspace.json first), so the
 * shell serves it from userData the way it serves the purchase list. These
 * checks lift the real route out of shell/main.cjs and drive it against a
 * temporary userData, both ways round, and pin that the build itself carries
 * no such file. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const main = readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')

function routeFor(userData) {
  const source = declaredFunctionSource(main, 'serveResearchWorkspacePointer')
  // eslint-disable-next-line no-new-func
  const factory = new Function('fs', 'path', 'userData', `
    const RESEARCH_WORKSPACE_POINTER_URL = '/research-workspace.json'
    const RESEARCH_WORKSPACE_POINTER_FILE = () => path.join(userData, 'research-workspace.json')
    const MAX_RESEARCH_WORKSPACE_POINTER_BYTES = 4 * 1024
    ${source}
    return serveResearchWorkspacePointer
  `)
  return factory(fs, path, userData)
}

function fakeResponse() {
  const out = { status: null, headers: null, body: '' }
  const done = new Promise(resolve => {
    out.writeHead = (status, reasonOrHeaders, headers) => { out.status = status; out.headers = headers || reasonOrHeaders }
    out.end = body => { out.body = String(body ?? ''); resolve(out) }
  })
  return { out, done }
}

async function ask(userData, url = '/research-workspace.json') {
  const route = routeFor(userData)
  const { out, done } = fakeResponse()
  const handled = route(url, { headers: {} }, out)
  if (!handled) return { handled }
  await done
  return { handled, status: out.status, body: JSON.parse(out.body), type: out.headers['content-type'] }
}

test('the route answers only its own path', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'te-research-pointer-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  assert.equal((await ask(userData, '/data/research.json')).handled, false)
  assert.equal((await ask(userData, '/research-workspace.json/extra')).handled, false)
})

test('no saved pointer answers 404 JSON, which the page reads as "no saved folder"', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'te-research-pointer-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  const answer = await ask(userData)
  assert.equal(answer.handled, true)
  assert.equal(answer.status, 404)
  assert.equal(answer.body.ok, false)
  assert.match(answer.type, /json/)
})

test('a saved local pointer is served as exactly {url}, and only its origin travels', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'te-research-pointer-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  fs.writeFileSync(path.join(userData, 'research-workspace.json'), JSON.stringify({ url: 'http://127.0.0.1:57924/some/path', note: 'not for the page' }))
  const answer = await ask(userData)
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { url: 'http://127.0.0.1:57924' })
})

test('a pointer that is not a loopback http address is refused by name', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'te-research-pointer-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  for (const url of ['https://example.com', 'http://10.0.0.5:57924', 'file:///C:/data', 42, null]) {
    fs.writeFileSync(path.join(userData, 'research-workspace.json'), JSON.stringify({ url }))
    const answer = await ask(userData)
    assert.equal(answer.status, 404, `${String(url)} must not be handed to the page`)
    assert.equal(answer.body.ok, false)
  }
  fs.writeFileSync(path.join(userData, 'research-workspace.json'), '{ not json')
  assert.equal((await ask(userData)).status, 404)
})

test('the route is wired before the SPA fallback, and the build carries no pointer of its own', () => {
  const route = main.indexOf('if (serveResearchWorkspacePointer(url, req, res)) return')
  const fallback = main.indexOf("let file = path.normalize(path.join(DIST, url === '/' ? 'index.html' : url))")
  assert.ok(route > 0 && fallback > route, 'the pointer route must run before the dist read')
  assert.equal(existsSync(path.join(ROOT, 'public', 'research-workspace.json')), false,
    'the machine-local pointer must never sit under public/, where vite would ship it')
  const boundary = JSON.parse(readFileSync(path.join(ROOT, 'config', 'renderer-payload-boundary.json'), 'utf8'))
  assert.ok(boundary.operator.paths.includes('research-workspace.json'), 'the renderer boundary classifies the pointer as operator data')
  const page = readFileSync(path.join(ROOT, 'src', 'research-data-workspace.js'), 'utf8')
  assert.match(page, /fetchImpl\('\/research-workspace\.json'/, 'the page still asks the shell for the pointer')
})
