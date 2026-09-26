import { ALL_SET, NESTING_MODES, SNIPPET_PREFIX, compositionFamily, conditionalNesting, emptyNestingForm, emptyNestingMember, hasFallback, isSnippetMember, memberPool, nestingOutline, nestingRunSpace, nestingSets, snippetCategories, snippetCategoryOf } from './research-nesting.mjs'
import { createViewSwitch } from './research-view-switch.js'
import './research-nesting.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`
const num = value => Number.isSafeInteger(value) ? value.toLocaleString() : 'Too many'
const plural = (count, one, many = one + 's') => `${num(count)} ${count === 1 ? one : many}`
const text = value => String(value ?? '').trim()
const SPINE = { together: 'all at once', sequence: 'in order', 'conditional-all': 'each match applies', 'conditional-first': 'first match applies', custom: 'as instructed' }
const PICK_LIMIT = 400

/* Counts over an outline: snippets and templates are the components the
   compiler reports; a reference to a saved composition is a boundary. */
function outlineStats(root) {
  const stats = { atoms: 0, templates: 0, references: 0, depth: 0 }
  const walk = (node, depth) => {
    if (node.kind === 'composition') { stats.references++; node.children.forEach(child => walk(child, depth)); return }
    if (node.kind === 'atom') stats.atoms++; else stats.templates++
    stats.depth = Math.max(stats.depth, depth)
    node.children.forEach(child => walk(child, depth + 1))
  }
  walk(root, 0)
  stats.components = stats.atoms + stats.templates
  return stats
}

/* A nesting takes SETS. Each member row picks a saved set (or every
   composition), whole or picked from in a pop-up; the mode says how the
   members combine; the nested set is the product of the members, sampled
   with a count and a seed like a composition run, reviewed, and saved as a
   set of its own. Editing a saved v1 nesting keeps the old one-composition
   path. Visualization draws the arrangement as a chain and a composition as
   a tree; Data is the plain form and the tree editor. */
export function createNestingEditor({ onDraft, onChange = () => {}, onSave, onPreview, onTask, onVariance = () => {}, onPreviewRun = null, onSaveRun = null, onPreviewRow = null }) {
  const el = document.createElement('div'); el.className = 'nesting-editor'
  let draft = null, catalog = [], state = emptyState()
  let trail = [], context = '', locked = false, disposed = false, previewTicket = 0, prepared = null, page = 0, busy = false
  let inspectSet = ALL_SET, pickerFor = -1, pickerSearch = '', pickerOpen = new Map()
  function emptyState() { return { selected: '', form: emptyNestingForm(), authoring: false, connections: false, review: null } }
  const view = createViewSwitch({ key: 'mc.research.nesting.view', onChange: value => { el.dataset.view = value; render() } })
  el.dataset.view = view.value
  const visual = () => view.value === 'visual'
  const q = name => el.querySelector(`[data-nest-${name}]`)
  const publish = () => onDraft(structuredClone(state))
  const names = () => (draft?.compositions || []).map(item => item.name).filter(Boolean)
  const compositionOf = name => (draft?.compositions || []).find(item => item.name === name)
  const sets = () => nestingSets(draft, catalog)
  const setLabel = name => name === ALL_SET ? 'All compositions' : typeof name === 'string' && name.startsWith(SNIPPET_PREFIX) ? name.slice(SNIPPET_PREFIX.length) + ' (snippets)' : name
  const titleOf = id => { const bundle = catalog.find(item => item.id === id); return bundle ? bundle.title || bundle.id : id }
  const itemLabel = (member, id) => isSnippetMember(member) ? titleOf(id) : id
  const memberNoun = member => isSnippetMember(member) ? 'snippet' : 'composition'
  const poolOf = member => memberPool(member, draft, catalog)
  const availableOf = member => memberPool({ ...member, pick: 'all' }, draft, catalog)
  const statsOf = name => { try { return outlineStats(nestingOutline(name, draft, catalog)) } catch { return null } }
  const space = () => { try { return nestingRunSpace(state.form, draft, catalog) } catch (error) { return { total: 0, raw: 0, error: error.message } } }
  const keptRows = () => (prepared?.rows || []).filter(row => state.review?.rows.find(item => item.index === row.index)?.keep)

  function outlineMarkup(node, depth = 0) {
    const kind = `<span class="nesting-node-kind" data-kind="${esc(node.kind)}">${esc(node.kind)}</span>`
    const title = `<span class="nesting-node-slot">${esc(node.label)}</span> <span class="nesting-node-title">${esc(node.name)}</span>`
    const jump = node.kind === 'composition' ? ` <button type="button" class="nest-small" data-nest-inspect="${esc(node.name)}">Inspect</button>` : ''
    if (!node.children.length) return `<li class="nesting-leaf">${kind}<span>${title}</span></li>`
    return `<li><details data-nest-branch${depth < 3 ? ' open' : ''}><summary>${kind}${title}${jump}</summary><ul>${node.children.map(child => outlineMarkup(child, depth + 1)).join('')}</ul></details></li>`
  }
  function applyDisabled() {
    for (const tag of ['button', 'input', 'textarea', 'select']) for (const node of el.querySelectorAll(tag)) node.disabled = locked || busy
    if (!q('name')) return
    const editing = !!state.form.editing, { total, error } = space()
    q('name').readOnly = editing
    if (q('save')) q('save').disabled = locked || busy || !state.form.members.length
    if (q('generate')) q('generate').disabled = locked || busy || !state.form.members.length || !total || !!error
    if (q('save-run')) q('save-run').disabled = locked || busy || !prepared || !keptRows().length
    if (q('save-run')) q('save-run').textContent = `Save as nested set (${prepared ? keptRows().length : 0})`
    if (q('count')) q('count').disabled = locked || busy || state.form.method === 'all'
    if (q('seed')) q('seed').disabled = locked || busy || state.form.method === 'all'
    q('task').disabled = locked || busy || !names().includes(state.selected)
    q('variance').disabled = locked || busy || !names().includes(state.selected)
    for (const node of el.querySelectorAll('[data-nest-up]')) node.disabled = locked || busy || Number(node.getAttribute('data-nest-up')) === 0
    for (const node of el.querySelectorAll('[data-nest-down]')) node.disabled = locked || busy || Number(node.getAttribute('data-nest-down')) === state.form.members.length - 1
    for (const node of el.querySelectorAll('[data-nest-choose]')) node.disabled = locked || busy || state.form.members[Number(node.getAttribute('data-nest-choose'))]?.pick !== 'some'
    if (q('previous')) q('previous').disabled = locked || busy || page === 0
    if (q('next')) q('next').disabled = locked || busy || (page + 1) * 20 >= (prepared?.rows || []).length
  }
  async function showPreview() {
    const ticket = ++previewTicket
    q('preview-note').textContent = ''
    q('preview').textContent = 'Compiling the assembled prompt…'
    try {
      const result = await onPreview({ name: state.selected, form: null })
      if (disposed || ticket !== previewTicket) return
      q('preview').textContent = result.text
      q('preview-note').textContent = `${result.nodeCount} components · depth ${result.depth} · ${state.selected}`
    } catch (error) {
      if (!disposed && ticket === previewTicket) { q('preview').textContent = ''; q('preview-note').textContent = error.message }
    }
  }
  function inspect(name, push = true) {
    if (push && state.selected && state.selected !== name) trail.push(state.selected)
    state.selected = name; state.authoring = false; publish(); render()
  }

  /* ---- the members: set, scope, pick, condition ---- */
  const setOptions = (selected, withSnippets = false) => {
    const compositions = [option(ALL_SET, `All compositions (${num(names().length)})`, selected), ...sets().map(set => option(set.name, `${set.name} (${num(set.members.length)}${set.kind === 'nesting' ? ', nested' : set.kind === 'variance' ? ', variants' : ''})`, selected))].join('')
    if (!withSnippets && !(typeof selected === 'string' && selected.startsWith(SNIPPET_PREFIX))) return compositions
    const snippets = snippetCategories(catalog).map(category => option(SNIPPET_PREFIX + category.name, `${category.name} (${num(category.members.length)} snippets)`, selected)).join('')
    return `<optgroup label="Composition sets">${compositions}</optgroup><optgroup label="Snippet categories">${snippets || option('', 'No snippets in the library', '')}</optgroup>`
  }
  function memberRow(member, i, conditional) {
    const available = availableOf(member), chosen = poolOf(member), last = hasFallback(state.form) && i === state.form.members.length - 1
    const scope = `<select data-nest-scope="${i}" aria-label="Member ${i + 1}: take all or pick">${option('all', `All ${num(available.length)}`, member.pick)}${option('some', member.pick === 'some' ? `Picked ${num(chosen.length)} of ${num(available.length)}` : 'Pick…', member.pick)}</select>`
    const choose = `<button type="button" class="nest-small" data-nest-choose="${i}"${member.pick === 'some' ? '' : ' hidden'}>${pickerFor === i ? 'Done' : 'Choose…'}</button>`
    const meta = `<span class="nest-meta">${plural(chosen.length, memberNoun(member))} in this member</span>`
    const when = !conditional ? '' : last ? '<div class="nest-when"><span class="nest-keyword">otherwise</span><span class="nest-meta">applies when no condition above matched</span></div>'
      : `<div class="nest-when"><span class="nest-keyword">${i > 0 && state.form.mode === 'conditional-first' ? 'else, when' : 'when'}</span><textarea data-nest-condition="${i}" rows="2" placeholder="Describe the condition" aria-label="Member ${i + 1} condition">${esc(member.condition)}</textarea></div>`
    const tools = `<span class="nest-tools"><button type="button" class="nest-small" data-nest-up="${i}" aria-label="Move member ${i + 1} up">↑</button><button type="button" class="nest-small" data-nest-down="${i}" aria-label="Move member ${i + 1} down">↓</button><button type="button" class="nest-small nest-drop" data-nest-remove="${i}" aria-label="Remove member ${i + 1}">×</button></span>`
    return { select: `<select data-nest-member="${i}" aria-label="Member ${i + 1} set">${setOptions(member.set, !!state.form.snippets)}</select>`, scope, choose, meta, when, tools }
  }
  function chainMarkup(form, conditional) {
    const rows = form.members.map((member, i) => { const r = memberRow(member, i, conditional); return `<li class="nest-node">
        <div class="nest-node-index"><span class="nest-index">${i + 1}</span></div>
        <div class="nest-node-body">${r.when}<div class="nest-node-row">${r.select}${r.scope}${r.choose}${r.meta}${r.tools}</div>${pickerFor === i ? '<div class="nest-picker" data-nest-picker></div>' : ''}</div></li>` }).join('')
    return `<p class="nest-spine-label">${esc(SPINE[form.mode] || '')}</p>
      <ol class="nest-chain" data-nest-chain data-mode="${esc(form.mode)}">${rows || '<li class="nesting-empty">Add a member: a saved set, or every composition, taken whole or picked from.</li>'}
        <li class="nest-node nest-node-add"><div class="nest-node-index"><span class="nest-index nest-index-add">+</span></div><div class="nest-node-body"><button type="button" data-nest-add-empty>Add a member</button></div></li></ol>
      <p class="nest-caption"><b>Fig. 1</b> The arrangement — ${plural(form.members.length, 'member')}, ${esc(SPINE[form.mode] || '')}.</p>`
  }
  function membersFormMarkup(form, conditional) {
    return `<ol class="nesting-members">${form.members.map((member, i) => { const r = memberRow(member, i, conditional); return `<li><div class="nesting-member-head"><strong>Member ${i + 1}</strong>${r.tools}</div>
        <div class="nest-node-row">${r.select}${r.scope}${r.choose}${r.meta}</div>${r.when}${pickerFor === i ? '<div class="nest-picker" data-nest-picker></div>' : ''}</li>` }).join('') || '<li class="nesting-empty">Add a member: a saved set, or every composition, taken whole or picked from.</li>'}</ol>
      <button type="button" data-nest-add-empty>Add a member</button>`
  }
  const ticks = () => `<div class="nest-ticks"><label class="nest-tick"><input type="checkbox" data-nest-snippets${state.form.snippets ? ' checked' : ''}><span>Members can be snippets too</span></label>${state.form.mode === 'conditional-first' ? `<label class="nest-tick"><input type="checkbox" data-nest-fallback${state.form.fallback ? ' checked' : ''}><span>The last member is the fallback (otherwise)</span></label>` : ''}</div>`
  function possibleLine() {
    const { total, error } = space(), members = state.form.members
    if (!members.length) return ''
    const product = members.map(member => num(poolOf(member).length)).join(' × ')
    return `<p class="nest-possible" data-nest-possible>Nestings possible: ${members.length > 1 ? product + ' = ' : ''}<b>${error ? '0' : num(total)}</b>${error ? ` · ${esc(error)}` : ''}</p>`
  }

  /* ---- the nested run: review list ---- */
  function renderRun() {
    const host = q('run'); if (!host) return
    host.hidden = !prepared
    if (!prepared) return
    const rows = prepared.rows.slice(page * 20, (page + 1) * 20), kept = keptRows().length
    q('run-count').textContent = `${num(prepared.rows.length)} nested compositions ${prepared.method === 'all' ? 'generated' : 'sampled'} from ${num(prepared.total)} possible${prepared.seed !== null ? ` · seed ${prepared.seed}` : ''} · ${num(kept)} kept. Untick what you do not want, rename what you like, then save the set.`
    q('page').textContent = prepared.rows.length > 20 ? `Page ${page + 1} of ${Math.ceil(prepared.rows.length / 20)}` : ''
    q('pager').hidden = prepared.rows.length <= 20
    q('rows').innerHTML = rows.map(row => {
      const review = state.review.rows.find(item => item.index === row.index)
      return `<tr><td class="nest-keep"><input type="checkbox" data-nest-keep="${row.index}" aria-label="Keep ${esc(review.name)}"${review.keep ? ' checked' : ''}></td>
        <td><input data-nest-run-name="${row.index}" aria-label="Nested composition name" value="${esc(review.name)}" maxlength="64"></td>
        <td class="nest-members-cell">${row.members.map(member => `<div><span class="nest-part-tag">${esc(setLabel(member.set))}</span>${esc(member.snippet ? member.title : member.composition)}</div>`).join('')}</td>
        <td><button type="button" class="nest-small" data-nest-run-read="${row.index}">Read prompt</button></td></tr>`
    }).join('')
    applyDisabled()
  }
  const singleForm = (row, name) => ({ name: name || 'nesting-preview', editing: '', mode: state.form.mode, instructions: state.form.instructions, members: row.members.map((member, i) => ({ composition: member.composition, condition: state.form.members[i]?.condition || '' })) })

  /* ---- the picker: the member's items in a family tree, inline under the row ---- */
  const familyOf = (member, id) => {
    if (isSnippetMember(member)) return text(catalog.find(item => item.id === id)?.donor?.family)
    return compositionFamily(id, draft, catalog)
  }
  function pickerGroups(member) {
    const groups = new Map(), available = availableOf(member)
    const hasFamilies = available.some(id => familyOf(member, id))
    for (const id of available) {
      const family = hasFamilies ? familyOf(member, id) || 'Other' : ''
      if (!groups.has(family)) groups.set(family, [])
      groups.get(family).push(id)
    }
    if (groups.has('Other')) { const other = groups.get('Other'); groups.delete('Other'); groups.set('Other', other) }
    return { hasFamilies, groups }
  }
  function renderPicker() {
    const host = q('picker'); if (!host) return
    const member = state.form.members[pickerFor]
    if (!member) { host.innerHTML = ''; return }
    const chosen = new Set(member.selected || []), { hasFamilies, groups } = pickerGroups(member), available = availableOf(member)
    const search = pickerSearch.toLocaleLowerCase()
    const matches = id => !search || itemLabel(member, id).toLocaleLowerCase().includes(search)
    let shownTotal = 0
    const groupMarkup = [...groups].map(([family, ids]) => {
      const shown = ids.filter(matches), picked = ids.filter(id => chosen.has(id)).length
      shownTotal += shown.length
      const key = family || '(all)'
      const open = search ? true : pickerOpen.has(key) ? pickerOpen.get(key) : !hasFamilies || picked > 0
      const items = `<ul class="nest-pick-items">${shown.slice(0, PICK_LIMIT).map(id => `<li><label class="nesting-pick"><input type="checkbox" data-nest-pick="${esc(id)}"${chosen.has(id) ? ' checked' : ''}><span>${esc(itemLabel(member, id))}</span></label></li>`).join('')}${shown.length > PICK_LIMIT ? `<li class="nesting-hint">${num(shown.length - PICK_LIMIT)} more here. Narrow the search to see them, or pick all shown.</li>` : ''}</ul>`
      if (!hasFamilies) return `<div class="nest-pick-group"${shown.length ? '' : ' hidden'}>${items}</div>`
      return `<div class="nest-pick-group"${shown.length ? '' : ' hidden'}><input type="checkbox" class="nest-pick-check" data-nest-pick-group="${esc(family)}" aria-label="Pick every item in ${esc(family)}"${picked === ids.length ? ' checked' : ''}>
        <details data-nest-pick-node="${esc(key)}"${open ? ' open' : ''}><summary><span class="nest-pick-name">${esc(family)}</span><span class="nest-meta">${num(picked)} of ${num(ids.length)}</span></summary>${items}</details></div>`
    }).join('')
    host.innerHTML = `<div class="nesting-picker-tools"><span class="nest-meta" data-nest-pick-count>${num(chosen.size)} of ${num(available.length)} picked</span><label class="nest-field nest-field-search"><span class="nest-hidden">Find</span><input type="search" data-nest-pick-search value="${esc(pickerSearch)}" placeholder="Find ${isSnippetMember(member) ? 'a snippet' : 'a composition'}"></label><button type="button" class="nest-small" data-nest-pick-all>Pick all shown</button><button type="button" class="nest-small" data-nest-pick-none>Clear shown</button></div>
      <div class="nest-pick-tree">${groupMarkup}${shownTotal ? '' : '<p class="nesting-hint">Nothing matches.</p>'}</div>`
    for (const node of el.querySelectorAll('[data-nest-pick-group]')) {
      const ids = groups.get(node.getAttribute('data-nest-pick-group')) || [], picked = ids.filter(id => chosen.has(id)).length
      node.indeterminate = picked > 0 && picked < ids.length
    }
    const scope = el.querySelector(`[data-nest-scope="${pickerFor}"]`)
    if (scope) for (const item of scope.options || []) if (item.value === 'some') item.textContent = `Picked ${num(chosen.size)} of ${num(available.length)}`
    const meta = el.querySelector(`[data-nest-choose="${pickerFor}"]`)?.nextElementSibling
    if (meta && meta.classList?.contains('nest-meta')) meta.textContent = `${plural(chosen.size, memberNoun(member))} in this member`
  }
  function openPicker(i) { pickerFor = i; pickerSearch = ''; pickerOpen = new Map(); render() }
  function closePicker() { pickerFor = -1; prepared = null; state.review = null; publish(); render() }

  function render() {
    if (disposed) return
    previewTicket++
    const form = state.form, choices = names(), conditional = conditionalNesting(form.mode), diagram = visual(), editing = !!form.editing
    let outline = '', problem = '', stats = null
    if (state.selected) try { const root = nestingOutline(state.selected, draft, catalog); stats = outlineStats(root); outline = `<ul class="nesting-outline">${outlineMarkup(root)}</ul>` } catch (error) { problem = error.message }
    const instructions = `<label class="nest-instructions">Shared instructions (optional)<textarea data-nest-instructions rows="3" placeholder="Text placed word for word before the members, in every nested composition of this set."></textarea></label>`
    const inspectChoices = inspectSet === ALL_SET ? choices : (sets().find(set => set.name === inspectSet)?.members || [])
    el.innerHTML = `<div class="nesting-head"><div><h3>Nesting</h3><p class="nesting-intro">A nesting arranges compositions from saved sets inside one larger prompt. It saves the result as a nested set. Build task set can draw from it, and later nestings can use it. Below it, inspect any composition down to its snippets.</p></div><div data-nest-switch class="nesting-switch"></div></div>
      <section class="nesting-author"><div class="nesting-heading"><h4>${editing ? 'Edit nesting' : 'Build a nested set'}</h4><button type="button" class="nest-small" data-nest-new>New nesting</button></div>
        <div class="nesting-identity"><label class="nest-field nest-field-name">${editing ? 'Name' : 'Nested set name'}<input data-nest-name value="${esc(form.name)}" maxlength="64" placeholder="Nested run 1"></label>
        <label class="nest-field">How members work together<select data-nest-mode>${NESTING_MODES.map(([id, label]) => option(id, label, form.mode)).join('')}</select></label></div>
        <p class="nesting-hint">${conditional ? 'Each member is a saved set, or a snippet category. Write a condition per member; the conditions describe behavior inside the prompt and do not choose task rows.' : 'Each member is a saved set, or a snippet category, taken whole or picked from. Every nested composition takes one item from each member, in this order.'}</p>
        ${diagram ? chainMarkup(form, conditional) : membersFormMarkup(form, conditional)}
        ${ticks()}
        ${instructions}
        ${possibleLine()}
        ${editing ? `<div class="nesting-actions"><button type="button" class="bench-primary" data-nest-save>Save changes to nesting</button></div><p class="nesting-hint">Editing a saved nesting takes exactly one composition per member.</p>`
          : `<div class="nest-run-controls"><label class="nest-field">Number to generate<span class="nest-inline"><input data-nest-count type="number" min="1" max="10000" value="${esc(form.count)}"><span class="nest-meta" data-nest-of></span></span></label>
            <label class="nest-field">Which ones<select data-nest-method>${option('sample', 'A random subset', form.method)}${option('all', 'All of them', form.method)}</select></label>
            <label class="nest-field">Random seed<input data-nest-seed type="number" min="0" max="4294967295" value="${esc(form.seed)}"></label>
            <button type="button" class="bench-primary" data-nest-generate>Generate the nested set</button></div>`}
        <p data-nest-status role="status" class="nesting-hint"></p>
        <section class="nest-run" data-nest-run hidden><div class="nesting-heading"><h4>The nested set</h4></div><p class="nesting-hint" data-nest-run-count></p>
          <div class="nesting-actions"><button type="button" class="nest-small" data-nest-keep-all>Keep all</button><button type="button" class="nest-small" data-nest-keep-none>Keep none</button></div>
          <div class="nest-run-table"><table><thead><tr><th>Keep</th><th>Name</th><th>Members, by set</th><th>Review</th></tr></thead><tbody data-nest-rows></tbody></table></div>
          <div class="nesting-actions" data-nest-pager><button type="button" class="nest-small" data-nest-previous>Previous</button><span class="nest-meta" data-nest-page></span><button type="button" class="nest-small" data-nest-next>Next</button></div>
          <h5 data-nest-run-reading class="nest-reading"></h5><pre data-nest-run-text hidden tabindex="0"></pre>
          <div class="nesting-actions"><button type="button" class="bench-primary" data-nest-save-run>Save as nested set (0)</button></div></section>
      </section>
      <section class="nesting-inspector"><div class="nesting-heading"><h4>Inspect a composition</h4></div>
        <p class="nesting-hint">Trace a composition down to its snippets and read its assembled prompt. Inspect a named member to follow it; the path takes you back.</p>
        <div class="nesting-identity"><label class="nest-field">Set<select data-nest-inspect-set>${setOptions(inspectSet)}</select></label><label class="nest-field nest-field-name">Composition<select data-nest-selected>${option('', 'Choose a saved composition', state.selected)}${(inspectChoices.includes(state.selected) || !state.selected ? inspectChoices : [state.selected, ...inspectChoices]).map(name => option(name, name, state.selected)).join('')}</select></label></div>
        <nav class="nesting-breadcrumbs" aria-label="Composition path">${trail.map((name, i) => `<button type="button" class="nest-small" data-nest-back="${i}">${esc(name)}</button><span>›</span>`).join('')}<strong>${esc(state.selected)}</strong></nav>
        <div class="nesting-actions nesting-outline-tools"><button type="button" class="nest-small" data-nest-expand>Expand all</button><button type="button" class="nest-small" data-nest-collapse>Immediate members</button>${stats ? `<span class="nest-meta nest-stats">${plural(stats.atoms, 'snippet')} · ${plural(stats.templates, 'template')} · ${plural(stats.references, 'nested composition')} · depth ${stats.depth}</span>` : ''}</div><p data-nest-outline-note class="nesting-hint">${esc(problem)}</p>
        <div class="nesting-inspection-grid"><div>${outline || '<p class="nesting-hint">Choose a composition above.</p>'}</div><div><h5>Assembled prompt</h5><p data-nest-preview-note role="status"></p><pre data-nest-preview tabindex="0"></pre></div></div>
        <div class="nesting-actions"><button type="button" data-nest-task>Add this composition as a task</button><button type="button" data-nest-variance>Create variance</button></div><p class="nesting-hint">Adds one task without replacing the tasks already in this project. Execution and grading still use the experiment’s declared setup.</p>
      </section>`

    q('switch').append(view.el)
    q('instructions').value = form.instructions
    q('mode').value = form.mode; q('selected').value = state.selected
    if (q('method')) q('method').value = form.method
    form.members.forEach((member, i) => {
      el.querySelector(`[data-nest-member="${i}"]`).value = member.set
      el.querySelector(`[data-nest-scope="${i}"]`).value = member.pick
      const condition = el.querySelector(`[data-nest-condition="${i}"]`)
      if (condition) condition.value = member.condition
    })
    const { total, error } = space()
    if (q('of')) q('of').textContent = total && !error ? `of ${num(total)} possible` : ''
    renderPicker(); renderRun(); applyDisabled()
    if (state.selected && choices.includes(state.selected)) showPreview()
  }
  el.addEventListener('input', event => {
    event.stopPropagation(); if (locked || busy) return
    const target = event.target
    if (target.hasAttribute('data-nest-pick-search')) { pickerSearch = target.value; const keep = pickerSearch; renderPicker(); const box = q('pick-search'); if (box) { box.value = keep; box.focus?.() } return }
    if (target.hasAttribute('data-nest-run-name')) { const row = state.review?.rows.find(item => item.index === Number(target.getAttribute('data-nest-run-name'))); if (row) { row.name = target.value; publish() } return }
    if (target.hasAttribute('data-nest-name')) state.form.name = target.value
    else if (target.hasAttribute('data-nest-instructions')) state.form.instructions = target.value
    else if (target.hasAttribute('data-nest-condition')) state.form.members[Number(target.getAttribute('data-nest-condition'))].condition = target.value
    else if (target.hasAttribute('data-nest-count')) state.form.count = target.value
    else if (target.hasAttribute('data-nest-seed')) state.form.seed = target.value
    else return
    if (prepared) { prepared = null; state.review = null; renderRun(); q('status').textContent = 'The nesting changed. Generate the nested set again to review it.' }
    publish()
  })
  el.addEventListener('change', event => {
    event.stopPropagation(); if (locked || busy) return
    const target = event.target
    if (target.hasAttribute('data-nest-pick') || target.hasAttribute('data-nest-pick-group')) {
      const member = state.form.members[pickerFor]; if (!member) return
      const chosen = new Set(member.selected || [])
      if (target.hasAttribute('data-nest-pick')) { const name = target.getAttribute('data-nest-pick'); if (target.checked) chosen.add(name); else chosen.delete(name) }
      else for (const id of pickerGroups(member).groups.get(target.getAttribute('data-nest-pick-group')) || []) { if (target.checked) chosen.add(id); else chosen.delete(id) }
      member.selected = availableOf(member).filter(item => chosen.has(item))
      prepared = null; state.review = null; publish(); renderPicker(); renderRun(); applyDisabled()
      return
    }
    if (target.hasAttribute('data-nest-keep')) { const row = state.review?.rows.find(item => item.index === Number(target.getAttribute('data-nest-keep'))); if (row) { row.keep = target.checked; publish(); renderRun() } return }
    if (target.hasAttribute('data-nest-inspect-set')) { inspectSet = target.value; render(); return }
    if (target.hasAttribute('data-nest-snippets')) { state.form.snippets = target.checked; prepared = null; state.review = null; publish(); render(); return }
    if (target.hasAttribute('data-nest-fallback')) { state.form.fallback = target.checked; prepared = null; state.review = null; publish(); render(); return }
    if (target.hasAttribute('data-nest-selected')) { trail = []; inspect(target.value, false); return }
    if (target.hasAttribute('data-nest-mode')) state.form.mode = target.value
    else if (target.hasAttribute('data-nest-method')) state.form.method = target.value
    else if (target.hasAttribute('data-nest-member')) { const member = state.form.members[Number(target.getAttribute('data-nest-member'))]; member.set = target.value; member.selected = [] }
    else if (target.hasAttribute('data-nest-scope')) { const i = Number(target.getAttribute('data-nest-scope')), member = state.form.members[i]; member.pick = target.value; prepared = null; state.review = null; if (member.pick === 'some') { publish(); openPicker(i); return } if (pickerFor === i) pickerFor = -1 }
    else return
    prepared = null; state.review = null
    publish(); render()
  })
  async function generate() {
    if (!onPreviewRun) { q('status').textContent = 'Nested runs are not available here.'; return }
    if (!text(state.form.name)) { let i = 1; const taken = new Set([...sets().map(set => set.name), ...names()]); while (taken.has(`Nested run ${i}`)) i++; state.form.name = `Nested run ${i}`; q('name').value = state.form.name }
    const ticket = ++previewTicket
    busy = true; applyDisabled(); q('status').textContent = 'Generating the nested set…'
    try {
      const result = await onPreviewRun(structuredClone(state.form))
      if (disposed || ticket !== previewTicket) return
      prepared = result; page = 0
      if (state.review?.fingerprint !== result.fingerprint) state.review = { fingerprint: result.fingerprint, rows: result.rows.map(row => ({ index: row.index, name: row.name, keep: true })) }
      q('status').textContent = ''
      publish(); renderRun()
    } catch (error) { if (!disposed) q('status').textContent = error.message }
    finally { if (!disposed) { busy = false; applyDisabled() } }
  }
  async function saveRun() {
    if (!onSaveRun || !prepared) return
    const selections = keptRows().map(row => ({ index: row.index, name: state.review.rows.find(item => item.index === row.index).name }))
    busy = true; applyDisabled(); q('status').textContent = 'Saving the nested set…'
    try {
      const result = await onSaveRun(prepared, selections)
      if (disposed) return
      if (!result?.ok) throw new Error(result?.error || 'The nested set could not be saved.')
      prepared = null; state.review = null; state.form.name = ''
      publish(); render()
      q('status').textContent = `Nested set ${result.name} saved: ${plural(result.count, 'composition')}. It is a set like any other: nest it again, route rows to it, or select it in the task set.`
    } catch (error) { if (!disposed) q('status').textContent = error.message }
    finally { if (!disposed) { busy = false; applyDisabled() } }
  }
  el.addEventListener('click', async event => {
    const button = event.target.closest('button')
    event.stopPropagation()
    if (!button || locked || busy) return
    const has = name => button.hasAttribute(`data-nest-${name}`), value = name => button.getAttribute(`data-nest-${name}`)
    if (has('pick-done')) { closePicker(); return }
    if (has('pick-all') || has('pick-none')) {
      const member = state.form.members[pickerFor]; if (!member) return
      const shown = new Set([...el.querySelectorAll('[data-nest-pick]')].map(node => node.getAttribute('data-nest-pick')))
      const chosen = new Set(member.selected || [])
      for (const name of shown) { if (has('pick-all')) chosen.add(name); else chosen.delete(name) }
      member.selected = availableOf(member).filter(item => chosen.has(item)); prepared = null; state.review = null; publish(); renderPicker(); renderRun(); applyDisabled(); return
    }
    if (has('choose')) { if (pickerFor === Number(value('choose'))) closePicker(); else openPicker(Number(value('choose'))); return }
    if (has('inspect')) { inspect(value('inspect')); return }
    if (has('variance')) { onVariance(state.selected); return }
    if (has('back')) { const i = Number(value('back')), name = trail[i]; trail = trail.slice(0, i); inspect(name, false); return }
    if (has('expand') || has('collapse')) { el.querySelectorAll('[data-nest-branch]').forEach((node, i) => { node.open = has('expand') || i === 0 }); return }
    if (has('generate')) { await generate(); return }
    if (has('save-run')) { await saveRun(); return }
    if (has('previous') || has('next')) { page += has('next') ? 1 : -1; renderRun(); return }
    if (has('keep-all') || has('keep-none')) { for (const row of state.review?.rows || []) row.keep = has('keep-all'); publish(); renderRun(); return }
    if (has('run-read')) {
      const row = prepared?.rows.find(item => item.index === Number(value('run-read'))); if (!row) return
      q('run-reading').textContent = state.review.rows.find(item => item.index === row.index).name; q('run-text').textContent = 'Compiling…'; q('run-text').hidden = false
      try { const result = onPreviewRow ? await onPreviewRow(prepared, row) : await onPreview({ name: '', form: singleForm(row) }); if (!disposed) q('run-text').textContent = result.text } catch (error) { if (!disposed) q('run-text').textContent = error.message }
      return
    }
    if (has('save') || has('task')) {
      let result
      if (has('save')) {
        const members = state.form.members.map(member => ({ composition: poolOf(member)[0] || '', condition: member.condition }))
        if (state.form.members.some(member => poolOf(member).length !== 1 || isSnippetMember(member))) { q('status').textContent = 'Editing a saved nesting takes exactly one composition per member. Pick one in each member.'; return }
        result = await onSave({ name: state.form.name, editing: state.form.editing, mode: state.form.mode, instructions: state.form.instructions, members })
      } else result = await onTask(state.selected)
      if (disposed) return
      if (result?.ok && has('save')) { state.selected = result.name; state.form = emptyNestingForm(); state.authoring = false; state.connections = false; trail = []; publish(); render() }
      q('status').textContent = result?.ok ? (has('save') ? 'Nesting saved. Save the project draft to keep it in your account, or download a copy.' : 'Task added. It is listed under Tasks below.') : result?.error || 'The action could not finish.'
      return
    }
    if (has('new')) { state.form = emptyNestingForm(); state.authoring = true; prepared = null; state.review = null }
    else if (has('add-empty')) { state.form.members.push(emptyNestingMember()); state.authoring = true; prepared = null; state.review = null }
    else if (has('remove')) { state.form.members.splice(Number(value('remove')), 1); prepared = null; state.review = null }
    else if (has('up') || has('down')) {
      const i = Number(value(has('up') ? 'up' : 'down')), j = i + (has('up') ? -1 : 1)
      if (j < 0 || j >= state.form.members.length) return
      ;[state.form.members[i], state.form.members[j]] = [state.form.members[j], state.form.members[i]]
      prepared = null; state.review = null
    } else return
    publish(); render()
  })
  el.addEventListener('toggle', event => {
    const node = event.target
    if (node && typeof node.hasAttribute === 'function' && node.hasAttribute('data-nest-pick-node') && !pickerSearch) pickerOpen.set(node.getAttribute('data-nest-pick-node'), !!node.open)
  }, true)
  // Old drafts kept members as single compositions; they become picked-from-all.
  const normalize = form => {
    const next = { ...emptyNestingForm(), ...form, snippets: !!form?.snippets, fallback: !!form?.fallback }
    if (next.mode === 'custom') next.mode = 'together'
    next.members = (Array.isArray(form?.members) ? form.members : []).map(member => member && typeof member.set === 'string'
      ? { ...emptyNestingMember(), ...member, selected: Array.isArray(member.selected) ? member.selected : [] }
      : { set: ALL_SET, pick: 'some', selected: member?.composition ? [member.composition] : [], condition: String(member?.condition || '') })
    return next
  }
  return { el, setContext(next) {
    if (disposed) return
    if (context !== next.contextKey) { trail = []; context = next.contextKey; prepared = null; page = 0; inspectSet = ALL_SET; pickerFor = -1 }
    draft = next.draft; catalog = next.catalog
    state = next.state && next.state.form && Array.isArray(next.state.form.members) ? { ...emptyState(), ...structuredClone(next.state), form: normalize(next.state.form) } : emptyState()
    if (!names().includes(state.selected)) state.selected = names()[0] || ''
    if (!sets().some(set => set.name === inspectSet)) inspectSet = ALL_SET
    render()
  }, setDisabled(value) { locked = value; applyDisabled() }, destroy() { disposed = true; previewTicket++ } }
}
