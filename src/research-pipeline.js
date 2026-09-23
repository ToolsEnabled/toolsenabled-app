import { JUDGE_LIMIT, JUDGE_PROMPT_LIMIT, PIPELINE_EFFORTS, PIPELINE_SURFACES, emptyPipelineDraft, emptyPipelineRow, judgeProblems, normalizePipelineDraft, pipelineConditions, pipelineJudges, resizeJudges } from './research-pipeline.mjs'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`

/* The pipeline rows: which vendor CLI, which exact model and which efforts.
   Prompt wording stays in Prompt design. The host keeps the draft
   retained beside the protocol decisions, previews the condition ids, and
   owns the Generate button (data-bench-generate-pipeline), which writes the
   conditions through the condition fields and attaches the harness files. */
export function createPipelineEditor({ onChange, settings = () => null, onOpenJudges = () => {}, onOpenPipeline = () => {} }) {
  const el = document.createElement('section'); el.className = 'pipeline-editor'
  const judgesEl = document.createElement('section'); judgesEl.className = 'pipeline-editor'
  let draft = emptyPipelineDraft(), locked = false
  const q = name => el.querySelector(`[data-pipe-${name}]`) || judgesEl.querySelector(`[data-pipe-${name}]`)
  const emit = () => onChange(structuredClone(draft))
  const preview = () => { const current = settings(); return current ? pipelineConditions(draft, current) : [] }

  function row(entry, i) {
    const surface = PIPELINE_SURFACES[entry.surface]
    return `<li class="pipe-row"><div class="pipe-row-line"><span class="pipe-index">${i + 1}</span>
      <label class="pipe-field">Surface<select data-pipe-surface="${i}">${Object.entries(PIPELINE_SURFACES).map(([id, item]) => option(id, item.label, entry.surface)).join('')}</select></label>
      <label class="pipe-field">Exact model id<input data-pipe-model="${i}" list="pipe-models-${i}" value="${esc(entry.model)}" maxlength="80" placeholder="${esc(surface.models[0])}"><datalist id="pipe-models-${i}">${surface.models.map(model => `<option value="${esc(model)}"></option>`).join('')}</datalist></label>
      <span class="pipe-efforts" role="group" aria-label="Efforts">${PIPELINE_EFFORTS.map(effort => `<label class="pipe-tick"><input type="checkbox" data-pipe-effort="${i}" value="${effort}"${entry.efforts.includes(effort) ? ' checked' : ''}><span>${effort}</span></label>`).join('')}</span>
      <button type="button" class="pipe-small pipe-drop" data-pipe-remove="${i}" aria-label="Remove">×</button></div>
      <label class="pipe-field pipe-exe">Executable <span class="pipe-meta">optional; the npm global install or PATH otherwise</span><input data-pipe-exe="${i}" value="${esc(entry.executable)}" maxlength="400" placeholder="C:/path/to/${esc(surface.short)}"></label></li>`
  }
  /* Judges: each is a model with its own prompt that reads a contestant's
     response. The person sets how many, which model and effort, and the
     prompt; nothing is prefilled. */
  function judge(entry, i) {
    const surface = PIPELINE_SURFACES[entry.surface]
    return `<li class="pipe-row pipe-judge"><div class="pipe-row-line"><span class="pipe-index" title="Judge ${i + 1}">J${i + 1}</span>
      <label class="pipe-field">Surface<select data-pipe-judge-surface="${i}">${Object.entries(PIPELINE_SURFACES).map(([id, item]) => option(id, item.label, entry.surface)).join('')}</select></label>
      <label class="pipe-field">Exact model id<input data-pipe-judge-model="${i}" list="pipe-judge-models-${i}" value="${esc(entry.model)}" maxlength="80" placeholder="${esc(surface.models[0])}"><datalist id="pipe-judge-models-${i}">${surface.models.map(model => `<option value="${esc(model)}"></option>`).join('')}</datalist></label>
      <label class="pipe-field">Effort<select data-pipe-judge-effort="${i}">${PIPELINE_EFFORTS.map(effort => option(effort, effort, entry.effort)).join('')}</select></label>
      <button type="button" class="pipe-small pipe-drop" data-pipe-judge-remove="${i}" aria-label="Remove judge ${i + 1}">×</button></div>
      <label class="pipe-field pipe-exe">Executable <span class="pipe-meta">optional; the npm global install or PATH otherwise</span><input data-pipe-judge-exe="${i}" value="${esc(entry.executable)}" maxlength="400" placeholder="C:/path/to/${esc(surface.short)}"></label>
      <label class="pipe-field pipe-prompt">Judge prompt <span class="pipe-meta">what this judge is asked about each response</span><textarea data-pipe-judge-prompt="${i}" rows="5" maxlength="${JUDGE_PROMPT_LIMIT}" placeholder="Write the instructions this judge follows for every response.">${esc(entry.prompt)}</textarea></label></li>`
  }
  function judgeStatus() {
    const written = pipelineJudges(draft), problems = judgeProblems(draft)
    const head = draft.judges.length ? `<b>${written.length}</b> of ${draft.judges.length} judge${draft.judges.length === 1 ? '' : 's'} will be written to <code>harness/surfaces.json</code>.` : 'No judges. A study graded only by its answer key needs none.'
    return head + problems.map(problem => `<span class="pipe-warn" data-pipe-judge-problem="${problem.kind}">${esc(problem.text)}</span>`).join('')
  }
  function refreshJudges() { const node = q('judge-status'); if (node) node.innerHTML = judgeStatus() }
  function render() {
    const conditions = preview()
    el.innerHTML = `<div class="pipe-head"><h3>LeanBench-style pipeline</h3>
      <p class="pipe-intro">Each row is a vendor CLI, an exact model and the efforts to run. Generate makes one condition for each surface × model × effort combination. Its command runs the generated harness with a fresh working directory, blank homes, the allowed environment and LeanBench's invocation flags. Each surface requires a canary from the same day. Provider notices and truncated responses stop collection. Attempt timeout comes from Schedule and budgets below. The output cap, room and canary rules come from the settings above. Prompt wording is used as authored in Prompt design.</p></div>
      <label class="pipe-field">Clean-room root<input data-pipe-root value="${esc(draft.root)}" maxlength="200" placeholder="C:/lbres"></label>
      <ol class="pipe-rows">${draft.rows.map(row).join('') || '<li class="pipe-hint">No surfaces yet.</li>'}</ol>
      ${draft.rows.some(row => row.noask) ? '<p class="pipe-hint" data-pipe-previous>Previous no-ask selections are kept with this draft for reference. New pipeline conditions use the authored prompt without an added instruction. Existing conditions remain in Systems and conditions below.</p>' : ''}
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-add>Add a surface</button></div>
      <p class="pipe-hint">Choose judging models and write their prompts in Judge audit. Generating this pipeline includes those judge settings.</p>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-open-judges>Configure judges</button></div>
      <p class="pipe-preview" data-pipe-preview>${conditions.length ? `<b>${conditions.length}</b> condition${conditions.length === 1 ? '' : 's'} will be generated: ${esc(conditions.map(item => item.id).join(', '))}` : 'Add a surface with a model and at least one effort to see the conditions.'}</p>
      <div class="pipe-actions"><button type="button" class="bench-primary" data-bench-generate-pipeline${conditions.length ? '' : ' disabled'}>Generate pipeline conditions and harness files</button></div>
      <p class="pipe-hint">Generating adds or updates these conditions through the condition fields below and attaches <code>harness/surfaces.json</code>, <code>harness/clean-room.mjs</code>, <code>harness/draw.mjs</code>, <code>harness/canary.mjs</code>, <code>harness/judge.mjs</code> and <code>harness/README.md</code> as project files. Existing conditions with other ids are kept. After collection, <code>node harness/judge.mjs</code> writes individual results to <code>results/judges/</code>. Command collectors run under the Test unfinished apparatus purpose. A counted experiment needs a registered execution contract, which the runner does not have yet. Review &amp; Run shows that verdict.</p>`
    judgesEl.innerHTML = `<div class="pipe-head"><h3>Judge models and prompts</h3>
      <p class="pipe-intro">Add a judge, then choose its surface, exact model, effort and prompt. Each judge reads the completed contestant responses and records its own verdict.</p></div>
      <label class="pipe-field">Number of judges<input type="number" data-pipe-judge-count min="0" max="${JUDGE_LIMIT}" step="1" value="${draft.judges.length}"></label>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-judge-add>Add judge</button></div>
      <ol class="pipe-rows">${draft.judges.map(judge).join('')}</ol>
      <p class="pipe-preview" data-pipe-judge-status>${judgeStatus()}</p>
      <p class="pipe-hint">Save the draft to retain these settings. Generate the pipeline in Decisions &amp; pipeline to include them in the exported project. After collection, run <code>node harness/judge.mjs</code> to record the verdicts.</p>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-open-pipeline>Open pipeline to generate harness</button></div>`
    disable()
  }
  function disable() {
    for (const section of [el, judgesEl]) for (const tag of ['button', 'input', 'select', 'textarea']) for (const node of section.querySelectorAll(tag)) {
      if (node.hasAttribute('data-pipe-open-judges') || node.hasAttribute('data-pipe-open-pipeline')) node.disabled = false
      else if (!(node.hasAttribute('data-bench-generate-pipeline') && !locked)) node.disabled = locked
    }
    q('judge-add').disabled = locked || draft.judges.length >= JUDGE_LIMIT
  }
  function refreshPreview() { const conditions = preview(), node = q('preview'); if (node) node.innerHTML = conditions.length ? `<b>${conditions.length}</b> condition${conditions.length === 1 ? '' : 's'} will be generated: ${esc(conditions.map(item => item.id).join(', '))}` : 'Add a surface with a model and at least one effort to see the conditions.'; const button = el.querySelector('[data-bench-generate-pipeline]'); if (button) button.disabled = locked || !conditions.length }

  for (const section of [el, judgesEl]) section.addEventListener('input', event => {
    const target = event.target, at = name => target.getAttribute(`data-pipe-${name}`)
    if (target.hasAttribute('data-pipe-root')) { draft.root = target.value.trim().slice(0, 200) || 'C:/lbres'; emit(); return }
    if (target.hasAttribute('data-pipe-model')) { draft.rows[Number(at('model'))].model = target.value.trim().slice(0, 80); refreshPreview(); refreshJudges(); emit(); return }
    if (target.hasAttribute('data-pipe-exe')) { draft.rows[Number(at('exe'))].executable = target.value.trim().slice(0, 400); emit(); return }
    if (target.hasAttribute('data-pipe-judge-model')) { draft.judges[Number(at('judge-model'))].model = target.value.trim().slice(0, 80); refreshJudges(); emit(); return }
    if (target.hasAttribute('data-pipe-judge-exe')) { draft.judges[Number(at('judge-exe'))].executable = target.value.trim().slice(0, 400); emit(); return }
    if (target.hasAttribute('data-pipe-judge-prompt')) { draft.judges[Number(at('judge-prompt'))].prompt = target.value.slice(0, JUDGE_PROMPT_LIMIT); refreshJudges(); emit() }
  })
  for (const section of [el, judgesEl]) section.addEventListener('change', event => {
    const target = event.target, at = name => target.getAttribute(`data-pipe-${name}`)
    if (target.hasAttribute('data-pipe-surface')) { const entry = draft.rows[Number(at('surface'))]; entry.surface = target.value; entry.model = entry.model || ''; render(); emit(); return }
    if (target.hasAttribute('data-pipe-effort')) { const effort = target.value, entry = draft.rows[Number(at('effort'))]; entry.efforts = PIPELINE_EFFORTS.filter(item => item === effort ? target.checked : entry.efforts.includes(item)); refreshPreview(); emit(); return }
    if (target.hasAttribute('data-pipe-judge-count')) { draft.judges = resizeJudges(draft.judges, target.value); render(); emit(); return }
    if (target.hasAttribute('data-pipe-judge-surface')) { draft.judges[Number(at('judge-surface'))].surface = target.value; render(); emit(); return }
    if (target.hasAttribute('data-pipe-judge-effort')) { draft.judges[Number(at('judge-effort'))].effort = target.value; emit() }
  })
  for (const section of [el, judgesEl]) section.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return
    if (button.hasAttribute('data-pipe-open-judges')) { onOpenJudges(); return }
    if (button.hasAttribute('data-pipe-open-pipeline')) { onOpenPipeline(); return }
    if (locked) return
    if (button.hasAttribute('data-pipe-add')) { if (draft.rows.length < 16) { const entry = emptyPipelineRow(); const used = new Set(draft.rows.map(item => item.surface)); entry.surface = Object.keys(PIPELINE_SURFACES).find(id => !used.has(id)) || 'claude-cli'; entry.model = PIPELINE_SURFACES[entry.surface].models[0]; draft.rows.push(entry); render(); emit() } }
    else if (button.hasAttribute('data-pipe-remove')) { draft.rows.splice(Number(button.getAttribute('data-pipe-remove')), 1); render(); emit() }
    else if (button.hasAttribute('data-pipe-judge-remove')) { draft.judges.splice(Number(button.getAttribute('data-pipe-judge-remove')), 1); render(); emit() }
    else if (button.hasAttribute('data-pipe-judge-add')) { draft.judges = resizeJudges(draft.judges, draft.judges.length + 1); render(); emit(); q(`judge-model="${draft.judges.length - 1}"`)?.focus() }
  })

  render()
  return {
    el, judgesEl,
    set(next) { draft = normalizePipelineDraft(next); render() },
    value: () => structuredClone(draft),
    refresh: () => refreshPreview(),
    setDisabled(value) { locked = !!value; disable(); refreshPreview() },
  }
}
