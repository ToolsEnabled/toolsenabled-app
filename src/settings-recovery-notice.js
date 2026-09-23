/* THE HALF OF THE FIX A PERSON CAN ACTUALLY SEE.
 *
 * shell/renderer-prefs.cjs stopped a settings file it cannot read from being
 * replaced: the unreadable bytes are moved to a dated copy and nothing is
 * destroyed. That closed the data loss and, by itself, changed nothing the
 * person experiences. They still open an application wearing none of the
 * choices they made, with no error and no explanation, which is precisely the
 * silent factory reset the whole store exists to end. A recovery nobody is told
 * about is indistinguishable from the loss it replaced -- and worse, it is
 * indistinguishable to US too, because the person's next move is to redo every
 * setting on top of defaults instead of asking for the file back.
 *
 * SO THIS SAYS THREE THINGS, and it is deliberately all three:
 *   WHY the app is showing defaults -- the reason the file could not be read.
 *   THAT nothing was deleted -- the sentence that stops a person concluding
 *     their data is gone, which is the conclusion they will otherwise reach.
 *   WHERE the file is -- an exact path, because "we kept a backup" that does
 *     not say where is a promise a person cannot act on.
 *
 * WHY THE PATH CHANGES WHILE THE WINDOW IS OPEN. The unreadable file is only
 * moved aside when a write happens, which is deliberate: a file that was only
 * transiently unreadable gets recovered intact by the next launch's retrying
 * read, and moving it eagerly would displace a record that was never damaged.
 * So this opens saying the file is still in place, and updates itself to the
 * dated copy the moment a write moves it. Both sentences are true when they are
 * shown, which is the property that matters -- a notice that promises where a
 * file WILL go is making a claim about the future.
 *
 * IT IS DISMISSIBLE, AND THE DISMISSAL IS NOT SAVED. A banner that cannot be
 * closed is hostile, and this one cannot be honestly persisted anyway: the only
 * place to persist it is the settings file that could not be read. So it goes
 * away for this window and returns next launch while the condition holds, which
 * is the correct behaviour rather than a limitation -- an unresolved data-loss
 * event should keep asking.
 *
 * TEXT IS SET AS TEXT. Every string here can contain a filesystem path chosen
 * by no one on this team, so nothing is built by string-concatenating markup.
 *
 * ONE MORE FACT RIDES THIS BAR, BELOW EVERY SETTINGS PROBLEM: that the previous
 * run left no shutdown record (src/last-exit-notice.js). It is a fact about
 * this WINDOW's start in the same way, and a second fixed bar at the same edge
 * would cover this one.
 */
import { lastExitNotice } from './last-exit-notice.js'

/* The reason strings from the store are sentence fragments ("the settings file
   contains malformed JSON"). Presented alone they read as an accusation with no
   consequence attached, so each notice states the consequence first and the
   reason second. */
export function settingsRecoveryNotice(state) {
  if (state && state.code === 'SETTINGS_NOTICE_READ_FAILED') {
    const cause = typeof state.causeCode === 'string' && state.causeCode ? ` (${state.causeCode})` : ''
    return {
      kind: 'unavailable',
      code: 'SETTINGS_NOTICE_READ_FAILED',
      heading: 'Your saved settings could not be checked',
      body: `The application could not check the saved-settings status${cause}. This does not mean the settings file is absent; the machine could not tell. Try again when the machine is less busy.`,
      pathLabel: null,
      path: null,
    }
  }

  // A refused change needs a fresh notice even after startup damage was dismissed.
  const refused = state && state.refused && typeof state.refused === 'object' ? state.refused : null
  if (refused?.category === 'recovery') {
    return {
      kind: 'refused', code: refused.code,
      heading: 'Your recovery checkpoint was not saved',
      body: refused.code === 'RECOVERY_RECORD_TOO_LARGE'
        ? 'The full recovery checkpoint exceeds its size limit. The previous saved checkpoint was kept. Recovery cannot continue until the full checkpoint can be saved.'
        : 'The recovery checkpoint could not be written. The previous saved checkpoint was kept. Recovery cannot continue until the full checkpoint can be saved.',
      pathLabel: null, path: null,
    }
  }
  if (refused) {
    const key = typeof refused.key === 'string' && refused.key ? refused.key : 'that setting'
    const action = refused.action === 'remove' ? 'removed' : 'saved'
    const full = refused.code === 'MC_PREFS_TOO_LARGE'
    return {
      kind: 'refused',
      code: typeof refused.code === 'string' ? refused.code : null,
      heading: `Your change to ${key} was not ${action}`,
      body: full
        ? `${key} could not be ${action} because the settings file would exceed its size limit. This change was not saved. Existing saved settings were kept.`
        : `${key} could not be ${action}: ${typeof refused.message === 'string' && refused.message ? refused.message : 'the settings file could not be written'}. This change was not saved. Existing saved settings were kept.`,
      pathLabel: state.preservedAt ? 'The previous settings file was kept at' : (state.file ? 'Your settings file is at' : null),
      path: state.preservedAt || state.file || null,
    }
  }

  const damaged = state && typeof state.damaged === 'string' && state.damaged ? state.damaged : null
  const preservedAt = state && typeof state.preservedAt === 'string' && state.preservedAt ? state.preservedAt : null
  const file = state && typeof state.file === 'string' && state.file ? state.file : null
  if (!damaged && !preservedAt) return lastExitNotice(state && state.lastExit)

  const reason = damaged || 'the settings file could not be read'

  if (preservedAt) {
    return {
      kind: 'preserved',
      heading: 'Your saved settings could not be read',
      /* Past tense throughout: by the time this renders, the move has happened
         and been confirmed by the write that caused it. */
      body: `This window started from the default settings because ${reason}. Nothing was deleted — the file that could not be read was kept, unchanged, as a dated copy.`,
      pathLabel: 'The unreadable file was kept at',
      path: preservedAt,
    }
  }

  return {
    kind: 'damaged',
    heading: 'Your saved settings could not be read',
    body: `This window is showing the default settings because ${reason}. Nothing has been deleted. Your settings file is still where it was, and the next setting you change will move it aside as a dated copy rather than write over it.`,
    pathLabel: file ? 'Your settings file is at' : null,
    path: file,
  }
}

/* Built element by element rather than from a markup string. See the header:
   `path` is a filesystem path, and a filesystem path is not this module's text
   to trust. */
function buildElement(doc, notice) {
  const root = doc.createElement('div')
  root.className = 'settings-recovery'
  root.setAttribute('data-settings-recovery', notice.kind)
  /* Polite rather than assertive. It is present at load and updates once; an
     assertive region would interrupt a screen-reader user mid-sentence for
     something that is not urgent in the seconds sense. */
  root.setAttribute('role', 'status')

  const heading = doc.createElement('b')
  heading.className = 'settings-recovery-heading'
  heading.textContent = notice.heading
  root.appendChild(heading)

  const body = doc.createElement('span')
  body.className = 'settings-recovery-body'
  body.textContent = notice.body
  root.appendChild(body)

  if (notice.path) {
    const where = doc.createElement('span')
    where.className = 'settings-recovery-path'
    const label = doc.createElement('span')
    label.textContent = `${notice.pathLabel}: `
    const code = doc.createElement('code')
    code.textContent = notice.path
    where.appendChild(label)
    where.appendChild(code)
    root.appendChild(where)
  }

  const dismiss = doc.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'settings-recovery-dismiss'
  dismiss.setAttribute('aria-label', notice.dismissLabel || 'Dismiss the settings notice for this window')
  dismiss.textContent = 'Dismiss'
  root.appendChild(dismiss)

  return { root, dismiss }
}

/**
 * Put the notice on the page and keep it current.
 *
 * `source` is window.mcPrefsNotice, which public/durable-storage.js exposes and
 * which does not exist in a plain browser -- under `vite dev` there is no shell,
 * no settings file and nothing to report, so this mounts nothing rather than
 * inventing a state. Returns a handle for tests; the application ignores it.
 */
export function mountSettingsRecoveryNotice({
  doc = typeof document === 'undefined' ? null : document,
  source = typeof window === 'undefined' ? null : window.mcPrefsNotice,
  container = null,
} = {}) {
  if (!doc || !source || typeof source.read !== 'function') return null

  let element = null
  let dismissed = false
  /* The exit sentence is dismissed ONCE for the window. A later settings refusal
     re-arms this bar for settings (below); when that refusal clears, the state
     falls through to the exit sentence again, and a sentence the person already
     dismissed must not come back hours later. */
  let exitDismissed = false
  let lastRefusal = null
  let unsubscribe = () => {}

  const host = () => container || doc.body
  const remove = () => {
    if (element && element.parentNode) element.parentNode.removeChild(element)
    element = null
  }

  function render(state) {
    if (state?.refused && state.refused !== lastRefusal) dismissed = false
    lastRefusal = state?.refused || null
    if (dismissed) return
    const found = settingsRecoveryNotice(state)
    const notice = found && found.kind === 'last-exit' && exitDismissed ? null : found
    remove()
    if (!notice) return
    const built = buildElement(doc, notice)
    built.dismiss.addEventListener('click', () => {
      dismissed = true
      if (notice.kind === 'last-exit') exitDismissed = true
      remove()
    })
    element = built.root
    const target = host()
    if (target) target.appendChild(element)
  }

  /* A bridge failure says nothing about whether a settings file exists. Keep
     it distinct from the null state that positively means there is no recovery
     notice, and retain only a safe errno-shaped label for the explanation. */
  const readFailure = (error) => ({
    code: 'SETTINGS_NOTICE_READ_FAILED',
    causeCode: error && typeof error.code === 'string' && error.code ? error.code : 'UNKNOWN',
  })

  let latest
  try { latest = source.read() } catch (error) { latest = readFailure(error) }
  render(latest)

  if (typeof source.subscribe === 'function') {
    /* A subscription that throws must not take the page down. This module is an
       explanation; failing loudly here would cost the person the app as well as
       their settings. */
    try { unsubscribe = source.subscribe(render) || (() => {}) } catch (error) { unsubscribe = () => {} }
  }

  return {
    element: () => element,
    /* Always read again: an unavailable result is transient evidence and must
       never become the answer for the rest of the window. */
    refresh: () => { try { render(source.read()) } catch (error) { render(readFailure(error)) } },
    destroy: () => { try { unsubscribe() } catch (error) { /* already gone */ } remove() },
  }
}
