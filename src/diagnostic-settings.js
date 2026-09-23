/* DIAGNOSTIC FILES, beside the Diagnostic retention row (owner direction
 * 2026-09-20, T782/T783: routine diagnostics are finite by default; Keep and
 * Archive are the person's explicit choices).
 *
 * The retention row chooses the window. This panel is what the window is
 * applied to: the closed diagnostic files this copy has written, each with the
 * three explicit actions the Engine offers (engine src/lib/diagnostic-retention.js,
 * reached through the shell's mcSettings.diagnosticsInspect / Keep / Export /
 * Archive). Nothing here deletes: Keep marks a file as protected from the
 * window, Export copies it to a place the person chooses, Archive moves it out
 * of the live folder into the archive folder the Engine manages.
 *
 * Every answer is read as it came back. A page that could not be read in
 * full says so and names how many files it could not read, because the
 * Engine stops automatic cleanup while any managed file is unreadable; a
 * busy or shutting-down service says that instead of pretending the list is
 * empty; a file still being written keeps its Export and Archive controls
 * disabled with the reason beside them.
 */
import { matchesSettingQuery } from './product-settings-layout.js'
import { formatBytes } from './account-reset-copy.js'
import { focusKeeper } from './focus-keep.js'
import { onDesktop } from './data-source.js'

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/* The Engine's reason codes, in the person's words. Anything not listed is
   shown as it came, so an unexpected code is still a sentence and never a
   blank. */
export const DIAGNOSTIC_REASONS = Object.freeze({
  'no-managed-diagnostics': 'No diagnostic files have been written yet.',
  'diagnostic-root-unavailable': 'The diagnostic folder could not be read, so automatic cleanup is paused until it can be. Nothing was deleted.',
  'diagnostic-candidate-unreadable': 'Some files in the diagnostic folder could not be read. Automatic cleanup is stopped until they can be; nothing was deleted.',
  'diagnostic-busy': 'Another diagnostic operation is still running. Try again in a moment.',
  'diagnostic-active': 'This file is still being written by a running process. Export or archive it after it closes.',
  closed: 'Diagnostic storage is closing with the application. Reopen Settings after the restart.',
  cancelled: 'Export cancelled. Nothing was copied.',
  DIAGNOSTICS_UNAVAILABLE: 'Diagnostic storage is unavailable on this copy, so there is nothing to list.',
  DIAGNOSTIC_REQUEST_INVALID: 'The request was not understood. Reopen Settings and try again.',
})
export const diagnosticReason = (reason, fallback = 'Diagnostic storage did not answer.') =>
  DIAGNOSTIC_REASONS[reason] || (reason ? String(reason) : fallback)

const KIND_WORDS = Object.freeze({
  'main-lag': 'App stall record', 'main-heap': 'Memory record', 'exit-record': 'Exit record',
  'native-decisions': 'Native decision record', 'native-stream': 'Native agent log output',
  'startup-fatal': 'Startup troubleshooting record',
})
const kindWords = kind => KIND_WORDS[kind] || String(kind || 'Diagnostic record')

/* A record whose creation time is not on its sidecar is still listed; the
   file itself says when it was written, so the sentence points there. */
const NO_TIME = 'written at a time the record does not name; open the exported file for its own timestamps'
function whenWords(createdAt) {
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return NO_TIME
  try { return new Date(createdAt).toLocaleString() } catch { return NO_TIME }
}

/* A row's `archive` is the Engine's archive PREFERENCE, stamped on the file
   when it was opened under the Archive choice (createWriter.open): the file is
   still in the live folder, still valid for Keep, Export and Archive, and is
   moved only when the retention window reaches it. A row is said to be moved
   only after this panel's own Archive press was confirmed (`moved`, set here
   from a diagnosticsArchive answer, never from the inspection). */
function stateWords(file, policy) {
  if (file.active) return 'Still being written'
  if (file.moved) return 'Moved to the archive folder'
  if (file.keep) return 'Kept past the retention window'
  // What happens next follows the CURRENT retention choice (T1335), not only
  // the stamp the file got when it was opened.
  if (policy?.mode === 'blocked') return 'Kept while cleanup is paused'
  if (policy?.cleanup === false) return 'Kept with no expiry under your retention choice'
  if (policy?.mode === 'archive' || file.archive) return 'Archives instead of expiring when the retention window reaches it'
  return 'Expires with the retention window'
}

/* WHAT THE FOLDER HELD WHEN IT WAS LAST COUNTED, in the Engine's own terms
   (diagnostic-retention.js inspect spreads status(), whose totals come from
   the last maintenance pass, not from this listing). managedBytes /
   protectedBytes / budgetMet are that pass's complete census and are null --
   never zero -- while it had not finished or this listing met unreadable
   files; projectedBytes is what that pass left after it acted;
   knownManagedBytes / knownProtectedBytes are the part it had counted. An
   unfinished count is only called unreadable when THIS listing reports
   unreadable files (unknownCount); a pass that merely had not reached the end
   of the folder is said to be unfinished. The retention target is the size
   closed files are brought back under over time: files still being written,
   kept files and unreadable files are never removed for it, so the folder can
   sit above it. Keep and Archive have no target at all. */
function storageWords(page) {
  const parts = []
  if (Number.isFinite(page?.managedBytes)) {
    parts.push(`${formatBytes(page.managedBytes)} of diagnostics counted by the last maintenance pass`)
    if (Number.isFinite(page.protectedBytes) && page.protectedBytes > 0) parts.push(`${formatBytes(page.protectedBytes)} of that is kept or still being written`)
    if (Number.isFinite(page.projectedBytes) && page.projectedBytes < page.managedBytes) parts.push(`about ${formatBytes(page.projectedBytes)} after that pass acted`)
  } else if (Number.isFinite(page?.knownManagedBytes) && page.knownManagedBytes > 0) {
    // A known part of zero says nothing worth a sentence; the unread count does.
    parts.push(page?.unknownCount > 0
      ? `at least ${formatBytes(page.knownManagedBytes)} of diagnostics counted by the last maintenance pass; the total is unknown while some files cannot be read`
      : `at least ${formatBytes(page.knownManagedBytes)} of diagnostics counted so far by the last maintenance pass; its total is not known yet`)
    if (Number.isFinite(page.knownProtectedBytes) && page.knownProtectedBytes > 0) parts.push(`at least ${formatBytes(page.knownProtectedBytes)} of that is kept or still being written`)
  }
  if (page?.budgetMet === false) parts.push('above the retention target at that pass; files being written, kept files and unreadable files are never removed to meet it')
  return parts.length ? parts.join('; ') + '.' : ''
}

function targetWords(policy) {
  if (!policy || typeof policy !== 'object') return ''
  if (policy.mode === 'blocked') return policy.reason || 'Diagnostic retention could not be read. Existing files are retained.'
  if (policy.cleanup === false) return 'Your retention choice keeps every diagnostic file, with no storage limit.'
  if (!Number.isFinite(policy.maxBytes) || !Number.isFinite(policy.maxAgeDays)) return ''
  const action = policy.mode === 'archive' ? 'moved to the archive folder' : 'removed'
  return `Closed files are ${action} when they reach ${policy.maxAgeDays} days or when storage exceeds ${policy.maxBytes / (1024 * 1024)} MiB. That is an eventual target for closed files, not a hard limit. Files still being written, kept files and unreadable files can hold the folder above it.`
}

/* writers[] is this application run's own open writers (status().writers),
   so the sum is this run's, not every process's or every closed writer's.
   The file a drop was recorded on carries its own metadata mark
   (outputSuppressed) wherever it is listed, and it need not be on the page
   being shown. So the sentence points at no page: an unrelated older
   suppressed row that happens to be on this page is NOT the writer that just
   dropped, and promising "marked below" would let that old row stand in for
   the current writer's file. The neutral wording is true whether the dropped
   writer's file is on this page, on another page, or (a closed writer aside)
   the same file as a listed mark. */
function droppedWords(page) {
  const dropped = Array.isArray(page?.writers) ? page.writers.reduce((sum, writer) => sum + (Number.isSafeInteger(writer?.dropped) && writer.dropped > 0 ? writer.dropped : 0), 0) : 0
  if (!dropped) return ''
  return `${dropped} diagnostic record${dropped === 1 ? ' was' : 's were'} dropped in this application run after a writer reached its output budget; the work itself continued. A file whose output was cut carries a mark where it appears in this list.`
}

export function createDiagnosticSettings({ bridge = globalThis.window?.mcSettings } = {}) {
  let root, page = null, files = [], notice = '', destroyed = false, loading = false, busy = new Set()
  // An installed copy without the call keeps the 'did not answer' sentence.
  const unsupported = () => typeof bridge?.diagnosticsInspect !== 'function' && !onDesktop()
  const refreshWaiters = []
  function flushSavedRefresh() {
    if (destroyed || loading || busy.size || !refreshWaiters.length) return
    const waiting = refreshWaiters.splice(0)
    void load().finally(() => { for (const resolve of waiting) resolve() })
  }
  function refreshSaved() {
    if (destroyed) return Promise.resolve()
    return new Promise(resolve => {
      refreshWaiters.push(resolve)
      flushSavedRefresh()
    })
  }

  /* ONE THING AT A TIME. A per-file action and a listing (Refresh, Show
     more) never overlap: the listing would replace the rows the action's
     answer belongs to, and the answer would then be applied to a row the
     person can no longer see, or the listing would read the file before the
     action wrote it and paint the older state on top. So the listing
     controls are held while any action is pending, and the action controls
     are held while a listing is in flight; the handlers refuse the same way
     in case a stale button is pressed. A row that this panel moved to the
     archive folder keeps no controls: it is no longer in the live folder. */
  function fileMarkup(file) {
    const id = escape(file.id)
    const held = busy.has(file.id) || loading || file.moved
    const disabledMove = file.active || held
    return `<article class="settings-row" data-diagnostic-file="${id}">
      <div class="settings-copy">
        <div class="settings-name">${escape(kindWords(file.kind))}</div>
        <div class="settings-desc">${escape(whenWords(file.createdAt))} · ${escape(formatBytes(file.bytes))} · ${escape(stateWords(file, page?.policy))}${file.outputSuppressed ? ' · output was cut at the diagnostic budget' : ''}</div>
      </div>
      <div class="settings-control diagnostic-file-actions">
        <button type="button" class="ctl-btn" data-diagnostic-keep="${id}" aria-pressed="${file.keep ? 'true' : 'false'}" ${held ? 'disabled' : ''}>${file.keep ? 'Kept' : 'Keep'}</button>
        <button type="button" class="ctl-btn" data-diagnostic-export="${id}" ${disabledMove ? 'disabled' : ''}>Export…</button>
        <button type="button" class="ctl-btn" data-diagnostic-archive="${id}" ${disabledMove ? 'disabled' : ''}>Archive</button>
      </div>
    </article>`
  }

  /* THE CENSUS IS SAID AS WHAT IT IS. scanComplete (the directory was walked
     to its end) decides whether there is more to show; complete (walked to
     the end AND every managed file read) is the only state in which an empty
     list means an empty folder. A page with unreadable files can still list
     the readable ones; they are listed, and the unread count stands beside
     them. Neither a page nor a partial census is ever called the whole. */
  function listMarkup() {
    if (!page) return `<p>${notice ? escape(notice) : 'Reading diagnostic files…'}</p>`
    const rows = files.map(fileMarkup).join('')
    const unread = page.unknownCount > 0
      ? `<p class="settings-desc" data-diagnostic-unread>${escape(`${page.unknownCount} file${page.unknownCount === 1 ? '' : 's'} in the diagnostic folder could not be read. Automatic cleanup is stopped until they can be; nothing was deleted.`)}</p>`
      : ''
    const census = files.length
      ? `<p class="settings-desc" data-diagnostic-census>${escape(`${files.length} file${files.length === 1 ? '' : 's'} listed${page.scanComplete === false ? ' so far' : ''}${page.unknownCount > 0 ? `, not counting the ${page.unknownCount} that could not be read` : ''}.`)}</p>`
      : ''
    const more = page.scanComplete === false
      ? `<p><button type="button" class="ctl-btn" data-diagnostic-more ${loading || busy.size ? 'disabled' : ''}>Show more files</button> <span class="settings-desc">The list so far is a page, not the whole folder.</span></p>`
      : ''
    const empty = !files.length && page.complete === true && !page.reason ? '<p class="settings-desc">No closed diagnostic files are on this computer right now.</p>' : ''
    const dropped = droppedWords(page) ? `<p class="settings-desc" data-diagnostic-dropped>${escape(droppedWords(page))}</p>` : ''
    const target = targetWords(page.policy) ? `<p class="settings-desc" data-diagnostic-target>${escape(targetWords(page.policy))}</p>` : ''
    return `${storageWords(page) ? `<p class="settings-desc" data-diagnostic-storage>${escape(storageWords(page))}</p>` : ''}${target}${dropped}${rows}${census}${empty}${unread}${more}`
  }

  function markup() {
    /* A BROWSER COPY HAS NO DIAGNOSTIC STORAGE (T1518). It said 'Diagnostic
       storage did not answer.' twice and offered a Refresh that could never
       work. One sentence says where the files live, and there is no Refresh. */
    if (unsupported()) return `<section class="settings-section" data-diagnostic-files><h2 class="settings-section-title">Diagnostic files</h2>
      <p>Diagnostic files are kept and listed in the ToolsEnabled desktop app on your computer.</p></section>`
    return `<section class="settings-section" data-diagnostic-files><h2 class="settings-section-title">Diagnostic files</h2>
      <p>Routine product diagnostics kept on this computer under your Diagnostic retention choice. Keep protects a closed file from the retention window, Export copies it to a place you choose, and Archive moves it to the archive folder. Kept and archived files have no storage limit. Nothing here deletes a file.</p>
      ${listMarkup()}
      <p><button type="button" class="ctl-btn" data-diagnostic-refresh ${loading || busy.size ? 'disabled' : ''}>Refresh</button></p>
      <p role="status" data-diagnostic-notice>${escape(notice)}</p></section>`
  }

  /* The panel is redrawn whole, and Refresh is drawn disabled while it reads:
     the pressed control gets focus back once it is drawn usable again (T1559). */
  const panelFocus = focusKeeper()
  const paint = () => {
    const panel = root?.querySelector('[data-diagnostic-files]')
    if (!panel || destroyed) return
    panelFocus.hold(panel)
    panel.outerHTML = markup()
    panelFocus.restore(root.querySelector('[data-diagnostic-files]'))
  }

  async function load({ next = false } = {}) {
    if (loading || busy.size || destroyed || unsupported()) return
    loading = true
    paint()
    try {
      const result = await bridge?.diagnosticsInspect?.({ next })
      if (destroyed) return
      if (!result || typeof result !== 'object') { notice = diagnosticReason(null); page = page || null }
      else {
        const arrived = Array.isArray(result.files) ? result.files : []
        files = next && page ? [...files, ...arrived] : arrived
        page = result
        notice = result.ok === false ? diagnosticReason(result.reason) : (result.reason ? diagnosticReason(result.reason) : '')
      }
    } catch (error) { if (!destroyed) notice = error?.message || diagnosticReason(null) }
    finally { loading = false; if (!destroyed) { paint(); flushSavedRefresh() } }
  }

  /* An answer is applied to the row that carries its managed id AT THE TIME
     IT ARRIVES (`current`), never to the object the press saw: the rows are
     the person's view of the folder and are replaced by every listing. */
  async function act(id, operation, request, apply) {
    if (busy.has(id) || loading || destroyed) return
    busy.add(id)
    paint()
    try {
      const result = await bridge?.[operation]?.(request)
      if (destroyed) return
      if (result?.ok === true) { notice = ''; apply(result, files.find(item => item.id === id)) }
      else notice = diagnosticReason(result?.reason, `${operation === 'diagnosticsKeep' ? 'The keep mark' : operation === 'diagnosticsExport' ? 'The export' : 'The archive move'} did not happen; diagnostic storage did not answer.`)
    } catch (error) { if (!destroyed) notice = error?.message || diagnosticReason(null) }
    finally { busy.delete(id); if (!destroyed) { paint(); flushSavedRefresh() } }
  }

  function click(event) {
    const button = event.target.closest?.('[data-diagnostic-keep], [data-diagnostic-export], [data-diagnostic-archive], [data-diagnostic-more], [data-diagnostic-refresh]')
    if (!button || !button.closest('[data-diagnostic-files]') || button.disabled) return
    if (button.hasAttribute('data-diagnostic-refresh')) { void load(); return }
    if (button.hasAttribute('data-diagnostic-more')) { void load({ next: true }); return }
    const keepId = button.getAttribute('data-diagnostic-keep')
    if (keepId !== null) {
      const file = files.find(item => item.id === keepId)
      if (!file || file.moved) return
      const keep = !file.keep
      void act(keepId, 'diagnosticsKeep', { id: keepId, keep }, (result, current) => { if (current) current.keep = result.keep === true })
      return
    }
    const exportId = button.getAttribute('data-diagnostic-export')
    if (exportId !== null) {
      void act(exportId, 'diagnosticsExport', { id: exportId }, result => { notice = `Exported to ${result.destination}.` })
      return
    }
    const archiveId = button.getAttribute('data-diagnostic-archive')
    if (archiveId !== null) {
      void act(archiveId, 'diagnosticsArchive', { id: archiveId }, (result, current) => {
        if (current) current.moved = true
        notice = `Moved to the archive folder${result.archivePath ? ` (${result.archivePath})` : ''}.`
      })
    }
  }

  return {
    markup, refreshSaved,
    matches: query => matchesSettingQuery(query, 'diagnostic files retention keep export archive stall memory exit native decision chromium log storage privacy'),
    bind(target) { root = target; root.addEventListener('click', click) },
    afterRender() { if (!page && !loading) void load() },
    destroy() {
      destroyed = true
      for (const resolve of refreshWaiters.splice(0)) resolve()
      root?.removeEventListener('click', click)
    },
    /* For tests and the section's own repaint: the last page as it came back. */
    get page() { return page },
    get files() { return files.map(file => ({ ...file })) },
  }
}
