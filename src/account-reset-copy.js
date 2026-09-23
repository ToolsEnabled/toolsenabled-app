/* WHAT THE PRODUCT SAYS WHEN SOMEBODY WANTS OUT.
 *
 * THIS FILE IS THE WORDS AND THE READING OF THE SHELL'S REPLIES. No DOM, no
 * stylesheet, no closure -- for the same reason src/account-markup.js exists:
 * anything that only lives inside a view can be checked by reading it, and
 * reading is what missed the last three defects on this surface. Every function
 * here can be CALLED by a test with the reply it is afraid of.
 *
 * THE THREE THINGS A PERSON CAN DO HERE, IN ORDER OF WHAT THEY COST:
 *
 *   Sign out              -- ends this sign-in on this computer. Reversible:
 *                            sign in again. Deletes nothing.
 *   Sign out everywhere   -- also refuses any copy of the sign-in taken off this
 *                            computer earlier. Reversible in the same way: the
 *                            account, the settings and the history are untouched
 *                            and the password still works.
 *   Delete everything     -- NOT reversible, and this file never pretends
 *                            otherwise. There is no server holding a copy, no
 *                            recycle bin step, and no undo.
 *
 * THE RULE THE COPY FOLLOWS. Every number and every file name on this screen is
 * MEASURED by shell/local-data-reset.cjs at the moment it is shown, and every
 * outcome sentence is built from what that module re-checked on the disk AFTER
 * it deleted. Nothing here is written from what the product intended to do. A
 * reset screen that says "your data has been deleted" over a vault Windows had
 * open is the single worst sentence this product could print, so `complete` --
 * "nothing remains anywhere" -- is a different fact from `ok` -- "the sweep ran"
 * -- and the sentences for the two do not overlap.
 *
 * AND WHAT IT REFUSES TO CLAIM. Deleting data here does not uninstall the
 * program, does not reach anything that already left this computer, and does not
 * touch the folders the person chose for their own work. Each of those is said
 * out loud, with the measured path where there is one, because the absence of a
 * claim is not a disclosure -- this codebase's signature defect is an absence
 * read as consent, and a person who assumed "delete everything" removed the
 * program would have assumed it from silence.
 */

export const RESET_TITLE = 'Remove this program’s data from the computer you are driving'

export const RESET_LEAD = 'Deleting removes what ToolsEnabled has saved on the computer you are driving: every account on that computer, '
  + 'your saved credentials, the signed record of everything it has done, your settings, and the permission '
  + 'level you chose. It cannot be undone, and it does not uninstall the program.'

/* THE SIGN-OUT SENTENCES ARE HERE TOO, NEXT TO THE DELETE. They used to say only
   what the buttons do; what they do not do is the part somebody acting on a
   stolen laptop needs, and it was nowhere. */
export const SIGN_OUT_TITLE = 'Sign out'
export const SIGN_OUT_DESC = '“Sign out” ends this sign-in on the computer you are driving. “Sign out everywhere” also refuses any '
  + 'saved sign-in taken from that computer earlier — use it if you think a copy of it exists.'
/* THIS SAID "the same password signs you back in", FLATLY, TO EVERYBODY.
 *
 * It is rendered on the same screen where a Google account is told, correctly,
 * "Google checked that address, so there is no password here to change". So a
 * Google account read both sentences at once, and the one next to the Sign out
 * button named a credential they do not have. They are not locked out -- Google
 * sign-in still works -- but the instruction beside the button is wrong for
 * them, and it is the sentence somebody acting on a stolen laptop reads before
 * pressing it.
 *
 * A FUNCTION, not two constants, because account-markup.js already branches on
 * state.signInMethod for the rename row twenty lines away and got it right
 * there. One shape for one question. */
export function signOutLimits(signInMethod) {
  /* THREE CASES, NOT TWO. A caller that does not know the method must not have
     one guessed for it: naming either credential would be wrong for half of the
     people who read it, which is the defect this function exists to close. */
  const backIn = signInMethod === 'google'
    ? 'signing in with Google again brings you straight back'
    : signInMethod === 'password'
      ? 'the same password signs you back in'
      : 'signing in again brings you straight back'
  return 'Neither one deletes anything: your account, your settings and your history stay '
    + `exactly as they are, and ${backIn}. There is no server involved — an account here `
    + 'exists only on the computer you are driving, so “everywhere” means every copy of that computer’s sign-in.'
}

/* Kept for callers that have no method to hand. Method-neutral on purpose: a
   default naming either credential would be wrong for half of them. */
export const SIGN_OUT_LIMITS = signOutLimits(null)

export const DELETE_BUTTON = 'Show me what would be deleted'
export const DELETE_CONFIRM_BUTTON = 'Delete it all now'
export const DELETE_CANCEL_BUTTON = 'Leave it alone'
export const DELETE_CLOSE_BUTTON = 'Close ToolsEnabled'

export const NO_BRIDGE_TITLE = 'This page cannot delete anything.'
export const NO_BRIDGE_DETAIL = 'This browser is not connected to the installed application that removes its data, so the '
  + 'controls on this screen are unavailable. Data can only be removed from inside ToolsEnabled on the computer you are driving.'

/* Said BEFORE the second press, because after it there is nothing to save. */
export const BACKUP_NOTICE = 'There is no undo and no copy anywhere else. If you want one, copy the folders named '
  + 'above somewhere safe on the computer you are driving before continuing.'

/* WHAT IS NOT DELETED. Written as claims this build can stand behind, each with
   the reason it survives, and deliberately not as reassurance. */
export const SURVIVES = Object.freeze([
  {
    title: 'The program itself',
    detail: 'This empties the data. It does not uninstall ToolsEnabled. On the computer you are driving, remove the '
      + 'program in Windows Settings → Apps → Installed apps, the same way you remove anything else.',
  },
  {
    title: 'Your own files',
    /* Kept as ONE string literal on purpose: the promise register in
       tools/test/product-account-surface.test.mjs matches a claim by substring
       against the source, and a sentence split across a concatenation is a
       sentence the register cannot pin. */
    detail: 'The folders you chose for your assistant to work in are yours. Nothing in them is opened, moved or deleted here, including work your assistant did in them.',
  },
  {
    title: 'Anything that already left this computer',
    detail: 'Mail that was sent, a file that was uploaded, work started on a service that is not the computer you are driving, or a '
      + 'Google account you signed in with — deleting here cannot reach any of it and does not undo it. If you '
      + 'signed in with Google, remove this program’s access in your Google account as well.',
  },
  {
    title: 'Copies you made yourself',
    detail: 'Anything you exported, saved or screenshotted elsewhere is outside these folders and stays where you '
      + 'put it.',
  },
])

/* The survivor list is also read through the relay. Keep the desk copy as the
   canonical table, and give only the verified desk-bound entry a remote twin;
   the other entries already describe the driven computer correctly. */
export const RESET_SUBJECT_HERE = 'this computer'
export const RESET_SUBJECT_REMOTE = 'the computer you are driving'

const REMOTE_SURVIVES = Object.freeze(SURVIVES.map((entry, index) => Object.freeze({
  ...entry,
  title: index === 2 ? 'Anything that already left the computer you are driving' : entry.title,
})))

/* The uninstall sentence belongs to the TARGET named by the reset surface.
 * A local renderer can pass its own target platform. A remote renderer must
 * not infer one from the driver's process, so a missing target stays neutral.
 * The legacy SURVIVES export remains unchanged for callers that consume the
 * source register directly; this function is the platform-aware view. */
function targetPlatform(platform) {
  return typeof platform === 'string' && platform ? platform : null
}

function removalDetail({ subject = RESET_SUBJECT_HERE, platform } = {}) {
  const target = subject === RESET_SUBJECT_REMOTE ? 'the computer you are driving' : 'this computer'
  const dataFact = 'This empties the data. It does not uninstall ToolsEnabled.'
  if (platform === 'win32') {
    return `${dataFact} On ${target}, remove the program in Windows Settings → Apps → Installed apps, the same way you remove anything else.`
  }
  return `${dataFact} Remove the program the way you installed it on ${target}; this only deletes data saved by ToolsEnabled.`
}

function removalOutcomeDetail({ subject = RESET_SUBJECT_HERE, platform } = {}) {
  const target = subject === RESET_SUBJECT_REMOTE ? 'the computer you are driving' : 'this computer'
  if (platform === 'win32') {
    return `The program itself is still installed — remove it through Windows Settings → Apps on ${target}.`
  }
  return `The program itself is still installed — remove it the way you installed it on ${target}; this only deletes data saved by ToolsEnabled.`
}

export function survivesLines({ subject = RESET_SUBJECT_HERE, platform } = {}) {
  const entries = subject === RESET_SUBJECT_REMOTE ? REMOTE_SURVIVES : SURVIVES
  const target = targetPlatform(platform)
  return entries.map((entry, index) => index === 0
    ? { ...entry, detail: removalDetail({ subject, platform: target }) }
    : entry)
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes'
  const megabytes = bytes / (1024 * 1024)
  if (megabytes >= 0.1) return `${megabytes.toFixed(2)} MB`
  const kilobytes = bytes / 1024
  if (kilobytes >= 1) return `${kilobytes.toFixed(1)} KB`
  return `${Math.round(bytes)} bytes`
}

/* The one place that names a root, so the screen and the result cannot call the
   same directory two different things. */
export const ROOT_LABELS = Object.freeze({
  'user-data': 'What this program saved for you',
  installation: 'This installation’s own settings',
  'earlier-name': 'Data from this program’s earlier name',
})

export function rootLabel(kind) {
  return ROOT_LABELS[kind] || 'Saved data'
}

/**
 * The shell's plan, read defensively.
 *
 * EVERY FIELD IS CHECKED, and an unrecognised reply becomes `available: false`
 * with a stated reason rather than an empty plan. An empty plan renders as
 * "there is nothing here to delete", which is a claim about somebody's vault,
 * and it must never be reachable from a reply this page did not understand.
 */
export function readPlan(reply) {
  const refused = reason => ({ available: false, reason, roots: [], totals: { files: 0, bytes: 0 }, untouched: [], conflicts: [] })
  if (!reply || typeof reply !== 'object') return refused('The installed application did not answer.')
  if (reply.ok !== true) {
    return refused(typeof reply.reason === 'string' && reply.reason ? reply.reason : 'The installed application refused to look.')
  }
  if (!Array.isArray(reply.roots)) return refused('The installed application answered with no list of folders.')
  const roots = reply.roots.map(root => ({
    kind: typeof root?.kind === 'string' ? root.kind : 'user-data',
    directory: typeof root?.directory === 'string' ? root.directory : '',
    guarded: root?.guarded === true,
    present: root?.present === true,
    files: Number.isSafeInteger(root?.files) ? root.files : 0,
    bytes: Number.isSafeInteger(root?.bytes) ? root.bytes : 0,
    named: Array.isArray(root?.named)
      ? root.named.filter(entry => entry && typeof entry.what === 'string').map(entry => ({ what: entry.what, rel: typeof entry.rel === 'string' ? entry.rel : '' }))
      : [],
    refusal: root?.refusal && typeof root.refusal.reason === 'string' ? { reason: root.refusal.reason } : null,
  }))
  const directoryList = value => (Array.isArray(value)
    ? value.filter(entry => entry && typeof entry.directory === 'string' && entry.directory)
      .map(entry => ({ kind: typeof entry.kind === 'string' ? entry.kind : 'other', directory: entry.directory }))
    : [])
  const untouched = directoryList(reply.untouched)
  /* A folder the person chose for their own work that sits INSIDE what is about
     to be deleted. Read separately from `untouched` because the screen says
     opposite things about the two, and a missing field must not silently become
     "there are none": an absent list here reads as an empty one, so the shell
     always sends it. */
  const conflicts = directoryList(reply.conflicts)
  return {
    available: true,
    roots,
    untouched,
    conflicts,
    totals: {
      files: Number.isSafeInteger(reply?.totals?.files) ? reply.totals.files : roots.reduce((sum, root) => sum + root.files, 0),
      bytes: Number.isSafeInteger(reply?.totals?.bytes) ? reply.totals.bytes : roots.reduce((sum, root) => sum + root.bytes, 0),
    },
  }
}

/**
 * One line per root, measured.
 *
 * A ROOT THIS BUILD WOULD NOT LOOK AT GETS A LINE OF ITS OWN, saying it will not
 * be deleted. A copy with no capability payload cannot work out where its
 * installation folder is, and the honest thing on that screen is "this folder
 * was not found, so it stays" -- not a shorter list.
 */
export function planLines(plan) {
  const lines = []
  for (const root of plan.roots || []) {
    if (!root.guarded) {
      lines.push({
        tone: 'warn',
        title: rootLabel(root.kind),
        detail: `This copy could not work out where this is${root.refusal ? ` (${root.refusal.reason})` : ''}, so it is NOT deleted and nothing about it is claimed here.`,
        directory: root.directory || '',
      })
      continue
    }
    if (!root.present) {
      lines.push({ tone: 'quiet', title: rootLabel(root.kind), detail: 'There is nothing here on the computer you are driving.', directory: root.directory })
      continue
    }
    const named = root.named.length > 0 ? ` They include ${root.named.map(entry => entry.what).join(', ')}.` : ''
    lines.push({
      tone: 'serious',
      title: rootLabel(root.kind),
      detail: `${root.files} file${root.files === 1 ? '' : 's'} (${formatBytes(root.bytes)}) would be deleted.${named}`,
      directory: root.directory,
    })
  }
  return lines
}

/**
 * The result, read from what the shell measured after it deleted.
 *
 * `complete` IS NOT `ok`. `ok` means the sweep ran. `complete` means nothing is
 * left, and it is the only thing that may produce the sentence a person will
 * read as "it is gone".
 */
export function readSweep(reply) {
  const replyKnown = Boolean(reply && typeof reply === 'object' && !Array.isArray(reply)
    && typeof reply.ok === 'boolean')
  const browser = replyKnown ? reply.browserStorage : null
  const browserStorage = browser && typeof browser === 'object' && !Array.isArray(browser)
    && typeof browser.attempted === 'boolean' && typeof browser.cleared === 'boolean'
    && (!browser.cleared || browser.attempted)
    ? {
        attempted: browser.attempted,
        cleared: browser.cleared,
        ...(typeof browser.reason === 'string' && browser.reason ? { reason: browser.reason } : {}),
      }
    : null
  const reason = replyKnown && typeof reply.reason === 'string' && reply.reason
    ? reply.reason : null
  if (!replyKnown || reply.ok !== true) {
    return {
      ran: false,
      complete: false,
      reason,
      browserStorage,
      deletionNotStarted: replyKnown && reply.ok === false && !reply.swept
        && browserStorage?.attempted === false && browserStorage.cleared === false,
      roots: [],
      remainingFiles: 0,
      revoked: false,
    }
  }
  const swept = reply.swept && typeof reply.swept === 'object' ? reply.swept : {}
  const results = Array.isArray(swept.results) ? swept.results : []
  return {
    ran: swept.ok === true,
    complete: swept.ok === true && swept.complete === true,
    reason,
    browserStorage,
    deletionNotStarted: false,
    /* `revoked.ok` MEANS THE REVOCATION STEP RAN, NOT THAT ANY SESSION WAS ENDED.
       That distinction is the module-level rule of shell/local-data-reset.cjs --
       "`ok` here means the sweep ran, NEVER everything is gone" -- enforced there
       for `swept` and dropped here. Both facts are kept; the copy must say which
       one it means. */
    revoked: reply?.revoked?.ok === true,
    revokedSessions: reply?.revoked?.revokedSessions === true,
    /* THE CANONICAL LEDGER OUTCOME. shell/main.cjs computes this so this screen
       can account for a survivor it would otherwise have no explanation for, and
       the reader threw it away -- so the one file most likely to be left behind
       was the one the product had decided, in writing, it must explain. */
    ledgerClosed: reply?.ledgerClosed?.closed === true,
    ledgerCloseRan: reply?.ledgerClosed?.ok === true,
    ledgerCloseReason: typeof reply?.ledgerClosed?.reason === 'string' ? reply.ledgerClosed.reason : null,
    remainingFiles: Number.isSafeInteger(swept.remainingFiles) ? swept.remainingFiles : 0,
    remainingBytes: Number.isSafeInteger(swept.remainingBytes) ? swept.remainingBytes : 0,
    roots: results.map(result => ({
      kind: typeof result?.kind === 'string' ? result.kind : 'user-data',
      /* WAS THIS FOLDER EVEN OPENED. A root the guard refused, or one that could
         not be read, comes back ok:false with no `remaining` -- so it contributes
         ZERO to remainingFiles while making `complete` false. Dropping this is what
         let the screen say "0 files could not be deleted ... because Windows had
         them open" about a folder nothing had looked inside. */
      swept: result?.ok === true,
      absent: result?.absent === true,
      reason: typeof result?.reason === 'string' && result.reason ? result.reason : null,
      directory: typeof result?.directory === 'string' ? result.directory : '',
      removedRoot: result?.removedRoot === true,
      kept: Array.isArray(result?.entries)
        ? result.entries.filter(entry => entry && entry.removed !== true && typeof entry.name === 'string').map(entry => ({
          name: entry.name,
          reason: typeof entry.reason === 'string' && entry.reason ? entry.reason : 'Windows did not say why.',
        }))
        : [],
      removedCount: Array.isArray(result?.entries) ? result.entries.filter(entry => entry && entry.removed === true).length : 0,
      remainingFiles: Number.isSafeInteger(result?.remaining?.files) ? result.remaining.files : 0,
    })),
  }
}

/**
 * What to say afterwards, including a browser clear that preceded the sweep.
 *
 * The middle one -- the sweep ran and something is still there -- is the case a
 * two-branch version collapses into "done", and it is the REAL case on Windows:
 * the window this is being read in holds its own browser files open, and those
 * files are inside the same directory. So it gets its own sentence, it names the
 * count, and it tells the person what to do about it.
 */
export function outcomeLines(sweep, { subject = RESET_SUBJECT_HERE, platform } = {}) {
  const target = targetPlatform(platform)
  if (!sweep.ran) {
    const browser = sweep.browserStorage
    const reason = sweep.reason || browser?.reason
    if (browser?.attempted === true && browser.cleared === true) {
      return {
        tone: 'bad',
        title: 'Browser settings were cleared.',
        detail: 'The application did not confirm erasing the remaining saved files. '
          + (reason || 'Restart ToolsEnabled before trying again.'),
      }
    }
    if (browser?.attempted === true) {
      return {
        tone: 'bad',
        title: 'Deletion could not be confirmed.',
        detail: 'Some browser settings may have been deleted. '
          + (reason || 'Restart ToolsEnabled before trying again.'),
      }
    }
    if (sweep.deletionNotStarted === true) {
      return {
        tone: 'bad',
        title: 'Nothing was deleted.',
        detail: reason || 'The application refused this request before deleting any data, so nothing was removed. Restart ToolsEnabled and try again.',
      }
    }
    return {
      tone: 'bad',
      title: 'Deletion could not be confirmed.',
      detail: reason || 'The application did not confirm whether anything was deleted. Restart ToolsEnabled before trying again.',
    }
  }
  if (sweep.complete) {
    return {
      tone: 'good',
      title: 'It is gone.',
      detail: `Every file this program had saved on the computer you are driving was removed, checked one by one after deleting.${
        /* revokedSessions, NOT revoked. `revoked` only says the step RAN. Somebody
           wiping a laptop they believe is compromised is exactly the person who
           presses this, and telling them every copied sign-in is now refused when no
           epoch was bumped is precisely why they would stop worrying. Same defect as
           the "Sign out everywhere" button beside it, which was fixed hours earlier. */
        sweep.revokedSessions
          ? ' Every sign-in was ended first, including any copy taken off that computer.'
          : sweep.revoked
            ? ' No sign-in was active, so none had to be ended; any copy taken off that computer is unchanged.'
            : ''
      } ${removalOutcomeDetail({ subject, platform: target })}`,
    }
  }
  /* TWO DIFFERENT INCOMPLETE OUTCOMES, AND ONLY ONE OF THEM IS OPEN FILES.
     A root the guard refused, or one that could not be read, comes back with no
     `remaining` -- so it adds ZERO to remainingFiles while making `complete`
     false. This branch was reachable in that state and printed "0 files could
     not be deleted while the program is running, because Windows had them open.
     They are named below": a count that is zero, a cause that is wrong, a list
     that is empty, and a remedy naming no folder. The person was told almost
     everything went and handed nothing to act on, with their installation
     settings still on disk. */
  const unopened = (sweep.roots || []).filter(root => !root.swept && !root.absent)
  if (sweep.remainingFiles === 0 && unopened.length > 0) {
    const named = unopened.map(root => root.directory).filter(Boolean)
    const said = unopened.find(root => root.reason)
    return {
      tone: 'warn',
      title: 'Some of it could not be reached.',
      detail: `${unopened.length} folder${unopened.length === 1 ? '' : 's'} could not be opened, so nothing in `
        + `${unopened.length === 1 ? 'it' : 'them'} was deleted and what is there is exactly as it was. `
        + (named.length
          ? `${named.length === 1 ? 'It is' : 'They are'}: ${named.join(', ')}. `
          : 'The application did not say which folder. ')
        + (said ? `Windows said: ${said.reason}. ` : '')
        + 'Everything else this program had saved was removed.',
    }
  }
  return {
    tone: 'warn',
    title: 'Almost all of it is gone.',
    detail: `${sweep.remainingFiles} file${sweep.remainingFiles === 1 ? '' : 's'} could not be deleted while the program `
      + 'is running, because Windows had them open. They are named below with the folder they are in. Closing '
      + 'ToolsEnabled on the computer you are driving releases them, and deleting that folder on that computer finishes the job.'
    /* AND NAME THE LEDGER IF IT IS ONE OF THEM. shell/main.cjs closes the
       canonical ledger before the sweep and reports whether it closed, precisely
       so this screen can account for a survivor. When it did not close, the
       ledger file is the likeliest thing still on disk and the person otherwise
       has no idea which of the named files matters. */
    + (sweep.ledgerCloseRan && !sweep.ledgerClosed
      ? ` One of them is this program's own record, which was still in use`
        + `${sweep.ledgerCloseReason ? ` (${sweep.ledgerCloseReason})` : ''}`
        + '; it is released when the program closes.'
      : ''),
  }
}
