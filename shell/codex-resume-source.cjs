'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function refuse(message) { throw Object.assign(new Error(message), { code: 'AGENT_RESUME_SOURCE_UNAVAILABLE' }) }
const within = (root, file) => { const rel = path.relative(root, file); return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) }

// The planner owns generatedHome. Derive only this declared agent's confined
// session namespace; a renderer cannot supply a home, rollout or search root.
function ownedCodexResumeSource({ generatedHome, agentId, account, threadId }) {
  if (!agentId || typeof generatedHome !== 'string') return null
  const home = path.resolve(generatedHome)
  const sessionRoot = path.dirname(path.dirname(path.dirname(path.dirname(home))))
  if (path.basename(sessionRoot) !== '@sessions' || path.basename(path.dirname(sessionRoot)) !== agentId
      || path.basename(path.dirname(path.dirname(sessionRoot))) !== '@agents'
      || path.basename(path.dirname(path.dirname(home))) !== 'codex') return null
  if (!/^[a-f0-9-]{36}$/.test(threadId)) refuse('The saved native conversation identity is invalid.')
  const leaf = path.basename(home)
  if (path.relative(sessionRoot, fs.realpathSync(sessionRoot)) !== '') refuse('The generated agent namespace contains a redirected path.')
  const owner = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  function ordinary(file, directory, boundary = sessionRoot) {
    if (file !== boundary && !within(boundary, file)) refuse('The saved conversation left its agent namespace.')
    for (let current = file;; current = path.dirname(current)) {
      // Windows file IDs can exceed Number's exact integer range. All identity
      // reads must retain the same full-width values, including descriptor reads.
      const stat = fs.lstatSync(current, { bigint: true })
      if (stat.isSymbolicLink() || (owner !== null && stat.uid !== owner)
          || (current === file ? directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) {
        refuse('The saved conversation is not an ordinary file owned by this agent account.')
      }
      if (current === boundary) return fs.lstatSync(file, { bigint: true })
    }
  }
  let entries = 0
  function list(directory) {
    try {
      ordinary(directory, true)
      const rows = fs.readdirSync(directory, { withFileTypes: true })
      entries += rows.length
      if (entries > 8192) refuse('The saved conversation lookup exceeded its bounded agent history.')
      return rows
    } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  function header(file) {
    ordinary(file, false)
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = fs.fstatSync(fd, { bigint: true }), bytes = Buffer.alloc(65536)
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0), newline = bytes.subarray(0, count).indexOf(10)
      if (newline < 0) refuse('The saved native conversation header is incomplete.')
      const row = JSON.parse(bytes.subarray(0, newline).toString('utf8'))
      const after = ordinary(file, false)
      if (before.dev !== after.dev || before.ino !== after.ino || row.type !== 'session_meta' || row.payload?.id !== threadId) {
        refuse('The saved native conversation changed identity.')
      }
      return { dev: before.dev, ino: before.ino, historyMode: row.payload.history_mode || 'legacy' }
    } finally { fs.closeSync(fd) }
  }
  function accountName(candidate) {
    if (!account) return leaf === '@default' ? null : refuse('The saved native conversation account is unknown.')
    const marker = path.join(candidate, 'toolsenabled-account.json')
    ordinary(marker, false)
    const fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = fs.fstatSync(fd, { bigint: true })
      if (stat.size > 4096n || stat.nlink !== 1n) refuse('The native conversation account marker is invalid.')
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'))
      const named = ordinary(marker, false)
      if (stat.dev !== named.dev || stat.ino !== named.ino || value.name !== account) {
        refuse('The saved native conversation belongs to another provider account.')
      }
      return value.name
    } finally { fs.closeSync(fd) }
  }
  const matches = []
  const sessions = list(sessionRoot).filter(row => /^[a-f0-9]{64}$/.test(row.name))
  if (sessions.length > 256) refuse('The saved conversation lookup exceeded its bounded session history.')
  for (const session of sessions) {
    const codex = path.join(sessionRoot, session.name, 'codex')
    for (const tier of list(codex).filter(row => ['guided', 'standard', 'unrestricted'].includes(row.name))) {
      const candidate = path.join(codex, tier.name, leaf)
      if (!list(candidate).length) continue
      accountName(candidate)
      function walk(directory, depth) {
        for (const row of list(directory)) {
          const file = path.join(directory, row.name)
          if (row.isDirectory() && depth < 3 && /^\d{2,4}$/.test(row.name)) walk(file, depth + 1)
          else if (row.name.endsWith('-' + threadId + '.jsonl')) matches.push({ file, home: candidate, identity: header(file) })
        }
      }
      walk(path.join(candidate, 'sessions'), 0)
      walk(path.join(candidate, 'archived_sessions'), 0)
    }
  }
  if (matches.length > 1) refuse('More than one owned rollout claims this saved conversation.')
  if (!matches.length) return null
  const selected = matches[0]
  // Paginated rollouts resolve their history in SQLite, not in the JSONL file.
  // Bind only the database derived from the verified agent/account home;
  // fresh CLI config and credentials come from the newly admitted session.
  // The Windows planner moves SQLite out of long generated homes. Recompute
  // that exact per-home location; never follow a config-supplied database path.
  const servicesRoot = path.dirname(path.dirname(path.dirname(path.dirname(sessionRoot))))
  const compactDatabase = process.platform === 'win32' && selected.home.length > 220
  const databaseHome = selected.identity.historyMode === 'paginated'
    ? compactDatabase ? path.join(servicesRoot, 'agent-db', crypto.createHash('sha256').update(selected.home, 'utf8').digest('base64url')) : selected.home
    : null
  const databaseBoundary = compactDatabase ? servicesRoot : sessionRoot
  function databaseIdentity() {
    if (!databaseHome) return null
    try {
      ordinary(databaseHome, true, databaseBoundary)
      const rows = fs.readdirSync(databaseHome, { withFileTypes: true })
      if (rows.length > 8192) refuse('The saved conversation database lookup exceeded its bound.')
      for (const row of rows) if (/\.sqlite(?:-(?:wal|shm))?$/.test(row.name)) ordinary(path.join(databaseHome, row.name), false, databaseBoundary)
      return ordinary(path.join(databaseHome, 'thread_history_1.sqlite'), false, databaseBoundary)
    } catch { refuse('The saved native conversation database is unavailable or not owned by this account.') }
  }
  const database = databaseIdentity()
  return Object.freeze({ sourcePath: selected.file, databaseHome, assertCurrent() {
    accountName(selected.home)
    const current = header(selected.file)
    if (current.dev !== selected.identity.dev || current.ino !== selected.identity.ino || current.historyMode !== selected.identity.historyMode) refuse('The saved conversation file was replaced.')
    const currentDatabase = databaseIdentity()
    if (database && (database.dev !== currentDatabase.dev || database.ino !== currentDatabase.ino)) refuse('The saved conversation database was replaced.')
  } })
}

module.exports = { ownedCodexResumeSource }
