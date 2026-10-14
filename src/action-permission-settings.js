export const ACTION_PERMISSIONS_KEY = 'mc.action-permissions.v1'
export const ACTION_PERMISSIONS_RECOVERY_PREFIX = 'mc.action-permissions.recovery.'
const SECTION_TITLE = 'Agent permission profiles'
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const modes = [['automatic', 'Automatic'], ['direct', 'Direct user request'], ['inherited', 'Inherited user request'], ['disabled', 'Disabled']]
const AUTOMATIC_WORKING_PROFILES = new Set(['independent', 'autonomous', 'autonomous-plus'])
const WORKING_PROFILE_LABELS = new Map([
  ['locked', 'Locked'],
  ['careful', 'Careful'],
  ['balanced', 'Balanced'],
  ['independent', 'Independent'],
  ['autonomous', 'Autonomous'],
  ['autonomous-plus', 'Autonomous+'],
])
const hasOwn = (value, key) => Boolean(value && typeof value === 'object' && Object.hasOwn(value, key))

export function normalizeWorkingProfileReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || typeof receipt.id !== 'string' || !receipt.id || !Number.isFinite(receipt.atMs)) return null
  return { id: receipt.id, atMs: receipt.atMs }
}

export function defaultAgentResumeMode(receipt) {
  const normalized = normalizeWorkingProfileReceipt(receipt)
  return normalized && AUTOMATIC_WORKING_PROFILES.has(normalized.id) ? 'automatic' : 'direct'
}

export function resolveAgentResumeMode(profile, receipt) {
  const actions = profile?.actions
  if (hasOwn(actions, 'agentResume')) return { mode: actions.agentResume, source: 'saved-override', workingProfileId: null }
  if (profile?.parentId) return { mode: '', source: 'inherited', workingProfileId: null }
  const normalized = normalizeWorkingProfileReceipt(receipt)
  if (normalized && WORKING_PROFILE_LABELS.has(normalized.id)) {
    return {
      mode: defaultAgentResumeMode(normalized),
      source: 'working-profile',
      workingProfileId: normalized.id,
    }
  }
  return { mode: 'direct', source: 'engine-fallback', workingProfileId: null }
}

export function describeAgentResumeMode(profile, receipt) {
  const resolved = resolveAgentResumeMode(profile, receipt)
  if (resolved.source === 'saved-override') return 'Chosen in this permission profile.'
  if (resolved.source === 'inherited') return 'Uses the parent profile\u2019s choice.'
  if (resolved.source === 'working-profile') {
    const label = WORKING_PROFILE_LABELS.get(resolved.workingProfileId)
    return `${resolved.mode === 'automatic' ? 'Automatic' : 'Direct user request'}, from your saved ${label} working profile.`
  }
  return 'Direct user request, the default when no working profile is saved.'
}

export const defaultActionProfiles = () => ({ v: 1, activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', parentId: null, actions: {}, functions: null }] })

// Refuse a descendant before it becomes a draft that can never be saved.
export function wouldCreatePermissionCycle(profiles, profileId, parentId) {
  const byId = new Map(profiles.map(profile => [profile.id, profile]))
  const seen = new Set([profileId])
  for (let id = parentId; id; id = byId.get(id)?.parentId) {
    if (seen.has(id)) return true
    seen.add(id)
  }
  return false
}

// Presentation validation only. The host's selected engine remains the save
// authority; an unknown record is never treated as an absent default.
function readableActionProfiles(value) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v)
  const id = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)
  const tool = v => typeof v === 'string' && /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(v)
  if (!object(value) || value.v !== 1 || !id(value.activeProfileId) || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > 32) return false
  const ids = new Map()
  for (const row of value.profiles) {
    if (!object(row) || !id(row.id) || ids.has(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120 || (row.parentId != null && !id(row.parentId)) || !object(row.actions)) return false
    const actions = Object.entries(row.actions)
    if (actions.length > 2048 || actions.some(([key, mode]) => (key !== 'agentResume' && !tool(key)) || !modes.some(([allowed]) => allowed === mode))) return false
    if (row.functions != null && (!Array.isArray(row.functions) || row.functions.length > 2048 || row.functions.some(name => !tool(name)) || new Set(row.functions).size !== row.functions.length)) return false
    ids.set(row.id, row)
  }
  if (!ids.has(value.activeProfileId)) return false
  for (const row of value.profiles) {
    const seen = new Set()
    let current = row
    while (current) {
      if (seen.has(current.id) || (current.parentId && !ids.has(current.parentId))) return false
      seen.add(current.id); current = ids.get(current.parentId)
    }
  }
  return true
}

export function createActionPermissionSettings({ draft, storage = globalThis.localStorage, readWorkingProfileReceipt = () => null } = {}) {
  let root, notice = '', record, savedRaw, readFailed = false, recovery = null, savedNotice = ''
  const readAuthoritativeWorkingProfileReceipt = () => {
    if (typeof readWorkingProfileReceipt !== 'function') return null
    try { return normalizeWorkingProfileReceipt(readWorkingProfileReceipt()) }
    catch { return null }
  }
  function readRecord() {
    readFailed = false
    let damaged = false
    try {
      damaged = Boolean(globalThis.window?.mcPrefsNotice?.read?.().damaged)
      if (damaged) throw new Error('Saved settings are unavailable.')
      savedRaw = storage.getItem(ACTION_PERMISSIONS_KEY)
      record = savedRaw === null ? defaultActionProfiles() : JSON.parse(savedRaw)
      if (!readableActionProfiles(record)) {
        savedNotice = 'The saved permission profiles are not supported by this window.'; record = null
      } else savedNotice = ''
    } catch {
      readFailed = savedRaw === undefined || damaged
      savedNotice = 'The saved permission profiles could not be read.'; record = null
    }
    notice = savedNotice
  }
  readRecord()
  const current = () => draft.value('permissions:profiles', record)
  const selected = () => current()?.profiles.find(p => p.id === current().activeProfileId)
  const options = (value, inherit = false) => `${inherit ? '<option value="">Use parent profile</option>' : ''}${modes.map(([id, label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${label}</option>`).join('')}`
  function markup() {
    if (recovery && draft.has?.('permissions:profiles') === false) { recovery = null; notice = savedNotice }
    const value = current(), profile = selected()
    const committedWorkingProfileReceipt = profile ? readAuthoritativeWorkingProfileReceipt() : null
    const resume = profile ? resolveAgentResumeMode(profile, committedWorkingProfileReceipt) : null
    return `<section class="settings-section" data-action-permissions><h2 class="settings-section-title">${SECTION_TITLE}</h2>
      <p>Only the saved active profile changes the API available to agents. Profiles can narrow the functions allowed by an agent's role and permission level.</p>
      ${profile ? `<article class="settings-row"><label for="settings-active-profile">Active profile</label><div class="settings-field-control"><select id="settings-active-profile" data-permission-profile>${value.profiles.map(p => `<option value="${escape(p.id)}" ${p.id === profile.id ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select><button class="ctl-btn" type="button" data-permission-add>Add profile</button></div></article>
      <label class="settings-row"><span>Profile name</span><input data-permission-name value="${escape(profile.name)}" maxlength="80"></label>
      <label class="settings-row"><span>Parent profile</span><select data-permission-parent><option value="">None</option>${value.profiles.filter(p => !wouldCreatePermissionCycle(value.profiles, profile.id, p.id)).map(p => `<option value="${escape(p.id)}" ${p.id === profile.parentId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select></label>
      <label class="settings-row"><span>Resume an agent</span><select data-permission-mode="agentResume">${options(resume?.mode, Boolean(profile.parentId))}</select></label>
      <p data-permission-agent-resume-source>${escape(describeAgentResumeMode(profile, committedWorkingProfileReceipt))}</p>
      <p>Direct requires your request to this agent. Inherited accepts your verified request passed through its parent agents. Automatic permits resuming without a new request.</p>
      ${Object.entries(profile.actions || {}).filter(([id]) => id !== 'agentResume').map(([id, mode]) => `<label class="settings-row"><span>${escape(id)}</span><select data-permission-mode="${escape(id)}">${options(mode, Boolean(profile.parentId))}</select></label>`).join('')}
      <article class="settings-row"><label for="settings-function-rule">Add a function rule</label><div class="settings-field-control"><input id="settings-function-rule" data-permission-rule placeholder="Function name"><button class="ctl-btn" type="button" data-permission-add-rule>Add rule</button></div></article>
      <label class="settings-row settings-check-row"><span>Restrict exposed functions to this list</span><input type="checkbox" data-permission-restrict ${Array.isArray(profile.functions) ? 'checked' : ''}></label>
      <label class="settings-row"><span>Allowed function names, one per line</span><textarea data-permission-functions ${Array.isArray(profile.functions) ? '' : 'disabled'}>${escape((profile.functions || []).join('\n'))}</textarea></label>
      <p>An empty restricted list exposes no functions. A child profile cannot restore a function restricted by its parent.</p>` : ''}
      ${!profile ? `<p>Agents may be unable to use tools until these saved permission profiles can be read. Resetting uses the default profile and your saved working-profile defaults. Save settings keeps a copy of the original record before replacing it.</p><button class="ctl-btn" type="button" data-permission-reset>Reset permission profiles to the default</button>` : ''}
      <p role="status">${escape(notice)}</p></section>`
  }
  const paint = () => { const panel = root?.querySelector('[data-action-permissions]'); if (panel) panel.outerHTML = markup() }
  function stage(value) {
    const reset = recovery
    draft.stage('permissions:profiles', value, next => {
      try {
        for (const profile of next.profiles) {
          if (Object.keys(profile.actions || {}).length > 2048) throw new Error('A profile supports up to 2048 action rules.')
          if (!profile.name.trim()) throw new Error('Give each permission profile a name.')
          if (Array.isArray(profile.functions) && (profile.functions.length > 2048 || profile.functions.some(id => !/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(id)))) throw new Error('Use exact dotted function names in the allowed functions list.')
          const seen = new Set([profile.id]); let parent = profile.parentId
          while (parent) {
            if (seen.has(parent)) throw new Error('Permission profiles cannot inherit in a circle.')
            seen.add(parent)
            const found = next.profiles.find(p => p.id === parent)
            if (!found) throw new Error('A parent permission profile is missing.')
            parent = found.parentId
          }
        }
        const write = (key, text) => {
          const result = storage.setItem(key, text)
          if (result?.ok === false) throw new Error(result.error?.message || result.reason || 'Permission settings could not be saved.')
        }
        if (reset) {
          if (storage.getItem(ACTION_PERMISSIONS_KEY) !== reset.raw) throw new Error('Saved permission profiles changed. Reopen Settings before trying again.')
          const previous = storage.getItem(reset.key)
          if (previous !== null && previous !== reset.raw) throw new Error('The permission recovery copy already holds another record.')
          if (previous === null) write(reset.key, reset.raw)
          if (storage.getItem(reset.key) !== reset.raw) throw new Error('The original permission profiles could not be verified in the recovery copy.')
          if (storage.getItem(ACTION_PERMISSIONS_KEY) !== reset.raw) throw new Error('Saved permission profiles changed. Reopen Settings before trying again.')
        }
        write(ACTION_PERMISSIONS_KEY, JSON.stringify(next))
        record = structuredClone(next)
        savedRaw = JSON.stringify(next)
        savedNotice = ''; notice = reset ? 'Permission profiles reset. The original record was preserved.' : ''; recovery = null
        paint()
      } catch (error) {
        notice = error?.message || 'Permission settings could not be saved.'
        paint()
        throw error
      }
    })
    notice = ''
  }
  function change(event) {
    if (!event.target.closest('[data-action-permissions]') || !current()) return
    const value = structuredClone(current()), profile = value.profiles.find(p => p.id === value.activeProfileId), input = event.target
    let repaint = false
    let updateResumeSource = false
    if (input.matches('[data-permission-profile]')) { value.activeProfileId = input.value; repaint = true }
    else if (input.matches('[data-permission-name]')) profile.name = input.value
    else if (input.matches('[data-permission-parent]')) {
      if (wouldCreatePermissionCycle(value.profiles, profile.id, input.value)) {
        input.value = profile.parentId || ''
        notice = 'Permission profiles cannot inherit in a circle.'
        const status = root?.querySelector('[data-action-permissions] [role="status"]')
        if (status) status.textContent = notice
        return
      }
      profile.parentId = input.value || null; repaint = true
    }
    else if (input.matches('[data-permission-mode]')) {
      profile.actions ||= {}
      if (input.value) profile.actions[input.dataset.permissionMode] = input.value
      else delete profile.actions[input.dataset.permissionMode]
      updateResumeSource = input.dataset.permissionMode === 'agentResume'
    } else if (input.matches('[data-permission-restrict]')) { profile.functions = input.checked ? [] : null; repaint = true }
    else if (input.matches('[data-permission-functions]')) profile.functions = [...new Set(input.value.split(/\s+/).filter(Boolean))]
    else return
    stage(value)
    if (updateResumeSource) {
      const source = root?.querySelector('[data-permission-agent-resume-source]')
      const nextProfile = selected()
      if (source && nextProfile) source.textContent = describeAgentResumeMode(nextProfile, readAuthoritativeWorkingProfileReceipt())
    }
    if (repaint) paint()
  }
  function click(event) {
    if (event.target.closest('[data-permission-reset]') && !current()) {
      if (readFailed) { savedRaw = undefined; readRecord() }
      if (readFailed) { paint(); return }
      if (record) { paint(); return }
      recovery = { raw: savedRaw, key: `${ACTION_PERMISSIONS_RECOVERY_PREFIX}${Date.now()}-${globalThis.crypto.randomUUID()}` }
      stage(defaultActionProfiles())
      notice = 'Reset is pending. Save settings to preserve the original record and apply the default profiles.'
      paint(); return
    }
    if (!current()) return
    const value = structuredClone(current())
    if (event.target.closest('[data-permission-add]')) {
      if (value.profiles.length >= 32) { notice = 'A maximum of 32 profiles is supported.'; paint(); return }
      const id = `profile-${globalThis.crypto.randomUUID()}`
      value.profiles.push({ id, name: 'New profile', parentId: value.activeProfileId, actions: {}, functions: null })
      value.activeProfileId = id
    } else if (event.target.closest('[data-permission-add-rule]')) {
      const id = root.querySelector('[data-permission-rule]')?.value.trim()
      if (!id || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(id)) { notice = 'Enter a valid function name.'; paint(); return }
      const profile = value.profiles.find(p => p.id === value.activeProfileId)
      profile.actions = { ...profile.actions, [id]: 'direct' }
    } else return
    stage(value); paint()
  }
  function repaint() { paint() }
  return { markup, repaint, matches: query => matchesSettingQuery(query, SECTION_TITLE, 'permission profiles agent resume automatic direct inherited functions api'),
    bind(target) { root = target; root.addEventListener('input', change); root.addEventListener('change', change); root.addEventListener('click', click) },
    destroy() { root?.removeEventListener('input', change); root?.removeEventListener('change', change); root?.removeEventListener('click', click) } }
}
import { matchesSettingQuery } from './product-settings-layout.js'
