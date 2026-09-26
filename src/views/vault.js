/* /vault — the credentials this computer holds, what they are called, and who
 * may read each one.
 *
 * WHY THIS IS A PAGE AND NOT A SETTINGS ROW. The vault is supposed to have its
 * own page like Settings and Ledger do. It had been delivered as the
 * `vault_credentials` row inside Settings' "Data & Privacy" section -- a real
 * surface, reachable, and not a page. A row inside a category inside another
 * page is not a page of its own, and describing it as one is how the request
 * kept coming back.
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
 * THE NICKNAME REPLACES THE NAME RATHER THAN LABELLING IT. The rule is that
 * credentials get secret nicknames so the real names are not visible. A
 * nickname shown beside the real name would leave the real name visible, which
 * is the thing to prevent. So a nicknamed record shows its nickname where
 * its name would be, and the real name is behind a per-row disclosure that is
 * closed until the owner opens it -- available to the person sitting here, not
 * on screen by default and never handed to an assistant.
 *
 * THE MATRIX IS ENFORCED SOMEWHERE ELSE, WHICH IS THE POINT. These checkboxes
 * write to the durable policy in shell/vault-access-policy.cjs; the refusal
 * happens in shell/vault-presence.cjs's `vaultRecordValues`, before the vault is
 * opened, in the main process. A switch that only hid a row here would be a
 * label on a door that does not lock. The engine reads the same file on its own
 * side, which is how a rule written here reaches a read this process never
 * makes -- an agent's, or a scheduled run's.
 */

import { el } from '../components.js'
import { ROLE_COLOR_NAMES } from '../role-colors.js'
import { APPROVALS_HREF, VAULT_COPY, createVaultCredentialsSettings } from '../vault-credentials-settings.js'
/* Both stylesheets live at src/, not src/views/ -- every other view in this
   directory reaches them with `../`. THE PAGE NO LONGER BORROWS SETTINGS'
   LAYOUT (2026-09-23 overhaul). It was built from `settings-shell`,
   `settings-header` and `settings-section`, and the side navigation's rules for
   Settings (src/sidebar-pages.css) then stripped every credential card of its
   edge and padding, so the rows floated on the page. Its own classes, all in
   src/vault-page.css, keep Settings' changes from reshaping this page. */
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

/* THE PRINCIPALS THAT ARE NOT ROLES, and why the list above cannot reach them.
 *
 * A rule may name anything the policy's principal shape accepts, but the names
 * above are the palette of roles an AGENT runs as -- so a principal that is not
 * an agent gets no control from them, however hard the policy can rule on it.
 * That left exactly one enforced decision the owner could not author: a
 * SCHEDULED read. The engine's dispatch site fixes its principal in code
 * (`roleId: 'scheduler'` in its job runner) and the shared policy file refuses
 * the read when `access.scheduler` is false -- a lock with no key, which is the
 * mirror image of the defect this page's header warns about.
 *
 * The id here is the wire name and must stay spelled exactly as the dispatch
 * site spells it: a rule under any other spelling is stored, drawn as set, and
 * matches no read, which is worse than no control because it reads as a closed
 * door. The label is what the owner reads; the roleId is not shown, because
 * "scheduler" is a name the product uses to itself.
 *
 * They are drawn apart from the roles rather than mixed in. A scheduled run is
 * this computer acting for itself, not an agent wearing a role, and listing it
 * between Builder and Reviewer would say otherwise. */
const NON_ROLE_PRINCIPALS = Object.freeze([
  Object.freeze({ id: 'scheduler', label: 'Scheduled actions' }),
])

export function nonRolePrincipals() {
  return NON_ROLE_PRINCIPALS.map(principal => ({ ...principal }))
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
  accessLegend: name => `Who may read ${name}`,
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
  /* The page's own labels. A count is drawn only from a snapshot that answered;
     before that each count reads "Not read", never 0. */
  eyebrow: 'This computer',
  listTitle: 'Credentials',
  factTotal: 'Credentials',
  factNicknamed: 'Shown by a private nickname',
  factRestricted: 'With access restrictions',
  factNotRead: 'Not read',
  shownNickname: 'Private nickname',
  shownReal: 'Real name',
  nameTitle: 'Name',
  nicknameNote: 'Assistants and this screen use the nickname in place of the real name. Clear it and save to show the real name again.',
  accessNote: 'Each change saves as soon as you make it.',
  /* Said beside the control rather than only in the rules panel: the owner is
     about to refuse a credential to something that is not an agent, and the
     consequence is that their own scheduled runs stop using it. */
  automationNote: 'This computer’s own automation, not an agent role. A scheduled action reads the vault as the '
    + 'scheduler, so refusing it here stops every scheduled run from using this credential.',
  agentsNote: 'Add a rule for one agent by its exact agent ID.',
  agentIdRefused: 'Enter an exact agent ID. Use the controls above for a role or for this computer’s own automation.',
  manageHint: 'Ask for a new credential, or remove one after you approve it.',
  rulesTitle: 'How this vault works',
  rules: Object.freeze([
    ['Values', 'What a credential holds is never shown on this screen, and this product never shows it to an assistant either.'],
    ['Nicknames', 'A nickname replaces the real record name here and for assistants. To see the real name, open the credential and choose Show the real record name.'],
    ['Who may read', 'Every role, and this computer’s own scheduled actions, may read a credential until you set that one to Refused. This computer checks the rule before it opens the vault.'],
    ['Removing', 'Remove asks for your approval on the approvals screen first. Nothing is removed until you approve it.'],
  ]),
  approvalsLink: 'Open the approvals screen',
})

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* Two small line icons, drawn in currentColor so every theme colours them. */
const CHEVRON = '<svg class="vault-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>'
const LOCK = '<svg class="vault-lock" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3.25" y="7" width="9.5" height="6.75" rx="1.25" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>'

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
  const automation = nonRolePrincipals()

  /* THE LAYOUT. A header with the one primary action; a strip of counts; then
     the credentials as a table (one row per credential, the editor opening
     under its own row) with "Add or remove credentials" under it; and, beside
     it on a wide window, a short account of the rules this page works under.
     DOM ORDER IS LOAD-BEARING: this page's [data-vault-status] must come
     before the embedded panel's own [data-vault-status], and "Add or remove
     credentials" stays under the list, where the Vault guide says it is. */
  const root = el(`<div class="view-pad vault-page">
    <div class="vault-shell">
      <header class="vault-header">
        <div class="vault-title">
          <p class="vault-eyebrow">${esc(VAULT_PAGE_COPY.eyebrow)}</p>
          <h1 class="vault-h1">${esc(VAULT_PAGE_COPY.title)}</h1>
          <p class="vault-lede">${esc(VAULT_PAGE_COPY.lede)}</p>
        </div>
        <div class="vault-header-actions">
          <button type="button" class="ctl-btn vault-primary" data-vault-open-add>Add credential</button>
        </div>
      </header>
      <div class="vault-layout">
        <div class="vault-main">
          <dl class="vault-facts" data-vault-facts>
            <div class="vault-fact"><dt>${esc(VAULT_PAGE_COPY.factTotal)}</dt><dd data-vault-fact="total"></dd></div>
            <div class="vault-fact"><dt>${esc(VAULT_PAGE_COPY.factNicknamed)}</dt><dd data-vault-fact="nicknamed"></dd></div>
            <div class="vault-fact"><dt>${esc(VAULT_PAGE_COPY.factRestricted)}</dt><dd data-vault-fact="restricted"></dd></div>
          </dl>
          <section class="vault-panel is-empty" aria-labelledby="vault-list-title">
            <div class="vault-panel-head">
              <h2 class="vault-panel-title" id="vault-list-title">${esc(VAULT_PAGE_COPY.listTitle)}</h2>
              <p class="vault-result-count" data-vault-count aria-live="polite"></p>
            </div>
            <div class="vault-toolbar">
              <label class="vault-search"><span class="vault-field-label">Search credentials</span><input type="search" data-vault-search placeholder="Search displayed names" /></label>
              <label class="vault-filter"><span class="vault-field-label">Show</span><select data-vault-filter><option value="all">All credentials</option><option value="restricted">With access restrictions</option><option value="nicknamed">With private nicknames</option></select></label>
              <button type="button" class="ctl-btn" data-vault-refresh>Refresh</button>
            </div>
            <p class="vault-notice" data-vault-status role="status">${esc(VAULT_PAGE_COPY.reading)}</p>
            <div class="vault-table-head" data-vault-table-head aria-hidden="true" hidden>
              <span>Credential</span><span>Shown as</span><span>Who may read it</span><span>Status</span><span class="vault-table-head-open"></span>
            </div>
            <div class="vault-page-rows" data-vault-rows></div>
          </section>
          <details class="vault-manage" data-vault-manage>
            <summary class="vault-manage-summary"><span class="vault-manage-title">Add or remove credentials</span><span class="vault-manage-hint">${esc(VAULT_PAGE_COPY.manageHint)}</span>${CHEVRON}</summary>
            <div class="vault-manage-body" data-vault-management></div>
          </details>
        </div>
        <aside class="vault-aside" aria-labelledby="vault-rules-title">
          <h2 class="vault-aside-title" id="vault-rules-title">${esc(VAULT_PAGE_COPY.rulesTitle)}</h2>
          <dl class="vault-rules">${VAULT_PAGE_COPY.rules.map(([term, text]) => `<div><dt>${esc(term)}</dt><dd>${esc(text)}</dd></div>`).join('')}</dl>
          <a class="vault-link" href="${APPROVALS_HREF}">${esc(VAULT_PAGE_COPY.approvalsLink)}</a>
        </aside>
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
  const tableHead = root.querySelector('[data-vault-table-head]')
  const tablePanel = root.querySelector('.vault-panel')
  const factNodes = ['total', 'nicknamed', 'restricted'].map(key => [key, root.querySelector(`[data-vault-fact="${key}"]`)])
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
  /* The counts come from the same snapshot as the rows, and only once it has
     answered: before that they say "Not read" rather than a 0 that would claim
     an empty vault. */
  function paintFacts() {
    const counts = policyReady ? {
      total: cached.length,
      nicknamed: cached.filter(name => !!records[name]?.nickname).length,
      restricted: cached.filter(name => Object.values(records[name]?.access || {}).includes(false)).length,
    } : null
    for (const [key, node] of factNodes) {
      if (!node) continue
      node.innerHTML = counts ? esc(counts[key])
        : `<span aria-hidden="true">—</span><span class="vault-sr">${esc(VAULT_PAGE_COPY.factNotRead)}</span>`
      node.classList.toggle('is-unread', !counts)
    }
  }
  function showTable(hasRows) {
    tableHead.hidden = !hasRows
    tablePanel.classList.toggle('is-empty', !hasRows)
  }
  function paint() {
    if (destroyed) return
    captureFocus()
    rowsNode.innerHTML = ''
    refreshButton.disabled = pendingWrites.size > 0
    paintFacts()
    if (!policyReady) { countNode.textContent = ''; showTable(false); return }
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
    showTable(visible.length > 0)
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
    /* Every principal this page already draws a control for. The agent list
       below is "everything else the policy names", so a principal missing from
       this set would be drawn twice -- once as its own control and once as an
       individual agent -- and a repaint could leave the two disagreeing. */
    const drawnIds = new Set([...roles, ...automation].map(principal => principal.id))
    const agentRules = Object.keys(access).filter(id => !drawnIds.has(id))
    const accessSummary = restrictions ? restrictions + ' access restriction' + (restrictions === 1 ? '' : 's') : 'No access restrictions'
    const saving = pendingWrites.has(name)
    /* ONE ROW PER CREDENTIAL, AND THE ROW IS THE DISCLOSURE. The summary is the
       table line (name, how it is shown, who may read it, state), so the whole
       line opens the editor under it. The real name of a nicknamed record is
       not on that line: it sits inside the editor, behind its own closed
       disclosure, so opening a row to change access still does not print it. */
    const row = el(`<section class="vault-page-row${nickname ? ' is-nicknamed' : ''}${restrictions ? ' is-restricted' : ''}" data-vault-key="${esc(name)}" aria-busy="${saving}">
      <details class="vault-card-details"><summary class="vault-row-line" data-vault-field="edit-summary">
        <h2 class="vault-row-name" data-vault-shown>${esc(shown)}</h2>
        <span class="vault-cell vault-cell-kind"><span class="vault-kind">${esc(nickname ? VAULT_PAGE_COPY.shownNickname : VAULT_PAGE_COPY.shownReal)}</span></span>
        <span class="vault-cell vault-cell-access" data-vault-access-summary>${accessSummary}${agentRules.length ? ' · ' + agentRules.length + ' individual agent rule' + (agentRules.length === 1 ? '' : 's') : ''}</span>
        <span class="vault-cell vault-cell-state"><span class="vault-badge" data-vault-save-state role="status">${saving ? 'Saving access…' : LOCK + 'Encrypted'}</span></span>
        <span class="vault-cell vault-cell-open"><span class="vault-open-closed">Edit</span><span class="vault-open-open">Close</span>${CHEVRON}</span>
      </summary><div class="vault-card-body">
      <section class="vault-nickname-editor"><h3 class="vault-editor-title">${esc(VAULT_PAGE_COPY.nameTitle)}</h3>
      ${nickname ? `<details class="vault-page-real"><summary data-vault-field="real-summary">${esc(VAULT_PAGE_COPY.realNameSummary)}</summary><code data-vault-real>${esc(name)}</code></details>` : ''}
      <label class="vault-credentials-label" for="vault-nick-${esc(name)}">${esc(VAULT_PAGE_COPY.nicknameLabel(shown))}</label>
      <div class="vault-field-row"><input class="vault-credentials-input" id="vault-nick-${esc(name)}" type="text" maxlength="60" data-vault-nickname data-vault-field="nickname" placeholder="${esc(VAULT_PAGE_COPY.nicknamePlaceholder)}" />
      <button type="button" class="ctl-btn" data-vault-save-nickname data-vault-field="save-nickname">Save nickname</button></div>
      <p class="vault-editor-note">${esc(VAULT_PAGE_COPY.nicknameNote)}</p></section>
      <fieldset class="vault-page-matrix" data-vault-matrix><legend class="vault-editor-title">${esc(VAULT_PAGE_COPY.accessLegend(shown))}</legend><p class="vault-editor-note">${esc(VAULT_PAGE_COPY.accessNote)}</p><div class="vault-role-list" data-vault-role-list></div>
      <p class="vault-editor-note">${esc(VAULT_PAGE_COPY.automationNote)}</p><div class="vault-role-list" data-vault-automation-list></div></fieldset>
      <fieldset class="vault-page-agents"><legend class="vault-editor-title">Individual agents</legend>
      <p class="vault-editor-note">${esc(VAULT_PAGE_COPY.agentsNote)}</p>
      <div class="vault-agent-rules" data-vault-agents></div>
      <label class="vault-credentials-label vault-agent-field"><span class="vault-field-label">Agent ID</span><input class="vault-credentials-input" data-vault-agent-id data-vault-field="agent-id" maxlength="120" placeholder="Exact agent ID" /></label>
      <div class="vault-agent-actions"><label class="vault-agent-choice"><input type="checkbox" data-vault-agent-allowed data-vault-field="agent-allowed" /> Allow this agent</label>
      <button type="button" class="ctl-btn" data-vault-save-agent data-vault-field="save-agent">Save agent access</button></div>
      </fieldset>
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
    /* `kind` is 'role', 'automation', or '' for an agent the owner typed in. It
       only decides the extra marker attribute: `data-vault-role` is what the
       screenshot tool counts, and a scheduled run is not a role, so it gets its
       own marker rather than borrowing that one. */
    function addAccessControl(container, subject, label, kind = '') {
      const allowed = access[subject] !== false
      /* The words beside the box are the ones the Vault guide teaches: May read
         and Refused. They are drawn from the retained decision, like the box. */
      const control = el(`<label class="vault-page-cell${allowed ? '' : ' is-refused'}"><input type="checkbox" ${kind ? `data-vault-${kind}="${esc(subject)}"` : ''} data-vault-field="access:${esc(subject)}"${allowed ? ' checked' : ''} /><span class="vault-cell-text">${esc(label)}</span><span class="vault-access-state">${esc(allowed ? VAULT_PAGE_COPY.accessOn : VAULT_PAGE_COPY.accessOff)}</span></label>`)
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
    for (const role of roles) addAccessControl(matrix, role.id, role.label, 'role')
    const automationList = row.querySelector('[data-vault-automation-list]')
    for (const principal of automation) addAccessControl(automationList, principal.id, principal.label, 'automation')
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
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(subject) || drawnIds.has(subject)) { say(VAULT_PAGE_COPY.agentIdRefused); return }
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
