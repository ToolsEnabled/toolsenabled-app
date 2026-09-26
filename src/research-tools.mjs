// Tool policy for the LeanBench-style pipeline: which tools the agents may
// use in each condition. A profile is a named set of enabled tool ids; a row
// of the pipeline names the profile it runs under (none means tools off, the
// LeanBench default). Ids are `<surface>/<tool>` for a vendor CLI's built-in
// tool, `server/<id>` for every tool of a registered tool server and
// `server/<id>/<tool>` for one of its tools. Tool servers are the person's own
// programs (a RAG index, a compiler-feedback loop) spoken to over the Model
// Context Protocol: a command to start (stdio) or a URL (http). Nothing here
// holds a secret; a server's environment is named, never valued.
const ID = /^[a-z][a-z0-9_-]{0,39}$/
const text = value => String(value ?? '').trim()
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
export const TOOL_PROFILE_LIMIT = 8
export const TOOL_SERVER_LIMIT = 16
export const CUSTOM_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

// The built-in tools of each vendor CLI, with what enabling one lets the model
// do. `access` drives the sandbox and approval mode: a read-only profile keeps
// the CLI's read-only mode; any write or execute tool opens it.
export const SURFACE_TOOLS = Object.freeze({
  'claude-cli': Object.freeze([
    { tool: 'Read', access: 'read', text: 'Read files in the working directory' },
    { tool: 'Glob', access: 'read', text: 'Find files by name pattern' },
    { tool: 'Grep', access: 'read', text: 'Search file contents' },
    { tool: 'Write', access: 'write', text: 'Create or overwrite files' },
    { tool: 'Edit', access: 'write', text: 'Edit a file in place' },
    { tool: 'NotebookEdit', access: 'write', text: 'Edit notebook cells' },
    { tool: 'Bash', access: 'execute', text: 'Run shell commands' },
    { tool: 'WebFetch', access: 'network', text: 'Fetch a web page' },
    { tool: 'WebSearch', access: 'network', text: 'Search the web' },
    { tool: 'Task', access: 'agent', text: 'Start sub-agents' },
    { tool: 'TodoWrite', access: 'state', text: 'Keep a task list' },
    { tool: 'Skill', access: 'agent', text: 'Run installed skills' },
  ]),
  'codex-cli': Object.freeze([
    { tool: 'shell', access: 'read', text: 'Run commands in the read-only sandbox' },
    { tool: 'workspace_write', access: 'write', text: 'Let commands and patches write inside the working directory' },
    { tool: 'web_search', access: 'network', text: 'Search the web' },
    { tool: 'view_image', access: 'read', text: 'Look at image files' },
  ]),
  'gemini-cli': Object.freeze([
    { tool: 'read_file', access: 'read', text: 'Read a file' },
    { tool: 'list_directory', access: 'read', text: 'List a directory' },
    { tool: 'glob', access: 'read', text: 'Find files by name pattern' },
    { tool: 'search_file_content', access: 'read', text: 'Search file contents' },
    { tool: 'write_file', access: 'write', text: 'Create or overwrite a file' },
    { tool: 'replace', access: 'write', text: 'Edit a file in place' },
    { tool: 'run_shell_command', access: 'execute', text: 'Run shell commands' },
    { tool: 'web_fetch', access: 'network', text: 'Fetch a web page' },
    { tool: 'google_web_search', access: 'network', text: 'Search the web' },
    { tool: 'save_memory', access: 'state', text: 'Save a note across turns' },
  ]),
})
export const OPEN_ACCESS = Object.freeze(['write', 'execute', 'network', 'agent'])

export function emptyToolServer() { return { id: '', name: '', kind: 'stdio', command: '', args: [], url: '', path: '', tools: [], env: [], note: '' } }
export function emptyToolProfile() { return { id: '', label: '', enabled: [], note: '' } }

// From a path or URL the person writes, the way to start the server: a
// Python file runs under python, a JavaScript file under node, an address is
// an http server, anything else is started as it is. The person can correct
// the command afterwards; the path is kept as written.
export function describeToolServerPath(raw) {
  const value = text(raw)
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return { kind: 'http', url: value, command: '', args: [], why: 'An address: the server is already running and speaks MCP over http.' }
  if (/\.py$/i.test(value)) return { kind: 'stdio', command: 'python', args: [value], url: '', why: 'A Python file: started with python.' }
  if (/\.(?:mjs|cjs|js)$/i.test(value)) return { kind: 'stdio', command: 'node', args: [value], url: '', why: 'A JavaScript file: started with node.' }
  if (/[\\/]$/.test(value) || !/\.[A-Za-z0-9]{1,5}$/.test(value.split(/[\\/]/).pop() || '')) {
    return { kind: 'stdio', command: 'node', args: [value.replace(/[\\/]$/, '')], url: '', why: 'A directory or a program without an extension: started with node, which runs the package main. Change the command if the engine starts another way.' }
  }
  return { kind: 'stdio', command: value, args: [], url: '', why: 'Started as it is.' }
}

export function normalizeToolServer(raw) {
  if (!raw || typeof raw !== 'object') return null
  const server = emptyToolServer()
  server.name = text(raw.name).slice(0, 80)
  server.id = ID.test(text(raw.id)) ? text(raw.id) : slug(raw.id || server.name)
  server.kind = raw.kind === 'http' ? 'http' : 'stdio'
  server.command = text(raw.command).slice(0, 400)
  server.args = (Array.isArray(raw.args) ? raw.args : []).map(arg => String(arg ?? '')).filter(Boolean).slice(0, 32)
  server.url = text(raw.url).slice(0, 400)
  server.path = text(raw.path).slice(0, 400)
  server.tools = [...new Set((Array.isArray(raw.tools) ? raw.tools : []).map(text).filter(name => CUSTOM_TOOL_NAME.test(name)))].slice(0, 64)
  server.env = [...new Set((Array.isArray(raw.env) ? raw.env : []).map(text).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))].slice(0, 16)
  server.note = text(raw.note).slice(0, 400)
  return server
}
export function normalizeToolProfile(raw) {
  if (!raw || typeof raw !== 'object') return null
  const profile = emptyToolProfile()
  profile.label = text(raw.label).slice(0, 80)
  profile.id = ID.test(text(raw.id)) ? text(raw.id) : slug(raw.id || profile.label)
  profile.enabled = [...new Set((Array.isArray(raw.enabled) ? raw.enabled : []).map(text).filter(id => /^(?:claude-cli|codex-cli|gemini-cli)\/[A-Za-z][A-Za-z0-9_.-]{0,63}$|^server\/[a-z][a-z0-9_-]{0,39}(?:\/[A-Za-z][A-Za-z0-9_.-]{0,63})?$/.test(id)))].slice(0, 256)
  profile.note = text(raw.note).slice(0, 400)
  return profile
}
export function normalizeToolPolicy(raw) {
  const policy = { servers: [], profiles: [] }
  if (!raw || typeof raw !== 'object') return policy
  // A row without a name keeps a positional id, so a freshly added row survives a save and its problems can name it.
  const ids = new Set()
  ;(Array.isArray(raw.servers) ? raw.servers : []).slice(0, TOOL_SERVER_LIMIT).map(normalizeToolServer).forEach((server, index) => {
    if (!server) return
    if (!server.id) server.id = 'server-' + (index + 1)
    if (!ids.has(server.id)) { ids.add(server.id); policy.servers.push(server) }
  })
  const profileIds = new Set()
  ;(Array.isArray(raw.profiles) ? raw.profiles : []).slice(0, TOOL_PROFILE_LIMIT).map(normalizeToolProfile).forEach((profile, index) => {
    if (!profile) return
    if (!profile.id) profile.id = 'profile-' + (index + 1)
    if (!profileIds.has(profile.id)) { profileIds.add(profile.id); policy.profiles.push(profile) }
  })
  return policy
}

// The catalog the page lists: every built-in tool of every surface, then
// every registered server and its declared tools.
export function toolCatalog(policy) {
  const current = normalizeToolPolicy(policy), rows = []
  for (const [surface, tools] of Object.entries(SURFACE_TOOLS)) for (const item of tools) rows.push({ id: surface + '/' + item.tool, group: surface, tool: item.tool, access: item.access, text: item.text })
  for (const server of current.servers) {
    rows.push({ id: 'server/' + server.id, group: 'server:' + server.id, tool: '*', access: 'server', text: 'Every tool ' + (server.name || server.id) + ' offers' })
    for (const tool of server.tools) rows.push({ id: 'server/' + server.id + '/' + tool, group: 'server:' + server.id, tool, access: 'server', text: 'One tool of ' + (server.name || server.id) })
  }
  return rows
}

// What stops a policy from being written, and what a reviewer would question.
export function toolProblems(policy, rows = []) {
  const current = normalizeToolPolicy(policy), problems = []
  current.servers.forEach((server, index) => {
    const missing = [!server.name && 'a name', server.kind === 'http' ? !server.url && 'a URL' : !server.command && 'a command to start it'].filter(Boolean)
    if (missing.length) problems.push({ kind: 'server', index, text: 'Tool server ' + (index + 1) + ' needs ' + missing.join(' and ') + '.' })
    if (server.env.some(name => /(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH)/i.test(name))) problems.push({ kind: 'server-secret', index, text: 'Tool server ' + (index + 1) + ' names a credential variable. Name it in the vault as a credential instead; the export carries names, never values.' })
  })
  const serverIds = new Set(current.servers.map(server => server.id)), catalog = new Set(toolCatalog(current).map(row => row.id))
  current.profiles.forEach((profile, index) => {
    if (!profile.label) problems.push({ kind: 'profile', index, text: 'Tool profile ' + (index + 1) + ' needs a label.' })
    const unknown = profile.enabled.filter(id => !catalog.has(id) && !(id.startsWith('server/') && serverIds.has(id.split('/')[1])))
    if (unknown.length) problems.push({ kind: 'profile-unknown', index, text: 'Tool profile ' + (profile.label || index + 1) + ' enables tools that are not in the catalog: ' + unknown.join(', ') + '.' })
    if (!profile.enabled.length) problems.push({ kind: 'profile-empty', index, text: 'Tool profile ' + (profile.label || index + 1) + ' enables nothing, which is the same as running without a profile.' })
  })
  for (const row of rows) if (row.tools && !current.profiles.some(profile => profile.id === row.tools)) problems.push({ kind: 'row', text: 'A pipeline row names a tool profile that no longer exists: ' + row.tools + '.' })
  return problems
}

// One profile, one surface: the flags and settings the harness applies. Kept
// free of outside references so the harness embeds this very function.
export function surfaceToolFlags(surface, profile, servers) {
  const enabled = profile && Array.isArray(profile.enabled) ? profile.enabled : []
  const builtins = enabled.filter(id => id.indexOf(surface + '/') === 0).map(id => id.slice(surface.length + 1))
  const access = { 'claude-cli': { Write: 'write', Edit: 'write', NotebookEdit: 'write', Bash: 'execute', WebFetch: 'network', WebSearch: 'network', Task: 'agent', Skill: 'agent' },
    'codex-cli': { workspace_write: 'write', web_search: 'network' },
    'gemini-cli': { write_file: 'write', replace: 'write', run_shell_command: 'execute', web_fetch: 'network', google_web_search: 'network' } }[surface] || {}
  const open = builtins.some(tool => access[tool] !== undefined)
  const mcp = {}, picked = {}
  for (const server of Array.isArray(servers) ? servers : []) {
    const whole = enabled.indexOf('server/' + server.id) >= 0
    const tools = enabled.filter(id => id.indexOf('server/' + server.id + '/') === 0).map(id => id.slice(('server/' + server.id + '/').length))
    if (!whole && !tools.length) continue
    mcp[server.id] = server.kind === 'http' ? { type: 'http', url: server.url } : { command: server.command, args: server.args || [], env: {} }
    picked[server.id] = whole ? null : tools
  }
  const serverIds = Object.keys(mcp), env = []
  for (const server of Array.isArray(servers) ? servers : []) if (mcp[server.id]) for (const name of server.env || []) if (env.indexOf(name) < 0) env.push(name)
  if (surface === 'claude-cli') {
    const allowed = builtins.slice()
    for (const id of serverIds) allowed.push.apply(allowed, picked[id] === null ? ['mcp__' + id] : picked[id].map(tool => 'mcp__' + id + '__' + tool))
    const args = ['--tools', builtins.join(',')]
    if (allowed.length) args.push('--allowedTools', allowed.join(','))
    if (serverIds.length) args.push('--mcp-config', JSON.stringify({ mcpServers: mcp }))
    args.push('--strict-mcp-config')
    return { surface, args, open, sandbox: null, settings: null, servers: serverIds, env }
  }
  if (surface === 'codex-cli') {
    const shell = builtins.indexOf('shell') >= 0
    const args = ['-c', 'features.shell_tool=' + shell, '-c', 'features.unified_exec=' + shell,
      '-c', 'features.view_image=' + (builtins.indexOf('view_image') >= 0),
      '-c', 'web_search=' + JSON.stringify(builtins.indexOf('web_search') >= 0 ? 'live' : 'disabled')]
    for (const id of serverIds) {
      const server = mcp[id]
      if (server.type === 'http') args.push('-c', 'mcp_servers.' + id + '.url=' + JSON.stringify(server.url))
      else {
        args.push('-c', 'mcp_servers.' + id + '.command=' + JSON.stringify(server.command)); args.push('-c', 'mcp_servers.' + id + '.args=' + JSON.stringify(server.args))
        const declared = (Array.isArray(servers) ? servers : []).find(item => item.id === id)
        args.push('-c', 'mcp_servers.' + id + '.env_vars=' + JSON.stringify(declared?.env || []))
      }
      if (picked[id] !== null) args.push('-c', 'mcp_servers.' + id + '.enabled_tools=' + JSON.stringify(picked[id]))
    }
    return { surface, args, open, sandbox: builtins.indexOf('workspace_write') >= 0 ? 'workspace-write' : 'read-only', settings: null, servers: serverIds, env }
  }
  if (surface === 'gemini-cli') {
    // An absent core list enables Gemini's default builtins. An explicit empty
    // list keeps a server-only profile limited to its selected MCP tools.
    const settings = { tools: { core: builtins } }
    if (serverIds.length) {
      // Gemini's core allowlist adds a deny rule above its server allowance.
      // Permit the discovered MCP tools above that deny; the exact server
      // allowlist below and each includeTools list still bound discovery.
      // Its MCP-only wildcard also handles Gemini's shortened tool names.
      settings.tools.allowed = ['mcp_*']
      settings.mcpServers = {}
      for (const id of serverIds) {
        const server = mcp[id]
        settings.mcpServers[id] = server.type === 'http' ? { httpUrl: server.url } : { command: server.command, args: server.args }
        if (picked[id] !== null) settings.mcpServers[id].includeTools = picked[id]
      }
    }
    const args = ['--approval-mode', open || serverIds.length ? 'yolo' : 'plan']
    if (serverIds.length) args.push('--allowed-mcp-server-names', serverIds.join(','))
    return { surface, args, open, sandbox: null, settings, servers: serverIds, env }
  }
  return { surface, args: [], open: false, sandbox: null, settings: null, servers: [], env: [] }
}

// Every profile translated for every surface, written into surfaces.json so
// the harness only applies what the page decided.
export function toolProfilesForHarness(policy) {
  const current = normalizeToolPolicy(policy), out = {}
  for (const profile of current.profiles) {
    out[profile.id] = { label: profile.label, enabled: profile.enabled, bySurface: {} }
    for (const surface of Object.keys(SURFACE_TOOLS)) out[profile.id].bySurface[surface] = surfaceToolFlags(surface, profile, current.servers)
  }
  return out
}
export function toolServersForHarness(policy) {
  return normalizeToolPolicy(policy).servers.map(server => ({ id: server.id, name: server.name, kind: server.kind, command: server.command, args: server.args, url: server.url, path: server.path, tools: server.tools, env: server.env }))
}
