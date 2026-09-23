import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'
import { serveCandidateRenderer, geometryRequestAllowed, fenceGeometryContext, visibleGeometryPressPoint } from '../lib/qa-candidate-browser.mjs'
import { artifactProofCounts, planFor, releaseArgumentsFor, verdictFor } from '../packaged-qa-suite.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const { releaseArgument, selectRendererDist, rendererRequestPath } = require('../lib/qa-renderer-dist.cjs')
const toolsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function fixture(t, html = '<h1>candidate only</h1>') {
  const root = mkdtempSync(path.join(tmpdir(), 'te-renderer-subject-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'archive-source')
  const repo = path.join(root, 'different checkout')
  const release = path.join(root, 'candidate package')
  mkdirSync(path.join(source, 'dist', 'assets'), { recursive: true })
  mkdirSync(path.join(repo, 'dist'), { recursive: true })
  mkdirSync(path.join(release, 'resources'), { recursive: true })
  writeFileSync(path.join(source, 'dist', 'index.html'), html)
  writeFileSync(path.join(source, 'dist', 'assets', 'index.js'), 'candidate renderer bytes')
  writeFileSync(path.join(repo, 'dist', 'index.html'), 'wrong checkout bytes')
  const archive = path.join(release, 'resources', 'app.asar')
  await asar.createPackage(source, archive)
  return { root, source, repo, release, archive }
}

test('renderer release arguments reject duplicate, missing and option-shaped values', () => {
  assert.equal(releaseArgument(['electron', 'driver']), null)
  for (const args of [['--release'], ['--release='], ['--release', '--visible'], ['--release=a', '--release=b'], ['--release', 'a', '--release=b']]) {
    assert.throws(() => releaseArgument(['electron', 'driver', ...args]), /--release/)
  }
})

test('source-only, website and installer scenarios bind the selected archive and remain unmet proof', async t => {
  const { release, archive } = await fixture(t)
  const before = readFileSync(archive)
  for (const name of ['ring-fidelity-qa.mjs', 'phone-signin-gate-qa.mjs', 'purchase-cart-readable-qa.cjs',
    'write-outcome-restate-qa.cjs', 'nsis-upgrade-roundtrip-qa.mjs']) {
    const source = readFileSync(path.join(toolsRoot, name), 'utf8')
    assert.deepEqual(releaseArgumentsFor(source, release), ['--release', release])
    for (const args of [['--release', release], [`--release=${release}`]]) {
      // The CJS drivers must refuse before importing Electron. Neither source
      // fixtures, website navigation nor installer builds may start here.
      const child = spawnSync(process.execPath, [path.join(toolsRoot, name), ...args], { encoding: 'utf8', timeout: 10_000 })
      assert.equal(child.status, 3, `${name}: ${child.stderr}`)
      assert.match(child.stderr, /candidate subject:/)
      assert.ok(child.stderr.includes(createHash('sha256').update(before).digest('hex')))
      assert.equal(verdictFor({ code: child.status, output: child.stderr }), 'INCONCLUSIVE')
      assert.doesNotMatch(child.stderr, /checks passed/)
    }
  }
  assert.deepEqual(readFileSync(archive), before)
})

test('metrics candidate cannot substitute an external engine or quietly stage checkout bytes', async t => {
  const { release } = await fixture(t)
  const source = readFileSync(path.join(toolsRoot, 'metrics-usage-live-qa.mjs'), 'utf8')
  assert.deepEqual(releaseArgumentsFor(source, release), ['--release', release])
  const child = spawnSync(process.execPath, [path.join(toolsRoot, 'metrics-usage-live-qa.mjs'),
    '--release', release, '--engine', '/wrong/engine'], { encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(child.status, 0)
  assert.match(child.stderr, /cannot override the engine in an explicit --release/)
  assert.match(source, /await stage\(scratch\)/)
  assert.match(source, /staged = candidate\.archive/)
  assert.match(source, /measuredEngine = path\.join\(candidate\.appRoot, 'resources', 'capability'\)/)
  assert.match(source, /renderer\?\.assertUnchanged\(\)/)
  assert.match(source, /runQaDriverProcess\(electron/)
  assert.match(source, /cleanupConfirmed/)
})

test('subscription candidate uses its own packed renderer and service and refuses dist overrides', () => {
  const source = readFileSync(path.join(toolsRoot, 'subscribe-page-drive.mjs'), 'utf8')
  const tree = parseAst(source)
  const declaration = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'selectedSubscribeDirectory')
  assert.ok(declaration)
  const fn = '(' + source.slice(declaration.start, declaration.end) + ')'
  const dist = '/selected/resources/app.asar/dist'
  const select = env => vm.runInNewContext(fn, { RENDERER: { release: '/selected', dist }, process: { env }, path })()
  assert.equal(select({}), dist)
  assert.throws(() => select({ SUB_DRIVE_DIST: '/wrong/dist' }), /cannot override/)
  assert.match(source, /requireShell\(path\.join\(SUBJECT_ROOT, 'shell', 'subscribe-endpoint\.cjs'\)\)/)
  assert.match(source, /requireShell\(path\.join\(SUBJECT_ROOT, 'shell', 'subscribe-service\.cjs'\)\)/)
  assert.match(source, /RENDERER\.release \? path\.dirname\(DIST\) : REPO_ROOT/)
  assert.match(source, /rendererRequestPath\(DIST, request\.url\)/)
  assert.match(source, /RENDERER\.assertUnchanged\(\)/)
  assert.equal(planFor(['subscribe-page-drive.mjs'])[0].artifactProof, 'instrumented-copy')
})

for (const inline of [false, true]) {
  test(`real candidate ASAR is selected and hashed without checkout fallback (${inline ? 'inline' : 'split'})`, async t => {
    const { repo, release, archive } = await fixture(t)
    const argv = ['electron', 'driver', ...(inline ? [`--release=${release}`] : ['--release', release])]
    const subject = selectRendererDist({ argv, repoRoot: repo })
    assert.equal(subject.dist, path.join(archive, 'dist'))
    assert.equal(subject.release, release)
    assert.equal(subject.provenance.mode, 'candidate-renderer')
    assert.equal(subject.provenance.proofScope, 'renderer-in-host-electron')
    assert.equal(subject.provenance.sha256, createHash('sha256').update(readFileSync(archive)).digest('hex'))
    assert.equal(asar.extractFile(archive, 'dist/index.html').toString(), '<h1>candidate only</h1>')
    assert.equal(subject.assertUnchanged(), undefined)
    assert.equal(readFileSync(path.join(repo, 'dist', 'index.html'), 'utf8'), 'wrong checkout bytes')
  })
}

test('renderer source mode retains the development dist path without claiming a candidate', () => {
  const repoRoot = path.join(tmpdir(), 'not-a-candidate')
  const subject = selectRendererDist({ argv: ['electron', 'driver'], repoRoot })
  assert.equal(subject.dist, path.join(repoRoot, 'dist'))
  assert.equal(subject.release, null)
  assert.equal(subject.provenance.mode, 'source-renderer')
  assert.equal(subject.provenance.sha256, undefined)
})

test('an explicit missing archive refuses even when checkout dist exists', async t => {
  const { repo, release, archive } = await fixture(t)
  rmSync(archive)
  assert.throws(() => selectRendererDist({ argv: ['electron', 'driver', '--release', release], repoRoot: repo }), { code: 'ENOENT' })
})

test('a candidate with no packed renderer entry cannot silently select checkout HTML', async t => {
  const { source, repo, release, archive } = await fixture(t, '')
  assert.throws(() => selectRendererDist({ argv: ['electron', 'driver', '--release', release], repoRoot: repo }), /ordinary packed/)
  rmSync(path.join(source, 'dist', 'index.html'))
  await asar.createPackage(source, archive)
  assert.throws(() => selectRendererDist({ argv: ['electron', 'driver', '--release', release], repoRoot: repo }))
})

test('renderer identity verification detects candidate mutation after selection', async t => {
  const { repo, release, archive } = await fixture(t)
  const subject = selectRendererDist({ argv: ['electron', 'driver', '--release', release], repoRoot: repo })
  appendFileSync(archive, 'changed')
  assert.throws(() => subject.assertUnchanged(), /changed during QA/)
})

test('Electron measures the physical ASAR file instead of its virtual directory', async t => {
  const { repo, release } = await fixture(t)
  const source = readFileSync(path.join(toolsRoot, 'lib/qa-renderer-dist.cjs'), 'utf8')
  const exports = { exports: {} }
  const loaded = []
  vm.runInNewContext(source, { module: exports, process: { versions: { electron: 'qa-host' } }, Buffer, URL,
    require(name) {
      loaded.push(name)
      if (name === 'node:fs') assert.fail('Electron virtual fs must not measure the physical archive')
      return name === 'original-fs' ? require('node:fs') : require(name)
    },
  })
  const subject = exports.exports.selectRendererDist({ argv: ['electron', 'qa', '--release', release], repoRoot: repo })
  assert.equal(subject.provenance.mode, 'candidate-renderer')
  subject.assertUnchanged()
  assert.ok(loaded.includes('original-fs'))
})

test('external unpacked renderer assets are refused even with a packed HTML entry', async t => {
  const { repo, release, source, archive } = await fixture(t)
  await asar.createPackageWithOptions(source, archive, { unpack: '**/index.js' })
  assert.throws(() => selectRendererDist({ argv: ['electron', 'qa', '--release', release], repoRoot: repo }), /linked or unpacked assets/)
})

for (const component of ['release', 'resources']) {
  test(`a linked ${component} directory is refused before archive decoding`, async t => {
    const { root, release } = await fixture(t)
    // Keep the real freshly written ASAR in place. On Windows the packer's
    // write stream can still prevent renaming its parent after createPackage
    // resolves. A separate linked entry exercises the same pre-decoder fence.
    const linkedRelease = path.join(root, 'linked-candidate')
    if (component === 'release') symlinkSync(release, linkedRelease, 'junction')
    else {
      mkdirSync(linkedRelease)
      symlinkSync(path.join(release, 'resources'), path.join(linkedRelease, 'resources'), 'junction')
    }
    const api = { uncache() { assert.fail('link target must not reach archive decoder') } }
    assert.throws(() => selectRendererDist({ argv: ['electron', 'driver', '--release', linkedRelease], asarApi: api }), /ordinary directory/)
  })
}

test('renderer requests cannot escape into a prefix-sharing sibling or malformed path', () => {
  const dist = path.join(tmpdir(), 'candidate', 'resources', 'app.asar', 'dist')
  assert.equal(rendererRequestPath(dist, '/'), path.join(dist, 'index.html'))
  assert.equal(rendererRequestPath(dist, '/assets/index.js?v=1'), path.join(dist, 'assets', 'index.js'))
  for (const request of ['/%2e%2e%2fdist-private/secret', '/%2e%2e%5cdist-private/secret', '/%00', '/%zz']) {
    assert.equal(rendererRequestPath(dist, request), null, request)
  }
})

test('Page2 and popup drivers consume the candidate subject and keep instrumented scope', () => {
  const entries = planFor(['page2-qa.cjs', 'owner-popup-qa.cjs'])
  for (const entry of entries) {
    const source = readFileSync(entry.file, 'utf8')
    assert.match(source, /selectRendererDist\(\{ argv: process\.argv, repoRoot: ROOT \}\)/)
    assert.match(source, /const DIST = RENDERER\.dist/)
    assert.match(source, /rendererRequestPath\(DIST, request\.url\)/)
    assert.match(source, /RENDERER\.assertUnchanged\(\)/)
    assert.match(source, /renderer: RENDERER\.provenance/)
    assert.deepEqual(releaseArgumentsFor(source, '/chosen'), ['--release', '/chosen'])
    assert.equal(entry.artifactProof, 'instrumented-copy')
  }
  assert.deepEqual(artifactProofCounts(entries.map(entry => ({ ...entry, verdict: 'PASS' }))),
    { exact: 0, instrumented: 2, unclassified: 0 })
})

test('popup derives its canonical theme from selected candidate capability, not checkout', async t => {
  const { repo, release } = await fixture(t)
  const source = readFileSync(path.join(toolsRoot, 'owner-popup-qa.cjs'), 'utf8')
  const tree = parseAst(source)
  const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'shippedThemeManifest')
  const measured = []
  const manifest = { themes: { white: {}, tan: {}, black: {} } }
  const read = vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, {
    ROOT: repo, RENDERER: { release }, path,
    fs: { existsSync(file) { measured.push(file); return true } },
    require(file) { measured.push(file); return { themeManifest: () => manifest } },
  })
  const result = read()
  const expected = path.join(release, 'resources', 'capability', 'src', 'lib', 'owner-prompt-theme.js')
  assert.equal(result.source, expected)
  assert.deepEqual(measured, [expected, expected])
  assert.match(source, /RENDERER\.release && themePathArgument/)
})

test('Page2 emits its actual completed check count in the suite summary vocabulary', () => {
  const source = readFileSync(path.join(toolsRoot, 'page2-qa.cjs'), 'utf8')
  assert.match(source, /report\.results\.filter\(result => result\.pass\)\.length/)
  assert.match(source, /report\.results\.length\} checks passed/)
  assert.equal(verdictFor({ code: 0, output: '63/63 checks passed\n' }), 'PASS')
  assert.equal(verdictFor({ code: 0, output: '62/63 checks passed\n' }), 'FAIL')
})

test('renderer subject regression is a required release source suite', () => {
  const entries = SOURCE_MANIFESTS.app.inventory.filter(row => row.file === 'tools/test/qa-renderer-dist.test.mjs')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].reason, null)
})

test('browser candidate server serves actual packed bytes and refuses APIs, writes and traversal', async t => {
  const { repo, release, archive } = await fixture(t)
  const before = readFileSync(archive)
  const server = await serveCandidateRenderer({ argv: ['node', 'geometry', '--release', release], repoRoot: repo, environment: {} })
  t.after(() => server.close())
  assert.equal(server.provenance.proofScope, 'candidate-renderer-in-emulated-browser')
  assert.equal(server.provenance.sha256, createHash('sha256').update(before).digest('hex'))
  const index = await fetch(server.origin + '/')
  assert.equal(index.status, 200)
  assert.equal(await index.text(), '<h1>candidate only</h1>')
  assert.match(index.headers.get('content-security-policy'), /form-action 'none'/)
  const asset = await fetch(server.origin + '/assets/index.js?v=1')
  assert.equal(await asset.text(), 'candidate renderer bytes')
  assert.match(asset.headers.get('content-type'), /javascript/)
  const head = await fetch(server.origin + '/', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  for (const url of ['/v1/account', '/api/anything', '/assets/missing.js', '/%2e%2e%2fshell/main.cjs', '/%00', '/%zz']) {
    assert.equal((await fetch(server.origin + url)).status, 404, url)
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal((await fetch(server.origin + '/', { method })).status, 405, method)
  }
  assert.deepEqual(readFileSync(archive), before)
  assert.equal(server.stats.served, 3)
  assert.equal(server.stats.refused, 10)
  assert.equal(server.staticPath('/assets/index.js?version=1'), true)
  assert.equal(server.staticPath('/v1/account'), false)
  await server.close()
  assert.equal(await server.close(), undefined, 'closure is idempotent')
  await assert.rejects(fetch(server.origin + '/', { signal: AbortSignal.timeout(1000) }))
})

test('browser candidate selection refuses conflicting web targets, malformed arguments and missing archives', async t => {
  const { repo, release } = await fixture(t)
  for (const environment of [{ APP_ORIGIN: 'http://127.0.0.1:1234' }, { APP_PATH: '/app/' }]) {
    await assert.rejects(serveCandidateRenderer({ argv: ['--release', release], repoRoot: repo, environment }), /cannot be combined/)
  }
  for (const argv of [['--release'], ['--release='], ['--release=a', '--release=b'], ['--release', '--visible']]) {
    await assert.rejects(serveCandidateRenderer({ argv, repoRoot: repo, environment: {} }), /--release/)
  }
  await assert.rejects(serveCandidateRenderer({ argv: ['--release', path.join(release, 'absent')], repoRoot: repo, environment: {} }), { code: 'ENOENT' })
  assert.equal(await serveCandidateRenderer({ argv: ['node', 'geometry'], repoRoot: repo, environment: {} }), null)
})

test('browser candidate mutation is detected at server closure, not relabeled a renderer pass', async t => {
  const { repo, release, archive } = await fixture(t)
  const server = await serveCandidateRenderer({ argv: ['--release=' + release], repoRoot: repo, environment: {} })
  appendFileSync(archive, 'unexpected change')
  await assert.rejects(server.close(), /changed during QA/)
  await assert.rejects(fetch(server.origin + '/', { signal: AbortSignal.timeout(1000) }))
})

test('geometry browser requests permit only read-only static assets at the selected origin', () => {
  const origin = 'http://127.0.0.1:43210'
  const staticPath = pathname => ['/', '/assets/app.js'].includes(pathname)
  const allowed = (url, method = 'GET') => geometryRequestAllowed({ origin, url, method, staticPath })
  assert.equal(allowed(origin + '/'), true)
  assert.equal(allowed(origin + '/assets/app.js?v=1', 'HEAD'), true)
  for (const url of [origin + '/v1/account', origin + '/api/agent', 'http://127.0.0.1:43211/',
    'https://example.invalid/', 'file:///owner/anything', 'http://fixture:secret@127.0.0.1:43210/', 'malformed']) {
    assert.equal(allowed(url), false, url)
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal(allowed(origin + '/', method), false)
  for (const pathname of ['/v1/account', '/api/file.js', '/app/v1/account/', '/rpc/']) {
    assert.equal(geometryRequestAllowed({ origin, url: origin + pathname, method: 'GET' }), false)
  }
  for (const pathname of ['/', '/src/main.js', '/@vite/client']) {
    assert.equal(geometryRequestAllowed({ origin, url: origin + pathname, method: 'GET' }), true)
  }
})

test('every geometry context blocks WebSockets and writes before pages can open', async () => {
  const callbacks = {}
  const context = {
    async routeWebSocket(pattern, callback) { assert.equal(pattern, '**/*'); callbacks.websocket = callback },
    async route(pattern, callback) { assert.equal(pattern, '**/*'); callbacks.http = callback },
  }
  const origin = 'http://127.0.0.1:43210'
  const blocked = await fenceGeometryContext(context, { origin, staticPath: pathname => pathname === '/' })
  let continued = 0, aborted = 0, closed = 0
  for (const [url, method] of [[origin + '/', 'GET'], [origin + '/', 'POST'], [origin + '/v1/account', 'GET'], ['http://127.0.0.1:43211/', 'GET']]) {
    await callbacks.http({ request: () => ({ url: () => url, method: () => method }),
      continue() { continued++ }, abort(reason) { assert.equal(reason, 'blockedbyclient'); aborted++ } })
  }
  callbacks.websocket({ close() { closed++ } })
  assert.equal(continued, 1)
  assert.equal(aborted, 3)
  assert.equal(closed, 1)
  assert.deepEqual(blocked, { http: 3, websocket: 1 })
  await assert.rejects(fenceGeometryContext({ route() { assert.fail('missing WebSocket support must refuse before routing') } }, { origin }), /WebSocket blocking support/)
})

test('phone geometry selects candidate bytes, fences every fresh browser context and keeps narrow proof scope', () => {
  const source = readFileSync(path.join(toolsRoot, 'phone-sheet-geometry-qa.mjs'), 'utf8')
  const [entry] = planFor(['phone-sheet-geometry-qa.mjs'])
  assert.equal(entry.artifactProof, 'instrumented-copy')
  assert.deepEqual(releaseArgumentsFor(source, '/chosen/candidate'), ['--release', '/chosen/candidate'])
  assert.match(source, /serveCandidateRenderer\(\{ argv: process\.argv, environment: process\.env, repoRoot: REPO_ROOT \}\)/)
  assert.match(source, /candidateRenderer\.assertUnchanged\(\)/)
  assert.match(source, /serviceWorkers: 'block'/)
  assert.equal((source.match(/browser\.newContext\(/g) || []).length, 1, 'all cases pass through the one fenced context builder')
  assert.match(source, /fenceGeometryContext\(context, \{ origin, staticPath: candidateRenderer\?\.staticPath \}\)/)
  assert.match(source, /sterileLaunchEnvironment\(/)
  assert.match(source, /checks - failures\.length\}\/\$\{checks\} checks passed/)
  assert.match(source, /missing\.length[\s\S]*?noVerdict\(/)
  assert.match(source, /LONG_CONVERSATION_TARGET_ENTRIES = 60/)
  assert.match(source, /page\.touchscreen\.tap\(target\.x, target\.y\)/)
  assert.match(source, /pressGeometryControl\(page, '\.phone-ledger-door-demo'/)
  assert.match(source, /pressGeometryControl\(page, '\.first-use-close'/)
  assert.equal((source.match(/if \(!await enterGeometryDemo\(page, label\)\) return/g) || []).length, 2,
    'ordinary and long-conversation cells must both enter via the public demo control')
  assert.match(source, /simulated === 'simulated'/)
  assert.match(source, /strayLedgerRows === 0/)
  assert.doesNotMatch(source, /setItem\(['"](?:mc\.example|.*auth|.*signedIn)/i,
    'a demo/sign-in state must not be fabricated to reach the sheet')
})

test('geometry presses reject obscured, disabled, hidden, transparent and off-screen controls', () => {
  const child = {}
  const make = overrides => ({ disabled: false, closest: () => null,
    getBoundingClientRect: () => ({ x: 4, y: 6, width: 40, height: 44 }),
    getAttribute: () => 'Visible control', textContent: 'Visible control', contains: value => value === child,
    ...overrides })
  const run = (node, hit = node) => vm.runInNewContext(`(${visibleGeometryPressPoint.toString()})`, {
    innerWidth: 320, innerHeight: 568,
    document: { querySelectorAll: () => [node], elementFromPoint: () => hit },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', ...node.style }),
  })('.fixture')
  const good = make()
  assert.deepEqual(JSON.parse(JSON.stringify(run(good))), { x: 24, y: 28, name: 'Visible control' })
  assert.equal(run(good, child).name, 'Visible control', 'a text child hit is still the same button')
  assert.equal(run(good, {}), null)
  for (const bad of [make({ disabled: true }), make({ closest: () => ({}) }),
    make({ style: { visibility: 'hidden' } }), make({ style: { display: 'none' } }), make({ style: { opacity: '0' } }),
    make({ getBoundingClientRect: () => ({ x: 310, y: 6, width: 40, height: 44 }) }),
    make({ getBoundingClientRect: () => ({ x: 4, y: 6, width: 0, height: 44 }) })]) {
    assert.equal(run(bad), null)
  }
})

test('preview serves the selected packed renderer and rejects a conflicting dist override', () => {
  const [entry] = planFor(['preview-browser-drive.mjs'])
  const source = readFileSync(entry.file, 'utf8')
  const tree = parseAst(source)
  const fn = name => {
    const node = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name)
    assert.ok(node, name)
    return `(${source.slice(node.start, node.end)})`
  }
  assert.equal(entry.artifactProof, 'instrumented-copy')
  assert.deepEqual(artifactProofCounts([{ ...entry, verdict: 'PASS' }]), { exact: 0, instrumented: 1, unclassified: 0 })
  assert.deepEqual(releaseArgumentsFor(source, '/chosen/candidate'), ['--release', '/chosen/candidate'])
  assert.match(source, /import rendererSubject from '\.\/lib\/qa-renderer-dist\.cjs'/)
  assert.match(source, /selectRendererDist\(\{ argv: process\.argv, repoRoot: REPO_ROOT \}\)/)
  const dist = path.join(tmpdir(), 'candidate', 'resources', 'app.asar', 'dist')
  const select = environment => vm.runInNewContext(fn('selectedPreviewDirectory'), {
    RENDERER: { release: '/chosen/candidate', dist }, process: { env: environment }, resolve: path.resolve,
  })()
  assert.equal(select({}), dist)
  assert.throws(() => select({ PREVIEW_DIST: '/wrong-checkout' }), /cannot override/)
  const legacy = vm.runInNewContext(fn('selectedPreviewDirectory'), {
    RENDERER: { release: null, dist: '/default' }, process: { env: { PREVIEW_DIST: 'preview-source' } }, resolve: path.resolve,
  })()
  assert.equal(legacy, path.resolve('preview-source'))

  const reads = []
  const serve = vm.runInNewContext(fn('makeServer'), {
    createServer: callback => callback, URL, DIST: dist, rendererRequestPath,
    existsSync: file => { reads.push(file); return true },
    statSync: () => ({ isFile: () => true, size: 10 }),
    createReadStream: file => ({ pipe: response => { reads.push(file); response.end('candidate') } }),
    MIME: { '.html': 'text/html' }, extname: path.extname,
    serverState: { requests: 0, bytes: 0, subscribePresent: false, downloadDeclaration: null },
  })()
  let status, body
  const response = { writeHead: value => { status = value }, end: value => { body = value } }
  serve({ url: '/preview/' }, response)
  assert.equal(status, 200)
  assert.equal(body, 'candidate')
  assert.deepEqual(reads, [path.join(dist, 'preview', 'index.html'), path.join(dist, 'preview', 'index.html')])
  serve({ url: '/%zz' }, response)
  assert.equal(status, 400)
  serve({ url: '/bad%5cpath' }, response)
  assert.equal(status, 403)
  assert.equal(reads.length, 2, 'malformed or escaping requests must not read a file')
})

test('preview cannot exit successfully when its candidate identity changes', () => {
  const source = readFileSync(path.join(toolsRoot, 'preview-browser-drive.mjs'), 'utf8')
  const tree = parseAst(source)
  const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'flush')
  for (const changed of [false, true]) {
    const saved = [], messages = [], exits = []
    const provenance = { mode: 'candidate-renderer', sha256: 'test-digest' }
    const flush = vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, {
      RENDERER: { provenance, assertUnchanged() { if (changed) throw new Error('selected archive changed') } },
      say: value => messages.push(value), LOG: [], OUT: '/test-output', join: path.join,
      mkdirSync() {}, writeFileSync: (file, content) => saved.push({ file, content }),
      assertions: 1, results: [{ ok: true }], process: { exit: code => exits.push(code) },
    })
    flush(0)
    assert.deepEqual(exits, [changed ? 1 : 0])
    const report = JSON.parse(saved.find(item => item.file.endsWith('drive.json')).content)
    assert.equal(report.exitCode, changed ? 1 : 0)
    assert.deepEqual(report.renderer, provenance)
    if (changed) assert.match(messages.join('\n'), /RENDERER INTEGRITY FAILED/)
  }
})

test('preview future-exit fixtures require exact declarations and never enable subscriptions by catalog presence', () => {
  const source = readFileSync(path.join(toolsRoot, 'preview-browser-drive.mjs'), 'utf8')
  const tree = parseAst(source)
  const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'applyPreviewExitFixtures')
  const original = "export const DECLARED = Object.freeze({ download: null, subscribe: Object.freeze({ enabled: false, href: '/#/subscribe' }) })"
  const apply = state => vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, { serverState: state })
  for (const subscribePresent of [false, true]) {
    assert.equal(apply({ subscribePresent, subscribeEnabled: false })(original), original)
  }
  const enabled = apply({ subscribeEnabled: true })(original)
  assert.equal(enabled, original.replace('enabled: false', 'enabled: true'))
  const declared = apply({ downloadDeclaration: { marker: 'test-only' } })(original)
  assert.equal(declared, original.replace('download: null,', 'download: {"marker":"test-only"},'))
  assert.match(declared, /enabled: false/)
  for (const invalid of ['', original.replace('enabled: false', 'enabled: true'), original + original]) {
    assert.throws(() => apply({ subscribeEnabled: true })(invalid), /one disabled declaration/)
  }
  for (const invalid of ['', original.replace('download: null,', ''), original + original]) {
    assert.throws(() => apply({ downloadDeclaration: { marker: 'test-only' } })(invalid), /one undeclared download/)
  }
  assert.match(source, /disabledWithCatalog\.disabled === true[\s\S]*?disabledWithCatalog\.anchor === false/)
  assert.match(source, /enabledWithoutCatalog\.disabled === true[\s\S]*?enabledWithoutCatalog\.anchor === false/)
  assert.match(source, /Boolean\(exitsPresent\[kind\]\.paint\)/,
    'a missing offered control must not pass by comparing null paint to disabled paint')
})

test('preview emits its actual completed count in the release suite vocabulary', () => {
  const source = readFileSync(path.join(toolsRoot, 'preview-browser-drive.mjs'), 'utf8')
  assert.match(source, /const failed = results\.filter\(r => !r\.ok\)/)
  assert.match(source, /say\(`\$\{assertions - failed\.length\}\/\$\{assertions\} checks passed \(instrumented preview renderer\)`\)/)
  assert.equal(verdictFor({ code: 0, output: '198/198 checks passed (instrumented preview renderer)\n' }), 'PASS')
  assert.equal(verdictFor({ code: 0, output: '197/198 checks passed (instrumented preview renderer)\n' }), 'FAIL')
  assert.notEqual(verdictFor({ code: 1, output: '198/198 checks passed (instrumented preview renderer)\n' }), 'PASS')
})

test('popup closes one complete scenario only after run resolves, and Page2 preserves failure evidence', () => {
  const popup = readFileSync(path.join(toolsRoot, 'owner-popup-qa.cjs'), 'utf8')
  assert.match(popup, /app\.whenReady\(\)\.then\(run\)\.then\(\(\) => \{\s*\/\/[^\n]*\n\s*process\.stdout\.write\('1\/1 checks passed \(complete owner-popup renderer scenario\)/)
  assert.equal(verdictFor({ code: 0, output: '1/1 checks passed (complete owner-popup renderer scenario)\n' }), 'PASS')
  const page2 = readFileSync(path.join(toolsRoot, 'page2-qa.cjs'), 'utf8')
  assert.match(page2, /const target = path\.join\(path\.dirname\(app\.getPath\('userData'\)\), 'page2-failure\.png'\)/)
  assert.match(page2, /await window\.webContents\.capturePage\(\)/)
  assert.match(page2, /renderer: RENDERER\.provenance, failureScreenshot/)
  assert.match(page2, /app\.exit\(1\)/)
})

test('approvals outcome binds its renderer, theme and closing identity check to the selected candidate', () => {
  const [entry] = planFor(['approvals-decision-outcome-qa.cjs'])
  const source = readFileSync(entry.file, 'utf8')
  const tree = parseAst(source)
  const functionText = name => {
    const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name)
    assert.ok(fn, name)
    return `(${source.slice(fn.start, fn.end)})`
  }
  const release = path.join(tmpdir(), 'selected approvals candidate')
  const dist = path.join(release, 'resources', 'app.asar', 'dist')
  const select = argv => vm.runInNewContext(functionText('selectedAppDirectory'), {
    process: { argv }, RENDERER: { release, dist }, path,
    arg() { assert.fail('a candidate must not consult the checkout app override') },
  })()
  assert.equal(select(['electron', 'qa', '--release', release]), dist)
  for (const argv of [['--app', '/wrong'], ['--app=/wrong']]) {
    assert.throws(() => select(argv), /cannot override/)
  }
  const sourceDist = path.join(tmpdir(), 'source-only')
  const sourceSelect = vm.runInNewContext(functionText('selectedAppDirectory'), {
    process: { argv: ['--app', sourceDist] }, RENDERER: { release: null, dist: '/unused' }, path,
    arg: () => sourceDist,
  })
  assert.equal(sourceSelect(), sourceDist)
  const loaded = []
  const manifest = { themes: { white: {}, tan: {}, black: {} } }
  const theme = vm.runInNewContext(functionText('shippedThemeManifest'), {
    ROOT: '/wrong-checkout', RENDERER: { release }, path,
    fs: { existsSync(file) { loaded.push(file); return true } },
    require(file) { loaded.push(file); return { themeManifest: () => manifest } },
  })()
  assert.equal(theme, manifest)
  const expectedTheme = path.join(release, 'resources', 'capability', 'src', 'lib', 'owner-prompt-theme.js')
  assert.deepEqual(loaded, [expectedTheme, expectedTheme])
  assert.match(source, /selectRendererDist\(\{ argv: process\.argv, repoRoot: ROOT \}\)/)
  assert.match(source, /rendererRequestPath\(appDir, request\.url\)/)
  assert.match(source, /renderer: \{ \.\.\.RENDERER\.provenance, dist: appDir \}/)
  assert.match(source, /RENDERER\.assertUnchanged\(\)\s*emitObserved\(observed\)/)
  assert.deepEqual(releaseArgumentsFor(source, release), ['--release', release])
  assert.equal(entry.artifactProof, 'instrumented-copy')
})

test('the approvals reader cannot mistake the main Ledger counter for the queue warning', () => {
  const source = readFileSync(path.join(toolsRoot, 'approvals-decision-outcome-qa.cjs'), 'utf8')
  const tree = parseAst(source)
  const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'readApprovalsView')
  const text = `(${source.slice(fn.start, fn.end)})`
  const read = ({ missing = false, width = 400, height = 20, display = 'inline', visibility = 'visible', opacity = '1' } = {}) => {
    const count = { textContent: '1 decision you submitted was not recorded, so it is still here.',
      getBoundingClientRect: () => ({ width, height }) }
    const queue = { querySelector: selector => selector === '[data-visible-count]' ? count : null,
      querySelectorAll: () => [] }
    return vm.runInNewContext(text, {
      document: { querySelector(selector) {
        assert.equal(selector, '.ledger-prompt-queue', 'never read an unscoped Ledger counter')
        return missing ? null : queue
      } },
      getComputedStyle: () => ({ display, visibility, opacity }),
    })()
  }
  const visible = read()
  assert.equal(visible.queuePresent, true)
  assert.match(visible.countNote, /not recorded/)
  assert.equal(visible.countNoteVisible, true)
  for (const condition of [{ width: 0 }, { height: 0 }, { display: 'none' }, { visibility: 'hidden' }, { opacity: '0' }, { missing: true }]) {
    assert.equal(read(condition).countNoteVisible, false)
  }
  assert.equal(read({ missing: true }).queuePresent, false)
  assert.match(source, /executeJavaScript\(`\(\$\{readApprovalsView\.toString\(\)\}\)\(\)`\)/)
  assert.match(source, /if \(!observed\.approvals\.countNoteVisible\) failures\.push/)
})

test('unattended approvals QA runs refusal and acceptance and does not summarize a refused case as passing', async () => {
  const source = readFileSync(path.join(toolsRoot, 'approvals-decision-outcome-qa.cjs'), 'utf8')
  const tree = parseAst(source)
  const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'runSelectedModes')
  async function drive(selected, refusalPass = true) {
    const calls = [], output = []
    const run = vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, {
      arg: (name, fallback) => selected ?? fallback,
      run: async mode => { calls.push(mode); return { ok: mode === 'accept' || refusalPass } },
      process: { stdout: { write: line => output.push(line) } },
    })
    const ok = await run()
    return { calls, output: output.join(''), ok }
  }
  const both = await drive(undefined)
  assert.deepEqual(both.calls, ['refuse', 'accept'])
  assert.equal(both.ok, true)
  assert.equal(verdictFor({ code: 0, output: both.output }), 'PASS')
  assert.match(both.output, /2\/2 checks passed/)
  const failure = await drive(undefined, false)
  assert.deepEqual(failure.calls, ['refuse', 'accept'])
  assert.equal(failure.ok, false)
  assert.match(failure.output, /1\/2 checks passed/)
  assert.equal(verdictFor({ code: 0, output: failure.output }), 'FAIL')
  assert.deepEqual((await drive('accept')).calls, ['accept'])
  assert.deepEqual((await drive('refuse')).calls, ['refuse'])
  await assert.rejects(drive('invented'), /--mode/)
  assert.match(source, /app\.whenReady\(\)\.then\(runSelectedModes\)/)
  assert.match(source, /app\.on\('window-all-closed', \(\) => \{\}\)/)
  assert.match(source, /then\(ok => app\.exit\(ok \? 0 : 1\)/)
})
