#!/usr/bin/env node
/* INCREMENTAL GATE EXECUTION FOR THE SHIP PATH.
 *
 * THE COST THIS EXISTS TO REMOVE. `npm run dist` is one chain of ~27 steps and
 * the sealed cut runs it as a single black box. r9 passed 5,472 tests and built
 * the installer, then failed check-no-owner-data on ONE comment. r10 passed
 * everything through the packaged smoke, then failed check-install-dir-immutable.
 * Each failure cost the whole ~20-minute cut, and each fix could only be
 * re-proven by paying it again. The owner asked for flags -- --gates-only,
 * --resume-from, --skip-verified with hash-bound evidence -- so that one failing
 * gate is re-run alone, standalone, against the tree it failed on.
 *
 * ONE SOURCE OF TRUTH, NOT A SECOND LIST. The gates are READ from
 * package.json's `scripts.dist` and split on `&&`, in order. This file never
 * carries its own copy of the chain: tools/test/ship-path.test.mjs pins what the
 * chain must contain, and a list kept here would be a second place for the two
 * to disagree. Every gate id is derived from the segment it names.
 *
 * WHAT MAY BE SKIPPED, AND WHAT MAY NEVER BE.
 *   - Only static checks with an explicit reusable input contract can be
 *     skipped. Runtime tests, private settings and external dependency/history
 *     checks run afresh; their inputs are not identified by an app commit.
 *   - A PRODUCER (vite build, pack:capability, electron-builder, strip
 *     diagnostics, seal --record, the runtime-file prepare/sync steps) makes the
 *     thing later gates inspect. --skip-verified never skips a producer: a
 *     skipped producer is a stale artifact wearing a fresh verdict.
 *
 * HASH-BOUND EVIDENCE, OR NO SKIP. A recorded pass is only reused when the
 * inputs it was measured against are byte-for-byte the ones present now:
 *   - a SOURCE gate binds to the exact HEAD commit and a CLEAN tree. A dirty
 *     tree has no cheap identity, so nothing recorded against it is ever reused
 *     -- the sealed cut requires clean trees at exact refs anyway (HOW-TO-CUT).
 *   - an ARTIFACT gate (anything naming release/) binds to file paths and
 *     contents across release/, including installer siblings, and to the clean
 *     checker source commit. Only this runner's own evidence file is excluded.
 * Reuse is decided at execution time after earlier producers have finished.
 * Evidence carries gate ids, verdicts, bindings and times. It carries no
 * absolute path and no environment, because it lives under release/, which the
 * final check-no-owner-data scan reads.
 *
 * This runner is ADDITIVE. `npm run dist` and the sealed cut are unchanged;
 * this is the standalone dry-run HOW-TO-CUT already tells the cutter to do
 * before every sealed cut, made cheap to repeat. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')
export const DEFAULT_EVIDENCE = path.join('release', 'gate-evidence.json')
export const ARTIFACT_DIRECTORY = 'release'
const BINDING_VERSION = 2

/* Unknown steps are producers for reuse purposes. A new command cannot acquire
 * a cacheable PASS merely because it was not on a list of known producers. */
const PRODUCER_MATCHERS = Object.freeze([
  /^npm run build$/,
  /^npm run pack:capability$/,
  /^electron-builder\b/,
  /^node tools\/strip-build-diagnostics\.mjs\b/,
  /^node tools\/launch-readiness-sync-packed-payload\.mjs\b/,
  /^node tools\/check-electron-runtime-files\.mjs --prepare\b/,
  /^node tools\/seal-artifact\.mjs --record\b/,
  /^node tools\/require-clean-tree\.mjs\b/,
])

// Reuse is an input contract, not a naming convention. Runtime checks, the
// ratchet, external engine/history checks and private-config/dependency checks
// have inputs beyond a clean app commit and release bytes; run them afresh.
const REUSABLE_COMMANDS = [
  /^node tools\/(?:check-plain-language|check-github-claims|check-data-schemas|check-research-queue)\.mjs$/,
  /^node tools\/check-renderer-payload\.mjs release\/win-unpacked$/,
]
const CHECK_COMMAND = /^(?:npm run (?:verify(?::[\w-]+)?|test(?::[\w-]+)?)|node tools\/(?:check-[\w-]+|test-ratchet|smoke-packaged|seal-artifact)\.mjs(?:\s+[^&|;<>]*)?)$/

export function parseDistChain(distScript) {
  if (typeof distScript !== 'string' || distScript.trim() === '') {
    throw new Error('scripts.dist is missing or empty; there is no ship chain to run')
  }
  const segments = distScript.split('&&').map(segment => segment.trim()).filter(Boolean)
  const seen = new Map()
  return segments.map((command, index) => {
    const base = gateIdFor(command)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const id = count === 1 ? base : `${base}#${count}`
    const producer = PRODUCER_MATCHERS.some(matcher => matcher.test(command)) || !CHECK_COMMAND.test(command)
    const artifact = /\brelease(?:\/|\\|$)/.test(command)
    return Object.freeze({
      index,
      id,
      command,
      kind: producer ? 'producer' : 'check',
      reusable: !producer && REUSABLE_COMMANDS.some(matcher => matcher.test(command)),
      binding: artifact ? 'artifact' : 'source',
    })
  })
}

function gateIdFor(command) {
  const npmRun = /^npm run (\S+)$/.exec(command)
  if (npmRun) return `npm:${npmRun[1]}`
  const node = /^node (\S+?)(?:\.mjs|\.cjs|\.js)?(?:\s+(.*))?$/.exec(command)
  if (node) {
    const name = path.posix.basename(node[1].replace(/\\/g, '/'))
    const args = (node[2] ?? '').trim()
    return args ? `${name}:${args.split(/\s+/).join(' ')}` : name
  }
  const first = command.split(/\s+/)[0]
  return first
}

/* ---------------------------------------------------------------- bindings */

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`)
  return result.stdout
}

export function sourceBinding(repo, { gitImpl = git } = {}) {
  const head = gitImpl(['rev-parse', 'HEAD^{commit}'], repo).trim()
  const porcelain = gitImpl(['status', '--porcelain=v1', '--untracked-files=all'], repo)
  const dirty = porcelain.split(/\r?\n/).filter(Boolean)
  return Object.freeze({
    kind: 'source',
    head,
    clean: dirty.length === 0,
    // A dirty tree is deliberately NOT summarised into a hash: the point of the
    // binding is that a reused verdict was measured on these exact bytes, and
    // uncommitted bytes have no identity a later run can re-derive.
    digest: dirty.length === 0 ? head : null,
  })
}

export function artifactBinding(repo, { directory = ARTIFACT_DIRECTORY, exclude = [] } = {}) {
  const root = path.join(repo, directory)
  if (!existsSync(root)) return Object.freeze({ kind: 'artifact', present: false, digest: null })
  if (lstatSync(root).isSymbolicLink()) return Object.freeze({ kind: 'artifact', present: true, digest: null, reason: 'linked artifact inputs are not cacheable' })
  if (!lstatSync(root).isDirectory()) throw new Error('artifact binding requires a directory')
  const excluded = new Set(exclude.map(file => path.resolve(file)))
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  let files = 0
  let linked = false
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) { linked = true; continue }
      if (excluded.has(path.resolve(full))) continue
      const relative = path.relative(root, full).split(path.sep).join('/')
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) throw new Error('artifact binding requires regular files')
      const info = lstatSync(full)
      hash.update(`${relative}\0${info.size}\0`)
      const descriptor = openSync(full, 'r')
      try {
        let count
        while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
      } finally {
        closeSync(descriptor)
      }
      hash.update('\n')
      files += 1
    }
  }
  walk(root)
  return Object.freeze({ kind: 'artifact', present: files > 0 || linked, files, digest: files > 0 && !linked ? hash.digest('hex') : null,
    ...(linked ? { reason: 'linked artifact inputs are not cacheable' } : {}) })
}

/* ---------------------------------------------------------------- evidence */

export function readEvidence(file) {
  if (!existsSync(file)) return { version: 1, gates: {} }
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.gates || typeof parsed.gates !== 'object' || Array.isArray(parsed.gates)) {
    throw new Error(`${path.basename(file)} is not a gate evidence record this runner wrote`)
  }
  return parsed
}

export function writeEvidence(file, evidence) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ plan */

export function selectGates(gates, { gatesOnly = null, resumeFrom = null } = {}) {
  if (gatesOnly && resumeFrom) throw new Error('--gates-only and --resume-from cannot be combined')
  const byId = new Map(gates.map(gate => [gate.id, gate]))
  if (gatesOnly) {
    const wanted = new Set(gatesOnly)
    for (const id of wanted) {
      if (!byId.has(id)) throw new Error(`unknown gate "${id}"; run with --list to see the ids the dist chain defines`)
    }
    return gates.filter(gate => wanted.has(gate.id))
  }
  if (resumeFrom) {
    const start = byId.get(resumeFrom)
    if (!start) throw new Error(`unknown gate "${resumeFrom}"; run with --list to see the ids the dist chain defines`)
    return gates.filter(gate => gate.index >= start.index)
  }
  return gates.slice()
}

export function planRun(gates, { evidence, bindings, skipVerified = false }) {
  return gates.map(gate => {
    const binding = bindings[gate.binding]
    if (!skipVerified) return { gate, action: 'run', reason: null }
    if (gate.kind === 'producer') return { gate, action: 'run', reason: 'producers are never skipped' }
    const prior = evidence.gates[gate.id]
    if (!prior) return { gate, action: 'run', reason: 'no evidence recorded' }
    if (prior.ok !== true) return { gate, action: 'run', reason: 'last recorded run failed' }
    if (!gate.reusable) return { gate, action: 'run', reason: 'this check requires fresh runtime, configuration or dependency evidence' }
    if (!bindings.source?.clean || !bindings.source?.digest) return { gate, action: 'run', reason: 'tree is dirty; checker changes invalidate every verdict' }
    if (!binding || !binding.digest) {
      return { gate, action: 'run', reason: gate.binding === 'source' ? 'tree is dirty; nothing recorded against uncommitted bytes is reused' : (binding?.reason ?? 'artifact absent') }
    }
    if (prior.binding !== binding.digest) return { gate, action: 'run', reason: 'inputs changed since the recorded pass' }
    if (prior.bindingVersion !== BINDING_VERSION || prior.bindingKind !== gate.binding
        || prior.sourceBinding !== bindings.source.digest || prior.commandSha256 !== commandSha256(gate.command)
        || prior.runtime !== `${process.version}/${process.platform}/${process.arch}`) {
      return { gate, action: 'run', reason: 'checker, command, runtime or evidence format changed' }
    }
    return { gate, action: 'skip', reason: `passed at ${prior.finishedAt} against the same inputs` }
  })
}

function commandSha256(command) {
  return createHash('sha256').update(command).digest('hex')
}

/* ------------------------------------------------------------------- run */

export function runGate(gate, { repo, env = process.env, spawn = spawnSync, log = console.log } = {}) {
  const binPath = path.join(repo, 'node_modules', '.bin')
  const childEnv = { ...env, PATH: `${binPath}${path.delimiter}${env.PATH ?? env.Path ?? ''}` }
  const startedAt = new Date().toISOString()
  const started = Date.now()
  log(`[release-gates] RUN ${gate.id}`)
  // On Windows the segment is handed to cmd.exe VERBATIM, wrapped in one pair of
  // quotes that `/s` strips: letting Node re-escape the segment turns
  // `node -e "process.exit(3)"` into a quoted string expression that exits 0,
  // i.e. a failing gate reported as a pass. Measured while testing this file.
  const result = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${gate.command}"`], { cwd: repo, env: childEnv, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
    : spawn('sh', ['-c', gate.command], { cwd: repo, env: childEnv, stdio: 'inherit' })
  const ok = result.status === 0 && !result.error && !result.signal
  const finishedAt = new Date().toISOString()
  log(`[release-gates] ${ok ? 'PASS' : 'FAIL'} ${gate.id} (${Date.now() - started} ms)`)
  return { ok, status: result.status, signal: result.signal ?? null, startedAt, finishedAt, durationMs: Date.now() - started }
}

export async function main(argv, {
  repo = REPO_ROOT,
  log = console.log,
  spawn = spawnSync,
  bindingsImpl = null,
} = {}) {
  const options = parseArgs(argv)
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const gates = parseDistChain(pkg.scripts && pkg.scripts.dist)
  if (options.help) { log(usage()); return 0 }
  if (options.list) {
    for (const gate of gates) log(`${String(gate.index).padStart(2)}  ${gate.kind.padEnd(8)} ${gate.binding.padEnd(8)} ${gate.id}`)
    return 0
  }
  const evidenceFile = path.resolve(repo, options.evidence ?? DEFAULT_EVIDENCE)
  const evidence = readEvidence(evidenceFile)
  const selected = selectGates(gates, { gatesOnly: options.gatesOnly, resumeFrom: options.resumeFrom })
  const measureBindings = (gate = null) => bindingsImpl ? bindingsImpl() : {
    source: sourceBinding(repo),
    artifact: !gate || gate.binding === 'artifact' ? artifactBinding(repo, { exclude: [evidenceFile] }) : { present: false, digest: null },
  }
  const bindings = measureBindings(selected.some(gate => gate.binding === 'artifact') ? null : { binding: 'source' })
  const plan = planRun(selected, { evidence, bindings, skipVerified: options.skipVerified })

  log(`[release-gates] source ${bindings.source.head?.slice(0, 12) ?? '?'} ${bindings.source.clean ? 'clean' : 'DIRTY'}; artifact ${bindings.artifact.present ? (bindings.artifact.digest?.slice(0, 12) ?? 'uncacheable') : 'absent'}`)
  if (options.dryRun) {
    for (const step of plan) log(`[release-gates] ${step.action.toUpperCase().padEnd(4)} ${step.gate.id}${step.reason ? ` -- ${step.reason}` : ''}`)
    log('[release-gates] Preview only; reuse is re-evaluated immediately before each gate.')
    return 0
  }

  for (const gate of selected) {
    const before = measureBindings(gate)
    const [step] = planRun([gate], { evidence, bindings: before, skipVerified: options.skipVerified })
    log(`[release-gates] ${step.action.toUpperCase().padEnd(4)} ${step.gate.id}${step.reason ? ` -- ${step.reason}` : ''}`)
    if (step.action === 'skip') continue
    const outcome = runGate(step.gate, { repo, spawn, log })
    // Bind to the inputs as they were when the gate STARTED. A producer changes
    // the artifact; the check that follows it re-measures and binds anew.
    const bound = before[step.gate.binding]
    const after = step.gate.reusable ? measureBindings(step.gate) : null
    const stable = after && bound.digest === after[step.gate.binding]?.digest && before.source.digest === after.source.digest
    evidence.gates[step.gate.id] = {
      ok: outcome.ok,
      status: outcome.status,
      binding: stable ? bound.digest : null,
      bindingVersion: BINDING_VERSION,
      bindingKind: step.gate.binding,
      sourceBinding: before.source.digest,
      commandSha256: commandSha256(step.gate.command),
      runtime: `${process.version}/${process.platform}/${process.arch}`,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      durationMs: outcome.durationMs,
    }
    writeEvidence(evidenceFile, evidence)
    if (!outcome.ok) {
      log(`[release-gates] STOPPED at ${step.gate.id}; re-run with --resume-from ${step.gate.id} after the fix`)
      return 1
    }
  }
  log('[release-gates] COMPLETE')
  return 0
}

export function parseArgs(argv) {
  const options = { list: false, help: false, dryRun: false, skipVerified: false, gatesOnly: null, resumeFrom: null, evidence: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--list') options.list = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--skip-verified') options.skipVerified = true
    else if (arg === '--all') { /* the default */ }
    else if (arg === '--gates-only') options.gatesOnly = value().split(',').map(id => id.trim()).filter(Boolean)
    else if (arg === '--resume-from') options.resumeFrom = value()
    else if (arg === '--evidence') options.evidence = value()
    else throw new Error(`unrecognised argument: ${arg}`)
  }
  return options
}

function usage() {
  return `usage: node tools/release-gates.mjs [--list] [--all | --gates-only a,b | --resume-from <id>] [--skip-verified] [--dry-run] [--evidence <file>]

Runs the gates of package.json scripts.dist, in order, one at a time, recording
hash-bound evidence in ${DEFAULT_EVIDENCE}.

  --list             print every gate id, kind (check|producer) and binding
  --gates-only a,b   run only the named gates, in dist order
  --resume-from id   run the named gate and everything after it
  --skip-verified    reuse an eligible static check only for the same command,
                     runtime, clean source commit and release contents;
                     producers and runtime/configuration checks always run
  --dry-run          print the plan and exit
  --evidence file    evidence record to read and write (default ${DEFAULT_EVIDENCE})`
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error(`[release-gates] ${error.message}`)
    process.exitCode = 2
  })
}
