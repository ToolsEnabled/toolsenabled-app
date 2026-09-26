// The pipeline editor's panels on their own: tool profiles and servers, custom
// models against the vault's credential names, what a draw records, and how
// judge verdicts are read. Each persists through value() and set().
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { emptyRecordPolicy } from '../../src/research-record.mjs'

register('./css-loader.mjs', import.meta.url)
const { createPipelineEditor } = await import('../../src/research-pipeline.js')
let installed
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => installed.restore())
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function mount() {
  const changes = [], editor = createPipelineEditor({ onChange: draft => changes.push(draft), settings: () => ({}) })
  document.body.append(editor.el); document.body.append(editor.judgesEl)
  const q = name => editor.el.querySelector(`[data-pipe-${name}]`) || editor.judgesEl.querySelector(`[data-pipe-${name}]`)
  const all = name => [...editor.el.querySelectorAll(`[data-pipe-${name}]`), ...editor.judgesEl.querySelectorAll(`[data-pipe-${name}]`)]
  const type = (name, value) => { const node = q(name); node.value = value; node.dispatch('input') }
  const choose = (name, value) => { const node = q(name); node.value = value; node.dispatch('change') }
  const tickBox = (name, value, checked) => { const box = all(name).find(node => node.value === value); assert.ok(box, `${name} offers ${value}`); box.checked = checked; box.dispatch('change') }
  const selected = name => q(name).querySelector('[selected]')?.value
  return { editor, changes, q, all, type, choose, tickBox, selected }
}
const addRow = view => { view.q('add').click() }

test('a profile enables catalog tools; a row naming it carries the profile as the condition id suffix', () => {
  const view = mount(), { q, all, type, choose, tickBox, editor } = view
  addRow(view)
  assert.match(q('preview').textContent, /1\s*condition will be generated: claude-claude-sonnet-5-max$/)
  assert.equal(q('tools="0"').querySelectorAll('option').length, 1, 'only Tools off until a profile exists')
  assert.match(q('tool-problems').textContent, /No profiles: every row runs with tools off/)
  q('profile-add').click()
  assert.equal(editor.value().tools.profiles.length, 1)
  assert.match(q('tool-problems').textContent, /Tool profile 1 needs a label/)
  assert.match(q('tool-problems').textContent, /enables nothing/)
  const catalog = all('profile-tool="0"').map(node => node.value)
  assert.ok(catalog.includes('claude-cli/Read') && catalog.includes('codex-cli/shell') && catalog.includes('gemini-cli/run_shell_command'), 'every surface\'s built-in tools are offered')
  // Typing the name changes the label; finishing it (change) makes the id follow, so the condition id reads well.
  type('profile-label="0"', 'Read only')
  assert.equal(editor.value().tools.profiles[0].label, 'Read only')
  assert.equal(editor.value().tools.profiles[0].id, 'profile', 'the id waits for the name to be finished')
  choose('profile-label="0"', 'Read only')
  assert.equal(editor.value().tools.profiles[0].id, 'read-only')
  assert.equal(q('profile-id="0"').textContent, 'read-only')
  tickBox('profile-tool="0"', 'claude-cli/Read', true)
  tickBox('profile-tool="0"', 'claude-cli/Grep', true)
  assert.deepEqual(editor.value().tools.profiles[0].enabled, ['claude-cli/Read', 'claude-cli/Grep'])
  tickBox('profile-tool="0"', 'claude-cli/Grep', false)
  assert.deepEqual(editor.value().tools.profiles[0].enabled, ['claude-cli/Read'])
  assert.ok(!/needs a label|enables nothing/.test(q('tool-problems').textContent), q('tool-problems').textContent)
  assert.match(q('tool-problems').textContent, /1\s*profile and\s*0\s*servers/)
  // The row picks the profile: the preview and the retained row carry it.
  assert.deepEqual([...q('tools="0"').querySelectorAll('option')].map(node => node.value), ['', 'read-only'])
  choose('tools="0"', 'read-only')
  assert.equal(editor.value().rows[0].tools, 'read-only')
  assert.match(q('preview').textContent, /claude-claude-sonnet-5-max-read-only$/)
  assert.equal(q('row-problems').hidden, true)
  // Removing the profile leaves the row's reference visible as a problem rather than silently generating tools-off.
  q('profile-remove="0"').click()
  assert.equal(q('row-problems').hidden, false)
  assert.match(q('row-problems').textContent, /Row 1 names a tool profile that does not exist: read-only/)
  assert.match(q('preview').textContent, /claude-claude-sonnet-5-max$/)
  assert.ok(view.changes.length >= 8, 'every edit was published')
})

test('a server described from a .py path is prefilled; its declared tools join the catalog and a rename re-points them', () => {
  const view = mount(), { q, all, type, choose, tickBox, editor } = view
  q('server-describe').click()
  assert.match(q('server-status').textContent, /Write the path of the server program/)
  assert.equal(editor.value().tools.servers.length, 0)
  type('server-path', 'C:/tools/rag/server.py')
  q('server-describe').click()
  const [server] = editor.value().tools.servers
  assert.equal(server.id, 'server'); assert.equal(server.name, 'server'); assert.equal(server.kind, 'stdio')
  assert.equal(server.command, 'python'); assert.deepEqual(server.args, ['C:/tools/rag/server.py']); assert.equal(server.path, 'C:/tools/rag/server.py')
  assert.equal(q('server-command="0"').value, 'python')
  assert.match(q('server-args="0"').textContent, /C:\/tools\/rag\/server\.py/)
  assert.match(q('server-status').textContent, /A Python file: started with python/)
  assert.equal(q('server-path').value, '', 'the path box is cleared once the server is added')
  assert.equal(q('server-url="0"'), null, 'a stdio server shows no URL field')
  // Declared tools appear in every profile's catalog, whole-server and one by one.
  type('server-tools="0"', 'search_index\nlookup\n'); choose('server-tools="0"', 'search_index\nlookup\n')
  assert.deepEqual(editor.value().tools.servers[0].tools, ['search_index', 'lookup'])
  q('profile-add').click()
  const catalog = all('profile-tool="0"').map(node => node.value)
  assert.ok(catalog.includes('server/server') && catalog.includes('server/server/search_index') && catalog.includes('server/server/lookup'), catalog.join(' '))
  tickBox('profile-tool="0"', 'server/server/search_index', true)
  type('server-name="0"', 'RAG index'); choose('server-name="0"', 'RAG index')
  assert.equal(editor.value().tools.servers[0].id, 'rag-index')
  assert.deepEqual(editor.value().tools.profiles[0].enabled, ['server/rag-index/search_index'], 'the profile follows the renamed server')
  assert.ok(all('profile-tool="0"').some(node => node.value === 'server/rag-index/search_index' && node.checked))
  // A credential-looking environment variable is refused in words; names only travel.
  type('server-env="0"', 'RAG_INDEX_DIR\nRAG_API_KEY')
  assert.deepEqual(editor.value().tools.servers[0].env, ['RAG_INDEX_DIR', 'RAG_API_KEY'])
  assert.match(q('tool-problems').textContent, /Tool server 1 names a credential variable/)
  // An http server switches its fields and needs a URL.
  choose('server-kind="0"', 'http')
  assert.equal(q('server-command="0"'), null); assert.ok(q('server-url="0"'))
  assert.match(q('tool-problems').textContent, /Tool server 1 needs a URL/)
  type('server-url="0"', 'http://127.0.0.1:8765/mcp')
  assert.ok(!/needs a URL/.test(q('tool-problems').textContent))
  // The draft survives a round trip through set(), servers and profiles included.
  const other = mount()
  other.editor.set(editor.value())
  assert.deepEqual(other.editor.value(), editor.value())
  assert.equal(other.q('server-url="0"').value, 'http://127.0.0.1:8765/mcp')
})

test('the ToolsEnabled tools become one server with MCP-style names and no command yet', async () => {
  const listed = []
  window.mcAgent = { tools: async () => { listed.push(1); return { ok: true, tools: [{ name: 'memory.get', allowed: true, gated: false }, { name: 'system.ask', allowed: true, gated: true }, { name: 'memory.get', allowed: true, gated: false }] } } }
  const view = mount(), { q, editor } = view
  assert.ok(q('server-toolsenabled'), 'the button is offered when the agent host lists tools')
  q('server-toolsenabled').click(); await tick()
  assert.equal(listed.length, 1)
  const [server] = editor.value().tools.servers
  assert.equal(server.id, 'toolsenabled'); assert.equal(server.name, 'ToolsEnabled tools over MCP'); assert.equal(server.command, '')
  assert.deepEqual(server.tools, ['memory_get', 'system_ask'])
  assert.match(q('server-status').textContent, /2 ToolsEnabled tools declared/)
  assert.match(q('tool-problems').textContent, /Tool server 1 needs a command to start it/)
  // Listing again refreshes the tools of the same server rather than adding another.
  q('server-toolsenabled').click(); await tick()
  assert.equal(editor.value().tools.servers.length, 1)
  delete window.mcAgent
})

test('a custom model names a vault credential; a name the vault lacks is a problem and http rows pick the model', async () => {
  const added = []
  window.mcVault = { names: async () => ({ ok: true, names: ['custom.LEAN_KEY', 'anthropic.api_key', 'custom.not a name'] }), add: async ({ credential, customName }) => { added.push([credential, customName]); return { ok: true } } }
  const view = mount(), { q, type, choose, selected, editor } = view
  await tick()
  assert.match(q('vault-status').textContent, /1 credential name read from the vault/)
  assert.match(q('model-problems').textContent, /No custom models/)
  q('model-add').click()
  assert.match(q('model-problems').textContent, /Model 1 needs a name, the model id the endpoint expects, a vault credential name/)
  type('model-name="0"', 'Lean prover'); choose('model-name="0"', 'Lean prover')
  type('model-id="0"', 'prover-7b')
  type('model-credential="0"', 'OTHER_KEY')
  assert.match(q('model-problems').textContent, /Model Lean prover names a credential that is not in the vault: OTHER_KEY/)
  assert.equal(q('model-url="0"').getAttribute('placeholder'), 'https://api.openai.com/v1/chat/completions', 'the kind\'s default endpoint is the placeholder')
  assert.deepEqual([...q('model-credential-pick="0"').querySelectorAll('option')].map(node => node.value), ['', 'LEAN_KEY'])
  choose('model-credential-pick="0"', 'LEAN_KEY')
  assert.equal(q('model-credential="0"').value, 'LEAN_KEY')
  assert.ok(!/not in the vault/.test(q('model-problems').textContent), q('model-problems').textContent)
  assert.deepEqual(editor.value().models, [{ id: 'lean-prover', name: 'Lean prover', kind: 'openai-chat', url: '', model: 'prover-7b', credential: 'LEAN_KEY', provider: '' }])
  choose('model-kind="0"', 'anthropic-messages')
  assert.equal(q('model-url="0"').getAttribute('placeholder'), 'https://api.anthropic.com/v1/messages')
  // Add to the vault asks the vault for the value under the name; nothing of it passes through here.
  q('model-vault-add="0"').click(); await tick()
  assert.deepEqual(added, [['custom', 'LEAN_KEY']])
  assert.match(q('vault-status').textContent, /asking for the value of LEAN_KEY/)
  // A row on the http surface picks the registered model instead of typing an id.
  addRow(view)
  choose('surface="0"', 'http')
  assert.equal(q('model="0"').tagName, 'SELECT')
  assert.deepEqual([...q('model="0"').querySelectorAll('option')].map(node => node.value), ['', 'lean-prover'])
  assert.equal(q('exe="0"'), null, 'an endpoint has no executable')
  assert.match(q('preview').textContent, /Add a surface with a model/)
  choose('model="0"', 'lean-prover')
  assert.match(q('preview').textContent, /http-lean-prover-max$/)
  assert.equal(editor.value().rows[0].model, 'lean-prover')
  // Renaming the model re-points the row; removing it leaves a visible problem.
  type('model-name="0"', 'Prover'); choose('model-name="0"', 'Prover')
  assert.equal(editor.value().rows[0].model, 'prover')
  assert.match(q('preview').textContent, /http-prover-max$/)
  q('model-remove="0"').click()
  assert.match(q('row-problems').textContent, /Row 1 names a custom model that is not registered: prover/)
  delete window.mcVault
})

test('without a vault bridge the credential is typed and the export carries the name only', () => {
  const view = mount(), { q } = view
  assert.match(q('vault-status').textContent, /No vault is reachable from this page, so credential names are typed/)
  q('model-add').click()
  assert.equal(q('model-credential-pick="0"'), null); assert.equal(q('model-vault-add="0"'), null); assert.equal(q('vault-refresh'), null)
  assert.ok(q('model-credential="0"'))
  assert.match(view.editor.el.textContent, /carry the name only/)
})

test('recording toggles change the summary and the sample draw as it would be recorded', () => {
  const view = mount(), { q, all, type, choose, editor } = view
  const preview = () => JSON.parse(q('record-preview').textContent)
  assert.equal(q('record-summary').textContent, 'The full response text; token counts, timing, provider and served model, tool calls and turns, the command line; failure evidence failures.')
  assert.equal(preview().usage.inputTokens, 812); assert.equal(preview().harness.evidence, undefined, 'a successful draw carries evidence only when the policy says always')
  assert.equal(q('record-extraction').hidden, true)
  const tokens = all('record-flag="tokens"')[0]; tokens.checked = false; tokens.dispatch('change')
  assert.ok(!/token counts/.test(q('record-summary').textContent))
  assert.equal(preview().usage.inputTokens, undefined); assert.equal(preview().usage.generationMs, 4210)
  const extracted = all('record-output').find(node => node.value === 'extracted'); extracted.checked = true; extracted.dispatch('change')
  assert.equal(q('record-extraction').hidden, false)
  assert.match(q('record-problems').textContent, /needs a pattern/)
  assert.equal(preview().output, '', 'no pattern extracts nothing')
  type('record-pattern', 'FINAL ANSWER:\\s*(\\d+)')
  assert.ok(!/needs a pattern/.test(q('record-problems').textContent))
  assert.match(q('record-summary').textContent, /^Only the text matching \/FINAL ANSWER:\\s\*\(\\d\+\)\/ \(with the full text's hash\)/)
  assert.equal(preview().output, '42'); assert.equal(preview().harness.extraction.matched, true); assert.equal(preview().harness.extraction.fullChars, 44)
  type('record-pattern', '(')
  assert.match(q('record-problems').textContent, /not a valid regular expression/)
  type('record-pattern', 'FINAL ANSWER:\\s*(\\d+)')
  choose('record-evidence', 'always')
  assert.deepEqual(preview().harness.evidence, { exit: 0, signal: null, spawnError: null, stderrTail: null, stdoutTail: null })
  const provider = all('record-flag="provider"')[0]; provider.checked = false; provider.dispatch('change')
  assert.match(q('record-problems').textContent, /Without the served model/)
  assert.equal(preview().identity.id, 'claude-sonnet-5', 'without the served model the identity is the requested one')
  assert.deepEqual(editor.value().record, { ...emptyRecordPolicy(), output: 'extracted', pattern: 'FINAL ANSWER:\\s*(\\d+)', tokens: false, provider: false, evidence: 'always' })
  const other = mount(); other.editor.set(editor.value())
  assert.deepEqual(other.editor.value().record, editor.value().record)
  assert.equal(other.q('record-extraction').hidden, false)
  assert.equal(other.all('record-flag="tokens"')[0].checked, false)
  assert.equal(other.q('record-evidence').querySelector('[selected]').value, 'always')
})

test('judge verdict settings persist through value() and set(), with their problems named', () => {
  const view = mount(), { q, type, choose, selected, editor } = view
  assert.match(q('verdict-status').textContent, /Verdicts are kept as written; nothing is scored/)
  choose('verdict-format', 'score')
  assert.match(q('verdict-status').textContent, /A scored judge arm needs at least one judge/)
  choose('verdict-scale', '10'); type('verdict-threshold', '0.6'); choose('verdict-rule', 'majority'); type('verdict-pattern', 'SCORE:\\s*(\\d+)')
  assert.deepEqual(editor.value().verdicts, { format: 'score', pattern: 'SCORE:\\s*(\\d+)', scale: 10, threshold: 0.6, rule: 'majority' })
  assert.match(q('verdict-status').textContent, /read as a score out of 10; the summary passes when more than half of the judges pass/)
  type('verdict-threshold', '7')
  assert.equal(editor.value().verdicts.threshold, 0.6, 'a threshold outside 0 to 1 is not taken')
  type('verdict-pattern', '(')
  assert.match(q('verdict-status').textContent, /verdict pattern is not a valid regular expression/)
  type('verdict-pattern', 'SCORE:\\s*(\\d+)')
  q('judge-add').click()
  assert.ok(!/needs at least one judge/.test(q('verdict-status').textContent))
  const other = mount(); other.editor.set(editor.value())
  assert.deepEqual(other.editor.value().verdicts, editor.value().verdicts)
  assert.equal(other.selected('verdict-format'), 'score'); assert.equal(other.selected('verdict-scale'), '10'); assert.equal(other.selected('verdict-rule'), 'majority')
  assert.equal(other.q('verdict-threshold').value, '0.6'); assert.equal(other.q('verdict-pattern').value, 'SCORE:\\s*(\\d+)')
  assert.equal(other.changes.length, 0, 'set() publishes nothing')
  assert.equal(selected('verdict-format'), 'score')
  other.editor.setDisabled(true)
  assert.equal(other.q('verdict-format').disabled, true); assert.equal(other.q('profile-add').disabled, true); assert.equal(other.q('open-judges').disabled, false)
})
