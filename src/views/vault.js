/* /vault — the credentials this computer holds, what they are called, and who
 * may read each one.
 *
 * WHY THIS IS A PAGE AND NOT A SETTINGS ROW. The owner asked three times, and
 * the third time said what was wrong with the answer he had been given:
 * "i still dont see vault page anywhere wtf? its supposed to have its own page
 * like settings and ledger does". It had been delivered as the
 * `vault_credentials` row inside Settings' "Data & Privacy" section -- a real
 * surface, reachable, and not a page. A row inside a category inside another
 * page is not "its own page like settings and ledger does", and describing it
 * as one is how the request came back three times.
 *
 * So this is a stop with its own address (`#/vault`), its own entry in the left
 * navigation, and its own crumb, exactly like Ledger. The Settings row stays
 * where it is and keeps working: it is a door, not a duplicate: both mount the
 * same reader and the same removal flow, so there is one implementation of
 * "what does this vault hold" and one of "remove this credential".
 *
 * WHAT THIS PAGE MAY NEVER DO, and the reason the seam is shaped the way it is:
 * it never shows, requests, or receives a credential's VALUE. `window.mcVault`
 * has no verb that returns one. Everything below is names, the owner's own
 * nicknames, and booleans.
 *
 * THE NICKNAME REPLACES THE NAME RATHER THAN LABELLING IT. The owner's words
 * were "give credentials secret nicknames so that they arent visible". A
 * nickname shown beside the real name would leave the real name visible, which
 * is the thing he asked to stop. So a nicknamed record shows its nickname where
 * its name would be, and the real name is behind a per-row disclosure that is
 * closed until the owner opens it -- available to the person sitting here, not
 * on screen by default and never handed to an assistant.
 *
 * THE MATRIX IS ENFORCED SOMEWHERE ELSE, WHICH IS THE POINT. These checkboxes
 * write to the durable policy in shell/vault-access-policy.cjs; the refusal
 * happens in shell/vault-presence.cjs's `vaultRecordValues`, before the vault is
 * opened, in the main process. A switch that only hid a row here would be a
 * label on a door that does not lock.
 */

import { el } from '../components.js'
import { ROLE_COLOR_NAMES } from '../role-colors.js'
import { VAULT_COPY, createVaultCredentialsSettings } from '../vault-credentials-settings.js'
/* Both stylesheets live at src/, not src/views/ -- every other view in this
   directory reaches them with `../`. settings.css is not optional decoration
   here: the markup below is built from `settings-shell`, `settings-page`,
   `settings-header` and `settings-section`, so without it this page draws
   unstyled. */
import '../settings.css'
import '../vault-credentials-settings.css'
import '../vault-page.css'

export const VAULT_ROUTE = '#/vault'

/* THE PRINCIPALS A RULE MAY NAME, in the order they appear in the access list.
 *
 * Taken from ROLE_COLOR_NAMES rather than spelled again, so a role added to the
 * product gets a control without anyone remembering to add one here. The three
 * that are filtered out are not roles an agent runs as: `default` and `spawned`
 * are presentation buckets for the tree drawing, and `shadow` is the legacy
 * spelling of `shadow-manager`, which would otherwise draw two columns that
 * mean the same thing. */
const NON_ROLE_KEYS = Object.freeze(['default', 'spawned', 'shadow'])

export function matrixRoles(names = ROLE_COLOR_NAMES) {
  return Object.keys(names)
    .filter(id => !NON_ROLE_KEYS.includes(id))
    .map(id => ({ id, label: names[id] }))
}

export const VAULT_PAGE_COPY = Object.freeze({
  title: 'Vault',
  lede: 'Manage saved credentials, private nicknames, and who can use them. Credential values stay in the encrypted vault.',
  reading: 'Reading what this computer’s vault holds.',
  nicknameLabel: name => `Secret nickname for ${name}`,
  nicknamePlaceholder: 'a name only you know',
  nicknameSaved: 'Nickname saved. Assistants and this screen use it instead of the record’s real name.',
  nicknameCleared: 'Nickname cleared. This record shows its real name again.',
  nicknameRefused: 'That nickname cannot be used. Use up to 60 characters, and no angle brackets or quotes.',
  realNameSummary: 'Show the real record name',
  accessLegend: name => `Which roles may read ${name}`,
  accessOn: 'May read',
  accessOff: 'Refused',
  accessSaved: (role, allowed) => `${role} ${allowed ? 'may now read' : 'can no longer read'} this credential.`,
  accessRefused: 'That change could not be saved, so nothing was altered.',
  policyUnreadable: 'This computer holds your decisions about which credentials may be read, and could not '
    + 'read them. Nothing is listed as allowed, and every read is refused until that file can be read again. '
    + 'That is not the same as having no rules.',
  empty: VAULT_COPY.empty,
  unreadable: VAULT_COPY.unreadable,
  bridgeAbsent: VAULT_COPY.bridgeAbsent,
})

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/**
 * Build the Vault page.
 *
 * @param {object} [options]
 * @param {object} [options.vault] the main-process seam; defaults to the
 *   preload exposure. A test passes its own, which is what lets every branch
 *   below be asserted without a window.
 */
export function vaultView({ vault } = {}) {
  const bridge = vault || (typeof globalThis !== 'undefined' ? globalThis.window?.mcVault : null)
  const roles = matrixRoles()

  const root = el(`<div class="view-pad settings-page vault-page">
    <div class="settings-shell">
      <header class="settings-header vault-header">
        <div><p class="vault-eyebrow">THIS COMPUTER</p><h1 class="mt">${esc(VAULT_PAGE_COPY.title)}</h1>
        <p class="settings-desc">${esc(VAULT_PAGE_COPY.lede)}</p></div>
        <button type="button" class="ctl-btn vault-primary" data-vault-open-add>Add credential</button>
      </header>
      <div class="settings-main">
        <div class="vault-toolbar">
          <label class="vault-search">Search credentials<input type="search" data-vault-search placeholder="Search displayed names" /></label>
          <label class="vault-filter">Show<select data-vault-filter><option value="all">All credentials</option><option value="restricted">With access restrictions</option><option value="nicknamed">With private nicknames</option></select></label>
          <button type="button" class="ctl-btn" data-vault-refresh>Refresh</button>
        </div>
        <p class="vault-result-count" data-vault-count aria-live="polite"></p>
        <p class="vault-notice" data-vault-status role="status">${esc(VAULT_PAGE_COPY.reading)}</p>
        <div class="vault-page-rows" data-vault-rows></div>
        <details class="vault-manage" data-vault-manage><summary>Add or remove credentials</summary>
          <div data-vault-management></div>
        </details>
      </div>
    </div>
  </div>`)

  const statusNode = root.querySelector('[data-vault-status]')
  const rowsNode = root.querySelector('[data-vault-rows]')
  const search = root.querySelector('[data-vault-search]')
  const filter = root.querySelector('[data-vault-filter]')
  const countNode = root.querySelector('[data-vault-count]')
  const management = root.querySelector('[data-vault-manage]')
  const refreshButton = root.querySelector('[data-vault-refresh]')
  let destroyed = false, refreshVersion = 0, writeSequence = 0
  let cached = [], records = Object.create(null), policyReady = false, refreshQueued = false
  const pendingWrites = new Map()
  const rowStates = new Map()
  let heldFocus = null
  const panel = createVaultCredentialsSettings({
    vault: bridge,
    displayName: name => policyReady ? records[name]?.nickname || name : 'Credential',
    refreshNames: () => refresh({ preserveStatus: true }),
    onChanged: () => refresh({ preserveStatus: true }),
  })
  root.querySelector('[data-vault-management]').appendChild(panel.element)
  root.querySelector('[data-vault-open-add]').addEventListener('click', () => {
    management.open = true
    panel.element.querySelector('[data-vault-new-name]')?.focus()
  })
  // Opening via either the header button or summary follows one refresh path.
  management.addEventListener('toggle', () => { if (management.open) void panel.refresh() })
  refreshButton.addEventListener('click', () => { void refresh() })
  search.addEventListener('input', paint)
  filter.addEventListener('change', paint)

  function say(text) {
    statusNode.textContent = String(text ?? '')
    statusNode.hidden = !text
  }
  function stateFor(name) {
    if (!rowStates.has(name)) rowStates.set(name, { detailsOpen: false, realOpen: false, agentDraft: '', agentAllowed: true })
    return rowStates.get(name)
  }
  function captureFocus() {
    const active = root.ownerDocument?.activeElement
    if (active && rowsNode.contains(active)) {
      heldFocus = { name: active.closest('[data-vault-key]')?.getAttribute('data-vault-key'),
        field: active.getAttribute('data-vault-field'), start: active.selectionStart, end: active.selectionEnd }
    } else if (active && active !== root.ownerDocument?.body) heldFocus = null
  }
  function restoreFocus() {
    if (!heldFocus?.field) return
    const active = root.ownerDocument?.activeElement
    if (active && active !== root.ownerDocument?.body && !rowsNode.contains(active)) return
    const row = [...rowsNode.querySelectorAll('[data-vault-key]')].find(item => item.getAttribute('data-vault-key') === heldFocus.name)
    const target = row && [...row.querySelectorAll('[data-vault-field]')].find(item => item.getAttribute('data-vault-field') === heldFocus.field)
    if (!target || target.disabled) return
    target.focus()
    if (typeof heldFocus.start === 'number' && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(heldFocus.start, heldFocus.end) } catch {}
    }
  }
  function invalidatePolicy() {
    policyReady = false
    panel.invalidate() // Redact already-rendered management names immediately.
    paint()
  }
  function paint() {
    if (destroyed) return
    captureFocus()
    rowsNode.innerHTML = ''
    refreshButton.disabled = pendingWrites.size > 0
    if (!policyReady) { countNode.textContent = ''; return }
    const query = String(search.value || '').trim().toLocaleLowerCase()
    const visible = cached.filter(name => {
      const record = records[name]
      return (record.nickname || name).toLocaleLowerCase().includes(query)
        && (filter.value !== 'restricted' || Object.values(record.access).includes(false))
        && (filter.value !== 'nicknamed' || !!record.nickname)
    }).sort((a, b) => (records[a].nickname || a).localeCompare(records[b].nickname || b))
    countNode.textContent = visible.length + ' of ' + cached.length + ' credentials'
    for (const name of visible) rowsNode.appendChild(drawRow(name, records[name]))
    if (!visible.length && cached.length) rowsNode.appendChild(el('<p class="vault-empty">No credentials match. Try another name or show all credentials.</p>'))
    restoreFocus()
  }
  async function writePolicy(name, call, apply, message, failure, { privateName = false } = {}) {
    if (destroyed || !policyReady || pendingWrites.has(name)) return
    const token = ++writeSequence
    pendingWrites.set(name, token)
    refreshVersion++ // A pre-write policy read cannot overwrite the result.
    if (privateName) {
      say('Saving nickname…')
      root.setAttribute('aria-busy', 'true')
      invalidatePolicy()
    }
    else paint()
    let answer
    try { answer = await call() } catch { answer = null }
    if (destroyed || pendingWrites.get(name) !== token) return
    if (answer?.ok) {
      // Always update the canonical record, including credentials with no rule.
      if (!records[name]) records[name] = { nickname: '', access: Object.create(null) }
      apply(records[name])
    }
    pendingWrites.delete(name)
    if (token === writeSequence) say(answer?.ok ? message : failure)
    paint()
    if (privateName) refreshQueued = true
    if (!pendingWrites.size && refreshQueued) {
      refreshQueued = false
      await refresh({ preserveStatus: true })
    }
  }
  function drawRow(name, record) {
    const state = stateFor(name)
    const nickname = record.nickname, shown = nickname || name, access = record.access
    const restrictions = Object.values(access).filter(value => value === false).length
    const roleIds = new Set(roles.map(role => role.id))
    const agentRules = Object.keys(access).filter(id => !roleIds.has(id))
    const accessSummary = restrictions ? restrictions + ' access restriction' + (restrictions === 1 ? '' : 's') : 'No access restrictions'
    const saving = pendingWrites.has(name)
    const row = el(`<section class="vault-page-row settings-section" data-vault-key="${esc(name)}" aria-busy="${saving}">
      <div class="vault-card-heading"><div><h2 class="settings-section-title" data-vault-shown>${esc(shown)}</h2>
      <p class="vault-card-meta">${nickname ? 'Private nickname' : 'Stored credential'} · <span data-vault-access-summary>${accessSummary}${agentRules.length ? ' · ' + agentRules.length + ' individual agent rule' + (agentRules.length === 1 ? '' : 's') : ''}</span></p></div><span class="vault-badge" data-vault-save-state role="status">${saving ? 'Saving access…' : 'Encrypted'}</span></div>
      ${nickname ? `<details class="vault-page-real"><summary data-vault-field="real-summary">${esc(VAULT_PAGE_COPY.realNameSummary)}</summary><code data-vault-real>${esc(name)}</code></details>` : ''}
      <details class="vault-card-details"><summary data-vault-field="edit-summary">Edit nickname and access</summary><div class="vault-card-body">
      <section class="vault-nickname-editor"><h3>Private nickname</h3>
      <p class="vault-editor-note">Use a name you recognize. The real record name stays behind its disclosure.</p>
      <label class="vault-credentials-label" for="vault-nick-${esc(name)}">${esc(VAULT_PAGE_COPY.nicknameLabel(shown))}</label>
      <input class="vault-credentials-input" id="vault-nick-${esc(name)}" type="text" maxlength="60" data-vault-nickname data-vault-field="nickname" placeholder="${esc(VAULT_PAGE_COPY.nicknamePlaceholder)}" />
      <button type="button" class="ctl-btn" data-vault-save-nickname data-vault-field="save-nickname">Save nickname</button></section>
      <section class="vault-access-editor"><fieldset class="vault-page-matrix" data-vault-matrix><legend>${esc(VAULT_PAGE_COPY.accessLegend(shown))}</legend><p class="vault-editor-note">Role changes save as you select them.</p><div class="vault-role-list" data-vault-role-list></div></fieldset>
      <fieldset class="vault-page-agents"><legend>Individual agents</legend>
      <div data-vault-agents></div>
      <label class="vault-credentials-label">Agent ID<input class="vault-credentials-input" data-vault-agent-id data-vault-field="agent-id" maxlength="120" placeholder="Exact agent ID" /></label>
      <label class="vault-agent-choice"><input type="checkbox" data-vault-agent-allowed data-vault-field="agent-allowed" /> Allow this agent</label>
      <button type="button" class="ctl-btn" data-vault-save-agent data-vault-field="save-agent">Save agent access</button>
      </fieldset></section>
      <div class="vault-editor-footer"><button type="button" class="ctl-btn" data-vault-close-editor data-vault-field="close-editor">Done editing</button></div>
      </div></details></section>`)
    const details = row.querySelector('.vault-card-details')
    details.open = state.detailsOpen
    details.addEventListener('toggle', () => {
      // One focused editor, with each credential's unsaved draft kept intact.
      // Ignore delayed toggle events from a row replaced by an async repaint.
      if (!rowsNode.contains(details)) return
      state.detailsOpen = details.open
      if (!details.open) return
      for (const [key, other] of rowStates) if (key !== name) other.detailsOpen = false
      for (const other of rowsNode.querySelectorAll('.vault-card-details')) {
        if (other !== details) other.open = false
      }
    })
    row.querySelector('[data-vault-close-editor]').addEventListener('click', () => {
      state.detailsOpen = false
      details.open = false
      details.querySelector('summary').focus()
    })
    const real = row.querySelector('.vault-page-real')
    if (real) { real.open = state.realOpen; real.addEventListener('toggle', () => { state.realOpen = real.open }) }
    function addAccessControl(container, subject, label, role = false) {
      const allowed = access[subject] !== false
      const control = el(`<label class="vault-page-cell"><input type="checkbox" ${role ? `data-vault-role="${esc(subject)}"` : ''} data-vault-field="access:${esc(subject)}"${allowed ? ' checked' : ''} /><span>${esc(label)}</span></label>`)
      const box = control.querySelector('input')
      box.addEventListener('change', () => {
        if (pendingWrites.has(name) || destroyed) return
        const next = box.checked
        void writePolicy(name, () => bridge.setAccess({ name, subject, allowed: next }),
          current => { current.access[subject] = next },
          VAULT_PAGE_COPY.accessSaved(label, next), VAULT_PAGE_COPY.accessRefused)
      })
      container.appendChild(control)
    }
    const matrix = row.querySelector('[data-vault-role-list]')
    for (const role of roles) addAccessControl(matrix, role.id, role.label, true)
    const agentList = row.querySelector('[data-vault-agents]')
    for (const id of agentRules) addAccessControl(agentList, id, id)
    const agentInput = row.querySelector('[data-vault-agent-id]')
    const agentAllowed = row.querySelector('[data-vault-agent-allowed]')
    agentInput.value = state.agentDraft
    agentAllowed.checked = state.agentAllowed
    agentInput.addEventListener('input', () => { state.agentDraft = agentInput.value })
    agentAllowed.addEventListener('change', () => { state.agentAllowed = agentAllowed.checked })
    row.querySelector('[data-vault-save-agent]').addEventListener('click', () => {
      const subject = agentInput.value.trim(), allowed = agentAllowed.checked
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(subject) || roleIds.has(subject)) { say('Enter an exact agent ID. Use the role controls for a role.'); return }
      void writePolicy(name, () => bridge.setAccess({ name, subject, allowed }),
        current => { current.access[subject] = allowed },
        'Agent access saved.', VAULT_PAGE_COPY.accessRefused)
    })
    const nickInput = row.querySelector('[data-vault-nickname]')
    nickInput.value = state.nickDraft ?? nickname
    nickInput.addEventListener('input', () => { state.nickDraft = nickInput.value })
    row.querySelector('[data-vault-save-nickname]').addEventListener('click', () => {
      const typed = nickInput.value, wanted = typed.trim()
      void writePolicy(name, () => bridge.setNickname({ name, nickname: wanted || null }),
        current => { current.nickname = wanted; if (state.nickDraft === typed) delete state.nickDraft },
        wanted ? VAULT_PAGE_COPY.nicknameSaved : VAULT_PAGE_COPY.nicknameCleared,
        VAULT_PAGE_COPY.nicknameRefused, { privateName: true })
    })
    for (const control of row.querySelectorAll('input,button')) control.disabled = saving && !control.hasAttribute('data-vault-close-editor')
    return row
  }
  async function refresh({ preserveStatus = false } = {}) {
    if (destroyed) return
    if (pendingWrites.size) { refreshQueued = true; return }
    const version = ++refreshVersion
    invalidatePolicy()
    if (!preserveStatus) say(VAULT_PAGE_COPY.reading)
    root.setAttribute('aria-busy', 'true')
    let listed, policy
    try { [listed, policy] = await Promise.all([bridge.names(), bridge.policy()]) }
    catch {
      if (destroyed || version !== refreshVersion) return
      root.setAttribute('aria-busy', 'false')
      say(bridge ? VAULT_PAGE_COPY.unreadable : VAULT_PAGE_COPY.bridgeAbsent)
      return
    }
    if (destroyed || version !== refreshVersion) return
    root.setAttribute('aria-busy', 'false')
    if (listed?.ok !== true || !Array.isArray(listed.names)) { say(listed?.reason || VAULT_PAGE_COPY.unreadable); return }
    if (!policy?.readable) { say(VAULT_PAGE_COPY.policyUnreadable); return }
    const next = Object.create(null)
    cached = [...new Set(listed.names.filter(name => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(name)))]
    for (const name of cached) {
      const entry = Object.hasOwn(policy.records || {}, name) ? policy.records[name] : null
      next[name] = { nickname: typeof entry?.nickname === 'string' ? entry.nickname : '',
        access: Object.assign(Object.create(null), entry?.access || {}) }
    }
    records = next
    policyReady = true
    for (const name of rowStates.keys()) if (!cached.includes(name)) rowStates.delete(name)
    paint()
    if (!cached.length) say(VAULT_PAGE_COPY.empty)
    else if (!preserveStatus) say('')
    // Both displays consume this exact successful names/policy snapshot.
    await panel.setSnapshot({ ok: true, names: cached })
  }
  void refresh()
  return { el: root, refresh, destroy() { destroyed = true; refreshVersion++; writeSequence++; pendingWrites.clear(); panel.destroy() } }
}
