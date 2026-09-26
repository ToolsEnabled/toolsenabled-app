import { JUDGE_LIMIT, JUDGE_PROMPT_LIMIT, PIPELINE_EFFORTS, PIPELINE_SURFACES, VERDICT_FORMATS, VERDICT_RULES, emptyPipelineDraft, emptyPipelineRow, judgeProblems, normalizePipelineDraft, pipelineConditions, pipelineJudges, resizeJudges, rowProblems, verdictProblems } from './research-pipeline.mjs'
import { CREDENTIAL_NAME, CUSTOM_MODEL_LIMIT, MODEL_KINDS, emptyCustomModel, modelProblems } from './research-models.mjs'
import { RECORD_EVIDENCE_MODES, RECORD_FLAGS, RECORD_KEEP_DRAWS, RECORD_OUTPUT_MODES, applyRecordPolicy, recordProblems, recordSummary } from './research-record.mjs'
import { CUSTOM_TOOL_NAME, TOOL_PROFILE_LIMIT, TOOL_SERVER_LIMIT, describeToolServerPath, emptyToolProfile, emptyToolServer, toolCatalog, toolProblems } from './research-tools.mjs'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`
const ID = /^[a-z][a-z0-9_-]{0,39}$/
const slug = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
const lines = value => String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
const ids = list => list.map(item => item.id)
// A free id: the wanted one when it is well formed and unused, else the
// fallback, else the first numbered variant that is free.
function uniqueId(wanted, taken, fallback) {
  const root = ID.test(wanted) ? wanted : fallback
  if (!taken.includes(root)) return root
  let n = 2; while (taken.includes(`${root}-${n}`)) n++
  return `${root}-${n}`
}
const problemList = (problems, attr) => problems.map(problem => `<span class="pipe-warn" data-pipe-${attr}="${esc(problem.kind)}">${esc(problem.text)}</span>`).join('')
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// The desktop bridges when this page runs inside the app: the vault lists
// credential names and opens its own entry form; the agent host lists the
// ToolsEnabled tools. A page without them offers typed names only.
const bridge = name => (typeof window !== 'undefined' && window && window[name]) || null
// What a server is called when it is added from a path: the file or directory
// name without its extension, or the host of an address.
function nameFromPath(raw) {
  const value = String(raw).trim()
  if (/^https?:\/\//i.test(value)) { try { return new URL(value).hostname } catch (error) { return 'http server' } }
  const last = value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return last.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'server'
}
// One successful draw as draw.mjs builds it before the recording policy is
// applied, so the preview shows exactly what each toggle keeps or drops.
function sampleDraw(record) {
  const draw = { output: 'Working through it: 6 × 7.\nFINAL ANSWER: 42\n', identity: { provider: 'anthropic', id: 'claude-sonnet-5-20260901', surface: 'claude-cli', version: '2.1.0' },
    completion: { status: 'complete', reason: 'The surface returned a final message.' }, usage: { inputTokens: 812, outputTokens: 96, cachedInputTokens: 0, generationMs: 4210, toolCalls: 0, turns: 1 },
    harness: { surface: 'claude-cli', model: 'claude-sonnet-5', effort: 'max', tools: null, requestedModel: 'claude-sonnet-5', servedModel: 'claude-sonnet-5-20260901', argv: ['claude', '-p', '--model', 'claude-sonnet-5', '--effort', 'max', '--output-format', 'json'], wallMs: 4980, canary: 'CANARY-PASS-<utc day>.json', promptSha256: '<sha256 of the frozen prompt>', outputSha256: '<sha256 of the full text>', trial: 'task-1:claude-claude-sonnet-5-max:1', attempt: 1 } }
  // draw.mjs writes the evidence on a failed draw, or on every draw when the policy says always; this sample succeeded.
  if (record.evidence === 'always') draw.harness.evidence = { exit: 0, signal: null, spawnError: null, stderrTail: null, stdoutTail: null }
  return draw
}

/* The pipeline rows: which vendor CLI, which exact model, which efforts and
   which tool profile. Prompt wording stays in Prompt design. The host keeps
   the draft retained beside the protocol decisions, previews the condition
   ids, and owns the Generate button (data-bench-generate-pipeline), which
   writes the conditions through the condition fields and attaches the harness
   files. Three panels below the rows register what the rows name: tool
   profiles and tool servers, custom models with their vault credential names,
   and what each draw records. Judges and how their verdicts are read live on
   Judge audit (judgesEl). */
export function createPipelineEditor({ onChange, settings = () => null, onOpenJudges = () => {}, onOpenPipeline = () => {} }) {
  const el = document.createElement('section'); el.className = 'pipeline-editor'
  const judgesEl = document.createElement('section'); judgesEl.className = 'pipeline-editor'
  let draft = emptyPipelineDraft(), locked = false, open = new Set(), describePath = '', serverNote = '', vaultNames = null, vaultNote = ''
  const q = name => el.querySelector(`[data-pipe-${name}]`) || judgesEl.querySelector(`[data-pipe-${name}]`)
  const emit = () => onChange(structuredClone(draft))
  const preview = () => { const current = settings(); return current ? pipelineConditions(draft, current) : [] }
  const vault = () => bridge('mcVault'), agent = () => bridge('mcAgent')
  const profileLabel = profile => profile.label || profile.id
  const modelLabel = model => model.name || model.id

  // The model control: an exact id typed against the surface's known models, or
  // for the http surface one of the registered custom models.
  function modelControl(attr, i, entry) {
    const surface = PIPELINE_SURFACES[entry.surface]
    if (entry.surface === 'http') {
      const missing = entry.model && !draft.models.some(model => model.id === entry.model)
      return `<label class="pipe-field">Custom model<select data-pipe-${attr}="${i}">${option('', draft.models.length ? 'Choose a registered model' : 'No custom model registered yet', entry.model)}${draft.models.map(model => option(model.id, modelLabel(model), entry.model)).join('')}${missing ? option(entry.model, entry.model + ' (not registered)', entry.model) : ''}</select></label>`
    }
    return `<label class="pipe-field">Exact model id<input data-pipe-${attr}="${i}" list="pipe-${attr}s-${i}" value="${esc(entry.model)}" maxlength="80" placeholder="${esc(surface.models[0])}"><datalist id="pipe-${attr}s-${i}">${surface.models.map(model => `<option value="${esc(model)}"></option>`).join('')}</datalist></label>`
  }
  const executableControl = (attr, i, entry) => entry.surface === 'http' ? '' : `<label class="pipe-field pipe-exe">Executable <span class="pipe-meta">optional; the npm global install or PATH otherwise</span><input data-pipe-${attr}="${i}" value="${esc(entry.executable)}" maxlength="400" placeholder="C:/path/to/${esc(PIPELINE_SURFACES[entry.surface].short)}"></label>`
  function row(entry, i) {
    const missing = entry.tools && !draft.tools.profiles.some(profile => profile.id === entry.tools)
    return `<li class="pipe-row"><div class="pipe-row-line"><span class="pipe-index">${i + 1}</span>
      <label class="pipe-field">Surface<select data-pipe-surface="${i}">${Object.entries(PIPELINE_SURFACES).map(([id, item]) => option(id, item.label, entry.surface)).join('')}</select></label>
      ${modelControl('model', i, entry)}
      <span class="pipe-efforts" role="group" aria-label="Efforts">${PIPELINE_EFFORTS.map(effort => `<label class="pipe-tick"><input type="checkbox" data-pipe-effort="${i}" value="${effort}"${entry.efforts.includes(effort) ? ' checked' : ''}><span>${effort}</span></label>`).join('')}</span>
      <label class="pipe-field">Tools<select data-pipe-tools="${i}">${option('', 'Tools off (LeanBench default)', entry.tools)}${draft.tools.profiles.map(profile => option(profile.id, profileLabel(profile), entry.tools)).join('')}${missing ? option(entry.tools, entry.tools + ' (no such profile)', entry.tools) : ''}</select></label>
      <button type="button" class="pipe-small pipe-drop" data-pipe-remove="${i}" aria-label="Remove">×</button></div>
      ${executableControl('exe', i, entry)}</li>`
  }
  /* Judges: each is a model with its own prompt that reads a contestant's
     response. The person sets how many, which model and effort, and the
     prompt; nothing is prefilled. */
  function judge(entry, i) {
    return `<li class="pipe-row pipe-judge"><div class="pipe-row-line"><span class="pipe-index" title="Judge ${i + 1}">J${i + 1}</span>
      <label class="pipe-field">Surface<select data-pipe-judge-surface="${i}">${Object.entries(PIPELINE_SURFACES).map(([id, item]) => option(id, item.label, entry.surface)).join('')}</select></label>
      ${modelControl('judge-model', i, entry)}
      <label class="pipe-field">Effort<select data-pipe-judge-effort="${i}">${PIPELINE_EFFORTS.map(effort => option(effort, effort, entry.effort)).join('')}</select></label>
      <button type="button" class="pipe-small pipe-drop" data-pipe-judge-remove="${i}" aria-label="Remove judge ${i + 1}">×</button></div>
      ${executableControl('judge-exe', i, entry)}
      <label class="pipe-field pipe-prompt">Judge prompt <span class="pipe-meta">what this judge is asked about each response</span><textarea data-pipe-judge-prompt="${i}" rows="5" maxlength="${JUDGE_PROMPT_LIMIT}" placeholder="Write the instructions this judge follows for every response.">${esc(entry.prompt)}</textarea></label></li>`
  }
  function judgeStatus() {
    const written = pipelineJudges(draft), problems = judgeProblems(draft)
    const head = draft.judges.length ? `<b>${written.length}</b> of ${draft.judges.length} judge${draft.judges.length === 1 ? '' : 's'} will be written to <code>harness/surfaces.json</code>.` : 'No judges. A study graded only by its answer key needs none.'
    return head + problemList(problems, 'judge-problem')
  }
  /* How verdicts are read after node harness/judge.mjs: kept as text, or
     parsed as a score or a PASS/FAIL word and combined by a rule. */
  function verdictStatus() {
    const v = draft.verdicts, rule = (VERDICT_RULES.find(([id]) => id === v.rule) || VERDICT_RULES[0])[1].toLowerCase()
    const head = v.format === 'text' ? 'Verdicts are kept as written; nothing is scored.'
      : `${v.format === 'score' ? `Each verdict is read as a score out of ${v.scale}` : 'Each verdict is read as PASS or FAIL'}; the summary passes when ${rule}${v.rule === 'mean' ? ` (${v.threshold})` : ''}.`
    return head + problemList(verdictProblems(draft), 'verdict-problem')
  }
  function verdictsBlock() {
    const v = draft.verdicts
    return `<section class="pipe-verdicts" data-pipe-verdicts><h4>Judge verdicts</h4>
      <p class="pipe-hint">How each verdict is read once <code>node harness/judge.mjs</code> has collected them. A score or a PASS/FAIL word is parsed from the text and the judges are combined by the rule; free text is kept as written. The summary stands beside the registered grade and never replaces it.</p>
      <div class="pipe-row-line"><label class="pipe-field">Format<select data-pipe-verdict-format>${VERDICT_FORMATS.map(([id, label]) => option(id, label, v.format)).join('')}</select></label>
      <label class="pipe-field">Scale<select data-pipe-verdict-scale>${[1, 10, 100].map(n => option(String(n), n === 1 ? '0 to 1' : `0 to ${n}`, String(v.scale))).join('')}</select></label>
      <label class="pipe-field">Threshold <span class="pipe-meta">0 to 1 of the scale</span><input type="number" data-pipe-verdict-threshold min="0" max="1" step="0.05" value="${esc(v.threshold)}"></label>
      <label class="pipe-field">Rule<select data-pipe-verdict-rule>${VERDICT_RULES.map(([id, label]) => option(id, label, v.rule)).join('')}</select></label></div>
      <label class="pipe-field pipe-exe">Verdict pattern <span class="pipe-meta">optional; group 1 is the score or the word, matched case-insensitively</span><input data-pipe-verdict-pattern value="${esc(v.pattern)}" maxlength="400" placeholder="SCORE:\\s*(\\d+(?:\\.\\d+)?)" spellcheck="false"></label>
      <p class="pipe-preview" data-pipe-verdict-status></p></section>`
  }

  /* Tools and custom tool servers: a profile is a named set of enabled tools a
     row runs under; a server is the person's own MCP program or address. */
  const groupLabel = group => PIPELINE_SURFACES[group] ? `${PIPELINE_SURFACES[group].short} built-in tools` : `Server ${draft.tools.servers.find(server => 'server:' + server.id === group)?.name || group.slice(7)}`
  function profile(entry, i, catalog) {
    const groups = [...new Set(catalog.map(item => item.group))]
    return `<li class="pipe-row pipe-profile" data-pipe-profile="${i}"><div class="pipe-row-line"><span class="pipe-index" title="Profile ${i + 1}">P${i + 1}</span>
      <label class="pipe-field">Profile name<input data-pipe-profile-label="${i}" value="${esc(entry.label)}" maxlength="80" placeholder="Read only"></label>
      <span class="pipe-meta">id <code data-pipe-profile-id="${i}">${esc(entry.id)}</code>, the condition id suffix</span>
      <button type="button" class="pipe-small pipe-drop" data-pipe-profile-remove="${i}" aria-label="Remove profile ${i + 1}">×</button></div>
      <div class="pipe-catalog">${groups.map(group => `<fieldset class="pipe-catalog-group"><legend>${esc(groupLabel(group))}</legend>${catalog.filter(item => item.group === group).map(item => `<label class="pipe-tick pipe-catalog-tool"><input type="checkbox" data-pipe-profile-tool="${i}" value="${esc(item.id)}"${entry.enabled.includes(item.id) ? ' checked' : ''}><span>${esc(item.tool === '*' ? 'Every tool' : item.tool)}</span><span class="pipe-meta">${esc(item.access)} · ${esc(item.text)}</span></label>`).join('')}</fieldset>`).join('')}</div>
      <label class="pipe-field pipe-exe">Note <span class="pipe-meta">optional</span><input data-pipe-profile-note="${i}" value="${esc(entry.note)}" maxlength="400"></label></li>`
  }
  function server(entry, i) {
    return `<li class="pipe-row pipe-server" data-pipe-server="${i}"><div class="pipe-row-line"><span class="pipe-index" title="Server ${i + 1}">S${i + 1}</span>
      <label class="pipe-field">Name<input data-pipe-server-name="${i}" value="${esc(entry.name)}" maxlength="80" placeholder="My retrieval index"></label>
      <span class="pipe-meta">id <code data-pipe-server-id="${i}">${esc(entry.id)}</code></span>
      <label class="pipe-field">Kind<select data-pipe-server-kind="${i}">${option('stdio', 'A program this computer starts (stdio)', entry.kind)}${option('http', 'An address it already answers at (http)', entry.kind)}</select></label>
      <button type="button" class="pipe-small pipe-drop" data-pipe-server-remove="${i}" aria-label="Remove server ${i + 1}">×</button></div>
      ${entry.kind === 'http' ? `<label class="pipe-field pipe-exe">URL<input data-pipe-server-url="${i}" value="${esc(entry.url)}" maxlength="400" placeholder="http://127.0.0.1:8765/mcp"></label>`
        : `<label class="pipe-field pipe-exe">Command<input data-pipe-server-command="${i}" value="${esc(entry.command)}" maxlength="400" placeholder="python"></label>
      <label class="pipe-field pipe-prompt">Arguments <span class="pipe-meta">one per line</span><textarea data-pipe-server-args="${i}" rows="2" placeholder="C:/tools/rag/server.py">${esc(entry.args.join('\n'))}</textarea></label>`}
      <div class="pipe-row-line"><label class="pipe-field pipe-prompt">Tools it offers <span class="pipe-meta">one name per line; a profile can enable the whole server without them</span><textarea data-pipe-server-tools="${i}" rows="2" placeholder="search_index">${esc(entry.tools.join('\n'))}</textarea></label>
      <label class="pipe-field pipe-prompt">Environment variable names it needs <span class="pipe-meta">names only, one per line; values stay on the run computer</span><textarea data-pipe-server-env="${i}" rows="2" placeholder="RAG_INDEX_DIR">${esc(entry.env.join('\n'))}</textarea></label></div>
      <label class="pipe-field pipe-exe">Note <span class="pipe-meta">optional</span><input data-pipe-server-note="${i}" value="${esc(entry.note)}" maxlength="400"></label>
      ${entry.path ? `<p class="pipe-hint">Described from <code>${esc(entry.path)}</code>.</p>` : ''}</li>`
  }
  function toolsPanel(catalog) {
    const listsTools = typeof agent()?.tools === 'function'
    return `<details class="pipe-panel" data-pipe-panel="tools"${open.has('tools') ? ' open' : ''}><summary><span class="pipe-panel-title">Tools and custom tool servers</span><span class="pipe-meta" data-pipe-panel-meta="tools"></span></summary>
      <p class="pipe-hint">A profile names the tools a row may use: the vendor CLI's own tools, and any tool of a server you register. A row with no profile runs tools off, LeanBench's default. Each profile is translated per surface into <code>harness/surfaces.json</code>; a write, run or network tool opens the CLI's sandbox and approval mode, and that is recorded.</p>
      <h4>Tool profiles</h4>
      <ol class="pipe-rows">${draft.tools.profiles.map((entry, i) => profile(entry, i, catalog)).join('') || '<li class="pipe-hint">No profiles: every row runs with tools off.</li>'}</ol>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-profile-add>Add a profile</button></div>
      <h4>Tool servers</h4>
      <p class="pipe-hint">Your own programs spoken to over the Model Context Protocol: a retrieval index, a compiler feedback loop. Nothing here holds a secret; a server's environment is named, never valued.</p>
      <ol class="pipe-rows">${draft.tools.servers.map(server).join('') || '<li class="pipe-hint">No servers registered.</li>'}</ol>
      <div class="pipe-row-line pipe-describe"><label class="pipe-field">Add a server from its path or address<input data-pipe-server-path value="${esc(describePath)}" maxlength="400" placeholder="C:/tools/rag/server.py or http://127.0.0.1:8765/mcp" spellcheck="false"></label>
      <button type="button" class="pipe-small" data-pipe-server-describe>Describe</button><button type="button" class="pipe-small" data-pipe-server-add>Add a server by hand</button>${listsTools ? '<button type="button" class="pipe-small" data-pipe-server-toolsenabled>Add the ToolsEnabled tools as a server</button>' : ''}</div>
      <p class="pipe-hint" data-pipe-server-status></p>
      <p class="pipe-preview" data-pipe-tool-problems></p></details>`
  }
  /* Models and API keys: an HTTP endpoint the person names. The key stays in
     the vault under a credential name; only the name travels. */
  function model(entry, i) {
    const kind = MODEL_KINDS[entry.kind], api = vault()
    return `<li class="pipe-row pipe-model" data-pipe-model-row="${i}"><div class="pipe-row-line"><span class="pipe-index" title="Model ${i + 1}">M${i + 1}</span>
      <label class="pipe-field">Name<input data-pipe-model-name="${i}" value="${esc(entry.name)}" maxlength="80" placeholder="Lean prover 7B"></label>
      <span class="pipe-meta">id <code data-pipe-model-id-text="${i}">${esc(entry.id)}</code></span>
      <label class="pipe-field">API kind<select data-pipe-model-kind="${i}">${Object.entries(MODEL_KINDS).map(([id, item]) => option(id, item.label, entry.kind)).join('')}</select></label>
      <button type="button" class="pipe-small pipe-drop" data-pipe-model-remove="${i}" aria-label="Remove model ${i + 1}">×</button></div>
      <label class="pipe-field pipe-exe">Endpoint URL <span class="pipe-meta">${kind.url ? 'the kind\'s default when empty' : 'required for your own endpoint'}</span><input data-pipe-model-url="${i}" value="${esc(entry.url)}" maxlength="400" placeholder="${esc(kind.url || 'https://models.example.org/v1/generate')}" spellcheck="false"></label>
      <div class="pipe-row-line"><label class="pipe-field">Model id the endpoint expects<input data-pipe-model-id="${i}" value="${esc(entry.model)}" maxlength="120" placeholder="my-model-7b" spellcheck="false"></label>
      <label class="pipe-field">Provider label <span class="pipe-meta">optional; for accounting</span><input data-pipe-model-provider="${i}" value="${esc(entry.provider)}" maxlength="40" placeholder="${esc(entry.kind.split('-')[0])}"></label></div>
      <div class="pipe-row-line">${vaultNames ? `<label class="pipe-field">From the vault<select data-pipe-model-credential-pick="${i}">${option('', 'Choose a credential name', vaultNames.includes(entry.credential) ? entry.credential : '')}${vaultNames.map(name => option(name, name, entry.credential)).join('')}</select></label>` : ''}
      <label class="pipe-field">Credential name<input data-pipe-model-credential="${i}" value="${esc(entry.credential)}" maxlength="100" placeholder="LEAN_KEY" spellcheck="false"></label>
      ${typeof api?.add === 'function' ? `<button type="button" class="pipe-small" data-pipe-model-vault-add="${i}">Add to the vault</button>` : ''}</div></li>`
  }
  function modelsPanel() {
    const api = vault()
    return `<details class="pipe-panel" data-pipe-panel="models"${open.has('models') ? ' open' : ''}><summary><span class="pipe-panel-title">Models and API keys</span><span class="pipe-meta" data-pipe-panel-meta="models"></span></summary>
      <p class="pipe-hint">A custom model is an HTTP endpoint you name. A row or a judge on the Custom endpoint surface picks it by name. Its API key never enters this page: name the vault credential that holds it. The export and <code>harness/surfaces.json</code> carry the name only. Before <code>node cli.mjs run</code>, set the environment variable of that name on the run computer. The harness reads it from its own environment and sends it in one request header.</p>
      <ol class="pipe-rows">${draft.models.map(model).join('') || '<li class="pipe-hint">No custom models registered.</li>'}</ol>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-model-add>Add a custom model</button>${typeof api?.names === 'function' ? '<button type="button" class="pipe-small" data-pipe-vault-refresh>Refresh vault names</button>' : ''}</div>
      <p class="pipe-hint" data-pipe-vault-status></p>
      <p class="pipe-preview" data-pipe-model-problems></p></details>`
  }
  /* What each draw records: the harness always computes the full envelope;
     this says which of it the retained response keeps. */
  function recordPanel() {
    const r = draft.record
    return `<details class="pipe-panel" data-pipe-panel="record"${open.has('record') ? ' open' : ''}><summary><span class="pipe-panel-title">What each draw records</span><span class="pipe-meta" data-pipe-panel-meta="record"></span></summary>
      <p class="pipe-hint">The harness records everything about every draw: the response text, the served identity, token usage, timing, the command line and the failure details. This registers which of it the retained response keeps. Dropping a field is a decision of record, visible in <code>harness/surfaces.json</code> and the frozen input manifest.</p>
      <span class="pipe-efforts" role="group" aria-label="Output">${RECORD_OUTPUT_MODES.map(([id, label]) => `<label class="pipe-tick"><input type="radio" name="pipe-record-output" data-pipe-record-output value="${id}"${r.output === id ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('')}</span>
      <div class="pipe-row-line" data-pipe-record-extraction${r.output === 'extracted' ? '' : ' hidden'}><label class="pipe-field pipe-exe">Extraction pattern <span class="pipe-meta">group 1 when the pattern has one, else the whole match</span><input data-pipe-record-pattern value="${esc(r.pattern)}" maxlength="2000" placeholder="FINAL ANSWER:\\s*(.+)" spellcheck="false"></label><label class="pipe-field">Flags<input data-pipe-record-flags value="${esc(r.flags)}" maxlength="6" placeholder="is"></label></div>
      <span class="pipe-efforts" role="group" aria-label="Fields kept">${RECORD_FLAGS.map(([key, label, text]) => `<label class="pipe-tick" title="${esc(text)}"><input type="checkbox" data-pipe-record-flag="${key}"${r[key] ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('')}</span>
      <label class="pipe-field">Keep the CLI's status and printed output<select data-pipe-record-evidence>${RECORD_EVIDENCE_MODES.map(([id, label]) => option(id, label, r.evidence)).join('')}</select></label>
      <label class="pipe-tick" title="${esc(RECORD_KEEP_DRAWS[2])}"><input type="checkbox" data-pipe-record-keep${r.keepDraws ? ' checked' : ''}><span>${esc(RECORD_KEEP_DRAWS[1])}</span></label>
      <p class="pipe-preview" data-pipe-record-summary></p>
      <p class="pipe-preview" data-pipe-record-problems></p>
      <details class="pipe-sample"><summary>A sample draw as it would be recorded</summary><pre data-pipe-record-preview tabindex="0"></pre></details></details>`
  }

  // reveal names a panel to open after this render, for an action taken inside it.
  function render(reveal) {
    openState(); if (reveal) open.add(reveal)
    const catalog = toolCatalog(draft.tools)
    el.innerHTML = `<div class="pipe-head"><h3>LeanBench-style pipeline</h3>
      <p class="pipe-intro">Each row is a vendor CLI, an exact model and the efforts to run. Generate makes one condition for each surface × model × effort combination. Its command runs the generated harness with a fresh working directory, blank homes, the allowed environment and LeanBench's invocation flags. Each surface requires a canary from the same day. Provider notices and truncated responses stop collection. Attempt timeout comes from Schedule and budgets below. The output cap, room and canary rules come from the settings above. Prompt wording is used as authored in Prompt design.</p></div>
      <label class="pipe-field">Clean-room root<input data-pipe-root value="${esc(draft.root)}" maxlength="200" placeholder="C:/cleanroom"></label>
      <ol class="pipe-rows">${draft.rows.map(row).join('') || '<li class="pipe-hint">No surfaces yet.</li>'}</ol>
      ${draft.rows.some(row => row.noask) ? '<p class="pipe-hint" data-pipe-previous>Previous no-ask selections are kept with this draft for reference. New pipeline conditions use the authored prompt without an added instruction. Existing conditions remain in Systems and conditions below.</p>' : ''}
      <p class="pipe-preview" data-pipe-row-problems hidden></p>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-add>Add a surface</button></div>
      ${toolsPanel(catalog)}
      ${modelsPanel()}
      ${recordPanel()}
      <p class="pipe-hint">Choose judging models and write their prompts in Judge audit. Generating this pipeline includes those judge settings.</p>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-open-judges>Configure judges</button></div>
      <p class="pipe-preview" data-pipe-preview></p>
      <div class="pipe-actions"><button type="button" class="bench-primary" data-bench-generate-pipeline>Generate pipeline conditions and harness files</button></div>
      <p class="pipe-hint">Generating adds or updates these conditions through the condition fields below and attaches <code>harness/surfaces.json</code>, <code>harness/clean-room.mjs</code>, <code>harness/draw.mjs</code>, <code>harness/canary.mjs</code>, <code>harness/judge.mjs</code> and <code>harness/README.md</code> as project files. Existing conditions with other ids are kept. After collection, <code>node harness/judge.mjs</code> writes individual results to <code>results/judges/</code>. Command collectors run under the Test unfinished apparatus purpose. A counted experiment needs a registered execution contract, which the runner does not have yet. Review &amp; Run shows that verdict.</p>`
    judgesEl.innerHTML = `<div class="pipe-head"><h3>Judge models and prompts</h3>
      <p class="pipe-intro">Add a judge, then choose its surface, exact model, effort and prompt. Each judge reads the completed contestant responses and records its own verdict.</p></div>
      <label class="pipe-field">Number of judges<input type="number" data-pipe-judge-count min="0" max="${JUDGE_LIMIT}" step="1" value="${draft.judges.length}"></label>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-judge-add>Add judge</button></div>
      <ol class="pipe-rows">${draft.judges.map(judge).join('')}</ol>
      <p class="pipe-preview" data-pipe-judge-status></p>
      ${verdictsBlock()}
      <p class="pipe-hint">Save the draft to retain these settings. Generate the pipeline in Decisions &amp; pipeline to include them in the exported project. After collection, run <code>node harness/judge.mjs</code> to record the verdicts.</p>
      <div class="pipe-actions"><button type="button" class="pipe-small" data-pipe-open-pipeline>Open pipeline to generate harness</button></div>`
    refreshPreview(); refreshTools(); refreshModels(); refreshRecord(); refreshJudges()
    disable()
  }
  function disable() {
    for (const section of [el, judgesEl]) for (const tag of ['button', 'input', 'select', 'textarea']) for (const node of section.querySelectorAll(tag)) {
      if (node.hasAttribute('data-pipe-open-judges') || node.hasAttribute('data-pipe-open-pipeline')) node.disabled = false
      else if (!(node.hasAttribute('data-bench-generate-pipeline') && !locked)) node.disabled = locked
    }
    q('judge-add').disabled = locked || draft.judges.length >= JUDGE_LIMIT
    q('profile-add').disabled = locked || draft.tools.profiles.length >= TOOL_PROFILE_LIMIT
    for (const name of ['server-add', 'server-describe', 'server-toolsenabled']) { const node = q(name); if (node) node.disabled = locked || draft.tools.servers.length >= TOOL_SERVER_LIMIT }
    q('model-add').disabled = locked || draft.models.length >= CUSTOM_MODEL_LIMIT
  }
  const openState = () => { const panels = [...el.querySelectorAll('[data-pipe-panel]')]; if (panels.length) open = new Set(panels.filter(node => node.open).map(node => node.getAttribute('data-pipe-panel'))) }
  const meta = (name, text) => { const node = q(`panel-meta="${name}"`); if (node) node.textContent = text }
  function refreshPreview() {
    const conditions = preview(), node = q('preview')
    if (node) node.innerHTML = conditions.length ? `<b>${conditions.length}</b> condition${conditions.length === 1 ? '' : 's'} will be generated: ${esc(conditions.map(item => item.id).join(', '))}` : 'Add a surface with a model and at least one effort to see the conditions.'
    const button = el.querySelector('[data-bench-generate-pipeline]'); if (button) button.disabled = locked || !conditions.length
    const problems = rowProblems(draft), rows = q('row-problems')
    if (rows) { rows.innerHTML = problemList(problems, 'row-problem'); rows.hidden = !problems.length }
  }
  function refreshTools() {
    const problems = toolProblems(draft.tools, draft.rows), profiles = draft.tools.profiles.length, servers = draft.tools.servers.length
    const head = profiles || servers ? `<b>${profiles}</b> profile${profiles === 1 ? '' : 's'} and <b>${servers}</b> server${servers === 1 ? '' : 's'}. A row runs tools off unless it names a profile.` : 'No profiles: every row runs with tools off, LeanBench\'s default.'
    const node = q('tool-problems'); if (node) node.innerHTML = head + problemList(problems, 'tool-problem')
    const status = q('server-status'); if (status) status.textContent = serverNote
    meta('tools', `${plural(profiles, 'profile')} · ${plural(servers, 'server')}${problems.length ? ` · ${plural(problems.length, 'check')}` : ''}`)
  }
  function refreshModels() {
    const problems = modelProblems(draft.models, vaultNames)
    const head = draft.models.length ? `<b>${draft.models.length}</b> custom model${draft.models.length === 1 ? '' : 's'} registered; the credential names go into <code>harness/surfaces.json</code>, never a value.` : 'No custom models. Rows on the Custom endpoint surface need one.'
    const node = q('model-problems'); if (node) node.innerHTML = head + problemList(problems, 'model-problem')
    const status = q('vault-status'); if (status) status.textContent = vaultNote
    meta('models', `${plural(draft.models.length, 'model')}${vaultNames ? ` · ${plural(vaultNames.length, 'vault name')}` : ''}${problems.length ? ` · ${plural(problems.length, 'check')}` : ''}`)
  }
  function refreshRecord() {
    const extraction = q('record-extraction'); if (extraction) extraction.hidden = draft.record.output !== 'extracted'
    const summary = q('record-summary'); if (summary) summary.textContent = recordSummary(draft.record)
    const problems = recordProblems(draft.record), node = q('record-problems'); if (node) node.innerHTML = problemList(problems, 'record-problem')
    const preview = q('record-preview'); if (preview) preview.textContent = JSON.stringify(applyRecordPolicy(draft.record, sampleDraw(draft.record)), null, 1)
    meta('record', `${draft.record.output === 'extracted' ? 'extracted output' : 'full output'} · evidence ${draft.record.evidence}${problems.length ? ` · ${plural(problems.length, 'check')}` : ''}`)
  }
  function refreshJudges() {
    const node = q('judge-status'); if (node) node.innerHTML = judgeStatus()
    const verdicts = q('verdict-status'); if (verdicts) verdicts.innerHTML = verdictStatus()
  }

  // The id follows the name once the person has finished typing it, so a
  // condition reads claude-…-max-read-only rather than -profile-2, and every
  // row, judge or profile that named the old id is re-pointed. A name whose
  // slug is taken or malformed leaves the id as it was.
  function rename(list, index, wanted, repoint) {
    const item = list[index], next = slug(wanted)
    if (!item || !ID.test(next) || next === item.id || list.some(other => other !== item && other.id === next)) return
    const previous = item.id; item.id = next; repoint(previous, next)
  }
  const renameProfile = (index, wanted) => rename(draft.tools.profiles, index, wanted, (previous, next) => { for (const row of draft.rows) if (row.tools === previous) row.tools = next })
  const renameServer = (index, wanted) => rename(draft.tools.servers, index, wanted, (previous, next) => { for (const profile of draft.tools.profiles) profile.enabled = profile.enabled.map(id => id === `server/${previous}` ? `server/${next}` : id.startsWith(`server/${previous}/`) ? `server/${next}/` + id.slice(previous.length + 8) : id) })
  const renameModel = (index, wanted) => rename(draft.models, index, wanted, (previous, next) => { for (const item of [...draft.rows, ...draft.judges]) if (item.surface === 'http' && item.model === previous) item.model = next })
  function addServer(entry) {
    if (draft.tools.servers.length >= TOOL_SERVER_LIMIT) { serverNote = `This draft already has ${TOOL_SERVER_LIMIT} tool servers.`; refreshTools(); return false }
    draft.tools.servers.push(entry); return true
  }
  // The vault's credential NAMES, never values: custom.LEAN_KEY is offered as
  // LEAN_KEY. Read at mount and on request; without a vault, names are typed.
  async function readVault() {
    const api = vault()
    if (typeof api?.names !== 'function') { vaultNames = null; vaultNote = 'No vault is reachable from this page, so credential names are typed. The run computer sets the variable of each name.'; return }
    let answer = null
    try { answer = await api.names() } catch (error) { answer = { ok: false, reason: error.message } }
    if (answer?.ok === true && Array.isArray(answer.names)) {
      vaultNames = [...new Set(answer.names.map(name => String(name ?? '').replace(/^custom\./, '')).filter(name => CREDENTIAL_NAME.test(name)))]
      vaultNote = `${plural(vaultNames.length, 'credential name')} read from the vault. Values never leave it.`
    } else { vaultNames = null; vaultNote = (answer?.reason || 'The vault could not be read') + ', so credential names are typed.' }
    render()
  }
  // Opens the vault's own entry form for the named credential. The value is
  // typed there; nothing of it passes through this page.
  async function addToVault(entry) {
    const api = vault(); if (!entry || typeof api?.add !== 'function') return
    if (!CREDENTIAL_NAME.test(entry.credential)) { vaultNote = 'Name the credential in capital letters, digits and underscores, starting with a letter.'; refreshModels(); return }
    let answer = null
    try { answer = await api.add({ credential: 'custom', customName: entry.credential }) } catch (error) { answer = { ok: false, reason: error.message } }
    vaultNote = answer?.ok === true ? `The vault is asking for the value of ${entry.credential} in its own form. Refresh the names once it is saved.` : (answer?.reason || 'The vault could not open its entry form, so nothing was asked for.')
    refreshModels()
  }
  // The ToolsEnabled tools as one MCP server: the names come from the agent
  // host with dots replaced by underscores, as MCP names them; the command
  // that starts the server on the run computer is left for the person.
  async function addToolsEnabledServer() {
    const api = agent(); if (typeof api?.tools !== 'function') return
    let answer = null
    try { answer = await api.tools() } catch (error) { answer = { ok: false, reason: error.message } }
    if (answer?.ok !== true || !Array.isArray(answer.tools)) { serverNote = 'The ToolsEnabled tools could not be listed: ' + (answer?.reason || 'no answer from the agent host') + '.'; refreshTools(); return }
    const names = [...new Set(answer.tools.map(tool => String(tool?.name ?? '').replace(/\./g, '_')).filter(name => CUSTOM_TOOL_NAME.test(name)))]
    const existing = draft.tools.servers.find(item => item.id === 'toolsenabled')
    if (existing) existing.tools = names.slice(0, 64)
    else if (!addServer({ ...emptyToolServer(), id: 'toolsenabled', name: 'ToolsEnabled tools over MCP', kind: 'stdio', tools: names.slice(0, 64) })) return
    serverNote = `${plural(names.length, 'ToolsEnabled tool')} declared${names.length > 64 ? ' (the first 64 are kept)' : ''} on the server toolsenabled. Fill in the command that starts it on the run computer.`
    render('tools'); emit()
  }

  for (const section of [el, judgesEl]) section.addEventListener('input', event => {
    const target = event.target, at = name => target.getAttribute(`data-pipe-${name}`), has = name => target.hasAttribute(`data-pipe-${name}`), index = name => Number(at(name))
    if (target.tagName === 'SELECT' || ['checkbox', 'radio'].includes(target.getAttribute('type'))) return
    if (has('root')) { draft.root = target.value.trim().slice(0, 200) || 'C:/cleanroom'; emit(); return }
    if (has('model')) { draft.rows[index('model')].model = target.value.trim().slice(0, 80); refreshPreview(); refreshJudges(); emit(); return }
    if (has('exe')) { draft.rows[index('exe')].executable = target.value.trim().slice(0, 400); emit(); return }
    if (has('judge-model')) { draft.judges[index('judge-model')].model = target.value.trim().slice(0, 80); refreshJudges(); emit(); return }
    if (has('judge-exe')) { draft.judges[index('judge-exe')].executable = target.value.trim().slice(0, 400); emit(); return }
    if (has('judge-prompt')) { draft.judges[index('judge-prompt')].prompt = target.value.slice(0, JUDGE_PROMPT_LIMIT); refreshJudges(); emit(); return }
    if (has('profile-label')) { draft.tools.profiles[index('profile-label')].label = target.value.trim().slice(0, 80); refreshTools(); emit(); return }
    if (has('profile-note')) { draft.tools.profiles[index('profile-note')].note = target.value.trim().slice(0, 400); emit(); return }
    if (has('server-path')) { describePath = target.value; return }
    const server = ['name', 'command', 'args', 'url', 'tools', 'env', 'note'].find(name => has(`server-${name}`))
    if (server) {
      const entry = draft.tools.servers[index(`server-${server}`)]
      if (server === 'args') entry.args = lines(target.value).slice(0, 32)
      else if (server === 'tools') entry.tools = [...new Set(lines(target.value).filter(name => CUSTOM_TOOL_NAME.test(name)))].slice(0, 64)
      else if (server === 'env') entry.env = [...new Set(lines(target.value).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))].slice(0, 16)
      else entry[server] = target.value.trim().slice(0, server === 'name' ? 80 : 400)
      refreshTools(); emit(); return
    }
    const model = ['name', 'url', 'id', 'provider', 'credential'].find(name => has(`model-${name}`))
    if (model) {
      const i = index(`model-${model}`), entry = draft.models[i], value = target.value.trim()
      if (model === 'id') entry.model = value.slice(0, 120)
      else entry[model] = value.slice(0, model === 'url' ? 400 : model === 'credential' ? 100 : model === 'provider' ? 40 : 80)
      if (model === 'credential') { const pick = q(`model-credential-pick="${i}"`); if (pick) pick.value = vaultNames?.includes(entry.credential) ? entry.credential : '' }
      refreshModels(); emit(); return
    }
    if (has('record-pattern')) { draft.record.pattern = target.value.slice(0, 2000); refreshRecord(); emit(); return }
    if (has('record-flags')) { draft.record.flags = target.value.replace(/[^gimsuy]/g, '').slice(0, 6); refreshRecord(); emit(); return }
    if (has('verdict-pattern')) { draft.verdicts.pattern = target.value.slice(0, 400); refreshJudges(); emit(); return }
    if (has('verdict-threshold')) { const value = Number(target.value); if (target.value !== '' && Number.isFinite(value) && value >= 0 && value <= 1) draft.verdicts.threshold = value; refreshJudges(); emit() }
  })
  for (const section of [el, judgesEl]) section.addEventListener('change', event => {
    const target = event.target, at = name => target.getAttribute(`data-pipe-${name}`), has = name => target.hasAttribute(`data-pipe-${name}`), index = name => Number(at(name))
    // A model id is a vendor's on a CLI surface and a registered name on the http surface: crossing that line clears it.
    if (has('surface')) { const entry = draft.rows[index('surface')], next = PIPELINE_SURFACES[target.value] ? target.value : entry.surface; if ((next === 'http') !== (entry.surface === 'http')) entry.model = ''; entry.surface = next; render(); emit(); return }
    if (has('effort')) { const effort = target.value, entry = draft.rows[index('effort')]; entry.efforts = PIPELINE_EFFORTS.filter(item => item === effort ? target.checked : entry.efforts.includes(item)); refreshPreview(); emit(); return }
    if (has('tools')) { draft.rows[index('tools')].tools = String(target.value).slice(0, 40); refreshPreview(); refreshTools(); emit(); return }
    if (has('model') && target.tagName === 'SELECT') { draft.rows[index('model')].model = String(target.value).slice(0, 80); refreshPreview(); refreshJudges(); emit(); return }
    if (has('judge-count')) { draft.judges = resizeJudges(draft.judges, target.value); render(); emit(); return }
    if (has('judge-surface')) { const entry = draft.judges[index('judge-surface')], next = PIPELINE_SURFACES[target.value] ? target.value : entry.surface; if ((next === 'http') !== (entry.surface === 'http')) entry.model = ''; entry.surface = next; render(); emit(); return }
    if (has('judge-effort')) { draft.judges[index('judge-effort')].effort = target.value; emit(); return }
    if (has('judge-model') && target.tagName === 'SELECT') { draft.judges[index('judge-model')].model = String(target.value).slice(0, 80); refreshJudges(); emit(); return }
    if (has('profile-label')) { renameProfile(index('profile-label'), target.value); render(); emit(); return }
    if (has('profile-tool')) { const entry = draft.tools.profiles[index('profile-tool')], id = target.value; entry.enabled = target.checked ? [...new Set([...entry.enabled, id])] : entry.enabled.filter(item => item !== id); refreshTools(); emit(); return }
    if (has('server-name')) { renameServer(index('server-name'), target.value); render(); emit(); return }
    if (has('server-kind')) { draft.tools.servers[index('server-kind')].kind = target.value === 'http' ? 'http' : 'stdio'; render(); emit(); return }
    if (has('server-tools')) { render(); return }
    if (has('model-name')) { renameModel(index('model-name'), target.value); render(); emit(); return }
    if (has('model-kind')) { draft.models[index('model-kind')].kind = MODEL_KINDS[target.value] ? target.value : 'openai-chat'; render(); emit(); return }
    if (has('model-credential-pick')) { const i = index('model-credential-pick'); if (target.value) { draft.models[i].credential = target.value; const input = q(`model-credential="${i}"`); if (input) input.value = target.value } refreshModels(); emit(); return }
    if (has('record-output')) { draft.record.output = target.value === 'extracted' ? 'extracted' : 'all'; refreshRecord(); emit(); return }
    if (has('record-flag')) { const key = at('record-flag'); if (RECORD_FLAGS.some(([id]) => id === key)) draft.record[key] = !!target.checked; refreshRecord(); emit(); return }
    if (has('record-keep')) { draft.record.keepDraws = !!target.checked; refreshRecord(); emit(); return }
    if (has('record-evidence')) { draft.record.evidence = RECORD_EVIDENCE_MODES.some(([id]) => id === target.value) ? target.value : 'failures'; refreshRecord(); emit(); return }
    if (has('verdict-format')) { draft.verdicts.format = VERDICT_FORMATS.some(([id]) => id === target.value) ? target.value : 'text'; refreshJudges(); emit(); return }
    if (has('verdict-scale')) { draft.verdicts.scale = [1, 10, 100].includes(Number(target.value)) ? Number(target.value) : 1; refreshJudges(); emit(); return }
    if (has('verdict-rule')) { draft.verdicts.rule = VERDICT_RULES.some(([id]) => id === target.value) ? target.value : 'mean'; refreshJudges(); emit() }
  })
  for (const section of [el, judgesEl]) section.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return
    const has = name => button.hasAttribute(`data-pipe-${name}`), index = name => Number(button.getAttribute(`data-pipe-${name}`))
    if (has('open-judges')) { onOpenJudges(); return }
    if (has('open-pipeline')) { onOpenPipeline(); return }
    if (locked) return
    if (has('add')) { if (draft.rows.length < 16) { const entry = emptyPipelineRow(); const used = new Set(draft.rows.map(item => item.surface)); entry.surface = Object.keys(PIPELINE_SURFACES).find(id => !used.has(id)) || 'claude-cli'; entry.model = PIPELINE_SURFACES[entry.surface].models[0] || ''; draft.rows.push(entry); render(); emit() } }
    else if (has('remove')) { draft.rows.splice(index('remove'), 1); render(); emit() }
    else if (has('judge-remove')) { draft.judges.splice(index('judge-remove'), 1); render(); emit() }
    else if (has('judge-add')) { draft.judges = resizeJudges(draft.judges, draft.judges.length + 1); render(); emit(); q(`judge-model="${draft.judges.length - 1}"`)?.focus() }
    else if (has('profile-add')) { if (draft.tools.profiles.length >= TOOL_PROFILE_LIMIT) return; draft.tools.profiles.push({ ...emptyToolProfile(), id: uniqueId('profile', ids(draft.tools.profiles), 'profile') }); render('tools'); emit(); q(`profile-label="${draft.tools.profiles.length - 1}"`)?.focus() }
    else if (has('profile-remove')) { draft.tools.profiles.splice(index('profile-remove'), 1); render(); emit() }
    else if (has('server-add')) { if (!addServer({ ...emptyToolServer(), id: uniqueId('server', ids(draft.tools.servers), 'server') })) return; render('tools'); emit(); q(`server-name="${draft.tools.servers.length - 1}"`)?.focus() }
    else if (has('server-describe')) {
      const described = describeToolServerPath(describePath)
      if (!described) { serverNote = 'Write the path of the server program, or the address it already answers at, then press Describe.'; refreshTools(); return }
      const name = nameFromPath(describePath)
      if (!addServer({ ...emptyToolServer(), id: uniqueId(slug(name), ids(draft.tools.servers), 'server'), name, kind: described.kind, command: described.command, args: [...described.args], url: described.url, path: describePath.trim().slice(0, 400) })) return
      serverNote = described.why + ' Check the command, then declare the tools it offers.'; describePath = ''; render('tools'); emit()
    }
    else if (has('server-remove')) { draft.tools.servers.splice(index('server-remove'), 1); render(); emit() }
    else if (has('server-toolsenabled')) addToolsEnabledServer()
    else if (has('model-add')) { if (draft.models.length >= CUSTOM_MODEL_LIMIT) return; draft.models.push({ ...emptyCustomModel(), id: uniqueId('model', ids(draft.models), 'model') }); render('models'); emit(); q(`model-name="${draft.models.length - 1}"`)?.focus() }
    else if (has('model-remove')) { draft.models.splice(index('model-remove'), 1); render(); emit() }
    else if (has('model-vault-add')) addToVault(draft.models[index('model-vault-add')])
    else if (has('vault-refresh')) readVault()
  })
  el.addEventListener('toggle', openState, true)

  readVault()
  render()
  return {
    el, judgesEl,
    set(next) { draft = normalizePipelineDraft(next); render() },
    value: () => structuredClone(draft),
    refresh: () => refreshPreview(),
    setDisabled(value) { locked = !!value; disable(); refreshPreview() },
  }
}
