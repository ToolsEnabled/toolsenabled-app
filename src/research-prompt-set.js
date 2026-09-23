import { canonical, invariant } from './benchmark/prompts.mjs'
import { PROMPT_DIMENSIONS, PROMPT_SELECTION_METHODS, selectPromptRows } from './benchmark/corpus.mjs'
import { emptyPromptSetState } from './research-prompt-set.mjs'
import './research-prompt-set.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`
const percent = value => value === null ? '—' : (100 * value).toFixed(1) + '%'
const num = value => Number(value).toLocaleString()
const plural = (count, one, many = one + 's') => `${num(count)} ${count === 1 ? one : many}`
const SET_DIMENSION = 'factor:set'

/* BUILD TASK SET. 1 tick the sets that go in; 2 all of them or a random
   sample; 3 the distribution, by set unless grouped otherwise; 4 generate.
   The pool prepares itself as the ticks change. Other sources, omission
   studies, allocation across groups, the ledger and the exclusions sit under
   Advanced. Every hook and callback keeps its contract. */
export function createPromptSetEditor({ onDraft, onInspect, onGenerate, onPrompt, onDownload }) {
  const el = document.createElement('div'); el.className = 'prompt-set-editor'
  let state = emptyPromptSetState(), spec, studies = [], sets = [], context = '', ticket = 0, locked = false, busy = false, disposed = false, pool = null, allocation = null, filter = '', inspectedGroup = null, prepareTimer = null
  const q = name => el.querySelector('[data-ps-' + name + ']')
  const publish = () => onDraft(structuredClone(state))
  const methodNeedsValues = () => ['weighted', 'quotas'].includes(state.method)
  const advancedMethod = () => !['all', 'random'].includes(state.method)
  const availableRows = () => (pool?.manifest.candidates || []).filter(row => ['selected', 'sample-excluded'].includes(row.disposition)).map(row => ({ ...row, disposition: 'eligible' }))
  const selection = () => ({ kind: state.method, limit: state.method === 'all' ? 512 : Number(state.count), dimensions: state.dimensions, weights: methodNeedsValues() ? Object.fromEntries(Object.entries(state.weights).map(([key, value]) => [key, Number(value)])) : {} })
  const setKind = set => set.kind === 'nesting' ? 'nested compositions' : set.kind === 'variance' ? 'variants' : 'compositions'
  const defaultRationale = () => `Task set from ${state.source === 'sets' ? (state.sets.length ? state.sets.join(', ') : 'saved sets') : state.source === 'current' ? 'the tasks already in the project' : state.source === 'retained' ? 'the retained pool' : 'the advanced recipe'}; ${state.method === 'all' ? 'every candidate' : `${PROMPT_SELECTION_METHODS.find(([id]) => id === state.method)?.[1].toLowerCase() || state.method} of ${state.count}, seed ${state.seed}`}.`
  function disable() {
    for (const node of el.querySelectorAll('button,input,select,textarea')) node.disabled = locked || busy
    if (q('count')) q('count').disabled = locked || busy || state.method === 'all'
    if (q('seed')) q('seed').disabled = locked || busy || state.method === 'all'
    if (q('apply')) q('apply').disabled = locked || busy || !pool || !allocation || allocation.issues.length > 0
    if (q('download')) q('download').disabled = locked || busy || !allocation
  }
  function render() {
    const retained = !!spec?.corpusPlan?.pool
    if (state.source === 'retained' && !retained) state.source = sets.length ? 'sets' : 'current'
    const chosen = new Set(state.sets)
    el.innerHTML = `
      <div class="ps-head"><h3>Build task set</h3><p class="ps-intro">Tick the sets that go in, choose how many tasks, and generate. Every composition in a chosen set is a candidate task.</p></div>
      <section class="ps-step"><div class="ps-step-head"><h4><span class="ps-step-n">1</span>Sets in the task set</h4><div class="ps-step-tools"><button type="button" class="ps-small" data-ps-sets-all>All</button><button type="button" class="ps-small" data-ps-sets-none>None</button></div></div>
        <div class="prompt-set-sets" data-ps-sets${state.source === 'sets' ? '' : ' hidden'}>${sets.length ? sets.map(set => `<label class="prompt-set-set"><input type="checkbox" data-ps-set="${esc(set.name)}"${chosen.has(set.name) ? ' checked' : ''}><span>${esc(set.name)}</span><small>${num(set.members.length)} ${setKind(set)}</small></label>`).join('') : '<p class="ps-hint">No saved sets yet. Save a run on Composition, a nested set on Nesting, or a variant set on Variance.</p>'}</div>
        <p class="ps-hint" data-ps-source-note${state.source === 'sets' ? ' hidden' : ''}>Drawing from ${state.source === 'current' ? 'the tasks already in this project' : state.source === 'retained' ? 'the retained pool of the last generation' : 'the prepared advanced recipe'} (chosen under Advanced).</p>
        <p class="ps-counts" data-ps-counts></p></section>
      <section class="ps-step"><div class="ps-step-head"><h4><span class="ps-step-n">2</span>How many</h4></div>
        <div class="ps-choices"><label class="ps-tick"><input type="radio" name="ps-mode" data-ps-mode="all"${state.method === 'all' ? ' checked' : ''}><span>All of them</span></label>
          <label class="ps-tick"><input type="radio" name="ps-mode" data-ps-mode="random"${state.method !== 'all' ? ' checked' : ''}><span>A random sample of</span></label>
          <label class="ps-field ps-inline"><span class="ps-hidden">Number of tasks</span><input data-ps-count type="number" min="1" max="512" step="1" value="${esc(state.count)}"></label>
          <label class="ps-field ps-inline"><span>seed</span><input data-ps-seed type="number" min="0" max="4294967295" step="1" value="${esc(state.seed)}"></label>
          <span class="ps-hint" data-ps-method-note></span></div></section>
      <section class="ps-step"><div class="ps-step-head"><h4><span class="ps-step-n">3</span>Distribution</h4><div class="ps-step-tools" data-ps-group-controls></div></div>
        <div data-ps-distribution></div><div data-ps-inspector hidden></div></section>
      <section class="ps-step"><div class="ps-step-head"><h4><span class="ps-step-n">4</span>Generate</h4></div>
        <label class="ps-field ps-rationale">Note for the record <span class="ps-meta">optional</span><textarea data-ps-rationale rows="1" placeholder="${esc(defaultRationale())}">${esc(state.rationale)}</textarea></label>
        <div class="ps-actions"><button type="button" class="bench-primary" data-ps-apply>Generate the task set</button><p role="status" data-ps-status class="ps-hint"></p></div>
        <p class="ps-hint">Generation replaces the project's task list; the full pool stays for resampling, and Undo restores the previous draft.</p></section>
      <details class="ps-advanced"><summary>Advanced</summary>
        <div class="ps-advanced-grid">
          <label class="ps-field">Source pool<select data-ps-source>${option('sets', sets.length ? `Saved sets (${sets.length})` : 'Saved sets (none yet)', state.source)}${option('current', 'Tasks already in this project', state.source)}${retained ? option('retained', 'Full retained pool (before selection)', state.source) : ''}${option('recipe', 'Prepared advanced generation', state.source)}</select></label>
          <label class="ps-field">Selection method<select data-ps-method>${PROMPT_SELECTION_METHODS.map(([id, label]) => option(id, label, state.method)).join('')}</select></label>
          <div class="ps-then" data-ps-then></div>
        </div>
        <details><summary>Include variants from saved omission studies (older drafts)</summary><div class="prompt-set-studies">${studies.filter(row => row.name && row.marks?.some(mark => mark.enabled)).map(row => `<label class="ps-tick"><input type="checkbox" data-ps-study="${esc(row.id)}"${state.studies.includes(row.id) ? ' checked' : ''}><span>${esc(row.name)} · ${esc(row.source.kind)}</span></label>`).join('') || '<p class="ps-hint">None. Variance saves variant sets now; they appear in step 1.</p>'}</div></details>
        <div class="ps-actions"><button type="button" class="ps-small" data-ps-prepare>Refresh the pool</button><button type="button" class="ps-small" data-ps-download>Download selection ledger</button></div>
        <details><summary>Candidate exclusions and duplicate aliases</summary><div data-ps-exclusions></div></details>
      </details>`
    renderGroups(); renderDistribution(); disable()
  }
  function dimensionChoices() {
    const factors = [...new Set(availableRows().flatMap(row => Object.keys(row.dimensions).filter(key => key.startsWith('factor:'))))].sort()
    const known = new Set(), choices = []
    for (const [id, label] of [[SET_DIMENSION, 'Set'], ...factors.map(key => [key, 'Factor: ' + key.slice(7)]), ...PROMPT_DIMENSIONS]) if (!known.has(id)) { known.add(id); choices.push([id, label]) }
    return choices
  }
  function renderGroups() {
    const choices = dimensionChoices()
    q('group-controls').innerHTML = `<label class="ps-field ps-inline"><span>Group by</span><select data-ps-dimension="0">${choices.map(([id, label]) => option(id, label, state.dimensions[0] || '')).join('')}</select></label>`
    q('then').innerHTML = [1, 2].map(index => `<label class="ps-field">Then by (optional)<select data-ps-dimension="${index}">${option('', 'None', state.dimensions[index] || '')}${choices.map(([id, label]) => option(id, label, state.dimensions[index] || '')).join('')}</select></label>`).join('')
  }
  function recalculate() {
    allocation = null
    try {
      const policy = selection(), seed = Number(state.seed)
      invariant(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'Enter a whole-number seed from 0 to 4,294,967,295.')
      invariant(Number.isSafeInteger(policy.limit) && policy.limit >= 1 && policy.limit <= 512, 'Request 1–512 tasks.')
      invariant(state.dimensions.length && new Set(state.dimensions).size === state.dimensions.length, 'Choose distinct grouping dimensions.')
      invariant(Object.values(policy.weights).every(value => Number.isFinite(value) && value >= 0 && value <= 1e9 && (state.method !== 'quotas' || Number.isSafeInteger(value))), 'Enter finite nonnegative weights, or whole numbers for exact counts.')
      if (pool) allocation = selectPromptRows(availableRows(), policy, seed)
      q('count').value = state.method === 'all' && pool ? String(availableRows().length) : state.count
      q('status').textContent = allocation?.issues.length ? allocation.issues.join(' ') : ''
    } catch (error) { q('status').textContent = error.message }
    renderDistribution(); disable()
  }
  function renderDistribution() {
    const focused = document.activeElement?.hasAttribute('data-ps-weight') ? document.activeElement : null
    q('method-note').textContent = state.method === 'all' ? '' : state.method === 'random' ? 'without replacement, across the whole pool' : `${PROMPT_SELECTION_METHODS.find(([id]) => id === state.method)?.[1].toLowerCase() || state.method}, across the groups below`
    q('rationale').placeholder = defaultRationale()
    if (!pool || !allocation) {
      q('distribution').innerHTML = `<p class="ps-hint">${pool ? 'Selection preview unavailable; check the fields above.' : busy ? 'Preparing the pool…' : state.source === 'sets' && !state.sets.length ? 'Tick at least one set.' : 'The pool prepares itself as you change the sets.'}</p>`
      q('counts').textContent = spec?.tasks.length ? `${plural(spec.tasks.length, 'task')} in the project now.` : ''
      return
    }
    const rows = availableRows(), manifest = pool.manifest, selected = allocation.selectedIds.length
    q('counts').innerHTML = `<b>${num(rows.length)}</b> candidate tasks · <b>${num(manifest.uniqueWordingCount)}</b> distinct wordings · <b>${num(selected)}</b> selected${manifest.candidateCount - rows.length ? ` · ${num(manifest.candidateCount - rows.length)} excluded or duplicate` : ''}${spec?.tasks.length ? ` · ${plural(spec.tasks.length, 'task')} in the project now` : ''}`
    if (pool.construction) q('method-note').textContent += ` The advanced recipe produced ${pool.construction.manifest.candidateCount} candidates; the allocation chosen here replaces its sampling.`
    const groups = allocation.groups.filter(group => group.label.toLowerCase().includes(filter.toLowerCase())), shown = groups.slice(0, 80), max = Math.max(1, ...allocation.groups.map(group => Math.max(group.available, group.requested || 0)))
    const heading = dimensionChoices().filter(([id]) => state.dimensions.includes(id)).map(([, label]) => label).join(' · ') || 'Group'
    q('distribution').innerHTML = `${allocation.groups.length > 12 ? `<label class="ps-field ps-inline"><span>Filter</span><input data-ps-filter type="search" value="${esc(filter)}"></label>` : ''}
      ${methodNeedsValues() ? '<button type="button" class="ps-small" data-ps-reset-values>Initialize all group values</button>' : ''}
      <div class="prompt-set-table" tabindex="0" role="region" aria-label="Available and selected tasks by group"><table>
        <thead><tr><th>${esc(heading)}</th><th class="ps-n">Available</th>${state.method === 'all' ? '' : '<th class="ps-n">Requested</th>'}<th class="ps-n">Selected</th>${methodNeedsValues() ? '<th class="ps-n">' + (state.method === 'quotas' ? 'Exact count' : 'Relative weight') + '</th>' : ''}<th class="ps-n">Inclusion</th></tr></thead>
        <tbody>${shown.map(group => `<tr><th><button type="button" class="ps-link" data-ps-inspect="${esc(group.key)}">${esc(group.label)}</button></th>
          <td class="ps-n"><span class="ps-track"><span class="prompt-set-bar prompt-set-pool" style="width:${100 * group.available / max}%"></span></span>${num(group.available)}</td>
          ${state.method === 'all' ? '' : `<td class="ps-n">${group.requested === null ? '—' : num(group.requested)}${group.requested > group.available ? ' · short' : ''}</td>`}
          <td class="ps-n"><span class="ps-track"><span class="prompt-set-bar prompt-set-sample" style="width:${100 * group.selected / max}%"></span></span>${num(group.selected)}</td>
          ${methodNeedsValues() ? `<td class="ps-n"><input data-ps-weight="${esc(group.key)}" aria-label="${esc((state.method === 'quotas' ? 'Count: ' : 'Weight: ') + group.label)}" type="number" min="0" step="${state.method === 'quotas' ? '1' : 'any'}" value="${esc(state.weights[group.key] ?? '')}"></td>` : ''}
          <td class="ps-n">${percent(group.inclusionProbability)}</td></tr>`).join('')}</tbody></table></div>
      ${groups.length > shown.length ? `<p class="ps-hint">Showing ${shown.length} of ${groups.length} matching groups. Filter to inspect the others; the ledger keeps all of them.</p>` : ''}
      ${allocation.zeroAllocationGroups ? `<p class="ps-hint">${plural(allocation.zeroAllocationGroups, 'group')} with no selected tasks.</p>` : ''}`
    q('exclusions').innerHTML = [...manifest.candidates.filter(row => !['selected', 'sample-excluded'].includes(row.disposition)), ...(pool.construction?.manifest.candidates || []).filter(row => row.disposition !== 'eligible')].map(row => `<p><strong>${esc(row.taskId)}</strong>: ${esc(row.reasons.map(reason => reason.reason + (reason.duplicateOf ? ' (' + reason.duplicateOf + ')' : '')).join('; '))}</p>`).join('') || '<p class="ps-hint">No candidate exclusions.</p>'
    if (focused) {
      const replacement = [...el.querySelectorAll('[data-ps-weight]')].find(node => node.getAttribute('data-ps-weight') === focused.getAttribute('data-ps-weight'))
      if (replacement) { replacement.replaceWith(focused); focused.focus() }
    }
    if (q('prompt')) for (const item of q('prompt').options) item.textContent = item.value + (allocation.chosen.has(item.value) ? ' · selected' : '')
  }
  async function prepare() {
    const own = ++ticket, key = context
    if (state.source === 'sets' && !state.sets.length) { pool = null; allocation = null; renderDistribution(); disable(); return }
    busy = true; disable(); q('status').textContent = ''; renderDistribution()
    try {
      const result = await onInspect(structuredClone(state))
      if (disposed || own !== ticket || key !== context) return
      pool = result; inspectedGroup = null; q('inspector').hidden = true; renderGroups(); recalculate()
    } catch (error) { if (!disposed && own === ticket && key === context) { pool = null; allocation = null; q('status').textContent = error.message; renderDistribution() } }
    finally { if (!disposed && own === ticket && key === context) { busy = false; disable() } }
  }
  // The pool follows the ticks: a short pause, then it prepares itself.
  function schedulePrepare() {
    pool = null; allocation = null; inspectedGroup = null; q('inspector').hidden = true; renderDistribution(); disable()
    if (prepareTimer) clearTimeout(prepareTimer)
    prepareTimer = setTimeout(() => { prepareTimer = null; if (!disposed) prepare() }, 250)
  }
  el.addEventListener('input', event => {
    if (locked || busy) return
    const node = event.target
    if (node.hasAttribute('data-ps-filter')) { filter = node.value; const at = node.selectionStart; renderDistribution(); q('filter')?.focus(); q('filter')?.setSelectionRange?.(at, at); disable(); return }
    if (node.hasAttribute('data-ps-rationale')) { state.rationale = node.value; publish(); disable(); return }
    for (const name of ['count', 'seed']) if (node === q(name)) { state[name] = node.value; publish(); recalculate(); return }
    if (node.hasAttribute('data-ps-weight')) {
      const key = node.getAttribute('data-ps-weight')
      if (node.value === '') delete state.weights[key]; else state.weights[key] = node.value
      publish(); recalculate()
      const replacement = [...el.querySelectorAll('[data-ps-weight]')].find(item => item.getAttribute('data-ps-weight') === key); replacement?.focus()
    }
  })
  el.addEventListener('change', event => {
    if (locked || busy) return
    const node = event.target
    if (node.hasAttribute('data-ps-mode')) { state.method = node.getAttribute('data-ps-mode') === 'all' ? 'all' : advancedMethod() ? state.method : 'random'; publish(); render(); recalculate(); return }
    if (node === q('method')) { state.method = node.value; publish(); render(); recalculate(); return }
    if (node === q('source') || node.hasAttribute('data-ps-study') || node.hasAttribute('data-ps-set')) {
      if (node === q('source')) { state.source = node.value; if (state.source === 'sets' && (!state.dimensions.length || state.dimensions[0] === 'omission')) state.dimensions = [SET_DIMENSION]; publish(); render(); schedulePrepare(); return }
      if (node.hasAttribute('data-ps-set')) state.sets = [...el.querySelectorAll('[data-ps-set]')].filter(item => item.checked).map(item => item.getAttribute('data-ps-set'))
      else state.studies = [...el.querySelectorAll('[data-ps-study]')].filter(item => item.checked).map(item => item.getAttribute('data-ps-study'))
      publish(); schedulePrepare(); return
    }
    if (node.hasAttribute('data-ps-dimension')) {
      state.dimensions = [...el.querySelectorAll('[data-ps-dimension]')].map(item => item.value).filter(Boolean); state.weights = {}; publish(); recalculate()
      inspectedGroup = null; q('inspector').hidden = true
    }
  })
  el.addEventListener('click', async event => {
    const button = event.target.closest('button')
    if (!button || locked || busy) return
    const operationContext = context, operationTicket = ticket
    try {
      if (button.hasAttribute('data-ps-sets-all') || button.hasAttribute('data-ps-sets-none')) {
        state.sets = button.hasAttribute('data-ps-sets-all') ? sets.map(set => set.name) : []
        for (const box of el.querySelectorAll('[data-ps-set]')) box.checked = state.sets.includes(box.getAttribute('data-ps-set'))
        publish(); schedulePrepare(); return
      }
      if (button === q('prepare')) { await prepare(); return }
      if (button.hasAttribute('data-ps-reset-values')) {
        state.weights = Object.fromEntries(allocation.groups.map(group => [group.key, state.method === 'quotas' ? String(group.selected) : '1'])); publish(); recalculate(); return
      }
      if (button.hasAttribute('data-ps-inspect')) {
        inspectedGroup = button.getAttribute('data-ps-inspect')
        const rows = availableRows().filter(row => canonical(state.dimensions.map(key => row.dimensions[key] ?? null)) === inspectedGroup)
        q('inspector').hidden = false; q('inspector').innerHTML = `<h5>${esc(allocation.groups.find(group => group.key === inspectedGroup).label)}</h5><p class="ps-hint">${plural(rows.length, 'available task')}. Showing up to 30.</p><div class="ps-actions"><select data-ps-prompt>${rows.slice(0, 30).map(row => option(row.taskId, row.taskId + (allocation.chosen.has(row.taskId) ? ' · selected' : ''), rows[0]?.taskId)).join('')}</select><button type="button" class="ps-small" data-ps-read>Read prompt</button></div><pre data-ps-wording tabindex="0"></pre>`
        return
      }
      if (button.hasAttribute('data-ps-read')) {
        const own = ticket, key = context, task = pool.plan.pool.tasks.find(task => task.id === q('prompt').value)
        busy = true; disable()
        const text = await onPrompt(task)
        if (!disposed && own === ticket && key === context && q('wording')) q('wording').textContent = text
        return
      }
      if (button === q('download')) {
        onDownload({ ...pool.manifest, construction: pool.construction, previewSelection: selection(), previewSeed: Number(state.seed), previewAllocation: { ...allocation, chosen: undefined }, rationale: state.rationale.trim() || defaultRationale() }); return
      }
      if (button === q('apply')) {
        invariant(pool && allocation && !allocation.issues.length, 'The pool is not ready. Tick sets and wait for the preview.')
        const plan = { ...structuredClone(pool.plan), seed: Number(state.seed), rationale: state.rationale.trim() || defaultRationale(), selection: selection() }, key = context
        busy = true; disable()
        const result = await onGenerate(plan, pool.binding, pool.construction)
        if (disposed || context !== key) return
        if (!result?.ok) throw new Error(result?.error || 'The task set could not be generated.')
        state.source = 'retained'; publish(); render(); q('status').textContent = `${plural(result.count, 'task')} generated. The full pool and allocation are retained for resampling.`
      }
    } catch (error) { if (!disposed && operationContext === context && operationTicket === ticket) q('status').textContent = error.message }
    finally { if (!disposed && operationContext === context && operationTicket === ticket) { busy = false; disable() } }
  })
  render()
  return { el, setContext(next) {
    const nextKey = next.contextKey
    ticket++; context = nextKey; busy = false; pool = null; allocation = null; spec = next.spec; studies = next.studies || []; sets = next.sets || []
    if (prepareTimer) { clearTimeout(prepareTimer); prepareTimer = null }
    state = next.state ? { ...emptyPromptSetState(), ...structuredClone(next.state) } : emptyPromptSetState()
    if (!Array.isArray(state.sets)) state.sets = []
    state.sets = state.sets.filter(name => sets.some(set => set.name === name))
    // A fresh selection draws from every saved set, grouped by set; a project
    // without sets falls back to the tasks it already holds.
    if (!next.state && !spec.corpusPlan?.pool && sets.length) { state.source = 'sets'; state.sets = sets.map(set => set.name); state.dimensions = [SET_DIMENSION] }
    if (state.source === 'sets' && !sets.length) state.source = 'current'
    if (!next.state && spec.corpusPlan?.pool) state = { ...state, source: 'retained', method: spec.corpusPlan.selection.kind, count: String(spec.corpusPlan.selection.limit), seed: String(spec.corpusPlan.seed), dimensions: spec.corpusPlan.selection.dimensions, weights: spec.corpusPlan.selection.weights, rationale: spec.corpusPlan.rationale }
    render()
    if (next.active && (spec.tasks.length || spec.corpusPlan?.pool || (state.source === 'sets' && state.sets.length))) prepare()
  }, setDisabled(value) { locked = value; disable() }, destroy() { disposed = true; ticket++; if (prepareTimer) clearTimeout(prepareTimer) } }
}
