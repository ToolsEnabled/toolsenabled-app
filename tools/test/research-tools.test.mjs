// Tool policy: named profiles of enabled tool ids, registered tool servers,
// and the per-surface translation the harness applies. Nothing here can carry
// a secret: a server names its environment variables, never their values.
import assert from 'node:assert/strict'
import test from 'node:test'
import { SURFACE_TOOLS, describeToolServerPath, normalizeToolPolicy, surfaceToolFlags, toolCatalog, toolProblems, toolProfilesForHarness, toolServersForHarness, TOOL_PROFILE_LIMIT } from '../../src/research-tools.mjs'

const policy = () => normalizeToolPolicy({
  servers: [
    { id: 'lean-rag', name: 'LEAN docs retrieval', kind: 'stdio', command: 'python', args: ['C:/research/rag/server.py'], tools: ['search_docs', 'bad name'], env: ['RAG_INDEX_DIR'] },
    { name: 'Compiler feedback', kind: 'http', url: 'http://127.0.0.1:8765/mcp' },
  ],
  profiles: [
    { id: 'rag', label: 'Retrieval only', enabled: ['server/lean-rag/search_docs'] },
    { label: 'Everything', enabled: ['claude-cli/Bash', 'claude-cli/Read', 'codex-cli/workspace_write', 'gemini-cli/run_shell_command', 'server/compiler-feedback', 'nonsense', 'claude-cli/Bash'] },
  ],
})

test('servers and profiles normalize to ids, declared tool names and de-duplicated enabled ids', () => {
  const current = policy()
  assert.deepEqual(current.servers.map(server => server.id), ['lean-rag', 'compiler-feedback'], 'a missing id comes from the name')
  assert.deepEqual(current.servers[0].tools, ['search_docs'], 'a tool name with a space is not a tool name')
  assert.deepEqual(current.profiles.map(profile => profile.id), ['rag', 'everything'])
  assert.deepEqual(current.profiles[1].enabled, ['claude-cli/Bash', 'claude-cli/Read', 'codex-cli/workspace_write', 'gemini-cli/run_shell_command', 'server/compiler-feedback'], 'unknown shapes and duplicates are dropped')
  assert.equal(normalizeToolPolicy({ profiles: Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, label: 'P' + i })) }).profiles.length, TOOL_PROFILE_LIMIT)
  assert.deepEqual(normalizeToolPolicy(null), { servers: [], profiles: [] })
})

test('the catalog lists every built-in tool per surface, then each server and its declared tools', () => {
  const rows = toolCatalog(policy())
  const builtin = Object.values(SURFACE_TOOLS).reduce((n, tools) => n + tools.length, 0)
  assert.equal(rows.length, builtin + 2 + 1, 'built-ins, two whole-server rows, one declared tool')
  assert.ok(rows.some(row => row.id === 'claude-cli/Bash' && row.access === 'execute'))
  assert.deepEqual(rows.filter(row => row.group === 'server:lean-rag').map(row => row.id), ['server/lean-rag', 'server/lean-rag/search_docs'])
})

test('a path or address becomes a way to start the server, which the person can still change', () => {
  assert.deepEqual(describeToolServerPath('/opt/lab/rag/server.py'), { kind: 'stdio', command: 'python', args: ['/opt/lab/rag/server.py'], url: '', why: 'A Python file: started with python.' })
  assert.equal(describeToolServerPath('C:/research/engine/index.mjs').command, 'node')
  assert.deepEqual(describeToolServerPath('C:/research/engine/').args, ['C:/research/engine'])
  assert.equal(describeToolServerPath('http://127.0.0.1:8765/mcp').kind, 'http')
  assert.equal(describeToolServerPath('C:/research/compiler/feedback.exe').command, 'C:/research/compiler/feedback.exe')
  assert.equal(describeToolServerPath('   '), null)
})

test('problems name incomplete servers, credential-shaped environment names, unknown ids, empty profiles and dangling rows', () => {
  const problems = toolProblems({ servers: [{ name: '', kind: 'http', url: '' }, { name: 'Keyed', command: 'x', env: ['RAG_API_KEY'] }], profiles: [{ label: '', enabled: [] }, { label: 'Ghost tools', enabled: ['server/nowhere/tool'] }] }, [{ tools: 'missing' }])
  assert.deepEqual(problems.map(problem => problem.kind), ['server', 'server-secret', 'profile', 'profile-empty', 'profile-unknown', 'row'])
  assert.match(problems[0].text, /needs a name and a URL/)
  assert.match(problems[1].text, /Name it in the vault/)
  assert.deepEqual(toolProblems(policy()), [], 'the example policy is complete')
})

test('claude gets built-in tools, allowed MCP tools and an inline MCP config under strict mode', () => {
  const current = policy(), flags = surfaceToolFlags('claude-cli', current.profiles[1], current.servers)
  assert.deepEqual(flags.args, ['--tools', 'Bash,Read', '--allowedTools', 'Bash,Read,mcp__compiler-feedback', '--mcp-config', JSON.stringify({ mcpServers: { 'compiler-feedback': { type: 'http', url: 'http://127.0.0.1:8765/mcp' } } }), '--strict-mcp-config'])
  assert.equal(flags.open, true, 'Bash opens the sandbox')
  const readOnly = surfaceToolFlags('claude-cli', { enabled: ['claude-cli/Read', 'server/lean-rag/search_docs'] }, current.servers)
  assert.equal(readOnly.open, false)
  assert.deepEqual(readOnly.args.slice(0, 4), ['--tools', 'Read', '--allowedTools', 'Read,mcp__lean-rag__search_docs'])
  assert.deepEqual(readOnly.env, ['RAG_INDEX_DIR'], 'the server\'s environment names travel with the flags')
  assert.deepEqual(surfaceToolFlags('claude-cli', null, current.servers).args, ['--tools', '', '--strict-mcp-config'], 'no profile means tools off')
})

test('codex gets the sandbox mode and -c overrides; gemini gets settings and the approval mode', () => {
  const current = policy()
  const codex = surfaceToolFlags('codex-cli', current.profiles[0], current.servers)
  assert.equal(codex.sandbox, 'read-only')
  assert.deepEqual(codex.args, ['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.view_image=false', '-c', 'web_search="disabled"', '-c', 'mcp_servers.lean-rag.command="python"', '-c', 'mcp_servers.lean-rag.args=["C:/research/rag/server.py"]', '-c', 'mcp_servers.lean-rag.env_vars=["RAG_INDEX_DIR"]', '-c', 'mcp_servers.lean-rag.enabled_tools=["search_docs"]'])
  assert.deepEqual(surfaceToolFlags('codex-cli', { enabled: ['codex-cli/shell', 'codex-cli/view_image', 'codex-cli/web_search'] }, []).args, ['-c', 'features.shell_tool=true', '-c', 'features.unified_exec=true', '-c', 'features.view_image=true', '-c', 'web_search="live"'], 'each selected native tool has an explicit supported setting')
  assert.equal(surfaceToolFlags('codex-cli', current.profiles[1], current.servers).sandbox, 'workspace-write')
  const gemini = surfaceToolFlags('gemini-cli', current.profiles[1], current.servers)
  assert.deepEqual(gemini.args, ['--approval-mode', 'yolo', '--allowed-mcp-server-names', 'compiler-feedback'])
  assert.deepEqual(gemini.settings, { tools: { core: ['run_shell_command'], allowed: ['mcp_*'] }, mcpServers: { 'compiler-feedback': { httpUrl: 'http://127.0.0.1:8765/mcp' } } })
  assert.deepEqual(surfaceToolFlags('gemini-cli', current.profiles[0], current.servers).settings.tools.core, [], 'a server-only profile disables every builtin')
  assert.deepEqual(surfaceToolFlags('gemini-cli', current.profiles[0], current.servers).settings.tools.allowed, ['mcp_*'], 'selected MCP tools remain executable above the builtin core deny policy')
  assert.deepEqual(surfaceToolFlags('gemini-cli', current.profiles[0], current.servers).args, ['--approval-mode', 'yolo', '--allowed-mcp-server-names', 'lean-rag'], 'MCP policy permission is bounded by the exact server discovery allowlist')
  assert.deepEqual(surfaceToolFlags('gemini-cli', null, []).settings.tools.core, [], 'an empty profile cannot inherit default builtins')
  assert.equal(surfaceToolFlags('gemini-cli', null, []).settings.tools.allowed, undefined, 'no servers means no MCP execution allowance')
  assert.deepEqual(surfaceToolFlags('gemini-cli', current.profiles[0], current.servers).settings.mcpServers['lean-rag'], { command: 'python', args: ['C:/research/rag/server.py'], includeTools: ['search_docs'] })
  assert.deepEqual(surfaceToolFlags('gemini-cli', null, []).args, ['--approval-mode', 'plan'], 'nothing enabled keeps the read-only plan mode')
})

test('the harness receives every profile translated per surface and the servers without values', () => {
  const current = policy(), profiles = toolProfilesForHarness(current)
  assert.deepEqual(Object.keys(profiles), ['rag', 'everything'])
  assert.deepEqual(Object.keys(profiles.rag.bySurface), ['claude-cli', 'codex-cli', 'gemini-cli'])
  const servers = toolServersForHarness(current)
  assert.deepEqual(servers[0], { id: 'lean-rag', name: 'LEAN docs retrieval', kind: 'stdio', command: 'python', args: ['C:/research/rag/server.py'], url: '', path: '', tools: ['search_docs'], env: ['RAG_INDEX_DIR'] })
  assert.ok(!JSON.stringify(servers).includes('note'))
})
