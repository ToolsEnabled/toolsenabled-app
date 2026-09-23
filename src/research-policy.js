// The authoring surface for a container's policy: which of its children may
// act, when it is finished, and when what it holds goes back to the start.
//
// WHY THIS IS NOT A LIST OF OPERATORS. A person could have been offered five
// buttons here -- parallel, race, sequence, state-gated, event-gated -- and the
// five would then have been built into the product, which is the one thing
// research-lifecycle.mjs and research-conditions.mjs are written not to be.
// They are ordinary library content: they ride in a bundle's own semantics and
// deleting all five leaves every module working. So this surface offers the
// LANGUAGE, and the five are reachable the way anything else in the library is.
// A person who wants a sixth operator writes it here without asking anyone.
//
// THE TERMS COME FROM THE LANGUAGE, NEVER FROM A LIST HELD HERE.
// research-conditions.mjs exports termsForMoment() for exactly this reason: a
// surface that kept its own list would eventually offer a term that validation
// then refuses, which is a dead end a person cannot get out of. Every control
// below is chosen by the term's id, so a term added to the language appears
// here, and a term that cannot be read at this moment is never drawn.
import {
  LIFECYCLE, MOMENTS, SIBLING_QUANTIFIERS, SIBLING_SCOPES, VALUE_TESTS,
  describeReason, termsForMoment, testNeedsValue, validateReason,
} from './research-conditions.mjs'
import { CLAUSE_WORDS, POLICY_CLAUSES, REQUIRED_CLAUSES } from './research-lifecycle.mjs'
import './research-policy.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) =>
  `<option value="${esc(value)}"${String(selected) === String(value) ? ' selected' : ''}>${esc(label)}</option>`

/* A new condition of a given term, with only the keys that term reads. Written
   here rather than in the language because a blank is a surface concern: the
   language's job is to refuse an incomplete one by name, and it does. */
const BLANK = Object.freeze({
  always: () => ({ term: 'always' }),
  field: () => ({ term: 'field', field: '', test: 'is', value: '' }),
  state: () => ({ term: 'state', test: 'is', is: 'active' }),
  siblings: () => ({ term: 'siblings', scope: 'earlier', quantifier: 'every', is: 'done' }),
  children: () => ({ term: 'children', quantifier: 'every', is: 'done' }),
  reason: () => ({ term: 'reason', holds: true }),
  since: () => ({ term: 'since', of: [{ term: 'always' }], test: 'at-least', value: '1' }),
  ago: () => ({ term: 'ago', of: [{ term: 'always' }], test: 'at-most', value: '3' }),
})

export function blankCondition(termId) {
  const make = BLANK[termId]
  /* Refused by name. A term the language offers and this surface cannot start
     is a dead control, and a silent fallback to a field comparison would put
     words in a person's mouth. */
  if (!make) throw new Error(`${termId || '(blank)'} is a term this surface cannot start yet.`)
  return make()
}

export function createPolicyEditor({ onChange = () => {} } = {}) {
  const el = document.createElement('div')
  el.className = 'policy-editor'
  let policy = null, fields = [], disposed = false

  const clauseOf = clause => (Array.isArray(policy?.[clause]) ? policy[clause] : [])

  // A condition is addressed by its clause and the path of nested reasons down
  // to it: "mayAct:0" is the first condition, "mayAct:0/2" the third condition
  // of the reason that the first one times.
  function conditionAt(address) {
    const [clause, trail] = address.split(':')
    const steps = trail.split('/').map(Number)
    let list = clauseOf(clause), condition = null
    for (const step of steps) {
      condition = list[step]
      list = condition?.of || []
    }
    return condition
  }
  function listAt(clause, steps) {
    let list = clauseOf(clause)
    for (const step of steps) list = list[step]?.of || []
    return list
  }

  const lifecycleChoices = selected => LIFECYCLE.map(state => option(state, state, selected)).join('')

  /* THE CONTROLS FOR ONE CONDITION, chosen by its term. Each branch draws only
     what that term reads, so a person is never asked for a value the language
     will not look at. */
  function termControls(address, read, depth) {
    const at = esc(address)
    switch (read.term) {
      case 'always':
        return ''
      case 'field':
        return `<input data-policy-field="${at}" value="${esc(read.field)}" aria-label="Field" placeholder="name a field"${
          fields.length ? ` list="policy-fields"` : ''}>
          <select data-policy-test="${at}" aria-label="Comparison">${VALUE_TESTS.map(item => option(item.id, item.label, read.test)).join('')}</select>
          ${testNeedsValue(read.test) ? `<input data-policy-value="${at}" value="${esc(read.value)}" aria-label="Value" placeholder="value">` : ''}`
      case 'state':
        return `<select data-policy-test="${at}" aria-label="Is or is not">${
          ['is', 'is-not'].map(id => option(id, id === 'is' ? 'is' : 'is not', read.test)).join('')}</select>
          <select data-policy-is="${at}" aria-label="State">${lifecycleChoices(read.is)}</select>`
      case 'siblings':
        return `<select data-policy-scope="${at}" aria-label="Which of them">${
          SIBLING_SCOPES.map(item => option(item.id, item.label, read.scope)).join('')}</select>
          <select data-policy-quantifier="${at}" aria-label="How many">${
            SIBLING_QUANTIFIERS.map(item => option(item.id, item.label, read.quantifier)).join('')}</select>
          <select data-policy-is="${at}" aria-label="State">${lifecycleChoices(read.is)}</select>`
      case 'children':
        return `<select data-policy-quantifier="${at}" aria-label="How many">${
          SIBLING_QUANTIFIERS.map(item => option(item.id, item.label, read.quantifier)).join('')}</select>
          <select data-policy-is="${at}" aria-label="State">${lifecycleChoices(read.is)}</select>`
      case 'reason':
        return `<select data-policy-holds="${at}" aria-label="Holds or does not">${
          [['true', 'holds'], ['false', 'does not hold']].map(([id, label]) => option(id, label, String(read.holds === true))).join('')}</select>`
      case 'since': case 'ago':
        return `<select data-policy-test="${at}" aria-label="Comparison">${
          VALUE_TESTS.filter(item => item.needsValue).map(item => option(item.id, item.label, read.test)).join('')}</select>
          <input data-policy-value="${at}" value="${esc(read.value)}" aria-label="How many steps" inputmode="numeric" placeholder="steps">
          <div class="policy-nested">${reasonMarkup(address, read.of || [], depth + 1)}</div>`
      default:
        /* A term the language offers that this surface has no controls for says
           so on the glass, rather than drawing an empty row that silently drops
           whatever the person had written. */
        return `<span class="policy-unknown">${esc(read.term)} cannot be edited here yet. It is kept as written.</span>`
    }
  }

  function conditionMarkup(clause, steps, condition, depth) {
    const address = `${clause}:${steps.join('/')}`
    const read = condition || {}
    const offered = termsForMoment(MOMENTS.runtime)
    return `<div class="policy-condition" data-policy-depth="${depth}">
      <select data-policy-term="${esc(address)}" aria-label="What this asks about">${
        offered.map(term => option(term.id, term.label, read.term)).join('')}</select>
      ${termControls(address, read, depth)}
      <button type="button" data-policy-remove="${esc(address)}" aria-label="Remove this condition">Remove</button>
    </div>`
  }

  /* A REASON IS A LIST OF CONDITIONS, ALL OF WHICH MUST HOLD, so the surface
     says "and" between them rather than offering a choice it does not have.
     The language has no grouping and no brackets, and this does not invent any. */
  function reasonMarkup(prefix, reason, depth) {
    const [clause, trail] = prefix.includes(':') ? prefix.split(':') : [prefix, '']
    const base = trail ? trail.split('/').map(Number) : []
    const rows = reason.map((condition, index) =>
      conditionMarkup(clause, [...base, index], condition, depth)).join('<div class="policy-and">and</div>')
    return `${rows || '<p class="policy-note">No conditions yet. A reason with none would hold for everything.</p>'}
      <button type="button" data-policy-add="${esc(clause)}:${esc(base.join('/'))}">Add a condition</button>`
  }

  function clauseMarkup(clause) {
    const reason = clauseOf(clause)
    const required = REQUIRED_CLAUSES.includes(clause)
    let refusal = ''
    if (reason.length) {
      try { validateReason(reason, { moment: MOMENTS.runtime, where: 'This' }) }
      catch (error) { refusal = error.message }
    } else if (required) {
      refusal = `This policy does not say ${CLAUSE_WORDS[clause]}.`
    }
    return `<section class="policy-clause" data-policy-clause="${esc(clause)}">
      <h4>${esc(CLAUSE_WORDS[clause].replace(/^./, c => c.toUpperCase()))}${required ? '' : ' <span class="policy-note">(optional)</span>'}</h4>
      ${reason.length ? `<p class="policy-said">${esc(describeReason(reason))}</p>` : ''}
      ${refusal ? `<p class="policy-refusal">${esc(refusal)}</p>` : ''}
      <div class="policy-reason">${reasonMarkup(clause, reason, 0)}</div>
      ${!required && reason.length ? `<button type="button" data-policy-drop-clause="${esc(clause)}">Remove this clause</button>` : ''}
    </section>`
  }

  function render() {
    if (disposed) return
    el.innerHTML = policy
      ? `${fields.length ? `<datalist id="policy-fields">${fields.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>` : ''}
         ${POLICY_CLAUSES.map(clauseMarkup).join('')}`
      : '<p class="policy-note">This place holds nothing, so nothing here needs a policy.</p>'
  }

  function changed() { render(); onChange(policy) }

  function setCondition(address, patch) {
    const condition = conditionAt(address)
    if (!condition) return
    Object.assign(condition, patch)
    changed()
  }

  el.addEventListener('change', event => {
    const control = event.target
    const read = name => control.getAttribute(name)
    if (read('data-policy-term') !== null) {
      const address = read('data-policy-term')
      const [clause, trail] = address.split(':')
      const steps = trail.split('/').map(Number)
      const list = listAt(clause, steps.slice(0, -1))
      const kept = list[steps.at(-1)]
      // Changing the term starts that term's own condition rather than carrying
      // keys the new term does not read.
      list[steps.at(-1)] = kept?.term === control.value ? kept : blankCondition(control.value)
      changed()
    } else if (read('data-policy-test') !== null) setCondition(read('data-policy-test'), { test: control.value })
    else if (read('data-policy-is') !== null) setCondition(read('data-policy-is'), { is: control.value })
    else if (read('data-policy-scope') !== null) setCondition(read('data-policy-scope'), { scope: control.value })
    else if (read('data-policy-quantifier') !== null) setCondition(read('data-policy-quantifier'), { quantifier: control.value })
    else if (read('data-policy-holds') !== null) setCondition(read('data-policy-holds'), { holds: control.value === 'true' })
    // A text box redraws when it is done, which is when "change" fires.
    else if (read('data-policy-field') !== null) setCondition(read('data-policy-field'), { field: control.value })
    else if (read('data-policy-value') !== null) setCondition(read('data-policy-value'), { value: control.value })
  })

  /* TYPING KEEPS UP WITHOUT REDRAWING. Every keystroke reaches the policy, so
     nothing is lost if a person clicks away without blurring the box, but the
     page is NOT rebuilt here: render() replaces the markup, which takes the
     caret out of the very box being typed in. The routing editor avoids this by
     listening only for "change"; this keeps that redraw point and still records
     the keystroke. */
  el.addEventListener('input', event => {
    const control = event.target
    const read = name => control.getAttribute(name)
    const address = read('data-policy-field') !== null ? read('data-policy-field')
      : (read('data-policy-value') !== null ? read('data-policy-value') : null)
    if (address === null) return
    const condition = conditionAt(address)
    if (!condition) return
    if (read('data-policy-field') !== null) condition.field = control.value
    else condition.value = control.value
    onChange(policy)
  })

  el.addEventListener('click', event => {
    const control = event.target.closest('button')
    if (!control || !el.contains(control)) return
    const read = name => control.getAttribute(name)
    if (read('data-policy-add') !== null) {
      const [clause, trail] = read('data-policy-add').split(':')
      const steps = trail ? trail.split('/').map(Number) : []
      if (!Array.isArray(policy[clause])) policy[clause] = []
      listAt(clause, steps).push(blankCondition('always'))
      changed()
    } else if (read('data-policy-remove') !== null) {
      const [clause, trail] = read('data-policy-remove').split(':')
      const steps = trail.split('/').map(Number)
      listAt(clause, steps.slice(0, -1)).splice(steps.at(-1), 1)
      changed()
    } else if (read('data-policy-drop-clause') !== null) {
      delete policy[read('data-policy-drop-clause')]
      changed()
    }
  })

  return {
    el,
    /* The policy is edited in place and handed back by reference, the way the
       routing editor hands back its draft: the caller owns saving it into the
       bundle's semantics, because a policy is content and this surface does not
       know where that content lives. */
    set(next, { fields: names = [] } = {}) {
      policy = next && typeof next === 'object' ? next : null
      fields = names.filter(Boolean)
      render()
    },
    get: () => policy,
    destroy() { disposed = true; el.innerHTML = '' },
  }
}
