// The authoring surface for named compositions and the rules that choose
// between them. Everything a person sees here that names something — a field,
// a value, a composition — is something they typed. What this file contributes
// is the arrangement and the comparisons, nothing about subject matter.
//
// PROMPT B. This was built once as a correct engine behind a prepare step and a
// JSON disclosure, which is the same difficulty one layer along: the owner
// opened Compose tasks and saw an unchanged page. So the surface is now the
// panel. Four numbered steps on arrival — fields, compositions, rules, rows —
// nothing to expand to reach any of them, and the rules read as an
// if / else if / otherwise ladder whose order is its meaning and can be changed
// in place. Selecting a row marks the rung that answers it, because a rule set
// is only readable against a case. JSON survives as an advanced escape hatch in
// the panel above, never as the way in.
//
// Compositions nest by name: a slot inside a composition may hold another
// composition, which may hold another, without limit. The model in
// research-routing.mjs resolves that; this file only shows it.
import { ROUTING_TESTS, compositionDepth, decisionDepth, fallbackOutcome, routingPreview, ruleOutcome, validateRouting } from './research-routing.mjs'
import { slotAccepts, slotRoleText } from './benchmark/composition.mjs'
import './research-routing.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) => `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`
const text = value => String(value ?? '').trim()
const containsComposition = node => !!node?.composition || Object.values(node?.slots || {}).some(containsComposition)
const titleOf = bundle => text(bundle.title) || bundle.id
const slotRoleTextOf = role => slotRoleText(role)

export function createRoutingEditor({ onChange = () => {}, onCapture = () => {}, surface = 'all' } = {}) {
  const el = document.createElement('div')
  el.className = 'routing-editor'
  let draft = null, catalog = [], disposed = false, selectedRow = 0, compositionIndex = -1
  let compositionPage = 0, compositionSearch = ''
  const choiceSearch = new Map()

  const byId = id => catalog.find(bundle => bundle.id === id)
  const names = () => (draft?.compositions || []).map(item => text(item.name)).filter(Boolean)

  // A path addresses a node inside one composition: the composition index,
  // then the slot names down to the node.
  function nodeAt(compositionIndex, path) {
    let node = draft.compositions[compositionIndex]?.node
    for (const slot of path) node = node?.slots?.[slot]
    return node
  }
  function setNodeAt(compositionIndex, path, value) {
    if (!path.length) { draft.compositions[compositionIndex].node = value; return }
    const parent = nodeAt(compositionIndex, path.slice(0, -1))
    parent.slots ||= {}
    parent.slots[path.at(-1)] = value
  }
  // A fresh reference to a snippet: its declared slots left explicitly empty so
  // the person fills each one, rather than the page choosing children for them.
  function refFor(id) {
    const bundle = byId(id)
    if (!bundle) return { use: id }
    const slots = Object.keys(bundle.slots || {})
    return { use: id, ...(slots.length ? { slots: Object.fromEntries(slots.map(slot => [slot, {}])) } : {}) }
  }

  /* PROMPT B. A place offers what it accepts and says so. A slot naming one
     role lists the snippets with that role; a slot naming several lists all of
     them; a slot naming none of ours accepts anything. Saved compositions are
     offered wherever a template is, because a composition is a snippet. */
  function accepted(role) {
    if (role === undefined) return catalog
    return catalog.filter(item => slotAccepts(role, item.role || 'node'))
  }
  function nodeMarkup(compositionIndex, node, path, label, role) {
    const address = `${compositionIndex}:${path.join('/')}`
    const reference = text(node?.composition)
    const bundle = reference ? null : byId(node?.use)
    const own = text(draft.compositions[compositionIndex]?.name)
    const selected = reference ? 'composition:' + reference : node?.use ? 'snippet:' + node.use : ''
    let depth = ''
    if (reference) {
      try { depth = `${compositionDepth(reference, draft)} level${compositionDepth(reference, draft) === 1 ? '' : 's'} deep` }
      catch (error) { depth = error.message }
    }
    const offered = accepted(role)
    const allNames = names().filter(name => name !== own), query = choiceSearch.get(address) || ''
    const matching = allNames.filter(name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    const offeredNames = allNames.length > 200 ? [...new Set([...(reference ? [reference] : []), ...matching.slice(0, 100)])] : allNames
    const choices = '<option value="">Not chosen yet</option>'
      + `<optgroup label="Snippets">${offered.map(item => option('snippet:' + item.id, `${titleOf(item)} (${item.id})`, selected)).join('')}</optgroup>`
      + `<optgroup label="Saved compositions">${offeredNames.map(name => option('composition:' + name, name, selected)).join('')}</optgroup>`
    const parameters = Object.entries(bundle?.parameters || {}).map(([name, fallback]) =>
      `<label class="routing-param">${esc(name)}<input data-routing-param="${esc(address)}" data-routing-param-name="${esc(name)}" value="${esc(node?.params?.[name] ?? fallback)}"></label>`).join('')
    const children = Object.keys(bundle?.slots || {}).map(slot =>
      nodeMarkup(compositionIndex, node?.slots?.[slot], [...path, slot], slot, bundle.slots[slot])).join('')
    const takes = role === undefined || slotRoleTextOf(role) === '*' ? '' : ` <span class="routing-note">takes ${esc(slotRoleTextOf(role))}</span>`
    return `<fieldset class="routing-node"><legend>${esc(label)}${takes}</legend>
      ${allNames.length > 200 ? `<label>Find a saved composition<input type="search" data-routing-choice-search="${esc(address)}" value="${esc(query)}"></label><p class="routing-note">The selector includes the first 100 matching saved compositions.</p>` : ''}
      <label>Use<select data-routing-use="${esc(address)}">${choices}</select></label>
      ${reference ? `<p class="routing-note">This is the saved composition <strong>${esc(reference)}</strong> · ${esc(depth)}</p>` : ''}
      ${parameters}${children}</fieldset>`
  }

  function compositionMarkup(composition, index) {
    let summary = ''
    try { summary = `${compositionDepth(text(composition.name), draft)} level${compositionDepth(text(composition.name), draft) === 1 ? '' : 's'} deep once its references are resolved` }
    catch (error) { summary = error.message }
    /* Not a disclosure. A composition and what sits inside it are the thing
       this surface is for, so they are on the glass with nothing to expand. */
    return `<section class="routing-composition">
      <div class="routing-row"><label>Composition name<input data-routing-composition-name="${index}" value="${esc(composition.name ?? '')}" placeholder="what you want to call it"></label>
        <button type="button" data-routing-remove-composition="${index}">Remove</button></div>
      <p class="routing-note">${esc(summary)}</p>
      ${nodeMarkup(index, composition.node, [], 'Top of this composition')}
    </section>`
  }

  /* PROMPT C. THE RULES READ AS WHAT THEY ARE: if this, then use that; else if;
     otherwise. Order is the meaning -- the first rule whose tests all hold
     decides -- so the ladder shows the order and lets a person change it in
     place. A rung may choose another set of rules instead of a composition, and
     that set is drawn inside the rung, indented, in the same shape. Nothing is
     behind a disclosure and nothing is edited as JSON.

     A set is addressed by a short key: r for the outermost one, d0, d1 for the
     named ones, so every control below knows which ladder it belongs to. */
  const setKey = index => (index === null ? 'r' : `d${index}`)
  const setAt = key => (key === 'r'
    ? { name: '', rules: draft.rules, otherwise: draft.otherwise, root: true }
    : draft.decisions[Number(key.slice(1))])
  const setFallback = (key, value) => {
    if (key === 'r') draft.otherwise = value
    else draft.decisions[Number(key.slice(1))].otherwise = value
  }
  const setNames = () => (draft.decisions || []).map(item => text(item.name)).filter(Boolean)
  const keyForName = name => {
    const index = (draft.decisions || []).findIndex(item => text(item.name) === text(name))
    return index < 0 ? null : setKey(index)
  }

  function outcomeChoices(outcome) {
    const selected = outcome?.decision ? 'decision:' + outcome.decision : outcome?.composition ? 'composition:' + outcome.composition : ''
    return option('', 'choose what happens', selected)
      + `<optgroup label="Compositions">${names().map(name => option('composition:' + name, name, selected)).join('')}</optgroup>`
      + `<optgroup label="Sets of rules">${setNames().map(name => option('decision:' + name, name, selected)).join('')}</optgroup>`
      + option('new-decision', 'a new set of rules here', selected)
  }

  /* What every row would do, recomputed from the draft rather than remembered,
     so the ladder and the rows table can never disagree about a decision. */
  function decisions() {
    try { return routingPreview(draft) } catch { return [] }
  }

  /* Which rungs answered the selected row, at every level it passed through. */
  function decidedPath() {
    const row = decisions()[selectedRow]
    return row && !row.error ? (row.path || []) : []
  }
  const rungWins = (setName, rule) => decidedPath().some(step => step.decision === text(setName) && step.rule === rule)

  function testMarkup(key, index, position, check, last) {
    const needsValue = ROUTING_TESTS.find(item => item.id === check.test)?.needsValue !== false
    const at = `${key}:${index}:${position}`
    return `<div class="routing-test">
      <select data-routing-test-field="${at}" aria-label="Field">${option('', 'choose a field', text(check.field))}${(draft.fields || []).map(name => option(text(name), text(name), text(check.field))).join('')}</select>
      <select data-routing-test-kind="${at}" aria-label="Comparison">${ROUTING_TESTS.map(item => option(item.id, item.label, check.test)).join('')}</select>
      ${needsValue ? `<input data-routing-test-value="${at}" value="${esc(check.value ?? '')}" aria-label="Value" placeholder="value">` : ''}
      <button type="button" data-routing-remove-test="${at}" aria-label="Remove this test">Remove</button>
      ${last ? '' : '<span class="routing-join">and</span>'}</div>`
  }

  function outcomeMarkup(key, rule, outcome, drawn) {
    const at = rule === null ? key : `${key}:${rule}`
    const branch = outcome?.decision ? branchMarkup(outcome.decision, drawn) : ''
    return `<div class="routing-rule-then"><span class="routing-keyword">${rule === null ? 'Otherwise' : 'then'}</span>
      <select data-routing-outcome="${at}" aria-label="What this rung chooses">${outcomeChoices(outcome)}</select></div>${branch}`
  }

  /* A set drawn where it is used. The first place it appears carries the whole
     editable ladder; a later reference to the same set says where it already
     is, so one set is never two editing surfaces at once. */
  function branchMarkup(name, drawn) {
    const key = keyForName(name)
    if (!key) return `<p class="routing-note routing-uses-refused">${esc(name)} is not one of your sets of rules.</p>`
    if (drawn.has(text(name))) return `<p class="routing-note">…continues in the rules named <strong>${esc(name)}</strong>, shown above.</p>`
    drawn.add(text(name))
    return `<div class="routing-branch">${ladderMarkup(key, drawn)}</div>`
  }

  function ruleMarkup(key, rule, index, drawn) {
    const set = setAt(key)
    const tests = rule.tests || []
    const winner = rungWins(set.name, index + 1)
    const body = tests.length
      ? tests.map((check, position) => testMarkup(key, index, position, check, position === tests.length - 1)).join('')
      : '<p class="routing-note">No test yet, so this rule cannot decide anything. Add one.</p>'
    return `<li class="routing-rule"${winner ? ' data-winner="true"' : ''}>
      <div class="routing-rule-head">
        <span class="routing-keyword">${index === 0 ? 'If' : 'Else if'}</span>
        ${winner ? '<span class="routing-winner">answers the selected row</span>' : ''}
        <span class="routing-rule-order">
          <button type="button" data-routing-move-rule-up="${key}:${index}"${index ? '' : ' disabled'} aria-label="Move this rule earlier">Move up</button>
          <button type="button" data-routing-move-rule-down="${key}:${index}"${index === set.rules.length - 1 ? ' disabled' : ''} aria-label="Move this rule later">Move down</button>
          <button type="button" data-routing-remove-rule="${key}:${index}" aria-label="Remove this rule">Remove</button>
        </span>
      </div>
      <div class="routing-rule-tests">${body}</div>
      <button type="button" data-routing-add-test="${key}:${index}">Add another test</button>
      ${outcomeMarkup(key, index, ruleOutcome(rule), drawn)}
    </li>`
  }

  function ladderMarkup(key, drawn) {
    const set = setAt(key)
    if (!set) return ''
    let heading = ''
    if (key !== 'r') {
      const index = Number(key.slice(1))
      let depth = ''
      try { depth = `${decisionDepth(text(set.name), draft)} level${decisionDepth(text(set.name), draft) === 1 ? '' : 's'} of rules deep` }
      catch (error) { depth = error.message }
      heading = `<div class="routing-row"><label>Name these rules<input data-routing-decision-name="${index}" value="${esc(set.name ?? '')}" placeholder="what you want to call them"></label>
        <button type="button" data-routing-remove-decision="${index}">Remove</button>
        <span class="routing-note">${esc(depth)}</span></div>`
    }
    const fallbackWins = rungWins(set.name, null)
    return `${heading}<ol class="routing-ladder">${(set.rules || []).map((rule, index) => ruleMarkup(key, rule, index, drawn)).join('')}
      <li class="routing-rule routing-fallback"${fallbackWins ? ' data-winner="true"' : ''}>
        ${outcomeMarkup(key, null, fallbackOutcome(set), drawn)}
        ${fallbackWins ? '<span class="routing-winner">answers the selected row</span>' : ''}
      </li></ol>
      <button type="button" data-routing-add-rule="${key}">Add a rule${key === 'r' ? '' : ' here'}</button>`
  }

  function rowsMarkup() {
    const fields = (draft.fields || []).map(text).filter(Boolean)
    const answers = decisions()
    const head = `<tr><th>Pick</th><th>Task identifier</th>${fields.map(name => `<th>${esc(name)}</th>`).join('')}<th>Uses</th><th></th></tr>`
    const body = (draft.rows || []).map((row, index) => {
      const answer = answers[index]
      /* PROMPT C. The whole path, not only the rung that started it: which
         rung of which set answered, at every level, then what it ended at. A
         nested decision nobody can trace is a decision nobody can correct. */
      const because = !answer ? ''
        : answer.error ? answer.error
        : `${answer.route} → ${answer.composition} · ${answer.depth} level${answer.depth === 1 ? '' : 's'} deep`
      return `<tr${index === selectedRow ? ' data-selected="true"' : ''}>
      <td><button type="button" data-routing-select-row="${index}" aria-pressed="${index === selectedRow}">${index === selectedRow ? 'Showing' : 'Show'}</button></td>
      <td><input data-routing-row-id="${index}" value="${esc(row.id ?? '')}"></td>
      ${fields.map(name => `<td><input data-routing-row-value="${index}" data-routing-row-field="${esc(name)}" value="${esc(row.values?.[name] ?? '')}"></td>`).join('')}
      <td class="routing-uses${answer && answer.error ? ' routing-uses-refused' : ''}">${esc(because)}</td>
      <td><button type="button" data-routing-remove-row="${index}">Remove</button></td></tr>`
    }).join('')
    return `<table class="routing-rows"><thead>${head}</thead><tbody>${body}</tbody></table>`
  }

  function render() {
    if (disposed) return
    if (!draft) { el.innerHTML = '<p class="routing-note">Choose a task above to start routing between compositions.</p>'; return }
    if (surface === 'composition') {
      const item = draft.compositions[compositionIndex]
      el.innerHTML = item ? compositionMarkup(item, compositionIndex) : '<p class="routing-note">Choose a saved composition, or start one from snippets.</p>'
      return
    }
    selectedRow = Math.max(0, Math.min(selectedRow, (draft.rows || []).length - 1))
    let problem = ''
    try { validateRouting(draft, { catalog: catalog.length ? catalog : null }) } catch (error) { problem = error.message }
    const drawn = new Set()
    const ladder = ladderMarkup('r', drawn)
    const stray = (draft.decisions || [])
      .map((decision, index) => [decision, index])
      .filter(([decision]) => !drawn.has(text(decision.name)))
      .map(([, index]) => ladderMarkup(setKey(index), drawn)).join('')
    const showCompositions = surface === 'all' || surface === 'snippets'
    const visibleCompositions = (draft.compositions || []).map((item, index) => ({ item, index })).filter(({ item }) => surface !== 'snippets' || !containsComposition(item.node))
    const paged = visibleCompositions.length > 50
    const matches = visibleCompositions.filter(({ item }) => !paged || item.name.toLocaleLowerCase().includes(compositionSearch.toLocaleLowerCase()))
    compositionPage = Math.max(0, Math.min(compositionPage, Math.ceil(matches.length / 10) - 1))
    const pageCompositions = paged ? matches.slice(compositionPage * 10, compositionPage * 10 + 10) : matches
    el.innerHTML = `
      <section class="routing-step"><h4>1 · Your fields</h4>
        <p class="routing-note">The values each task varies over, in your words. They travel into the task too, so a composition can quote one.</p>
        <div class="routing-fields">${(draft.fields || []).map((name, index) => `<span class="routing-field"><input data-routing-field="${index}" value="${esc(name)}" placeholder="name a field" aria-label="Field ${index + 1}"><button type="button" data-routing-remove-field="${index}">Remove</button></span>`).join('')}</div>
        <button type="button" data-routing-add-field>Add a field</button></section>
      ${showCompositions ? `<section class="routing-step"><h4>2 · Your compositions</h4>
        <p class="routing-note">${surface === 'snippets' ? 'Build and name arrangements of snippets here. Arrangements that reuse other compositions are listed in Nesting.' : 'An arrangement of snippets you have named. Any place inside one can hold another composition, and that one another, to any depth — chosen from the same list you choose a snippet from.'}</p>
        ${paged ? `<label>Find a saved composition<input type="search" data-routing-composition-search value="${esc(compositionSearch)}"></label><p>${matches.length.toLocaleString()} matching compositions · page ${compositionPage + 1} of ${Math.max(1, Math.ceil(matches.length / 10))}</p><button type="button" data-routing-composition-page="-1"${compositionPage === 0 ? ' disabled' : ''}>Previous compositions</button><button type="button" data-routing-composition-page="1"${(compositionPage + 1) * 10 >= matches.length ? ' disabled' : ''}>Next compositions</button>` : ''}
        ${pageCompositions.map(({ item, index }) => compositionMarkup(item, index)).join('') || '<p class="routing-note">No compositions yet, or none match this search.</p>'}
        <button type="button" data-routing-add-composition>Add a composition</button>
        <button type="button" data-routing-capture>Copy the prompt tree below into a new composition</button></section>` : ''}
      ${surface === 'tasks' ? '<p class="routing-note">The rules can choose any composition in the library above, saved sets included.</p><button type="button" data-routing-capture>Copy the selected task into the library as a composition</button>' : ''}
      <section class="routing-step"><h4>${showCompositions ? 3 : 2} · Your rules</h4>
        <p class="routing-note">Read top to bottom. The first rule whose tests all hold decides; move a rule to change what it can take. A rule can send a row to another set of rules instead of to a composition, and that set is drawn inside it.</p>
        ${ladder}
        ${stray ? `<div class="routing-stray"><p class="routing-note">These sets of rules are not reached from any rung yet.</p>${stray}</div>` : ''}</section>
      <section class="routing-step"><h4>${showCompositions ? 4 : 3} · Your rows</h4>
        <p class="routing-note">One task per row. Press Show on a row to mark the rule above that answers it.</p>
        ${rowsMarkup()}
        <button type="button" data-routing-add-row>Add a row</button></section>
      <p class="routing-problem" role="status">${problem ? esc(problem) : ''}</p>`
  }

  /* A new set of rules, named with a plain identifier the person can change.
     It is empty, so the ladder it draws asks for its first rule immediately. */
  function addDecision() {
    draft.decisions ||= []
    let index = draft.decisions.length + 1
    while (draft.decisions.some(item => text(item.name) === `rules-${index}`)) index += 1
    const name = `rules-${index}`
    draft.decisions.push({ name, rules: [], otherwise: null })
    return name
  }
  const outcomeChosen = value => {
    if (value.startsWith('composition:')) return { composition: value.slice('composition:'.length) }
    if (value.startsWith('decision:')) return { decision: value.slice('decision:'.length) }
    return null
  }
  function eachOutcome(apply) {
    const sets = [{ rules: draft.rules, get otherwise() { return draft.otherwise }, set otherwise(value) { draft.otherwise = value } }, ...(draft.decisions || [])]
    for (const set of sets) {
      for (const rule of set.rules || []) {
        const next = apply(ruleOutcome(rule))
        if (next !== undefined) { rule.then = next; delete rule.composition }
      }
      const next = apply(fallbackOutcome(set))
      if (next !== undefined) set.otherwise = next
    }
  }
  const renameComposition = (from, to) => {
    if (!from || from === text(to)) return
    eachOutcome(outcome => (outcome?.composition === from ? { composition: text(to) } : undefined))
    const swap = node => {
      if (text(node?.composition) === from) node.composition = text(to)
      for (const child of Object.values(node?.slots || {})) swap(child)
    }
    for (const composition of draft.compositions || []) swap(composition.node)
  }
  const renameDecision = (from, to) => {
    if (!from || from === text(to)) return
    eachOutcome(outcome => (outcome?.decision === from ? { decision: text(to) } : undefined))
  }

  function changed() { onChange(draft, draft.compositions[compositionIndex]?.name || ''); render() }

  el.addEventListener('click', event => {
    const button = event.target.closest('button')
    if (!button || !draft) return
    const at = name => button.getAttribute(name)
    if (at('data-routing-composition-page') !== null) { event.stopPropagation(); compositionPage += Number(at('data-routing-composition-page')); render(); return }
    if (button.hasAttribute('data-routing-add-field')) { draft.fields.push(''); changed() }
    else if (at('data-routing-remove-field') !== null) {
      const name = text(draft.fields[Number(at('data-routing-remove-field'))])
      draft.fields.splice(Number(at('data-routing-remove-field')), 1)
      for (const row of draft.rows) delete row.values[name]
      changed()
    }
    else if (button.hasAttribute('data-routing-add-composition')) {
      draft.compositions.push({ name: '', node: {} }); compositionSearch = ''
      compositionPage = Math.floor((draft.compositions.filter(item => surface !== 'snippets' || !containsComposition(item.node)).length - 1) / 10)
      changed()
    }
    else if (at('data-routing-remove-composition') !== null) { draft.compositions.splice(Number(at('data-routing-remove-composition')), 1); changed() }
    else if (button.hasAttribute('data-routing-capture')) { onCapture() }
    /* PROMPT C. Every control below names the set it belongs to, so the same
       handler serves the outermost ladder and every one nested inside it. */
    else if (at('data-routing-add-rule') !== null) { setAt(at('data-routing-add-rule')).rules.push({ tests: [], then: null }); changed() }
    else if (at('data-routing-remove-decision') !== null) { draft.decisions.splice(Number(at('data-routing-remove-decision')), 1); changed() }
    else if (at('data-routing-remove-rule') !== null) {
      const [key, index] = at('data-routing-remove-rule').split(':')
      setAt(key).rules.splice(Number(index), 1); changed()
    }
    else if (at('data-routing-move-rule-up') !== null) {
      const [key, raw] = at('data-routing-move-rule-up').split(':')
      const rules = setAt(key).rules, index = Number(raw)
      if (index > 0) rules.splice(index - 1, 0, rules.splice(index, 1)[0])
      changed()
    }
    else if (at('data-routing-move-rule-down') !== null) {
      const [key, raw] = at('data-routing-move-rule-down').split(':')
      const rules = setAt(key).rules, index = Number(raw)
      if (index < rules.length - 1) rules.splice(index + 1, 0, rules.splice(index, 1)[0])
      changed()
    }
    else if (at('data-routing-select-row') !== null) { selectedRow = Number(at('data-routing-select-row')); render() }
    else if (at('data-routing-add-test') !== null) {
      const [key, index] = at('data-routing-add-test').split(':')
      setAt(key).rules[Number(index)].tests.push({ field: draft.fields[0] ?? '', test: 'is', value: '' }); changed()
    }
    else if (at('data-routing-remove-test') !== null) {
      const [key, rule, position] = at('data-routing-remove-test').split(':')
      setAt(key).rules[Number(rule)].tests.splice(Number(position), 1); changed()
    }
    else if (button.hasAttribute('data-routing-add-row')) {
      let index = draft.rows.length + 1
      while (draft.rows.some(row => text(row.id) === `row-${index}`)) index++
      draft.rows.push({ id: `row-${index}`, values: {} }); changed()
    }
    else if (at('data-routing-remove-row') !== null) { draft.rows.splice(Number(at('data-routing-remove-row')), 1); changed() }
  })

  el.addEventListener('change', event => {
    const input = event.target
    if (!draft || typeof input?.getAttribute !== 'function') return
    const at = name => input.getAttribute(name)
    if (at('data-routing-composition-search') !== null) { event.stopPropagation(); compositionSearch = input.value; compositionPage = 0; render(); return }
    if (at('data-routing-choice-search') !== null) { event.stopPropagation(); choiceSearch.set(at('data-routing-choice-search'), input.value); render(); return }
    if (at('data-routing-field') !== null) { draft.fields[Number(at('data-routing-field'))] = input.value; changed() }
    /* Renaming carries its references with it. Without this a rename silently
       breaks every rung and place that pointed at the old name, and the person
       is left reading a refusal about a name they just changed. */
    else if (at('data-routing-composition-name') !== null) {
      const composition = draft.compositions[Number(at('data-routing-composition-name'))]
      if (surface === 'composition') {
        const name = text(input.value)
        const invalid = !name || name.length > 64 || /[\x00-\x1f]/.test(name) || draft.compositions.some(item => item !== composition && text(item.name) === name)
        input.setCustomValidity?.(invalid ? 'Use a unique name of 1–64 characters, without line breaks.' : '')
        if (invalid) { input.reportValidity?.(); return }
        input.value = name
      }
      renameComposition(text(composition.name), input.value)
      composition.name = input.value; changed()
    }
    else if (at('data-routing-decision-name') !== null) {
      const decision = draft.decisions[Number(at('data-routing-decision-name'))]
      renameDecision(text(decision.name), input.value)
      decision.name = input.value; changed()
    }
    else if (at('data-routing-use') !== null) {
      const [index, path] = at('data-routing-use').split(':')
      const steps = path ? path.split('/') : []
      const [kind, value] = input.value ? [input.value.slice(0, input.value.indexOf(':')), input.value.slice(input.value.indexOf(':') + 1)] : ['', '']
      setNodeAt(Number(index), steps, kind === 'composition' ? { composition: value } : kind === 'snippet' ? refFor(value) : {})
      // Direct connection edits may change the generated wrapper's shape.
      // Keep the structure editable without reopening an incompatible form.
      delete draft.compositions[Number(index)].nesting
      changed()
    }
    else if (at('data-routing-param') !== null) {
      const [index, path] = at('data-routing-param').split(':')
      const node = nodeAt(Number(index), path ? path.split('/') : [])
      node.params ||= {}
      node.params[at('data-routing-param-name')] = input.value
      changed()
    }
    else if (at('data-routing-outcome') !== null) {
      const [key, rule] = at('data-routing-outcome').split(':')
      const set = setAt(key)
      const chosen = input.value === 'new-decision' ? { decision: addDecision() } : outcomeChosen(input.value)
      /* The outermost set is assembled for reading, so writing its fallback has
         to go back to the draft itself rather than to that reading. */
      if (rule === undefined) setFallback(key, chosen)
      else { set.rules[Number(rule)].then = chosen; delete set.rules[Number(rule)].composition }
      changed()
    }
    else if (at('data-routing-test-field') !== null) {
      const [key, rule, position] = at('data-routing-test-field').split(':')
      setAt(key).rules[Number(rule)].tests[Number(position)].field = input.value; changed()
    }
    else if (at('data-routing-test-kind') !== null) {
      const [key, rule, position] = at('data-routing-test-kind').split(':')
      setAt(key).rules[Number(rule)].tests[Number(position)].test = input.value; changed()
    }
    else if (at('data-routing-test-value') !== null) {
      const [key, rule, position] = at('data-routing-test-value').split(':')
      setAt(key).rules[Number(rule)].tests[Number(position)].value = input.value; changed()
    }
    else if (at('data-routing-row-id') !== null) { draft.rows[Number(at('data-routing-row-id'))].id = input.value; changed() }
    else if (at('data-routing-row-value') !== null) {
      const row = draft.rows[Number(at('data-routing-row-value'))]
      row.values[at('data-routing-row-field')] = input.value; changed()
    }
  })

  return {
    el,
    setContext({ catalog: nextCatalog = [], draft: nextDraft = null, selected = '' } = {}) { catalog = nextCatalog; draft = nextDraft; compositionPage = 0; compositionSearch = ''; choiceSearch.clear(); compositionIndex = draft?.compositions.findIndex(item => item.name === selected) ?? -1; render() },
    addComposition(node = {}) {
      if (!draft || disposed) return
      let index = 1
      while (names().includes(`Untitled composition ${index}`)) index++
      draft.compositions.push({ name: `Untitled composition ${index}`, node: structuredClone(node) })
      compositionIndex = draft.compositions.length - 1; changed()
    },
    read() { return draft },
    write(next) { draft = next; render() },
    destroy() { disposed = true; el.replaceChildren() },
  }
}
