'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { readCodexContextSnapshot, MAX_SOURCE_BYTES } = require('./codex-context-snapshot.cjs')

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 512 * 1024
const MAX_MESSAGES = 100
const MAX_MESSAGE_CHARS = 16000
const MAX_TEXT_CHARS = 128000
const MAX_COPY_BYTES = 32 * 1024 * 1024
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function refused(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

// A provider transcript is reached only from the observer's trusted callback.
// A renderer may choose a receipt; it cannot choose a path, workspace or UUID.
function checkedPath(profile, candidate, { root = profile, allowMissing = false } = {}) {
  const resolved = path.resolve(candidate)
  if (!inside(profile, resolved) || !inside(root, resolved)) {
    refused('EDITOR_SOURCE_OUTSIDE_ACCOUNT', 'The editor session is outside this account’s folders.')
  }
  let current = profile
  for (const part of ['', ...path.relative(profile, resolved).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        refused('EDITOR_SOURCE_LINKED', 'Editor sessions in linked folders cannot be opened.')
      }
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return resolved
      if (error.code?.startsWith('EDITOR_')) throw error
      refused('EDITOR_SOURCE_UNAVAILABLE', 'The saved editor session is no longer readable. Check for sessions again.')
    }
  }
  const canonical = fs.realpathSync(resolved)
  if (path.relative(resolved, canonical) !== '' || !inside(profile, canonical) || !inside(root, canonical)) {
    refused('EDITOR_SOURCE_LINKED', 'Editor sessions in linked folders cannot be opened.')
  }
  return resolved
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
}

function fileIdentity(profile, root, file) {
  checkedPath(profile, file, { root })
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.nlink > 1) refused('EDITOR_SOURCE_LINKED', 'The editor record must be a regular file without additional links.')
  return stat
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(part => part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string')
    .map(part => part.text).join('\n')
}

function readSource(profile, source, { messages = false } = {}) {
  const before = fileIdentity(profile, source.root, source.file)
  if (!sameFile(source.identity, before)) refused('EDITOR_SOURCE_CHANGED', 'The editor record was replaced. Check for sessions again.')
  let fd
  try {
    fd = fs.openSync(source.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(fd)
    if (!sameFile(before, opened) || !sameFile(opened, fileIdentity(profile, source.root, source.file))) {
      refused('EDITOR_SOURCE_CHANGED', 'The editor record changed while it was being opened. Check for sessions again.')
    }
    const whole = opened.size <= HEAD_BYTES + TAIL_BYTES
    const headSize = Math.min(opened.size, whole ? HEAD_BYTES + TAIL_BYTES : HEAD_BYTES)
    const headBuffer = Buffer.alloc(headSize)
    const headRead = fs.readSync(fd, headBuffer, 0, headSize, 0)
    let head = headBuffer.subarray(0, headRead).toString('utf8')
    let tail = ''
    const truncated = opened.size > HEAD_BYTES + TAIL_BYTES
    if (opened.size > headRead) {
      head = head.slice(0, head.lastIndexOf('\n') + 1)
      const offset = opened.size - TAIL_BYTES
      const tailBuffer = Buffer.alloc(Math.min(TAIL_BYTES, opened.size - offset))
      const tailRead = fs.readSync(fd, tailBuffer, 0, tailBuffer.length, offset)
      tail = tailBuffer.subarray(0, tailRead).toString('utf8')
      // The partial first line is not evidence of a malformed record.
      if (offset > 0) tail = tail.slice(tail.indexOf('\n') + 1)
    }
    if (!sameFile(opened, fileIdentity(profile, source.root, source.file))) {
      refused('EDITOR_SOURCE_CHANGED', 'The editor record changed while it was being read. Check for sessions again.')
    }
    let cwd = null, historyMode = null, foundSession = false, malformed = 0
    const rows = [], fallbackRows = []
    for (const line of (head + tail).split('\n')) {
      if (!line.trim()) continue
      let record
      try { record = JSON.parse(line) } catch { malformed += 1; continue }
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue
      if (source.observation.provider === 'codex') {
        if (record.type === 'session_meta') {
          const id = record.payload?.id || record.payload?.session_id
          if (id !== source.observation.sessionId) refused('EDITOR_SOURCE_CHANGED', 'The editor record now belongs to another session. Check for sessions again.')
          foundSession = true
          historyMode = record.payload?.history_mode || 'legacy'
          if (typeof record.payload?.cwd === 'string') cwd = record.payload.cwd
        }
        if (record.type === 'turn_context' && typeof record.payload?.cwd === 'string') cwd = record.payload.cwd
        if (messages && record.type === 'response_item' && record.payload?.type === 'message'
            && ['user', 'assistant'].includes(record.payload.role)) {
          rows.push({ role: record.payload.role, text: textOf(record.payload.content) })
        }
        if (messages && record.type === 'event_msg' && ['user_message', 'agent_message'].includes(record.payload?.type)) {
          fallbackRows.push({ role: record.payload.type === 'user_message' ? 'user' : 'assistant',
            text: typeof record.payload.message === 'string' ? record.payload.message : '' })
        }
      } else {
        if (record.sessionId && record.sessionId !== source.observation.sessionId) continue
        if (record.sessionId === source.observation.sessionId) foundSession = true
        if (typeof record.cwd === 'string') cwd = record.cwd
        if (messages && ['user', 'assistant'].includes(record.type)) {
          rows.push({ role: record.type, text: textOf(record.message?.content) })
        }
      }
    }
    if (!foundSession) refused('EDITOR_SOURCE_IDENTITY_UNAVAILABLE', 'The record’s session identity could not be verified. Check for sessions again.')
    const candidates = (rows.length ? rows : fallbackRows).filter(row => row.text)
    let characters = 0, textTruncated = false
    const bounded = []
    for (const row of candidates.slice(-MAX_MESSAGES).reverse()) {
      const room = MAX_TEXT_CHARS - characters
      if (room <= 0) { textTruncated = true; break }
      const text = row.text.slice(0, Math.min(room, MAX_MESSAGE_CHARS))
      if (text.length < row.text.length) textTruncated = true
      characters += text.length
      bounded.unshift({ ...row, text })
    }
    return { cwd, historyMode, sourceBytes: opened.size, messages: bounded, readAtMs: Date.now(),
      partial: truncated || malformed > 0 || textTruncated || candidates.length > MAX_MESSAGES,
      bytesRead: headRead + Buffer.byteLength(tail), toolDetailsIncluded: false }
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

// Both official clients resolve a fork through their own conversation store.
// Codex 0.153 also requires its path argument to match that store's current
// rollout, even when the selected source path exists elsewhere. Import only
// the selected verified transcript; never credentials, neighbouring histories
// or provider indexes. The returned path identifies this temporary copy.
function stageProviderSource(profile, source, configDir) {
  const destinationHome = checkedPath(profile, configDir)
  if (destinationHome === profile || inside(source.providerHome, destinationHome)
      || inside(destinationHome, source.providerHome)) {
    refused('EDITOR_FORK_IMPORT_REFUSED', 'The conversation copy needs a separate confined session home.')
  }
  const parts = path.relative(source.root, source.file).split(path.sep)
  const isClaude = source.observation.provider === 'claude'
  if (isClaude && (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..')
      || parts[1].toLowerCase() !== `${source.observation.sessionId}.jsonl`.toLowerCase())) {
    refused('EDITOR_FORK_UNSUPPORTED', 'This is not a complete top-level Claude conversation record.')
  }
  const before = fileIdentity(profile, source.root, source.file)
  if (!sameFile(source.identity, before)) refused('EDITOR_SOURCE_CHANGED', 'The selected editor record was replaced. Check for sessions again.')
  const scanLimit = isClaude ? MAX_COPY_BYTES : MAX_SOURCE_BYTES
  if (before.size > scanLimit) refused('EDITOR_FORK_TOO_LARGE', 'This conversation exceeds the bounded copy limit. Watch it here or start a fresh agent.')
  const stamp = new Date(before.mtimeMs).toISOString().slice(0, 19)
  const directoryParts = isClaude ? ['projects', parts[0]] : ['sessions', ...stamp.slice(0, 10).split('-')]
  const leaf = isClaude ? parts[1] : `rollout-${stamp.replaceAll(':', '-')}-${source.observation.sessionId}.jsonl`
  let sourceFd, targetFd, created = false, target, targetIdentity
  const removeOwnedImport = () => {
    if (!created) return
    try {
      if (sameFile(targetIdentity, fileIdentity(profile, destinationHome, target))) fs.unlinkSync(target)
    } catch { /* A replaced or removed import is not ours to remove. */ }
    created = false
  }
  try {
    sourceFd = fs.openSync(source.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(sourceFd)
    if (!sameFile(before, opened) || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      refused('EDITOR_SOURCE_BUSY', 'The editor is saving this conversation. Wait for its current turn to finish and try again.')
    }
    const snapshot = !isClaude ? readCodexContextSnapshot(sourceFd, opened.size, source.observation.sessionId) : null
    const bytes = snapshot?.bytes || Buffer.alloc(opened.size)
    if (isClaude) {
      let offset = 0
      while (offset < bytes.length) {
        const count = fs.readSync(sourceFd, bytes, offset, bytes.length - offset, offset)
        if (!count) refused('EDITOR_SOURCE_BUSY', 'The editor record changed while its copy was read. Try again after the current turn.')
        offset += count
      }
    }
    const after = fileIdentity(profile, source.root, source.file)
    if (!sameFile(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
        || (bytes.length && bytes[bytes.length - 1] !== 10)) {
      refused('EDITOR_SOURCE_BUSY', 'The editor is still saving this conversation. Try again after its current turn.')
    }
    let hasIdentity = false
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      let record
      try { record = JSON.parse(line) } catch { refused('EDITOR_SOURCE_BUSY', 'The saved conversation contains an unfinished record. Try again after its current turn.') }
      const identity = isClaude ? record?.sessionId : record?.type === 'session_meta' ? record.payload?.id || record.payload?.session_id : null
      if (identity && identity !== source.observation.sessionId) {
        refused('EDITOR_SOURCE_CHANGED', 'The saved record contains another conversation identity. Check for sessions again.')
      }
      if (identity === source.observation.sessionId) hasIdentity = true
    }
    if (!hasIdentity) refused('EDITOR_SOURCE_IDENTITY_UNAVAILABLE', 'The complete source copy does not identify the selected conversation. Check for sessions again.')
    let directory = destinationHome
    for (const part of directoryParts) {
      directory = path.join(directory, part)
      checkedPath(profile, directory, { root: destinationHome, allowMissing: true })
      try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      checkedPath(profile, directory, { root: destinationHome })
      if (!fs.lstatSync(directory).isDirectory()) refused('EDITOR_FORK_IMPORT_REFUSED', 'The confined conversation folder is unavailable.')
    }
    target = path.join(directory, leaf)
    checkedPath(profile, target, { root: destinationHome, allowMissing: true })
    try { targetFd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600) }
    catch (error) {
      if (error.code === 'EEXIST') refused('EDITOR_FORK_IMPORT_REFUSED', 'Another copy of this editor record is already being prepared. Wait for it to finish.')
      throw error
    }
    targetIdentity = fs.fstatSync(targetFd); created = true
    fs.writeFileSync(targetFd, bytes)
    fs.fsyncSync(targetFd)
    if (!sameFile(targetIdentity, fileIdentity(profile, destinationHome, target))) refused('EDITOR_FORK_IMPORT_REFUSED', 'The confined source import changed while it was written.')
    Object.defineProperty(removeOwnedImport, 'sourcePath', { value: target })
    Object.defineProperty(removeOwnedImport, 'historyScope', { value: snapshot?.historyScope || 'saved-conversation' })
    return removeOwnedImport
  } catch (error) { removeOwnedImport(); throw error }
  finally {
    if (sourceFd !== undefined) fs.closeSync(sourceFd)
    if (targetFd !== undefined) fs.closeSync(targetFd)
  }
}

function createEditorSessionSources({ home, now = Date.now, isIncluded = () => false, accountForSource = () => null, maxReceipts = 512,
  receiptLifetimeMs = 30 * 60 * 1000 } = {}) {
  const profile = path.resolve(home)
  const sources = new Map(), receipts = new Map(), forks = new Map()
  const roots = Object.freeze({ codex: path.join(profile, '.codex', 'sessions'), claude: path.join(profile, '.claude', 'projects') })

  function prune(map) {
    for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key)
    while (map.size >= maxReceipts) map.delete(map.keys().next().value)
  }
  function capture(file, observation, providerHome = null) {
    const root = providerHome && roots[observation.provider]
      ? path.join(providerHome, observation.provider === 'codex' ? 'sessions' : 'projects')
      : roots[observation.provider]
    if (!root || typeof observation.sourceRef !== 'string') return
    try {
      const identity = fileIdentity(profile, root, file)
      sources.set(observation.sourceRef, { file, root, identity, observation,
        providerHome: path.dirname(root), expiresAt: now() + receiptLifetimeMs })
      prune(sources)
    } catch { /* This row remains metadata only, with no usable source receipt. */ }
  }
  function issue(observation, owner) {
    const source = sources.get(observation.sourceRef)
    if (!source) return null
    prune(receipts)
    for (const [key, held] of receipts) {
      if (held.owner === owner && held.source.observation.sourceRef === source.observation.sourceRef
          && sameFile(held.source.identity, source.identity)) { held.source = source; return key }
    }
    const receipt = crypto.randomBytes(32).toString('base64url')
    receipts.set(receipt, { source, owner, expiresAt: now() + receiptLifetimeMs })
    return receipt
  }
  function resolve(receipt, owner, map = receipts) {
    const held = typeof receipt === 'string' ? map.get(receipt) : null
    if (!held || held.owner !== owner || held.expiresAt <= now()) {
      refused('EDITOR_RECEIPT_UNAVAILABLE', 'This editor choice has expired or belongs to another window. Check for sessions again.')
    }
    if (isIncluded(held.source.observation) !== true) refused('EDITOR_IMPORT_REMOVED', 'This editor surface is no longer included. Include it and save before opening the session.')
    return held
  }
  function preview(receipt, owner) {
    const { source } = resolve(receipt, owner)
    const viewed = readSource(profile, source, { messages: true })
    return { ok: true, provider: source.observation.provider, sessionId: source.observation.sessionId,
      ...viewed, cwd: undefined, mode: 'mirror', liveControl: false }
  }
  function prepareFork(receipt, owner) {
    const { source } = resolve(receipt, owner)
    if (!['codex', 'claude'].includes(source.observation.provider)) refused('EDITOR_FORK_UNSUPPORTED', 'This provider does not support a separate conversation copy.')
    if (!SESSION_ID.test(source.observation.sessionId || '') || source.observation.kind === 'subagent') {
      refused('EDITOR_FORK_UNSUPPORTED', 'Only a complete top-level provider conversation can be copied here.')
    }
    const read = readSource(profile, source)
    if (typeof read.cwd !== 'string' || !path.isAbsolute(read.cwd)) refused('EDITOR_WORKSPACE_UNKNOWN', 'The editor record does not identify its working folder. A copy cannot be started safely.')
    const cwd = checkedPath(profile, read.cwd)
    if (!fs.statSync(cwd).isDirectory()) refused('EDITOR_WORKSPACE_UNKNOWN', 'The editor’s working folder is no longer available.')
    accountForSource(source.observation.provider, source.providerHome)
    prune(forks)
    const forkReceipt = crypto.randomBytes(32).toString('base64url')
    forks.set(forkReceipt, { source, owner, cwd, expiresAt: now() + receiptLifetimeMs })
    return { ok: true, mode: 'fork', forkReceipt, provider: source.observation.provider,
      sourceSessionId: source.observation.sessionId, model: source.observation.model, effort: source.observation.effort,
      historyScope: source.observation.provider === 'codex' ? 'current-model-context' : 'saved-conversation',
      workspace: path.basename(cwd), expiresAt: now() + receiptLifetimeMs }
  }
  function redeemFork(forkReceipt, owner, cwd) {
    const held = resolve(forkReceipt, owner, forks)
    const current = readSource(profile, held.source)
    if (typeof current.cwd !== 'string' || typeof cwd !== 'string' || checkedPath(profile, current.cwd) !== held.cwd || checkedPath(profile, cwd) !== held.cwd) {
      refused('EDITOR_FORK_WORKSPACE_MISMATCH', 'Choose a session profile for the editor’s original working folder before starting its copy.')
    }
    const account = accountForSource(held.source.observation.provider, held.source.providerHome)
    forks.delete(forkReceipt)
    let sourceStaged = false
    return Object.freeze({ provider: held.source.observation.provider, threadId: held.source.observation.sessionId,
      sourcePath: held.source.file, providerHome: held.source.providerHome, account, cwd: held.cwd,
      stageSource(configDir) {
        if (sourceStaged) refused('EDITOR_RECEIPT_UNAVAILABLE', 'This editor source import was already used. Check for sessions again.')
        sourceStaged = true
        return stageProviderSource(profile, held.source, configDir)
      },
      assertCurrent() {
        if (isIncluded(held.source.observation) !== true) refused('EDITOR_IMPORT_REMOVED', 'The editor surface was removed before its copy could start.')
        if (accountForSource(held.source.observation.provider, held.source.providerHome) !== account) refused('EDITOR_SOURCE_ACCOUNT_CHANGED', 'The editor’s provider account changed. Check for sessions again before copying it.')
        const verified = readSource(profile, held.source)
        if (typeof verified.cwd !== 'string' || checkedPath(profile, verified.cwd) !== held.cwd) {
          refused('EDITOR_FORK_WORKSPACE_MISMATCH', 'The editor changed its working folder. Check for sessions again before copying it.')
        }
      } })
  }
  function adopt() {
    return { ok: false, code: 'EDITOR_HANDOFF_UNAVAILABLE',
      reason: 'This editor has no verified handoff to ToolsEnabled. It must acknowledge that it stopped driving the conversation and grant exclusive control before takeover is available. Watch it or start a copy instead.' }
  }
  return Object.freeze({ capture, issue, preview, prepareFork, redeemFork, adopt })
}

module.exports = { createEditorSessionSources, checkedPath, readSource }
