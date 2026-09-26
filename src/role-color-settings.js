import { readOrg } from './org-controls.js'
import { matchesSettingQuery } from './product-settings-layout.js'
import {
  ROLE_COLOR_DEFAULTS, ROLE_COLOR_NAMES, ROLE_COLORS_EVENT, ROLE_COLORS_KEY,
  applyRoleColors, defaultRoleColor, normalizeRoleColor, readRoleColors,
  resetRoleColors, saveRoleColor, validRoleColorId,
} from './role-colors.js'

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const LEGACY = new Set(['coordinator', 'helper', 'shadow', 'default', 'spawned'])
export const ROLE_COLORS_SEARCH = 'role colors colours theme palette appearance custom reset'

export function createRoleColorSettings({ stageWrite = null, setStageError = null, storage, documentRef = globalThis.document, windowRef = globalThis.window, readRoles = readOrg } = {}) {
  let stageColors = () => {}
  if (stageWrite) {
    const target = storage || globalThis.localStorage
    const values = new Map()
    stageColors = () => stageWrite('role:colors', null, () => {
      const record = readRoleColors(storage)
      if (!record.ok) return record
      for (const [id, value] of drafts) {
        const color = normalizeRoleColor(value)
        if (!color) throw new Error('Enter a valid hex color for every edited role.')
        record.colors[id] = color
      }
      target.setItem(ROLE_COLORS_KEY, JSON.stringify({ version: 1, colors: record.colors }))
      values.clear()
      drafts.clear()
      applyRoleColors({ documentRef, storage: target })
      windowRef?.dispatchEvent(new CustomEvent(ROLE_COLORS_EVENT))
      for (const row of root?.querySelectorAll?.('[data-role-color-id]') || []) syncRow(row, record)
      say('Role colors saved.')
    })
    storage = {
      getItem: key => values.has(key) ? values.get(key) : target.getItem(key),
      setItem(key, value) { values.set(key, value); stageColors() },
      removeItem(key) { values.set(key, null); stageColors() },
    }
  }
  const names = new Map(Object.keys(ROLE_COLOR_DEFAULTS).filter(id => !LEGACY.has(id)).map(id => [id, ROLE_COLOR_NAMES[id]]))
  const drafts = new Map()
  let root = null, destroyed = false, loadedRoles = false, status = ''
  const saved = () => readRoleColors(storage)
  const chosen = (id, record) => Object.hasOwn(record.colors, id) ? record.colors[id] : defaultRoleColor(id)
  const rowMarkup = (id, name, record) => {
    const color = chosen(id, record)
    const typed = drafts.has(id) ? drafts.get(id) : color
    return `<fieldset class="role-color-row" data-role-color-id="${escape(id)}">
      <legend>${escape(name)}</legend>
      <label class="role-color-swatch-label"><span class="sr-only">Choose ${escape(name)} color</span>
        <input type="color" data-role-color-picker value="${color}" aria-label="Choose ${escape(name)} color"/>
      </label>
      <label class="role-color-hex-label"><span class="sr-only">${escape(name)} hex color</span>
        <input type="text" data-role-color-hex value="${escape(typed)}" maxlength="7" spellcheck="false" autocomplete="off" aria-label="${escape(name)} hex color" aria-describedby="role-colors-help"/>
      </label>
      <button type="button" class="ctl-btn" data-role-color-action="save" aria-label="Save ${escape(name)} color">Save</button>
      <button type="button" class="ctl-btn" data-role-color-action="reset" aria-label="Reset ${escape(name)} color">Reset</button>
    </fieldset>`
  }
  function markup() {
    const record = saved()
    return `<section class="role-color-settings settings-section" data-role-color-settings aria-labelledby="role-colors-title">
      <div class="role-colors-heading"><div><h2 class="settings-section-title" id="role-colors-title">Role colors</h2>
      <p id="role-colors-help">Agents have individual default colors. Choose a swatch or enter a hex color to use one color for a role. Accents adapt to each theme for contrast; your saved color stays the same. Names and status labels stay visible.</p></div>
      <button type="button" class="ctl-btn" data-role-color-action="reset-all">Reset all role colors</button></div>
      <div class="role-color-list" data-role-color-list>${[...names].map(([id, name]) => rowMarkup(id, name, record)).join('')}</div>
      <details class="role-color-legacy"><summary>Example and older role colors</summary><div class="role-color-list">${[...LEGACY].filter(id => !names.has(id)).map(id => rowMarkup(id, ROLE_COLOR_NAMES[id], record)).join('')}</div></details>
      <p class="role-color-source" data-role-color-source>Custom roles are read from this computer’s Role library.</p>
      <output class="role-color-status" data-role-color-status role="status" aria-live="polite">${escape(status || (!record.ok ? record.reason : ''))}</output>
    </section>`
  }
  const say = text => {
    status = text
    const output = root?.querySelector('[data-role-color-status]')
    if (output) output.textContent = text
  }
  const syncRow = (row, record) => {
    const id = row.dataset.roleColorId
    const color = chosen(id, record)
    const picker = row.querySelector('[data-role-color-picker]')
    const input = row.querySelector('[data-role-color-hex]')
    if (picker) picker.value = color
    if (input) { input.value = color; input.removeAttribute('aria-invalid') }
  }
  function commit(row, value) {
    const id = row?.dataset.roleColorId
    const result = saveRoleColor(id, value, storage)
    if (!result.ok) {
      if (value !== null && !normalizeRoleColor(value)) row?.querySelector('[data-role-color-hex]')?.setAttribute('aria-invalid', 'true')
      say(result.reason)
      return false
    }
    drafts.delete(id)
    syncRow(row, result)
    // Another row may still hold a half-typed color; the page keeps Save held for it.
    if (stageWrite) restage()
    if (!stageWrite) applyRoleColors({ documentRef, storage })
    if (!stageWrite) windowRef?.dispatchEvent(new CustomEvent(ROLE_COLORS_EVENT))
    say(stageWrite ? 'Color change is pending. Save settings to apply it.' : (value === null ? 'Default color restored.' : 'Role color saved.'))
    return true
  }
  /* A HALF-TYPED COLOR IS NOT A CHANGE (T1428). On the Settings page every
     keystroke used to stage, so '#12' read as '1 unsaved change' and the whole
     Save failed later. Now the field is marked at once and the page's Save is
     held with a sentence naming the role, the way the numeric rows do. */
  function restage() {
    const invalid = [...drafts].find(([, value]) => !normalizeRoleColor(value))
    if (invalid && setStageError) setStageError('role:colors', `Enter a valid hex color for ${names.get(invalid[0]) || ROLE_COLOR_NAMES[invalid[0]] || invalid[0]}, such as #1f6feb.`)
    else stageColors()
  }
  const onInput = event => {
    const input = event.target.closest?.('[data-role-color-hex]')
    const row = input?.closest('[data-role-color-id]')
    if (!row) return
    drafts.set(row.dataset.roleColorId, input.value)
    if (!stageWrite) return
    if (normalizeRoleColor(input.value)) input.removeAttribute?.('aria-invalid')
    else input.setAttribute?.('aria-invalid', 'true')
    restage()
  }
  const onChange = event => {
    const picker = event.target.closest?.('[data-role-color-picker]')
    const row = picker?.closest('[data-role-color-id]')
    if (row && !commit(row, picker.value)) picker.value = chosen(row.dataset.roleColorId, saved())
  }
  const onClick = event => {
    const button = event.target.closest?.('[data-role-color-action]')
    if (!button) return
    const action = button.dataset.roleColorAction
    if (action === 'reset-all') {
      const result = resetRoleColors(storage)
      if (!result.ok) { say(result.reason); return }
      drafts.clear()
      for (const row of root.querySelectorAll('[data-role-color-id]')) syncRow(row, result)
      if (!stageWrite) applyRoleColors({ documentRef, storage })
      if (!stageWrite) windowRef?.dispatchEvent(new CustomEvent(ROLE_COLORS_EVENT))
      // Staged on the Settings page: nothing is restored until Save settings writes it (T1429).
      say(stageWrite ? 'Resetting all role colors is pending. Save settings to apply it.' : 'All role colors restored to their defaults.')
      return
    }
    const row = button.closest('[data-role-color-id]')
    if (row) commit(row, action === 'reset' ? null : row.querySelector('[data-role-color-hex]')?.value)
  }
  async function afterRender(nextRoot) {
    root = nextRoot
    const host = root?.querySelector('[data-role-color-settings]')
    if (!host || loadedRoles) return
    loadedRoles = true
    let catalog
    try { catalog = await readRoles() } catch { catalog = null }
    if (destroyed) return
    if (catalog?.state === 'ready' && Array.isArray(catalog.roles)) {
      const record = saved()
      for (const role of catalog.roles) {
        if (!validRoleColorId(role?.id) || typeof role.name !== 'string' || !role.name.trim()) continue
        names.set(role.id, role.name)
        // Append/update labels only. A late Role library read must not replace
        // a color field under the person's cursor or discard an unsaved hex.
        const existing = [...(root?.querySelectorAll('[data-role-color-id]') || [])].find(row => row.dataset.roleColorId === role.id)
        if (existing) {
          existing.querySelector('legend').textContent = role.name
          for (const [selector, label] of [
            ['[data-role-color-picker]', `Choose ${role.name} color`],
            ['[data-role-color-hex]', `${role.name} hex color`],
            ['[data-role-color-action="save"]', `Save ${role.name} color`],
            ['[data-role-color-action="reset"]', `Reset ${role.name} color`],
          ]) existing.querySelector(selector)?.setAttribute('aria-label', label)
        }
        else root?.querySelector('[data-role-color-list]')?.insertAdjacentHTML('beforeend', rowMarkup(role.id, role.name, record))
      }
    } else {
      const notice = root?.querySelector('[data-role-color-source]')
      if (notice) notice.textContent = 'Built-in role colors are available here. Connect to the desktop app to include its custom roles.'
    }
  }
  return {
    markup, afterRender,
    matches: query => matchesSettingQuery(query, ROLE_COLORS_SEARCH),
    bind(nextRoot) { root = nextRoot; root.addEventListener('click', onClick); root.addEventListener('input', onInput); root.addEventListener('change', onChange) },
    destroy() { destroyed = true; root?.removeEventListener('click', onClick); root?.removeEventListener('input', onInput); root?.removeEventListener('change', onChange) },
  }
}
