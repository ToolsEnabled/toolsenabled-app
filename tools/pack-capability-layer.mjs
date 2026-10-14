#!/usr/bin/env node

// Stages the capability layer -- the half of this product that is not the
// viewer -- into `capability/`, from where electron-builder ships it as an
// extraResource. See tools/capability-manifest.json for what is staged and
// why. Two rules govern this file:
//
//   1. The payload is DERIVED. Nothing is hand-listed except the closure roots
//      and the runtime resources a require() walk provably cannot see -- the
//      JSON in `dataFiles` and the spawned .ps1/.cmd/.py in `helperPrograms`.
//      A hand-maintained file list drifts from the code the day someone adds
//      a require, and drifts silently, because the missing file only shows
//      up on a customer's machine where nobody is watching.
//
//   2. The guard is FAIL-CLOSED. The source tree this payload is cut from is
//      the builder's working tree and currently contains the builder's name,
//      home-directory paths and LAN addresses. Staging runs
//      check-no-owner-data.mjs over the result and exits 1 on any hit.
//      --allow-owner-data exists for engineering runs that must exercise the
//      RUNTIME path before that source is purged; it does not weaken the ship
//      path, because `npm run dist` runs the same guard again over
//      release/win-unpacked, where extraResources have already been copied.

import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { resolveCapabilitySourceBinding } from './lib/capability-source-git.mjs'
import { CAPABILITY_INDEX_FILE, checkCapabilityIndex } from './lib/capability-index-check.mjs'
import { collectProviderRuntimePayload, readPinnedRuntimeFile } from './lib/provider-runtime-payload.mjs'

const execFile = promisify(execFileCallback)
const require_ = createRequire(import.meta.url)
const BUILTINS = new Set(require_('node:module').builtinModules)

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_FILE = path.join(REPO_ROOT, 'tools', 'capability-manifest.json')
const DEFAULTS_DIR = path.join(REPO_ROOT, 'capability-defaults')
const DEFAULT_OUT = path.join(REPO_ROOT, 'capability')
const PAYLOAD_RECORD = 'PAYLOAD.json'
const UNSHIPPABLE_MARKER = 'UNSHIPPABLE-OWNER-DATA.txt'
const NEUTRAL_AGENT_ORG = 'config/agent-org.json'
const SOURCE_AGENT_ORG_EXAMPLE = 'config/agent-org.example.json'

// THE VAULT SCRIPT IS A PROGRAM; THE VAULT IS ITS CONTENTS. Shipping
// tools/secrets.ps1 is the fix this file exists to carry. Shipping
// vault/secrets.json would be handing every customer the builder's credentials,
// and the two live one directory apart under names that differ by four
// characters. So the rule is stated mechanically rather than left to whoever
// edits the manifest next: no staged path may sit under any of these roots, and
// no staged file may carry one of these names, whatever list declared it.
//
// state/ is here for a second reason as well -- the bridge writes per-boot
// bearer tokens into it when started out of the payload directory, so a hand-
// copied payload can carry live tokens (config/payload-boundary.json's
// `excluded` rule catches the same case at the other end of the build).
const SECRET_MATERIAL_PREFIXES = ['vault/', 'state/', 'private/', 'reports/', 'logs/', '.git/']
// SEGMENT-ANCHORED, NOT PREFIX-ANCHORED, AND THAT DIFFERENCE IS THE HOLE IT CLOSES.
//
// These names were matched with startsWith, which only ever sees them at the ROOT
// of the scanned tree. That is right for the staged payload, whose root is the
// payload, and wrong for the built artefact: a vault written into
// `resources/app.asar.unpacked/<pkg>/vault/secrets.json` sits four segments deep,
// so the prefix rule walks straight past the exact thing it exists to catch. The
// basename and extension rules would still catch `secrets.json` by name, but not
// an arbitrarily-named file inside a credential directory -- and "the directory is
// a store" is the whole reason these six are listed separately from the filenames.
//
// Matching is on whole path SEGMENTS, so `state/` catches `<pkg>/state/x` but not
// `state-machine.js`, `restore/`, or `src/lib/fleet-supervisor/state.js`.
//
// MEASURED BEFORE CHANGING, over the real 388-file staged payload: every one of
// the six names appears as a segment ZERO times, so this widens what the rule can
// see without changing any verdict that exists today.
//
// STATED RISK, because it is not measurable yet: the full artefact tree
// (release/win-unpacked) has never been built on this machine, so whether some
// third-party package ships a directory literally named `state` or `logs` is
// UNKNOWN, not known-clean. If this fires on a vendored package, the refusal names
// the offending segment so the cause is one read away -- and the answer then is to
// narrow this list with evidence, never to switch the check off.
const SECRET_MATERIAL_SEGMENTS = new Set(SECRET_MATERIAL_PREFIXES.map((value) => value.replace(/\/$/, '')))
// `secrets` with no extension is listed even though the WORD is deliberately not
// matched as a substring (see the note below). An extensionless file named
// exactly `secrets` is not a program -- tools/secrets.ps1 is the program, and it
// keeps its extension -- so this exact name is unambiguously a store, and adding
// it costs none of the satisfiability the substring rule would have cost.
// Measured before adding: zero files named exactly `secrets` in the staged payload.
const SECRET_MATERIAL_BASENAMES = new Set(['.toolsenabled-local-profile.json','secrets.json', 'auth.json', '.env', 'credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'secrets',
  'renderer-prefs.json', 'renderer-fleet-documents.json', 'agent-spawn-key.enc', 'agent-spawn-records.jsonl', 'agent-turn-usage-records.jsonl',
  'product-accounts.json', 'hosted-product-accounts.json', 'product-session.enc'])
const SECRET_MATERIAL_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.p12', '.sqlite', '.sqlite3'])
// A SECRET CONTAINER IS RECOGNISED BY ITS SHAPE, NOT BY THE WORD "SECRET".
//
// Owner ruling R1191: "The cut must carefully make sure my private info does not
// make it out period." The named shapes were .env / *.pem / *.key / id_rsa /
// keystore.* / "secrets". Five of those six are container shapes and are matched
// here and above. The sixth -- the bare word -- is NOT matched, and that is a
// measurement, not an omission.
//
// MEASURED over the staged payload: the only two files whose names contain
// "secret" are src/lib/secret-patterns.js and tools/secrets.ps1. The second is
// the file this packer exists to ship; its own header says so: "Shipping
// tools/secrets.ps1 is the fix this file exists to carry. Shipping
// vault/secrets.json would be handing every customer the builder's credentials,
// and the two live one directory apart under names that differ by four
// characters."
//
// So a substring rule on the word would refuse the vault SCRIPT while the vault
// CONTENTS are already refused by name and prefix -- it would forbid the product
// from shipping working code, and an unsatisfiable rule is not a stricter rule.
// It gets overridden, and then nothing is checked. The distinction the owner is
// actually asking for is a program that reads a secret store versus the store
// itself, and that is exactly the prefix/basename/extension split above.
//
// These patterns cover the variants a Set of exact names cannot: .env.production,
// keystore.jks, id_rsa.bak. Anchored at the start so a source file merely
// discussing one (env-loader.js) is not caught.
const SECRET_MATERIAL_NAME_PATTERNS = [
  { label: 'dotenv file', regex: /^\.env(\..+)?$/ },
  { label: 'keystore', regex: /^keystore\..+$/ },
  { label: 'private SSH key', regex: /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/ },
]
// What a helperProgram is allowed to be. A helper program is spawned, so an
// entry here that is not executable is either a mistake or an attempt to move
// a data file past the rules that apply to data files.
const HELPER_PROGRAM_EXTENSIONS = new Set(['.ps1', '.cmd', '.bat', '.py'])

// WHERE THE SOURCE TREE IS, IS A SETTING -- NOT A CONSTANT IN THIS FILE.
//
// The obvious convenience here is a default list of sibling directory names to
// try. It was written that way first, and it was wrong for the same reason the
// owner-data guard exists: the name of the private working tree this product is
// built from is itself one of that guard's forbidden patterns, and hardcoding
// it would have committed a fresh copy of exactly the leak the project is
// trying to remove. The exposure from a tracked source file is not the shipped
// artifact -- `!tools/**` keeps this file out of the asar -- it is that tracked
// source publishes on any push.
//
// So the mechanism is code and the location is configuration, resolved in this
// order, all of which keep the path out of git:
//   1. --source <path>
//   2. TOOLSENABLED_SOURCE
//   3. private/capability-source.owner.json  { "path": "...", "ref": "<40-char commit>" }
//      (/private/ is
//      gitignored, and is where this repo already keeps builder-specific
//      settings such as owner-data-patterns.owner.json)
function parseArgs(argv) {
  const options = { source: null, sourceRef: null, out: DEFAULT_OUT, allowOwnerData: false, quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--allow-owner-data') { options.allowOwnerData = true; continue }
    if (flag === '--quiet') { options.quiet = true; continue }
    const value = argv[index + 1]
    if (flag === '--source') { options.source = value; index += 1; continue }
    if (flag === '--source-ref') { options.sourceRef = value; index += 1; continue }
    if (flag === '--out') { options.out = value; index += 1; continue }
    throw new Error(`unknown flag ${flag}`)
  }
  return options
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

function parsedJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`)
  }
}

/* The app owns the bytes that ship; the engine owns the runtime contract.
 * Their comments and formatting may differ, but their declared organisation
 * may not. Check that before the destination is emptied so a drifted source
 * cannot destroy the last coherent staged payload and then fail halfway. */
function assertNeutralAgentOrgSemanticParity({ source, defaultsDir = DEFAULTS_DIR }) {
  const shippedFile = path.join(defaultsDir, NEUTRAL_AGENT_ORG)
  const exampleFile = path.join(source, SOURCE_AGENT_ORG_EXAMPLE)
  if (!existsSync(shippedFile)) throw new Error(`neutral default is missing: capability-defaults/${NEUTRAL_AGENT_ORG}`)
  if (!existsSync(exampleFile)) throw new Error(`capability source is missing its neutral org contract: ${SOURCE_AGENT_ORG_EXAMPLE}`)

  const shipped = parsedJson(shippedFile, `capability-defaults/${NEUTRAL_AGENT_ORG}`)
  const example = parsedJson(exampleFile, SOURCE_AGENT_ORG_EXAMPLE)
  const { $comment: _shippedComment, ...shippedContract } = shipped
  const { $comment: _exampleComment, ...exampleContract } = example
  if (JSON.stringify(canonicalJson(shippedContract)) !== JSON.stringify(canonicalJson(exampleContract))) {
    throw new Error(
      `the app's ${NEUTRAL_AGENT_ORG} and the engine's ${SOURCE_AGENT_ORG_EXAMPLE} are not semantically identical; `
      + 'update both neutral declarations before packing',
    )
  }
}

function assertStagedDefaultByteEquality({ sourceFile, stagedFile, relative }) {
  const expected = readFileSync(sourceFile)
  const actual = readFileSync(stagedFile)
  if (!expected.equals(actual)) {
    throw new Error(`staged neutral default changed bytes while copying capability-defaults/${relative}`)
  }
}

/* A managed-process path is an executable claim, even when it comes from a
 * neutral default. The require() walker cannot discover a path stored in JSON,
 * so bind every installed-process declaration to the files this pack actually
 * stages. An empty entry point is the explicit optional/unavailable state. */
function assertManagedProcessEntrypointShipped(registry, processId, stagedFiles) {
  const entry = registry?.processes?.[processId]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`neutral managed-process registry is missing process ${processId}`)
  }
  if (typeof entry.entryPoint !== 'string' || typeof entry.entryPattern !== 'string') {
    throw new Error(`neutral managed process ${processId} must declare string entryPoint and entryPattern values`)
  }
  const entryPoint = entry.entryPoint.trim().replaceAll('\\', '/')
  const entryPattern = entry.entryPattern.trim().replaceAll('\\', '/')
  if (!entryPoint || !entryPattern) {
    if (entryPoint || entryPattern) {
      throw new Error(`neutral managed process ${processId} must leave both entryPoint and entryPattern empty when unavailable`)
    }
  }
  const staged = stagedFiles instanceof Set ? stagedFiles : new Set(stagedFiles)
  if (entry.registrar !== null && entry.registrar !== undefined) {
    if (typeof entry.registrar !== 'string' || !entry.registrar.trim()) {
      throw new Error(`neutral managed process ${processId} registrar must be null or a non-empty string`)
    }
    const registrar = entry.registrar.trim().replaceAll('\\', '/')
    if (!staged.has(registrar)) {
      throw new Error(
        `neutral managed process ${processId} declares registrar ${registrar}, but that program is absent from the staged payload; `
        + 'add the registrar as a helper program or remove the managed-process declaration',
      )
    }
  }
  if (!entryPoint) return { declared: false }
  if (!staged.has(entryPoint)) {
    throw new Error(
      `neutral managed process ${processId} declares ${entryPoint}, but that program is absent from the staged payload; `
      + 'add the program as a closure root or leave the optional entryPoint and entryPattern empty',
    )
  }
  return { declared: true, entryPoint }
}

function assertManagedProcessEntrypointsShipped(registry, stagedFiles) {
  const processes = registry?.processes
  if (!processes || typeof processes !== 'object' || Array.isArray(processes)) {
    throw new Error('neutral managed-process registry must declare a processes object')
  }
  const processIds = Object.keys(processes).sort()
  if (processIds.length === 0) {
    throw new Error('neutral managed-process registry declares zero processes')
  }
  return processIds.map(processId => assertManagedProcessEntrypointShipped(registry, processId, stagedFiles))
}

// Is byte `index` inside a comment? Used ONLY to decide whether an
// *unresolvable* require mention is real code or prose. This codebase
// documents its own module graph in prose -- src/lib/providers/code-intel.js
// contains the sentence "directly through `require('./module').name(...)` in
// this codebase" -- and a raw text scan reads that as a broken dependency.
//
// The direction of this check is deliberate and load-bearing: it can only
// ever SUPPRESS AN ERROR about a specifier that already failed to resolve on
// disk. It is never consulted to decide that something is not a dependency,
// so a mis-parse here can only turn a hard failure into a hard failure
// somewhere more obvious -- never into a silently missing file. Any mention
// that DOES resolve is staged regardless of whether it sits in a comment;
// over-including a file that already exists costs bytes, and under-including
// one costs a customer a product that does not start.
function insideComment(source, index) {
  let line = false
  let block = false
  let quote = null
  for (let position = 0; position < index; position += 1) {
    const character = source[position]
    const next = source[position + 1]
    if (line) { if (character === '\n') line = false; continue }
    if (block) { if (character === '*' && next === '/') { block = false; position += 1 } continue }
    if (quote) {
      if (character === '\\') { position += 1; continue }
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue }
    if (character === '/' && next === '/') { line = true; position += 1; continue }
    if (character === '/' && next === '*') { block = true; position += 1 }
  }
  return line || block
}

// Static require() walk. Deliberately literal-only: a computed require would
// be an unresolvable dependency at pack time, so it is reported rather than
// guessed at. The capability layer currently has none.
function computeClosure(root, entrypoints, declaredDynamic = []) {
  const seen = new Set()
  const external = new Set()
  const dynamic = []
  const unresolved = []
  const queue = entrypoints.map((entry) => path.resolve(root, entry))
  const declared = new Map(declaredDynamic.map((entry) => [`${entry.from}\0${entry.expression}`, entry.resolvesTo]))
  const usedDeclarations = new Set()

  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    if (!existsSync(file)) { unresolved.push({ from: '<entrypoint>', spec: path.relative(root, file) }); continue }
    seen.add(file)
    if (path.extname(file) === '.json') continue

    const source = readFileSync(file, 'utf8')
    const pattern = /require\(\s*([^)]*?)\s*\)/g
    let match
    while ((match = pattern.exec(source))) {
      const raw = match[1].trim()
      const literal = /^(['"])([^'"]+)\1$/.exec(raw)
      if (!literal) {
        if (insideComment(source, match.index)) continue
        const relative = path.relative(root, file).split(path.sep).join('/')
        const key = `${relative}\0${raw.slice(0, 80)}`
        const targets = declared.get(key)
        if (!targets) { dynamic.push({ from: relative, expression: raw.slice(0, 80) }); continue }
        usedDeclarations.add(key)
        for (const target of targets) queue.push(path.resolve(root, target))
        continue
      }
      const spec = literal[2]
      if (spec.startsWith('node:') || BUILTINS.has(spec)) continue
      if (!spec.startsWith('.')) {
        if (!insideComment(source, match.index)) external.add(spec)
        continue
      }

      const base = path.resolve(path.dirname(file), spec)
      const resolved = [base, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, 'index.js')]
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
      if (resolved) queue.push(resolved)
      else if (!insideComment(source, match.index)) unresolved.push({ from: path.relative(root, file), spec })
    }
  }

  const files = [...seen].map((file) => path.relative(root, file).split(path.sep).join('/')).sort()
  // A declaration that no longer matches anything is a stale claim about the
  // code, and stale claims are how a manifest quietly stops describing what it
  // packs. Surface it rather than carry it.
  const staleDeclarations = [...declared.keys()]
    .filter((key) => !usedDeclarations.has(key))
    .map((key) => key.split('\0').join(': '))
  return { files, external: [...external].sort(), dynamic, unresolved, staleDeclarations }
}

// Refuses to stage credential storage no matter which manifest list named it.
// Deliberately checked against the FINAL staged set rather than each list as it
// is read: the whole point is that it cannot be bypassed by choosing a
// different category, and a per-list check would have to be repeated four times
// and would be forgotten on the fifth list someone adds.
function assertNoSecretMaterial(relativePaths) {
  const offenders = []
  for (const relative of relativePaths) {
    const normalized = relative.split(path.sep).join('/')
    const basename = path.posix.basename(normalized).toLowerCase()
    const extension = path.posix.extname(normalized).toLowerCase()
    const segments = normalized.toLowerCase().split('/').slice(0, -1)
    const segment = segments.find((candidate) => SECRET_MATERIAL_SEGMENTS.has(candidate))
    const namePattern = SECRET_MATERIAL_NAME_PATTERNS.find((candidate) => candidate.regex.test(basename))
    if (segment) offenders.push(`${normalized} -- under a ${segment}/ directory`)
    else if (SECRET_MATERIAL_BASENAMES.has(basename)) offenders.push(`${normalized} -- named ${basename}`)
    else if (segments.includes('accounts') && /^[0-9a-f]{32}\.json$/.test(basename)) offenders.push(`${normalized} -- saved account data`)
    else if (namePattern) offenders.push(`${normalized} -- ${namePattern.label}`)
    else if (SECRET_MATERIAL_EXTENSIONS.has(extension)) offenders.push(`${normalized} -- ${extension} file`)
  }
  if (!offenders.length) return
  throw new Error(
    'refusing to stage credential or runtime-state material into the capability payload:\n  ' +
      offenders.join('\n  ') +
      '\nThe vault SCRIPT (tools/secrets.ps1) ships; the vault CONTENTS never do. If a program\n' +
      'genuinely needs one of these paths at runtime it creates it on the customer\'s machine.',
  )
}

function assertPythonHelpersDeclared(sourceRoot, closureFiles, helperPrograms) {
  const declared = new Set(helperPrograms)
  const missing = new Set()
  for (const file of closureFiles) {
    if (!/\.[cm]?js$/.test(file)) continue
    const absolute = path.resolve(sourceRoot, file)
    const source = readFileSync(absolute, 'utf8')
    // These are repository-owned helper paths. SDK-owned Python programs
    // resolved against a configured external runtime are outside this bundle.
    const pattern = /(?:path\.(?:join|resolve)\(\s*__dirname\s*,|rootPath\()\s*((?:['"][^'"\r\n]+['"]\s*,\s*)*['"][^'"\r\n]+\.py['"])\s*\)/g
    for (const match of source.matchAll(pattern)) {
      if (insideComment(source, match.index)) continue
      const parts = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(value => value[1])
      const base = match[0].startsWith('rootPath(') ? sourceRoot : path.dirname(absolute)
      const resolved = path.resolve(base, ...parts)
      const relative = path.relative(sourceRoot, resolved).split(path.sep).join('/')
      if (relative.startsWith('../') || path.isAbsolute(relative) || !declared.has(relative)) missing.add(relative)
    }
  }
  if (missing.size) throw new Error('Python helpers reached by the shipped JavaScript must be declared in helperPrograms:\n  ' + [...missing].sort().join('\n  '))
}

function assertHelperProgramsAreExecutable(helperPrograms) {
  const wrong = helperPrograms.filter((relative) => !HELPER_PROGRAM_EXTENSIONS.has(path.extname(relative).toLowerCase()))
  if (!wrong.length) return
  throw new Error(
    'tools/capability-manifest.json lists helperPrograms that are not executable helpers:\n  ' +
      wrong.join('\n  ') +
      `\nhelperPrograms is for spawned non-JavaScript programs (${[...HELPER_PROGRAM_EXTENSIONS].join(', ')}).\n` +
      'JavaScript the payload spawns belongs in spawnedPrograms, where its require() graph is walked;\n' +
      'JSON read through a computed path belongs in dataFiles.',
  )
}

// POWERSHELL HAS A DEPENDENCY GRAPH TOO, AND HAND-LISTING IT WOULD REPEAT THE
// BUG THIS FILE JUST FIXED.
//
// tools/secrets.ps1 dot-sources tools/owner-prompt-theme.ps1 at line 736. Ship
// the vault script alone and it still cannot run: PowerShell reports "The term
// '...owner-prompt-theme.ps1' is not recognized as the name of a cmdlet,
// function, script file, or operable program" -- measured, in a sterile payload,
// AFTER secrets.ps1 was added to the manifest and the pack reported clean.
// Declaring the second file by hand would fix today and leave the next
// dot-source to be discovered by a customer, which is exactly how the first
// file went missing. So the .ps1 closure is DERIVED, on the same terms as the
// require() closure: walked from the declared helpers, and fail-closed on a
// reference that does not resolve.
//
// Both $PSScriptRoot-relative forms this tree actually uses, and the reason
// there are two: the first draft of this walk matched only `$PSScriptRoot\x`
// and reported a clean pack over the very file it was written to catch, because
// secrets.ps1 spells it `. (Join-Path $PSScriptRoot 'owner-prompt-theme.ps1')`.
// A scanner that silently matches nothing is worse than no scanner, so both are
// listed explicitly and there is a test that would fail if either stopped
// matching.
//
// References anchored anywhere else -- $RepoRoot, an absolute path, a computed
// name -- are deliberately NOT followed. The one instance in this tree
// (owner-prompt-queue.ps1's Join-Path $RepoRoot 'tools\start-owner-host.ps1')
// is guarded by a Test-Path that returns when the file is absent, so it
// degrades rather than throws; a future unguarded one would surface as a
// runtime failure in the packaged smoke gate, which now exercises a real
// credential-backed call.
const PS_SCRIPT_ROOT_REFERENCES = [
  /\$PSScriptRoot[\\/]([A-Za-z0-9_.\\/-]+?\.(?:ps1|psm1|psd1))/gi,
  /Join-Path\s+\$PSScriptRoot\s+['"]([A-Za-z0-9_.\\/-]+?\.(?:ps1|psm1|psd1))['"]/gi,
]

function computePowerShellClosure(root, seeds) {
  const seen = new Set()
  const unresolved = []
  const queue = seeds.filter((seed) => /\.(ps1|psm1|psd1)$/i.test(seed))

  while (queue.length) {
    const relative = queue.pop()
    if (seen.has(relative)) continue
    const file = path.join(root, relative)
    if (!existsSync(file)) { unresolved.push({ from: '<declared helper>', spec: relative }); continue }
    seen.add(relative)

    const source = readFileSync(file, 'utf8')
    const directory = path.posix.dirname(relative.split(path.sep).join('/'))
    for (const pattern of PS_SCRIPT_ROOT_REFERENCES) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(source))) {
        const target = path.posix.normalize(path.posix.join(directory, match[1].split('\\').join('/')))
        if (seen.has(target)) continue
        if (!existsSync(path.join(root, target))) { unresolved.push({ from: relative, spec: target }); continue }
        queue.push(target)
      }
    }
  }
  return { files: [...seen].sort(), unresolved }
}

// The guard has THREE outcomes, not two, and collapsing the last two is how a
// payload nobody scanned gets described as a payload somebody scanned.
//
//   exit 0  clean       -- it ran, and found nothing.
//   exit 1  violations  -- it ran, and found offenders it can name.
//   exit 2  COULD NOT RUN -- a setup problem, almost always a missing or
//                            foreign private/owner-data-patterns.owner.json.
//
// Treating 2 as 1 produced a genuinely misleading failure: the packer printed
// "0 file(s) carry builder-identifying data" followed by prose blaming the
// capability-layer SOURCE for carrying the builder's name -- a diagnosis of a
// scan that never happened, sending the builder hunting for data nothing had
// detected. Worse, under --allow-owner-data the same collapse staged an
// UNSCANNED payload and logged it as "DIRTY (0 files)".
//
// tools/check-declaration-privacy.mjs already draws this line correctly
// ("Unchecked is not clean, so nothing was written"); this mirrors it.
const GUARD_SETUP_ERROR = 2

// THE REFUSAL IS CORRECT; THE DIAGNOSIS WAS NOT.
//
// The overwhelmingly common reason the guard cannot run is that this file is
// absent, and it is absent BY DESIGN: /private/ is gitignored, so the owner
// supplies it per machine and a fresh clone or worktree has never had it. The
// refusal below must stay exactly as strict -- what follows only explains it.
//
// Two things were wrong with explaining it via the child's stderr alone:
//
//   1. The packer named the missing path only by forwarding the child's
//      message. The `|| \`... exited N without a message.\`` fallback directly
//      above admits the child may say nothing -- and in that case the refusal
//      named no file, no cause and no remedy at all.
//   2. "Fix the guard's setup and re-run" points nowhere. Even with the child's
//      text, nothing said the absence is EXPECTED. A reader who has just made a
//      worktree reads "is missing" as a broken checkout and goes looking for
//      what deleted it, or -- far worse -- goes looking for a way around the
//      guard, which is the one door this project must never open.
//
// So the packer now states the cause itself, from its own existsSync, and
// points at the committed template and the document that describes the copy.
const OWNER_PATTERNS_RELATIVE = 'private/owner-data-patterns.owner.json'
const OWNER_PATTERNS_EXAMPLE = 'config/owner-data-patterns.example.json'
const OWNER_PATTERNS_DOCUMENT = 'docs/REPRODUCIBLE-BUILD.md'

/* Why the guard could not run, in the packer's own words. Exported so the
 * regression can assert the text without reconstructing a whole pack. */
function describeGuardSetupFailure({ repoRoot = REPO_ROOT } = {}) {
  const expected = path.join(repoRoot, 'private', 'owner-data-patterns.owner.json')
  if (existsSync(expected)) {
    // Present, so the setup problem is something else and this must not invent
    // a cause. The child's report above is the only evidence there is.
    return (
      `\n${OWNER_PATTERNS_RELATIVE} IS present at ${expected}, so the missing-owner-profile\n` +
      'case does not apply here. The guard failed to run for the reason it reported above.'
    )
  }
  return (
    `\nWHY: the owner-data guard has no identity profile to search for.\n` +
    `  missing file: ${OWNER_PATTERNS_RELATIVE}\n` +
    `  expected at:  ${expected}\n` +
    `${OWNER_PATTERNS_RELATIVE} is an OWNER-SUPPLIED PRIVATE INPUT. It is deliberately\n` +
    'NOT committed to this repository -- /private/ is gitignored -- so a fresh clone or\n' +
    'worktree has never had it. Its absence is the expected state of a new checkout, not\n' +
    'a broken one and not a missing dependency: nothing deleted it and no branch carries\n' +
    'it. The guard refuses rather than scanning a payload for nobody, and that refusal is\n' +
    'correct -- do not weaken it.\n' +
    `\nTO PROCEED: copy the committed template ${OWNER_PATTERNS_EXAMPLE} to\n` +
    `${OWNER_PATTERNS_RELATIVE} and replace every placeholder with the names, usernames\n` +
    `and account aliases that must never ship. ${OWNER_PATTERNS_DOCUMENT} describes this step.\n` +
    'The copy stays local and gitignored; it must not be committed.'
  )
}

async function runOwnerDataGuard(directory) {
  try {
    const { stdout } = await execFile(process.execPath, [path.join(REPO_ROOT, 'tools', 'check-no-owner-data.mjs'), directory], {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { clean: true, ran: true, report: stdout }
  } catch (error) {
    const report = `${error.stdout || ''}${error.stderr || ''}`
    // A spawn failure (ENOENT, EACCES) has no numeric exit status at all. That
    // is even less evidence than exit 2, so it takes the same fail-closed path
    // rather than the "we found offenders" one.
    const ran = error.code !== GUARD_SETUP_ERROR && typeof error.code === 'number'
    return { clean: false, ran, report, exitCode: error.code }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const log = (message) => { if (!options.quiet) console.log(message) }

  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
  const binding = resolveCapabilitySourceBinding({
    repoRoot: REPO_ROOT,
    explicitSource: options.source,
    explicitSourceRef: options.sourceRef,
  })
  const { source, sourceRef } = binding
  const out = path.resolve(options.out)
  log(`capability source: ${source} @ ${sourceRef}`)
  if (!Array.isArray(manifest.neutralDefaults) || !manifest.neutralDefaults.includes(NEUTRAL_AGENT_ORG)) {
    throw new Error(`${NEUTRAL_AGENT_ORG} is no longer declared as a neutral default`)
  }
  assertNeutralAgentOrgSemanticParity({ source })
  if (!manifest.dataFiles?.includes(CAPABILITY_INDEX_FILE) || manifest.neutralDefaults.includes(CAPABILITY_INDEX_FILE)) {
    throw new Error('the capability index must be declared as engine-derived payload data')
  }
  // Reject a stale catalogue before touching the previous staged payload.
  const checkedIndex = await checkCapabilityIndex({ source })
  log(`capability index: current for ${checkedIndex.toolCount} registered tools`)

  // Entrypoints are walked with the host modules the shell require()s directly
  // (see $comment_hostModules in the manifest). Both are closure ROOTS and
  // obey the same fail-closed rules; only entrypoints are startable, which is
  // why PAYLOAD.json keeps them apart.
  const hostModules = manifest.hostModules || []
  // Programs the PAYLOAD spawns (see $comment_spawnedPrograms). They are
  // closure roots for the same reason an entrypoint is: each has its own
  // require() graph, and copying one verbatim would ship a program whose first
  // require() throws on the customer's machine.
  const spawnedPrograms = manifest.spawnedPrograms || []
  const helperPrograms = manifest.helperPrograms || []
  assertHelperProgramsAreExecutable(helperPrograms)
  const closure = computeClosure(source, [...manifest.entrypoints, ...hostModules, ...spawnedPrograms], manifest.dynamicRequires || [])
  assertPythonHelpersDeclared(source, closure.files, helperPrograms)
  if (closure.staleDeclarations.length) {
    throw new Error(
      'tools/capability-manifest.json declares dynamic requires that no longer exist in the source:\n  ' +
        closure.staleDeclarations.join('\n  ') +
        '\nRemove them, or fix the expression they were meant to match.',
    )
  }
  /* A NEUTRAL DEFAULT IS RESOLVED BY THE DEFAULT, NOT BY THE SOURCE.
     The walker resolves every declared dynamic-require target against the
     source tree. config/agent-org.json is such a target -- and it is also a
     neutralDefault: it ships from capability-defaults/, never from the source,
     because in a builder's checkout that path holds the builder's own org and
     in the published engine it deliberately does not exist at all. Demanding a
     source copy therefore meant the payload worktree had to carry an untracked
     file -- which require-clean-tree then refused, rightly, as bytes git
     history could not reproduce. So a target that the manifest already names
     as a neutral default, and that capability-defaults/ actually holds, counts
     as resolved: the payload WILL contain it, from the place the manifest says.
     Anything else unresolved is still the hard refusal it always was. */
  const neutralByPath = new Set(manifest.neutralDefaults || [])
  const unresolved = closure.unresolved.filter((entry) => {
    const relative = String(entry.spec).split(path.sep).join('/')
    return !(neutralByPath.has(relative) && existsSync(path.join(DEFAULTS_DIR, relative)))
  })
  if (unresolved.length) {
    throw new Error(
      'the capability closure has unresolved requires; staging a payload that cannot load is worse than not staging one:\n  ' +
        unresolved.map((entry) => `${entry.from} -> ${entry.spec}`).join('\n  '),
    )
  }
  if (closure.external.length) {
    throw new Error(
      'the capability layer now depends on npm packages, which this payload does not ship:\n  ' +
        closure.external.join('\n  ') +
        '\nEither vendor them into the payload or remove the dependency; do not ship a layer that cannot resolve its own imports.',
    )
  }
  if (closure.dynamic.length) {
    throw new Error(
      'the capability layer contains computed require() expressions that a pack-time walk cannot follow:\n  ' +
        closure.dynamic.map((entry) => `${entry.from}: ${entry.expression}`).join('\n  '),
    )
  }

  const powershell = computePowerShellClosure(source, helperPrograms)
  if (powershell.unresolved.length) {
    throw new Error(
      'a declared helper program references a PowerShell script that is not in the source tree:\n  ' +
        powershell.unresolved.map((entry) => `${entry.from} -> ${entry.spec}`).join('\n  ') +
        '\nStaging a helper that cannot dot-source its own dependencies ships a vault script that throws\n' +
        'CommandNotFoundException on the customer\'s first credential read.',
    )
  }

  const providerRuntimes = collectProviderRuntimePayload(source, manifest.providerRuntimes || [])
  const neutral = new Set(manifest.neutralDefaults)
  const staged = [...new Set([...closure.files, ...manifest.dataFiles, ...helperPrograms, ...powershell.files, ...providerRuntimes.files])]
    .filter((file) => !neutral.has(file))
    .sort()
  assertNoSecretMaterial([...staged, ...manifest.neutralDefaults])
  const defaults = [...manifest.neutralDefaults]
  const all = [...staged, ...defaults].sort()
  const managedDefaultRelative = 'config/managed-processes.json'
  const managedDefault = parsedJson(
    path.join(DEFAULTS_DIR, managedDefaultRelative),
    `capability-defaults/${managedDefaultRelative}`,
  )
  const stagedFiles = new Set(all)
  assertManagedProcessEntrypointsShipped(managedDefault, stagedFiles)

  /* EMPTY THE DIRECTORY; DO NOT DELETE IT.
   *
   * This was `rmSync(out, {recursive, force})` followed by `mkdirSync(out)`.
   * Same end state -- an empty destination -- but deleting the ROOT fails with
   * EBUSY whenever any process holds the directory itself, and on Windows a
   * process merely having it as its working directory is enough.
   *
   * That is not hypothetical here: agents are directed to offload read-only
   * analysis to `codex exec --cd <this tree>`, and each such run holds this
   * path for its lifetime. Measured tonight -- `rmdir(capability)` failed
   * EBUSY while removing all eight children INDIVIDUALLY succeeded, which is
   * what proves the lock is on the directory and not its contents. With two
   * such runs alive, `npm run dist` died here before writing a single file,
   * and the count rose from two to four within the hour because every lane is
   * told to work that way.
   *
   * The alternative on the table was freezing that directive across the whole
   * swarm to wait for a natural gap that may never come. This is two lines
   * instead, and it removes the race rather than scheduling around it.
   *
   * `force: true` on each child so a concurrent reader that vanishes between
   * readdir and rm does not fail the build. */
  mkdirSync(out, { recursive: true })
  for (const entry of readdirSync(out)) {
    rmSync(path.join(out, entry), { recursive: true, force: true })
  }

  let bytes = 0
  for (const relative of staged) {
    const from = path.join(source, relative)
    if (!existsSync(from)) throw new Error(`declared payload file is absent from the source tree: ${relative}`)
    const to = path.join(out, relative)
    mkdirSync(path.dirname(to), { recursive: true })
    const runtimePin = providerRuntimes.pins.get(relative)
    if (runtimePin) {
      writeFileSync(to, readPinnedRuntimeFile(source, relative, runtimePin))
      readPinnedRuntimeFile(out, relative, runtimePin)
    } else cpSync(from, to)
    assertStagedDefaultByteEquality({ sourceFile: from, stagedFile: to, relative })
    bytes += statSync(to).size
  }

  for (const relative of defaults) {
    const from = path.join(DEFAULTS_DIR, relative)
    if (!existsSync(from)) throw new Error(`neutral default is missing: capability-defaults/${relative}`)
    const to = path.join(out, relative)
    mkdirSync(path.dirname(to), { recursive: true })
    cpSync(from, to)
    bytes += statSync(to).size
  }

  const digest = createHash('sha256')
  for (const relative of all) {
    digest.update(relative)
    digest.update('\0')
    digest.update(readFileSync(path.join(out, relative)))
  }

  log(`staged ${all.length} files (${(bytes / 1024 / 1024).toFixed(2)} MB) into ${out}`)

  const guard = await runOwnerDataGuard(out)
  // THIS RECORD DELIBERATELY CARRIES NO TIMESTAMP.
  //
  // It used to carry `stagedAt: new Date().toISOString()`, which had a writer
  // and no reader anywhere -- not in shell/capability-layer.cjs, not in
  // check-asar-manifest.mjs, smoke-packaged.mjs, capability-acceptance.mjs or
  // check-payload-current.mjs, which between them consume entrypoints,
  // bridgeEntrypoint, hostModules, fileCount, ownerDataClean and
  // neutralDefaults. It was nonetheless the ONLY thing that stopped two
  // stagings of identical source from producing an identical payload: every
  // other staged file was byte-for-byte the same across rebuilds.
  //
  // docs/REPRODUCIBLE-BUILD.md §5 tells a reader who needs to prove two builds
  // carry the same payload to compare resources/ between them. One unread
  // wall-clock field made that comparison impossible to pass. Removing it costs
  // nothing and makes the payload verifiable.
  //
  // Note payloadSha256 below is computed from `digest`, which was accumulated
  // BEFORE this record exists, so it has always excluded PAYLOAD.json itself by
  // construction -- and fileCount counts `all`, which likewise cannot include
  // the record being written. Neither is a bug; do not "fix" either.
  const record = {
    schemaVersion: 1,
    sourceRef,
    entrypoints: manifest.entrypoints,
    bridgeEntrypoint: manifest.entrypoints[0],
    ownerHostModule: 'src/owner-host.js',
    hostModules,
    spawnedPrograms,
    helperPrograms,
    ...(providerRuntimes.records.length ? { providerRuntimes: providerRuntimes.records } : {}),
    fileCount: all.length,
    byteCount: bytes,
    payloadSha256: digest.digest('hex'),
    neutralDefaults: defaults,
    ownerDataClean: guard.clean,
  }
  writeFileSync(path.join(out, PAYLOAD_RECORD), `${JSON.stringify(record, null, 2)}\n`)

  // Close the source-side TOCTOU window: a branch checkout is allowed, but it
  // must still be the exact clean commit after every byte has been copied.
  resolveCapabilitySourceBinding({
    repoRoot: REPO_ROOT,
    explicitSource: source,
    explicitSourceRef: sourceRef,
  })

  if (guard.clean) {
    rmSync(path.join(out, UNSHIPPABLE_MARKER), { force: true })
    log('owner-data guard: clean')
    return
  }

  // THE GUARD COULD NOT RUN. Say only that, and refuse -- including under
  // --allow-owner-data. That flag means "I know what this payload carries and
  // I am staging it anyway for an engineering run"; its whole contract is the
  // named offender list it writes into the marker. When the scanner never ran
  // there is no such list, so the flag's premise does not hold and honouring it
  // would stage an unscanned payload under a marker claiming 0 offenders.
  if (!guard.ran) {
    writeFileSync(
      path.join(out, UNSHIPPABLE_MARKER),
      'The owner-data guard could not run against this payload, so nothing has checked it.\n' +
        'Unchecked is not clean. This payload must not be shipped.\n',
    )
    console.error('\nOwner-data guard COULD NOT RUN, so this payload is UNCHECKED -- not clean, and not known-dirty.')
    console.error(guard.report.trim() || `check-no-owner-data.mjs exited ${guard.exitCode} without a message.`)
    console.error(describeGuardSetupFailure())
    console.error(
      '\nNothing was scanned, so there is no offender list and no conclusion to draw about the\n' +
        'capability-layer source. Re-run the pack once the step above is done; --allow-owner-data\n' +
        'will NOT bypass this, because it accepts KNOWN owner data and nothing here is known.\n' +
        `The staged payload is marked ${UNSHIPPABLE_MARKER}.`,
    )
    process.exitCode = 1
    return
  }

  const summary = guard.report.split('\n').filter((line) => line.includes('Per-pattern matches') || line.startsWith('Scanned')).join('\n')
  const offenders = [...new Set(guard.report.split('\n').filter((line) => line.includes('| pattern=')).map((line) => line.split(' | ')[0]))]

  if (!options.allowOwnerData) {
    writeFileSync(path.join(out, UNSHIPPABLE_MARKER), 'This payload failed the owner-data guard and must not be shipped.\n')
    console.error('\nOwner-data guard FAILED on the staged capability payload.')
    console.error(summary)
    console.error(`\n${offenders.length} file(s) carry builder-identifying data:`)
    for (const file of offenders) console.error(`  ${path.relative(out, file)}`)
    console.error(
      '\nThis is not a packaging defect -- the packaging works. It is the capability-layer SOURCE\n' +
        'carrying the builder\'s name, home paths and LAN addresses (SHIPMENT-PLAN P3.4). Purge those\n' +
        'in the source tree, or re-run with --allow-owner-data to exercise the runtime path only.\n' +
        'The staged payload is marked UNSHIPPABLE-OWNER-DATA.txt and `npm run dist` will refuse it again.',
    )
    process.exitCode = 1
    return
  }

  writeFileSync(
    path.join(out, UNSHIPPABLE_MARKER),
    'This payload was staged with --allow-owner-data for an engineering run.\n' +
      'It carries builder-identifying data and MUST NOT be shipped to anyone.\n' +
      `Offending files (${offenders.length}):\n` +
      offenders.map((file) => `  ${path.relative(out, file)}`).join('\n') +
      '\n',
  )
  log(`owner-data guard: DIRTY (${offenders.length} files) -- staged anyway under --allow-owner-data, marked ${UNSHIPPABLE_MARKER}`)
}

// Run only when invoked as a program. Until this guard existed, importing this
// module STAGED A PAYLOAD as a side effect, so the three refusals above -- the
// ones that decide whether credentials or runtime state can reach a customer --
// were the only rules in the build with no way to test them except by watching
// a full pack fail. A guard nobody can exercise in isolation is a guard nobody
// notices the day it stops firing.
// Compare filesystem identities, not spellings. Release lanes invoke tools
// through junctions, and Windows paths are case-insensitive; a URL/string
// comparison made those real invocations look like imports, so main() ran
// nothing and Node exited 0. realpathSync.native resolves both aliases using
// the platform's own path semantics.
const invokedPath = process.argv[1] ? realpathSync.native(process.argv[1]) : ''
const modulePath = realpathSync.native(fileURLToPath(import.meta.url))
if (invokedPath === modulePath) {
  main().catch((error) => {
    console.error(`pack-capability-layer: ${error.message}`)
    process.exitCode = 1
  })
}

export {
  HELPER_PROGRAM_EXTENSIONS,
  OWNER_PATTERNS_DOCUMENT,
  OWNER_PATTERNS_EXAMPLE,
  OWNER_PATTERNS_RELATIVE,
  SECRET_MATERIAL_PREFIXES,
  describeGuardSetupFailure,
  assertHelperProgramsAreExecutable,
  assertPythonHelpersDeclared,
  assertManagedProcessEntrypointShipped,
  assertManagedProcessEntrypointsShipped,
  assertNeutralAgentOrgSemanticParity,
  assertNoSecretMaterial,
  assertStagedDefaultByteEquality,
  computeClosure,
  computePowerShellClosure,
  main,
}
