'use strict'

/* The permission level, recorded where the rest of the product looks for it.
 *
 * docs/design/INSTALLER-EXPERIENCE.md 2.1 calls the permission-level question
 * the product's first impression. Until now it existed in exactly one place --
 * tools/mcsetup.js, an interactive command-line program -- so the only way to
 * answer it was to have a developer checkout and a terminal. The screen this
 * module backs asks it in the app instead.
 *
 * IT WRITES THE ENGINE'S RECORD, NOT A SECOND ONE.
 * The tempting shortcut is a small app-owned file holding one string. That
 * would produce two answers to "what level is this install", which is worse
 * than none, because the two cannot disagree loudly. So every value here comes
 * from src/lib/setup/machine-record.js out of the capability payload: it owns
 * the list of tiers, the shape of the record, the validation, and the atomic
 * write. This file resolves the four machine facts that module cannot know
 * from inside a GUI process, and otherwise gets out of the way.
 *
 * IT NEVER RETURNS AN INTERNAL PATH.
 * The services root, the install root and the runtime stay in the main process,
 * for the same reason shell/main.cjs keeps the agent resolver's path-bearing
 * message out of its IPC reply: a failure string is the easiest way for an
 * internal directory name to reach the DOM.
 *
 * ONE PATH CROSSES, AND IT IS NOT ONE OF THOSE. The workspace does, because
 * docs/design/INSTALLER-EXPERIENCE.md section 3 step 7 asks the person WHICH
 * FOLDER their assistant may work in, and that question cannot be asked without
 * naming the folder -- "Guided is shown one card containing `Documents\AI
 * Workspace`, created for her, with a single 'Use this folder' button". It is
 * also the one path here that belongs to the user rather than to the
 * installation, so showing it tells them about their own computer rather than
 * about ours. The rule it is an exception to is unchanged for every other value:
 * servicesRoot, installRoot and nodePath are still absent from every reply below,
 * including the failure ones.
 *
 * (This was the gap the first-run screen shipped with. `recordTier` writes
 * `workspaceRoots: [workspace.defaultWorkspacePath({})]` when no record exists,
 * so an installation that never answered the workspace question still has one --
 * chosen for the user, in a folder they were never shown. The functions below
 * exist to stop that being the only way it can happen. And the record NAMING a
 * folder is no longer the same as the product CONFIGURING it: writeAssistantConfig
 * writes the person's `.mcp.json` only where the record says a person chose the
 * folder -- `workspaceChosen`, stamped by recordWorkspaces -- never into the
 * default it had to name to be a valid record.)
 */

const fs = require('node:fs')
const path = require('node:path')
const { resolveCapabilityRoot } = require('./capability-layer.cjs')

/* Declared in tools/capability-manifest.json under `hostModules`, which is what
 * puts them in the payload; a copy of the path is unavoidable (the manifest is
 * a build input and this is a runtime read), so the failure below names the
 * manifest rather than reporting a bare MODULE_NOT_FOUND. */
const MACHINE_RECORD_MODULE = 'src/lib/setup/machine-record.js'
const WORKSPACE_MODULE = 'src/lib/setup/workspace.js'

function failure(code, reason) {
  return { ok: false, code, reason }
}

/* WHERE THE PERSON'S DOCUMENTS FOLDER ACTUALLY IS.
 *
 * The engine's defaultWorkspacePath() guesses `%USERPROFILE%\Documents`, and on
 * a OneDrive-redirected machine ("Back up your folders", the consumer Windows 11
 * default) the real known folder is `%USERPROFILE%\OneDrive\Documents` -- so the
 * suggested card named one folder while the Browse dialog (shell/main.cjs, which
 * already asks `app.getPath('documents')`) opened another, and the folder the
 * product created never appeared under Explorer's own "Documents". One answer,
 * asked of the known-folder API, passed into the engine at every call site here.
 *
 * `options.documentsDir` wins when a caller states it (tests; anything without
 * Electron), including an explicit null meaning "no known-folder answer". The
 * require is guarded because this module is loaded by plain-Node tests where
 * Electron is absent -- they keep the engine's own fallback. */
function resolveDocumentsDir(options = {}) {
  if ('documentsDir' in options) return options.documentsDir
  try {
    const { app } = require('electron')
    const documents = app.getPath('documents')
    return typeof documents === 'string' && documents.length > 0 ? documents : null
  } catch {
    return null
  }
}

function suggestedWorkspace(workspace, options = {}) {
  return workspace.defaultWorkspacePath({ documentsDir: resolveDocumentsDir(options) })
}

function loadSetupModules({ root = resolveCapabilityRoot(), load = require } = {}) {
  if (!root) {
    return failure(
      'SETUP_PAYLOAD_ABSENT',
      'No capability payload is present, so this copy has no setup code to record a permission level with.',
    )
  }
  let machineRecord
  let workspace
  try {
    machineRecord = load(path.join(root, MACHINE_RECORD_MODULE))
    workspace = load(path.join(root, WORKSPACE_MODULE))
  } catch (error) {
    return failure(
      'SETUP_MODULES_ABSENT',
      `The capability payload does not carry its setup modules (${error.message}). They are staged by tools/capability-manifest.json under hostModules.`,
    )
  }
  if (!Array.isArray(machineRecord?.TIERS)
    || typeof machineRecord.resolveServicesRoot !== 'function'
    || typeof machineRecord.readMachineRecord !== 'function'
    || typeof machineRecord.buildMachineRecord !== 'function'
    || typeof machineRecord.resolveNodePath !== 'function'
    || typeof machineRecord.defaultMachineId !== 'function'
    || typeof machineRecord.defaultMachineLabel !== 'function'
    || typeof machineRecord.writeMachineRecord !== 'function'
    || typeof machineRecord.writeMcpConfig !== 'function'
    || typeof workspace?.defaultWorkspacePath !== 'function'
    || typeof workspace.checkWorkspaceCandidate !== 'function'
    || typeof workspace.provisionWorkspace !== 'function') {
    return failure('SETUP_MODULES_UNRECOGNIZED', 'The capability payload carries a setup module this shell does not recognize.')
  }
  /* `root` TRAVELS WITH THE MODULES, because the generated assistant
     configuration needs it and deriving it a second time at the point of use is
     how two answers to "where is the engine" get born. See engineRootFor(). */
  return { ok: true, machineRecord, workspace, root }
}

/* Where this install lives. Packaged, process.resourcesPath is
 * <install>/resources, so the install root is its parent. In a checkout it is
 * the repo root. Derived from the same value resolveCapabilityRoot() uses, so
 * the two cannot describe different installations. */
function resolveInstallRoot({ resourcesPath = process.resourcesPath, repoRoot = path.join(__dirname, '..') } = {}) {
  if (typeof resourcesPath === 'string' && resourcesPath) return path.dirname(resourcesPath)
  return path.resolve(repoRoot)
}

/* The Node that runs the servers.
 *
 * process.execPath is the Electron binary, and that IS this installation's
 * Node: shell/capability-layer.cjs already starts the whole capability layer
 * on it under ELECTRON_RUN_AS_NODE, which is the reason no second runtime
 * ships. Recording anything else would name a runtime this install does not
 * carry. Nothing outside src/lib/setup/ reads this field today (checked across
 * the engine tree: only mcsetup.js and setup/plan.js do), so it describes the
 * install rather than driving a spawn.
 */
function resolveRuntimePath({ execPath = process.execPath } = {}) {
  return execPath
}

/**
 * What the app should show before it asks. Never throws: a first-run screen
 * that crashes on a malformed record is a product that cannot be recovered
 * from its own UI.
 */
function readTierState(options = {}) {
  const modules = options.modules || loadSetupModules(options)
  if (!modules.ok) return { ok: true, available: false, code: modules.code, reason: modules.reason, configured: false, tier: null, tiers: [] }

  const { machineRecord } = modules
  const tiers = machineRecord.TIERS.slice()
  let record
  try {
    record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) })
  } catch (error) {
    /* A record that exists and is unreadable is NOT "not set up yet". Saying
     * so would invite the app to overwrite a configuration it could not read,
     * which is exactly what readMachineRecord refuses to do. */
    return {
      ok: true,
      available: true,
      configured: false,
      unreadable: true,
      code: error?.code || 'SETUP_MACHINE_RECORD_UNREADABLE',
      reason: error?.message || 'The recorded configuration could not be read.',
      tier: null,
      tiers,
    }
  }
  if (!record) return { ok: true, available: true, configured: false, tier: null, tiers }
  return { ok: true, available: true, configured: true, tier: record.tier, tiers }
}

/**
 * Record the chosen level.
 *
 * An existing record keeps every field it already has except the tier. The
 * person answering this question again -- "you can change it later" -- is
 * changing one thing, and rebuilding the record from defaults would silently
 * relocate the workspace they chose.
 */
function recordTier(tier, options = {}) {
  const modules = options.modules || loadSetupModules(options)
  if (!modules.ok) return modules

  const { machineRecord, workspace } = modules
  if (!machineRecord.TIERS.includes(tier)) {
    return failure('SETUP_TIER_UNKNOWN', 'That is not one of the permission levels this product offers.')
  }

  const servicesRoot = machineRecord.resolveServicesRoot({})
  let existing = null
  try {
    existing = machineRecord.readMachineRecord({ servicesRoot })
  } catch (error) {
    return failure(error?.code || 'SETUP_MACHINE_RECORD_UNREADABLE', error?.message || 'The recorded configuration could not be read.')
  }

  // Consent and audit admission used the host's earlier snapshot. The audit
  // await can let another request change the tier; refuse that stale write.
  // This comparison and the machine write below are synchronous in this host.
  if (Object.prototype.hasOwnProperty.call(options, 'expectedPreviousTier')
    && (existing ? existing.tier : null) !== options.expectedPreviousTier) {
    return failure('SETUP_TIER_STATE_CHANGED', 'The permission level changed while this choice was being recorded. Read the current level and choose again.')
  }

  let record
  try {
    record = machineRecord.buildMachineRecord({
      ...(existing || {}),
      tier,
      installRoot: existing ? existing.installRoot : resolveInstallRoot(options),
      servicesRoot,
      nodePath: existing ? existing.nodePath : machineRecord.resolveNodePath({ execPath: resolveRuntimePath(options) }),
      workspaceRoots: existing ? existing.workspaceRoots : [suggestedWorkspace(workspace, options)],
      machineId: existing ? existing.machine.id : machineRecord.defaultMachineId(),
      machineLabel: existing ? existing.machine.label : machineRecord.defaultMachineLabel(),
      createdAtMs: existing ? existing.createdAtMs : Date.now(),
    })
  } catch (error) {
    return failure(error?.code || 'SETUP_MACHINE_RECORD_INVALID', error?.message || 'That level could not be recorded.')
  }

  /* THE FOLDER'S PROVENANCE SURVIVES A LEVEL CHANGE. buildMachineRecord
     constructs only the fields the engine's schema names and drops
     `workspaceChosen` (recordWorkspaces explains why the flag rides alongside
     the schema rather than in it). Re-recording the level is "changing one
     thing"; silently forgetting that a person chose their folder would be a
     second thing, and writeAssistantConfig below would then stop writing into a
     folder they did choose. So the flag is carried over exactly as found. */
  const stamped = existing && existing.workspaceChosen === true ? { ...record, workspaceChosen: true } : record
  try {
    machineRecord.writeMachineRecord(stamped, { servicesRoot })
  } catch (error) {
    return failure(error?.code || 'SETUP_MACHINE_RECORD_WRITE_FAILED', 'The permission level could not be saved on this computer.')
  }
  /* BOTH COPIES, ON THE SAME ANSWER. The dispatch root's document is refreshed
     here rather than only at startup because this question is answered DURING a
     run: the capability layer was started before the person chose a level, and
     it is not restarted afterwards. Leaving the refresh to the next launch would
     mean the first agent someone starts -- the one right after setup, which is
     the whole point of the walkthrough -- runs against the fail-closed document
     or none at all.

     It is reported separately from `assistantConfig` and never fails the
     recording, for the same reason that one does not: the level is saved, and
     this is the product configuring itself. */
  const dispatchAssistantConfig = options.dispatchRoot === undefined
    ? null
    : ensureDispatchAssistantConfig({ ...options, modules, record: stamped })
  return {
    ok: true,
    tier: record.tier,
    configured: true,
    assistantConfig: writeAssistantConfig(stamped, modules),
    ...(dispatchAssistantConfig ? { dispatchAssistantConfig } : {}),
  }
}

/**
 * Project the record into the `.mcp.json` an agent client reads.
 *
 * THE RECORD ALONE CONFIGURES NOTHING. tools/mcsetup.js has always written both
 * -- the record AND the generated document (mcsetup.js applyPlan) -- but the app
 * wrote only the record. An installation created through the first-run screen
 * therefore had no `.mcp.json` at all, so the answer to "how much should the
 * assistant be allowed to do" narrowed nothing for any client that reads one.
 * The command-line path and the app path produced different installations from
 * the same answer, and only one of them was configured.
 *
 * A STALE DOCUMENT IS REMOVED RATHER THAN LEFT. The dangerous case is not the
 * absent file, it is the previous one: someone moving `unrestricted` down to
 * `guided` whose old document still names the full surface would have narrowed
 * the record and nothing else, and the file that actually configures their agent
 * client would still grant what they just revoked. If the narrower document
 * cannot be written, the wider one does not get to survive.
 *
 * It never fails the recording. The level is the person's answer and it is
 * already saved; reporting `ok: false` here would tell them their choice did not
 * take when it did. The generation outcome is returned ALONGSIDE so the screen
 * can say what did and did not happen, with a code and no path.
 *
 * THE TARGET DIRECTORY MAY BE STATED, and there are exactly two callers that do
 * anything different with it. Left unstated it is the folder the person chose,
 * which is what their own agent client reads. ensureDispatchAssistantConfig()
 * below states the app's own dispatch root instead, which is what this product's
 * lane launcher reads. One generator, one record, two readers -- see the long
 * note above that function for why both need a copy.
 *
 * LEFT UNSTATED, IT IS WRITTEN ONLY INTO A FOLDER A PERSON CHOSE. The record
 * always names a first workspace root, because buildMachineRecord requires one
 * -- and when nobody has answered the folder question yet, that root is the
 * default setup named by itself (recordTier, failClosedRecord). Until now this
 * function could not tell the two apart: answering the permission question
 * alone created `Documents\AI Workspace` and configured an assistant in it, in
 * a folder the person had never been shown. The record carries the difference
 * -- `workspaceChosen`, stamped by recordWorkspaces when a person was shown the
 * question and answered it -- and this is where it is read. No flag, no write:
 * a typed refusal, nothing created, not even the directory.
 *
 * A STATED TARGET IS THE CALLER'S OWN DIRECTORY and is not gated on the flag:
 * the dispatch root is a directory this product owns and creates on every start,
 * and the fail-closed document written there is what lets a lane start before
 * setup is complete. A stated target that is not a usable path is refused, and
 * never falls back to the person's folder.
 */
function writeAssistantConfig(record, modules, { targetDirectory = null } = {}) {
  const { machineRecord } = modules
  let directory
  if (targetDirectory !== null && targetDirectory !== undefined) {
    if (typeof targetDirectory !== 'string' || targetDirectory.length === 0) {
      return { ok: false, code: 'SETUP_ASSISTANT_CONFIG_NO_WORKSPACE' }
    }
    directory = targetDirectory
  } else {
    directory = Array.isArray(record?.workspaceRoots) ? record.workspaceRoots[0] : null
    if (typeof directory !== 'string' || directory.length === 0) {
      return { ok: false, code: 'SETUP_ASSISTANT_CONFIG_NO_WORKSPACE' }
    }
    if (record.workspaceChosen !== true) {
      return { ok: false, code: 'SETUP_ASSISTANT_CONFIG_NOT_CHOSEN' }
    }
  }
  try {
    fs.mkdirSync(directory, { recursive: true })
  } catch (error) {
    return { ok: false, code: error?.code === 'EACCES' || error?.code === 'EPERM' ? 'SETUP_ASSISTANT_CONFIG_DENIED' : 'SETUP_ASSISTANT_CONFIG_NO_WORKSPACE' }
  }
  /* The person's folder is merged into; the product's own dispatch root keeps
     the plain generated write it has always had. See mergeIntoPersonsDocument. */
  if (targetDirectory === null || targetDirectory === undefined) {
    return mergeIntoPersonsDocument(directory, record, modules)
  }
  try {
    const generated = machineRecord.writeMcpConfig(assistantConfigRecord(record, modules), { targetDirectory: directory })
    return {
      ok: true,
      code: 'SETUP_ASSISTANT_CONFIG_WRITTEN',
      servers: Object.keys(generated.document.mcpServers),
    }
  } catch (error) {
    try { fs.rmSync(path.join(directory, '.mcp.json'), { force: true }) } catch { /* Reported below regardless. */ }
    return { ok: false, code: error?.code || 'SETUP_ASSISTANT_CONFIG_FAILED' }
  }
}


/* ---------- the person's own `.mcp.json`: merged into, never replaced ----------
 *
 * THE DEFECT. The folder a person chooses is THEIR folder, and a `.mcp.json`
 * already in it is usually THEIR file: the agent clients that read it (Claude
 * Code, Cursor and others) keep a person's own project servers there. Setup and
 * every launch-time refresh wrote the generated document over it wholesale --
 * the person's servers gone, no copy kept, nothing said -- and a failed write
 * then removed the file outright. That is the "aggressive write over a user's
 * paths" the owner asked about on 2026-09-22, and it was the one place this
 * product rewrote a file of the person's.
 *
 * THE RULE NOW. ToolsEnabled owns the entries it writes (the catalogue names:
 * toolsenabled-readonly, toolsenabled, playwright) and nothing else in the
 * file. Every other top-level key and every other server stays exactly as the
 * person left it. An entry of ours from a wider level is still withdrawn, so
 * the narrowing rule above holds. A person's own entry that happens to use one
 * of our names is replaced and REPORTED. Whenever the file held anything of the
 * person's and this write changes more than our own entries, the file as it
 * was is first copied beside it as `.mcp.json.toolsenabled-backup` (never over
 * an older copy), and the answer says what changed in plain words, with names
 * and no paths. A file that is not a JSON object is not ours to interpret: it
 * is left byte for byte and the answer says so. A failed write takes back only
 * the entries under ToolsEnabled's names; the person's own entries stay in the
 * file, and a copy of the file as it was is kept first whenever anything of
 * theirs was in it.
 */
const PERSON_DOCUMENT = '.mcp.json'
const PERSON_BACKUP = '.mcp.json.toolsenabled-backup'
const OWN_ENTRY_SCRIPTS = /(?:^|[\\/])(?:mcp-server|playwright-gateway)\.js$/
const OWN_ENTRY_NAMES = Object.freeze(['toolsenabled-readonly', 'toolsenabled', 'playwright'])

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

/* Whether an entry under one of our names carries our own marks: the
   TOOLSENABLED_* environment every generated entry is stamped with, or one of
   the two scripts the generator points at. A person's own server under the same
   name has neither, and replacing it is reported rather than done quietly. */
function carriesOwnMarks(entry) {
  if (!plainObject(entry)) return false
  if (plainObject(entry.env) && Object.keys(entry.env).some(key => /^TOOLSENABLED_/.test(key))) return true
  return Array.isArray(entry.args) && entry.args.some(arg => typeof arg === 'string' && OWN_ENTRY_SCRIPTS.test(arg))
}

function ownEntryNames(generated, modules) {
  const names = new Set(OWN_ENTRY_NAMES)
  for (const name of Object.keys(generated?.document?.mcpServers || {})) names.add(name)
  for (const skipped of Array.isArray(generated?.skipped) ? generated.skipped : []) {
    if (typeof skipped?.name === 'string') names.add(skipped.name)
  }
  const catalogue = modules?.machineRecord?.SERVER_CATALOGUE
  for (const entry of Array.isArray(catalogue) ? catalogue : []) {
    if (typeof entry?.name === 'string') names.add(entry.name)
  }
  return names
}

function writeTextAtomic(file, text, mode) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', ...(mode ? { mode } : {}) })
    fs.renameSync(temporary, file)
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch { /* already renamed */ }
  }
}

/* One copy of the file as the person had it, never over an earlier copy: the
   first backup is the one that still holds what they wrote before ToolsEnabled
   ever touched it. Returns the backup's file NAME (not a path) or throws. */
function keepPersonsCopy(directory, originalText, mode) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? PERSON_BACKUP : `${PERSON_BACKUP}-${attempt + 1}`
    try {
      fs.writeFileSync(path.join(directory, name), originalText, { encoding: 'utf8', flag: 'wx', mode: mode || 0o600 })
      return name
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (fs.readFileSync(path.join(directory, name), 'utf8') === originalText) return name
    }
  }
  throw Object.assign(new Error('No free backup name'), { code: 'SETUP_ASSISTANT_CONFIG_BACKUP_FAILED' })
}

function mergeSentence({ kept, replaced, backup }) {
  const parts = []
  if (kept.length > 0) {
    const names = `${kept.slice(0, 6).join(', ')}${kept.length > 6 ? ', and more' : ''}`
    parts.push(`ToolsEnabled added its entries to the .mcp.json already in that folder and kept your own ${kept.length === 1 ? 'entry' : `${kept.length} entries`} (${names}).`)
  } else {
    parts.push('ToolsEnabled added its entries to the .mcp.json already in that folder and kept the rest of the file as it was.')
  }
  if (replaced.length > 0) {
    parts.push(`Your own ${replaced.length === 1 ? 'entry' : 'entries'} named ${replaced.join(', ')} used a name ToolsEnabled needs, so ${replaced.length === 1 ? 'it was' : 'they were'} replaced.`)
  }
  if (backup) parts.push(`The file as it was is saved beside it as ${backup}.`)
  return parts.join(' ')
}

/* Read what is in the folder now: null when there is no file, the text and
   mode when there is an ordinary file, or a refusal. */
function readPersonsDocument(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) {
      return { refusal: { ok: false, code: 'SETUP_ASSISTANT_CONFIG_PERSON_FILE_UNREADABLE',
        reason: 'The .mcp.json in that folder is not an ordinary file, so ToolsEnabled left it exactly as it was.' } }
    }
    return { text: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 }
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: null, mode: null }
    return { refusal: { ok: false, code: error?.code === 'EACCES' || error?.code === 'EPERM' ? 'SETUP_ASSISTANT_CONFIG_DENIED' : 'SETUP_ASSISTANT_CONFIG_FAILED' } }
  }
}

function parsePersonsDocument(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  if (!plainObject(parsed) || (Object.hasOwn(parsed, 'mcpServers') && !plainObject(parsed.mcpServers))) return null
  return parsed
}

function mergeIntoPersonsDocument(directory, record, modules) {
  const { machineRecord } = modules
  const file = path.join(directory, PERSON_DOCUMENT)
  const found = readPersonsDocument(file)
  if (found.refusal) return found.refusal
  const originalText = found.text
  const existing = originalText === null ? null : parsePersonsDocument(originalText)
  if (originalText !== null && existing === null) {
    return { ok: false, code: 'SETUP_ASSISTANT_CONFIG_PERSON_FILE_UNREADABLE',
      reason: 'The .mcp.json already in that folder is not a settings file ToolsEnabled can read, so it was left exactly as it was. Move it aside or fix it, then press Finish setup again.' }
  }

  /* The generated document. The payload generates it without touching the
     folder; a module that can only write (a test double) writes it into the
     folder, and the person's original, held above, is merged back over that. */
  const input = assistantConfigRecord(record, modules)
  let generated
  try {
    generated = typeof machineRecord.generateMcpConfig === 'function'
      ? machineRecord.generateMcpConfig(input)
      : machineRecord.writeMcpConfig(input, { targetDirectory: directory })
  } catch (error) {
    /* The narrower document could not be made, so ours must not outlive it --
       but only ours. The person's own entries stay, as they were. */
    try { restoreWithoutOwnEntries(directory, file, originalText, existing, found.mode, modules) } catch { /* reported below regardless */ }
    return { ok: false, code: error?.code || 'SETUP_ASSISTANT_CONFIG_FAILED' }
  }
  const servers = Object.keys(generated.document.mcpServers)

  if (existing === null) {
    if (typeof machineRecord.generateMcpConfig === 'function') {
      try {
        writeTextAtomic(file, `${JSON.stringify(generated.document, null, 2)}\n`)
      } catch (error) {
        try { fs.rmSync(file, { force: true }) } catch { /* reported below */ }
        return { ok: false, code: error?.code || 'SETUP_ASSISTANT_CONFIG_FAILED' }
      }
    }
    return { ok: true, code: 'SETUP_ASSISTANT_CONFIG_WRITTEN', servers }
  }

  const ours = ownEntryNames(generated, modules)
  const existingServers = plainObject(existing.mcpServers) ? existing.mcpServers : {}
  const mergedServers = {}
  const kept = []
  const replaced = []
  for (const [name, entry] of Object.entries(existingServers)) {
    if (ours.has(name)) {
      if (!carriesOwnMarks(entry)) replaced.push(name)
      continue
    }
    mergedServers[name] = entry
    kept.push(name)
  }
  for (const [name, entry] of Object.entries(generated.document.mcpServers)) mergedServers[name] = entry
  const merged = { ...existing, mcpServers: mergedServers }
  const mergedText = `${JSON.stringify(merged, null, 2)}\n`
  const personsContent = kept.length > 0 || replaced.length > 0 || Object.keys(existing).some(key => key !== 'mcpServers')
  const firstMerge = !Object.entries(existingServers).some(([name, entry]) => ours.has(name) && carriesOwnMarks(entry))

  /* A copy is kept when the person's content is in the file and this write is
     more than ToolsEnabled refreshing its own entries: the first merge into a
     file of theirs, or one of their entries replaced. Refreshing only our own
     entries on a later launch changes nothing of theirs and leaves no litter. */
  let backup = null
  if (personsContent && (firstMerge || replaced.length > 0) && mergedText !== originalText) {
    try {
      backup = keepPersonsCopy(directory, originalText, found.mode)
    } catch {
      if (typeof machineRecord.generateMcpConfig !== 'function') {
        try { writeTextAtomic(file, originalText, found.mode) } catch { /* reported below */ }
      }
      return { ok: false, code: 'SETUP_ASSISTANT_CONFIG_BACKUP_FAILED',
        reason: 'ToolsEnabled could not save a copy of the .mcp.json already in that folder, so it did not change it.' }
    }
  }
  try {
    const current = fs.readFileSync(file, 'utf8')
    if (current !== mergedText) writeTextAtomic(file, mergedText, found.mode)
  } catch (error) {
    /* The rename never happened, so the file is what it was (or, behind a
       writer-only module, its original is restored). Nothing is removed. */
    if (typeof machineRecord.generateMcpConfig !== 'function') {
      try { writeTextAtomic(file, originalText, found.mode) } catch { /* reported below */ }
    }
    return { ok: false, code: error?.code || 'SETUP_ASSISTANT_CONFIG_FAILED' }
  }
  if (!personsContent) return { ok: true, code: 'SETUP_ASSISTANT_CONFIG_WRITTEN', servers }
  const reported = firstMerge || replaced.length > 0
  return {
    ok: true,
    code: 'SETUP_ASSISTANT_CONFIG_MERGED',
    servers,
    merged: {
      kept: kept.length,
      keptNames: kept.slice(0, 20),
      replaced: replaced.slice(0, 20),
      backup,
      reason: reported ? mergeSentence({ kept, replaced, backup }) : null,
    },
  }
}

/* After a failed generation the narrower document could not be made, so no
   entry under one of ToolsEnabled's names may keep granting the wider one --
   whether or not it carries our marks, because a stale entry from an older
   build may not. Entries under other names and every other key stay. If
   anything of the person's was in the file (their own servers, their own
   settings, or an entry of theirs under one of our names), a copy of the file
   as it was is kept first. A file with nothing left in it is removed, which is
   the narrowing rule above; a file with nothing of ours in it is not touched. */
function restoreWithoutOwnEntries(directory, file, originalText, existing, mode, modules) {
  if (originalText === null) {
    fs.rmSync(file, { force: true })
    return
  }
  if (existing === null) return
  const ours = ownEntryNames(null, modules)
  const servers = plainObject(existing.mcpServers) ? existing.mcpServers : {}
  const remaining = Object.fromEntries(Object.entries(servers).filter(([name]) => !ours.has(name)))
  if (Object.keys(remaining).length === Object.keys(servers).length) return
  const othersRemain = Object.keys(remaining).length > 0 || Object.keys(existing).some(key => key !== 'mcpServers')
  const personsUnderOurNames = Object.entries(servers).some(([name, entry]) => ours.has(name) && !carriesOwnMarks(entry))
  if (othersRemain || personsUnderOurNames) keepPersonsCopy(directory, originalText, mode)
  if (!othersRemain) {
    fs.rmSync(file, { force: true })
    return
  }
  writeTextAtomic(file, `${JSON.stringify({ ...existing, mcpServers: remaining }, null, 2)}\n`, mode)
}

/**
 * The record the GENERATOR is given, which is not the record on disk.
 *
 * ONE FIELD DIFFERS, AND WITHOUT IT THE DOCUMENT IS EMPTY ON EVERY PACKAGED
 * INSTALL. generateMcpConfig() resolves each server as
 * `path.join(record.installRoot, 'src/mcp-server.js')` and OMITS any server
 * whose script is not on disk -- deliberately, so a client is never told about
 * a server that cannot start. `installRoot` is recorded by resolveInstallRoot()
 * below as the directory the application was installed into, because that is
 * what the OTHER reader of the field needs: workspace.checkWorkspaceCandidate()
 * refuses a workspace folder inside the installation, and that refusal is about
 * the whole install directory. But the engine does not live at the top of that
 * directory in a packaged build -- it is an extraResource under
 * `resources\capability` -- so the generator looked for `<install>\src\
 * mcp-server.js`, found nothing, and skipped all three servers.
 *
 * MEASURED ON THIS MACHINE'S OWN INSTALLATION, 2026-08-12, not deduced: the
 * recorded installRoot named `...\Programs\toolsenabled`, `src/mcp-server.js`
 * was absent from it, and the `.mcp.json` in the person's chosen folder read
 *     {"mcpServers": {}}
 * -- a configured assistant with no tools at all, which is the product.
 *
 * So the generator is handed the ENGINE root: the same payload directory the
 * capability layer is started from, which is where `src/mcp-server.js` actually
 * is in both a packaged install and a checkout. Two fields ride on it, and both
 * want the engine rather than the installation: the `args` entry that names the
 * server program, and the `cwd` the server runs in.
 *
 * THE RECORD ON DISK IS NOT REWRITTEN. It keeps saying what it has always said
 * about where this copy is installed, because the workspace check reads it and
 * means something different by it. The substitution happens here, at the one
 * point where the field means "where the engine is", and nowhere else.
 *
 * A SECOND FIELD NOW MOVES WITH IT, FOR THE SAME REASON AND WITH THE SAME
 * RESTRAINT. `nodePath` is written once, by whichever INSTALLATION happened to
 * run setup, and generateMcpConfig only ever checked that the path still exists
 * -- never that it is the build now running. So a person who installed an
 * update, or who has two copies, kept a `.mcp.json` naming the OLD executable
 * forever. That is the whole of "the second window looks outdated": it was the
 * older installed build, started faithfully from a record written months ago.
 *
 * MEASURED ON THIS MACHINE'S OWN INSTALLATION, 2026-08-18: the live
 * `<userData>\workspace\.mcp.json` named
 *     "command": "<localappdata>\\Programs\\toolsenabled\\ToolsEnabled.exe"
 * for all three servers, and the record it came from had been sealed on a
 * different day from a different copy.
 *
 * `process.execPath` is true by construction on every machine and cannot go
 * stale on any of them, which is exactly the argument resolveNodePath() already
 * makes for using it at setup time; the only correction here is WHEN it is
 * asked. Packaged, that value is this application's own binary -- which is why
 * generateMcpConfig also stamps ELECTRON_RUN_AS_NODE on every entry it writes,
 * without which the same executable ignores the script argument and starts the
 * whole application instead of a server.
 */
function assistantConfigRecord(record, modules) {
  const engineRoot = typeof modules?.root === 'string' && modules.root.length > 0 ? modules.root : null
  const substituted = { ...record, nodePath: process.execPath }
  return engineRoot ? { ...substituted, installRoot: engineRoot } : substituted
}

/* ---------- the configuration the DISPATCH root needs ----------
 *
 * WHAT WAS BROKEN, AND WHY NO SOURCE TEST COULD SEE IT.
 *
 * A Claude lane started by the mission bridge is launched with
 *     --mcp-config <root>\.mcp.json --strict-mcp-config
 * where `<root>` is the dispatch root the shell declares to the capability
 * layer -- `<userData>\workspace` (WORKSPACE_ROOT in shell/main.cjs, handed over
 * as `--root main=...` in shell/capability-layer.cjs). Nothing has ever written
 * a `.mcp.json` there. The only writer in the product is writeAssistantConfig()
 * above, and it writes into `workspaceRoots[0]` -- the folder the PERSON chose,
 * which is a different directory and is deliberately so.
 *
 * MEASURED ON THIS MACHINE, 2026-08-12: `<userData>\workspace` existed and was
 * EMPTY; `<profile>\Documents\AI Workspace\.mcp.json` existed. The two halves of
 * the product disagreed about where an agent's configuration lives, and the half
 * that launches agents was pointed at the empty one.
 *
 * `--strict-mcp-config` WITH A MISSING FILE IS NOT "NO TOOLS". IT IS NO AGENT.
 * Measured against the installed Claude Code 2.1.186 rather than assumed:
 *     --mcp-config <missing>          -> Error: Invalid MCP configuration:
 *                                        MCP config file not found  (exit 1)
 *     --mcp-config <file with {}>     -> starts; refuses only the empty prompt
 * So the lane did not start "with zero ToolsEnabled tools"; it exited before it
 * ran at all, and the person saw BRIDGE_AGENT_LANE_START_FAILED.
 *
 * WHY THE FILE MOVED TO THE DISPATCH ROOT RATHER THAN THE ROOT MOVING TO THE
 * FILE. Handing the bridge the person's chosen folder instead was the other
 * candidate and it is worse in three separate ways. The folder can be answered
 * AFTER the layer has started, and the layer is started once per launch with a
 * root it cannot be told to change -- so the bridge would dispatch into a folder
 * the person had already moved away from. Before the folder question is answered
 * there is no chosen folder at all, and the default one is deliberately NOT
 * created until somebody says yes (see recordWorkspaces below).
 * And `<userData>\workspace` is the one directory this product owns, creates on
 * every start, and can rely on being a real directory on a customer's machine --
 * which the asar-as-cwd history in shell/main.cjs paid for once already.
 *
 * SO BOTH DIRECTORIES GET THE DOCUMENT, and they are not the same thing. The
 * person's folder gets it because their own agent client reads it there. The
 * dispatch root gets it because the product's own lane launcher reads it there.
 * The document is generated from the record and not from the directory, so the
 * two copies cannot describe different permission levels.
 */
function ensureDispatchAssistantConfig(options = {}) {
  const dispatchRoot = options.dispatchRoot
  if (typeof dispatchRoot !== 'string' || dispatchRoot.length === 0) {
    return { ok: false, code: 'SETUP_DISPATCH_ROOT_ABSENT' }
  }
  const modules = options.modules || loadSetupModules(options)
  if (!modules.ok) return { ok: false, code: modules.code }

  let record = options.record
  if (record === undefined) {
    const { machineRecord } = modules
    try {
      record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) })
    } catch {
      /* A record that EXISTS and cannot be read is the fail-closed case below,
         not a reason to leave the lane unlaunchable. readMachineRecord refuses a
         record whose integrity seal does not match, and that state is reachable
         today -- so "unreadable" must still produce a runnable, minimal
         configuration rather than nothing at all. */
      record = null
    }
  }
  return writeAssistantConfig(record || failClosedRecord(modules, options), modules, { targetDirectory: dispatchRoot })
}

/**
 * Rewrite the document in the person's OWN folder, on launch, from this build.
 *
 * WHY A LAUNCH-TIME REWRITE IS NEEDED AT ALL, given that recordTier already
 * writes this file. The document names an executable and an engine directory,
 * and both of those belong to the COPY THAT WROTE IT. Setup runs once; the
 * application is then updated, moved, or installed a second time, and nothing
 * has ever revisited the file. The dispatch root's copy is already refreshed on
 * every launch (see the call in shell/main.cjs); the person's copy -- the one
 * their own agent client actually reads -- was the half that went stale, and it
 * is the half that produced a second, older application window every time they
 * started an agent.
 *
 * IT CREATES NOTHING. Refreshed only where a document ALREADY exists, so the
 * deliberate rule that the default folder is not provisioned until somebody says
 * yes (recordWorkspaces below) is untouched, and a person who has
 * not answered the folder question still has nothing written anywhere near it.
 *
 * AND IT REWRITES ONLY A FOLDER A PERSON CHOSE. An existing document is not
 * consent: a record whose first root nobody answered for (`workspaceChosen`
 * absent) is refused with SETUP_ASSISTANT_CONFIG_NOT_CHOSEN and the file is left
 * byte for byte as it was, by the same gate writeAssistantConfig applies to
 * every unstated target. The existence check stays in front of it on purpose:
 * the common unanswered case (no document) keeps reporting ABSENT, which the
 * launch path in shell/main.cjs already treats as nothing to say.
 *
 * IT NEVER FAILS A LAUNCH. Same rule as its sibling: a window that opens and
 * honestly reports a broken configuration is better than no window.
 */
function refreshChosenAssistantConfig(options = {}) {
  const modules = options.modules || loadSetupModules(options)
  if (!modules.ok) return { ok: false, code: modules.code }

  const { machineRecord } = modules
  let record = options.record
  if (record === undefined) {
    try {
      record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) })
    } catch {
      record = null
    }
  }
  /* No record means setup has not been completed, and an unanswered folder
     question has no folder to refresh. The fail-closed record used by the
     dispatch root is deliberately NOT used here: it names a default folder
     nobody has chosen, and writing into it would provision it. */
  if (!record) return { ok: false, code: 'SETUP_ASSISTANT_CONFIG_NOT_RECORDED' }
  const directory = Array.isArray(record.workspaceRoots) ? record.workspaceRoots[0] : null
  if (typeof directory !== 'string' || directory.length === 0) {
    return { ok: false, code: 'SETUP_ASSISTANT_CONFIG_NO_WORKSPACE' }
  }
  if (!fs.existsSync(path.join(directory, '.mcp.json'))) {
    return { ok: false, code: 'SETUP_ASSISTANT_CONFIG_ABSENT' }
  }
  /* The target is deliberately NOT stated: left unstated, writeAssistantConfig
     writes only into a folder the record says a person chose. A document that
     merely exists in the first root is not proof anyone chose that folder.
     Measured 2026-08-22: the machine record lives in %LOCALAPPDATA%\ToolsEnabled,
     not in the Electron profile, so every build launched with this machine's
     LOCALAPPDATA inherited (a packaged smoke run with a fresh --user-data-dir, a
     Playwright harness) read the builder's record, found the workspace
     `.mcp.json` it named, and repointed it at itself. tools/smoke-packaged.mjs
     is now isolated on its side; this is the rule on this side. */
  return writeAssistantConfig(record, modules)
}

/**
 * The record used when this computer has not answered the level question yet.
 *
 * IT IS BUILT AND NEVER WRITTEN. Nothing on disk changes: this exists only to
 * generate the document the dispatch root needs, because the alternative --
 * leaving the file absent until somebody completes setup -- means a lane that
 * cannot start at all, with a refusal that says nothing about setup.
 *
 * IT IS ALWAYS THE MOST RESTRICTIVE LEVEL, and that is what makes it safe to
 * write something nobody has consented to. The engine already makes exactly this
 * assumption on exactly this path: recordedPermissionSession() in the mission
 * bridge falls back to the fail-closed tier when the record is absent or
 * unreadable, and dispatches with that level's flags. Writing a document for any
 * other level would put the configuration and the enforced session into
 * disagreement; writing the fail-closed one keeps them saying the same thing.
 *
 * The level a person then chooses REPLACES this, both here and in their folder,
 * because recordTier rewrites both copies.
 */
function failClosedRecord(modules, options = {}) {
  const { machineRecord, workspace } = modules
  const tiers = Array.isArray(machineRecord.TIERS) ? machineRecord.TIERS : []
  /* The first entry, not a name typed here. src/lib/permission-tier-policy.js
     owns the vocabulary and orders it from the most restrictive level upwards;
     a literal 'guided' in this file would be a second declaration of that order
     which nothing keeps in step with the first. */
  const tier = tiers[0]
  return machineRecord.buildMachineRecord({
    tier,
    installRoot: resolveInstallRoot(options),
    servicesRoot: machineRecord.resolveServicesRoot({}),
    nodePath: machineRecord.resolveNodePath({ execPath: resolveRuntimePath(options) }),
    /* NAMED, NOT CREATED. buildMachineRecord requires a workspace root and this
       record is never written, so naming the default here provisions nothing --
       the folder question is still unanswered and the folder still does not
       exist. The generated document does not depend on this value. */
    workspaceRoots: [suggestedWorkspace(workspace, options)],
    machineId: machineRecord.defaultMachineId(),
    machineLabel: machineRecord.defaultMachineLabel(),
    createdAtMs: Date.now(),
  })
}

/* ---------- the workspace question (design section 3, step 7) ---------- */

const MAX_WORKSPACE_ROOTS = 8

/**
 * What the workspace step should show before it asks.
 *
 * Never throws, for the same reason readTierState does not: a walkthrough that
 * crashes on a malformed record is a product that cannot be recovered from its
 * own first screen. Every unknown collapses to `available: false` with a code and
 * a reason, and the screen states that instead of offering a button that fails.
 */
function readWorkspaceState(options = {}) {
  const modules = options.modules || loadSetupModules(options)
  if (!modules.ok) {
    return { ok: true, available: false, code: modules.code, reason: modules.reason, roots: [], suggested: null }
  }
  const { machineRecord, workspace } = modules
  let suggested = null
  try { suggested = suggestedWorkspace(workspace, options) } catch { suggested = null }

  let record
  try {
    record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) })
  } catch (error) {
    return {
      ok: true,
      available: false,
      code: error?.code || 'SETUP_MACHINE_RECORD_UNREADABLE',
      reason: error?.message || 'The recorded configuration could not be read.',
      roots: [],
      suggested,
    }
  }
  /* No record means the permission level has not been answered yet. The
     workspace cannot be recorded before it, because the level decides which
     folders are refused -- so this reports "not yet", not an error. */
  if (!record) {
    return { ok: true, available: true, configured: false, tier: null, roots: [], suggested, recorded: false }
  }
  return {
    ok: true,
    available: true,
    configured: true,
    tier: record.tier,
    roots: Array.isArray(record.workspaceRoots) ? record.workspaceRoots.slice() : [],
    suggested,
    /* True only once the person has been shown the question and answered it.
       A record whose roots are exactly the suggested default and which was never
       asked is reported as `chosen: false`, so the walkthrough can tell "they
       picked this" from "nobody ever asked". */
    chosen: Boolean(record.workspaceChosen),
    recorded: true,
  }
}

/**
 * Would this folder be allowed, and if not, why in words the person can act on?
 *
 * The check is `src/lib/setup/workspace.js` out of the payload -- the same
 * refusals `tools/mcsetup.js` applies -- rather than a second opinion written
 * here. The install root it needs is main-process knowledge, which is why this
 * cannot live in the renderer.
 */
function checkWorkspace(candidate, options = {}) {
  const modules = options.modules || loadSetupModules(options)
  if (!modules.ok) return { ok: false, code: modules.code, reason: modules.reason }

  const { machineRecord, workspace } = modules
  let tier = 'guided'
  try {
    const record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) })
    /* An unreadable or absent record leaves `guided`, the STRICTEST setting for
       this check: it applies the inside-the-installation refusal that
       `unrestricted` is allowed to waive. Defaulting the other way would waive a
       refusal because a file could not be read. */
    if (record && typeof record.tier === 'string') tier = record.tier
  } catch { /* keep guided */ }

  const verdict = workspace.checkWorkspaceCandidate(candidate, { installRoot: resolveInstallRoot(options), tier })
  if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.message, resolved: verdict.resolved || null }
  return { ok: true, resolved: verdict.resolved }
}

/**
 * Record the folders, having created them and given them a history.
 *
 * EVERY ROOT IS CHECKED BEFORE ANY IS CREATED. A list where the third entry is
 * refused must not leave two new folders on someone's disk and no record, so the
 * refusal happens over the whole list first.
 *
 * The record keeps every other field it already has. Someone changing the folder
 * later is changing one thing, and rebuilding from defaults would silently move
 * the permission level they chose.
 */
function recordWorkspaces(roots, options = {}) {
  const modules = options.modules || loadSetupModules(options)
  if (!modules.ok) return modules

  const { machineRecord, workspace } = modules
  if (!Array.isArray(roots) || roots.length === 0) {
    return failure('SETUP_WORKSPACE_MISSING', 'Choose a folder for your assistant to work in.')
  }
  if (roots.length > MAX_WORKSPACE_ROOTS) {
    return failure('SETUP_WORKSPACE_TOO_MANY', `Setup records at most ${MAX_WORKSPACE_ROOTS} folders.`)
  }

  const servicesRoot = machineRecord.resolveServicesRoot({})
  let existing = null
  try {
    existing = machineRecord.readMachineRecord({ servicesRoot })
  } catch (error) {
    return failure(error?.code || 'SETUP_MACHINE_RECORD_UNREADABLE', error?.message || 'The recorded configuration could not be read.')
  }
  /* The permission level decides which folders are refused, so it has to exist
     before a folder can be recorded against it. In the walkthrough it always
     does -- the level is the screen before this one. */
  if (!existing) {
    return failure('SETUP_TIER_NOT_RECORDED', 'Choose a permission level first; it decides which folders can be used.')
  }

  const installRoot = existing.installRoot || resolveInstallRoot(options)
  const checked = []
  for (const candidate of roots) {
    const verdict = workspace.checkWorkspaceCandidate(candidate, { installRoot, tier: existing.tier })
    if (!verdict.ok) {
      return { ok: false, code: verdict.code, reason: verdict.message, resolved: verdict.resolved || null }
    }
    if (!checked.includes(verdict.resolved)) checked.push(verdict.resolved)
  }

  const provisioned = []
  for (const resolved of checked) {
    let result
    try {
      result = workspace.provisionWorkspace(resolved, { installRoot, tier: existing.tier })
    } catch (error) {
      return failure(error?.code || 'SETUP_WORKSPACE_UNAVAILABLE', error?.message || 'That folder could not be prepared.')
    }
    provisioned.push({
      workspace: result.workspace,
      created: Boolean(result.created),
      undoAvailable: Boolean(result.undoAvailable),
      undoUnavailableReason: result.undoUnavailableReason || null,
    })
  }

  let record
  try {
    record = machineRecord.buildMachineRecord({
      ...existing,
      workspaceRoots: checked,
      machineId: existing.machine.id,
      machineLabel: existing.machine.label,
    })
  } catch (error) {
    return failure(error?.code || 'SETUP_MACHINE_RECORD_INVALID', error?.message || 'Those folders could not be recorded.')
  }

  /* `workspaceChosen` rides ALONGSIDE the validated record rather than through
     buildMachineRecord, which constructs only the fields it knows and would drop
     it. validateMachineRecord accepts additional keys, and readMachineRecord
     validates rather than rewrites, so the flag survives a round trip while the
     engine's own schema stays exactly what src/lib/setup/machine-record.js says
     it is. It is one boolean and it means "a person was shown this question and
     answered it", which is the difference between a chosen folder and a default
     nobody saw. */
  const stamped = { ...record, workspaceChosen: true }
  try {
    machineRecord.writeMachineRecord(stamped, { servicesRoot })
  } catch (error) {
    return failure(error?.code || 'SETUP_MACHINE_RECORD_WRITE_FAILED', 'Those folders could not be saved on this computer.')
  }

  /* Configure only the folder the person selected. An earlier record can name
     the suggested Documents folder before anyone chose it. That path can hold
     a configuration owned by another install or another assistant; its name
     and an absent workspaceChosen flag do not prove we created it. Changing
     the selected folder therefore never removes or rewrites the old folder's
     configuration. Keep releasedRoots for callers of the existing reply. */
  const assistantConfig = writeAssistantConfig(stamped, modules)
  return { ok: true, roots: checked, provisioned, assistantConfig, releasedRoots: [] }
}

module.exports = {
  MACHINE_RECORD_MODULE,
  WORKSPACE_MODULE,
  MAX_WORKSPACE_ROOTS,
  loadSetupModules,
  readTierState,
  recordTier,
  ensureDispatchAssistantConfig,
  refreshChosenAssistantConfig,
  writeAssistantConfig,
  assistantConfigRecord,
  readWorkspaceState,
  checkWorkspace,
  recordWorkspaces,
  resolveInstallRoot,
  resolveRuntimePath,
}
