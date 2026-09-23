import { el } from './components.js'
import researcherRoleDocument from './data/researcher.role.json' with { type: 'json' }
import { defaultRoleColor, readRoleColors } from './role-colors.js'
import { ROLE_FIELDS, roleDraft, sameDraft, roleDocument, parseRoleDocument, directionsPreview,
  roleConnections, initialRolePositions, functionExample } from './role-studio-model.js'

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const clone = value => JSON.parse(JSON.stringify(value))
let nextStudioId = 0

export function buildRoleStudio({ availability, blocked, onCreate, onEdit, onReset, onRead, scopeKey = availability?.overlayFile || '' }) {
  let roles = availability?.roles || []
  const catalog = availability?.functionCatalog || []
  const maxText = availability?.ruleTextLimit || 1500
  const colors = readRoleColors().colors
  const color = id => colors[id] || defaultRoleColor(id)
  const drafts = new Map()
  let selected = roles[0]?.id || 'new'
  let view = 'canvas'
  let tab = 'directions'
  let roleQuery = ''
  let functionQuery = ''
  let functionFilter = 'all'
  let positions = initialRolePositions(roles)
  let zoom = 1
  let busy = false
  let showReset = false
  const uid = `role-studio-${++nextStudioId}`
  const box = el(`<section class="board-box board-roles-box">
    <div class="board-box-h"><span class="bh-t">Role library</span><span data-role-count>${roles.length}</span></div>
    <p class="rail-sub">Shape how your agents work. Edit directions, choose functions, and see how roles connect.</p>
    ${blocked ? `<p class="org-notice">${esc(blocked)}</p>` : ''}
    <button class="ctl-btn role-studio-launch" type="button" data-open-studio${blocked ? ' disabled' : ''}>Open role workspace <span aria-hidden="true">↗</span></button>
    <output class="ctl-out" data-roles="out" role="status"></output>
    <dialog class="role-studio" aria-labelledby="${uid}-title">
      <div class="rs-shell">
        <header class="rs-header"><div><span class="rs-eyebrow">YOUR AGENT TEAM</span><h1 id="${uid}-title">Role workspace</h1></div>
          <div class="rs-header-actions"><span class="rs-draft-summary" data-draft-summary></span><button type="button" data-action="close" aria-label="Close role workspace">Close <span aria-hidden="true">×</span></button></div>
        </header>
        <div class="rs-layout">
          <aside class="rs-sidebar" aria-label="Role library">
            <button class="rs-canvas-link" type="button" data-action="canvas"><span aria-hidden="true">▦</span> Role canvas</button>
            <label class="rs-search"><span class="rs-sr">Find a role</span><input type="search" data-role-search placeholder="Find a role…"></label>
            <nav class="rs-role-list" aria-label="Choose a role" data-role-list></nav>
            <div class="rs-library-actions"><button type="button" data-action="new">+ New role</button><button type="button" data-action="researcher">+ Researcher role</button><button type="button" data-action="import">Import file</button><input type="file" accept=".json,application/json" data-import-file hidden></div>
          </aside>
          <main class="rs-main" data-studio-main></main>
        </div>
        <footer class="rs-status"><output role="status" aria-live="polite" data-studio-status>Choose a role to start editing.</output><span>Drafts stay here until you save · Ctrl / ⌘ S to save</span></footer>
      </div>
    </dialog>
  </section>`)
  const dialog = box.querySelector('dialog')
  const main = box.querySelector('[data-studio-main]')
  const roleList = box.querySelector('[data-role-list]')
  const status = box.querySelector('[data-studio-status]')
  const savedStatus = box.querySelector('[data-roles="out"]')
  const say = message => { status.textContent = message; savedStatus.textContent = message }
  const announceClosed = () => { savedStatus.textContent = 'Workspace closed. Unsaved drafts are kept for this page visit.' }
  const getRole = id => roles.find(role => role.id === id)
  const entryFor = id => {
    if (!drafts.has(id)) {
      const role = getRole(id)
      const draft = roleDraft(role)
      drafts.set(id, { draft, baseline: clone(draft), revision: role?.revision ?? 0 })
    }
    return drafts.get(id)
  }
  const dirty = entry => !sameDraft(entry.draft, entry.baseline)
  const inheritedRole = () => selected === 'new' ? getRole(entryFor('new').draft.baseDefaultRole) : getRole(selected)
  const guidanceRole = () => {
    const role = inheritedRole()
    return { ...role, name: selected === 'new' ? entryFor('new').draft.id : role?.name }
  }
  function refreshBadges() {
    let count = 0
    for (const [id, entry] of drafts) {
      if (dirty(entry)) count++
      const dot = [...roleList.querySelectorAll('[data-draft-dot]')].find(node => node.dataset.draftDot === id)
      if (dot) dot.hidden = !dirty(entry)
    }
    box.querySelector('[data-draft-summary]').textContent = count ? `${count} unsaved ${count === 1 ? 'draft' : 'drafts'}` : 'All changes saved'
    const state = main.querySelector('[data-edit-state]')
    if (state) state.textContent = dirty(entryFor(selected)) ? 'Unsaved draft' : 'Saved'
    const save = main.querySelector('[data-action="save"]')
    if (save) save.disabled = busy || !!entryFor(selected).conflict || (selected !== 'new' && !dirty(entryFor(selected)))
  }
  function renderLibrary() {
    const query = roleQuery.trim().toLowerCase()
    const matches = roles.filter(role => `${role.name} ${role.id} ${role.summary || ''}`.toLowerCase().includes(query))
    roleList.innerHTML = matches.map(role => `<button type="button" class="rs-role-link" data-select-role="${esc(role.id)}" aria-current="${view === 'editor' && selected === role.id}" style="--rs-role:${color(role.id)}">
      <span class="rs-role-dot" aria-hidden="true"></span><span><b>${esc(role.name || role.id)}</b><small>${role.custom ? 'Custom role' : 'Default role'}</small></span><span class="rs-unsaved-dot" data-draft-dot="${esc(role.id)}" title="Unsaved draft" aria-label="Unsaved draft" hidden>•</span></button>`).join('') || '<p class="rs-empty">No matching roles.</p>'
    if (drafts.has('new')) roleList.insertAdjacentHTML('beforeend', `<button type="button" class="rs-role-link" data-select-role="new" aria-current="${view === 'editor' && selected === 'new'}"><span aria-hidden="true">＋</span><span><b>${esc(entryFor('new').draft.id || 'New role')}</b><small>Not created yet</small></span></button>`)
    box.querySelector('[data-action="canvas"]').setAttribute('aria-current', String(view === 'canvas'))
    box.querySelector('[data-role-count]').textContent = roles.length
    refreshBadges()
  }
  function selectRole(id) {
    const changed = selected !== id || view !== 'editor'
    selected = id; view = 'editor'; showReset = false
    entryFor(id)
    renderLibrary(); renderEditor()
    if (changed) say(id === 'new' ? 'New role draft.' : `Editing ${getRole(id)?.name || id}.`)
  }
  function canvasMarkup() {
    const edges = roleConnections(availability?.org, roles)
    const counts = new Map()
    for (const agent of availability?.org?.agents || []) counts.set(agent.role, (counts.get(agent.role) || 0) + 1)
    const width = Math.max(920, ...Object.values(positions).map(p => p.x + 300))
    const height = Math.max(600, ...Object.values(positions).map(p => p.y + 200))
    return `<div class="rs-canvas-heading"><div><h2>Every role, working together</h2><p>Open a card to edit. Drag its handle to arrange your canvas.</p></div><div class="rs-zoom"><button type="button" data-action="zoom-out" aria-label="Zoom out">−</button><output data-zoom>${Math.round(zoom * 100)}%</output><button type="button" data-action="zoom-in" aria-label="Zoom in">+</button><button type="button" data-action="fit">Fit</button><button type="button" data-action="arrange">Arrange</button></div></div>
      <div class="rs-canvas" data-canvas tabindex="0" aria-label="Role canvas. Scroll to explore; select a role to edit.">
        <div class="rs-canvas-space" style="width:${width * zoom}px;height:${height * zoom}px"><div class="rs-canvas-world" style="width:${width}px;height:${height}px;transform:scale(${zoom})">
          <svg class="rs-connections" width="${width}" height="${height}" aria-label="Saved reporting relationships">
            ${edges.map(edge => {
              const a = positions[edge.from], b = positions[edge.to]
              if (!a || !b || edge.from === edge.to) return ''
              const x1 = a.x + 128, y1 = a.y + 150, x2 = b.x + 128, y2 = b.y
              return `<path d="M${x1},${y1} C${x1},${y1 + 55} ${x2},${y2 - 55} ${x2},${y2}" data-edge-from="${esc(edge.from)}" data-edge-to="${esc(edge.to)}"><title>${esc(edge.from)} manages ${esc(edge.to)} · ${edge.count} saved reporting ${edge.count === 1 ? 'line' : 'lines'}</title></path>`
            }).join('')}
          </svg>
          ${roles.map(role => `<article class="rs-node" data-node-id="${esc(role.id)}" style="--rs-role:${color(role.id)};left:${positions[role.id]?.x || 0}px;top:${positions[role.id]?.y || 0}px">
            <div class="rs-node-top"><span>${role.custom ? 'Custom' : 'Default'}</span><button type="button" class="rs-drag" data-drag-role="${esc(role.id)}" aria-label="Move ${esc(role.name || role.id)} card; use arrow keys" title="Drag to move; arrow keys also work">⠿</button></div>
            <button type="button" class="rs-node-open" data-select-role="${esc(role.id)}"><b>${esc(role.name || role.id)} <span aria-hidden="true">↗</span></b><span>${esc(role.summary || role.owns)}</span></button>
            <div class="rs-node-foot"><span>${counts.get(role.id) || 0} assigned</span><span>${Array.isArray(role.functions) ? role.functions.length + ' functions' : 'Installed functions'}</span></div>
          </article>`).join('')}
        </div></div>
      </div><div class="rs-canvas-note">Lines show saved manager → report relationships, grouped by role. Card positions are personal layout only.${edges.some(edge => edge.from === edge.to) ? ' Some reporting lines connect agents with the same role.' : ''}</div>`
  }
  function renderCanvas() { main.innerHTML = canvasMarkup() }
  function directionsMarkup(draft) {
    return `<div class="rs-directions">${ROLE_FIELDS.map((field, i) => `<label class="rs-direction"><span class="rs-field-heading"><b><span class="rs-field-number">0${i + 1}</span>${field.label}</b><output data-count="${field.key}">${draft.rules[field.key].length} / ${maxText}</output></span><span class="rs-help">${field.hint}</span><textarea data-field="${field.key}" maxlength="${maxText}" rows="6" spellcheck="true">${esc(draft.rules[field.key])}</textarea></label>`).join('')}
      ${guidanceRole()?.rules?.length ? `<details class="rs-inherited"><summary>Inherited operating guidance · ${guidanceRole().rules.length} rules</summary><p class="rs-help">Included with this role’s directions. Custom roles inherit this guidance from their base.</p><ul>${guidanceRole().rules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ul></details>` : ''}</div>`
  }
  function functionsMarkup(draft) {
    if (!catalog.length) return '<p class="rs-empty">This copy did not provide a function catalog. Existing function choices will be preserved when you save directions.</p>'
    const standard = draft.functions === null
    const selectedFunctions = new Set(draft.functions === null
      ? catalog.filter(item => item.defaultEnabled !== false).map(item => item.id)
      : draft.functions)
    const items = [...catalog, ...[...selectedFunctions].filter(id => !catalog.some(item => item.id === id)).map(id => ({ id, effect: 'unavailable', summary: 'Not installed in this build. This saved name is retained, but cannot be called.' }))]
    return `<div class="rs-function-policy" data-role-functions>
      <label><input type="checkbox" data-field="functions-standard"${standard ? ' checked' : ''}><span><b>Use installed function defaults</b><small>Or turn this off to choose exactly which functions this role uses.</small></span></label>
      <label><input type="checkbox" data-field="direct-user"${draft.requiresDirectUserAuthorization ? ' checked' : ''}><span><b>Actions require a direct user request</b><small>Useful for an on-demand assistant. Reading functions remain available.</small></span></label>
      <p class="rs-help">Selections work within the role’s abilities and the session’s permissions.</p>
    </div><div class="rs-function-toolbar"><input type="search" data-function-search aria-label="Find a function" placeholder="Search names or descriptions…" value="${esc(functionQuery)}"><select data-function-filter aria-label="Filter functions">${[['all','All functions'],['selected','Selected'],['read','Read only'],['action','Actions'],['unavailable','Unavailable']].map(([id,label]) => `<option value="${id}"${id === functionFilter ? ' selected' : ''}>${label}</option>`).join('')}</select><span data-function-count></span></div>
    <div class="rs-function-bulk"><button type="button" data-action="select-visible"${standard ? ' disabled' : ''}>Select visible</button><button type="button" data-action="clear-visible"${standard ? ' disabled' : ''}>Clear visible</button><span class="rs-help">Selecting no functions disables all ToolsEnabled functions for this role.</span></div>
    <div class="rs-functions">${items.map(item => `<details class="rs-function" data-function-row data-search="${esc(`${item.id} ${item.summary}`.toLowerCase())}" data-effect="${esc(item.effect)}">
      <summary><input type="checkbox" data-function-id="${esc(item.id)}" aria-label="Include ${esc(item.id)}"${selectedFunctions.has(item.id) ? ' checked' : ''}${standard ? ' disabled' : ''}><span><b>${esc(item.id)}</b><small>${esc(item.summary)}</small></span><span class="rs-effect">${item.effect === 'unavailable' ? 'Unavailable' : /-read$/.test(item.effect) ? 'Read' : 'Action'}</span></summary>
      <div class="rs-function-detail"><p>${esc(item.description || item.summary)}</p>${item.inputSchema ? `<h3>Inputs</h3><pre>${esc(JSON.stringify(item.inputSchema, null, 2))}</pre><h3>Call template</h3><p class="rs-help">Replace placeholder values before use.</p><pre>${esc(functionExample(item))}</pre><button type="button" data-copy-function="${esc(item.id)}">Copy call template</button>` : '<p class="rs-help">Input details are not available in this build.</p>'}</div>
    </details>`).join('')}</div><p class="rs-empty" data-function-empty hidden>No functions match this filter.</p>`
  }
  function filterFunctions() {
    const entry = entryFor(selected)
    let count = 0
    for (const row of main.querySelectorAll('[data-function-row]')) {
      const input = row.querySelector('[data-function-id]')
      const effect = row.dataset.effect
      const matches = row.dataset.search.includes(functionQuery.toLowerCase().trim()) && (functionFilter === 'all'
        || (functionFilter === 'selected' && input.checked)
        || (functionFilter === 'read' && /-read$/.test(effect))
        || (functionFilter === 'action' && !/-read$/.test(effect) && effect !== 'unavailable')
        || (functionFilter === 'unavailable' && effect === 'unavailable'))
      row.hidden = !matches
      if (matches) count++
    }
    const counter = main.querySelector('[data-function-count]')
    if (counter) counter.textContent = `${count} shown · ${entry.draft.functions === null ? 'defaults' : entry.draft.functions.length + ' selected'}`
    const empty = main.querySelector('[data-function-empty]')
    if (empty) empty.hidden = count !== 0
  }
  function renderEditor() {
    const entry = entryFor(selected), draft = entry.draft, role = inheritedRole()
    const fresh = selected === 'new'
    const capabilities = role?.capabilities || {}
    main.innerHTML = `<div class="rs-editor-heading"><div><span class="rs-eyebrow">${fresh ? 'NEW ROLE' : getRole(selected)?.custom ? 'CUSTOM ROLE' : 'DEFAULT ROLE'}</span><h2>${esc(fresh ? draft.id || 'Make a role your own' : role?.name || selected)}</h2><p>${esc(fresh ? 'Start from a role that already works, then shape its responsibilities.' : role?.summary || role?.id)}</p></div><span data-edit-state></span></div>
      ${entry.conflict ? `<section class="rs-conflict"><b>This role changed in another window.</b><p>Your draft is preserved. Review the saved version before choosing which to keep.</p><details><summary>Current saved directions and functions</summary><pre>${esc(roleDocument(roleDraft(getRole(selected))))}</pre></details><button type="button" data-action="discard">Use saved version</button><button type="button" data-action="keep-draft">Keep my draft for the next save</button></section>` : ''}
      ${fresh ? `<div class="rs-new-fields"><label>Role ID<input type="text" data-field="id" maxlength="64" placeholder="release-reviewer" value="${esc(draft.id)}"></label><label>Start from<select data-field="base"><option value="">Blank role</option>${roles.filter(r => !r.custom).map(r => `<option value="${esc(r.id)}"${draft.baseDefaultRole === r.id ? ' selected' : ''}>${esc(r.name || r.id)}</option>`).join('')}</select></label><p class="rs-help">A base supplies starting directions, operating guidance and abilities. Changing it fills only empty directions fields.</p></div>` : ''}
      <div class="rs-abilities"><span>${capabilities.mayClaimWork ? 'Can take assigned work' : 'Cannot reserve work'}</span><span>${capabilities.mayWakeReports ? 'Can wake reports' : 'Does not wake reports'}</span>${capabilities.orgRoot ? '<span>Organisation root</span>' : ''}${capabilities.singleSeat ? '<span>One seat</span>' : ''}<span>${capabilities.mayMutateMissionBridge ? 'Team APIs: act' : capabilities.mayReportMissionBridge ? 'Team APIs: report' : capabilities.mayUseMissionBridge ? 'Team APIs: inspect' : 'No team API access'}</span></div>
      <div class="rs-tabs" role="tablist" aria-label="Role editor sections">${[['directions','Directions'],['functions','Functions'],['preview','Preview & file']].map(([id,label]) => `<button type="button" role="tab" id="${uid}-${id}" aria-controls="${uid}-panel" aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}" data-tab="${id}">${label}</button>`).join('')}</div>
      <div class="rs-editor-body" id="${uid}-panel" role="tabpanel" aria-labelledby="${uid}-${tab}">${tab === 'directions' ? directionsMarkup(draft) : tab === 'functions' ? functionsMarkup(draft) : `<div class="rs-preview"><h3>Directions preview</h3><p class="rs-help">Includes your draft and inherited guidance. The session also receives its assignment and runtime context at start.</p><pre>${esc(directionsPreview(guidanceRole(), draft))}</pre><div class="rs-file-actions"><button type="button" data-action="export">Export role JSON</button><button type="button" data-action="copy-directions">Copy directions</button></div><details><summary>Portable role file</summary><pre>${esc(roleDocument(draft))}</pre></details></div>`}</div>
      <footer class="rs-editor-footer"><div><button class="rs-primary" type="button" data-action="save">${fresh ? 'Create role' : 'Save role'}</button><button type="button" data-action="discard">${fresh ? 'Clear draft' : 'Discard changes'}</button><span class="rs-help">Saved changes apply when sessions restart.</span></div><div>${!fresh ? '<button type="button" data-action="duplicate">Duplicate</button>' : ''}${!fresh && !role?.custom ? '<button type="button" data-action="reset">Restore defaults…</button>' : ''}</div></footer>
      ${showReset ? '<section class="rs-reset-confirm"><p>Restore this role’s shipped directions, functions and action policy? Other role drafts will stay here.</p><button type="button" data-action="confirm-reset">Restore this role</button><button type="button" data-action="cancel-reset">Cancel</button></section>' : ''}`
    if (busy) main.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = true })
    filterFunctions(); refreshBadges()
  }
  function renderMain() { if (view === 'canvas') renderCanvas(); else renderEditor() }
  function updateRoles(next) {
    if (!Array.isArray(next)) return
    roles = next
    const defaults = initialRolePositions(roles)
    positions = Object.fromEntries(roles.map(role => [role.id, Object.hasOwn(positions, role.id) ? positions[role.id] : defaults[role.id]]))
    for (const role of roles) {
      const entry = drafts.get(role.id)
      if (!entry) continue
      if (!dirty(entry)) drafts.delete(role.id)
      else if (role.revision !== entry.revision) entry.conflict = true
    }
    renderLibrary(); renderMain()
  }
  async function save(reset = false) {
    if (busy || blocked) return
    const id = selected, entry = entryFor(id)
    if (entry.conflict && !reset) return
    const draft = clone(entry.draft)
    if (!reset) {
      for (const field of ROLE_FIELDS) {
        draft.rules[field.key] = draft.rules[field.key].trim()
      }
      if (id === 'new' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.id)) { say('Give the role an ID using lowercase letters, numbers, hyphens or underscores.'); main.querySelector('[data-field="id"]')?.focus(); return }
    }
    busy = true; renderEditor(); say(reset ? 'Restoring defaults…' : 'Saving role…')
    try {
      const functionFields = catalog.length ? { functions: draft.functions, requiresDirectUserAuthorization: draft.requiresDirectUserAuthorization } : {}
      const result = reset ? await onReset({ id, expectedRevision: entry.revision })
        : id === 'new' ? await onCreate({ id: draft.id, baseDefaultRole: draft.baseDefaultRole, rules: draft.rules,
          ...(getRole(draft.baseDefaultRole)?.capabilities ? { capabilities: clone(getRole(draft.baseDefaultRole).capabilities) } : {}), ...functionFields })
          : await onEdit({ id, rules: draft.rules, expectedRevision: entry.revision, ...functionFields })
      if (!result?.ok) {
        say(result?.reason || 'The role could not be saved. Your draft is still here; try again.')
        if (/REVISION_CONFLICT/.test(result?.code || '')) {
          const latest = await onRead?.()
          if (latest?.state === 'ready') updateRoles(latest.roles)
        }
        return
      }
      drafts.delete(id)
      if (id === 'new') selected = draft.id
      showReset = false
      updateRoles(result.roles)
      say(reset ? 'Default directions and function policy restored.' : id === 'new' ? 'Role created.' : 'Role saved.')
    } catch (error) {
      say(`The role could not be saved. Your draft is still here. ${error?.message || 'Try again.'}`)
    } finally {
      busy = false; renderMain(); refreshBadges()
    }
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); say('Copied to clipboard.') }
    catch { say('Clipboard is unavailable. Open the preview and copy the text by hand.') }
  }
  function exportFile() {
    const draft = entryFor(selected).draft
    const url = URL.createObjectURL(new Blob([roleDocument(draft)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${draft.id || 'new-role'}.role.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    say('Role file exported. Importing it opens a draft for review.')
  }
  function open() {
    if (blocked || dialog.open) return
    renderLibrary(); renderMain(); dialog.showModal()
    savedStatus.textContent = status.textContent
  }
  box.querySelector('[data-open-studio]').addEventListener('click', open)
  box.openStudio = open
  dialog.addEventListener('cancel', announceClosed)
  dialog.addEventListener('input', event => {
    if (event.target.matches('[data-role-search]')) { roleQuery = event.target.value; renderLibrary(); return }
    if (event.target.matches('[data-function-search]')) { functionQuery = event.target.value; filterFunctions(); return }
    const key = event.target.dataset.field
    if (!key || busy) return
    const entry = entryFor(selected)
    if (ROLE_FIELDS.some(field => field.key === key)) {
      entry.draft.rules[key] = event.target.value
      const counter = main.querySelector(`[data-count="${key}"]`)
      if (counter) counter.textContent = `${event.target.value.length} / ${maxText}`
    } else if (key === 'id') entry.draft.id = event.target.value
    refreshBadges()
  })
  dialog.addEventListener('change', event => {
    if (busy) return
    if (event.target.matches('[data-function-filter]')) { functionFilter = event.target.value; filterFunctions(); return }
    const entry = entryFor(selected), key = event.target.dataset.field
    if (key === 'functions-standard') {
      if (event.target.checked) { entry.explicitFunctions = entry.draft.functions; entry.draft.functions = null }
      else entry.draft.functions = entry.explicitFunctions || []
      renderEditor()
    } else if (key === 'direct-user') entry.draft.requiresDirectUserAuthorization = event.target.checked
    else if (event.target.matches('[data-function-id]')) {
      const ids = new Set(entry.draft.functions || [])
      if (event.target.checked) ids.add(event.target.dataset.functionId); else ids.delete(event.target.dataset.functionId)
      entry.draft.functions = [...ids].sort(); filterFunctions()
    } else if (key === 'base') {
      const base = getRole(event.target.value)
      entry.draft.baseDefaultRole = base?.id || null
      for (const field of ROLE_FIELDS) if (!entry.draft.rules[field.key].trim()) entry.draft.rules[field.key] = base?.[field.key] || ''
      entry.draft.functions = Array.isArray(base?.functions) ? [...base.functions] : null
      entry.draft.requiresDirectUserAuthorization = base?.requiresDirectUserAuthorization === true
      renderEditor()
    }
    refreshBadges()
  })
  box.querySelector('[data-import-file]').addEventListener('change', async event => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      if (file.size > 400000) throw new Error('This role file is too large. Import one role at a time.')
      const draft = parseRoleDocument(await file.text(), maxText)
      const existing = getRole(draft.id)
      if (draft.baseDefaultRole && !roles.some(role => !role.custom && role.id === draft.baseDefaultRole)) throw new Error('The base role in this file is not installed.')
      if (existing && draft.baseDefaultRole !== existing.baseDefaultRole) throw new Error('This file has a different base role. Give it a new ID before importing.')
      const id = existing ? draft.id : 'new'
      if (drafts.has(id) && dirty(entryFor(id))) throw new Error('This role already has an unsaved draft. Save or discard that draft before importing over it.')
      entryFor(id).draft = draft
      tab = 'preview'; selectRole(id); say('File opened as a draft. Review it, then save when ready.')
    } catch (error) { say(error.message || 'The role file could not be read.') }
    finally { event.target.value = '' }
  })
  dialog.addEventListener('click', event => {
    const button = event.target.closest('button')
    if (!button || button.disabled) return
    if (busy && button.dataset.action !== 'close') return
    if (button.dataset.selectRole) { selectRole(button.dataset.selectRole); return }
    if (button.dataset.tab) { tab = button.dataset.tab; renderEditor(); main.querySelector(`[data-tab="${tab}"]`)?.focus(); return }
    if (button.dataset.copyFunction) { const item = catalog.find(item => item.id === button.dataset.copyFunction); if (item) void copy(functionExample(item)); return }
    const action = button.dataset.action
    if (action === 'close') { dialog.close(); announceClosed(); return }
    if (action === 'canvas') { view = 'canvas'; renderLibrary(); renderCanvas(); say('Choose a role to start editing.'); return }
    if (action === 'new') { tab = 'directions'; selectRole('new'); return }
    if (action === 'researcher') {
      if (getRole('researcher')) { tab = 'directions'; selectRole('researcher'); return }
      if (drafts.has('new') && dirty(entryFor('new'))) { say('Save or discard the existing new-role draft before opening Researcher.'); return }
      try {
        entryFor('new').draft = parseRoleDocument(JSON.stringify(researcherRoleDocument), maxText)
        tab = 'directions'; selectRole('new')
        say('Researcher draft opened. Save to add it to your role library; assignment is optional.')
      } catch (error) { say(error.message || 'The Researcher draft could not be opened.') }
      return
    }
    if (action === 'import') { box.querySelector('[data-import-file]').click(); return }
    if (action === 'arrange') { positions = initialRolePositions(roles); renderCanvas(); return }
    if (['zoom-in', 'zoom-out', 'fit'].includes(action)) {
      const canvas = main.querySelector('[data-canvas]')
      zoom = action === 'fit' ? Math.min(1,
        (canvas.clientWidth - 12) / Math.max(920, ...Object.values(positions).map(p => p.x + 300)),
        (canvas.clientHeight - 12) / Math.max(600, ...Object.values(positions).map(p => p.y + 200)))
        : Math.max(.4, Math.min(1.6, Math.round((zoom + (action === 'zoom-in' ? .1 : -.1)) * 10) / 10))
      renderCanvas(); return
    }
    if (action === 'save') { void save(); return }
    if (action === 'reset' || action === 'cancel-reset') { showReset = action === 'reset'; renderEditor(); return }
    if (action === 'confirm-reset') { void save(true); return }
    if (action === 'discard') { drafts.delete(selected); showReset = false; renderLibrary(); renderEditor(); say('Draft cleared.'); return }
    if (action === 'keep-draft') {
      const entry = entryFor(selected); entry.baseline = roleDraft(getRole(selected)); entry.revision = getRole(selected).revision; delete entry.conflict
      renderEditor(); say('Draft kept against the current saved version. Press Save role to apply it.'); return
    }
    if (action === 'duplicate') {
      if (drafts.has('new') && dirty(entryFor('new'))) { say('Save or discard the existing new-role draft before duplicating another role.'); return }
      const draft = clone(entryFor(selected).draft), source = getRole(selected)
      draft.baseDefaultRole = source.custom ? source.baseDefaultRole : source.id
      draft.id = `${source.id.slice(0, 58)}-copy`
      entryFor('new').draft = draft; selectRole('new'); return
    }
    if (action === 'export') { exportFile(); return }
    if (action === 'copy-directions') { void copy(directionsPreview(guidanceRole(), entryFor(selected).draft)); return }
    if (action === 'select-visible' || action === 'clear-visible') {
      const entry = entryFor(selected)
      if (entry.draft.functions === null) return
      const ids = new Set(entry.draft.functions)
      for (const row of main.querySelectorAll('[data-function-row]')) if (!row.hidden) {
        const input = row.querySelector('[data-function-id]')
        input.checked = action === 'select-visible'
        if (input.checked) ids.add(input.dataset.functionId); else ids.delete(input.dataset.functionId)
      }
      entry.draft.functions = [...ids].sort(); filterFunctions(); refreshBadges()
    }
  })
  dialog.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (view === 'editor') void save(); return }
    if (busy) return
    if (event.target.matches('[data-tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const tabs = ['directions', 'functions', 'preview'], index = tabs.indexOf(tab)
      tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]
      renderEditor(); main.querySelector(`[data-tab="${tab}"]`)?.focus()
    }
    if (event.target.matches('[data-drag-role]') && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
      event.preventDefault()
      const id = event.target.dataset.dragRole, point = positions[id], delta = event.shiftKey ? 40 : 10
      point.x = Math.max(10, point.x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0))
      point.y = Math.max(10, point.y + (event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0))
      renderCanvas(); [...main.querySelectorAll('[data-drag-role]')].find(node => node.dataset.dragRole === id)?.focus()
    }
  })
  main.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-drag-role]')
    if (!handle || event.button !== 0) return
    const id = handle.dataset.dragRole, start = { ...positions[id] }, x = event.clientX, y = event.clientY
    const card = handle.closest('[data-node-id]')
    handle.setPointerCapture(event.pointerId)
    const move = e => {
      positions[id] = { x: Math.max(10, start.x + (e.clientX - x) / zoom), y: Math.max(10, start.y + (e.clientY - y) / zoom) }
      card.style.left = `${positions[id].x}px`; card.style.top = `${positions[id].y}px`
      main.querySelector('.rs-connections').style.opacity = '.2'
    }
    const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); renderCanvas() }
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end)
  })
  box.setRoles = updateRoles
  box.snapshotStudio = () => ({ version: 1, scopeKey, open: dialog.open, selected, view, tab, roleQuery, functionQuery, functionFilter,
    positions: clone(positions), zoom, drafts: [...drafts.entries()].map(([id, entry]) => [id, clone(entry)]) })
  box.restoreStudio = snapshot => {
    if (snapshot?.version !== 1 || snapshot.scopeKey !== scopeKey) return 0
    for (const [id, entry] of snapshot.drafts || []) if (id === 'new' || getRole(id)) drafts.set(id, clone(entry))
    selected = snapshot.selected === 'new' || getRole(snapshot.selected) ? snapshot.selected : roles[0]?.id || 'new'
    view = snapshot.view === 'editor' ? 'editor' : 'canvas'; tab = ['directions','functions','preview'].includes(snapshot.tab) ? snapshot.tab : 'directions'
    roleQuery = snapshot.roleQuery || ''; functionQuery = snapshot.functionQuery || ''; functionFilter = snapshot.functionFilter || 'all'
    positions = { ...positions, ...snapshot.positions }; zoom = snapshot.zoom || 1
    box.querySelector('[data-role-search]').value = roleQuery
    updateRoles(roles)
    if (snapshot.open && box.isConnected) open()
    return 1
  }
  return box
}
