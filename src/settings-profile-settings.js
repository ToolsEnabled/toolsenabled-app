import { WORKING_PROFILES, PROFILE_PRODUCT_VALUES, PROFILE_PRODUCT_PRESERVED, PROFILE_RESOURCE_PRESERVED, PROFILE_LOCAL_PRESERVED, PROFILE_PRESERVED_SCOPES, workingProfilePlan, matchWorkingProfile } from './settings-profile-policy.js'
import { PROFILE_INTENT } from './setup-profile.js'
import { WRITE_ACTION_FLAGS } from './write-flags.js'
import { RESOURCE_CONTROLS } from './resource-settings.js'
import { productSettingPresentation } from './product-settings-layout.js'
import { productValueError } from './research-settings.js'
import { withDeadline } from './read-deadline.js'
import { syncNumericRange } from './settings-numeric.js'
import { focusKeeper } from './focus-keep.js'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const display = (value, unit = '') => value == null || typeof value === 'number' && !Number.isFinite(value) ? 'Unavailable' : `${typeof value === 'boolean' ? value ? 'On' : 'Off' : value}${unit ? ` ${unit}` : ''}`
const title = id => productSettingPresentation(id).title || id
const MIB = 1024 ** 2

export function createWorkingProfileSettings({ draft, productSettings, setup, resources, localSettings = [], onStaged = () => {}, onBusy = () => {}, isBlocked = () => false, onSavedProfileChange = () => {} } = {}) {
  let root = null, panel = null, rows = [], loading = false, staging = false, loaded = false, error = '', generation = 0, queued = false
  let selected = 'balanced', message = ''
  /* WHETHER THE THUMB STANDS FOR SOMETHING (T1438). 'balanced' is only where
     the slider starts. Until the saved values match a preset, or the person
     picks one, the thumb and the sentence under it must not read as a preset
     in effect: a fresh install read 'Saved: Custom' with Balanced's 'keep
     approvals' sentence while approvals were off. */
  let selectionMeant = false
  // The last profile application this install recorded (the save's receipt):
  // it names the preset the page reads back once rows have been changed since.
  let savedProfile = null
  const flagIds = WRITE_ACTION_FLAGS.map(flag => flag.id)
  const planFor = (id, state = setup.profileState()) => workingProfilePlan(id, { tier: state.tier, writeFlagIds: flagIds, totalBytes: resources.profileState().totalBytes })

  /* THE CELL: always in view, never behind a disclosure (owner, 2026-09-15:
     "i dont like the dropdown lets change that"). It sits first in the quick
     strip the Settings landing page draws; the value review is a separate
     block under the whole strip (reviewMarkup) so its table can take the full
     width. Every hook the page and the tests read stays where it was. */
  function markup() {
    const initial = Math.max(0, WORKING_PROFILES.findIndex(profile => profile.id === selected))
    return `<section class="settings-working-profile quick-slider" data-working-profile aria-labelledby="working-profile-title">
      <div class="working-profile-lead quick-slider-head">
        <span class="working-profile-title quick-slider-title" id="working-profile-title">Working profile</span>
        <span class="working-profile-state quick-slider-state" aria-live="polite"><strong data-working-profile-current>Reading saved profile…</strong><span data-working-profile-draft></span></span>
      </div>
      <div class="working-profile-picker quick-slider-picker"><label class="settings-sr-only" for="working-profile-slider">Stage a working profile</label>
        <input type="range" id="working-profile-slider" data-working-profile-slider min="0" max="${WORKING_PROFILES.length - 1}" step="1" value="${initial}" aria-describedby="working-profile-help working-profile-message" disabled>
        <div class="working-profile-options quick-slider-stops" style="--stops:${WORKING_PROFILES.length}">${WORKING_PROFILES.map(profile => `<button type="button" data-working-profile-choice="${profile.id}" aria-pressed="false" disabled>${profile.label}</button>`).join('')}</div>
        <p id="working-profile-help" class="quick-slider-help" data-working-profile-help>Reading the current host policies before offering a profile.</p>
        <p id="working-profile-message" class="quick-slider-message" data-working-profile-message role="status"></p>
      </div>
      <div class="working-profile-links"><button type="button" class="working-profile-link" data-working-profile-refresh>Read saved values</button></div>
    </section>`
  }

  function reviewMarkup() {
    return `<details class="working-profile-review" data-working-profile-review-block><summary class="working-profile-link">Review every profile value and what stays separate</summary><div data-working-profile-review></div></details>`
  }

  function snapshot(saved = false) {
    const resource = resources.profileState()
    return { product: rows.map(row => ({ ...row, value: saved ? row.savedValue : draft.value(`product:${row.id}`, row.savedValue) })),
      setup: setup.profileState({ saved }), resources: saved ? resource.savedSettings : resource.settings, resourceApplicable: resource.applicable }
  }
  /* THE NAME THE PAGE READS BACK (owner, 2026-09-16: "its literally just
     preset profiles"). An exact match names the preset. Otherwise the preset
     this computer last applied -- the save's receipt -- is still the name,
     marked with how many values now differ from it, so a person who moved two
     quick sliders after choosing Autonomous+ reads "Autonomous+ · 2 changed"
     and the thumb stays on Autonomous+, rather than "Custom" sending them back
     to re-apply it. Only a computer with no receipt and no match reads Custom. */
  function labelFor(state) {
    const results = WORKING_PROFILES.map(profile => ({ profile, ...matchWorkingProfile(planFor(profile.id, state.setup), state) }))
    const matches = results.filter(entry => entry.matches).map(entry => entry.profile)
    if (matches.length) return matches.find(profile => profile.id === selected) || matches[0]
    const applied = savedProfile ? results.find(entry => entry.profile.id === savedProfile.id) : null
    if (applied) return { ...applied.profile, changed: applied.differences.length, label: `${applied.profile.label} · ${applied.differences.length} changed` }
    return { id: 'custom', label: 'Custom' }
  }
  function readError() {
    if (typeof productSettings?.set !== 'function') return 'This window cannot save host product policies.'
    if (!loaded) return error || 'Read the saved policies before choosing a working profile.'
    if (error) return error
    const state = setup.profileState(), resource = resources.profileState()
    if (!state.ready || !['guided', 'standard', 'unrestricted'].includes(state.tier)) return state.errors?.[0] || 'The current permission level could not be read.'
    if (resource.applicable && !resource.ready) return resource.error || 'This computer\u2019s resource limits could not be read. Press Read saved values to try again.'
    for (const id of Object.keys(PROFILE_PRODUCT_VALUES)) {
      const row = rows.find(row => row.id === id)
      if (!row || row.present === false || row.enforcement?.declared === false) return `This host cannot apply the profile field “${title(id)}”. Update or reconnect the host, then read saved values again.`
    }
    if (resource.applicable && Object.keys(planFor(selected).resources).some(key => !Object.hasOwn(resource.settings || {}, key))) return 'This host does not support every resource field in the profile.'
    return ''
  }

  function review(plan, current) {
    const line = (label, now, next, note = '') => `<tr><th scope="row">${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</th><td>${esc(now)}</td><td>${esc(next)}</td></tr>`
    const productRows = Object.entries(plan.product).map(([id, value]) => {
      const row = current.product.find(row => row.id === id)
      const note = id === 'audit.activity' ? 'Select success and failure summaries for API calls. Required protected-action records remain enforced; a recording failure can still leave a summary gap. Native tools outside the API are separate.'
        : id === 'tools.credential_check_interval_seconds' ? 'Windows presence cache; zero uses credential-digest invalidation. Linux checks its own backend.'
        : id === 'fleet.max_declared_agents' ? 'Declared organization entries, not running agents; explicit host limits can be stricter.'
          : id.startsWith('tools.audit_batch') ? 'Fast tool scheduling; required activity records still become durable before admission.'
            : id === 'capability.elevation_duration' ? 'Bounds future temporary grants; it grants no access by itself.'
              : id === 'agent.blocked_question' ? 'ToolsEnabled permission questions; provider-native prompts remain separate.'
                : id === 'rules.filing_from' ? value === 'Agents too' ? 'Agents may turn what you say into rules; the two nested approval choices apply.' : 'Agents neither file rules nor ask about them; you add rules yourself, and the nested approval choices apply only if you choose Agents too later.'
                  : row?.applies === 'next-session' ? 'New sessions.' : ''
      return line(title(id), display(row?.value, row?.unit), row?.applicable === false ? 'Not applicable on this host' : display(value, row?.unit), note)
    }).join('')
    const flags = WRITE_ACTION_FLAGS.map(flag => line(flag.label, display(current.setup.writeFlags[flag.id]), display(plan.setup.writeFlags[flag.id]), 'App action control; existing role and permission restrictions still apply.')).join('')
    const intents = PROFILE_INTENT.filter(field => field.id !== 'approvals').map(field => line(field.name,
      field.labels[current.setup.intent[field.id]] || 'Unavailable', field.id === 'failover' && current.setup.accounts?.applicable === false ? 'No accounts configured — excluded' : field.labels[plan.setup.intent[field.id]],
      field.id === 'failover' ? 'Global automatic/manual selection only; keeps provider overrides and an existing automatic ranking.' : '')).join('')
    const resourceRows = Object.entries(plan.resources).map(([key, value]) => {
      const control = RESOURCE_CONTROLS.find(control => (control.key || control.name) === key)
      const scale = control?.unit === 'MiB' ? MIB : 1
      return line(control?.label || key, display(current.resources?.[key] / scale, control?.unit),
        current.resourceApplicable ? display(value / scale, control?.unit) : 'Local desktop only — excluded')
    }).join('')
    const kept = Object.entries(PROFILE_PRODUCT_PRESERVED).map(([id, reason]) => `<li><strong>${esc(title(id))}:</strong> ${esc(reason)}</li>`).join('')
    /* The admission mode is read back beside its reason so the person sees
       what the profile is leaving in place. */
    const resourceKept = Object.entries(PROFILE_RESOURCE_PRESERVED).map(([key, reason]) => `<li><strong>Resource admission${key === 'mode' && current.resourceApplicable ? ` (now ${esc(current.resources?.mode || 'unavailable')})` : ''}:</strong> ${esc(reason)}</li>`).join('')
    const localKept = Object.entries(PROFILE_LOCAL_PRESERVED).map(([id, reason]) => `<li><strong>${esc(localSettings.find(row => row.id === id)?.name || id)}:</strong> ${esc(reason)}</li>`).join('')
    return `<p>Values for <strong>${esc(plan.label)}</strong> under the current permission level. Current or pending values include unsaved edits. Choosing a profile stages every value in this table; Save settings applies them all. Every profile keeps purchase approval and shared-file locking. Detailed activity auditing and enforced resource admission are optional setup under Advanced: a profile leaves them as you chose. A profile starts no agents.</p>
      <div class="working-profile-table"><table><thead><tr><th>Policy</th><th>Current or pending</th><th>${esc(plan.label)}</th></tr></thead><tbody>${productRows}${flags}${intents}${resourceRows}</tbody></table></div>
      <h3>Kept as you chose</h3><p>Profiles leave both saved choices and pending individual edits alone. These settings do not decide whether the action, tool and resource values match a named profile.</p><ul>${kept}${resourceKept}${localKept}${PROFILE_PRESERVED_SCOPES.map(([name, why]) => `<li><strong>${esc(name)}:</strong> ${esc(why)}</li>`).join('')}</ul>`
  }

  function paint() {
    if (!panel) return
    const problem = readError(), disabled = loading || staging || draft.saving || isBlocked() || Boolean(problem)
    const slider = panel.querySelector('[data-working-profile-slider]')
    slider.disabled = disabled
    const refreshButton = root.querySelector('[data-working-profile-refresh]')
    if (refreshButton) refreshButton.disabled = loading || staging || draft.saving
    const currentNode = panel.querySelector('[data-working-profile-current]'), draftNode = panel.querySelector('[data-working-profile-draft]')
    let current, saved
    if (!problem && !loading) { current = draft.valid ? labelFor(snapshot()) : { id: 'invalid', label: 'Invalid — correct the highlighted value' }; saved = labelFor(snapshot(true)) }
    if (loading || problem) currentNode.textContent = loading ? 'Reading saved profile…' : 'Saved profile: see the message below'
    else currentNode.innerHTML = `Saved: <em class="working-profile-current-name">${esc(saved.label)}</em>`
    currentNode.dataset.profile = saved?.id || 'unavailable'
    draftNode.textContent = staging ? 'Preparing profile changes…' : draft.saving ? 'Saving settings…' : current && draft.dirty
      ? current.id === 'invalid' ? 'Pending values need correction before Save.' : `Pending profile: ${current.label}. Save settings to apply.` : ''
    draftNode.dataset.profile = current?.id || 'unavailable'
    for (const button of panel.querySelectorAll('[data-working-profile-choice]')) {
      button.disabled = disabled
      button.setAttribute('aria-pressed', String(current?.id === button.dataset.workingProfileChoice))
    }
    const plan = planFor(selected)
    slider.value = String(WORKING_PROFILES.findIndex(profile => profile.id === selected))
    syncNumericRange(slider)
    const noPreset = !selectionMeant && current?.id === 'custom'
    panel.dataset.profileState = noPreset ? 'custom' : 'preset'
    slider.setAttribute('aria-valuetext', noPreset
      ? 'No working profile is applied. Your saved values match none of them.'
      : `Stage ${plan.label}. ${current ? `Current choices: ${current.label}.` : 'Your current choices are not shown; read the message below the slider.'}`)
    // One line under the tick labels: the staged preset's own sentence. The
    // permission level, tool-set and delegation reminders live in the review.
    panel.querySelector('[data-working-profile-help]').textContent = noPreset
      ? 'No working profile is applied: your saved values match none of them. Choose one to stage its values.'
      : plan.description
    panel.querySelector('[data-working-profile-message]').textContent = problem || (!draft.valid && !staging ? draft.errors[0]?.message : '') || message || ''
    const reviewNode = root.querySelector('[data-working-profile-review]')
    if (loaded && reviewNode) reviewNode.innerHTML = review(plan, snapshot())
  }

  function sync() {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; paint() })
  }
  const refreshFocus = focusKeeper()
  async function refresh() {
    const ticket = ++generation
    // Read saved values disables itself while it reads; it gets focus back after (T1559)
    refreshFocus.hold(root?.querySelector('[data-working-profile-refresh]'))
    loading = true; error = ''; paint()
    const results = await Promise.allSettled([
      withDeadline(Promise.resolve().then(() => productSettings?.read?.()), 10_000),
      withDeadline(Promise.resolve().then(() => setup.readForProfile()), 10_000),
      withDeadline(Promise.resolve().then(() => resources.readForProfile()), 10_000),
    ])
    if (ticket !== generation || !panel) return
    const failed = results.find(result => result.status === 'rejected')
    const result = results[0].status === 'fulfilled' ? results[0].value : null
    if (failed) error = failed.reason?.message || 'The current policies could not be read.'
    else if (result?.ok !== true || result.available === false || !Array.isArray(result.rows)) error = result?.reason || 'The saved product policies could not be read from this computer. Press Read saved values to try again.'
    else if (result.rejected?.some(row => row.id === '*' || Object.hasOwn(PROFILE_PRODUCT_VALUES, row.id))) error = 'A saved profile policy is unreadable or invalid. Correct it before choosing a profile.'
    else {
      rows = result.rows.map(row => ({ ...row, savedValue: Object.hasOwn(row, 'savedValue') ? row.savedValue : row.value }))
      const receipt = result.workingProfile
      const before = savedProfile?.id ?? null
      savedProfile = receipt && typeof receipt.id === 'string' && WORKING_PROFILES.some(profile => profile.id === receipt.id)
        ? { id: receipt.id, atMs: receipt.atMs } : null
      loaded = true
      // Other sections that show what the saved profile decides (the resume
      // row under Agent permission profiles) repaint from this same read.
      if ((savedProfile?.id ?? null) !== before) onSavedProfileChange(savedProfile ? { ...savedProfile } : null)
    }
    loading = false
    if (!draft.dirty) message = ''
    if (!readError() && !draft.dirty) { const match = labelFor(snapshot()); if (match.id !== 'custom') { selected = match.id; selectionMeant = true } }
    paint()
    refreshFocus.restore(root?.querySelector('[data-working-profile-refresh]'))
  }
  /* CHOOSING A PRESET APPLIES THE WHOLE PRESET (owner, 2026-09-16: "all the
     sliders are supposed to be independent and make for a quick easy way to
     set the large majority of settings. its literally just preset profiles").
     Every product row the preset names is staged through the row's own shared
     writer, the resource limits and the Setup intent go with it, and Save
     settings applies them all; the review table shows each current value
     beside the preset's, so nothing moves unseen. The earlier rule that held
     back rows the person had changed since the last application is gone: it
     made Autonomous+ land half-applied and read as broken. A value someone
     wants different from the preset is changed after choosing it, on its own
     control or its own quick slider, and the saved name then reads
     "<preset> · N changed" instead of forgetting the preset. */
  async function choose(id) {
    if (!WORKING_PROFILES.some(profile => profile.id === id) || loading || staging || draft.saving || isBlocked() || readError()) return
    const previousFocus = root?.ownerDocument?.activeElement
    selected = id; selectionMeant = true; staging = true; message = ''; onBusy(true); paint()
    try {
      const plan = planFor(id)
      for (const [key, value] of Object.entries(plan.product)) {
        const row = rows.find(row => row.id === key)
        if (row.applicable !== false && productValueError(row, value)) throw new Error(`${title(key)}: ${productValueError(row, value)}`)
      }
      if (resources.profileState().applicable) resources.stageForProfile(plan.resources)
      // Each output uses the individual control's shared key and writer, and
      // names this profile so the save leaves its receipt. "When an agent
      // needs an answer" is derived from the Setup intent and reaches its row
      // through Setup's own writer below, never behind Setup's back.
      for (const [key, value] of Object.entries(plan.product)) {
        const row = rows.find(row => row.id === key)
        if (key === 'agent.blocked_question' || row.applicable === false) continue
        await productSettings.set(key, value, { profile: id })
      }
      await setup.stageWorkingProfile(plan.setup)
      message = draft.dirty ? 'Profile values staged. Review your pending choices, then Save settings.' : `Saved values already match ${plan.label}.`
      onStaged()
    } catch (cause) { message = `${cause.message} Any staged changes remain visible; review or discard them.` }
    finally {
      staging = false; onBusy(false); paint()
      const active = root?.ownerDocument?.activeElement
      if (previousFocus?.isConnected && (!active || active === root.ownerDocument.body || active === previousFocus)) previousFocus.focus?.({ preventScroll: true })
    }
  }
  function input(event) {
    if (event.target.matches?.('[data-working-profile-slider]') && !staging && !loading) {
      selected = WORKING_PROFILES[Number(event.target.value)]?.id || selected
      selectionMeant = true
      paint()
    }
  }
  function change(event) { if (event.target.matches?.('[data-working-profile-slider]')) void choose(WORKING_PROFILES[Number(event.target.value)]?.id) }
  function click(event) {
    const choice = event.target.closest?.('[data-working-profile-choice]')
    if (choice) void choose(choice.dataset.workingProfileChoice)
    else if (event.target.closest?.('[data-working-profile-refresh]')) void refresh()
  }
  return { markup, reviewMarkup, sync, refresh, choose,
    // The committed receipt from the last successful host read, never a staged choice.
    get savedProfile() { return savedProfile ? { ...savedProfile } : null },
    bind(target) { root = target; panel = target.querySelector('[data-working-profile]'); root.addEventListener('input', input); root.addEventListener('change', change); root.addEventListener('click', click); void refresh() },
    destroy() { generation += 1; root?.removeEventListener('input', input); root?.removeEventListener('change', change); root?.removeEventListener('click', click); root = null; panel = null },
  }
}
