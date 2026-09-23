export const ACTION_PERMISSIONS_KEY = 'mc.action-permissions.v1'
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

export function createActionPermissionSettings({ draft, storage = globalThis.localStorage, readWorkingProfileReceipt = () => null } = {}) {
  let root, notice = '', record
  const readAuthoritativeWorkingProfileReceipt = () => {
    if (typeof readWorkingProfileReceipt !== 'function') return null
    try { return normalizeWorkingProfileReceipt(readWorkingProfileReceipt()) }
    catch { return null }
  }
  try { record = JSON.parse(storage.getItem(ACTION_PERMISSIONS_KEY) || 'null') || defaultActionProfiles() }
  catch { notice = 'The saved permission profiles could not be read.'; record = null }
  if (record && (record.v !== 1 || !Array.isArray(record.profiles) || !record.profiles.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && (!p.actions || (typeof p.actions === 'object' && !Array.isArray(p.actions))) && (p.functions == null || Array.isArray(p.functions))) || !record.profiles.some(p => p.id === record.activeProfileId))) {
    notice = 'The saved permission profiles are not supported by this window.'; record = null
  }
  const current = () => draft.value('permissions:profiles', record)
  const selected = () => current()?.profiles.find(p => p.id === current().activeProfileId)
  const options = (value, inherit = false) => `${inherit ? '<option value="">Use parent profile</option>' : ''}${modes.map(([id, label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${label}</option>`).join('')}`
  function markup() {
    const value = current(), profile = selected()
    const committedWorkingProfileReceipt = profile ? readAuthoritativeWorkingProfileReceipt() : null
    const resume = profile ? resolveAgentResumeMode(profile, committedWorkingProfileReceipt) : null
    return `<section class="settings-section" data-action-permissions><h2 class="settings-section-title">${SECTION_TITLE}</h2>
      <p>Only the saved active profile changes the API available to agents. Profiles can narrow the functions allowed by an agent's role and permission level.</p>
      ${profile ? `<article class="settings-row"><label for="settings-active-profile">Active profile</label><div class="settings-field-control"><select id="settings-active-profile" data-permission-profile>${value.profiles.map(p => `<option value="${escape(p.id)}" ${p.id === profile.id ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select><button class="ctl-btn" type="button" data-permission-add>Add profile</button></div></article>
      <label class="settings-row"><span>Profile name</span><input data-permission-name value="${escape(profile.name)}" maxlength="80"></label>
      <label class="settings-row"><span>Parent profile</span><select data-permission-parent><option value="">None</option>${value.profiles.filter(p => p.id !== profile.id).map(p => `<option value="${escape(p.id)}" ${p.id === profile.parentId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select></label>
      <label class="settings-row"><span>Resume an agent</span><select data-permission-mode="agentResume">${options(resume?.mode, Boolean(profile.parentId))}</select></label>
      <p data-permission-agent-resume-source>${escape(describeAgentResumeMode(profile, committedWorkingProfileReceipt))}</p>
      <p>Direct requires your request to this agent. Inherited accepts your verified request passed through its parent agents. Automatic permits resuming without a new request.</p>
      ${Object.entries(profile.actions || {}).filter(([id]) => id !== 'agentResume').map(([id, mode]) => `<label class="settings-row"><span>${escape(id)}</span><select data-permission-mode="${escape(id)}">${options(mode, Boolean(profile.parentId))}</select></label>`).join('')}
      <article class="settings-row"><label for="settings-function-rule">Add a function rule</label><div class="settings-field-control"><input id="settings-function-rule" data-permission-rule placeholder="Function name"><button class="ctl-btn" type="button" data-permission-add-rule>Add rule</button></div></article>
      <label class="settings-row settings-check-row"><span>Restrict exposed functions to this list</span><input type="checkbox" data-permission-restrict ${Array.isArray(profile.functions) ? 'checked' : ''}></label>
      <label class="settings-row"><span>Allowed function names, one per line</span><textarea data-permission-functions ${Array.isArray(profile.functions) ? '' : 'disabled'}>${escape((profile.functions || []).join('\n'))}</textarea></label>
      <p>An empty restricted list exposes no functions. A child profile cannot restore a function restricted by its parent.</p>` : ''}
      <p role="status">${escape(notice)}</p></section>`
  }
  const paint = () => { const panel = root?.querySelector('[data-action-permissions]'); if (panel) panel.outerHTML = markup() }
  function stage(value) {
    draft.stage('permissions:profiles', value, next => {
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
      storage.setItem(ACTION_PERMISSIONS_KEY, JSON.stringify(next))
      record = structuredClone(next)
    })
  }
  function change(event) {
    if (!event.target.closest('[data-action-permissions]') || !current()) return
    const value = structuredClone(current()), profile = value.profiles.find(p => p.id === value.activeProfileId), input = event.target
    let repaint = false
    let updateResumeSource = false
    if (input.matches('[data-permission-profile]')) { value.activeProfileId = input.value; repaint = true }
    else if (input.matches('[data-permission-name]')) profile.name = input.value
    else if (input.matches('[data-permission-parent]')) { profile.parentId = input.value || null; repaint = true }
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
