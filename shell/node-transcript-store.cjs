'use strict'

// One file per spoken entry. Updates replace that entry atomically; an append
// never reads or rewrites the history of this or another node.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const digest = value => createHash('sha256').update(value).digest('hex')
const identity = value => {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) throw new Error('Invalid transcript identity.')
  return value
}
/* WHO THIS TRANSCRIPT BELONGS TO, OR A REFUSAL THAT SAYS WHICH HALF IS MISSING.
 *
 * T406 (measured 2026-09-18 on the 3e1cd3a9 candidate): mcTranscripts.list()
 * reached this file with no request at all, and `async function list({
 * computerId })` answered with a TypeError -- "Cannot destructure property
 * 'computerId' of 'undefined'" -- which shell/main.cjs then dressed as
 * MC_TRANSCRIPT_STORAGE_FAILED. Storage had not failed. Nobody had said whose
 * transcript was wanted. Those are different answers, and a caller holding a
 * storage-failure code will go looking for a disk problem that is not there.
 *
 * Every operation's identity now comes through here. A request that cannot
 * name its computer (or, for a per-node operation, its node) is refused by
 * name, with the missing field in the sentence and MC_TRANSCRIPT_IDENTITY_
 * UNRESOLVED as the code, and the shell passes that code through untouched. */
const IDENTITY_UNRESOLVED = 'MC_TRANSCRIPT_IDENTITY_UNRESOLVED'
const identityOf = (request, field) => {
  const value = request && typeof request === 'object' ? request[field] : undefined
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) {
    throw Object.assign(new Error(`The transcript identity could not be resolved: ${field} is ${value === undefined ? 'missing' : 'not a usable id'}.`),
      { code: IDENTITY_UNRESOLVED, field })
  }
  return value
}

function createNodeTranscriptStore({ directory, io = fs, settings = {}, saveSettings = async () => {}, validateDirectory = () => {} }) {
  const root = path.resolve(directory, 'node-transcripts')
  const active = path.join(root, 'active')
  let configuration = { archiveDirectory: path.join(directory, 'transcript-graveyard'), archiveMaxBytes: 256 * 1024 * 1024, deleteNodesOnExit: false, ...settings }
  const queues = new Map()
  const states = new Map()
  let closing = false
  const keyOf = request => digest(identityOf(request, 'computerId')) + '-' + digest(identityOf(request, 'nodeId'))
  const enqueue = (key, task) => {
    if (closing) return Promise.reject(new Error('Transcript storage is closing.'))
    const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(task)
    queues.set(key, pending)
    pending.finally(() => { if (queues.get(key) === pending) queues.delete(key) }).catch(() => {})
    return pending
  }
  async function names(directoryPath) {
    try { return await io.readdir(directoryPath) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  async function atomic(file, value) {
    const temporary = file + '.' + randomUUID() + '.tmp'
    try {
      await io.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
      const handle = await io.open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      await io.rename(temporary, file)
    } catch (error) { await io.unlink(temporary).catch(() => {}); throw error }
  }
  /* REPAIR FOR TURNS ALREADY ON DISK TWICE.
 *
 * Until shell/node-transcript-capture.cjs stopped appending a provider's final
 * aggregate on top of its own unnamed deltas, a spill file held the turn's text
 * concatenated with itself, so "51" read back as "5151". Preventing new ones
 * does nothing for the records already written: the person keeps seeing every
 * old reply twice whenever a conversation is reopened or resumed, which is the
 * only place this was ever visible.
 *
 * Records written by the fixed path carry `textWhole` and are never examined.
 * An older record is repaired ON READ and its bytes are left where they are: no
 * reader can be certain a repeated string is not what the agent actually said,
 * so the original stays on disk and only what is handed out is repaired.
 *
 * T366: THE REPAIR ONLY REACHED THE CASE WHERE THE DELTA RUN HAPPENED TO FINISH.
 *
 * The bug appended the provider's whole aggregate AFTER the deltas captured so
 * far, so a spill holds `D + A` where D is however much of the reply the delta
 * run had written and A is the complete reply -- and A therefore begins with D.
 * Halving only repairs the case where the deltas had reached the end (D === A).
 * When the aggregate landed mid-run, D is a shorter prefix, the file is not its
 * own double, and the person still reads the opening of every old reply twice.
 *
 * MEASURED over the owner's LIVE node-transcripts (4124 legacy spill files,
 * 2026-09-19, counts only -- no text was copied out): 576 are whole doubles and
 * were repaired; 2808 more are prefix doubles and were not, carrying 570,686
 * duplicated characters that the owner re-reads on every reopen or resume.
 *
 * THE SPLIT IS NOT A JUDGEMENT CALL. Of the 3384 doubled files, 3349 admit
 * EXACTLY ONE n with text[0..n) === text[n..2n), and after removing the leading
 * copy 3349 have no doubling left at all. The largest such n is taken, which is
 * precisely what halving already did for a whole double (n = length / 2), so
 * this generalises the shipped rule rather than adding a second one.
 *
 * WHAT IS STILL REFUSED. Text with no repeated leading run is returned
 * untouched, and the repair is applied ONCE per read, so a reply that genuinely
 * opens by repeating itself loses at most that one run and never unwinds
 * further. As before, the bytes on disk are not rewritten: no reader can be
 * certain a halved string is not what the agent actually said, so only what is
 * handed out is repaired.
 */
function singleSpill(text) {
  const value = String(text || '')
  if (value.length < 2) return value
  for (let head = Math.floor(value.length / 2); head >= 1; head -= 1) {
    if (value.slice(0, head) === value.slice(head, 2 * head)) return value.slice(head)
  }
  return value
}

async function state(request) {
    const key = keyOf(request)
    if (states.has(key)) return states.get(key)
    // Reads and writes may arrive together during hydration. Publish the load
    // promise before yielding so they share one index rather than allowing a
    // later empty read to replace an index the first append already populated.
    const pending = (async () => {
      const folder = path.join(active, key)
      const files = (await names(folder)).filter(name => /^\d{16}-[a-f0-9]{64}\.json$/.test(name)).sort()
      let metadata = null
      try { metadata = JSON.parse(await io.readFile(path.join(folder, 'node.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      return { folder, metadata, revision: metadata?.revision || 0, files: new Map(files.map(name => [name.slice(17, 81), name])), sequence: files.length ? Number(files.at(-1).slice(0, 16)) : 0 }
    })()
    states.set(key, pending)
    pending.catch(() => { if (states.get(key) === pending) states.delete(key) })
    return pending
  }
  async function append(request) {
    const key = keyOf(request)
    if (!Array.isArray(request.entries) || request.entries.length > 128) throw new Error('Transcript writes must be batched into at most 128 entries.')
    return enqueue(key, async () => {
      const held = await state(request)
      if (held.metadata?.closed) throw new Error('This node is closed; its transcript cannot be reopened by a late write.')
      held.revision += 1
      await io.mkdir(held.folder, { recursive: true })
      if (!held.metadata) {
        const initial = { computerId: request.computerId, nodeId: request.nodeId, savedAt: Date.now() }
        await atomic(path.join(held.folder, 'node.json'), initial)
        held.metadata = initial
      }
      for (const entry of request.entries) {
        identity(entry.id)
        if (!['you', 'agent', 'action'].includes(entry.who) || typeof entry.text !== 'string') throw new Error('Invalid transcript entry.')
        const id = digest(entry.id)
        const filename = held.files.get(id) || String(++held.sequence).padStart(16, '0') + '-' + id + '.json'
        await atomic(path.join(held.folder, filename), entry)
        await io.unlink(path.join(held.folder, filename + '.text')).catch(error => { if (error.code !== 'ENOENT') throw error })
        held.files.set(id, filename)
      }
      const supplied = { ...request.metadata }
      // Once the host has bound a real session, delayed renderer excerpts
      // cannot replace its native thread/provider/account with stale values.
      delete supplied.nativeSessionId
      if (held.metadata?.nativeSessionId) for (const field of ['threadId', 'provider', 'account']) delete supplied[field]
      const metadata = { ...held.metadata, ...supplied, computerId: request.computerId, nodeId: request.nodeId, savedAt: Date.now(), revision: held.revision }
      await atomic(path.join(held.folder, 'node.json'), metadata)
      held.metadata = metadata
      return { ok: true, count: held.files.size }
    })
  }
  async function bindSessionMetadata(request) {
    const key = keyOf(request)
    identity(request.sessionId)
    identity(request.metadata?.threadId)
    if (!['codex', 'claude', 'gemini', 'grok', 'local'].includes(request.metadata.provider)
        || !(request.metadata.account === null || typeof request.metadata.account === 'string')) throw new Error('Invalid native transcript binding.')
    return enqueue(key, async () => {
      const held = await state(request)
      if (held.metadata?.closed) throw new Error('Closed transcript cannot receive a session binding.')
      if (request.replace !== true && held.metadata?.nativeSessionId !== request.sessionId) return { ok: true, unchanged: true }
      await io.mkdir(held.folder, { recursive: true })
      const metadata = { ...held.metadata, computerId: request.computerId, nodeId: request.nodeId,
        nativeSessionId: request.sessionId, threadId: request.metadata.threadId,
        provider: request.metadata.provider, account: request.metadata.account, savedAt: Date.now(), revision: ++held.revision }
      await atomic(path.join(held.folder, 'node.json'), metadata)
      held.metadata = metadata
      return { ok: true }
    })
  }
  async function read(request) {
    const key = keyOf(request)
    await queues.get(key)?.catch(() => {})
    const held = await state(request)
    const limit = Math.max(1, Math.min(100, Number(request.limit) || 60))
    const availableFiles = new Set(held.files.values())
    const legacyFiles = (held.metadata?.legacyFiles || []).filter(name => availableFiles.has(name))
    const legacySet = new Set(legacyFiles)
    const ordered = [...legacyFiles, ...[...held.files.values()].filter(name => !legacySet.has(name)).sort()]
    const cursor = request.before ? ordered.indexOf(request.before) : -1
    if (request.strictBefore === true && request.before && cursor < 0) {
      const error = new Error('The transcript cursor is not in this conversation.')
      error.code = 'MC_AGENT_TRANSCRIPT_CURSOR_INVALID'; throw error
    }
    const files = cursor >= 0 ? ordered.slice(0, cursor) : ordered
    const page = files.slice(-limit)
    const entries = await Promise.all(page.map(async name => {
      // Resume may need more than its bounded prompt can carry. These are
      // locators for this node's existing files, not copied history or a new
      // permission grant. Derive them here; never trust an entry's fields.
      const { recoveryFiles: _untrustedRecoveryFiles, textWhole: spillIsWhole, ...entry } = JSON.parse(await io.readFile(path.join(held.folder, name), 'utf8'))
      // Older native capture wrote the turn only into its stable entry ID.
      // Recover that display metadata for known UUID host sessions on read;
      // retain original bytes and any explicit stamp already present.
      if (entry.who === 'agent' && entry.turnStamp === undefined && typeof entry.id === 'string') {
        const captured = /^agent:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:([^\0\r\n]{1,512})$/i.exec(entry.id)
        if (captured) entry.turnStamp = captured[1]
      }
      const extra = await io.readFile(path.join(held.folder, name + '.text'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      return { ...entry, text: entry.text + (spillIsWhole === true ? extra : singleSpill(extra)),
        ...(request.includeRecoveryFiles === true ? { recoveryFiles: [path.join(held.folder, name), ...(extra ? [path.join(held.folder, name + '.text')] : [])] } : {}) }
    }))
    return { ok: true, metadata: held.metadata, entries, before: files.length > page.length ? page[0] : null, count: held.files.size,
      ...(request.includeRecoveryFiles === true ? { recoveryDirectory: held.folder } : {}) }
  }
  async function list(request) {
    const prefix = digest(identityOf(request, 'computerId')) + '-'
    const records = []
    for (const name of await names(active)) {
      if (!name.startsWith(prefix) || !/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(name)) continue
      const metadata = JSON.parse(await io.readFile(path.join(active, name, 'node.json'), 'utf8'))
      if (!metadata.closed) records.push(metadata)
    }
    return { ok: true, records }
  }
  async function rollback(request) {
    return enqueue(keyOf(request), async () => {
      const held = await state(request)
      const id = digest(identity(request.entryId))
      const filename = held.files.get(id)
      if (filename) {
        // Invalidate staged archive receipts durably before deleting bytes.
        // A restart must not restore the pre-rollback revision and admit an
        // archive containing the message the caller just removed.
        const metadata = { ...held.metadata, revision: held.revision + 1 }
        await atomic(path.join(held.folder, 'node.json'), metadata)
        held.revision = metadata.revision
        held.metadata = metadata
        await io.unlink(path.join(held.folder, filename + '.text')).catch(error => { if (error.code !== 'ENOENT') throw error })
        await io.unlink(path.join(held.folder, filename)); held.files.delete(id)
      }
      return { ok: true }
    })
  }
  async function appendText(request) {
    const turnStamp = request.turnStamp === undefined ? undefined : identity(request.turnStamp)
    return enqueue(keyOf(request), async () => {
      const held = await state(request)
      if (held.metadata?.closed) throw new Error('This node is closed.')
      held.revision += 1
      const id = digest(identity(request.entryId))
      if (typeof request.text !== 'string') throw new Error('Invalid transcript text.')
      await io.mkdir(held.folder, { recursive: true })
      if (!held.metadata) {
        const initial = { computerId: request.computerId, nodeId: request.nodeId, savedAt: Date.now() }
        await atomic(path.join(held.folder, 'node.json'), initial)
        held.metadata = initial
      }
      let filename = held.files.get(id)
      if (!filename) {
        filename = String(++held.sequence).padStart(16, '0') + '-' + id + '.json'
        /* `textWhole` marks a spill this fixed path owns from its first byte,
           so read() never second-guesses it. Its absence is what identifies a
           record written before the doubling was stopped. */
        await atomic(path.join(held.folder, filename), { id: request.entryId, who: 'agent', text: '', textWhole: true, at: request.at || Date.now(),
          ...(turnStamp === undefined ? {} : { turnStamp }) })
        held.files.set(id, filename)
      } else if (turnStamp !== undefined) {
        const entry = JSON.parse(await io.readFile(path.join(held.folder, filename), 'utf8'))
        if (entry.turnStamp !== undefined && entry.turnStamp !== turnStamp) throw new Error('Transcript turn identity cannot change.')
        if (entry.turnStamp === undefined) await atomic(path.join(held.folder, filename), { ...entry, turnStamp })
      }
      const handle = await io.open(path.join(held.folder, filename + '.text'), 'a', 0o600)
      try { await handle.writeFile(request.text); await handle.sync() } finally { await handle.close() }
      const metadata = { ...held.metadata, revision: held.revision }
      await atomic(path.join(held.folder, 'node.json'), metadata)
      held.metadata = metadata
      return { ok: true }
    })
  }
  async function archiveFolder() {
    // User selection may be outside userData, but a reparse point must never
    // turn a quota cleanup into traversal of some other directory.
    const folder = path.resolve(configuration.archiveDirectory)
    validateDirectory(folder)
    if (folder === root || folder.startsWith(root + path.sep) || root.startsWith(folder + path.sep)) throw new Error('Archive folder must be separate from active transcript storage.')
    let ancestor = folder
    while (true) {
      try {
        if ((await io.realpath(ancestor)).toLowerCase() !== ancestor.toLowerCase()) throw new Error('Archive folder must not traverse a symbolic link.')
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const parent = path.dirname(ancestor)
        if (parent === ancestor) throw error
        ancestor = parent
      }
    }
    await io.mkdir(folder, { recursive: true })
    if ((await io.realpath(folder)).toLowerCase() !== folder.toLowerCase()) throw new Error('Archive folder must not be a symbolic link.')
    return folder
  }
  async function enforceQuota(folder) {
    const archives = []
    for (const name of await names(folder)) {
      if (!/^transcript-\d{13}-[a-f0-9-]{36}$/.test(name)) continue
      const target = path.join(folder, name)
      const info = await io.lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      let bytes = 0
      for (const file of await names(target)) {
        const item = await io.lstat(path.join(target, file))
        if (item.isSymbolicLink() || !item.isFile()) throw new Error('Archive contains an unexpected filesystem entry.')
        bytes += item.size
      }
      archives.push({ target, name, bytes })
    }
    let total = archives.reduce((sum, item) => sum + item.bytes, 0)
    for (const item of archives.sort((a, b) => a.name.localeCompare(b.name))) {
      if (total <= configuration.archiveMaxBytes) break
      await io.rm(item.target, { recursive: true }); total -= item.bytes
    }
  }
  async function archive(request) {
    return enqueue(keyOf(request), async () => {
      const held = await state(request)
      if (!held.metadata) return { ok: true }
      const folder = await archiveFolder()
      const target = path.join(folder, (request.stageOnly ? 'transcript-pending-' : 'transcript-') + Date.now() + '-' + randomUUID())
      // Copy first, mark closed only after every entry is durable at destination.
      // Failure leaves the active source and its metadata intact.
      await io.cp(held.folder, target, { recursive: true, errorOnExist: true, force: false })
      await atomic(path.join(target, 'node.json'), { ...held.metadata, closedAt: Date.now(), sourceRevision: held.revision })
      if (request.stageOnly) return { ok: true, archiveId: path.basename(target) }
      return finishArchive(held, folder)
    })
  }
  async function finishArchive(held, folder) {
      await atomic(path.join(held.folder, 'node.json'), { ...held.metadata, closed: true })
      held.metadata = { ...held.metadata, closed: true }
      for (const file of held.files.values()) {
        await io.unlink(path.join(held.folder, file + '.text')).catch(error => { if (error.code !== 'ENOENT') throw error })
        await io.unlink(path.join(held.folder, file))
      }
      held.files.clear()
      await enforceQuota(folder)
      return { ok: true }
  }
  async function commitArchive(request) {
    return enqueue(keyOf(request), async () => {
      if (!/^transcript-pending-\d{13}-[a-f0-9-]{36}$/.test(request.archiveId || '')) throw new Error('Invalid archive receipt.')
      const folder = await archiveFolder()
      const archived = JSON.parse(await io.readFile(path.join(folder, request.archiveId, 'node.json'), 'utf8'))
      if (archived.nodeId !== request.nodeId || archived.computerId !== request.computerId) throw new Error('Archive receipt belongs to another node.')
      const held = await state(request)
      if (held.revision !== archived.sourceRevision) throw new Error('Conversation changed after the archive was prepared. Active history was retained.')
      await io.rename(path.join(folder, request.archiveId), path.join(folder, request.archiveId.replace('transcript-pending-', 'transcript-')))
      return finishArchive(held, folder)
    })
  }
  async function cancelArchive(request) {
    return enqueue(keyOf(request), async () => {
      if (!/^transcript-pending-\d{13}-[a-f0-9-]{36}$/.test(request.archiveId || '')) throw new Error('Invalid archive receipt.')
      const folder = await archiveFolder()
      const target = path.join(folder, request.archiveId)
      if ((await io.lstat(target)).isSymbolicLink()) throw new Error('Archive receipt must not be a symbolic link.')
      const archived = JSON.parse(await io.readFile(path.join(target, 'node.json'), 'utf8'))
      if (archived.nodeId !== request.nodeId || archived.computerId !== request.computerId) throw new Error('Archive receipt belongs to another node.')
      await io.rm(target, { recursive: true })
      return { ok: true }
    })
  }
  /* A NEW ARCHIVE FOLDER IS CHECKED BEFORE IT IS SAVED (T1488). On Linux any
     absolute path passed: a file, a folder that could not be created, and '/'
     were all 'Settings saved.', and closed conversations would have gone there.
     The folder is created if it is missing, and one small probe file is written
     and removed to prove it can hold archives. */
  async function usableArchiveFolder(folder) {
    if (path.dirname(folder) === folder) throw new Error('Choose a folder for closed conversations, not the top of the drive.')
    if (folder === root || folder.startsWith(root + path.sep) || root.startsWith(folder + path.sep)) throw new Error('Archive folder must be separate from active transcript storage.')
    const unwritable = 'The archive folder cannot be created or written. Choose a folder you can write to.'
    let info = null
    try { info = await io.stat(folder) } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(unwritable)
    }
    if (info && !info.isDirectory()) throw new Error('The archive folder is a file, not a folder. Choose a folder.')
    try {
      await io.mkdir(folder, { recursive: true })
      const probe = path.join(folder, `.archive-check-${randomUUID()}`)
      await io.writeFile(probe, '')
      await io.unlink(probe)
    } catch {
      throw new Error(unwritable)
    }
  }
  async function configure(next) {
    const merged = { ...configuration, ...next }
    if (typeof merged.archiveDirectory !== 'string' || !path.isAbsolute(merged.archiveDirectory)
      || !Number.isSafeInteger(merged.archiveMaxBytes) || merged.archiveMaxBytes < 0
      || typeof merged.deleteNodesOnExit !== 'boolean') throw new Error('Invalid transcript settings.')
    validateDirectory(path.resolve(merged.archiveDirectory))
    if (path.resolve(merged.archiveDirectory) !== path.resolve(configuration.archiveDirectory)) await usableArchiveFolder(path.resolve(merged.archiveDirectory))
    await saveSettings(merged)
    configuration = merged
    return { ok: true, transcript: { ...configuration } }
  }
  async function migrate(request) {
    // Identity first, for the same reason as append(): a request with no owner
    // is refused by name before any of its other fields are looked at.
    const key = keyOf(request)
    if (!Array.isArray(request.entries) || request.entries.length > 128) throw new Error('Invalid legacy transcript batch.')
    return enqueue(key, async () => {
      const held = await state(request)
      if (held.metadata?.legacyMigrated) return { ok: true, unchanged: true }
      if (held.metadata?.closed) throw new Error('Closed transcripts cannot be migrated back into active storage.')
      held.revision += 1
      await io.mkdir(held.folder, { recursive: true })
      if (!held.metadata) {
        const initial = { computerId: request.computerId, nodeId: request.nodeId, savedAt: Date.now() }
        await atomic(path.join(held.folder, 'node.json'), initial)
        held.metadata = initial
      }
      const legacyFiles = []
      for (const entry of request.entries) {
        const id = digest(identity(entry.id))
        const filename = held.files.get(id) || String(++held.sequence).padStart(16, '0') + '-' + id + '.json'
        if (!held.files.has(id)) await atomic(path.join(held.folder, filename), entry)
        held.files.set(id, filename)
        legacyFiles.push(filename)
      }
      // Existing canonical metadata wins over an older bounded excerpt.
      const supplied = { ...request.metadata }
      delete supplied.nativeSessionId
      const metadata = { ...supplied, ...held.metadata, computerId: request.computerId, nodeId: request.nodeId,
        savedAt: held.metadata?.savedAt || Date.now(), legacyMigrated: true, legacyFiles, revision: held.revision }
      await atomic(path.join(held.folder, 'node.json'), metadata)
      held.metadata = metadata
      return { ok: true }
    })
  }
  async function shutdown({ deleteNodes = async () => {} } = {}) {
    closing = true
    await Promise.all([...queues.values()])
    if (configuration.deleteNodesOnExit) {
      // Node deletion must succeed before history is discarded.
      await deleteNodes()
      await clearForPrivacy()
    }
    return { ok: true, deleted: configuration.deleteNodesOnExit }
  }
  async function clearForPrivacy() {
    await Promise.all([...queues.values()])
    if ((await io.realpath(active).catch(error => error.code === 'ENOENT' ? active : Promise.reject(error))).toLowerCase() !== active.toLowerCase()) throw new Error('Transcript folder must not be a symbolic link.')
    await io.rm(active, { recursive: true, force: true })
    states.clear()
  }
  return { append, appendText, bindSessionMetadata, migrate, read, list, archive, commitArchive, cancelArchive, rollback, configure, shutdown, clearForPrivacy, getSettings: async () => ({ ok: true, transcript: { ...configuration } }) }
}

module.exports = { createNodeTranscriptStore }
