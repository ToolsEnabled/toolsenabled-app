import { CHECK_KINDS, CHECK_LIMIT, CHECKS_GRADER_FILE, CUSTOM_GRADER_FILE, FIXTURE_LIMIT, checksProblems, emptyCheck, emptyChecksDraft, emptyFixture, evaluateFixtures, normalizeChecksDraft } from './research-checks.mjs'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`
const problemList = problems => problems.map(problem => `<span class="pipe-warn" data-checks-problem="${esc(problem.kind)}">${esc(problem.text)}</span>`).join('')
const needsOf = kind => (CHECK_KINDS.find(([id]) => id === kind) || CHECK_KINDS[0])[2]
const freshId = taken => { let n = taken.length + 1; while (taken.includes(`check-${n}`)) n++; return `check-${n}` }

/* Mechanical checks: deterministic grading the researcher writes as table
   rows (a pattern, an exact text, a JSON value at a path, a length) or as a
   module exporting grade(project, task, output). Fixtures name an output and
   the verdict it must get; table rows are evaluated here as they are typed.
   The host retains the draft beside the study (data-bench-checks-draft) and
   owns the Attach button (data-bench-apply-checks), which pins the generated
   files under checks/ and sets the study's scoring to the module. */
export function createChecksEditor({ onChange }) {
  const el = document.createElement('section'); el.className = 'checks-editor'
  let draft = emptyChecksDraft(), locked = false
  const q = name => el.querySelector(`[data-checks-${name}]`)
  const emit = () => onChange(structuredClone(draft))

  // One check: the kind decides which field is shown; a kind change re-renders.
  function check(entry, i) {
    const needs = needsOf(entry.kind)
    const expected = label => `<label class="pipe-field pipe-prompt">${label}<textarea data-checks-expected="${i}" rows="2" maxlength="20000" spellcheck="false">${esc(entry.expected)}</textarea></label>`
    return `<li class="pipe-row checks-row" data-checks-row="${i}"><div class="pipe-row-line"><span class="pipe-index" title="Check ${i + 1}">${i + 1}</span>
      <label class="pipe-field">Name<input data-checks-name="${i}" value="${esc(entry.name)}" maxlength="80" placeholder="Names the final answer"></label>
      <label class="pipe-field">What it checks<select data-checks-kind="${i}">${CHECK_KINDS.map(([id, label]) => option(id, label, entry.kind)).join('')}</select></label>
      <label class="pipe-tick"><input type="checkbox" data-checks-required="${i}"${entry.required ? ' checked' : ''}><span>Required</span></label>
      <label class="pipe-field">Weight<input type="number" data-checks-weight="${i}" min="0.01" max="100" step="0.5" value="${esc(entry.weight)}"></label>
      <button type="button" class="pipe-small pipe-drop" data-checks-remove="${i}" aria-label="Remove check ${i + 1}">×</button></div>
      <div class="pipe-row-line" data-checks-fields="${esc(needs)}">${needs === 'pattern' ? `<label class="pipe-field pipe-exe">Pattern <span class="pipe-meta">a regular expression tested against the output</span><input data-checks-pattern="${i}" value="${esc(entry.pattern)}" maxlength="2000" placeholder="FINAL ANSWER:\\s*42\\b" spellcheck="false"></label><label class="pipe-field">Flags<input data-checks-flags="${i}" value="${esc(entry.flags)}" maxlength="4" placeholder="i"></label>`
        : needs === 'path' ? `<label class="pipe-field pipe-exe">JSON path <span class="pipe-meta">dotted, such as answer.value or items.0.id</span><input data-checks-path="${i}" value="${esc(entry.path)}" maxlength="400" placeholder="answer.value" spellcheck="false"></label>${expected('Expected value <span class="pipe-meta">JSON when it parses, else text</span>')}`
        : needs === 'expected' ? expected(entry.kind === 'max-chars' ? 'Maximum characters' : 'Text to compare with')
        : `<p class="pipe-hint">${entry.kind === 'expected' ? 'Compares the output with the task\'s expected answer; nothing more to fill in.' : 'Nothing more to fill in.'}</p>`}</div></li>`
  }
  function fixture(entry, i) {
    return `<li class="pipe-row checks-fixture" data-checks-fixture="${i}"><div class="pipe-row-line"><span class="pipe-index" title="Fixture ${i + 1}">F${i + 1}</span>
      <label class="pipe-field">Name<input data-checks-fixture-name="${i}" value="${esc(entry.name)}" maxlength="80" placeholder="A correct answer"></label>
      <label class="pipe-field">Must<select data-checks-fixture-expect="${i}">${option('pass', 'pass', entry.expect)}${option('fail', 'fail', entry.expect)}</select></label>
      <button type="button" class="pipe-small pipe-drop" data-checks-fixture-remove="${i}" aria-label="Remove fixture ${i + 1}">×</button></div>
      <div class="pipe-row-line"><label class="pipe-field pipe-prompt">Output to grade<textarea data-checks-fixture-output="${i}" rows="3" maxlength="20000" spellcheck="false">${esc(entry.output)}</textarea></label>
      <label class="pipe-field pipe-prompt">Expected answer <span class="pipe-meta">optional; what the task's expected answer would be</span><textarea data-checks-fixture-expected="${i}" rows="3" maxlength="20000" spellcheck="false">${esc(entry.expected)}</textarea></label></div>
      <p class="pipe-preview checks-result" data-checks-fixture-result="${i}"></p></li>`
  }
  function render() {
    el.innerHTML = `<div class="pipe-head"><h4>Mechanical checks</h4>
      <p class="pipe-intro">Deterministic grading with no model in the loop: a table of checks run against each output, or a grading module you write. Attaching pins the grader under <code>checks/</code> in the frozen input manifest and sets Scoring to the custom grading module. The exported CLI runs it in its module host with no network and no randomness.</p></div>
      <span class="pipe-efforts" role="group" aria-label="How the checks are written">${[['table', 'A table of checks'], ['code', 'A grading module I write']].map(([id, label]) => `<label class="pipe-tick"><input type="radio" name="checks-mode" data-checks-mode value="${id}"${draft.mode === id ? ' checked' : ''}><span>${label}</span></label>`).join('')}</span>
      <div data-checks-table${draft.mode === 'table' ? '' : ' hidden'}>
        <ol class="pipe-rows">${draft.checks.map(check).join('') || '<li class="pipe-hint">No checks yet.</li>'}</ol>
        <div class="pipe-actions"><button type="button" class="pipe-small" data-checks-add>Add a check</button></div>
        <p class="pipe-hint">An output passes when every required check passes; its score is the weighted share of checks that passed. The check against the task's expected answer reads each task's own expected result.</p></div>
      <div data-checks-code-section${draft.mode === 'code' ? '' : ' hidden'}>
        <label class="pipe-field pipe-prompt">Grading module <span class="pipe-meta">an ES module exporting grade(project, task, output) that returns { passed, score }</span><textarea data-checks-code rows="14" maxlength="200000" spellcheck="false" placeholder="export async function grade(project, task, output) { const passed = /FINAL ANSWER: 42/.test(String(output)); return { passed, score: passed ? 1 : 0 } }">${esc(draft.code)}</textarea></label>
        <p class="pipe-hint">It is pinned as <code>${CUSTOM_GRADER_FILE}</code>. The fixtures below are checked on the run computer with <code>node checks/run-fixtures.mjs</code>, since this page runs no module.</p></div>
      <h4 class="checks-subhead">Fixtures</h4>
      <p class="pipe-hint">An output and the verdict it must get. Table checks are evaluated here as you type; the pinned fixtures are checked again on the run computer.</p>
      <ol class="pipe-rows">${draft.fixtures.map(fixture).join('') || '<li class="pipe-hint">No fixtures yet.</li>'}</ol>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-checks-fixture-add>Add a fixture</button></div>
      <p class="pipe-preview" data-checks-results></p>
      <p class="pipe-preview" data-checks-problems></p>
      <p class="pipe-hint" data-checks-files></p>`
    refresh(); disable()
  }
  function disable() {
    for (const tag of ['button', 'input', 'select', 'textarea']) for (const node of el.querySelectorAll(tag)) node.disabled = locked
    q('add').disabled = locked || draft.checks.length >= CHECK_LIMIT
    q('fixture-add').disabled = locked || draft.fixtures.length >= FIXTURE_LIMIT
  }
  function refresh() {
    const results = evaluateFixtures(draft), problems = checksProblems(draft)
    results.forEach((result, i) => { const node = q(`fixture-result="${i}"`); if (node) node.textContent = result.ok === null ? result.detail : `${result.ok ? 'As registered' : 'Missed'}: expects ${result.expect}, gets ${result.actual}. ${result.detail}` })
    const kept = results.filter(result => result.ok === true).length, missed = results.filter(result => result.ok === false).length
    q('results').innerHTML = !results.length ? 'No fixtures yet; add one to see the grader decide.'
      : draft.mode === 'code' ? `<b>${results.length}</b> fixture${results.length === 1 ? '' : 's'} to check on the run computer.`
      : `<b>${kept}</b> of ${results.length} fixture${results.length === 1 ? '' : 's'} get the verdict registered for ${results.length === 1 ? 'it' : 'them'}${missed ? `; <b>${missed}</b> missed` : ''}.`
    q('problems').innerHTML = problems.length ? problemList(problems) : 'Ready to attach.'
    q('files').innerHTML = `Attaching pins <code>${draft.mode === 'code' ? CUSTOM_GRADER_FILE : CHECKS_GRADER_FILE}</code>, <code>checks/fixtures.json</code> and <code>checks/run-fixtures.mjs</code> as project files.`
  }

  el.addEventListener('input', event => {
    const target = event.target, at = name => target.getAttribute(`data-checks-${name}`), has = name => target.hasAttribute(`data-checks-${name}`), index = name => Number(at(name))
    if (locked || target.tagName === 'SELECT' || ['checkbox', 'radio'].includes(target.getAttribute('type'))) return
    if (has('code')) { draft.code = target.value.slice(0, 200000); refresh(); emit(); return }
    const field = ['name', 'pattern', 'flags', 'expected', 'path', 'weight'].find(name => has(name))
    if (field) {
      const entry = draft.checks[index(field)]
      if (field === 'weight') { const weight = Number(target.value); entry.weight = Number.isFinite(weight) && weight > 0 && weight <= 100 ? weight : 1 }
      else if (field === 'flags') entry.flags = target.value.replace(/[^imsu]/g, '').slice(0, 4)
      else if (field === 'expected') entry.expected = target.value.slice(0, 20000)
      else entry[field] = (field === 'pattern' ? target.value : target.value.trim()).slice(0, field === 'pattern' ? 2000 : field === 'path' ? 400 : 80)
      refresh(); emit(); return
    }
    const fixtureField = ['name', 'output', 'expected'].find(name => has(`fixture-${name}`))
    if (fixtureField) {
      const entry = draft.fixtures[index(`fixture-${fixtureField}`)]
      entry[fixtureField] = fixtureField === 'name' ? target.value.trim().slice(0, 80) : target.value.slice(0, 20000)
      refresh(); emit()
    }
  })
  el.addEventListener('change', event => {
    const target = event.target, at = name => target.getAttribute(`data-checks-${name}`), has = name => target.hasAttribute(`data-checks-${name}`), index = name => Number(at(name))
    if (locked) return
    if (has('mode')) { draft.mode = target.value === 'code' ? 'code' : 'table'; render(); emit(); return }
    if (has('kind')) { draft.checks[index('kind')].kind = CHECK_KINDS.some(([id]) => id === target.value) ? target.value : 'regex'; render(); emit(); return }
    if (has('required')) { draft.checks[index('required')].required = !!target.checked; refresh(); emit(); return }
    if (has('fixture-expect')) { draft.fixtures[index('fixture-expect')].expect = target.value === 'fail' ? 'fail' : 'pass'; refresh(); emit() }
  })
  el.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || locked) return
    const has = name => button.hasAttribute(`data-checks-${name}`), index = name => Number(button.getAttribute(`data-checks-${name}`))
    if (has('add')) { if (draft.checks.length >= CHECK_LIMIT) return; draft.checks.push({ ...emptyCheck(), id: freshId(draft.checks.map(item => item.id)) }); render(); emit(); q(`name="${draft.checks.length - 1}"`)?.focus() }
    else if (has('remove')) { draft.checks.splice(index('remove'), 1); render(); emit() }
    else if (has('fixture-add')) { if (draft.fixtures.length >= FIXTURE_LIMIT) return; draft.fixtures.push(emptyFixture()); render(); emit(); q(`fixture-name="${draft.fixtures.length - 1}"`)?.focus() }
    else if (has('fixture-remove')) { draft.fixtures.splice(index('fixture-remove'), 1); render(); emit() }
  })

  render()
  return {
    el,
    set(next) { draft = normalizeChecksDraft(next); render() },
    value: () => structuredClone(draft),
    setDisabled(value) { locked = !!value; disable() },
  }
}
