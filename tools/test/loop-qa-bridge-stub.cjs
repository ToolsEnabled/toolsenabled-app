'use strict'

/* THE CONTROLLED CAPABILITY LAYER, STARTED BY THE APP ITSELF.
 *
 * This is not a bridge the harness starts and then points the app at. It is the
 * layer the packaged app starts FOR ITSELF, on the supervised customer path,
 * because the harness swapped `bridgeEntrypoint` in a scratch copy of
 * resources/capability/PAYLOAD.json. shell/capability-layer.cjs spawns whatever
 * that record names; everything from the spawn onward is shipped code.
 *
 * WHY THE ENGINE IS THE THING REPLACED, AND NOT THE DISCOVERY PATH.
 *
 * The previous harness set MC_BRIDGE_PROOF_FILE so the shell would report
 * source 'env' and NOT report a supervised layer, which let the renderer's
 * `?bridge=` developer override select a stub the harness had started. Commit
 * 17a0483 fenced that variable out of packaged builds because HKCU\Environment
 * is user-writable without elevation, so the variable was never proof that a
 * developer was present. Re-enabling that path for the test would reopen exactly
 * the hole the fence closed, so the harness stops using it: instead of
 * suppressing the supervised layer, it substitutes the ENGINE BELOW it. The
 * product then takes the same path a double-clicked install takes.
 *
 * WHAT THIS STUB MUST BE FAITHFUL TO. Three shipped contracts read this process:
 *   1. shell/capability-layer.cjs startCapabilityLayer() parses ONE JSON line on
 *      stdout and requires ok:true plus a string baseUrl; it takes port, pid and
 *      bootstrapProofFile from that same line.
 *   2. shell/capability-layer.cjs readCapabilityProof() reads bootstrapProofFile
 *      as JSON and requires a token matching /^[A-Za-z0-9_-]{43}$/.
 *   3. src/mission-bridge.js validRuntimeDiscovery() validates /v1/runtime field
 *      by field and rejects ANY unexpected key, so /v1/runtime carries exactly
 *      ok, baseUrl, port, startedAt, pid and nothing else. A sloppy stub is not
 *      discovered, and the harness fails rather than passing on a fiction.
 *
 * THE /qa/* ROUTES ARE THE HARNESS'S, NOT THE PRODUCT'S. They exist so the
 * harness can prove which listener it is talking to and read what ARRIVED. They
 * are guarded by a per-run nonce the harness generates and writes beside this
 * file, so another QA harness cycling ports on this machine cannot answer them
 * and cannot read this run's record. The product never calls them.
 *
 * This file is never shipped. It is copied into a scratch copy of the payload
 * that lives under the OS temp directory for the duration of one run.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const CONFIG_FILE = path.join(__dirname, 'loop-qa-bridge-stub.config.json')

/* The declared discovery range. The stub must never sit inside it: the renderer
   scan is what the supervised pin exists to replace, this machine really does
   run a live capability layer in that range, and a stub squatting there could
   be found by some OTHER process's scan. Bind elsewhere or refuse. */
const DISCOVERY_LOW = 4610
const DISCOVERY_HIGH = 4619

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'QA_STUB_REFUSED', message })}\n`)
  process.exit(1)
}

let config
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
} catch (error) {
  fail(`the QA stub config could not be read at ${CONFIG_FILE}: ${error.message}`)
}
if (typeof config?.qaNonce !== 'string' || config.qaNonce.length < 32) fail('the QA stub config carries no usable per-run nonce')
if (typeof config?.announceFile !== 'string' || !config.announceFile) fail('the QA stub config names no announce file')
if (typeof config?.proofFile !== 'string' || !config.proofFile) fail('the QA stub config names no bootstrap proof file')

/* The per-boot bootstrap secret, minted here exactly as the real layer mints
   its own, and written where the shell will read it. The shell hands it to the
   renderer over IPC; the renderer presents it at /v1/bootstrap. The harness
   never injects it into the renderer -- that whole exchange is shipped code. */
const proofToken = crypto.randomBytes(32).toString('base64url')
fs.mkdirSync(path.dirname(config.proofFile), { recursive: true })
fs.writeFileSync(config.proofFile, JSON.stringify({ token: proofToken }), 'utf8')

const startedAt = new Date().toISOString()
const bearer = crypto.randomBytes(32).toString('base64url')
const received = []
let launchSeq = 0

function record(entry) {
  received.push({ ...entry, at: Date.now() })
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${server.address()?.port ?? 0}`)

  /* CORS, mirroring the real bridge (mission-bridge/server.js). The renderer is
     a different origin from this listener and every audited call carries
     `authorization` and `content-type`, which forces a preflight. Without these
     headers the browser refuses the request before it is sent, this stub records
     nothing at all, and the symptom on the glass is a bare "Failed to fetch"
     that looks exactly like a broken product. */
  const cors = {
    'access-control-allow-origin': request.headers.origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
  }
  const reply = (status, body) => {
    const payload = JSON.stringify(body)
    response.writeHead(status, { ...cors, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    return response.end()
  }

  /* ---- the harness's own routes, nonce-guarded ---- */
  if (url.pathname.startsWith('/qa/')) {
    if (url.searchParams.get('nonce') !== config.qaNonce) return reply(404, { ok: false })
    if (url.pathname === '/qa/whoami') {
      return reply(200, { ok: true, nonce: config.qaNonce, pid: process.pid, port: server.address().port, startedAt })
    }
    if (url.pathname === '/qa/state') {
      return reply(200, { ok: true, received, bootstrapAccepted: received.some(e => e.pathname === '/v1/bootstrap' && e.proofAccepted === true) })
    }
    return reply(404, { ok: false })
  }

  /* ---- the product's protocol ---- */
  const port = server.address().port
  if (url.pathname === '/v1/runtime') {
    record({ pathname: url.pathname })
    return reply(200, { ok: true, baseUrl: `http://127.0.0.1:${port}`, port, startedAt, pid: process.pid })
  }
  if (url.pathname === '/v1/bootstrap') {
    const accepted = url.searchParams.get('proof') === proofToken
    record({ pathname: url.pathname, proofAccepted: accepted })
    if (!accepted) return reply(403, { ok: false, error: { code: 'BRIDGE_PROOF_REFUSED', message: 'bad proof' } })
    return reply(200, { ok: true, token: bearer })
  }
  if (request.headers.authorization !== `Bearer ${bearer}`) {
    return reply(401, { ok: false, error: { code: 'BRIDGE_UNAUTHORIZED', message: 'no bearer' } })
  }
  if (url.pathname === '/v1/status') {
    return reply(200, { ok: true, roots: ['isolated'], queue: [] })
  }

  let raw = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    let body = null
    try { body = JSON.parse(raw) } catch { body = null }
    record({ pathname: url.pathname, body })

    if (url.pathname === '/v1/actions/dispatch') {
      launchSeq += 1
      return reply(200, {
        ok: true,
        receipt: {
          action: 'dispatch',
          tier: body?.tier,
          launchId: `launch_stub${String(launchSeq).padStart(4, '0')}`,
          agentId: 'luna',
          auditSequence: launchSeq,
          auditEventHash: crypto.createHash('sha256').update(`dispatch-${launchSeq}`).digest('hex'),
        },
      })
    }
    if (url.pathname === '/v1/actions/terminate') {
      return reply(200, {
        ok: true,
        receipt: {
          action: 'terminate',
          idempotencyKey: body?.idempotencyKey,
          agentId: body?.agentId,
          runId: body?.expectedRunId,
          pid: body?.expectedPid,
          verifiedGone: true,
          terminalStatus: 'failed',
          exitCode: 1,
          verifiedGoneAt: new Date().toISOString(),
          terminalAt: Date.now(),
          auditSequence: 999,
          auditEventHash: crypto.createHash('sha256').update('terminate').digest('hex'),
        },
      })
    }
    return reply(404, { ok: false, error: { code: 'BRIDGE_ROUTE_UNKNOWN', message: url.pathname } })
  })
})

function listenOutsideDiscoveryRange(attempt = 0) {
  if (attempt > 40) return fail('could not obtain a port outside the declared discovery range')
  server.once('error', error => fail(`the QA stub could not listen: ${error.message}`))
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    if (port >= DISCOVERY_LOW && port <= DISCOVERY_HIGH) {
      return server.close(() => listenOutsideDiscoveryRange(attempt + 1))
    }
    const baseUrl = `http://127.0.0.1:${port}`

    /* The announce FILE is the harness's independent statement of where this
       process is. The harness compares it against what the SHELL reports over
       IPC; two independent sources naming the same origin and the same pid is
       what proves the binding. Written before the stdout line, so the shell
       cannot report an origin the harness cannot yet corroborate. */
    fs.mkdirSync(path.dirname(config.announceFile), { recursive: true })
    fs.writeFileSync(config.announceFile, JSON.stringify({ baseUrl, port, pid: process.pid, startedAt, nonce: config.qaNonce }), 'utf8')

    /* The one line shell/capability-layer.cjs parses. */
    process.stdout.write(`${JSON.stringify({
      ok: true,
      baseUrl,
      port,
      startedAt,
      pid: process.pid,
      roots: ['isolated'],
      liveRegistration: false,
      bootstrapProofFile: config.proofFile,
    })}\n`)
  })
}

const shutdown = () => { try { server.close() } catch { /* going away anyway */ } process.exit(0) }
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

listenOutsideDiscoveryRange()
