'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createEditorSessionSources } = require('./editor-session-source.cjs')

// Settings and the observer use the engine's existing consent file. This
// Discovery returns metadata. An explicit attachment is a separate receipt-
// bound operation; the default import policy never starts or reads a chat.
function createIdeSessionSettings({ root, home, accountRoot = home, consent, writer, observer, accountForSource, sourceHomes = () => [] }) {
  const profile = path.resolve(accountRoot), userHome = path.resolve(home)
  const sources = createEditorSessionSources({ home: profile, accountForSource, isIncluded(observation) {
    const saved = writer.readConsentState(root)
    return saved.ok === true && consent.partitionObservedSessions([observation], saved).imported.length === 1
  } })
  function checked(candidate) {
    const resolved = path.resolve(candidate)
    const relative = path.relative(profile, resolved)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Editor discovery must stay inside this account.')
    let current = profile
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part)
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Editor discovery cannot follow linked folders.') }
      catch (error) { if (error.code === 'ENOENT') break; throw error }
    }
    return resolved
  }
  checked(userHome)
  function read({ discover = false, policyOnly = false, owner = null, selectedSessionIds } = {}) {
    if (selectedSessionIds !== undefined && (!Array.isArray(selectedSessionIds) || !selectedSessionIds.length
        || selectedSessionIds.length > 8 || selectedSessionIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))) {
      throw new Error('Choose between one and eight saved session identifiers.')
    }
    const saved = writer.readConsentState(root)
    if (!saved.ok) return { ok: false, reason: saved.reason }
    if (policyOnly === true || (!discover && saved.importPolicy === 'none' && saved.importedSurfaces.length === 0)) {
      return { ok: true, importPolicy: saved.importPolicy, importedSurfaces: saved.importedSurfaces,
        excludedSurfaces: saved.excludedSurfaces, discovery: 'not-requested', surfaces: [], imported: [] }
    }
    const allHomes = [{ provider: 'claude', home: path.join(userHome, '.claude') },
      { provider: 'codex', home: path.join(userHome, '.codex') }, ...sourceHomes()]
    const unique = new Map()
    for (const entry of allHomes) {
      if (!['claude', 'codex'].includes(entry?.provider) || typeof entry.home !== 'string') continue
      const resolved = checked(entry.home)
      const key = `${entry.provider}:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`
      unique.set(key, { provider: entry.provider, home: resolved })
    }
    const homes = [...unique.values()].slice(0, 20)
    const observations = []
    let remainingFiles = 40
    for (const entry of homes) {
      if (remainingFiles <= 0) break
      const observed = observer.observeAgentSessions({ home: profile, providers: [entry.provider],
        claudeRoot: checked(path.join(entry.home, 'projects')),
        codexRoot: checked(path.join(entry.home, 'sessions')),
        ...(selectedSessionIds ? { selectedSessionIds } : {}),
        maxFiles: selectedSessionIds ? Math.min(selectedSessionIds.length, remainingFiles) : Math.max(1, Math.floor(40 / homes.length)),
        onSource: (file, session) => sources.capture(file, session, entry.home) })
      observations.push(observed)
      remainingFiles -= (observed.scans || []).reduce((sum, scan) => sum + (scan.filesRead || 0), 0)
    }
    if (observations.some(result => !Array.isArray(result?.sessions)
        || result.sessions.some(session => !session || !['claude', 'codex'].includes(session.provider)))) {
      return { ok: false, reason: 'Editor session discovery could not be read.' }
    }
    const observation = { sessions: [...new Map(observations.flatMap(result => result.sessions).map(session => [session.sourceRef || `${session.provider}:${session.sessionId}`, session])).values()],
      coverage: unique.size > observations.length || observations.some(result => result.coverage !== 'complete') ? 'partial' : 'complete',
      coverageNotes: observations.flatMap(result => result.coverageNotes || []) }
    if (observations.every(result => result.coverage === 'unavailable')) observation.coverage = 'unavailable'
    if (unique.size > homes.length) observation.coverageNotes.push('The configured provider home limit was reached; some homes were not scanned.')
    if (observations.length < homes.length) observation.coverageNotes.push('The saved-session lookup reached its file limit; some homes were not scanned.')
    const split = consent.partitionObservedSessions(observation.sessions, saved)
    return { ok: true, importPolicy: saved.importPolicy, importedSurfaces: saved.importedSurfaces,
      excludedSurfaces: saved.excludedSurfaces, discovery: observation.coverage,
      ...(selectedSessionIds ? { selectedSessionIds, missingSessionIds: selectedSessionIds.filter(id => !observation.sessions.some(session => session.sessionId?.toLowerCase() === id.toLowerCase())) } : {}),
      notes: observation.coverageNotes || [], surfaces: split.offeredSurfaces,
      imported: split.imported.map(session => ({ provider: session.provider, surface: session.consentKey,
        sessionId: session.sessionId, model: session.model, effort: session.effort, observedAtMs: session.observedAtMs,
        workspace: session.workspace, sourceRef: session.sourceRef, receipt: sources.issue(session, owner),
        capabilities: { mirror: true, fork: session.kind !== 'subagent', adopt: false },
        forkUnavailableReason: session.kind === 'subagent' ? 'A provider subagent record is not a complete conversation to copy.' : null })) }
  }
  function setPolicy(policy) {
    const result = writer.setImportPolicy(root, policy)
    return result.ok ? { ok: true, importPolicy: result.importPolicy } : result
  }
  function setSurface(surface, imported) {
    if (typeof surface !== 'string' || !consent.SURFACE_RE.test(surface) || typeof imported !== 'boolean') throw new Error('Choose an editor surface and whether to include it.')
    if (imported) {
      const current = read({ discover: true })
      if (!current.ok) return current
      if (!current.surfaces.some(row => row.surface === surface)) return { ok: false, reason: 'This editor surface is no longer present. Check for editor sessions again.' }
    }
    const result = imported ? writer.importSurface(root, surface) : writer.removeSurface(root, surface)
    return result.ok ? { ok: true, surface, imported } : result
  }
  return { read, setPolicy, setSurface, preview: sources.preview, prepareFork: sources.prepareFork,
    redeemFork: sources.redeemFork, adopt: sources.adopt }
}

module.exports = { createIdeSessionSettings }
