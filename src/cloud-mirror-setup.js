/**
 * THE CLOUD MIRROR SETUP DIALOG.
 *
 * A cloud dispatch is checked against a MIRROR -- a private repository holding
 * the tree a cloud agent will actually diff against. Until this existed, the
 * only way to declare one was to hand-author `state/cloud-mirror/registry.json`
 * and get five fields right, so every dispatch refused
 * CLOUD_MIRROR_NOT_REGISTERED and the remedy was "edit some JSON". This is the
 * surface that replaces that: two links and a folder, and the API does the rest.
 *
 * THE PERSON TYPES THE PRIVATE MIRROR REPOSITORY. The registry keys every
 * dispatch on an exact GitHub "owner/name" string, so the bridge canonicalizes
 * that address, asks GitHub about that exact repository, and requires the
 * selected cloud environment to report the same binding. The text box and the
 * environment are two witnesses to one repository, never two independently
 * trusted destinations.
 *
 * WHY NOT owner-popup.js. That module is the OWNER PROMPT surface -- it
 * validates against PROMPT_KINDS, polls a snapshot, and reports presentation
 * evidence back to the engine, because its job is to prove a person was shown a
 * decision. This is a person-initiated form with none of those obligations, and
 * bending a prompt renderer into a form would have given the product two
 * half-shaped modal systems instead of one clear one.
 *
 * EVERY REFUSAL SHOWN HERE IS THE ENGINE'S OWN SENTENCE. The registration path
 * refuses by name -- unreachable, not writable, not private, already bound --
 * and each of those sentences already says what is wrong and what to do. A
 * second vocabulary written here would drift from it, and this codebase has
 * already paid for that twice.
 */

import { currentDataSource } from './data-source.js'
import { validAuditReceiptPair } from './mission-bridge.js'

const CHECK_STATES = Object.freeze({
  OK: { label: 'checked', tone: 'good' },
  UNVERIFIED: { label: 'not established', tone: 'warn' },
  'NOT CHECKED': { label: 'not checked', tone: 'warn' },
})

/* A project key is typed, so it is the one field that can be malformed by hand.
   Mirrored from PROJECT_KEY in the engine's cloud-mirror module: the engine is
   the authority and refuses by name regardless, but refusing here as well means
   a person is told before they spend three network calls finding out. */
const PROJECT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const DEFAULT_BOUNDARY_MANIFEST = 'config/cloud-mirror-boundary.json'
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The one repository identity the surface can derive without credentials.
 * GitHub remains authoritative for existence, access and visibility; this is
 * only the early shape/mismatch check that keeps an obviously wrong form from
 * making network calls.
 */
export function githubRepositoryFromRemote(value) {
  const remote = String(value || '').trim()
  let parsed
  try { parsed = new URL(remote) } catch { return null }
  if (parsed.protocol.toLowerCase() !== 'https:'
    || parsed.hostname.toLowerCase() !== 'github.com'
    || parsed.port || parsed.search || parsed.hash
    || parsed.username || parsed.password) return null
  const segments = parsed.pathname.split('/')
  if (segments.length !== 3 || segments[0] !== '' || !segments[1] || !segments[2]) return null
  let [, owner, repository] = segments
  repository = String(repository || '').replace(/\.git$/i, '')
  if (!GITHUB_OWNER_RE.test(String(owner || '')) || !GITHUB_REPO_RE.test(repository)) return null
  return `${owner}/${repository}`
}

const COMMIT_SHA = /^[a-f0-9]{40}$/i
const REQUIRED_REGISTRATION_CHECKS = Object.freeze([
  'typed remote and Cloud environment name the same repository',
  'mirror repository is active',
  'mirror repository is private',
  'mirror repository is reachable',
  'this machine can push to the mirror',
])

function plainRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sameRepository(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase()
}

function canonicalUtcTimestamp(value) {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function portableBoundaryManifest(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[\r\n]/.test(value)) return null
  const portable = value.trim().replace(/\\/g, '/')
  const segments = portable.split('/')
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return portable
}

/* A renderer cannot establish GitHub privacy itself; the authenticated engine
   does that. It can and must still refuse a malformed/stale success envelope
   instead of turning any `{ok:true}` into the next outward action. These are
   the durable facts the current engine writes only after exact repo_get,
   active/private checks, reachability and a dry-run write probe all succeed. */
function verifiedProjectBinding(projectKey, project, expectedRepository = null) {
  try {
    if (!PROJECT_KEY_RE.test(String(projectKey || '')) || !plainRecord(project)) return false
    const remoteRepository = githubRepositoryFromRemote(project.mirrorRemote)
    if (!remoteRepository || !sameRepository(remoteRepository, project.cloudRepository)
      || !sameRepository(remoteRepository, project.githubRepository)
      || (expectedRepository && !sameRepository(remoteRepository, expectedRepository))
      || project.mirrorBranch !== `cloud-mirror/${projectKey}`
      || !portableBoundaryManifest(project.boundaryManifest)
      || !canonicalUtcTimestamp(project.privacyVerifiedAt)) return false
    return true
  } catch { return false }
}

function verifiedRegistrationReceipt(receipt, request) {
  try {
    if (!plainRecord(receipt) || receipt.action !== 'cloud-mirror-register'
      || receipt.projectKey !== request.projectKey || receipt.environment !== request.environment
      || !validAuditReceiptPair(receipt.intentAudit, receipt.audit, 'cloud.mirror.register', request.projectKey)) return false
    const expectedRepository = githubRepositoryFromRemote(request.mirrorRemote)
    if (!expectedRepository || !verifiedProjectBinding(request.projectKey, receipt.project, expectedRepository)
      || portableBoundaryManifest(receipt.project.boundaryManifest) !== portableBoundaryManifest(request.boundaryManifest)
      || !Array.isArray(receipt.checks)) return false
    return REQUIRED_REGISTRATION_CHECKS.every((name) => receipt.checks.some((check) => (
      plainRecord(check) && check.name === name && check.state === 'OK'
    )))
  } catch { return false }
}

function verifiedPublicationReceipt(receipt, projectKey, project) {
  try {
    return plainRecord(receipt)
      && receipt.action === 'cloud-mirror-publish'
      && receipt.projectKey === projectKey
      && sameRepository(receipt.cloudRepository, project.cloudRepository)
      && receipt.mirrorBranch === project.mirrorBranch
      && COMMIT_SHA.test(String(receipt.sourceCommit || ''))
      && COMMIT_SHA.test(String(receipt.publicationCommit || ''))
      && Number.isSafeInteger(receipt.mirroredEntries) && receipt.mirroredEntries >= 0
      && Number.isSafeInteger(receipt.withheldEntries) && receipt.withheldEntries >= 0
      && validAuditReceiptPair(receipt.intentAudit, receipt.audit, 'cloud.mirror.publish', projectKey)
  } catch { return false }
}

function failClosedListedProject(project) {
  try {
    if (!plainRecord(project)) return null
    const key = String(project.key || '')
    if (!PROJECT_KEY_RE.test(key)) return null
    if (project.enabled !== true || verifiedProjectBinding(key, project)) return project
    return {
      ...project,
      enabled: false,
      disabledReason: 'This saved mirror does not carry a complete exact private-destination proof. Re-register it before publishing.',
    }
  } catch { return null }
}

export function emptyMirrorSetupState() {
  return {
    phase: 'loading',        // loading | ready | registering | publishing | registered | failed | publish-failed
    projects: [],            // what is already registered
    registryPath: null,
    environments: [],
    environmentsComplete: null,   // null = not read yet. NOT the same as false.
    draft: { projectKey: '', sourceRoot: '', boundaryManifest: DEFAULT_BOUNDARY_MANIFEST, mirrorRemote: '', environment: '' },
    reregisterKey: null,     // set only by the disabled project's own control
    busy: null,
    refusal: null,           // { code, message }
    notice: null,            // successful local-only state change
    result: null,            // the receipt of a successful registration
  }
}

/**
 * WHY THE REGISTER CONTROL IS DISABLED, or null when it can be pressed.
 *
 * Returned as a SENTENCE rather than a boolean because the control must carry
 * its reason. The house rule this follows is the one the settings and connect
 * surfaces already settled on: a control that cannot succeed is disabled and
 * says why beside it, never silently inert and never live-and-refusing. The
 * dead-control census in this repository found forty-nine of the other kind.
 */
export function registerBlockedReason(state, { viaRelay = false } = {}) {
  if (state.phase === 'loading') return 'Reading the environments the computer you are driving is signed in to.'
  if (state.busy) return 'Working.'
  const { projectKey, sourceRoot, boundaryManifest, mirrorRemote, environment } = state.draft
  if (!projectKey.trim()) return 'Give this project a short name first.'
  if (!PROJECT_KEY_RE.test(projectKey.trim())) {
    return 'A project name is lowercase letters, digits, dashes or underscores — it is the name a dispatch refers to.'
  }
  const existing = state.projects.find((project) => project.key === projectKey.trim())
  const replacingDisabled = Boolean(existing
    && existing.enabled === false
    && state.reregisterKey === existing.key)
  if (existing && !replacingDisabled) {
    return existing.enabled === false
      ? 'That project name belongs to a disabled mirror. Use its Re-register control so ToolsEnabled can revalidate and replace only that disabled entry.'
      : 'That project name is already registered on the computer you are driving. Enabled mirrors cannot be replaced from this form.'
  }
  if (state.reregisterKey && !replacingDisabled) {
    return 'The disabled mirror selected for re-registration no longer matches this form. Cancel and choose Re-register again.'
  }
  if (!sourceRoot.trim()) return 'Choose the folder this project should send.'
  if (!portableBoundaryManifest(boundaryManifest)) {
    return 'The boundary manifest must be a non-traversing relative path inside that folder, such as config/cloud-mirror-boundary.json.'
  }
  if (!mirrorRemote.trim()) return 'Paste the address of the private repository the mirror should publish to.'
  const typedRepository = githubRepositoryFromRemote(mirrorRemote)
  if (!typedRepository) {
    return 'Use an HTTPS GitHub repository address such as https://github.com/you/your-mirror.git. SSH, embedded credentials, and non-GitHub remotes are not accepted.'
  }
  if (!environment.trim()) return 'Choose the cloud environment this project runs in.'
  const chosen = state.environments.find((entry) => entry.environmentId === environment.trim())
  /* Not merely "unknown". If the list is INCOMPLETE, an environment missing
     from it has not been shown not to exist -- most often the account that owns
     it is not signed in here -- and telling somebody it does not exist would
     send them to fix the wrong thing. */
  if (!chosen) {
    return state.environmentsComplete === true
      ? (viaRelay
          ? 'That environment is not one the computer you are driving is signed in to.'
          : 'That environment is not one this computer is signed in to.')
      : 'The environment list could not be read in full, so this one could not be confirmed.'
  }
  if (!chosen.repository) {
    return chosen.reason || 'That environment names no single repository, so a mirror cannot be bound to it.'
  }
  if (String(chosen.repository).toLowerCase() !== typedRepository.toLowerCase()) {
    return `That cloud environment is bound to ${chosen.repository}, not ${typedRepository}. Bind it to the private mirror repository you entered, then refresh this list.`
  }
  return null
}

/** The environments a person may actually choose, and why the others are out. */
export function environmentChoices(state) {
  return state.environments.map((entry) => ({
    id: entry.environmentId,
    repository: entry.repository || null,
    visibility: entry.visibility || null,
    // An environment bound to no repository, or to several, is SHOWN and not
    // selectable. Hiding it would leave a person hunting for an environment
    // they can see in the provider's own console. Provider visibility is shown
    // only as context: it can be stale and never overrules the authenticated
    // GitHub check the registration action makes against the typed repository.
    selectable: Boolean(entry.repository),
    reason: entry.repository ? null : (entry.reason || 'This environment names no single repository.'),
  }))
}

/**
 * The line under the environment picker. Absent when the list is whole.
 *
 * A partial list presented as the whole set is the defect this exists to avoid:
 * somebody concludes their environment is gone when the truth is that we could
 * not ask.
 */
export function environmentCompletenessNote(state) {
  if (state.environmentsComplete === true) return null
  if (state.environmentsComplete === null) return 'Environments have not been read yet.'
  return 'This list is incomplete — at least one account could not be asked. An environment missing here has not been shown to be missing.'
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ))
}

export function checkRowsMarkup(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return ''
  return `<ul class="cms-checks">${checks.map((entry) => {
    const state = CHECK_STATES[entry.state] || { label: String(entry.state || '').toLowerCase(), tone: 'warn' }
    return `<li class="cms-check" data-tone="${escapeHtml(state.tone)}">
      <span class="cms-check-state">${escapeHtml(state.label)}</span>
      <span class="cms-check-name">${escapeHtml(entry.name)}</span>
      ${entry.detail ? `<span class="cms-check-detail">${escapeHtml(entry.detail)}</span>` : ''}
    </li>`
  }).join('')}</ul>`
}

function setupStatusText(state) {
  if (state.phase === 'loading') return 'Reading registered mirrors and signed-in cloud environments.'
  if (state.busy === 'register') {
    return state.reregisterKey
      ? `Revalidating disabled mirror ${state.reregisterKey}.`
      : `Checking and registering ${state.draft.projectKey || 'the mirror'}.`
  }
  if (String(state.busy || '').startsWith('publish:')) return `Publishing ${String(state.busy).slice('publish:'.length)}.`
  if (String(state.busy || '').startsWith('disable:')) return `Disabling ${String(state.busy).slice('disable:'.length)} locally.`
  if (state.busy === 'choose-folder') return 'Waiting for a folder choice.'
  if (state.phase === 'registered') return 'Registration and initial publication completed.'
  if (state.phase === 'publish-failed') return 'Registration completed; publication needs attention.'
  if (state.phase === 'failed') return 'Registration was not completed.'
  if (state.reregisterKey) return `Re-registering disabled mirror ${state.reregisterKey}. GitHub will recheck the exact destination before it is enabled.`
  return 'Ready to register a dedicated private GitHub mirror.'
}

function selectedDisabledProject(state) {
  if (!state.reregisterKey) return null
  return state.projects.find((project) => project.key === state.reregisterKey && project.enabled === false) || null
}

function projectEnvironment(state, project) {
  const explicit = String(project.environment || project.environmentId || '').trim()
  if (explicit && state.environments.some((entry) => entry.environmentId === explicit)) return explicit
  const repository = String(project.githubRepository || project.cloudRepository || '').trim().toLowerCase()
  if (!repository) return ''
  const matches = state.environments.filter((entry) => String(entry.repository || '').trim().toLowerCase() === repository)
  return matches.length === 1 ? matches[0].environmentId : ''
}

export function setupBodyMarkup(state, { canChooseDirectory = true, viaRelay = false } = {}) {
  if (state.phase === 'registered' && state.result) {
    const publication = state.result.publication?.publication || state.result.publication || null
    const branch = publication?.mirrorBranch || state.result.project?.mirrorBranch || null
    return `<div class="cms-done" role="status" aria-live="polite">
      <p class="cms-lede">${escapeHtml(state.result.projectKey)} now mirrors to ${escapeHtml(state.result.project.cloudRepository)}.</p>
      <p class="cms-note">The current snapshot was published${branch ? ` to ${escapeHtml(branch)}` : ''}. Cloud work for this project is checked against that repository from now on.</p>
      ${checkRowsMarkup(state.result.checks)}
    </div>`
  }

  if (state.phase === 'publishing' && state.result) {
    const destination = state.result.project?.cloudRepository || state.result.project?.mirrorRemote || 'the private mirror'
    return `<div class="cms-done cms-progress" role="status" aria-live="polite" aria-busy="true">
      <p class="cms-lede">Publishing ${escapeHtml(state.result.projectKey)} to ${escapeHtml(destination)}...</p>
      <p class="cms-note">ToolsEnabled is classifying and scanning the current committed snapshot, checking the destination is still private, and then publishing its workspace branch.</p>
      ${checkRowsMarkup(state.result.checks)}
      <div class="cms-actions">
        <button type="button" class="ctl-btn" disabled>Publishing...</button>
      </div>
    </div>`
  }

  if (state.phase === 'publish-failed' && state.result) {
    return `<div class="cms-done">
      <p class="cms-lede">${escapeHtml(state.result.projectKey)} is registered, but its current snapshot was not published.</p>
      ${state.refusal ? `<p class="cms-refusal" role="alert" tabindex="-1">${escapeHtml(state.refusal.message)}</p>` : ''}
      ${checkRowsMarkup(state.result.checks)}
      <div class="cms-actions">
        <button type="button" class="ctl-btn" data-cms-action="publish" data-project-key="${escapeHtml(state.result.projectKey)}"${state.busy ? ' disabled' : ''}>
          Try publishing again
        </button>
      </div>
    </div>`
  }

  const blocked = registerBlockedReason(state, { viaRelay })
  const folderBlocked = canChooseDirectory
    ? null
    : 'Choosing a folder is unavailable in this browser. Open the installed desktop app on the computer you are driving.'
  const choices = environmentChoices(state)
  const note = environmentCompletenessNote(state)
  const replacing = selectedDisabledProject(state)
  const controlsDisabled = Boolean(state.busy || state.phase === 'loading')

  const registeredProjects = state.projects.length > 0
    ? `<section class="cms-registered">
        <span class="cms-label">Registered mirrors</span>
        <ul class="cms-checks">${state.projects.map((project) => {
          const disabled = project.enabled === false
          const statusId = `cms-project-status-${project.key}`
          const selected = disabled && state.reregisterKey === project.key
          const detail = disabled
            ? (project.disabledReason || 'This legacy entry must be re-registered and revalidated before publishing.')
            : (project.cloudRepository || project.mirrorRemote || 'No destination is saved. Open setup and register this mirror again.')
          const actions = disabled
            ? `<button type="button" class="ctl-btn cms-project-action" data-cms-action="reregister" data-project-key="${escapeHtml(project.key)}"
                aria-label="${escapeHtml(`Re-register disabled mirror ${project.key}`)}" aria-describedby="${escapeHtml(statusId)}"${state.busy || selected ? ' disabled' : ''}>${selected ? 'Re-registering...' : 'Re-register'}</button>`
            : `<button type="button" class="ctl-btn cms-project-action" data-cms-action="publish" data-project-key="${escapeHtml(project.key)}"
                aria-label="${escapeHtml(`Publish ${project.key} now`)}" aria-describedby="${escapeHtml(statusId)}"${state.busy ? ' disabled' : ''}>Publish now</button>
              <button type="button" class="ctl-btn cms-project-action" data-cms-action="disable" data-project-key="${escapeHtml(project.key)}"
                aria-label="${escapeHtml(`Disable ${project.key} locally without changing GitHub`)}" aria-describedby="${escapeHtml(statusId)}"${state.busy ? ' disabled' : ''}>Disable locally</button>`
          return `<li class="cms-check cms-project" data-state="${disabled ? 'disabled' : 'enabled'}">
            <span class="cms-check-name">${escapeHtml(project.key)}</span>
            <span class="cms-project-status" id="${escapeHtml(statusId)}">${disabled ? 'Disabled - re-registration required' : 'Enabled'}</span>
            <span class="cms-check-detail">${escapeHtml(detail)}</span>
            <span class="cms-project-actions">${actions}</span>
          </li>`
        }).join('')}</ul>
      </section>`
    : ''

  return `<div class="cms-form">
    ${registeredProjects}
    ${state.notice ? `<p class="cms-note" role="status">${escapeHtml(state.notice)}</p>` : ''}
    ${replacing ? `<section class="cms-reregister" id="cms-reregister-note" role="status" aria-live="polite" tabindex="-1">
      <span><strong>Re-registering ${escapeHtml(replacing.key)}.</strong> Its saved folder and repository are preloaded. GitHub will recheck the exact repository before this disabled entry can be replaced and enabled.</span>
      <button type="button" class="ctl-btn" data-cms-action="cancel-reregister"${controlsDisabled ? ' disabled' : ''}>Cancel</button>
    </section>` : ''}
    <label class="cms-field">
      <span class="cms-label">Project name</span>
      <input class="cms-input" type="text" data-cms-field="projectKey" value="${escapeHtml(state.draft.projectKey)}"
        autocomplete="off" spellcheck="false" placeholder="engine"${replacing ? ' readonly aria-describedby="cms-reregister-note"' : ''}${controlsDisabled ? ' disabled' : ''} />
    </label>

    <label class="cms-field">
      <span class="cms-label">Folder to send</span>
      <span class="cms-row">
        <input class="cms-input" type="text" data-cms-field="sourceRoot" value="${escapeHtml(state.draft.sourceRoot)}"
          autocomplete="off" spellcheck="false" readonly${controlsDisabled ? ' disabled' : ''} />
        <button type="button" class="ctl-btn" data-cms-action="choose-folder"${folderBlocked || controlsDisabled ? ` disabled aria-describedby="${folderBlocked ? 'cms-folder-blocked' : 'cms-registration-status'}"` : ''}>Choose…</button>
      </span>
      ${folderBlocked ? `<span class="cms-blocked" id="cms-folder-blocked">${escapeHtml(folderBlocked)}</span>` : ''}
    </label>

    <label class="cms-field">
      <span class="cms-label">Private GitHub mirror repository</span>
      <input class="cms-input" type="text" data-cms-field="mirrorRemote" value="${escapeHtml(state.draft.mirrorRemote)}"
        autocomplete="off" spellcheck="false" placeholder="https://github.com/you/your-mirror.git"${controlsDisabled ? ' disabled' : ''} />
    </label>

    <label class="cms-field">
      <span class="cms-label">Boundary manifest</span>
      <input class="cms-input" type="text" data-cms-field="boundaryManifest" value="${escapeHtml(state.draft.boundaryManifest)}"
        autocomplete="off" spellcheck="false" placeholder="${DEFAULT_BOUNDARY_MANIFEST}"${controlsDisabled ? ' disabled' : ''} />
      <span class="cms-note">Repository-relative file that classifies every tracked path as mirrored or withheld. ToolsEnabled will not create it or guess what may leave this computer.</span>
    </label>

    <label class="cms-field">
      <span class="cms-label">Cloud environment</span>
      <select class="cms-input" data-cms-field="environment"${controlsDisabled ? ' disabled' : ''}>
        <option value="">Choose one…</option>
        ${choices.map((choice) => `<option value="${escapeHtml(choice.id)}"${choice.selectable ? '' : ' disabled'}${state.draft.environment === choice.id ? ' selected' : ''}>${
          escapeHtml(choice.selectable ? `${choice.repository}${choice.visibility ? ` · provider label: ${choice.visibility}; GitHub rechecks` : ''}` : `${choice.id} — ${choice.reason}`)
        }</option>`).join('')}
      </select>
      ${note ? `<span class="cms-note">${escapeHtml(note)}</span>` : ''}
    </label>

    ${state.refusal ? `<p class="cms-refusal" role="alert" tabindex="-1">${escapeHtml(state.refusal.message)}</p>` : ''}
    ${state.result && state.phase === 'failed' ? checkRowsMarkup(state.result.checks) : ''}

    <div class="cms-actions">
      <button type="button" class="ctl-btn" data-cms-action="register"${blocked ? ' disabled aria-describedby="cms-blocked"' : ''}>
        ${state.busy === 'register' ? (replacing ? 'Revalidating…' : 'Checking…') : (replacing ? 'Re-register and revalidate' : 'Register this mirror')}
      </button>
      ${blocked ? `<span class="cms-blocked" id="cms-blocked">${escapeHtml(blocked)}</span>` : ''}
    </div>

    <p class="cms-note">Registering verifies this exact GitHub repository is private and writable, and that the selected cloud environment is bound to the same owner/name. It changes nothing in the folder you chose.</p>
  </div>`
}

export function setupMarkup(state, options) {
  const busy = state.phase === 'loading' || Boolean(state.busy)
  return `<div class="cms-overlay" data-cms-overlay>
    <section class="cms-dialog" role="dialog" aria-modal="true" aria-labelledby="cms-title" aria-describedby="cms-registration-status" aria-busy="${busy ? 'true' : 'false'}" tabindex="-1">
      <header class="cms-header">
        <h2 id="cms-title">Cloud mirror</h2>
        <button type="button" class="cms-close" data-cms-action="close" aria-label="Close">×</button>
      </header>
      <p class="cms-registration-status" id="cms-registration-status" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(setupStatusText(state))}</p>
      <div class="cms-body">${setupBodyMarkup(state, options)}</div>
    </section>
  </div>`
}

/**
 * The controller. Every dependency is injected, so the behaviour above can be
 * driven with values instead of asserted against source text -- which is the
 * failure mode a sweep of this repository found twenty-one times.
 */
function modalBackgroundNodes(documentRef) {
  if (!documentRef) return []
  const roots = [
    documentRef.querySelector?.('header.topbar'),
    documentRef.getElementById?.('stage'),
    documentRef.getElementById?.('drawer'),
  ].filter(Boolean)
  const drawer = documentRef.getElementById?.('drawer')
  // Match the owner-prompt modal: Settings may re-derive inert on the drawer
  // root, so its focusable children are guarded independently too.
  const drawerControls = drawer?.querySelectorAll ? [...drawer.querySelectorAll(FOCUSABLE)] : []
  return [...new Set([...roots, ...drawerControls])]
}

export function createCloudMirrorSetup({ documentRef, postAction, chooseDirectory = null, onClose = null } = {}) {
  const state = emptyMirrorSetupState()
  let root = null
  let modalSession = null
  let generation = 0

  function current(requestGeneration) { return requestGeneration === generation }

  function refresh() {
    if (!root) return
    const options = {
      canChooseDirectory: typeof chooseDirectory === 'function',
      viaRelay: currentDataSource() === 'relay',
    }
    const dialog = root.querySelector?.('.cms-dialog')
    const status = root.querySelector?.('#cms-registration-status')
    const body = root.querySelector?.('.cms-body')
    if (dialog && status && body) {
      // Keep the live region mounted. Replacing the node that owns aria-live at
      // the same instant as its message is a best-effort announcement in some
      // assistive technology; changing the text of the existing node is the
      // deterministic pattern used here.
      dialog.setAttribute('aria-busy', state.phase === 'loading' || state.busy ? 'true' : 'false')
      status.textContent = setupStatusText(state)
      body.innerHTML = setupBodyMarkup(state, options)
      return
    }
    root.innerHTML = setupMarkup(state, options)
  }

  function focusInitial() {
    const target = root?.querySelector?.('[data-cms-action="close"]') || root?.querySelector?.('.cms-dialog')
    if (target && typeof target.focus === 'function') target.focus()
  }

  function focusRefusal() {
    const alert = root?.querySelector?.('.cms-refusal')
    if (alert && typeof alert.focus === 'function') alert.focus()
  }

  function focusReregisterNotice() {
    const notice = root?.querySelector?.('#cms-reregister-note')
    if (notice && typeof notice.focus === 'function') notice.focus()
  }

  async function safePost(action, body) {
    try { return await postAction(action, body) }
    catch (error) {
      return { ok: false, code: 'BRIDGE_UNREACHABLE', reason: error?.message || String(error) }
    }
  }

  async function load(requestGeneration = generation) {
    if (!current(requestGeneration)) return
    state.phase = 'loading'
    state.busy = null
    state.refusal = null
    state.notice = null
    refresh()
    const [listed, accounts] = await Promise.all([
      safePost('cloud-mirror-list', {}),
      safePost('cloud-accounts', {}),
    ])
    if (!current(requestGeneration)) return
    if (listed?.ok && listed.receipt) {
      state.projects = Array.isArray(listed.receipt.projects)
        ? listed.receipt.projects.map(failClosedListedProject).filter(Boolean)
        : []
      state.registryPath = listed.receipt.registryPath || null
    } else {
      // A registry that cannot be READ is not a registry that is empty. Saying
      // "nothing is registered" here would invite somebody to register a
      // duplicate over work they cannot currently see.
      state.refusal = {
        code: listed?.code || 'BRIDGE_UNKNOWN',
        message: listed?.reason || 'The registered mirrors could not be read on the computer you are driving.',
      }
    }
    if (accounts?.ok && accounts.receipt) {
      state.environments = Array.isArray(accounts.receipt.environments) ? accounts.receipt.environments : []
      state.environmentsComplete = accounts.receipt.environmentsComplete === true
    } else {
      // Not read is not empty, and `environmentsComplete: false` is how the
      // note below says so out loud.
      state.environments = []
      state.environmentsComplete = false
      if (!state.refusal) {
        state.refusal = {
          code: accounts?.code || 'BRIDGE_UNKNOWN',
          message: accounts?.reason || 'The signed-in cloud environments could not be read on the computer you are driving.',
        }
      }
    }
    state.phase = 'ready'
    refresh()
    focusInitial()
  }

  function beginReregister(projectKey) {
    if (state.busy) return
    const key = String(projectKey || '').trim()
    const project = state.projects.find((entry) => entry.key === key) || null
    if (!PROJECT_KEY_RE.test(key) || !project || project.enabled !== false) {
      state.reregisterKey = null
      state.phase = 'ready'
      state.refusal = {
        code: 'CMS_REREGISTER_NOT_DISABLED',
        message: project
          ? 'That mirror is enabled. Enabled mirrors cannot be replaced from this form.'
          : 'That disabled mirror is no longer registered on the computer you are driving. Refresh and try again.',
      }
      refresh()
      focusRefusal()
      return
    }
    state.reregisterKey = key
    state.draft = {
      projectKey: key,
      sourceRoot: String(project.sourceRoot || ''),
      boundaryManifest: portableBoundaryManifest(project.boundaryManifest) || DEFAULT_BOUNDARY_MANIFEST,
      mirrorRemote: String(project.mirrorRemote || ''),
      environment: projectEnvironment(state, project),
    }
    state.phase = 'ready'
    state.result = null
    state.refusal = null
    state.notice = null
    refresh()
    focusReregisterNotice()
  }

  function cancelReregister() {
    if (state.busy || !state.reregisterKey) return
    state.reregisterKey = null
    state.draft = { projectKey: '', sourceRoot: '', boundaryManifest: DEFAULT_BOUNDARY_MANIFEST, mirrorRemote: '', environment: '' }
    state.refusal = null
    state.result = null
    state.phase = 'ready'
    refresh()
    root?.querySelector?.('[data-cms-field="projectKey"]')?.focus?.()
  }

  async function register() {
    if (registerBlockedReason(state) !== null) return
    const requestGeneration = generation
    const replacement = selectedDisabledProject(state)
    const body = {
      projectKey: state.draft.projectKey.trim(),
      sourceRoot: state.draft.sourceRoot.trim(),
      boundaryManifest: portableBoundaryManifest(state.draft.boundaryManifest),
      mirrorRemote: state.draft.mirrorRemote.trim(),
      environment: state.draft.environment.trim(),
      ...(replacement ? { replace: true } : {}),
    }
    state.busy = 'register'
    state.refusal = null
    state.notice = null
    state.result = null
    refresh()
    const response = await safePost('cloud-mirror-register', body)
    if (!current(requestGeneration)) return
    state.busy = null
    if (response?.ok && verifiedRegistrationReceipt(response.receipt, body)) {
      state.result = response.receipt
      const registered = { key: response.receipt.projectKey, ...response.receipt.project, enabled: true }
      state.projects = [...state.projects.filter((entry) => entry.key !== registered.key), registered]
      state.reregisterKey = null
      await publish(response.receipt.projectKey)
      return
    }
    state.phase = 'failed'
    // The engine's own sentence, forwarded. Each registration refusal already
    // names what is wrong and what to do about it.
    state.refusal = response?.ok
      ? {
          code: 'CMS_REGISTRATION_RECEIPT_UNVERIFIED',
          message: 'The computer reported registration success without a complete exact private-repository proof. Nothing was published. Refresh and re-register after the installed capability is current.',
        }
      : {
          code: response?.code || 'BRIDGE_UNKNOWN',
          message: response?.reason || 'The mirror could not be registered, and the computer you are driving did not say why.',
        }
    refresh()
    focusRefusal()
  }

  async function publish(projectKey) {
    if (state.busy) return
    const requestGeneration = generation
    const key = String(projectKey || '').trim()
    const project = state.projects.find((entry) => entry.key === key) || null
    if (!PROJECT_KEY_RE.test(key) || !project) {
      state.phase = 'failed'
      state.refusal = { code: 'CMS_PROJECT_NOT_REGISTERED', message: 'That mirror is not registered on the computer you are driving.' }
      refresh()
      focusRefusal()
      return
    }
    if (project.enabled === false) {
      state.phase = 'ready'
      state.refusal = {
        code: 'CMS_PROJECT_DISABLED',
        message: 'That mirror is disabled locally. Use Re-register so GitHub can revalidate its exact private destination before anything is published.',
      }
      refresh()
      focusRefusal()
      return
    }
    if (!verifiedProjectBinding(key, project)) {
      state.phase = 'ready'
      state.refusal = {
        code: 'CMS_PROJECT_UNVERIFIED',
        message: 'That saved mirror does not carry a complete exact private-destination proof. Re-register it before anything is published.',
      }
      refresh()
      focusRefusal()
      return
    }
    const prior = state.result?.projectKey === key ? state.result : null
    state.result = {
      ...(prior || {}),
      projectKey: key,
      project: prior?.project || project,
      checks: Array.isArray(prior?.checks) ? prior.checks : [],
      publication: null,
    }
    state.busy = `publish:${key}`
    state.phase = 'publishing'
    state.refusal = null
    state.notice = null
    refresh()
    const response = await safePost('cloud-mirror-publish', { projectKey: key })
    if (!current(requestGeneration)) return
    state.busy = null
    if (response?.ok && verifiedPublicationReceipt(response.receipt, key, project)) {
      state.result.publication = response.receipt
      state.phase = 'registered'
      state.refusal = null
    } else {
      state.phase = 'publish-failed'
      state.refusal = response?.ok
        ? {
            code: 'CMS_PUBLICATION_RECEIPT_UNVERIFIED',
            message: 'The computer reported publication success without a complete receipt for this exact repository and workspace branch. Publication is not confirmed.',
          }
        : {
            code: response?.code || 'BRIDGE_UNKNOWN',
            message: response?.reason || 'The mirror was registered, but its current snapshot could not be published and the computer you are driving did not say why.',
          }
    }
    refresh()
    if (state.phase === 'publish-failed') focusRefusal()
  }

  async function disable(projectKey) {
    if (state.busy) return
    const requestGeneration = generation
    const key = String(projectKey || '').trim()
    const project = state.projects.find((entry) => entry.key === key) || null
    if (!PROJECT_KEY_RE.test(key) || !project || project.enabled === false) {
      state.phase = 'ready'
      state.refusal = {
        code: 'CMS_DISABLE_NOT_ENABLED',
        message: project
          ? 'That mirror is already disabled locally.'
          : 'That mirror is no longer registered on the computer you are driving. Refresh and try again.',
      }
      state.notice = null
      refresh()
      focusRefusal()
      return
    }

    state.busy = `disable:${key}`
    state.refusal = null
    state.notice = null
    refresh()
    const response = await safePost('cloud-mirror-disable', { projectKey: key })
    if (!current(requestGeneration)) return
    state.busy = null
    if (response?.ok === true && response.receipt?.project
      && response.receipt.action === 'cloud-mirror-disable' && response.receipt.projectKey === key
      && response.receipt.project.key === key && response.receipt.project.enabled === false
      && response.receipt.remoteChanged === false
      && validAuditReceiptPair(response.receipt.intentAudit, response.receipt.audit, 'cloud.mirror.disable', key)) {
      state.projects = state.projects.map((entry) => entry.key === key ? response.receipt.project : entry)
      state.phase = 'ready'
      state.result = null
      state.notice = `${key} is disabled on this computer. Its GitHub repository and ${project.mirrorBranch || 'workspace branch'} were not changed. Use Re-register to verify the same or a different private destination.`
      state.refusal = null
    } else {
      state.phase = 'failed'
      state.refusal = {
        code: response?.ok ? 'CMS_DISABLE_RECEIPT_UNVERIFIED' : (response?.code || 'BRIDGE_UNKNOWN'),
        message: response?.ok
          ? 'The computer did not confirm that exact local change. Refresh and verify its saved state before trying again.'
          : (response?.reason || 'The local mirror registration could not be disabled. GitHub was not changed.'),
      }
    }
    refresh()
    if (state.phase === 'failed') focusRefusal()
  }

  async function pickFolder() {
    if (state.busy) return
    const requestGeneration = generation
    if (typeof chooseDirectory !== 'function') {
      state.refusal = { code: 'CMS_NO_FOLDER_PICKER', message: 'Choosing a folder is unavailable in this browser. Open the installed desktop app on the computer you are driving.' }
      refresh()
      focusRefusal()
      return
    }
    state.busy = 'choose-folder'
    refresh()
    let picked
    try { picked = await chooseDirectory() } catch (error) {
      picked = { ok: false, error: { message: error?.message || String(error) } }
    }
    if (!current(requestGeneration)) return
    state.busy = null
    if (picked?.canceled) { refresh(); return }
    if (!picked?.ok || !picked.path) {
      state.refusal = { code: 'CMS_FOLDER_NOT_CHOSEN', message: picked?.error?.message || 'No folder was chosen.' }
      refresh()
      focusRefusal()
      return
    }
    state.draft.sourceRoot = picked.path
    state.refusal = null
    refresh()
  }

  function onInput(event) {
    const field = event.target?.dataset?.cmsField
    if (!field || !(field in state.draft) || state.busy) return
    if (field === 'projectKey' && state.reregisterKey) return
    state.draft[field] = event.target.value
    // Re-render so the blocked reason under the button tracks what was typed.
    // The focused field is restored because a full re-render would otherwise
    // take the caret away mid-word.
    const active = field
    const caret = event.target.selectionStart
    refresh()
    const restored = root?.querySelector?.(`[data-cms-field="${active}"]`)
    if (restored) {
      restored.focus()
      if (typeof caret === 'number' && typeof restored.setSelectionRange === 'function') {
        try { restored.setSelectionRange(caret, caret) } catch { /* selects are not text inputs */ }
      }
    }
  }

  function onClick(event) {
    const control = event.target?.closest?.('[data-cms-action]')
    const action = control?.dataset?.cmsAction
    if (action === 'close') { close(); return }
    if (action === 'choose-folder') { void pickFolder(); return }
    if (action === 'register') { void register(); return }
    if (action === 'disable') { void disable(control?.dataset?.projectKey); return }
    if (action === 'cancel-reregister') { cancelReregister(); return }
    if (action === 'reregister') { beginReregister(control?.dataset?.projectKey); return }
    if (action === 'publish') { void publish(control?.dataset?.projectKey); return }
    if (event.target?.dataset?.cmsOverlay !== undefined) close()
  }

  function trapFocus(event) {
    if (!root) return
    if (event.key === 'Escape') {
      event.preventDefault?.()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = root.querySelector?.('.cms-dialog')
    if (!dialog) return
    const stops = [...(dialog.querySelectorAll?.(FOCUSABLE) || [])]
      .filter((node) => !node.disabled && node.tabIndex !== -1 && node.offsetParent !== null)
    if (!stops.length) {
      event.preventDefault?.()
      dialog.focus?.()
      return
    }
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (event.shiftKey && documentRef?.activeElement === first) {
      event.preventDefault?.()
      last.focus?.()
    } else if (!event.shiftKey && documentRef?.activeElement === last) {
      event.preventDefault?.()
      first.focus?.()
    }
  }

  function onKeydown(event) { trapFocus(event) }

  function open(host) {
    if (root) return Promise.resolve()
    generation += 1
    Object.assign(state, emptyMirrorSetupState())
    root = host
    modalSession = {
      generation,
      priorFocus: documentRef?.activeElement || null,
      background: modalBackgroundNodes(documentRef).map((node) => ({ node, hadInert: node.hasAttribute('inert') })),
    }
    for (const entry of modalSession.background) entry.node.setAttribute('inert', '')
    root.addEventListener('input', onInput)
    root.addEventListener('change', onInput)
    root.addEventListener('click', onClick)
    documentRef?.addEventListener?.('keydown', onKeydown)
    const pending = load(modalSession.generation)
    focusInitial()
    return pending
  }

  function close() {
    if (!root) return
    generation += 1 // invalidates every request issued by the modal being closed
    const closingRoot = root
    const session = modalSession
    root = null
    modalSession = null
    closingRoot.removeEventListener('input', onInput)
    closingRoot.removeEventListener('change', onInput)
    closingRoot.removeEventListener('click', onClick)
    documentRef?.removeEventListener?.('keydown', onKeydown)
    for (const entry of session?.background || []) entry.node.toggleAttribute('inert', entry.hadInert)
    closingRoot.innerHTML = ''
    if (session?.priorFocus?.isConnected && typeof session.priorFocus.focus === 'function') session.priorFocus.focus()
    if (typeof onClose === 'function') onClose()
  }

  return { open, close, register, disable, publish, beginReregister, cancelReregister, pickFolder, load, state }
}
