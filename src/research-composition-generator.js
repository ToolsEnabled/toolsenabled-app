import { canonical } from './benchmark/prompts.mjs'
import { compositionCombinationCount, compositionGenerationBinding, compositionGenerationSpace, compositionSnippets, emptyCompositionGeneration } from './research-composition-generator.mjs'
import { nestingSets } from './research-nesting.mjs'
import './research-composition-generator.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (id, name, selected) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(name)}</option>`
const num = value => Number.isSafeInteger(value) ? value.toLocaleString() : 'Too many'
const plural = (count, one, many = one + 's') => `${num(count)} ${count === 1 ? one : many}`
const text = value => String(value ?? '').trim()
const UNLABELLED = 'Unlabelled'
const OTHER_FAMILY = 'Other'
const SEPARATORS = { paragraph: '\n\n', line: '\n', space: ' ' }

/* ONE FORM. A composition is the minimum viable prompt: one snippet from
   every part, where every category in the snippet library is a part.
   1 select snippets in a family → category → snippet tree; 2 the distribution
   of that selection, as numbers; 3 generate the run (a seeded sample of the
   pool); 4 handcraft single compositions into the run, before or after
   generating; 5 the distribution among what the run holds; 6 the run's list,
   kept and named, saved as one SET. A set is what Nesting picks up: every
   composition saved from one run carries the run's name on its wrapper
   (compositionGeneration.set), so the set is readable from the catalog with
   no new model. The parts the model needs are derived from the selection. */
export function createCompositionGenerator({ onDraft, onPreview, onSave }) {
  const el = document.createElement('section'); el.className = 'composition-generator'
  let state = emptyState(), catalog = [], routing = null, context = '', binding = '', prepared = null, page = 0
  let locked = false, busy = false, disposed = false, revision = 0
  let search = '', nodeState = new Map(), handPicks = {}, handName = ''
  function emptyState() { const empty = emptyCompositionGeneration(); empty.handcrafted = []; return empty }
  const q = name => el.querySelector(`[data-cg-${name}]`)
  const publish = () => onDraft(structuredClone(state))
  const bundleOf = id => catalog.find(item => item.id === id)
  const titleOf = id => { const bundle = bundleOf(id); return bundle ? bundle.title || bundle.id : id }
  const pool = () => { try { return compositionGenerationSpace(state.form) } catch (error) { return { total: 0, raw: compositionCombinationCount(state.form), error: error.message } } }
  const familyOf = bundle => text(bundle.donor?.family)
  const categoriesOf = bundle => { const list = (bundle.labels || []).map(text).filter(Boolean); return list.length ? [...new Set(list)] : [UNLABELLED] }
  const partFor = label => state.form.parts.find(part => part.label === label)
  const isPicked = (label, id) => !!partFor(label)?.snippets.includes(id)
  const pickedIds = () => new Set(state.form.parts.flatMap(part => part.snippets))
  const libraryCategories = () => [...new Set(compositionSnippets(catalog).flatMap(categoriesOf))]
  const snippetsIn = label => compositionSnippets(catalog).filter(bundle => categoriesOf(bundle).includes(label))
  // Every category in the library is a required part: a composition is only
  // complete with one snippet from each.
  const missingParts = () => libraryCategories().filter(label => !partFor(label)?.snippets.length)
  const partOrder = () => [...state.form.parts.map(part => part.label), ...libraryCategories().filter(label => !partFor(label))]
  const canSample = () => pool().total > 0 && !missingParts().length
  // The run: sampled rows kept in review, and handcrafted entries marked in.
  const sampledRows = () => prepared?.rows || []
  const keptSampled = () => sampledRows().filter(row => !row.error && state.review?.rows.find(item => item.index === row.index)?.keep)
  const inRun = () => state.handcrafted.filter(entry => entry.include)
  const keptHand = () => inRun().filter(entry => entry.keep !== false && !handProblem(entry))
  const hasRun = () => !!prepared || inRun().length > 0
  // Sets already saved: read from the catalog, where every generated wrapper
  // carries its run's name.
  // Sets already saved, read from the catalog and the routing draft by the
  // shared model: composition runs, nested runs and variant runs alike.
  function savedSets() {
    return nestingSets(routing, catalog).map(set => {
      const seeds = new Set()
      for (const bundle of catalog) { const generation = bundle.nestingGeneration || bundle.compositionGeneration; const name = bundle.nestingGeneration ? bundle.nestingGeneration.name : bundle.compositionGeneration?.set; if (name === set.name && generation?.method === 'sample' && generation.count !== '1') seeds.add(String(generation.seed)) }
      return { ...set, seeds, nested: set.kind === 'nesting', variants: set.kind === 'variance' }
    })
  }

  const nextRunName = () => { const taken = new Set(savedSets().map(set => set.name)); let i = taken.size + 1; while (taken.has(`Run ${i}`)) i++; return `Run ${i}` }
  function tree() {
    const snippets = compositionSnippets(catalog)
    const hasFamilies = snippets.some(familyOf)
    const families = new Map()
    for (const bundle of snippets) {
      const family = hasFamilies ? familyOf(bundle) || OTHER_FAMILY : ''
      if (!families.has(family)) families.set(family, new Map())
      for (const category of categoriesOf(bundle)) {
        const categories = families.get(family)
        if (!categories.has(category)) categories.set(category, [])
        categories.get(category).push(bundle)
      }
    }
    return { hasFamilies, families }
  }
  const invalidate = () => {
    revision++; prepared = null; state.review = null; page = 0
    q('status').textContent = ''
    counts(); renderRun(); controls(); publish()
  }
  function counts() {
    const { total, raw, error } = pool(), restricted = state.form.compatibility.mode === 'groups', missing = missingParts()
    const library = plural(compositionSnippets(catalog).length, 'snippet')
    q('count').textContent = error || (missing.length
      ? `${library} in the library · nothing to sample yet: ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no snippet selected`
      : `${library} in the library · ${num(total)} ${restricted ? 'compatible' : 'possible'} compositions from this selection${restricted ? ' · ' + num(raw - total) + ' excluded by compatibility' : ''} · ${plural(savedSets().length, 'saved set')} in this project`)
    q('of').textContent = canSample() ? `of ${num(total)} possible` : ''
    q('requested').disabled = locked || busy || state.form.method === 'all'
    q('seed').disabled = locked || busy || state.form.method === 'all'
  }
  function controls() {
    for (const node of el.querySelectorAll('button, input, select, textarea')) node.disabled = locked || busy
    q('generate').disabled = locked || busy || !canSample()
    const keepable = keptSampled().length + keptHand().length
    q('save').disabled = locked || busy || !hasRun() || !keepable
    q('save').textContent = `Save this set (${keepable})`
    for (const node of el.querySelectorAll('[data-cg-keep]')) node.disabled ||= !!sampledRows().find(row => row.index === Number(node.dataset.cgKeep))?.error
    for (const node of el.querySelectorAll('[data-cg-up]')) node.disabled ||= Number(node.dataset.cgUp) === 0
    for (const node of el.querySelectorAll('[data-cg-down]')) node.disabled ||= Number(node.dataset.cgDown) === state.form.parts.length - 1
    q('previous').disabled ||= page === 0
    q('next').disabled ||= (page + 1) * 20 >= sampledRows().length
    const add = q('hand-add')
    if (add) add.disabled = locked || busy || !libraryCategories().length
    counts()
  }

  /* ---- 1. the selector ---- */
  const matches = bundle => !search || [bundle.title, bundle.text, bundle.id].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase())
  function renderTree() {
    const { hasFamilies, families } = tree()
    const wasOpen = (key, fallback) => search ? true : nodeState.has(key) ? nodeState.get(key) : fallback
    let markup = ''
    for (const [family, categories] of families) {
      const familyKey = 'f:' + family
      let familyMarkup = '', familyAll = 0, familySelected = 0, familyShown = 0
      for (const [category, bundles] of categories) {
        const picked = bundles.filter(bundle => isPicked(category, bundle.id)).length
        const shown = bundles.filter(matches)
        familyAll += bundles.length; familySelected += picked; familyShown += shown.length
        const key = 'c:' + family + '|' + category
        familyMarkup += `<div class="cg-node cg-node-category"${shown.length ? '' : ' hidden'}><input type="checkbox" class="cg-node-check" data-cg-pick-category="${esc(category)}" data-family="${esc(family)}" aria-label="Select every ${esc(category)} snippet${family ? ' in ' + esc(family) : ''}"${picked === bundles.length ? ' checked' : ''}>
          <details data-cg-node="${esc(key)}"${wasOpen(key, false) ? ' open' : ''}><summary><span class="cg-node-name">${esc(category)}</span><span class="cg-node-count">${num(picked)} of ${num(bundles.length)}</span></summary>
          <ul class="cg-snippets">${bundles.map(bundle => `<li${matches(bundle) ? '' : ' hidden'}><label class="cg-snippet"><input type="checkbox" data-cg-pick="${esc(category)}" value="${esc(bundle.id)}"${isPicked(category, bundle.id) ? ' checked' : ''}><span>${esc(bundle.title || bundle.id)}</span></label></li>`).join('')}</ul></details></div>`
      }
      if (!hasFamilies) { markup += familyMarkup; continue }
      markup += `<div class="cg-node cg-node-family"${familyShown ? '' : ' hidden'}><input type="checkbox" class="cg-node-check" data-cg-pick-family="${esc(family)}" aria-label="Select every snippet in ${esc(family)}"${familySelected === familyAll ? ' checked' : ''}>
        <details data-cg-node="${esc(familyKey)}"${wasOpen(familyKey, true) ? ' open' : ''}><summary><span class="cg-node-name">${esc(family)}</span><span class="cg-node-count">${num(familySelected)} of ${num(familyAll)}</span></summary>${familyMarkup}</details></div>`
    }
    q('tree').innerHTML = markup || '<p class="cg-note">No snippets yet. Create or import snippets in Snippets first.</p>'
    for (const node of el.querySelectorAll('[data-cg-pick-category]')) {
      const bundles = families.get(node.dataset.family || '')?.get(node.dataset.cgPickCategory) || []
      const picked = bundles.filter(bundle => isPicked(node.dataset.cgPickCategory, bundle.id)).length
      node.indeterminate = picked > 0 && picked < bundles.length
    }
    for (const node of el.querySelectorAll('[data-cg-pick-family]')) {
      const categories = families.get(node.dataset.cgPickFamily) || new Map()
      let all = 0, picked = 0
      for (const [category, bundles] of categories) { all += bundles.length; picked += bundles.filter(bundle => isPicked(category, bundle.id)).length }
      node.indeterminate = picked > 0 && picked < all
    }
  }
  function pick(label, id, on) {
    let part = partFor(label)
    if (on) {
      if (!part) { part = { label, snippets: [] }; state.form.parts.push(part) }
      if (!part.snippets.includes(id)) part.snippets.push(id)
    } else if (part) {
      part.snippets = part.snippets.filter(item => item !== id)
      if (!part.snippets.length) state.form.parts.splice(state.form.parts.indexOf(part), 1)
    }
  }

  /* ---- 2. the distribution within the selection ---- */
  const distributionTable = (rows, foot) => `<div class="cg-metrics-scroll"><table class="cg-metrics"><thead><tr><th>Part (category)</th>${rows.head}</tr></thead><tbody>${rows.body}</tbody><tfoot><tr>${foot}</tr></tfoot></table></div>`
  function renderMetrics() {
    const host = q('metrics'), parts = state.form.parts, { total, raw, error } = pool(), restricted = state.form.compatibility.mode === 'groups'
    const { hasFamilies, families } = tree(), snippets = compositionSnippets(catalog)
    const chosen = parts.reduce((sum, part) => sum + part.snippets.length, 0)
    const missing = missingParts()
    if (!parts.length && !libraryCategories().length) { host.innerHTML = '<p class="cg-note">No snippets in the library yet.</p>'; return }
    const body = parts.map((part, i) => { const n = snippetsIn(part.label).length; return `<tr><td><span class="cg-index">${i + 1}</span>${esc(part.label || 'Part ' + (i + 1))}</td><td class="cg-n">${num(part.snippets.length)}</td><td class="cg-n">${n ? num(n) : '—'}</td><td class="cg-n">${chosen ? Math.round(100 * part.snippets.length / chosen) : 0}%</td><td class="cg-order"><button type="button" class="cg-small" data-cg-up="${i}" aria-label="Move ${esc(part.label)} earlier">↑</button><button type="button" class="cg-small" data-cg-down="${i}" aria-label="Move ${esc(part.label)} later">↓</button></td></tr>` }).join('')
      + missing.map(label => `<tr class="cg-missing"><td><span class="cg-index">·</span>${esc(label)}</td><td class="cg-n">0</td><td class="cg-n">${num(snippetsIn(label).length)}</td><td class="cg-n">—</td><td class="cg-order">needed</td></tr>`).join('')
    const product = parts.map(part => num(part.snippets.length)).join(' × ')
    const families_ = hasFamilies ? [...families].map(([family, categories]) => { const ids = new Set([...categories.values()].flat().map(bundle => bundle.id)); const picked = [...pickedIds()].filter(id => ids.has(id)).length; return `${esc(family)} ${num(picked)} of ${num(ids.size)}` }).join(' · ') : ''
    host.innerHTML = `<p class="cg-note">Every composition takes one snippet from each part below, in this order. ${plural(libraryCategories().length, 'part')} in the library.</p>
      ${distributionTable({ head: '<th class="cg-n">Selected</th><th class="cg-n">In library</th><th class="cg-n">Share of selection</th><th>Order</th>', body }, `<td>Total</td><td class="cg-n">${num(chosen)}</td><td class="cg-n">${num(snippets.length)}</td><td class="cg-n">${chosen ? '100%' : '—'}</td><td></td>`)}
      ${missing.length ? `<p class="cg-problem cg-missing-note">Not yet a complete composition: ${missing.map(esc).join(', ')} ${missing.length === 1 ? 'has' : 'have'} nothing selected. Select at least one snippet there.</p>` : ''}
      <p class="cg-combos">Compositions possible: ${parts.length > 1 ? product + ' = ' : ''}<b>${error || missing.length ? '0' : num(total)}</b>${restricted && !missing.length ? ` compatible · ${num(Math.max(0, raw - total))} excluded by compatibility groups` : ''}${error ? ` · ${esc(error)}` : ''}</p>
      ${families_ ? `<p class="cg-families">By family: ${families_}</p>` : ''}`
  }

  /* ---- 4. handcrafted compositions: one snippet per part, by hand ---- */
  function handMembers(entry) { return partOrder().map(label => ({ label, id: entry.picks[label], title: entry.picks[label] ? titleOf(entry.picks[label]) : '' })) }
  function handProblem(entry) {
    const missing = partOrder().filter(label => !entry.picks[label])
    if (missing.length) return `no snippet for ${missing.join(', ')}`
    const gone = Object.values(entry.picks).filter(id => !bundleOf(id))
    return gone.length ? `${plural(gone.length, 'snippet')} no longer in the library` : ''
  }
  const handText = entry => (state.form.instructions ? state.form.instructions + '\n\n' : '') + partOrder().map(label => bundleOf(entry.picks[label])?.text ?? '').join(SEPARATORS[state.form.separator] || '\n\n')
  const handForm = entry => ({ ...state.form, prefix: entry.name, method: 'all', count: '1', compatibility: { mode: 'all', groups: [] }, parts: partOrder().map(label => ({ label, snippets: [entry.picks[label]] })) })
  const nameTaken = name => state.handcrafted.some(entry => entry.name === name) || (routing?.compositions || []).some(item => item.name === name)
  const nextHandName = () => { let i = 1; while (nameTaken(`Handcrafted ${i}`)) i++; return `Handcrafted ${i}` }
  function renderHand() {
    const order = partOrder()
    q('hand-form').innerHTML = order.length ? order.map(label => `<label class="cg-field cg-hand-part">${esc(label)}<select data-cg-hand="${esc(label)}">${option('', 'Choose a snippet', handPicks[label] || '')}${snippetsIn(label).map(bundle => option(bundle.id, bundle.title || bundle.id, handPicks[label] || '')).join('')}</select></label>`).join('')
      + `<label class="cg-field cg-hand-name">Name<input data-cg-hand-name value="${esc(handName)}" maxlength="64" placeholder="${esc(nextHandName())}"></label><button type="button" data-cg-hand-add>Add to the run</button>`
      : '<p class="cg-note">No snippets in the library yet.</p>'
    q('hand-list').innerHTML = state.handcrafted.length ? `<div class="cg-review-table"><table><thead><tr><th>In run</th><th>Name</th><th>Snippets, by part</th><th></th></tr></thead><tbody>${state.handcrafted.map((entry, i) => {
      const problem = handProblem(entry)
      return `<tr><td class="cg-keep"><input type="checkbox" data-cg-hand-include="${i}" aria-label="Include ${esc(entry.name)} in the run"${entry.include ? ' checked' : ''}${problem ? ' disabled' : ''}></td><td class="cg-saved-name">${esc(entry.name)}</td><td class="cg-members">${handMembers(entry).map(member => `<div><span class="cg-part-tag">${esc(member.label)}</span>${member.title ? esc(member.title) : '<span class="cg-note">none</span>'}</div>`).join('')}${problem ? `<p class="cg-problem">${esc(problem)}</p>` : ''}</td><td><button type="button" class="cg-small" data-cg-hand-remove="${i}">Remove</button></td></tr>`
    }).join('')}</tbody></table></div>` : ''
  }

  /* ---- 5 and 6. the run: its distribution, its list ---- */
  function runUsage() {
    const usage = new Map(partOrder().map(label => [label, new Map()]))
    const bump = (label, id) => { const counts = usage.get(label); if (counts && id) counts.set(id, (counts.get(id) || 0) + 1) }
    for (const row of keptSampled()) row.members.forEach((member, i) => bump(state.form.parts[i]?.label, member.id))
    for (const entry of keptHand()) for (const label of partOrder()) bump(label, entry.picks[label])
    return usage
  }
  function renderRun() {
    const show = hasRun()
    q('run-dist').hidden = !show; q('review').hidden = !show
    if (!show) return
    const sampled = keptSampled(), hand = keptHand(), usage = runUsage(), n = sampled.length + hand.length
    const used = label => usage.get(label)?.size || 0, totalUsed = partOrder().reduce((sum, label) => sum + used(label), 0)
    const body = partOrder().map((label, i) => `<tr><td><span class="cg-index">${i + 1}</span>${esc(label)}</td><td class="cg-n">${num(used(label))}</td><td class="cg-n">${num(partFor(label)?.snippets.length || 0)}</td><td class="cg-n">${num(snippetsIn(label).length)}</td><td class="cg-n">${totalUsed ? Math.round(100 * used(label) / totalUsed) : 0}%</td></tr>`).join('')
    const frequency = partOrder().map(label => { const counts = [...(usage.get(label) || new Map())].sort((a, b) => b[1] - a[1]); return counts.length ? `<table class="cg-metrics cg-metrics-small"><caption>${esc(label)}</caption><thead><tr><th>Snippet</th><th class="cg-n">In run</th></tr></thead><tbody>${counts.map(([id, count]) => `<tr><td>${esc(titleOf(id))}</td><td class="cg-n">${num(count)}</td></tr>`).join('')}</tbody></table>` : '' }).join('')
    q('run-metrics').innerHTML = `<p class="cg-note">Compositions in this run: <b>${num(n)}</b> · ${plural(sampled.length, 'sampled')}${prepared && sampledRows().length !== sampled.length ? ` (${num(sampledRows().length - sampled.length)} not kept)` : ''}, ${plural(hand.length, 'handcrafted')}.</p>
      ${n ? distributionTable({ head: '<th class="cg-n">Used in run</th><th class="cg-n">Selected</th><th class="cg-n">In library</th><th class="cg-n">Share of run</th>', body }, `<td>Total</td><td class="cg-n">${num(totalUsed)}</td><td class="cg-n">${num(state.form.parts.reduce((sum, part) => sum + part.snippets.length, 0))}</td><td class="cg-n">${num(compositionSnippets(catalog).length)}</td><td class="cg-n">${totalUsed ? '100%' : '—'}</td>`)
        + `<details class="cg-frequency"><summary>How often each snippet appears in the run</summary><div class="cg-frequency-grid">${frequency}</div></details>` : '<p class="cg-note">Nothing kept yet. Tick compositions in the list below.</p>'}`
    // 6. the list
    const rows = sampledRows().slice(page * 20, (page + 1) * 20)
    q('review-count').textContent = `${sampledRows().length ? `${num(sampledRows().length)} sampled from ${num(prepared.total)} possible${sampledRows().some(row => row.error) ? ` (${num(sampledRows().filter(row => row.error).length)} could not compile)` : ''}. ` : ''}${inRun().length ? `${plural(inRun().length, 'handcrafted composition')} in the run. ` : ''}Untick what you do not want, rename what you like, then save the set.`
    q('page').textContent = sampledRows().length > 20 ? `Page ${page + 1} of ${Math.ceil(sampledRows().length / 20)}` : ''
    q('pager').hidden = sampledRows().length <= 20
    const handRows = page === 0 ? inRun().map(entry => { const i = state.handcrafted.indexOf(entry), problem = handProblem(entry); return `<tr class="cg-hand-row"><td class="cg-keep"><input type="checkbox" data-cg-keep-hand="${i}" aria-label="Keep ${esc(entry.name)}"${entry.keep === false ? '' : ' checked'}${problem ? ' disabled' : ''}></td>
        <td><span class="cg-saved-name">${esc(entry.name)}</span><span class="cg-tag">handcrafted</span></td>
        <td class="cg-members">${handMembers(entry).map(member => `<div><span class="cg-part-tag">${esc(member.label)}</span>${esc(member.title)}</div>`).join('')}${problem ? `<p class="cg-problem">${esc(problem)}</p>` : ''}</td><td><button type="button" class="cg-small" data-cg-read-hand="${i}">Read prompt</button></td></tr>` }).join('') : ''
    q('rows').innerHTML = handRows + rows.map(row => {
      const review = state.review.rows.find(item => item.index === row.index)
      return `<tr><td class="cg-keep"><input type="checkbox" data-cg-keep="${row.index}" aria-label="Keep ${esc(review.name)}"${review.keep ? ' checked' : ''}${row.error ? ' disabled' : ''}></td>
        <td><input data-cg-name="${row.index}" aria-label="Composition name" value="${esc(review.name)}" maxlength="64"></td>
        <td class="cg-members">${row.members.map(member => `<div><span class="cg-part-tag">${esc(member.part)}</span>${esc(member.title)}</div>`).join('')}${row.error ? `<p class="cg-problem">${esc(row.error)}</p>` : ''}</td><td><button type="button" class="cg-small" data-cg-read="${row.index}">Read prompt</button></td></tr>`
    }).join('')
    q('set-name').textContent = text(state.form.set) || nextRunName()
  }
  function readingOf(name, value) { q('reading').textContent = name; q('prompt').textContent = value; q('prompt').hidden = false; q('prompt').focus() }
  function renderSets() {
    const sets = savedSets()
    q('sets').innerHTML = sets.length ? `<details class="cg-sets"><summary>${plural(sets.length, 'saved set')} in this project</summary><div class="cg-review-table"><table><thead><tr><th>Set</th><th>Compositions</th><th>Members</th></tr></thead><tbody>${[...sets].reverse().map(set => `<tr><td class="cg-saved-name">${esc(set.name)}</td><td class="cg-n">${num(set.members.length)}</td><td class="cg-members"><details class="cg-saved-members"><summary>${set.variants ? 'variants' : set.nested ? 'nested' : set.seeds.size ? `sampled with seed ${[...set.seeds].map(esc).join(', ')}` : 'handcrafted'} · show names</summary>${set.members.map(name => `<div>${esc(name)}</div>`).join('')}</details></td></tr>`).join('')}</tbody></table></div></details>` : ''
  }

  function renderAll() { renderTree(); renderMetrics(); renderHand(); renderRun(); renderSets(); controls() }
  function render() {
    const f = state.form
    el.innerHTML = `<div class="cg-head"><h3>Compositions from snippets</h3><p class="cg-intro">A composition is the smallest complete prompt: one snippet from every part, in order. Select the snippets the run may draw from, generate the run, add handcrafted compositions to it, and save it as a set. Sets are what Nesting arranges.</p></div>
      <section class="cg-step"><div class="cg-step-head"><h4><span class="cg-step-n">1</span>Select snippets</h4><div class="cg-step-tools"><label class="cg-field cg-search"><span class="cg-hidden">Find a snippet</span><input type="search" data-cg-find value="${esc(search)}" placeholder="Find a snippet"></label><button type="button" class="cg-small" data-cg-select-all>Select all</button><button type="button" class="cg-small" data-cg-clear-all>Clear</button></div></div>
        <div class="cg-tree" data-cg-tree></div></section>
      <section class="cg-step"><div class="cg-step-head"><h4><span class="cg-step-n">2</span>Distribution within the selection</h4></div><div data-cg-metrics></div></section>
      <section class="cg-step"><div class="cg-step-head"><h4><span class="cg-step-n">3</span>Generate the run</h4></div>
        <div class="cg-batch"><label class="cg-field">Run name<input data-cg-set value="${esc(f.set || '')}" maxlength="50" placeholder="${esc(nextRunName())}"></label>
        <label class="cg-field">Number to sample<span class="cg-inline"><input data-cg-requested type="number" min="1" max="10000" value="${esc(f.count)}"><span class="cg-of" data-cg-of></span></span></label>
        <label class="cg-field">Which ones<select data-cg-method>${option('sample', 'A random subset', f.method)}${option('all', 'All of them', f.method)}</select></label>
        <label class="cg-field">Random seed<input data-cg-seed type="number" min="0" max="4294967295" value="${esc(f.seed)}"></label></div>
        <div class="cg-batch"><label class="cg-field">Name prefix<input data-cg-prefix value="${esc(f.prefix)}" maxlength="50" placeholder="the run name"></label>
        <label class="cg-field">Between parts<select data-cg-separator>${[['paragraph', 'Blank line'], ['line', 'New line'], ['space', 'Space']].map(([id, label]) => option(id, label, f.separator)).join('')}</select></label></div>
        <label class="cg-instructions">Shared instructions (optional)<textarea data-cg-instructions rows="2" placeholder="Text placed before every composition in this run"></textarea></label>
        <p data-cg-count class="cg-count" role="status"></p>
        <div class="cg-actions"><button type="button" class="bench-primary" data-cg-generate>Generate the run</button><p data-cg-status role="status"></p></div>
        <p class="cg-note">Up to 10,000 sampled per run. The same selection, seed and count give the same compositions again. Sampled compositions are named prefix 1, prefix 2, … and can be renamed in the list.</p></section>
      <section class="cg-step"><div class="cg-step-head"><h4><span class="cg-step-n">4</span>Handcraft a composition</h4></div>
        <p class="cg-note">Pick one snippet for each part and name it. Handcrafted compositions join the run beside the sampled ones, before or after you generate.</p>
        <div class="cg-hand-form" data-cg-hand-form></div><p data-cg-hand-status class="cg-note" role="status"></p><div data-cg-hand-list></div></section>
      <section class="cg-step" data-cg-run-dist hidden><div class="cg-step-head"><h4><span class="cg-step-n">5</span>Distribution within the run</h4></div><div data-cg-run-metrics></div></section>
      <section data-cg-review class="cg-step cg-review" hidden><div class="cg-step-head"><h4><span class="cg-step-n">6</span>The run</h4></div><p data-cg-review-count class="cg-note"></p>
        <div class="cg-toolbar"><button type="button" class="cg-small" data-cg-select-valid>Keep all</button><button type="button" class="cg-small" data-cg-select-none>Keep none</button></div>
        <div class="cg-review-table"><table><thead><tr><th>Keep</th><th>Name</th><th>Snippets, by part</th><th>Review</th></tr></thead><tbody data-cg-rows></tbody></table></div>
        <div class="cg-pager" data-cg-pager><button type="button" class="cg-small" data-cg-previous>Previous</button><span data-cg-page></span><button type="button" class="cg-small" data-cg-next>Next</button></div>
        <h4 data-cg-reading class="cg-reading"></h4><pre data-cg-prompt hidden tabindex="0"></pre>
        <div class="cg-actions"><button type="button" class="bench-primary" data-cg-save>Save this set (0)</button><p class="cg-note">Saves as the set <b data-cg-set-name></b>. Nesting arranges saved sets.</p></div></section>
      <div data-cg-sets class="cg-sets-host"></div>`
    q('method').value = f.method; q('separator').value = f.separator
    q('instructions').value = f.instructions
    renderAll()
  }
  el.addEventListener('toggle', event => {
    const node = event.target
    if (node && typeof node.hasAttribute === 'function' && node.hasAttribute('data-cg-node') && !search) nodeState.set(node.dataset.cgNode, !!node.open)
  }, true)
  el.addEventListener('input', event => {
    event.stopPropagation(); if (locked || busy) return
    const node = event.target
    if (node.hasAttribute('data-cg-find')) { search = node.value; renderTree(); return }
    if (node.hasAttribute('data-cg-hand-name')) { handName = node.value; return }
    if (node.hasAttribute('data-cg-name')) {
      state.review.rows.find(row => row.index === Number(node.dataset.cgName)).name = node.value
      if (q('reading').dataset.index === node.dataset.cgName) q('reading').textContent = node.value
      publish(); return
    }
    const field = ['set', 'prefix', 'instructions', 'requested', 'seed'].find(name => node.hasAttribute(`data-cg-${name}`))
    if (!field) return
    state.form[field === 'requested' ? 'count' : field] = node.value
    invalidate()
  })
  el.addEventListener('change', event => {
    event.stopPropagation(); if (locked || busy) return
    const node = event.target
    if (node.hasAttribute('data-cg-pick') || node.hasAttribute('data-cg-pick-category') || node.hasAttribute('data-cg-pick-family')) {
      const { families } = tree()
      if (node.hasAttribute('data-cg-pick')) pick(node.dataset.cgPick, node.value, node.checked)
      else if (node.hasAttribute('data-cg-pick-category')) for (const bundle of families.get(node.dataset.family || '')?.get(node.dataset.cgPickCategory) || []) pick(node.dataset.cgPickCategory, bundle.id, node.checked)
      else for (const [category, bundles] of families.get(node.dataset.cgPickFamily) || []) for (const bundle of bundles) pick(category, bundle.id, node.checked)
      invalidate(); renderAll(); return
    }
    if (node.hasAttribute('data-cg-hand')) { handPicks[node.dataset.cgHand] = node.value; return }
    if (node.hasAttribute('data-cg-hand-include')) { state.handcrafted[Number(node.dataset.cgHandInclude)].include = node.checked; publish(); renderRun(); controls(); return }
    if (node.hasAttribute('data-cg-keep-hand')) { state.handcrafted[Number(node.dataset.cgKeepHand)].keep = node.checked; publish(); renderRun(); controls(); return }
    if (node.hasAttribute('data-cg-keep')) { state.review.rows.find(row => row.index === Number(node.dataset.cgKeep)).keep = node.checked; publish(); renderRun(); controls(); return }
    if (node.hasAttribute('data-cg-method')) state.form.method = node.value
    else if (node.hasAttribute('data-cg-separator')) state.form.separator = node.value
    else return
    invalidate()
  })
  async function generate() {
    const ticket = ++revision, activeContext = context
    if (!text(state.form.set)) { state.form.set = nextRunName(); q('set').value = state.form.set }
    if (!text(state.form.prefix)) { state.form.prefix = state.form.set; q('prefix').value = state.form.prefix }
    busy = true; controls(); q('status').textContent = 'Sampling the run…'
    try {
      const result = await onPreview(structuredClone(state.form))
      if (disposed || revision !== ticket) return
      prepared = result; page = 0
      if (state.review?.fingerprint !== result.fingerprint) state.review = { fingerprint: result.fingerprint, rows: result.rows.map(row => ({ index: row.index, name: row.name, keep: !row.error })) }
      renderRun(); publish(); q('status').textContent = `${plural(result.rows.length, 'composition')} sampled. Read them below; untick what you do not want, then save the set.`
    } catch (error) { if (!disposed && context === activeContext) q('status').textContent = error.message }
    finally { if (!disposed && context === activeContext) { busy = false; controls() } }
  }
  // The sampled compositions save first (their preview is bound to the catalog
  // as it was); each kept handcrafted one then previews and saves on its own,
  // against the catalog as it is by then, and leaves the handcrafted list.
  async function save() {
    const activeContext = context, hand = keptHand().map(entry => structuredClone(entry)), setName = text(state.form.set) || nextRunName()
    const sampled = keptSampled().map(row => ({ index: row.index, name: state.review.rows.find(item => item.index === row.index).name }))
    if (!text(state.form.set)) state.form.set = setName
    busy = true; controls(); q('status').textContent = `Saving the set ${setName}…`
    let count = 0, handSaved = 0
    try {
      if (prepared && sampled.length) {
        const result = await onSave(prepared, sampled)
        if (disposed || context !== activeContext) return
        if (!result?.ok) throw new Error(result?.error || 'The compositions could not be saved.')
        count = result.count
      }
      for (const entry of hand) {
        const preview = await onPreview(handForm({ ...entry, set: setName }))
        if (disposed || context !== activeContext) return
        const result = await onSave(preview, [{ index: preview.rows[0].index, name: entry.name }])
        if (disposed || context !== activeContext) return
        if (!result?.ok) throw new Error(result?.error || `${entry.name} could not be saved.`)
        handSaved++
        state.handcrafted = state.handcrafted.filter(item => item.name !== entry.name)
      }
      prepared = null; state.review = null; page = 0
      if (text(state.form.prefix) === setName) state.form.prefix = ''
      state.form.set = ''
      publish(); renderHand(); renderRun(); renderSets()
      q('set').value = ''; q('prefix').value = state.form.prefix
      q('status').textContent = `Set ${setName} saved: ${count ? plural(count, 'sampled composition') : ''}${count && handSaved ? ' and ' : ''}${handSaved ? plural(handSaved, 'handcrafted composition') : ''}. Nesting can arrange it now.`
    } catch (error) { if (!disposed && context === activeContext) { q('status').textContent = error.message; publish(); renderHand(); renderRun() } }
    finally { if (!disposed && context === activeContext) { busy = false; controls() } }
  }
  el.addEventListener('click', async event => {
    event.stopPropagation(); const button = event.target.closest('button'); if (!button || locked || busy) return
    const has = name => button.hasAttribute(`data-cg-${name}`), index = name => Number(button.getAttribute(`data-cg-${name}`))
    if (has('read')) {
      const row = sampledRows().find(row => row.index === index('read'))
      q('reading').dataset.index = String(row.index); readingOf(state.review.rows.find(item => item.index === row.index).name, row.error || row.text); return
    }
    if (has('read-hand')) { const entry = state.handcrafted[index('read-hand')]; if (!entry) return; delete q('reading').dataset.index; readingOf(entry.name, handText(entry)); return }
    if (has('previous') || has('next')) { page += has('next') ? 1 : -1; renderRun(); return }
    if (has('select-valid') || has('select-none')) {
      for (const row of state.review?.rows || []) row.keep = has('select-valid') && !sampledRows().find(item => item.index === row.index)?.error
      for (const entry of inRun()) entry.keep = has('select-valid')
      publish(); renderRun(); controls(); return
    }
    if (has('generate')) { await generate(); return }
    if (has('save')) { await save(); return }
    if (has('hand-add')) {
      const order = partOrder(), picks = Object.fromEntries(order.map(label => [label, handPicks[label] || '']))
      const missing = order.filter(label => !picks[label])
      if (missing.length) { q('hand-status').textContent = `Choose a snippet for ${missing.join(', ')}.`; return }
      const name = text(handName) || nextHandName()
      if (nameTaken(name)) { q('hand-status').textContent = `A composition named "${name}" already exists. Choose another name.`; return }
      state.handcrafted.push({ name, picks, include: true, keep: true })
      handPicks = {}; handName = ''
      q('hand-status').textContent = `${name} added to the run.`
      publish(); renderHand(); renderRun(); controls(); return
    }
    if (has('hand-remove')) { state.handcrafted.splice(index('hand-remove'), 1); publish(); renderHand(); renderRun(); controls(); return }
    if (has('select-all')) { for (const [, categories] of tree().families) for (const [category, bundles] of categories) for (const bundle of bundles) pick(category, bundle.id, true) }
    else if (has('clear-all')) state.form.parts = []
    else if (has('up') || has('down')) {
      const i = index(has('up') ? 'up' : 'down'), j = i + (has('up') ? -1 : 1)
      if (j < 0 || j >= state.form.parts.length) return
      ;[state.form.parts[i], state.form.parts[j]] = [state.form.parts[j], state.form.parts[i]]
    } else return
    invalidate(); renderAll()
  })
  return { el, setContext(next) {
    if (disposed) return
    const nextBinding = compositionGenerationBinding(next.catalog, next.routing)
    const nextState = next.state || emptyState()
    if (context === next.contextKey && binding === nextBinding && canonical(state) === canonical(nextState)) return
    if (context !== next.contextKey) { search = ''; nodeState = new Map(); handPicks = {}; handName = '' }
    revision++; busy = false; prepared = null; page = 0; context = next.contextKey; binding = nextBinding
    catalog = next.catalog; routing = next.routing
    state = structuredClone(nextState); state.form = { ...emptyCompositionGeneration().form, ...state.form }
    state.form.compatibility = { ...emptyCompositionGeneration().form.compatibility, ...state.form.compatibility }
    if (!Array.isArray(state.form.parts)) state.form.parts = []
    if (typeof state.form.set !== 'string') state.form.set = ''
    if (!Array.isArray(state.handcrafted)) state.handcrafted = []
    state.handcrafted = state.handcrafted.filter(entry => entry && typeof entry.name === 'string' && entry.picks && typeof entry.picks === 'object')
    render()
  }, setDisabled(value) { locked = value; if (q('save')) controls() }, destroy() { disposed = true; revision++ } }
}
