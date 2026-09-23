/* THE ORGANISATION CONTROLS, AND WHY THEY LIVE IN THEIR OWN FILE.
 *
 * src/views/computers.js draws the fleet. These three panels are the only part
 * of that page that WRITES anything about the declared organisation, and they
 * are the only part that has to keep saying what the engine actually enforces
 * next to what a role's wording claims. Kept inline they would have doubled the
 * view; kept here they can be read as one thing: the editing surface, its
 * failure sentences, and the disabled shape it takes when there is nothing
 * behind it.
 *
 * NOTHING HERE DECIDES WHETHER AN EDIT IS LEGAL. One controller, one manager
 * per agent, no cycle, no unknown role, no reserved role id, at most ten custom
 * roles — every one of those rules lives in the payload
 * (capability/src/lib/agent-org.js and custom-role-store.js) and is applied by
 * the store behind window.mcOrg. This file renders what the store returns and
 * prints the store's own sentence when it refuses. A second guard here would be
 * a second implementation, and the copy is the one that drifts.
 *
 * THE PANELS DEGRADE RATHER THAN PRETEND. The same page is served in a plain
 * browser from dist/, where window.mcOrg does not exist. Every builder below
 * takes an `availability` record and, when it is not `ready`, renders the
 * controls DISABLED with the reason on them instead of rendering an enabled
 * control with no backend attached. */

import { controlState, el } from './components.js'
import { refusalSentence } from './refusal-copy.js'
import { buildRoleStudio } from './role-studio.js'

const escapeMarkup = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

/* Mirrors MAX_RULE_TEXT in capability/src/lib/custom-role-store.js. It is used
   only to tell a person the limit before they hit it; the refusal itself is
   still the store's. */
export const MAX_RULE_TEXT = 6000

export const ORG_ABSENT_REASON = 'This copy is running in a browser, so there is no organisation store behind this page. The desktop app is where the declared organisation is saved.'

const RULE_FIELDS = Object.freeze([
  Object.freeze({ key: 'owns', label: 'Owns' }),
  Object.freeze({ key: 'mustNot', label: 'Must not' }),
  Object.freeze({ key: 'handoff', label: 'Hands off to' }),
])

/** Is there an organisation store behind this window at all? */
export function orgBridge() {
  const bridge = globalThis.mcOrg
  return bridge && typeof bridge.read === 'function' ? bridge : null
}

/**
 * The one availability record every panel below branches on.
 *
 *   { state: 'absent',  reason }              no bridge — a plain browser
 *   { state: 'failed',  code, reason }        a bridge that could not answer
 *   { state: 'ready',   org, roles, overlayFile }
 *
 * It never rejects and never throws, so a caller can await it in the same
 * Promise.all as the fleet fetch without a second failure vocabulary.
 */
export async function readOrg() {
  const bridge = orgBridge()
  if (!bridge) return { state: 'absent', code: 'ORG_BRIDGE_ABSENT', reason: ORG_ABSENT_REASON }
  let result = null
  try {
    result = await bridge.read()
  } catch (error) {
    return { state: 'failed', code: 'ORG_READ_THREW', reason: `The organisation could not be read: ${error?.message || error}` }
  }
  if (!result?.ok) {
    return {
      state: 'failed',
      code: result?.code || 'ORG_READ_FAILED',
      reason: result?.reason || 'The organisation could not be read.',
    }
  }
  return { state: 'ready', org: result.org, roles: result.roles, overlayFile: result.overlayFile,
    ...(Array.isArray(result.functionCatalog) ? { functionCatalog: result.functionCatalog } : {}),
    ...(Number.isSafeInteger(result.ruleTextLimit) ? { ruleTextLimit: result.ruleTextLimit } : {}) }
}

/**
 * The sentence a refusal is shown as.
 *
 * The engine already writes readable English into `reason` — "The controller is
 * the accountable root and cannot report to another agent." — so that is what
 * is shown, verbatim. The code is appended only when there is no reason to
 * show, because a bare code with no sentence is worse than a long sentence.
 */
export function failureSentence(result, fallback = 'The change was refused.') {
  /* [B6] `${fallback} (${code})` used to be this function's middle branch, so a
     refusal that carried a code and no reason put the identifier in brackets in
     front of a person -- and the bottom branch returned a fallback with nothing
     to do in it. Both now go through the shared composer, which never shows the
     identifier and always ends with an action. The engine's own `reason` is
     still preferred and still shown verbatim; that judgement was right and is
     unchanged, it just no longer stops there. */
  return refusalSentence(result, { fallback })
}

/** Whether a refusal means "your window is out of date", which has its own cure. */
export const isRevisionConflict = (result) => result?.code === 'AGENT_ORG_STORE_REVISION_CONFLICT'

export const REVISION_CONFLICT_ADVICE = 'Another window changed the organisation first. This page has re-read it — look at the current hierarchy and make the change again.'

/* THE ONE FACT A ROLE MENU MUST NOT OMIT.
   A role's wording is a description; `capabilities.mayClaimWork` is what the
   product mechanically guarantees. Five shipped roles are described as not
   dispatching work AND are prevented from reserving it; a custom role with no
   base is prevented too. Offering a role in a menu turns its description into a
   promise, so the enforced half travels with it everywhere the role is named. */
/* The label says the consequence a person can SEE, not the mechanism. "Can
   reserve work" named an internal lease no customer surface exhibits — the
   dropdown asserted a mechanic nobody could observe, twice per option. The
   enforced flag itself still travels on the role detail card, where there is
   room for its sentence. */
export const claimLabel = (role) => role?.capabilities?.mayClaimWork ? 'can be given jobs' : 'watch only'
const claimFlag = (role) => role?.capabilities?.mayClaimWork ? 'yes' : 'no'
export const missionAccessLabel = (role) => {
  if (role?.capabilities?.mayMutateMissionBridge) return 'team APIs: inspect, report and act'
  if (role?.capabilities?.mayReportMissionBridge) return 'team APIs: inspect and report'
  if (role?.capabilities?.mayUseMissionBridge) return 'team APIs: inspect only'
  return 'no team API access'
}

export const roleOptionLabel = (role) => `${role?.name || role?.id} · ${claimLabel(role)}`

/**
 * What the person is told about the org they are looking at, before they touch
 * it. `damaged` and `baselineDrift` are the two facts that are invisible unless
 * something says them out loud, and both change what an edit MEANS.
 */
export function orgNotices(org) {
  const notices = []
  if (!org) return notices
  if (org.damaged) {
    notices.push({
      kind: 'damaged',
      text: `Your saved organisation could not be loaded, so this is the one the app ships with: ${org.damaged}. Any change you make starts from that, not from what you had saved.`,
    })
  }
  /* NO HASHES IN FRONT OF A PERSON (owner, 2026-08-18, reading this very
     notice on the fleet rail). It used to quote both content hashes, so the
     sentence read `You saved yours from "60132024e9efbfe…"` and then ran off
     the edge of a 330px rail mid-hash. Neither hash is something anybody can
     act on, and the two facts that ARE actionable -- the default moved, and
     your version is the one running -- were the half getting truncated away.
     The hashes are still on `org.baselineDrift` for anything that debugs. */
  if (org.baselineDrift) {
    notices.push({
      kind: 'drift',
      text: 'The organisation this app ships with has changed since you saved your own. Your version is still the one in force, and the newer default is not being applied.',
    })
  }
  return notices
}

export function orgNoticeMarkup(org) {
  return orgNotices(org).map(notice =>
    `<div class="org-notice" data-notice="${notice.kind}">${escapeMarkup(notice.text)}</div>`).join('')
}

/* The single line that explains why an editing control is off, and the reason
   it fails CLOSED. Anything that is not a completed successful read — a bridge
   that is absent, a read that failed, a read that has not answered yet — leaves
   the panel with no revision to write against, and a control offered in that
   state would be a control with no backend. */
function disabledReason(availability) {
  if (availability?.state === 'ready') return null
  return failureSentence(availability, 'The declared organisation has not been read, so it cannot be edited here.')
}

function roleFactsMarkup(role) {
  if (!role) return '<div class="rail-sub">No role selected.</div>'
  const enforced = [
    `<span class="role-claim" data-claim="${claimFlag(role)}">${escapeMarkup(claimLabel(role))}</span>`,
    `<span class="role-claim" data-claim="mission">${escapeMarkup(missionAccessLabel(role))}</span>`,
    role.capabilities?.singleSeat ? '<span class="role-claim" data-claim="seat">one seat only</span>' : '',
  ].filter(Boolean).join('')
  const rules = Array.isArray(role.rules) && role.rules.length
    ? `<div class="role-rule"><b>Rules</b><span>${role.rules.map(escapeMarkup).join('<br>')}</span></div>`
    : ''
  return `
    <div class="role-enforced">${enforced}</div>
    <div class="rail-sub">${escapeMarkup(role.summary || 'This role ships no summary.')}</div>
    ${role.custom ? `<div class="rail-sub">Custom role${role.baseDefaultRole ? ` · based on ${escapeMarkup(role.baseDefaultRole)}` : ' · no base; its saved abilities are shown above'}</div>` : ''}
    ${RULE_FIELDS.map(field => `<div class="role-rule"><b>${field.label}</b><span>${escapeMarkup(role[field.key] || 'not stated')}</span></div>`).join('')}
    ${rules}`
}

/**
 * THE ROLE OF ONE AGENT.
 *
 * `agent` is a node of the fleet projection. It is only editable when that node
 * is also an agent of the declared organisation — the projection is generated
 * FROM the org, so normally it is, but a stale fleet.json can name an agent the
 * org no longer has. When it does, the control is disabled and says which fact
 * is missing, rather than offering a menu whose every choice returns
 * AGENT_ORG_STORE_UNKNOWN_AGENT.
 *
 * `onAssign(roleId)` must return the awaited {ok, ...} result of
 * mcOrg.assignRole. This builder does not call the bridge itself: the view owns
 * the revision it is holding and what has to be re-drawn afterwards.
 */
export function buildRoleAssignBox({ agent, availability, onAssign }) {
  const roles = availability?.state === 'ready' ? availability.roles : []
  const declared = availability?.state === 'ready'
    ? availability.org.agents.find(entry => entry.id === agent.id) || null
    : null
  const blocked = disabledReason(availability)
    || (declared ? null : `This agent is not part of the organisation saved on the computer you are driving, so its role cannot be changed here. The fleet record still names it "${agent.declaredRole || agent.id}".`)
  const current = declared?.role || agent.declaredRole || ''
  const controls = controlState({ enabled: !blocked, why: blocked })
  const disabled = controls.disabled

  const box = el(`
    <div class="board-box board-role-box">
      <div class="board-box-h"><span class="bh-t">Role</span></div>
      <div class="board-cap">what this agent is declared to be, and what that is enforced to mean</div>
      ${blocked ? `<div class="org-notice" data-notice="off">${escapeMarkup(blocked)}</div>` : ''}
      <label class="ctl-field"><span class="cl">Role</span>
        <select class="ctl-select" data-role="pick" aria-label="Declared role"${disabled ? ' disabled' : ''}>
          ${roles.length
            ? roles.map(role => `<option value="${escapeMarkup(role.id)}"${role.id === current ? ' selected' : ''}>${escapeMarkup(roleOptionLabel(role))}</option>`).join('')
            : `<option value="">${escapeMarkup(current || 'unavailable')}</option>`}
        </select>
      </label>
      <div class="role-facts" data-role="facts">${roleFactsMarkup(roles.find(role => role.id === current))}</div>
      <div class="ctl-dispatch">
        <button class="ctl-btn" type="button" data-role="apply"${disabled ? ' disabled' : ''}${blocked ? ` title="${escapeMarkup(blocked)}"` : ''}>Save role</button>
        <output class="ctl-out" data-role="out" role="status"></output>
      </div>
    </div>`)

  if (disabled) return box

  const select = box.querySelector('[data-role="pick"]')
  const facts = box.querySelector('[data-role="facts"]')
  const apply = box.querySelector('[data-role="apply"]')
  const output = box.querySelector('[data-role="out"]')

  select.addEventListener('change', () => {
    facts.innerHTML = roleFactsMarkup(roles.find(role => role.id === select.value))
    output.textContent = select.value === current ? '' : 'not saved yet'
  })

  apply.addEventListener('click', async () => {
    if (select.value === current) {
      output.textContent = 'already this role'
      return
    }
    apply.disabled = true
    output.textContent = 'saving…'
    const result = await onAssign(select.value)
    if (!box.isConnected) return
    apply.disabled = false
    output.textContent = result?.ok
      ? 'saved'
      : (isRevisionConflict(result) ? REVISION_CONFLICT_ADVICE : failureSentence(result, 'The role was not changed.'))
  })

  return box
}

/**
 * THE ROLE LIBRARY.
 *
 * Every role this copy can assign, what each one is enforced to mean, and the
 * three rule fields a person may rewrite. Defaults are editable too — the
 * engine records a default's override separately from a custom role precisely
 * so it can be rolled back — and only a default is offered the rollback.
 *
 * The callbacks return the awaited bridge results. `roles` is replaced from
 * whatever they return, so the list can never drift from what was stored.
 */
export function buildRoleLibraryBox({ availability, onCreate, onEdit, onReset, scopeKey }) {
  const bridge = orgBridge()
  const missing = ['createRole', 'editRole', 'resetRole'].some(verb => typeof bridge?.[verb] !== 'function')
  const blocked = disabledReason(availability) || (missing ? 'Connect to the desktop app to edit your roles.' : null)
  return buildRoleStudio({ availability, blocked, onCreate, onEdit, onReset, onRead: readOrg, scopeKey })
}

// The route keeps this in memory across remounts. The workspace owns both its
// visible editor and the drafts for roles that are not currently on screen.
export function snapshotRoleLibrary(box) {
  return box?.snapshotStudio?.() || null
}

export function restoreRoleLibrary(box, snapshot) {
  return box?.restoreStudio?.(snapshot) || 0
}
