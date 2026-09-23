'use strict'
// Native qualification only. Every caller must explicitly name an isolated
// scratch boundary; this helper has no installation or owner-state fallback.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const MODES = ['missing-key', 'unreadable-key', 'invalid-key', 'invalid-head', 'invalid-history', 'opaque-history', 'malformed-wal']
const FIXTURE_KEY = 'audit_repair_unrelated_fixture'
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
// Failure diagnostics must survive cleanup without copying encrypted records
// or reading their contents. Inspect only named fixture paths, stopping before
// descendants of a link or an inaccessible/missing ancestor.
function custodyMetadata(scratchRoot) {
  if (typeof scratchRoot !== 'string' || !path.isAbsolute(scratchRoot)) throw new Error('An absolute disposable scratch root is required.')
  const rows = new Map()
  const inspect = file => {
    const absolute = path.resolve(file)
    let current = path.parse(absolute).root
    for (const part of ['', ...absolute.slice(current.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part)
      if (!rows.has(current)) {
        try {
          const info = fs.lstatSync(current)
          rows.set(current, { path: current, type: info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
            uid: info.uid, gid: info.gid, mode: (info.mode & 0o7777).toString(8), links: info.nlink, device: info.dev, inode: info.ino })
        } catch (error) { rows.set(current, { path: current, code: error.code || 'STAT_FAILED' }) }
      }
      if (rows.get(current).type !== 'directory') break
    }
  }
  for (const relative of ['.', 'profile/capability/vault/secrets.json', 'profile/capability/vault/secrets.json.lock']) inspect(path.join(scratchRoot, relative))
  return [...rows.values()]
}
function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function prepare({ stateRoot, scratchRoot, engineRoot = process.env.MC_SETTINGS_ENGINE_ROOT } = {}) {
  if (![stateRoot, scratchRoot, engineRoot].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Explicit absolute engine, state, and scratch roots are required.')
  stateRoot = path.resolve(stateRoot); scratchRoot = path.resolve(scratchRoot)
  if (!within(scratchRoot, stateRoot) || path.dirname(scratchRoot) === scratchRoot) throw new Error('The state root must be inside the explicit disposable scratch boundary.')
  if (!fs.existsSync(stateRoot)) throw new Error('Create the isolated state directory or finish Setup in the disposable app first.')
  for (let current = stateRoot; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Fixture paths must not contain links.')
    if (current === scratchRoot) break
  }
  const engine = createRequire(path.join(engineRoot, 'package.json'))
  process.env.TOOLSENABLED_TEST_ISOLATED = '1'
  process.env.TOOLSENABLED_TEST_ROOT = scratchRoot
  process.env.LOCALAPPDATA = path.join(scratchRoot, 'local-app-data')
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot
  for (const [name, relative] of Object.entries({ TOOLSENABLED_AUDIT_DB: 'state/audit.sqlite3', TOOLSENABLED_AUDIT_JSONL_PATH: 'logs/actions.jsonl',
    TOOLSENABLED_AUDIT_TEXT_PATH: 'logs/actions.log', TOOLSENABLED_AUDIT_EMERGENCY_PATH: 'logs/audit-emergency.jsonl', TOOLSENABLED_VAULT_PATH: 'vault/secrets.json',
    TOOLSENABLED_OWNER_LEDGER_FILE: 'reports/OWNER-REQUEST-LEDGER.json', TOOLSENABLED_ACTIVE_REQUEST_PATH: 'state/active-request.json' })) process.env[name] = path.join(stateRoot, relative)
  if (process.platform === 'win32') seedSigningKey(stateRoot)
  return { engine, stateRoot, scratchRoot, metadata: path.join(scratchRoot, 'audit-repair-fixture.json'),
    runtime: engine('./src/lib/runtime.js'), audit: engine('./src/lib/audit.js'), maintenance: engine('./src/lib/audit-identity-maintenance.js') }
}
// Every scenario used to bootstrap its own signing key from nothing: a fresh
// vault has no SIGNING_VAULT_KEY, so the first real write went through
// runtime's getOrCreateSecret, a cold powershell.exe/DPAPI round trip that
// also creates the vault container, its lock, and its ACLs for the first
// time. That specific cold-bootstrap spawn is the one that goes missing
// under load; every OTHER vault operation here (adding a key to a container
// that already exists) is the same op every real install performs
// constantly and is not what T310 found broken. Pre-seeding just the key --
// generated once, for real, via tools/test/lib/generate-audit-native-seed-vault.mjs,
// never the owner's vault -- removes that one fragile spawn from all 14
// scenarios while every other operation (the fixture write, the anchor's own
// first-write establishment, every tamper/repair/recover call) still goes
// through the real, unmocked vault backend exactly as before.
function seedSigningKey(stateRoot) {
  const vaultFile = path.join(stateRoot, 'vault', 'secrets.json')
  if (fs.existsSync(vaultFile)) return
  const seed = require('./fixtures/audit-native-seed-vault.json')
  fs.mkdirSync(path.dirname(vaultFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(vaultFile, `${JSON.stringify(seed)}\n`, { mode: 0o600 })
}
function vaultRecords(context) {
  const container = JSON.parse(fs.readFileSync(context.runtime.vaultFilePath(), 'utf8').replace(/^\uFEFF/, ''))
  return { container, records: process.platform === 'linux' ? container.records : container }
}
function unrelated(context) {
  return Object.fromEntries(Object.entries(vaultRecords(context).records)
    .filter(([key]) => ![context.audit.SIGNING_VAULT_KEY, context.audit.HEAD_VAULT_KEY].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, digest(value)]))
}
function writeContainer(context, container) {
  fs.writeFileSync(context.runtime.vaultFilePath(), `${JSON.stringify(container)}\n`, { mode: 0o600 })
  context.runtime.invalidateSecretValueCache()
}
async function tamper(context, mode) {
  if (!MODES.includes(mode)) throw new Error('Choose a supported disposable damage mode.')
  await context.audit.close()
  if (mode === 'missing-key' || mode === 'unreadable-key' || mode === 'malformed-wal') {
    const { container, records } = vaultRecords(context)
    if (mode !== 'unreadable-key') delete records[context.audit.SIGNING_VAULT_KEY]
    else records[context.audit.SIGNING_VAULT_KEY] = 'invalid-ciphertext-disposable-fixture'
    writeContainer(context, container)
    if (mode === 'malformed-wal') fs.writeFileSync(`${process.env.TOOLSENABLED_AUDIT_DB}-wal`, 'OWNED_MALFORMED_WAL_DISPOSABLE_REPAIR_FIXTURE\n', { mode: 0o600 })
  } else if (mode === 'invalid-key' || mode === 'invalid-head') {
    context.runtime.setSecret(mode === 'invalid-key' ? context.audit.SIGNING_VAULT_KEY : context.audit.HEAD_VAULT_KEY, 'invalid-plaintext-disposable-fixture')
    await context.audit.close()
  } else if (mode === 'opaque-history') {
    fs.writeFileSync(process.env.TOOLSENABLED_AUDIT_DB, 'unreadable disposable audit database\n')
  } else {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.env.TOOLSENABLED_AUDIT_DB)
    try { db.prepare('UPDATE audit_events SET signature = ? WHERE sequence = (SELECT min(sequence) FROM audit_events)').run(Buffer.alloc(64, 7).toString('base64')) }
    finally { db.close() }
  }
  return context.maintenance.probe({ stateRoot: context.stateRoot })
}
async function seed(context, mode) {
  if (fs.existsSync(context.metadata)) throw new Error('This scratch fixture was already seeded.')
  context.runtime.setSecret(FIXTURE_KEY, 'benign disposable record; no payment or provider credential')
  const receipt = context.audit.requireRecord('audit.repair.fixture', 'disposable', { purpose: 'Native Settings repair qualification.' })
  if (!receipt.durable || !receipt.anchored) throw new Error('The native fixture seed was not anchored.')
  await context.audit.close()
  const baseline = { version: 1, stateRoot: context.stateRoot, mode, unrelated: unrelated(context), seedSequence: receipt.sequence }
  fs.writeFileSync(context.metadata, `${JSON.stringify(baseline)}\n`, { flag: 'wx', mode: 0o600 })
  const probe = await tamper(context, mode)
  if (mode === 'malformed-wal') {
    const file = `${process.env.TOOLSENABLED_AUDIT_DB}-wal`
    const bytes = fs.readFileSync(file)
    baseline.unverifiedWal = { relative: path.relative(context.stateRoot, file), size: bytes.length, sha256: digest(bytes) }
    fs.writeFileSync(context.metadata, `${JSON.stringify(baseline)}\n`, { mode: 0o600 })
  }
  return { ok: probe.canRepair === true, mode, fixtureKey: FIXTURE_KEY, seedSequence: receipt.sequence, probe, unrelatedCiphertextPreserved: JSON.stringify(unrelated(context)) === JSON.stringify(baseline.unrelated) }
}
async function verify(context) {
  const baseline = JSON.parse(fs.readFileSync(context.metadata, 'utf8'))
  if (baseline.stateRoot !== context.stateRoot) throw new Error('The fixture receipt belongs to another state root.')
  const preserved = JSON.stringify(unrelated(context)) === JSON.stringify(baseline.unrelated)
  const probe = context.maintenance.probe({ stateRoot: context.stateRoot })
  const events = context.engine('./src/lib/audit-store.js').withReadOnlyLedger(process.env.TOOLSENABLED_AUDIT_DB, store => store.verify().events)
  const first = events[0]?.event
  let originalWalPreserved = null
  if (baseline.unverifiedWal) {
    originalWalPreserved = probe.archives.some(archive => {
      const manifest = JSON.parse(fs.readFileSync(path.join(archive.archivePath, 'manifest.json'), 'utf8'))
      const row = manifest.unverifiedInputFiles?.find(row => row.relative === baseline.unverifiedWal.relative && row.sha256 === baseline.unverifiedWal.sha256)
      return row && digest(fs.readFileSync(path.join(archive.archivePath, 'unverified-input', row.relative))) === baseline.unverifiedWal.sha256
    })
  }
  return { ok: preserved && originalWalPreserved !== false && probe.canRotate === true && first?.action === 'audit.identity.repaired', unrelatedCiphertextPreserved: preserved, originalWalPreserved,
    mode: baseline.mode, probe, genesis: first, events: events.map(row => ({ sequence: row.sequence, action: row.event?.action, target: row.event?.target })) }
}
module.exports = { prepare, seed, tamper, verify, unrelated, vaultRecords, writeContainer, custodyMetadata, FIXTURE_KEY, MODES }
if (require.main === module) {
  const [operation, ...args] = process.argv.slice(2)
  const options = args[0]?.startsWith('--')
    ? Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]))
    : { '--state-root': args[0], '--mode': args[1], '--scratch-root': process.env.TOOLSENABLED_TEST_ROOT }
  let context
  Promise.resolve().then(async () => {
    context = prepare({ stateRoot: options['--state-root'], scratchRoot: options['--scratch-root'], engineRoot: options['--engine-root'] || process.env.MC_SETTINGS_ENGINE_ROOT })
    if (operation === 'seed') return seed(context, options['--mode'])
    if (operation === 'verify') return verify(context)
    if (operation === 'tamper') return tamper(context, options['--mode'])
    throw new Error('Use seed, tamper, or verify.')
  }).then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.ok && operation !== 'tamper') process.exitCode = 1 })
    .catch(error => { process.stderr.write(`${error.code || 'FIXTURE_FAILED'}: ${error.message}\n`); process.exitCode = 1 })
    .finally(async () => { if (context) await context.audit.close() })
}
