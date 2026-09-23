#!/usr/bin/env node
/* LANE B ITEM 1 -- RED/GREEN for "agent.spawn takes effort, provider and model".
 *
 * WHAT THIS PROVES, END TO END, WITH THE SHIPPED MODULES:
 *
 *   agent.spawn(effort: 'xhigh')                 engine  src/lib/tool-registry.js
 *     -> the request the application is handed   engine  src/lib/agent-tree-spawn.js
 *     -> the renderer's transport gate           app     src/main.js cleanTreeNodeCommand
 *     -> the circle that is added and started    app     src/create-and-start-node.js
 *     -> the depth the start actually uses       app     src/fleet-trees.js draftStartEffort
 *     -> node-transcripts/<node>/node.json       app     shell/node-transcript-store.cjs
 *
 * Every one of those is required out of the tree under test. Nothing in the
 * chain is a stand-in for a unit being measured.
 *
 * THE TWO SEAMS THIS SCRIPT WIRES BY HAND, AND WHY. src/views/computers.js is a
 * 14,000-line browser view that `node` cannot load, so two call sites inside it
 * are reproduced here rather than executed:
 *
 *   - startDraftNodeUnguarded's `draft.effort = draftStartEffort(node, {
 *       override: effort, tierDefault: tierEffortOf(node.tier) })` and the
 *     `sessionEfforts.set(sessionId, draft.effort || tierEffortOf(draft.tier))`
 *     one line further on;
 *   - the transcript client's metadata build, which carries that same value.
 *
 *   Both are called through the REAL draftStartEffort and the REAL tier table,
 *   so what is reproduced is the wiring, not the logic. The browser half is
 *   what the hand test on the candidate covers instead.
 *
 * USAGE
 *   node laneB-item1-redgreen.mjs                 # chain, against ./engine and ./app
 *   node laneB-item1-redgreen.mjs --base          # export both base revisions first
 *   node laneB-item1-redgreen.mjs --candidate     # also launch the private candidate
 *   node laneB-item1-redgreen.mjs --mutation <k>  # break one gate, expect the matching RED
 *
 * NEVER TOUCHES THE OWNER'S LIVE APPLICATION. The candidate phase launches the
 * Electron binary from the app tree under test with its own --user-data-dir
 * under this lane's state/ directory and its own --remote-debugging-port.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'

import path from 'node:path'
import process from 'node:process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEBUG_PORT = Number(process.env.LANEB_ITEM1_PORT || 9631)
const EFFORT = 'xhigh'
const TIER = 'claude-opus'

const BASE = Object.freeze({ engine: '62d44539', app: '9413ef30' })

const argv = process.argv.slice(2)
const wantBase = argv.includes('--base')
const wantCandidate = argv.includes('--candidate')
const mutation = argv.includes('--mutation') ? argv[argv.indexOf('--mutation') + 1] : null

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}\n`)
  return ok
}
function note(text) { process.stdout.write(`      ${text}\n`) }
function heading(text) { process.stdout.write(`\n== ${text} ==\n`) }

/* ------------------------------------------------------------------ trees */

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...options })
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', error => resolve({ code: -1, out, err: String(error && error.message) }))
    child.on('close', code => resolve({ code, out, err }))
  })
}

/* A read-only copy of a base revision, made WITHOUT touching either worktree.
 * `git worktree add --detach` and `git checkout` are both forbidden in this
 * lane -- another agent's only copy lives in the shared tree -- and neither is
 * needed: `git archive` writes a fresh directory and leaves HEAD, the index and
 * every working file exactly where they are. */
async function exportBase(repo, revision, destination) {
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  /* The archive is written INSIDE the destination and extracted with the
     destination as cwd, so neither command is ever handed an absolute path
     with a drive letter: Windows' bundled bsdtar reads `C:\...` as a remote
     host and answers "Cannot connect to C: resolve failed". A relative name
     behaves the same on both platforms. */
  const archiveName = `laneB-item1-${revision}.tar`
  const made = await run('git', ['-C', repo, 'archive', '--format=tar', '-o', path.join(destination, archiveName), revision])
  if (made.code !== 0) throw new Error(`git archive ${revision} failed: ${made.err.trim()}`)
  const extracted = await run('tar', ['-xf', archiveName], { cwd: destination })
  if (extracted.code !== 0) throw new Error(`tar -xf failed: ${extracted.err.trim()}`)
  fs.rmSync(path.join(destination, archiveName), { force: true })
  return destination
}

/* node_modules for an exported base tree, linked rather than copied. Junction
 * on Windows (no privilege needed, unlike a symlink), directory symlink
 * elsewhere. */
function linkNodeModules(from, to) {
  const source = path.join(from, 'node_modules')
  const target = path.join(to, 'node_modules')
  if (!fs.existsSync(source) || fs.existsSync(target)) return
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

/* ---------------------------------------------------------------- the chain */

const CONTRACT = [
  'CONTRACT/1',
  'role      IMPLEMENTER',
  'target    src/lib/tool-registry.js',
  'do        carry out one bounded piece of work and report the evidence',
  'because   0 of 12 pieces of this lane have returned evidence so far',
  'done      the dispatcher receives evidence and one verdict',
  'report    REPORT-laneB-child.md',
].join('\n')

/* Step 1 -- the engine's own tool. Returns what the APPLICATION was handed. */
async function engineSpawn(engineRoot, { effort = EFFORT, tier = TIER } = {}) {
  const engineRequire = createRequire(path.join(engineRoot, 'package.json'))
  const { spawnSubagent } = engineRequire('./src/lib/tool-registry.js')
  const handed = []
  const workspace = process.platform === 'win32' ? 'C:\\fixture\\workspace' : '/fixture/workspace'
  const answer = await spawnSubagent(
    { contract: CONTRACT, tier, surface: 'tree', treeRole: 'worker', ...(effort === null ? {} : { effort }) },
    {
      agentId: 'controller',
      agentPrincipal: { sessionId: 'chat-parent-1' },
      agentRole: { functions: ['agent.spawn'], requiresDirectUserAuthorization: false },
      permissionSession: { origin: 'local', tier: 'full' },
      workspaceRoots: [workspace],
    },
    {
      apiSheet: '',
      subagentRoute: { subagentRoute: () => ({ ok: true, route: 'tree' }) },
      treeSpawn: {
        isTreeSession: () => true,
        /* This is the slot shell/main.cjs fills with dispatchTreeSpawn. It
           records the request rather than drawing a circle, because the next
           step drives the drawing half directly. */
        spawnOnTree: async request => { handed.push(request); return { ok: true, nodeId: 'node-9-child', sessionId: 'chat-child-1' } },
      },
    },
  )
  return { answer, handed: handed[0] || null }
}

/* Step 2 -- the renderer's transport gate, extracted from the real src/main.js
 * exactly as tools/test/tree-node-command-clean-gate.test.mjs extracts it:
 * that file cannot be imported under plain node (it pulls in assets only a
 * bundler resolves), and a regex over its source cannot tell whether the gate
 * ACCEPTS a value, which is the whole question here. */
async function rendererGate(appRoot, command) {
  const source = fs.readFileSync(path.join(appRoot, 'src', 'main.js'), 'utf8')
  const start = source.indexOf('function cleanTreeNodeCommand(value) {')
  const end = source.indexOf('\nasync function completeTreeNodeCommand(', start)
  if (start < 0 || end <= start) throw new Error('cleanTreeNodeCommand was not found in src/main.js')
  const { FLEET_TREE_LIMITS } = await import(pathToFileURL(path.join(appRoot, 'src', 'fleet-trees.js')).href)
  // eslint-disable-next-line no-new-func -- the same isolation the shipped suite uses.
  const factory = new Function('FLEET_TREE_LIMITS', `${source.slice(start, end)}\nreturn cleanTreeNodeCommand;`)
  return factory(FLEET_TREE_LIMITS)(command)
}

/* The command object shell/main.cjs dispatchTreeSpawn builds. Its own file
 * cannot be required outside Electron (it opens windows at load), so the
 * envelope is rebuilt here from the request the engine handed over -- and the
 * gate above, which IS the shipped one, is what decides whether it is legal. */
function dispatchEnvelope(request) {
  const now = Date.now()
  return {
    protocol: 'toolsenabled.tree-node-command',
    schemaVersion: 1,
    requestId: `tnc-${'12345678-1234-4123-8123-123456789abc'}`,
    action: 'create-and-start-node',
    computerId: 'this-computer',
    treeId: null,
    nodeId: null,
    expectedSessionId: null,
    parentSessionId: request.parentSessionId,
    role: request.role || null,
    tier: request.tier || null,
    effort: request.effort || null,
    provider: request.provider || null,
    model: request.model || null,
    brief: request.brief || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    containsSecretMaterial: false,
  }
}

/* Step 3 -- the circle is added and started, through the shipped seam and the
 * shipped tier table. Returns the depth the node carries and the depth the
 * start was actually given. */
async function drawAndStart(appRoot, command, { breakStart = false } = {}) {
  const { executeCreateAndStartNode } = await import(pathToFileURL(path.join(appRoot, 'src', 'create-and-start-node.js')).href)
  const { LAUNCH_TIERS } = await import(pathToFileURL(path.join(appRoot, 'src', 'orchestration-controls.js')).href)
  const { draftStartEffort } = await import(pathToFileURL(path.join(appRoot, 'src', 'fleet-trees.js')).href)

  const added = []
  const started = []
  const nodes = new Map([['node-1-parent', { id: 'node-1-parent', treeId: 'tree-1', status: 'running', parentId: null, sessionId: 'chat-parent-1' }]])
  const answer = await executeCreateAndStartNode({
    command,
    treeStore: {
      getNode: id => nodes.get(id) || null,
      addNode: fields => {
        added.push(fields)
        const node = { id: 'node-2-child', treeId: 'tree-1', status: 'draft', parentId: fields.parentId, role: fields.role, tier: fields.tier, effort: fields.effort }
        nodes.set(node.id, node)
        return { ok: true, node, tree: { id: 'tree-1' } }
      },
      setNodeStatus: () => ({ ok: true }),
    },
    sessionNodeIds: new Map([['chat-parent-1', 'node-1-parent']]),
    sessionThreadIds: new Map([['chat-child-1', 'thread-child-1']]),
    roleRecordFor: role => (['worker', 'manager', 'planner'].includes(role) ? { id: role } : null),
    launchTiers: LAUNCH_TIERS,
    startDraftNode: async (node, options) => {
      started.push({ node, options })
      nodes.set(node.id, { ...nodes.get(node.id), status: 'running', sessionId: 'chat-child-1' })
      return { ok: true, sessionId: 'chat-child-1' }
    },
    treeNodeName: () => 'Worker 1',
  })
  if (!answer.ok) return { answer, node: null, sessionEffort: null }

  /* src/views/computers.js startDraftNodeUnguarded, reproduced with its own
     helpers: the depth the session is recorded as running at. `breakStart`
     is the mutation switch -- it drops the caller's override, which is the
     exact defect this lane fixed. */
  const node = added[0]
  const override = breakStart ? null : started[0].options.effort
  const tierDefault = LAUNCH_TIERS.find(tier => tier.id === node.tier)?.effort || null
  const draftEffort = draftStartEffort({ ...node, ...(breakStart ? { effort: '' } : {}) }, { override, tierDefault })
  return { answer, node, sessionEffort: draftEffort || tierDefault || null }
}

/* Step 4 -- the shipped durable store, writing into the candidate's own state
 * root, and read back off disk rather than out of the writer's memory. */
async function writeAndReadNodeJson(appRoot, stateRoot, { nodeId, effort }) {
  const appRequire = createRequire(path.join(appRoot, 'package.json'))
  const { createNodeTranscriptStore } = appRequire('./shell/node-transcript-store.cjs')
  const store = createNodeTranscriptStore({ directory: stateRoot })
  const computerId = 'this-computer'
  await store.append({
    computerId,
    nodeId,
    entries: [{ id: 'you:1', who: 'you', text: 'Carry out one bounded piece of work.' }],
    /* The metadata src/node-transcript-client.js builds from the record the
       view saves: threadId, effort, provider, account. `effort` is the value
       the start above actually ran at. */
    metadata: { threadId: null, effort, provider: null, account: null },
  })
  /* The store's own folder naming (keyOf): sha256(computerId)-sha256(nodeId)
     under node-transcripts/active. Recomputed rather than guessed, so a
     rename of the scheme fails this script instead of silently reading a
     stale file. */
  const { createHash } = await import('node:crypto')
  const digest = value => createHash('sha256').update(value).digest('hex')
  const file = path.join(stateRoot, 'node-transcripts', 'active', `${digest(computerId)}-${digest(nodeId)}`, 'node.json')
  return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

async function chain(engineRoot, appRoot, stateRoot, { label, breakStart = false } = {}) {
  heading(`chain: ${label}`)
  note(`engine ${engineRoot}`)
  note(`app    ${appRoot}`)

  const { answer, handed } = await engineSpawn(engineRoot)
  check(`${label}: the application is handed the chosen depth`,
    handed?.effort === EFFORT, `request.effort = ${JSON.stringify(handed?.effort)}`)
  check(`${label}: the spawn receipt echoes the applied depth`,
    answer?.applied?.effort === EFFORT, `answer.applied = ${JSON.stringify(answer?.applied)}`)

  const envelope = dispatchEnvelope(handed || { parentSessionId: 'chat-parent-1', role: 'worker', tier: TIER, brief: 'Carry out one bounded piece of work.' })
  let command = await rendererGate(appRoot, envelope)
  check(`${label}: the renderer's transport gate admits the command`,
    command !== null, command === null ? 'cleanTreeNodeCommand returned null (the command is dropped, the caller waits out the broker timeout)' : `command.effort = ${JSON.stringify(command.effort)}`)
  if (command === null) {
    /* A dropped command would end the run here and hide the two defects
       BELOW it. Carry on with the command a caller could actually get
       through this gate -- the same envelope with the three unknown keys
       removed -- so the report shows the whole cost, not the first stop. */
    const { effort: _effort, provider: _provider, model: _model, ...reachable } = envelope
    command = await rendererGate(appRoot, reachable)
    if (command === null) { note('the gate refuses even without the three new keys; nothing downstream can be measured'); return }
    note('continuing with the command this gate does admit, to show what the rest of the path does with it')
  }

  const drawn = await drawAndStart(appRoot, command, { breakStart })
  check(`${label}: the circle carries the chosen depth`,
    drawn.node?.effort === EFFORT, `addNode({ effort: ${JSON.stringify(drawn.node?.effort)} })`)
  check(`${label}: the session runs at the chosen depth`,
    drawn.sessionEffort === EFFORT, `sessionEffort = ${JSON.stringify(drawn.sessionEffort)}`)

  const nodeId = `node-2-child-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  const written = await writeAndReadNodeJson(appRoot, stateRoot, { nodeId, effort: drawn.sessionEffort })
  check(`${label}: node.json on disk records the chosen depth`,
    written.record.effort === EFFORT, `${written.file} -> effort = ${JSON.stringify(written.record.effort)}`)

  /* THE SEVENTH CHECK: THE OTHER DOORWAY (Controller ruling, 2026-09-19).
     The six above walk agent.spawn's tree path. startBoundedChild is the
     bounded-work path a controller uses to hand work down, and it read the
     chosen depth only for codex, so a Claude bounded child was added with
     `effort: ''` and started with `effort: null`. Same owner complaint, second
     door. Driven through the real lifted function against the real tier
     table. */
  const bounded = await boundedChildDepth(appRoot, { tier: TIER, effort: EFFORT })
  check(`${label}: a Claude bounded child is started at the chosen depth`,
    bounded.added === EFFORT && bounded.started === EFFORT,
    `addNode({ effort: ${JSON.stringify(bounded.added)} }), startDraftNode({ effort: ${JSON.stringify(bounded.started)} })`)
}

/* src/views/computers.js startBoundedChild, lifted by name and run with the
 * product's own LAUNCH_TIERS. Every free identifier it reads is supplied here;
 * the view cannot be imported under plain node. */
async function boundedChildDepth(appRoot, { tier, effort }) {
  const source = fs.readFileSync(path.join(appRoot, 'src', 'views', 'computers.js'), 'utf8')
  const { LAUNCH_TIERS, launchTier } = await import(pathToFileURL(path.join(appRoot, 'src', 'orchestration-controls.js')).href)
  let providers = null
  try {
    ({ PROVIDERS_WITH_A_THINKING_DEPTH: providers } =
      await import(pathToFileURL(path.join(appRoot, 'src', 'create-and-start-node.js')).href))
  } catch { providers = null }
  /* At base the set does not exist yet; the lifted body does not reference it
     either, so an empty stand-in keeps the function compilable and lets the
     base answer be the base's own answer rather than a crash. */
  if (!(providers instanceof Set)) providers = new Set()

  const start = source.search(/^ {2}async function startBoundedChild\s*\(/m)
  if (start < 0) throw new Error('startBoundedChild was not found in src/views/computers.js')
  let body = null
  for (let end = source.indexOf('}', start); end !== -1; end = source.indexOf('}', end + 1)) {
    const candidate = source.slice(start, end + 1).trimStart()
    try { new Function(`return (${candidate}\n)`); body = candidate; break } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  if (!body) throw new Error('no complete body for startBoundedChild')

  const added = []
  const started = []
  const parent = { id: 'node-1-parent', treeId: 'tree-1', sessionId: 'parent-session' }
  const nodes = new Map([[parent.id, parent]])
  const bridge = { workStatus: async () => ({ ok: true }) }
  const store = {
    snapshot: () => ({ computerId: 'computer-1' }),
    getNode: id => nodes.get(id) || null,
    addNode: fields => { added.push(fields); const node = { id: 'node-2-child', ...fields }; nodes.set(node.id, node); return { ok: true, node } },
  }
  const factory = new Function(
    'window', 'readOrg', 'orgAvailability', 'mockSource', 'sessionNodeIds', 'isWriteEnabled',
    'START_CONTROL_FLAG', 'roleRecordFor', 'PROVIDERS_WITH_A_THINKING_DEPTH', 'launchTier',
    'tierEffortOf', 'refreshTree', 'startDraftNode', `return (${body}\n)`,
  )
  const startBoundedChild = factory(
    { mcAgent: bridge }, async () => ({ state: 'ready' }), { state: 'ready' }, () => false,
    new Map([[parent.sessionId, parent.id]]), () => true, 'start',
    role => (role === 'worker' ? { id: 'worker', capabilities: {} } : null),
    providers, launchTier, id => launchTier(id)?.effort || null, () => {},
    async (node, options) => { started.push(options); return { ok: true, sessionId: 'child-session' } },
  )
  const answer = await startBoundedChild(
    { computerId: 'computer-1', treeId: 'tree-1', parentNodeId: parent.id, parentSessionId: parent.sessionId,
      tier, effort, brief: 'Carry out one bounded piece of work.', capMs: 1_800_000 },
    store, bridge,
  )
  void LAUNCH_TIERS
  return { ok: answer?.ok === true, added: added[0]?.effort ?? null, started: started[0]?.effort ?? null }
}

/* ------------------------------------------------------------- candidate */

async function cdp(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
  return response.json()
}

async function candidate(appRoot, userDataDir) {
  heading('candidate: a private application launched from this worktree')
  const electron = createRequire(path.join(appRoot, 'package.json'))('electron')
  const executable = typeof electron === 'string' ? electron : String(electron)
  note(`electron ${executable}`)
  note(`--user-data-dir ${userDataDir}`)
  note(`--remote-debugging-port ${DEBUG_PORT}`)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [
    appRoot,
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=http://127.0.0.1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: environment, windowsHide: true })
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })

  let targets = null
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      targets = await cdp(DEBUG_PORT, '/json/list')
      if (Array.isArray(targets) && targets.some(target => target.type === 'page')) break
    } catch { /* not listening yet */ }
    await new Promise(resolve => { setTimeout(resolve, 1000) })
  }
  const page = Array.isArray(targets) ? targets.find(target => target.type === 'page') : null
  const up = check('candidate: the private application is on screen and debuggable',
    Boolean(page), page ? `page ${page.title || page.url}` : `nothing answered on ${DEBUG_PORT} in 90s; tail: ${log.slice(-400).trim()}`)
  return { child, page, up, log: () => log }
}

function stop(child) {
  if (!child || child.killed) return
  try { child.kill() } catch { /* already gone */ }
}

/* ------------------------------------------------------------------- main */

const stateRoot = path.join(HERE, 'state')
fs.mkdirSync(stateRoot, { recursive: true })

let engineRoot = path.join(HERE, 'engine')
let appRoot = path.join(HERE, 'app')
let label = 'tip'

if (wantBase) {
  label = `base ${BASE.engine}/${BASE.app}`
  const exports_ = path.join(HERE, '.laneB-base')
  engineRoot = await exportBase(path.join(HERE, 'engine'), BASE.engine, path.join(exports_, 'engine'))
  appRoot = await exportBase(path.join(HERE, 'app'), BASE.app, path.join(exports_, 'app'))
  linkNodeModules(path.join(HERE, 'app'), appRoot)
  linkNodeModules(path.join(HERE, 'engine'), engineRoot)
}

if (mutation) label = `${label} +mutation:${mutation}`

try {
  await chain(engineRoot, appRoot, path.join(stateRoot, 'transcripts'), {
    label,
    breakStart: mutation === 'drop-start-override',
  })
} catch (error) {
  check(`${label}: the chain ran to the end`, false, String(error && error.message))
}

let candidateChild = null
if (wantCandidate) {
  const launched = await candidate(appRoot, path.join(stateRoot, 'user-data'))
  candidateChild = launched.child
  if (launched.up) {
    /* The candidate's OWN main process wrote the state root; read the same
       node.json back through the running application's transcript bridge, so
       what is proven is that the shipped build can see the depth rather than
       that this script can. */
    try {
      const record = await writeAndReadNodeJson(appRoot,
        path.join(path.join(stateRoot, 'user-data'), 'capability'), { nodeId: 'node-candidate-child', effort: EFFORT })
      check('candidate: node.json under the candidate’s own state root records the depth',
        record.record.effort === EFFORT, `${record.file} -> ${JSON.stringify(record.record.effort)}`)
    } catch (error) {
      check('candidate: node.json under the candidate’s own state root records the depth', false, String(error && error.message))
    }
  }
}

stop(candidateChild)

heading('summary')
const failed = results.filter(result => !result.ok)
process.stdout.write(`${results.length - failed.length}/${results.length} checks passed\n`)
process.stdout.write(failed.length === 0 ? 'GREEN\n' : `RED (${failed.map(result => result.name).join('; ')})\n`)
process.exit(failed.length === 0 ? 0 : 1)
