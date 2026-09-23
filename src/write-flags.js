import { PROFILE_SCHEMA_VERSION, PROFILE_STORAGE_KEY, deriveProfile } from './setup-profile.js'

export const WRITE_FLAGS_EVENT = 'mc:write-flags-changed'

export const WRITE_ACTION_FLAGS = Object.freeze([
  Object.freeze({ id: 'dispatch', label: 'Hand out work to agents', description: 'Show the form that hands a job to a Codex or Claude agent. Every hand-off is recorded (an audited dispatch).' }),
  Object.freeze({ id: 'decision', label: 'Approve or decline', description: 'Show Approve and Decline buttons on ledger requests. Every decision is recorded and kept.' }),
  Object.freeze({ id: 'queue', label: 'Take or finish queued work', description: 'Show the controls that take a waiting work item or mark one finished, on the strict build queue.' }),
  Object.freeze({ id: 'thread-reply', label: 'Reply to your coordinator', description: 'Let you type replies into the coordinator conversation. Every reply is sent and recorded.' }),
  Object.freeze({ id: 'report-read', label: 'Read agent reports', description: 'Show an agent’s written reports on its page. Reading only; nothing is changed.' }),
  Object.freeze({ id: 'agent-session', label: 'Run an agent session', description: 'Start, watch, and stop a live agent session from the agent page.' }),
  /* Codex Cloud. Default-off like every other write action, and that is the
     answer to "why is this feature not simply on": the flags fail closed
     (see 2c9318e, where an absent key used to read as enabled), and a cloud
     launch is the most consequential write in this list -- it starts real,
     billable work on a remote service that cannot be cancelled once accepted.

     Off does NOT mean invisible here, and that distinction is the actual fix.
     The other surfaces vanish entirely when their flag is off, which is why
     "shipped off pending review" and "the product has no such feature" looked
     identical from inside the app. The cloud panel renders either way: turned
     off it states what it is and where the switch is, so a person can find the
     feature and turn it on. A feature nobody can discover is not shipped. */
  Object.freeze({ id: 'cloud-launch', label: 'Launch Codex Cloud tasks', description: 'Launch a task on Codex Cloud and watch it from the agent page. Each launch still asks for approval.' }),
])

const IDS = new Set(WRITE_ACTION_FLAGS.map(flag => flag.id))
const storageKey = id => `mc.write.${id}`

function assertAction(id) {
  if (!IDS.has(id)) throw new TypeError(`Unknown write-action flag: ${id}`)
}

export function isWriteEnabled(id) {
  assertAction(id)
  try {
    const stored = localStorage.getItem(storageKey(id))
    if (stored !== null) return stored === 'enabled'
    // An absent action preference uses Basic. A saved profile remains a choice,
    // including historical Observe; unreadable/malformed data is never absence.
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY)
    if (raw === null) return true
    const profile = JSON.parse(raw)
    if (!profile || profile.schemaVersion !== PROFILE_SCHEMA_VERSION
      || !['in-progress', 'skipped', 'complete'].includes(profile.status)) return false
    if (profile.status === 'in-progress') return true
    if (!['observe', 'assisted', 'autonomous'].includes(profile.answers?.autonomy)) return false
    // These flags expose actions; the host still enforces the real tier,
    // workspace, accounts, kill switch and each operation's authorization.
    return deriveProfile(profile.answers, { tier: 'unrestricted', writeFlagIds: [id] }).writeFlags[id] === true
  } catch {
    return false
  }
}

export function setWriteEnabled(id, enabled) {
  assertAction(id)
  const on = Boolean(enabled)
  // Announce only a durable choice. Settings keeps this change pending if
  // storage refuses it; a success event would otherwise expose an unsaved action.
  localStorage.setItem(storageKey(id), on ? 'enabled' : 'disabled')
  window.dispatchEvent(new CustomEvent(WRITE_FLAGS_EVENT, { detail: Object.freeze({ action: id, enabled: on }) }))
  return on
}
