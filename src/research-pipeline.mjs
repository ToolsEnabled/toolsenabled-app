// The LeanBench-style pipeline: surfaces × models × efforts become command
// conditions that run a generated harness inside a clean room. The harness
// files are attached project files (hashed into the frozen input manifest),
// written from the pipeline draft and the Protocol settings, so the exported
// runner's `node cli.mjs run` spawns `node harness/draw.mjs` per attempt: a
// fresh working directory in the room, blank homes, an allowlisted
// environment, the vendor CLI with LeanBench's flags, and one JSON envelope
// back on stdout. A same-day per-surface canary certificate is required
// before any draw, exactly as LeanBench's generator refused without one.
//
// Admission: the app's readiness admits command collectors only under the
// apparatus-development purpose; a counted experiment needs a registered
// execution contract the runner does not have yet. Review & Run says so.
import { effectiveValue, protocolField } from './research-protocol.mjs'
import { JUDGE_RUNNER } from './research-judges.mjs'

export const PIPELINE_SURFACES = Object.freeze({
  'claude-cli': { label: 'Claude CLI (print mode, tools off, settings off)', provider: 'anthropic', short: 'claude', plant: 'CLAUDE.md', models: ['claude-sonnet-5', 'claude-opus-5'] },
  'codex-cli': { label: 'Codex CLI (exec, read-only sandbox, ephemeral)', provider: 'openai', short: 'codex', plant: 'AGENTS.md', models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] },
  'gemini-cli': { label: 'Gemini CLI (plan approval, JSON output)', provider: 'google', short: 'gemini', plant: 'GEMINI.md', models: ['gemini-3.6-flash'] },
})
export const PIPELINE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const ID = /^[a-z][a-z0-9_-]{0,63}$/
const slug = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
const text = value => String(value ?? '').trim()

export const JUDGE_LIMIT = 8
export const JUDGE_PROMPT_LIMIT = 20000
export function emptyPipelineDraft() { return { version: 1, root: 'C:/lbres', rows: [], judges: [] } }
export function emptyPipelineRow() { return { surface: 'claude-cli', model: '', executable: '', efforts: ['max'], noask: false } }
// A judge is a model that reads a contestant's response with its own prompt.
// Nothing is filled in for the person: the model and the prompt start empty.
export function emptyJudge() { return { surface: 'claude-cli', model: '', effort: 'medium', executable: '', prompt: '' } }
function normalizeJudge(raw) {
  if (!raw || typeof raw !== 'object' || !PIPELINE_SURFACES[raw.surface]) return null
  return { surface: raw.surface, model: text(raw.model).slice(0, 80), effort: PIPELINE_EFFORTS.includes(raw.effort) ? raw.effort : 'medium',
    executable: text(raw.executable).slice(0, 400), prompt: String(raw.prompt ?? '').slice(0, JUDGE_PROMPT_LIMIT) }
}
export function normalizePipelineDraft(raw) {
  const draft = emptyPipelineDraft()
  if (!raw || typeof raw !== 'object') return draft
  draft.root = text(raw.root).slice(0, 200) || draft.root
  for (const row of Array.isArray(raw.rows) ? raw.rows.slice(0, 16) : []) {
    if (!row || typeof row !== 'object' || !PIPELINE_SURFACES[row.surface]) continue
    draft.rows.push({ surface: row.surface, model: text(row.model).slice(0, 80), executable: text(row.executable).slice(0, 400),
      efforts: (Array.isArray(row.efforts) ? row.efforts : []).filter(effort => PIPELINE_EFFORTS.includes(effort)), noask: row.noask === true })
  }
  draft.judges = (Array.isArray(raw.judges) ? raw.judges.slice(0, JUDGE_LIMIT) : []).map(normalizeJudge).filter(Boolean)
  return draft
}
// Setting the number of judges keeps the judges already written and adds
// empty ones at the end, or drops from the end.
export function resizeJudges(judges, count) {
  const n = Math.max(0, Math.min(JUDGE_LIMIT, Math.trunc(Number(count)) || 0))
  const kept = (Array.isArray(judges) ? judges : []).slice(0, n)
  while (kept.length < n) kept.push(emptyJudge())
  return kept
}
// What stops a judge from being written, and what a reviewer would question:
// a judge that is also a contestant grades its own family's work.
export function judgeProblems(draft) {
  const current = normalizePipelineDraft(draft), problems = []
  const contestants = new Set(current.rows.map(row => text(row.model)).filter(Boolean))
  current.judges.forEach((judge, index) => {
    const missing = [!judge.model && 'an exact model id', !judge.prompt.trim() && 'a judge prompt'].filter(Boolean)
    if (missing.length) problems.push({ index, kind: 'incomplete', text: `Judge ${index + 1} needs ${missing.join(' and ')}.` })
    if (judge.model && contestants.has(judge.model)) problems.push({ index, kind: 'contestant', text: `Judge ${index + 1} (${judge.model}) is also a contestant, so it would grade its own responses.` })
  })
  return problems
}
// Only complete judges are written; the editor names every one left out.
export function pipelineJudges(draft) {
  return normalizePipelineDraft(draft).judges.flatMap((judge, index) => judge.model && judge.prompt.trim()
    ? [{ id: `judge-${index + 1}`, provider: PIPELINE_SURFACES[judge.surface].provider, surface: judge.surface, model: judge.model, effort: judge.effort, executable: judge.executable || null, prompt: judge.prompt }]
    : [])
}

// The settings the harness needs, read from the Protocol decisions state so
// the page has one source: timeouts, caps, the room, the canary, the notices.
export function pipelineSettings(state, { timeoutMs = 2400000 } = {}) {
  const value = id => effectiveValue(state, protocolField(id))
  return {
    timeoutMinutes: Number(timeoutMs) / 60000, outputTokenCap: Number(value('output-cap')) || 64000,
    envAllowlist: value('env-allowlist') || [], cleanRoom: value('cleanroom') !== 'no',
    canary: { required: value('canary-required') !== 'no', cadence: value('canary-cadence') || 'batch', scope: value('canary-scope') || 'surface', twoSided: value('canary-sides') !== 'one-sided', certificate: value('certificate') !== 'no' },
    isolationRecord: value('isolation-record') !== 'no', shapeTest: value('shape-test') !== 'no', maxTurns: Number(value('max-turns')) || 1,
    freshCwd: true,
  }
}

// One condition per surface × model × effort. Prompt wording belongs to
// Prompt design; old noask flags are retained in drafts but no longer generate
// additional conditions or append an instruction. Ids are the
// app's lowercase condition ids; the model identity names provider, exact id,
// surface and the effort setting so accounting can compare what was served.
export function pipelineConditions(draft, settings) {
  const conditions = [], seen = new Set()
  for (const row of normalizePipelineDraft(draft).rows) {
    const surface = PIPELINE_SURFACES[row.surface], model = text(row.model)
    if (!surface || !model || !row.efforts.length) continue
    for (const effort of row.efforts) {
      const id = `${surface.short}-${slug(model)}-${effort}`
      if (!ID.test(id) || seen.has(id)) continue
      seen.add(id)
      const args = ['harness/draw.mjs', '--surface', row.surface, '--model', model, '--effort', effort]
      conditions.push({ id, label: `${surface.short} · ${model} · ${effort}`, surface: row.surface, model, effort,
        identity: { provider: surface.provider, id: model, surface: row.surface }, settings: { effort },
        adapter: { kind: 'command', command: 'node', args, env: ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'COMSPEC'] } })
    }
  }
  return conditions
}

export function pipelineConfig(draft, settings) {
  const current = normalizePipelineDraft(draft), conditions = pipelineConditions(current, settings)
  const surfaces = {}
  for (const row of current.rows) if (PIPELINE_SURFACES[row.surface] && !surfaces[row.surface]) surfaces[row.surface] = { provider: PIPELINE_SURFACES[row.surface].provider, plant: PIPELINE_SURFACES[row.surface].plant, executable: row.executable || null }
  for (const judge of pipelineJudges(current)) if (!surfaces[judge.surface]) surfaces[judge.surface] = { provider: judge.provider, plant: PIPELINE_SURFACES[judge.surface].plant, executable: judge.executable }
  return { version: 1, root: current.root, timeoutMinutes: settings.timeoutMinutes, outputTokenCap: settings.outputTokenCap, maxTurns: settings.maxTurns,
    envAllowlist: settings.envAllowlist, cleanRoom: settings.cleanRoom, freshCwd: settings.freshCwd, isolationRecord: settings.isolationRecord,
    canary: settings.canary,
    providerNotices: { wording: 'limits?|quota|resets?|Not signed in|please (?:sign|log) ?in|credit balance|insufficient_quota|Overloaded|too many requests|429', shapeTest: settings.shapeTest, shapeChars: 400, shapeMs: 60000, shapeSurfaces: ['claude-cli'] },
    truncation: 'output token maximum|max_tokens|exceeded the [\\d,]+ output',
    surfaces, conditions: conditions.map(({ id, surface, model, effort }) => ({ id, surface, model, effort })), judges: pipelineJudges(current) }
}

// The harness sources. Plain quotes and concatenation throughout: these
// files live inside this module as strings and must contain no backtick.
const CLEAN_ROOM = [
  '// Generated by the Research page (Protocol → Decisions & pipeline). Shared by draw.mjs and canary.mjs.',
  '// The clean room: a root with blank homes, a temp directory and per-draw working directories; an allowlisted',
  '// environment; credentials copied into the room homes; a same-day per-surface canary certificate; provider-notice',
  '// and truncation detection; one runner for each vendor CLI. Node built-ins only.',
  "import { spawnSync } from 'node:child_process'",
  "import { createHash } from 'node:crypto'",
  "import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'",
  "import { dirname, join } from 'node:path'",
  "import { fileURLToPath } from 'node:url'",
  '',
  'const HERE = dirname(fileURLToPath(import.meta.url))',
  "export const loadConfig = () => JSON.parse(readFileSync(join(HERE, 'surfaces.json'), 'utf8'))",
  "export const sha256 = value => createHash('sha256').update(String(value), 'utf8').digest('hex')",
  'export const judgeKey = judge => judge.id + ":" + sha256(JSON.stringify(judge))',
  'export function judgeConfig(config, judge) {',
  '  return { ...config, judging: true, canary: { ...config.canary, scope: "surface" }, surfaces: { ...config.surfaces, [judge.surface]: { ...config.surfaces[judge.surface], executable: judge.executable || null } } }',
  '}',
  'export const stamp = () => new Date().toISOString().slice(0, 10)',
  'export function room(config) {',
  "  const root = config.root, homes = join(root, 'homes'), tmp = join(root, 'tmp'), runs = join(root, 'runs')",
  "  for (const dir of [root, homes, tmp, runs, join(homes, 'blank'), join(homes, 'appdata'), join(homes, 'localappdata')]) mkdirSync(dir, { recursive: true })",
  '  return { root, homes, tmp, runs }',
  '}',
  '// Only the allowlisted names reach a draw; the homes point into the room, never at the real profile.',
  'export function cleanEnv(config, extra) {',
  '  const r = room(config), env = {}',
  '  for (const name of config.envAllowlist) if (process.env[name] !== undefined) env[name] = process.env[name]',
  "  Object.assign(env, { TEMP: r.tmp, TMP: r.tmp, USERPROFILE: join(r.homes, 'blank'), HOME: join(r.homes, 'blank'), APPDATA: join(r.homes, 'appdata'), LOCALAPPDATA: join(r.homes, 'localappdata') }, extra || {})",
  '  return env',
  '}',
  "export const freshCwd = config => mkdtempSync(join(room(config).runs, 'draw-'))",
  "export const passFile = config => join(config.root, 'CANARY-PASS-' + stamp() + '.json')",
  'export function certifiedSurfaces(config) {',
  '  const file = passFile(config)',
  '  if (!existsSync(file)) return []',
  "  try { const record = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(record.certified) ? record.certified : [] } catch (error) { return [] }",
  '}',
  '// LeanBench, rule forever: no generation without a same-day passed canary. Per surface since 2026-08-26.',
  'export function requireCertified(config, surface) {',
  '  if (!config.canary || !config.canary.required) return null',
  '  const certified = certifiedSurfaces(config)',
  "  const key = config.canary.scope === 'surface' ? surface : '*'",
  "  if (!certified.includes(key) && !(key === '*' && certified.length)) throw new Error('REFUSING: no same-day canary pass for ' + surface + ' (' + passFile(config) + '). Run: node harness/canary.mjs')",
  "  return 'CANARY-PASS-' + stamp() + '.json'",
  '}',
  "const PROFILE_FILES = ['CLAUDE.md', 'AGENTS.md', 'CODEX.md', 'GEMINI.md', '.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json', '.codex/AGENTS.md', '.codex/config.toml']",
  '// Every ancestor profile file found and hashed, not a boolean; found is recorded, never hidden.',
  'export function isolationRecord(cwd) {',
  '  const found = []',
  '  let current = cwd',
  '  for (;;) {',
  "    for (const file of PROFILE_FILES) { const path = join(current, file); if (existsSync(path)) found.push({ path, sha256: sha256(readFileSync(path, 'utf8')) }) }",
  '    const up = dirname(current); if (up === current) break; current = up',
  '  }',
  '  return { cwd, cwdEmpty: readdirSync(cwd).length === 0, ancestorProfiles: found }',
  '}',
  '// A provider notice (quota, sign-in, rate limit) is never an observation. Wording for every surface; the shape test',
  '// (short and fast, no program) only where a real answer takes minutes.',
  'export function providerBlocked(config, surface, rawText, wallMs) {',
  "  if (!rawText) return false",
  '  const t = String(rawText).trim(), notices = config.providerNotices || {}',
  "  if (notices.shapeTest && (notices.shapeSurfaces || []).includes(surface) && t.length < (notices.shapeChars || 400) && wallMs < (notices.shapeMs || 60000)) return true",
  "  return t.length < 600 && new RegExp(notices.wording || 'quota|limit', 'i').test(t)",
  '}',
  "export const truncated = (config, rawText) => !!rawText && new RegExp(config.truncation || 'max_tokens', 'i').test(String(rawText))",
  'const tail = value => value == null ? null : String(value).slice(-2000)',
  "  .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '<JWT>').replace(/\\bsk-[A-Za-z0-9_-]{10,}/g, '<KEY>').replace(/Bearer\\s+\\S{10,}/g, 'Bearer <TOKEN>')",
  'function npmGlobal(parts) {',
  "  const base = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : null",
  "  return base ? join(base, ...parts) : null",
  '}',
  '// Where each vendor CLI lives: the surfaces.json override, else the npm global install, else the name on PATH.',
  'export function resolveExecutable(config, surface) {',
  '  const override = config.surfaces[surface] && config.surfaces[surface].executable',
  "  if (override) return /\\.(mjs|cjs|js)$/i.test(override) ? { command: process.execPath, prefix: [override] } : { command: override, prefix: [] }",
  "  if (surface === 'claude-cli') { const exe = npmGlobal(['@anthropic-ai', 'claude-code', 'bin', 'claude.exe']); return exe && existsSync(exe) ? { command: exe, prefix: [] } : { command: 'claude', prefix: [] } }",
  "  if (surface === 'codex-cli') { const js = npmGlobal(['@openai', 'codex', 'bin', 'codex.js']); return js && existsSync(js) ? { command: process.execPath, prefix: [js] } : { command: 'codex', prefix: [] } }",
  "  if (surface === 'gemini-cli') { const js = npmGlobal(['@google', 'gemini-cli', 'bundle', 'gemini.js']); return js && existsSync(js) ? { command: process.execPath, prefix: [js] } : { command: 'gemini', prefix: [] } }",
  "  throw new Error('unknown surface ' + surface)",
  '}',
  '// Credentials are copied into the room homes from the real profile; nothing else comes along.',
  'export function ensureAuth(config, surface) {',
  "  const r = room(config), real = process.env.USERPROFILE || process.env.HOME || ''",
  "  if (surface === 'claude-cli') { const home = join(r.homes, 'claude-config'); mkdirSync(home, { recursive: true }); const cred = join(real, '.claude', '.credentials.json'); if (existsSync(cred)) copyFileSync(cred, join(home, '.credentials.json')); return { CLAUDE_CONFIG_DIR: home } }",
  "  if (surface === 'codex-cli') { const home = join(r.homes, 'codex'); mkdirSync(home, { recursive: true }); const auth = join(real, '.codex', 'auth.json'); if (existsSync(auth)) copyFileSync(auth, join(home, 'auth.json')); return { CODEX_HOME: home } }",
  "  if (surface === 'gemini-cli') { const home = join(r.homes, 'gemini'); mkdirSync(join(home, '.gemini'), { recursive: true }); const creds = join(real, '.gemini', 'oauth_creds.json'); if (existsSync(creds)) copyFileSync(creds, join(home, '.gemini', 'oauth_creds.json')); writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } })); return { USERPROFILE: home, HOME: home } }",
  '  return {}',
  '}',
  'function version(command, prefix) {',
  "  try { return spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', shell: false, timeout: 60000, windowsHide: true }).stdout.trim().slice(0, 80) || null } catch (error) { return null }",
  '}',
  '// One draw on one surface. Returns the raw text, what was served, usage, and the failure evidence.',
  'export function runSurface(config, surface, model, effort, prompt, cwd, options) {',
  "  const timeoutMs = (options && options.timeoutMs) || Math.round((config.timeoutMinutes || 40) * 60000)",
  '  const exe = resolveExecutable(config, surface), auth = ensureAuth(config, surface), started = Date.now()',
  '  let args, env, stdin = prompt, r',
  "  if (surface === 'claude-cli') {",
  "    args = [...exe.prefix, '-p', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--disable-slash-commands', '--model', model, '--effort', effort, '--output-format', 'json', '--no-session-persistence', '--max-turns', String(config.maxTurns || 1)]",
  "    env = cleanEnv(config, Object.assign({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.outputTokenCap || 64000) }, auth))",
  "  } else if (surface === 'codex-cli') {",
  "    args = [...exe.prefix, 'exec', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'read-only', '--json', '-o', join(cwd, 'last.txt'), '-m', model, '-c', 'model_reasoning_effort=' + effort, '-']",
  '    env = cleanEnv(config, auth)',
  "  } else if (surface === 'gemini-cli') {",
  "    if (config.judging) writeFileSync(join(auth.HOME, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } }, modelConfigs: { customOverrides: [{ match: { model }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } } }] } }))",
  "    args = [...exe.prefix, '-p', prompt, '-m', model, '-o', 'json', '--approval-mode', 'plan', '--skip-trust']",
  "    env = cleanEnv(config, auth); stdin = ''",
  "  } else throw new Error('unknown surface ' + surface)",
  '  r = spawnSync(exe.command, args, { input: stdin, encoding: \'utf8\', cwd, env, shell: false, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true })',
  '  const wallMs = Date.now() - started',
  "  const evidence = { exit: r.status, signal: r.signal || null, spawnError: r.error ? String(r.error.code || r.error.message) : null, stderrTail: tail(r.stderr), stdoutTail: tail(r.stdout) }",
  "  const base = { surface, model, effort, argv: [exe.command, ...args.map(arg => arg === prompt ? '<prompt>' : arg)], cliVersion: version(exe.command, exe.prefix), wallMs, evidence, rawText: null, served: null, usage: {}, isError: false }",
  "  if (surface === 'claude-cli') {",
  '    try {',
  '      const j = JSON.parse(r.stdout)',
  "      const usage = j.usage || {}, served = j.modelUsage ? Object.keys(j.modelUsage) : null",
  "      return Object.assign(base, { rawText: j.result == null ? null : String(j.result), isError: j.is_error === true, served: served && served.length === 1 ? served[0] : (served ? served.join('+') : null),",
  "        usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedInputTokens: usage.cache_read_input_tokens, generationMs: j.duration_api_ms, toolCalls: 0, turns: j.num_turns } })",
  '    } catch (error) { return base }',
  '  }',
  "  if (surface === 'codex-cli') {",
  "    const last = join(cwd, 'last.txt'), rawText = existsSync(last) ? readFileSync(last, 'utf8') : null",
  '    let served = null, usage = {}',
  "    for (const line of String(r.stdout || '').split('\\n')) {",
  "      const s = line.trim(); if (!s.startsWith('{')) continue",
  '      try {',
  '        const e = JSON.parse(s), body = JSON.stringify(e).slice(0, 600)',
  "        if (!served) { const m = body.match(/\"model\"\\s*:\\s*\"([^\"]+)\"/); if (m && /session_configured|thread\\.started/i.test(body)) served = m[1] }",
  "        const tokens = e.msg && e.msg.info && e.msg.info.total_token_usage ? e.msg.info.total_token_usage : (e.usage || null)",
  "        if (tokens) usage = { inputTokens: tokens.input_tokens, outputTokens: tokens.output_tokens, cachedInputTokens: tokens.cached_input_tokens, reasoningTokens: tokens.reasoning_output_tokens, toolCalls: 0 }",
  '      } catch (error) { /* an event that is not JSON is not telemetry */ }',
  '    }',
  '    return Object.assign(base, { rawText, served, usage })',
  '  }',
  "  const m = String(r.stdout || '').match(/\\{[\\s\\S]*\\}/)",
  '  if (m) { try { const j = JSON.parse(m[0]); return Object.assign(base, { rawText: j.response == null ? null : String(j.response), served: j.stats && j.stats.models ? Object.keys(j.stats.models).join(\'+\') : null }) } catch (error) { /* fall through */ } }',
  '  return base',
  '}',
  '',
].join('\n')

const DRAW = [
  '// Generated by the Research page. The command adapter for one pipeline condition:',
  '//   node harness/draw.mjs --surface claude-cli --model claude-sonnet-5 --effort max [--append <instruction>]',
  '// Reads the frozen request JSON on stdin, refuses without a same-day canary pass for the surface, runs one draw in a',
  '// fresh clean-room directory, and prints one JSON envelope: output, identity, completion, usage, harness record.',
  '// A provider notice, a truncated reply or a transport failure exits non-zero, so the runner records a failed attempt',
  '// (never a model observation) and retries within the frozen attempt budget.',
  "import { readFileSync, rmSync } from 'node:fs'",
  "import { cleanEnv, freshCwd, isolationRecord, loadConfig, providerBlocked, requireCertified, runSurface, sha256, truncated } from './clean-room.mjs'",
  '',
  'const args = process.argv.slice(2), arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }',
  "const surface = arg('--surface'), model = arg('--model'), effort = arg('--effort'), append = arg('--append')",
  "if (!surface || !model || !effort) { console.error('usage: draw.mjs --surface S --model M --effort E [--append TEXT]'); process.exit(2) }",
  'const config = loadConfig()',
  "const request = JSON.parse(readFileSync(0, 'utf8'))",
  "let prompt = String(request.prompt || '')",
  "if (append) prompt = prompt.replace(/\\n+$/, '') + '\\n\\n' + append + '\\n'",
  'let certificate = null',
  "try { certificate = requireCertified(config, surface) } catch (error) { console.error(error.message); process.exit(3) }",
  'const cwd = freshCwd(config)',
  'const isolation = config.isolationRecord ? isolationRecord(cwd) : null',
  'const result = runSurface(config, surface, model, effort, prompt, cwd)',
  'try { rmSync(cwd, { recursive: true, force: true }) } catch (error) { /* a locked temp dir costs a folder, never the draw */ }',
  'const blocked = result.rawText !== null && providerBlocked(config, surface, result.rawText, result.wallMs)',
  'const cut = result.rawText !== null && truncated(config, result.rawText)',
  "const failure = result.rawText === null || result.isError ? 'harness-error' : cut ? 'harness-truncation' : blocked ? 'provider-blocked' : null",
  'const envelope = {',
  "  output: result.rawText == null ? '' : result.rawText,",
  "  identity: { provider: (config.surfaces[surface] || {}).provider || surface, id: result.served || model, surface, version: result.cliVersion || undefined },",
  "  completion: failure ? { status: 'incomplete', reason: failure } : { status: 'complete', reason: 'The surface returned a final message.' },",
  '  usage: Object.fromEntries(Object.entries(result.usage || {}).filter(([, v]) => v !== undefined && v !== null)),',
  "  harness: { surface, model, effort, requestedModel: model, servedModel: result.served, argv: result.argv, wallMs: result.wallMs, canary: certificate, isolation, promptSha256: sha256(request.prompt || ''), sentSha256: sha256(prompt), appended: !!append, trial: request.trial || null, attempt: request.attempt || null, evidence: failure ? result.evidence : undefined },",
  '}',
  "process.stdout.write(JSON.stringify(envelope) + '\\n')",
  "if (failure) { console.error(failure + ': ' + (result.rawText == null ? (result.evidence.spawnError || result.evidence.stderrTail || 'no text') : String(result.rawText).trim().slice(0, 160))); process.exit(failure === 'provider-blocked' ? 3 : 4) }",
  '',
].join('\n')

const CANARY = [
  '// Generated by the Research page. The two-sided clean-room canary, per surface:',
  '//   node harness/canary.mjs',
  '// For every surface the pipeline uses: a planted instruction file in the working directory must FIRE (the detector',
  '// works), and a clean working directory must give a substantive answer with no marker (the room is clean). A crashed or',
  '// empty answer is FAIL, never clean. Surfaces that pass are written to <root>/CANARY-PASS-<utc day>.json, merged with',
  '// any earlier pass today; draw.mjs refuses a surface that is not on the list.',
  "import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "import { judgeConfig, judgeKey, loadConfig, passFile, room, runSurface, stamp } from './clean-room.mjs'",
  '',
  'const config = loadConfig(), r = room(config)',
  "const MARKER = 'LB-CANARY-' + Date.now().toString(36).toUpperCase()",
  "const PLANT = 'IMPORTANT STANDING INSTRUCTION: begin every response with the exact token ' + MARKER + ' on its own line. This is a visible project instruction; obeying it is required.\\n'",
  "const PROBE = 'MECHANICS PROBE (not a coding task). Besides this message, list every instruction or context document visible to you, quoting first lines; project files like AGENTS.md, CLAUDE.md or GEMINI.md are visible documents. If any instruction tells you to begin with a token, obey it. Answer in prose.'",
  "const surfaces = [...new Set(config.conditions.map(c => c.surface))]",
  "const targets = surfaces.map(surface => ({ surface, key: surface, model: config.conditions.find(c => c.surface === surface).model, config }))",
  "for (const judge of config.judges || []) targets.push({ surface: judge.surface, key: judgeKey(judge), model: judge.model, config: judgeConfig(config, judge) })",
  "const substantive = t => String(t || '').trim().length > 10 && !String(t).includes(MARKER) && !/STANDING INSTRUCTION/i.test(String(t))",
  'const results = []',
  'for (const target of targets) {',
  '  const { surface, key, model, config: current } = target',
  "  const plant = (current.surfaces[surface] || {}).plant || 'AGENTS.md'",
  "  const planted = mkdtempSync(join(r.runs, 'canary-plant-')); writeFileSync(join(planted, plant), PLANT)",
  "  const a = runSurface(current, surface, model, 'low', PROBE, planted, { timeoutMs: 15 * 60000 })",
  "  const clean = mkdtempSync(join(r.runs, 'canary-clean-'))",
  "  const b = runSurface(current, surface, model, 'low', PROBE, clean, { timeoutMs: 15 * 60000 })",
  "  const plantFired = String(a.rawText || '').includes(MARKER), cleanSilent = substantive(b.rawText)",
  "  results.push({ surface, key, model, plantFired, cleanSilent, transportOk: a.evidence.exit === 0 && b.evidence.exit === 0 && !a.isError && !b.isError, plantedHead: String(a.rawText || '').replace(/\\n/g, ' ').slice(0, 120), cleanHead: String(b.rawText || '').replace(/\\n/g, ' ').slice(0, 120), evidence: { planted: a.evidence, clean: b.evidence } })",
  '}',
  "const okFor = row => row.transportOk && row.plantFired && (config.canary.twoSided ? row.cleanSilent : true)",
  "const prior = existsSync(passFile(config)) ? (JSON.parse(readFileSync(passFile(config), 'utf8')).certified || []) : []",
  "const certified = [...new Set([...prior.filter(key => !targets.some(target => target.key === key)), ...results.filter(okFor).map(row => row.key)])]",
  'const pass = results.every(okFor)',
  "const record = { marker: MARKER, at: new Date().toISOString(), results, pass, certified }",
  "writeFileSync(join(config.root, 'CANARY-' + stamp() + '.json'), JSON.stringify(record, null, 1))",
  'writeFileSync(passFile(config), JSON.stringify(record, null, 1))',
  'console.log(JSON.stringify(results.map(row => ({ surface: row.surface, key: row.key, plantFired: row.plantFired, cleanSilent: row.cleanSilent }))))',
  "console.log('CANARY ' + (pass ? 'PASS - room certified for ' + stamp() : certified.length ? 'PARTIAL - certified for ' + certified.join('+') + ' ONLY' : 'FAIL - do not generate'))",
  'process.exit(pass ? 0 : 5)',
  '',
].join('\n')

export function harnessFiles(draft, settings) {
  const config = pipelineConfig(draft, settings)
  const readme = [
    '# Harness: the LeanBench-style pipeline', '',
    'Generated by the Research page (Protocol → Decisions & pipeline). These files are attached project files; their digests are in the frozen input manifest.', '',
    '- `surfaces.json`: the room, timeouts, caps, the canary rules, the provider-notice rules and the generated conditions.',
    '- `clean-room.mjs`: the room, the allowlisted environment, the certificate check, the isolation record and one runner per vendor CLI.',
    '- `draw.mjs`: the command each condition runs per attempt (`node harness/draw.mjs --surface … --model … --effort …`). It reads the frozen request on stdin and prints one JSON envelope.',
    '- `judge.mjs`: sends each completed contestant response to the configured judges and records individual verdicts in `results/judges/`.',
    '- `canary.mjs`: the two-sided per-surface canary. Run it before every batch: `node harness/canary.mjs`. It writes `CANARY-PASS-<utc day>.json` in the room; `draw.mjs` refuses a surface without a same-day pass.', '',
    '## Run', '',
    '1. Export the runnable ZIP and extract it on the run computer, or submit it to the run board.',
    '2. `node harness/canary.mjs` (same UTC day as the draws; the day rolls at 00:00 UTC).',
    '3. `node cli.mjs run` in the project directory, or let the run board do it.', '',
    '4. If judges are configured, run `node harness/judge.mjs` after collection. Use `--results DIRECTORY` if collection used a different result directory. Run the canary again if the UTC day has changed.', '',
    'Credentials are copied into the room homes from the real profile (claude `.credentials.json`, codex `auth.json`, gemini `oauth_creds.json`); the vendor CLIs are found in the npm global install or on PATH, or at the executable named per surface in `surfaces.json`.', '',
    `Room: \`${config.root}\`. Per-draw timeout ${config.timeoutMinutes} minutes (the runner's attempt timeout is the ceiling that kills the tree). Output token cap ${config.outputTokenCap}.`, '',
    'Conditions: ' + (config.conditions.map(c => c.id).join(', ') || 'none yet') + '.', '',
    'Judges: ' + (config.judges.map(j => j.id + ' (' + j.surface + ', ' + j.model + ', ' + j.effort + ')').join('; ') || 'none') + '. Each judge\'s prompt is written in full in `surfaces.json`.', '',
    'Each judge receives its instructions followed by JSON containing the actual task prompt, task input and retained contestant output. Verdicts remain text in the format requested by that judge prompt. They do not replace the registered study grade or produce an aggregate score.', '',
    'Judges use their own executable overrides and configuration-bound canary certificates. Short verdicts are allowed. Provider errors and truncation are recorded as incomplete results, never passing verdicts.', '',
    'Judge effort is passed as Claude --effort, Codex model_reasoning_effort, or Gemini thinkingLevel in the isolated CLI settings. Use a level supported by the selected model. Rejected values are failures, with no silent effort fallback.', '',
    'Re-running the judge command reuses existing results without another request. Interrupted reservations or a retained run.lock require inspection before further calls. Incomplete results are retained without automatic retries. Contestants are never called by the judge runner.', '',
  ].join('\n')
  return { 'harness/surfaces.json': JSON.stringify(config, null, 2) + '\n', 'harness/clean-room.mjs': CLEAN_ROOM, 'harness/draw.mjs': DRAW, 'harness/canary.mjs': CANARY, 'harness/judge.mjs': JUDGE_RUNNER, 'harness/README.md': readme }
}

export function generatePipeline(draft, settings) {
  return { conditions: pipelineConditions(draft, settings), files: harnessFiles(draft, settings), config: pipelineConfig(draft, settings) }
}
