/* A PICTURE THIS APP ACCEPTS IS A PICTURE THE SEND CAN CARRY.
 *
 * T18, cycle 2. The owner, 2026-09-16: "sending images doesnt work". The
 * delivery fix of 2026-09-15 is in the cut and the Claude seam really does
 * carry a picture -- measured -- but the two ends of the path disagreed about
 * HOW BIG a picture may be, and nobody was told:
 *
 *   shell/main.cjs        MAX_PASTE_IMAGE_BYTES  8 MiB   accepts and writes it
 *   <engine>/src/lib/agent-engine/turn-image-bytes.js
 *                         MAX_IMAGE_BYTES        3 MB    refuses it at send
 *
 * So an ordinary screenshot of a busy screen became a chip in the composer and
 * then a send that threw away the picture AND the person's words, under
 * "The message was not sent. Check that this agent is still available, then try
 * again." -- an agent that was available, and a retry that does the same thing
 * forever.
 *
 * WHAT THIS SUITE HOLDS, and it is three separate facts, not one:
 *
 *   1. THE NUMBER IS THE ENGINE'S. Read off the payload under test, never a
 *      literal here; then proven by driving the REAL ClaudeCliAdapter with a
 *      real file on each side of it. A test that hard-coded 3 000 000 would
 *      keep passing on the day the engine changed it.
 *   2. THE ATTACHMENT DOORS REFUSE IT FIRST, with one plain sentence that names
 *      the picture and both sizes, and they commit nothing: no file written, no
 *      path in the session's allowlist.
 *   3. THE CEILING BINDS ONLY THE PROVIDER IT IS TRUE OF. Codex is handed the
 *      PATH and opens the file itself, so the same picture must still attach on
 *      a Codex session. Refusing it there would break something that works.
 *
 * Run alone with:
 *   node --test tools/test/picture-too-large-is-refused-before-the-send.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { solidPng } from './helpers/paste-picture-native.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createAgentCommandSurface } = require_(path.join(ROOT, 'shell', 'agent-command-surface.cjs'))
const { createAgentHost } = require_(path.join(ROOT, 'shell', 'agent-host.cjs'))

/* The engine this build actually ships, so the ceiling under test is the one a
   person's send will meet. */
const ENGINE_ROOT = path.join(ROOT, 'capability')
const TURN_IMAGE = path.join(ENGINE_ROOT, 'src', 'lib', 'agent-engine', 'turn-image-bytes.js')
const { MAX_IMAGE_BYTES } = require_(TURN_IMAGE)
const { ClaudeCliAdapter } = require_(path.join(ENGINE_ROOT, 'src', 'lib', 'agent-engine', 'claude-cli-adapter.js'))

const SCRATCH = mkdtempSync(testScratchRoot('t18-too-large-'))

/* A PNG whose bytes really are the size asked for: random pixels stored with
   deflate level 0, because a solid colour compresses to almost nothing and
   would quietly make an "over the ceiling" fixture that is under it. */
function pngOfAtLeast(bytes, name) {
  const zlib = require_('node:zlib')
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc32 = buf => { let crc = 0xffffffff; for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const side = Math.ceil(Math.sqrt(bytes / 3)) + 8
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(side * (1 + side * 3))
  let o = 0
  for (let y = 0; y < side; y++) { raw[o++] = 0; for (let x = 0; x < side * 3; x++) raw[o++] = (y * 7 + x * 13) & 0xff }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0)),
  ])
  const file = path.join(SCRATCH, name)
  writeFileSync(file, png)
  return { file, bytes: png.length, png }
}

/* ---------- 1. the engine's own ceiling, proven against the real adapter ---- */

test('the engine names the ceiling, and the real Claude adapter carries a picture under it and refuses one over it with nothing written', async () => {
  assert.ok(Number.isSafeInteger(MAX_IMAGE_BYTES) && MAX_IMAGE_BYTES > 0,
    'the payload under test exports no MAX_IMAGE_BYTES, so nothing here knows what the send will carry')

  const drive = async (imagePath) => {
    const written = []
    const adapter = new ClaudeCliAdapter({ transport: { send: message => written.push(message), onData () {}, close () {}, kill () {} } })
    const threadId = '7cf7c88e-6912-4388-a181-78aef262c494'
    adapter.threadId = threadId
    try {
      const turn = adapter.sendTurn({ threadId, text: 'what is in this picture?', images: [{ path: imagePath }] })
      /* The turn never settles -- no provider is answering -- so what is under
         test is what reached the transport by the next tick. */
      await Promise.race([turn, new Promise(resolve => setTimeout(resolve, 500))])
      return { written, refusal: null }
    } catch (error) {
      return { written, refusal: { code: error.code, message: error.message } }
    }
  }

  const over = pngOfAtLeast(MAX_IMAGE_BYTES + 400_000, 'over-the-ceiling.png')
  assert.ok(over.bytes > MAX_IMAGE_BYTES, `the fixture must be over the ceiling (${over.bytes} vs ${MAX_IMAGE_BYTES})`)
  const refused = await drive(over.file)
  assert.ok(refused.refusal, 'the adapter carried a picture larger than the engine says it may read')
  assert.equal(refused.written.length, 0,
    'the over-size picture reached the provider transport, so the refusal is not preflight and the turn is unconfirmed')

  /* THE CONTROL, and it is the point: the same call with a picture UNDER the
     ceiling gets through, so the refusal above is about the size and not about
     pictures in general. */
  const under = path.join(SCRATCH, 'under-the-ceiling.png')
  writeFileSync(under, solidPng(8, [255, 0, 0]))
  assert.ok(statSync(under).size < MAX_IMAGE_BYTES)
  const carried = await drive(under)
  assert.equal(carried.refusal, null, 'a picture inside the ceiling was refused: ' + JSON.stringify(carried.refusal))
  assert.equal(carried.written.length, 1)
  assert.equal(carried.written[0].message.content.filter(block => block.type === 'image').length, 1)
})

/* ---------- 2/3. the attachment doors, on a real command surface ----------- */

const window_ = { kind: 'window', owner: { id: 'window-1' }, mayWrite: true, label: 'this window' }

function surfaceFor(tier) {
  const saved = []
  const agentSessions = new Map()
  const host = {
    startSession: async request => ({ sessionId: request.sessionId, threadId: 'thread-1', tier: 'guided', effort: 'medium', account: null }),
    sendTurn: async request => ({ sessionId: request.sessionId, threadId: 'thread-1', turnId: 'turn-1', request }),
    /* THE ONLY THING THIS DOUBLE DOES NOT INVENT: which provider a model row
       runs on comes from the real host's own table, so a test cannot claim a
       tier/provider pairing the product does not have. */
    providerForTier: createAgentHost({ enginePath: path.join(ENGINE_ROOT, 'src', 'lib', 'agent-engine', 'codex-process.js'), defaultCwd: SCRATCH }).providerForTier,
    treeLinks: () => ({ ok: true, links: [] }),
    startableTiers: () => ({ ok: true, tiers: [tier] }),
    closeSession: async request => ({ sessionId: request.sessionId, closed: true }),
  }
  let picked = null
  const deps = {
    agentSessions,
    currentAgentHost: () => host,
    getAgentHost: () => host,
    agentIpcError: (code, message) => { throw Object.assign(new Error(message), { code }) },
    agentPayload: (value, allowed) => {
      for (const key of Object.keys(value || {})) if (!allowed.includes(key)) throw Object.assign(new Error('bad key ' + key), { code: 'MC_AGENT_INVALID_PAYLOAD' })
      return value
    },
    boundedAgentString: (value, name, max) => {
      if (typeof value !== 'string' || !value.length || value.length > max) throw Object.assign(new Error(name), { code: 'MC_AGENT_INVALID_PAYLOAD' })
      return value
    },
    parseAgentStart: value => ({ sessionId: value.sessionId, ...(value.tier ? { tier: value.tier } : {}) }),
    parseAgentSend: value => ({ sessionId: value.sessionId, text: value.text, ...(value.images ? { images: value.images } : {}) }),
    parseAgentSessionCommand: value => ({ sessionId: value.sessionId }),
    parseAgentPasteAttachment: value => ({ sessionId: value.sessionId, mime: value.mime, data: value.data }),
    MAX_PASTE_IMAGE_BYTES: 8 * 1024 * 1024,
    savePasteAttachment: (mime, bytes) => {
      const file = path.join(SCRATCH, `saved-${saved.length}.png`)
      writeFileSync(file, bytes)
      saved.push({ mime, size: bytes.length, path: file })
      return { path: file, size: bytes.length }
    },
    rendererSafeAgentError: error => Object.assign(new Error(error.code || 'AGENT_SESSION_FAILED'), { code: error.code || 'AGENT_SESSION_FAILED' }),
    spawnRecordAvailability: () => ({ ok: true }),
    spawnRecordHistory: () => ({ ok: true, total: 0, entries: [] }),
    usageRecordHistory: () => ({ ok: true, total: 0, entries: [] }),
    engineAvailability: () => ({ ok: true, code: 'AGENT_ENGINE_READY' }),
    ensureWorkspaceRoot: () => SCRATCH,
    chosenWorkspaceCwd: () => null,
    readAgentConfinement: () => ({ ok: true, tier: 'guided' }),
    listAgentTools: () => ({ ok: true, tier: 'guided', total: 0, tools: [] }),
    /* The REAL payload, so the ceiling the doors apply is the engine's own. */
    resolveCapabilityRoot: () => ENGINE_ROOT,
    requireModule: file => require_(file),
    readStandingRequests: () => ({ ok: true, exists: false, entries: [] }),
    readCanonicalLedger: request => ({ ok: true, revision: 0, updatedAt: null, exists: false, records: [], chain: { ok: true, events: 0, drift: [], unchained: [], code: null }, filter: request }),
    sessionProfiles: { list: () => [], create: r => r, remove: () => true, resolveCwd: () => SCRATCH },
    recordSpawnIntent: () => ({ sequence: 1, eventHash: 'hash-1', durable: true, signed: true }),
    recordSpawnOutcome: () => {},
    recordSessionEnd: session => { session.ended = true },
    bindAgentOwner: () => {},
    agentOrgRecord: {
      read: () => ({ ok: true, org: {}, roles: [] }),
      resolveRoleBinding: binding => ({ ok: true, role: { id: binding.id, name: 'r', summary: null, owns: '', mustNot: '', handoff: '', rules: [], revision: 0 } }),
      reparent: () => ({ ok: true, org: {} }), assignRole: () => ({ ok: true, org: {} }),
      ensureSeat: () => ({ ok: true, unchanged: false, org: {} }), releaseSeat: () => ({ ok: true, unchanged: false, org: {} }),
      createRole: () => ({ ok: true, roles: [] }), editRole: () => ({ ok: true, roles: [] }),
      resetRole: () => ({ ok: true, roles: [] }), resetOrg: () => ({ ok: true, org: {} }), exportOrg: () => ({ ok: true, document: {} }),
    },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [picked] }) },
    statFile: async file => statSync(file),
    MAX_AGENT_SESSIONS: 8,
    MAX_SESSION_ID_LENGTH: 128,
    AGENT_EFFORT_VALUES: ['low', 'medium', 'high'],
    WORKSPACE_ROOT: SCRATCH,
  }
  const surface = createAgentCommandSurface(deps)
  return { surface, agentSessions, saved, pick: value => { picked = value } }
}

async function started(surface, tier, sessionId) {
  await surface.run('agent:start', { sessionId, tier }, window_)
}

test('a picture over the engine ceiling is refused at BOTH attachment doors, in one plain sentence, with nothing written and nothing allowlisted', async () => {
  const big = pngOfAtLeast(MAX_IMAGE_BYTES + 400_000, 'door-over.png')
  const { surface, agentSessions, saved, pick } = surfaceFor('claude-sonnet')
  await started(surface, 'claude-sonnet', 'claude-1')

  /* THE PASTE DOOR. */
  const pasted = await surface.run('agent:paste-attachment',
    { sessionId: 'claude-1', mime: 'image/png', data: big.png.toString('base64') }, window_)
  assert.equal(pasted.ok, false, 'a picture the send cannot carry was attached anyway')
  assert.equal(typeof pasted.sentence, 'string')
  assert.ok(pasted.sentence.includes('picture'), 'the sentence does not say what it is about: ' + pasted.sentence)
  /* Both sizes, so the person can act: what they have, and what fits. */
  assert.ok(/\b\d+\.\d MB\b.*\b\d+\.\d MB\b/.test(pasted.sentence),
    'the sentence names fewer than two sizes, so a person cannot tell how much smaller to go: ' + pasted.sentence)
  assert.ok(!/\bMC_[A-Z_]+\b/.test(pasted.sentence), 'the sentence shows an error identifier: ' + pasted.sentence)
  assert.deepEqual(saved, [], 'a picture that cannot be delivered was still written to the person\'s disk')
  assert.equal(agentSessions.get('claude-1').attachments, undefined, 'a picture that cannot be delivered entered the allowlist')

  /* THE PICKER DOOR, the same answer for the same file. */
  pick(big.file)
  const picked = await surface.run('agent:pick-attachment', { sessionId: 'claude-1' }, window_)
  assert.equal(picked.ok, false, 'the Attach button issued a path the send cannot carry')
  assert.ok(picked.sentence.includes(path.basename(big.file)),
    'the picker\'s sentence does not name the file the person chose: ' + picked.sentence)
  assert.equal(agentSessions.get('claude-1').attachments, undefined, 'a picked over-size picture entered the allowlist')
})

test('a picture inside the ceiling still attaches, and the same over-size picture still attaches on Codex, whose delivery path hands over the path', async () => {
  /* CONTROL ONE: under the ceiling, on the provider the ceiling binds. */
  const small = path.join(SCRATCH, 'small.png')
  writeFileSync(small, solidPng(8, [0, 0, 255]))
  const claude = surfaceFor('claude-sonnet')
  await started(claude.surface, 'claude-sonnet', 'claude-2')
  const ok = await claude.surface.run('agent:paste-attachment',
    { sessionId: 'claude-2', mime: 'image/png', data: require_('node:fs').readFileSync(small).toString('base64') }, window_)
  assert.equal(ok.ok, true, 'a picture inside the ceiling was refused: ' + JSON.stringify(ok))
  assert.deepEqual([...claude.agentSessions.get('claude-2').attachments], [ok.path])

  /* CONTROL TWO, and this is the one a careless ceiling would break: Codex is
     sent the PATH and opens the file itself, so no byte ceiling of this
     product's applies and the same picture must still attach. */
  const big = pngOfAtLeast(MAX_IMAGE_BYTES + 400_000, 'codex-over.png')
  const codex = surfaceFor('astra')
  await started(codex.surface, 'astra', 'codex-1')
  const onCodex = await codex.surface.run('agent:paste-attachment',
    { sessionId: 'codex-1', mime: 'image/png', data: big.png.toString('base64') }, window_)
  assert.equal(onCodex.ok, true, 'a picture Codex can deliver was refused for a ceiling that is not Codex\'s: ' + JSON.stringify(onCodex))
  assert.deepEqual([...codex.agentSessions.get('codex-1').attachments], [onCodex.path])
})
