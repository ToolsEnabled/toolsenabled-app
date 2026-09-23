import { emptyVarianceState, emptyVarianceRun, textMark, varianceTreatments } from './research-variance.mjs'
import { ALL_SET, SNIPPET_PREFIX, compositionFamily, compositionSnippets, emptyNestingMember, isSnippetMember, memberPool, nestingSets, snippetCategories, snippetCategoryOf } from './research-nesting.mjs'
import './research-variance.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`
const num = value => Number.isSafeInteger(value) ? value.toLocaleString() : 'Too many'
const plural = (count, one, many = one + 's') => `${num(count)} ${count === 1 ? one : many}`
const text = value => String(value ?? '').trim()
const PICK_LIMIT = 400
function markedOriginal(source, marks) {
  const merged = []
  for (const range of [...marks].sort((a, b) => a.start - b.start)) {
    const prior = merged.at(-1)
    if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end)
    else merged.push({ start: range.start, end: range.end })
  }
  let cursor = 0, result = ''
  for (const range of merged) { result += esc(source.slice(cursor, range.start)) + `<del>${esc(source.slice(range.start, range.end))}</del>`; cursor = range.end }
  return result + esc(source.slice(cursor))
}

/* VARIANCE over sets. 1 what to vary: composition sets (whole or picked) and
   the snippets to mark text in; 2 the omissions: parts to leave out of every
   composition, and marked words inside snippets, one at a time or together,
   with the untouched control; 3 generate the variant set with a count and a
   seed, review, save. The saved variant set is a set like any other. The
   retained draft keeps the older per-source studies untouched beside the run. */
export function createVarianceEditor({ onDraft, onSnippet, onPreviewRun, onSaveRun, onPreviewRow }) {
  const el = document.createElement('div'); el.className = 'variance-editor'
  let state = emptyVarianceState(), spec = { tasks: [], catalog: [] }, routing = null, prepared = null, page = 0
  let locked = false, disposed = false, active = false, ticket = 0, busy = false, context = ''
  let pickerFor = null, pickerSearch = '', pickerOpen = new Map(), markingId = '', snippet = null, markLabel = '', markReplace = ''
  const q = name => el.querySelector(`[data-var-${name}]`)
  const run = () => state.run
  const publish = () => onDraft(structuredClone(state))
  const sets = () => nestingSets(routing, spec.catalog)
  const names = () => (routing?.compositions || []).map(item => item.name).filter(Boolean)
  const setLabel = name => name === ALL_SET ? 'All compositions' : typeof name === 'string' && name.startsWith(SNIPPET_PREFIX) ? name.slice(SNIPPET_PREFIX.length) + ' (snippets)' : name
  const titleOf = id => { const bundle = spec.catalog.find(item => item.id === id); return bundle ? bundle.title || bundle.id : id }
  const itemLabel = (member, id) => isSnippetMember(member) ? titleOf(id) : id
  const poolOf = member => memberPool(member, routing, spec.catalog)
  const availableOf = member => memberPool({ ...member, pick: 'all' }, routing, spec.catalog)
  const categories = () => [...new Set(spec.catalog.filter(item => item.kind === 'atom').flatMap(bundle => (bundle.labels || []).map(text).filter(Boolean).length ? [...new Set((bundle.labels || []).map(text).filter(Boolean))] : ['Unlabelled']))]
  const compositionsInScope = () => [...new Set(run().members.flatMap(poolOf))]
  const snippetsToMark = () => [...new Set(run().snippets.flatMap(poolOf))]
  const treatments = () => varianceTreatments(run())
  const keptRows = () => (prepared?.rows || []).filter(row => state.review?.rows.find(item => item.index === row.index)?.keep)
  const rowsOf = (list, key) => list.map((member, i) => ({ member, i, key }))
  // Which compositions take a change: those using a snippet with an enabled
  // mark. Counted per set row and per snippet in the marking list.
  const changedSnippets = () => new Set(run().marks.filter(mark => mark.enabled).map(mark => mark.bundleId))
  const snippetsOf = new Map()
  const usesOf = name => { if (!snippetsOf.has(name)) snippetsOf.set(name, compositionSnippets(name, routing, spec.catalog)); return snippetsOf.get(name) }
  const takesChange = (name, changed = changedSnippets()) => usesOf(name).some(id => changed.has(id)) || run().parts.length > 0
  const affectedIn = names => { const changed = changedSnippets(); return names.filter(name => takesChange(name, changed)).length }
  const usageOf = id => compositionsInScope().filter(name => usesOf(name).includes(id)).length

  function disable() {
    for (const tag of ['button', 'input', 'select', 'textarea']) for (const node of el.querySelectorAll(tag)) node.disabled = locked || busy
    if (!q('name')) return
    const omissions = treatments().some(item => item.marks.length || item.parts.length)
    q('generate').disabled = locked || busy || !run().members.length || !omissions
    if (q('save-run')) { q('save-run').disabled = locked || busy || !prepared || !keptRows().length; q('save-run').textContent = `Save as variant set (${prepared ? keptRows().length : 0})` }
    if (q('count')) q('count').disabled = locked || busy || run().method === 'all'
    if (q('seed')) q('seed').disabled = locked || busy || run().method === 'all'
    if (q('mark')) q('mark').disabled = locked || busy || !snippet || !(q('text').selectionEnd > q('text').selectionStart)
    for (const key of ['members', 'snippets']) for (const node of el.querySelectorAll(`[data-var-up-${key}]`)) node.disabled = locked || busy || Number(node.getAttribute(`data-var-up-${key}`)) === 0
    for (const key of ['members', 'snippets']) for (const node of el.querySelectorAll(`[data-var-down-${key}]`)) node.disabled = locked || busy || Number(node.getAttribute(`data-var-down-${key}`)) === run()[key].length - 1
    for (const node of el.querySelectorAll('[data-var-choose]')) { const [key, i] = node.getAttribute('data-var-choose').split(':'); node.disabled = locked || busy || run()[key][Number(i)]?.pick !== 'some' }
    if (q('previous')) q('previous').disabled = locked || busy || page === 0
    if (q('next')) q('next').disabled = locked || busy || (page + 1) * 20 >= (prepared?.rows || []).length
  }
  const invalidateRun = () => { prepared = null; state.review = null; page = 0; renderRun() }

  /* ---- 1. scope rows ---- */
  const setOptions = (selected, snippets) => snippets
    ? snippetCategories(spec.catalog).map(category => option(SNIPPET_PREFIX + category.name, `${category.name} (${num(category.members.length)} snippets)`, selected)).join('') || option('', 'No snippets in the library', '')
    : [option(ALL_SET, `All compositions (${num(names().length)})`, selected), ...sets().map(set => option(set.name, `${set.name} (${num(set.members.length)}${set.kind === 'nesting' ? ', nested' : set.kind === 'variance' ? ', variants' : ''})`, selected))].join('')
  function scopeRow(member, i, key) {
    const available = availableOf(member), chosen = poolOf(member), open = pickerFor === `${key}:${i}`
    return `<li class="var-row"><div class="var-row-line"><span class="var-index">${i + 1}</span><select data-var-member="${key}:${i}" aria-label="${key === 'members' ? 'Compositions' : 'Snippets'} ${i + 1}">${setOptions(member.set, key === 'snippets')}</select>
      <select data-var-scope="${key}:${i}" aria-label="Take all or pick">${option('all', `All ${num(available.length)}`, member.pick)}${option('some', member.pick === 'some' ? `Picked ${num(chosen.length)} of ${num(available.length)}` : 'Pick…', member.pick)}</select>
      <button type="button" class="var-small" data-var-choose="${key}:${i}"${member.pick === 'some' ? '' : ' hidden'}>${open ? 'Done' : 'Choose…'}</button>
      <span class="var-meta">${plural(chosen.length, key === 'snippets' ? 'snippet' : 'composition')}${key === 'members' && chosen.length ? ` · ${num(affectedIn(chosen))} take a change` : ''}</span>
      <span class="var-tools"><button type="button" class="var-small" data-var-up-${key}="${i}" aria-label="Move up">↑</button><button type="button" class="var-small" data-var-down-${key}="${i}" aria-label="Move down">↓</button><button type="button" class="var-small var-drop" data-var-remove="${key}:${i}" aria-label="Remove">×</button></span></div>
      ${open ? '<div class="var-picker" data-var-picker></div>' : ''}</li>`
  }
  const familyOf = (member, id) => isSnippetMember(member) ? text(spec.catalog.find(item => item.id === id)?.donor?.family) : compositionFamily(id, routing, spec.catalog)
  function pickerGroups(member) {
    const groups = new Map(), available = availableOf(member), hasFamilies = available.some(id => familyOf(member, id))
    for (const id of available) { const family = hasFamilies ? familyOf(member, id) || 'Other' : ''; if (!groups.has(family)) groups.set(family, []); groups.get(family).push(id) }
    if (groups.has('Other')) { const other = groups.get('Other'); groups.delete('Other'); groups.set('Other', other) }
    return { hasFamilies, groups }
  }
  const pickerMember = () => { if (!pickerFor) return null; const [key, i] = pickerFor.split(':'); return run()[key]?.[Number(i)] || null }
  function renderPicker() {
    const host = q('picker'); if (!host) return
    const member = pickerMember(); if (!member) { host.innerHTML = ''; return }
    const chosen = new Set(member.selected || []), { hasFamilies, groups } = pickerGroups(member), available = availableOf(member), search = pickerSearch.toLocaleLowerCase()
    const matches = id => !search || itemLabel(member, id).toLocaleLowerCase().includes(search)
    let shownTotal = 0
    const groupMarkup = [...groups].map(([family, ids]) => {
      const shown = ids.filter(matches), picked = ids.filter(id => chosen.has(id)).length; shownTotal += shown.length
      const key = family || '(all)', open = search ? true : pickerOpen.has(key) ? pickerOpen.get(key) : !hasFamilies || picked > 0
      const items = `<ul class="var-pick-items">${shown.slice(0, PICK_LIMIT).map(id => `<li><label class="var-pick"><input type="checkbox" data-var-pick="${esc(id)}"${chosen.has(id) ? ' checked' : ''}><span>${esc(itemLabel(member, id))}</span></label></li>`).join('')}${shown.length > PICK_LIMIT ? `<li class="var-hint">${num(shown.length - PICK_LIMIT)} more here. Narrow the search to see them, or pick all shown.</li>` : ''}</ul>`
      if (!hasFamilies) return `<div class="var-pick-group"${shown.length ? '' : ' hidden'}>${items}</div>`
      return `<div class="var-pick-group"${shown.length ? '' : ' hidden'}><input type="checkbox" class="var-pick-check" data-var-pick-group="${esc(family)}" aria-label="Pick every item in ${esc(family)}"${picked === ids.length ? ' checked' : ''}><details data-var-pick-node="${esc(key)}"${open ? ' open' : ''}><summary><span class="var-pick-name">${esc(family)}</span><span class="var-meta">${num(picked)} of ${num(ids.length)}</span></summary>${items}</details></div>`
    }).join('')
    host.innerHTML = `<div class="var-picker-tools"><span class="var-meta" data-var-pick-count>${num(chosen.size)} of ${num(available.length)} picked</span><label class="var-field var-field-search"><span class="var-hidden">Find</span><input type="search" data-var-pick-search value="${esc(pickerSearch)}" placeholder="Find ${isSnippetMember(member) ? 'a snippet' : 'a composition'}"></label><button type="button" class="var-small" data-var-pick-all>Pick all shown</button><button type="button" class="var-small" data-var-pick-none>Clear shown</button></div>
      <div class="var-pick-tree">${groupMarkup}${shownTotal ? '' : '<p class="var-hint">Nothing matches.</p>'}</div>`
    for (const node of el.querySelectorAll('[data-var-pick-group]')) { const ids = groups.get(node.getAttribute('data-var-pick-group')) || [], picked = ids.filter(id => chosen.has(id)).length; node.indeterminate = picked > 0 && picked < ids.length }
    const scope = el.querySelector(`[data-var-scope="${pickerFor}"]`)
    if (scope) for (const item of scope.options || []) if (item.value === 'some') item.textContent = `Picked ${num(chosen.size)} of ${num(available.length)}`
  }

  /* ---- 2. omissions ---- */
  function renderOmissions() {
    const current = run(), toMark = snippetsToMark(), parts = categories()
    if (q('parts')) q('parts').innerHTML = parts.length ? parts.map(part => `<label class="var-tick"><input type="checkbox" data-var-part="${esc(part)}"${current.parts.includes(part) ? ' checked' : ''}><span>${esc(part)}</span></label>`).join('') : '<p class="var-hint">No snippet categories in the library.</p>'
    if (!toMark.includes(markingId)) markingId = toMark[0] || ''
    const scoped = compositionsInScope().length
    q('marking').innerHTML = toMark.length ? toMark.map(id => option(id, scoped ? `${titleOf(id)} · used by ${num(usageOf(id))} of ${num(scoped)}` : titleOf(id), markingId)).join('') : option('', 'Add snippets to change above', '')
    q('marking').value = markingId
    q('marks').innerHTML = current.marks.length ? `<ul class="var-marks">${current.marks.map((mark, i) => `<li><label class="var-tick"><input type="checkbox" data-var-enabled="${i}"${mark.enabled ? ' checked' : ''}><span></span></label><input class="var-mark-label" data-var-mark-label="${i}" value="${esc(mark.label)}" maxlength="120" aria-label="Omission name"><span class="var-meta">${esc(mark.title)}</span><span class="var-mark-text">“${esc(mark.text.length > 90 ? mark.text.slice(0, 87) + '…' : mark.text)}”${mark.replacement ? ` → “${esc(mark.replacement.length > 90 ? mark.replacement.slice(0, 87) + '…' : mark.replacement)}”` : ' → omitted'}</span><button type="button" class="var-small var-drop" data-var-remove-mark="${i}" aria-label="Remove">×</button></li>`).join('')}</ul>` : '<p class="var-hint">Nothing marked yet. Choose a snippet, highlight words, and mark them.</p>'
    renderSnippet()
  }
  async function loadSnippet() {
    const own = ++ticket, id = markingId
    snippet = null; q('text').value = ''; q('text-note').textContent = id ? 'Reading the snippet…' : 'Add snippets to change in step 1, then choose one here.'
    if (!id || !onSnippet) { disable(); return }
    try {
      const result = await onSnippet(id)
      if (disposed || own !== ticket) return
      snippet = result; q('text').value = result.text; q('text-note').textContent = 'Highlight the words to change, then mark them.'
    } catch (error) { if (!disposed && own === ticket) q('text-note').textContent = error.message }
    disable()
  }
  function renderSnippet() { if (snippet?.id !== markingId) loadSnippet(); else { q('text').value = snippet.text; disable() } }

  /* ---- 3. the run ---- */
  function possibleLine() {
    const scoped = compositionsInScope(), affected = affectedIn(scoped), arms = treatments().length, changes = treatments().filter(item => item.marks.length || item.parts.length).length
    if (!run().members.length) return ''
    if (!changes) return `<p class="var-possible" data-var-possible>Mark words in a snippet first. ${plural(scoped.length, 'composition')} in scope.</p>`
    if (!affected) return `<p class="var-possible" data-var-possible>None of the ${plural(scoped.length, 'composition')} in scope uses a changed snippet. Mark words in a snippet they use, or choose other sets.</p>`
    return `<p class="var-possible" data-var-possible>Variants possible: up to ${num(affected)} of ${plural(scoped.length, 'composition')} take a change × ${plural(arms, 'treatment')}${run().includeControl ? ' (the original counted)' : ''} = <b>${num(affected * arms)}</b> · the exact count appears once generated, since each change touches only the compositions that use its snippet; untouched compositions stay out.</p>`
  }
  function renderRun() {
    const host = q('run'); if (!host) return
    host.hidden = !prepared
    disable()
    if (!prepared) return
    const rows = prepared.rows.slice(page * 20, (page + 1) * 20), kept = keptRows().length
    q('run-count').textContent = `${num(prepared.rows.length)} variants ${prepared.method === 'all' ? 'generated' : 'sampled'} from ${num(prepared.total)} possible${prepared.seed !== null ? ` · seed ${prepared.seed}` : ''} · ${plural(prepared.bundles.length, 'new snippet or template')} · ${num(kept)} kept. Untick what you do not want, rename what you like, then save the set.`
    q('page').textContent = prepared.rows.length > 20 ? `Page ${page + 1} of ${Math.ceil(prepared.rows.length / 20)}` : ''
    q('pager').hidden = prepared.rows.length <= 20
    q('rows').innerHTML = rows.map(row => {
      const review = state.review.rows.find(item => item.index === row.index)
      return `<tr><td class="var-keep"><input type="checkbox" data-var-keep="${row.index}" aria-label="Keep ${esc(review.name)}"${review.keep ? ' checked' : ''}></td>
        <td><input data-var-run-name="${row.index}" aria-label="Variant name" value="${esc(review.name)}" maxlength="64"></td>
        <td><span class="var-source">${esc(row.source)}</span></td><td>${esc(row.arm)}</td>
        <td><button type="button" class="var-small" data-var-run-read="${row.index}">Read prompt</button></td></tr>`
    }).join('')
    disable()
  }

  function render() {
    if (disposed) return
    const current = run()
    el.innerHTML = `<div class="var-head"><h3>Variance</h3><p class="var-intro">Controlled variants blank, delete or replace words inside a snippet with vaguer wording. Every composition in the chosen sets is rebuilt with the change. Each variant remains a complete prompt. Each change alone, or all together, beside the untouched original. The result is saved as a variant set. Build task set draws from it, and Nesting can nest it. A nested set can also be varied.</p></div>
      <section class="var-step"><div class="var-step-head"><h4><span class="var-step-n">1</span>Snippet changes</h4></div>
        <p class="var-hint">The snippets whose words change, by category, all or picked. Then choose one, highlight words, and mark them.</p>
        <ol class="var-rows">${current.snippets.map((member, i) => scopeRow(member, i, 'snippets')).join('') || '<li class="var-hint">Add a snippet category to change words inside its snippets.</li>'}</ol><button type="button" class="var-small" data-var-add="snippets">Add a snippet category</button>
        <div class="var-marking"><label class="var-field">Snippet<select data-var-marking></select></label>
          <textarea data-var-text rows="6" readonly aria-label="Snippet text; highlight words to change"></textarea><p class="var-hint" data-var-text-note></p>
          <div class="var-mark-tools"><label class="var-field"><span>Replace with <span class="var-meta">leave empty to omit</span></span><input data-var-replace maxlength="4000" value="${esc(markReplace)}" placeholder="For example: SMA, or: some consecutive days"></label><label class="var-field">Change name<input data-var-label maxlength="120" value="${esc(markLabel)}" placeholder="For example: RSI period blanked"></label><button type="button" class="var-small" data-var-mark>Mark highlighted words</button></div>
          <p class="var-hint">Replacement wording takes the place of the selected words. For example, “SMA(20)” becomes “SMA”, or “3 consecutive days” becomes “some consecutive days”. Without replacement wording, the selected words are removed and the sentence closes around the gap.</p></div>
        <div data-var-marks></div></section>
      <section class="var-step"><div class="var-step-head"><h4><span class="var-step-n">2</span>Compositions that take the changes</h4></div>
        <p class="var-hint">Every composition in these sets that uses a changed snippet becomes a variant. Nested sets and earlier variant sets count too.</p>
        <ol class="var-rows">${current.members.map((member, i) => scopeRow(member, i, 'members')).join('') || '<li class="var-hint">No sets chosen yet.</li>'}</ol><button type="button" class="var-small" data-var-add="members">Add a set</button>
        <details class="var-advanced"${current.parts.length ? ' open' : ''}><summary>Advanced: leave out a whole part</summary><p class="var-hint">Drops that part from every composition that has it. The variant is then an incomplete prompt on purpose; use it only when that is the study.</p><div class="var-ticks" data-var-parts></div></details></section>
      <section class="var-step"><div class="var-step-head"><h4><span class="var-step-n">3</span>Generate the variant set</h4></div>
        <div class="var-ticks var-generate-ticks"><label class="var-field">Generate<select data-var-mode>${option('individual', 'One variant per change', current.mode)}${option('together', 'All changes together', current.mode)}</select></label><label class="var-tick"><input type="checkbox" data-var-control${current.includeControl ? ' checked' : ''}><span>Include the original as a control</span></label></div>
        ${possibleLine()}
        <div class="var-run-controls"><label class="var-field">Variant set name<input data-var-name value="${esc(current.name)}" maxlength="64" placeholder="Variant run 1"></label><label class="var-field">Number to generate<input data-var-count type="number" min="1" max="10000" value="${esc(current.count)}"></label>
          <label class="var-field">Which ones<select data-var-method>${option('sample', 'A random subset', current.method)}${option('all', 'All of them', current.method)}</select></label><label class="var-field">Random seed<input data-var-seed type="number" min="0" max="4294967295" value="${esc(current.seed)}"></label>
          <button type="button" class="bench-primary" data-var-generate>Generate the variant set</button></div>
        <p data-var-status role="status" class="var-hint"></p>
        <section class="var-run" data-var-run hidden><h5>The variant set</h5><p class="var-hint" data-var-run-count></p>
          <div class="var-actions"><button type="button" class="var-small" data-var-keep-all>Keep all</button><button type="button" class="var-small" data-var-keep-none>Keep none</button></div>
          <div class="var-run-table"><table><thead><tr><th>Keep</th><th>Name</th><th>From</th><th>Treatment</th><th>Review</th></tr></thead><tbody data-var-rows></tbody></table></div>
          <div class="var-actions" data-var-pager><button type="button" class="var-small" data-var-previous>Previous</button><span class="var-meta" data-var-page></span><button type="button" class="var-small" data-var-next>Next</button></div>
          <h5 data-var-run-reading class="var-reading"></h5><div class="var-compare" data-var-compare hidden><div><h6>Original · changes marked</h6><pre data-var-original tabindex="0"></pre></div><div><h6>Variant</h6><pre data-var-run-text tabindex="0"></pre></div></div>
          <div class="var-actions"><button type="button" class="bench-primary" data-var-save-run>Save as variant set (0)</button></div></section></section>`
    q('mode').value = current.mode
    for (const [key, list] of [['members', current.members], ['snippets', current.snippets]]) list.forEach((member, i) => { const s = el.querySelector(`[data-var-member="${key}:${i}"]`); if (s) s.value = member.set; const sc = el.querySelector(`[data-var-scope="${key}:${i}"]`); if (sc) sc.value = member.pick })
    for (const name of ['mouseup', 'keyup', 'select']) q('text').addEventListener(name, () => disable())
    renderPicker(); renderOmissions(); renderRun(); disable()
  }
  el.addEventListener('toggle', event => {
    const node = event.target
    if (node && typeof node.hasAttribute === 'function' && node.hasAttribute('data-var-pick-node') && !pickerSearch) pickerOpen.set(node.getAttribute('data-var-pick-node'), !!node.open)
  }, true)
  el.addEventListener('input', event => {
    event.stopPropagation(); if (locked || busy) return
    const target = event.target
    if (target.hasAttribute('data-var-pick-search')) { pickerSearch = target.value; const keep = pickerSearch; renderPicker(); const box = q('pick-search'); if (box) { box.value = keep; box.focus?.() } return }
    if (target.hasAttribute('data-var-label')) { markLabel = target.value; return }
    if (target.hasAttribute('data-var-replace')) { markReplace = target.value; return }
    if (target.hasAttribute('data-var-run-name')) { const row = state.review?.rows.find(item => item.index === Number(target.getAttribute('data-var-run-name'))); if (row) { row.name = target.value; publish() } return }
    if (target.hasAttribute('data-var-mark-label')) { run().marks[Number(target.getAttribute('data-var-mark-label'))].label = target.value; publish(); invalidateRun(); return }
    if (target.hasAttribute('data-var-name')) run().name = target.value
    else if (target.hasAttribute('data-var-count')) run().count = target.value
    else if (target.hasAttribute('data-var-seed')) run().seed = target.value
    else return
    publish(); invalidateRun()
  })
  el.addEventListener('change', event => {
    event.stopPropagation(); if (locked || busy) return
    const target = event.target, current = run()
    if (target.hasAttribute('data-var-pick') || target.hasAttribute('data-var-pick-group')) {
      const member = pickerMember(); if (!member) return
      const chosen = new Set(member.selected || [])
      if (target.hasAttribute('data-var-pick')) { const id = target.getAttribute('data-var-pick'); if (target.checked) chosen.add(id); else chosen.delete(id) }
      else for (const id of pickerGroups(member).groups.get(target.getAttribute('data-var-pick-group')) || []) { if (target.checked) chosen.add(id); else chosen.delete(id) }
      member.selected = availableOf(member).filter(item => chosen.has(item))
      publish(); invalidateRun(); renderPicker(); renderOmissions(); return
    }
    if (target.hasAttribute('data-var-member')) { const [key, i] = target.getAttribute('data-var-member').split(':'); const member = current[key][Number(i)]; member.set = target.value; member.selected = []; pickerFor = null; publish(); invalidateRun(); render(); return }
    if (target.hasAttribute('data-var-scope')) { const id = target.getAttribute('data-var-scope'), [key, i] = id.split(':'), member = current[key][Number(i)]; member.pick = target.value; pickerFor = member.pick === 'some' ? id : null; pickerSearch = ''; pickerOpen = new Map(); publish(); invalidateRun(); render(); return }
    if (target.hasAttribute('data-var-part')) { const part = target.getAttribute('data-var-part'); current.parts = target.checked ? [...new Set([...current.parts, part])] : current.parts.filter(item => item !== part); publish(); invalidateRun(); render(); return }
    if (target.hasAttribute('data-var-marking')) { markingId = target.value; renderSnippet(); return }
    if (target.hasAttribute('data-var-enabled')) { current.marks[Number(target.getAttribute('data-var-enabled'))].enabled = target.checked; publish(); invalidateRun(); render(); return }
    if (target.hasAttribute('data-var-keep')) { const row = state.review?.rows.find(item => item.index === Number(target.getAttribute('data-var-keep'))); if (row) { row.keep = target.checked; publish(); renderRun() } return }
    if (target.hasAttribute('data-var-mode')) current.mode = target.value
    else if (target.hasAttribute('data-var-control')) current.includeControl = target.checked
    else if (target.hasAttribute('data-var-method')) current.method = target.value
    else return
    publish(); invalidateRun(); render()
  })
  async function generate() {
    if (!onPreviewRun) return
    if (!text(run().name)) { const taken = new Set([...sets().map(set => set.name), ...names()]); let i = 1; while (taken.has(`Variant run ${i}`)) i++; run().name = `Variant run ${i}`; q('name').value = run().name }
    const own = ++ticket
    busy = true; disable(); q('status').textContent = 'Generating the variant set…'
    try {
      const result = await onPreviewRun(structuredClone(run()))
      if (disposed || own !== ticket) return
      prepared = result; page = 0
      if (state.review?.fingerprint !== result.fingerprint) state.review = { fingerprint: result.fingerprint, rows: result.rows.map(row => ({ index: row.index, name: row.name, keep: true })) }
      q('status').textContent = ''
      publish(); renderRun()
    } catch (error) { if (!disposed) q('status').textContent = error.message }
    finally { if (!disposed) { busy = false; disable() } }
  }
  async function saveRun() {
    if (!onSaveRun || !prepared) return
    const selections = keptRows().map(row => ({ index: row.index, name: state.review.rows.find(item => item.index === row.index).name }))
    busy = true; disable(); q('status').textContent = 'Saving the variant set…'
    try {
      const result = await onSaveRun(prepared, selections)
      if (disposed) return
      if (!result?.ok) throw new Error(result?.error || 'The variant set could not be saved.')
      prepared = null; state.review = null; run().name = ''
      publish(); render()
      q('status').textContent = `Variant set ${result.name} saved: ${plural(result.count, 'composition')}${result.bundles ? ` and ${plural(result.bundles, 'new snippet or template')}` : ''}. Build task set can draw from it; Nesting can use it.`
    } catch (error) { if (!disposed) q('status').textContent = error.message }
    finally { if (!disposed) { busy = false; disable() } }
  }
  el.addEventListener('click', async event => {
    event.stopPropagation(); const button = event.target.closest('button'); if (!button || locked || busy) return
    const has = name => button.hasAttribute(`data-var-${name}`), value = name => button.getAttribute(`data-var-${name}`), current = run()
    try {
      if (has('pick-all') || has('pick-none')) {
        const member = pickerMember(); if (!member) return
        const shown = new Set([...el.querySelectorAll('[data-var-pick]')].map(node => node.getAttribute('data-var-pick'))), chosen = new Set(member.selected || [])
        for (const id of shown) { if (has('pick-all')) chosen.add(id); else chosen.delete(id) }
        member.selected = availableOf(member).filter(item => chosen.has(item)); publish(); invalidateRun(); renderPicker(); renderOmissions(); return
      }
      if (has('choose')) { const id = value('choose'); pickerFor = pickerFor === id ? null : id; pickerSearch = ''; pickerOpen = new Map(); render(); return }
      if (has('add')) { const key = value('add'); current[key].push(key === 'snippets' ? { ...emptyNestingMember(), set: SNIPPET_PREFIX + (snippetCategories(spec.catalog)[0]?.name || '') } : emptyNestingMember()); publish(); invalidateRun(); render(); return }
      if (has('remove')) { const [key, i] = value('remove').split(':'); current[key].splice(Number(i), 1); pickerFor = null; publish(); invalidateRun(); render(); return }
      for (const key of ['members', 'snippets']) for (const dir of ['up', 'down']) if (button.hasAttribute(`data-var-${dir}-${key}`)) {
        const i = Number(button.getAttribute(`data-var-${dir}-${key}`)), j = i + (dir === 'up' ? -1 : 1)
        if (j < 0 || j >= current[key].length) return
        ;[current[key][i], current[key][j]] = [current[key][j], current[key][i]]; pickerFor = null; publish(); invalidateRun(); render(); return
      }
      if (has('mark')) {
        if (!snippet) throw new Error('Choose a snippet to mark first.')
        if (current.marks.length >= 128) throw new Error('A run supports up to 128 changes.')
        let index = 1; while (current.marks.some(item => item.id === `mark-${index}`)) index++
        current.marks.push(textMark(snippet, q('text').selectionStart, q('text').selectionEnd, { id: `mark-${index}`, label: markLabel, replacement: markReplace }))
        markLabel = ''; markReplace = ''; publish(); invalidateRun(); render(); q('status').textContent = ''; return
      }
      if (has('remove-mark')) { current.marks.splice(Number(value('remove-mark')), 1); publish(); invalidateRun(); render(); return }
      if (has('generate')) { await generate(); return }
      if (has('save-run')) { await saveRun(); return }
      if (has('previous') || has('next')) { page += has('next') ? 1 : -1; renderRun(); return }
      if (has('keep-all') || has('keep-none')) { for (const row of state.review?.rows || []) row.keep = has('keep-all'); publish(); renderRun(); return }
      if (has('run-read')) {
        const row = prepared?.rows.find(item => item.index === Number(value('run-read'))); if (!row) return
        q('run-reading').textContent = `${state.review.rows.find(item => item.index === row.index).name} · ${row.arm}`; q('compare').hidden = false
        q('original').textContent = 'Compiling…'; q('run-text').textContent = ''
        const result = onPreviewRow ? await onPreviewRow(prepared, row) : null
        if (disposed || !result) return
        q('run-text').textContent = result.text
        q('original').innerHTML = result.original ? markedOriginal(result.original, result.omitted || []) : esc(result.text)
        return
      }
    } catch (error) { if (!disposed) q('status').textContent = error.message }
  })
  const normalize = form => { const next = { ...emptyVarianceRun(), ...(form || {}) }; for (const key of ['members', 'snippets']) next[key] = (Array.isArray(next[key]) ? next[key] : []).map(member => ({ ...emptyNestingMember(), ...member, selected: Array.isArray(member.selected) ? member.selected : [] })); next.parts = Array.isArray(next.parts) ? next.parts : []; next.marks = Array.isArray(next.marks) ? next.marks : []; return next }
  return { el, setContext(next) {
    ticket++; prepared = null; busy = false; spec = next.spec; routing = next.routing; active = next.active; snippetsOf.clear()
    if (context !== next.contextKey) { pickerFor = null; pickerSearch = ''; markingId = ''; snippet = null; markLabel = ''; page = 0; context = next.contextKey }
    // The older per-source studies ride along untouched; the run is ours.
    state = next.state?.studies?.length ? structuredClone(next.state) : { ...emptyVarianceState(), ...(next.state ? structuredClone(next.state) : {}) }
    if (!Array.isArray(state.studies)) state.studies = emptyVarianceState().studies
    if (!state.studies.some(item => item.id === state.active)) state.active = state.studies[0].id
    state.run = normalize(state.run); state.review = state.review && Array.isArray(state.review.rows) ? state.review : null
    if (active) render()
  }, startSource(source) {
    // A snippet or composition sent here from another step becomes the first row to vary or mark.
    const current = run()
    if (source?.kind === 'snippet') { const category = snippetCategories(spec.catalog).find(item => item.members.includes(source.id)); if (category) current.snippets.push({ set: SNIPPET_PREFIX + category.name, pick: 'some', selected: [source.id], condition: '' }); markingId = source.id }
    else if (source?.kind === 'composition') current.members.push({ set: ALL_SET, pick: 'some', selected: [source.id], condition: '' })
    publish(); if (active) render(); return structuredClone(state)
  }, setDisabled(value) { locked = value; disable() }, destroy() { disposed = true; ticket++ } }
}
