// The LeanBench-style pipeline: surfaces × models × efforts become command
// conditions the study accepts, and the generated harness runs one draw in a
// clean room, refuses without a same-day canary, and never banks a provider
// notice as an observation. The vendor CLI here is a fake that behaves like
// claude's print mode: JSON with result and usage, and it obeys a planted
// CLAUDE.md marker exactly as the real thing did in the calibration.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { generatePipeline, normalizePipelineDraft, pipelineConditions, pipelineSettings, emptyPipelineDraft, emptyJudge, judgeProblems, resizeJudges, JUDGE_LIMIT } from '../../src/research-pipeline.mjs'
import { emptyProtocolDecisions } from '../../src/research-protocol.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { validateStudy } from '../../src/benchmark/study.mjs'

const settings = () => pipelineSettings(emptyProtocolDecisions())
const draftWith = rows => ({ ...emptyPipelineDraft(), rows })

test('surfaces × models × efforts become conditions the study accepts', () => {
  const draft = draftWith([{ surface: 'claude-cli', model: 'claude-sonnet-5', executable: '', efforts: ['high', 'max'], noask: true }, { surface: 'codex-cli', model: 'gpt-5.6-luna', executable: '', efforts: ['low'], noask: false }])
  const conditions = pipelineConditions(draft, settings())
  assert.deepEqual(conditions.map(item => item.id), ['claude-claude-sonnet-5-high', 'claude-claude-sonnet-5-max', 'codex-gpt-5-6-luna-low'])
  assert.deepEqual(conditions[0].adapter.args, ['harness/draw.mjs', '--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'high'])
  assert.ok(conditions.every(condition => !condition.adapter.args.includes('--append')), 'an old noask flag cannot add instructions or twin conditions')
  assert.equal(normalizePipelineDraft(draft).rows[0].noask, true, 'the old selection is retained for reference')
  const spec = genericStarter()
  spec.conditions = conditions.map(item => ({ id: item.id, label: item.label, model: { ...item.identity, settings: item.settings }, adapter: item.adapter }))
  if (spec.analysisPlan?.contrasts) spec.analysisPlan.contrasts = []
  if (spec.observationPlan?.overrides) spec.observationPlan.overrides = {}
  assert.doesNotThrow(() => validateStudy(spec), 'the frozen study accepts the generated command conditions')
  assert.deepEqual(normalizePipelineDraft({ rows: [{ surface: 'ghost', model: 'x', efforts: ['max'] }, { surface: 'codex-cli', model: ' m ', efforts: ['max', 'ultra'], noask: 'yes' }] }).rows, [{ surface: 'codex-cli', model: 'm', executable: '', efforts: ['max'], noask: false }])
})

test('the harness uses the schedule timeout and ignores retired instruction settings', () => {
  const state = emptyProtocolDecisions()
  state.values = { 'draw-timeout': 40, 'noask-text': 'A stale instruction.', noask: 'yes' }
  const current = pipelineSettings(state, { timeoutMs: 123456 })
  assert.equal(Math.round(current.timeoutMinutes * 60000), 123456)
  assert.equal(current.noaskText, undefined)
  const generated = generatePipeline(draftWith([{ surface: 'claude-cli', model: 'model', efforts: ['low'], noask: true }]), current)
  assert.equal(Math.round(JSON.parse(generated.files['harness/surfaces.json']).timeoutMinutes * 60000), 123456)
  assert.equal(generated.conditions.length, 1)
  assert.ok(!JSON.stringify(generated).includes('A stale instruction.'))
})

test('judges: the person sets how many, each model and effort and its prompt; only complete judges are written', () => {
  assert.deepEqual(emptyJudge(), { surface: 'claude-cli', model: '', effort: 'medium', executable: '', prompt: '' }, 'nothing is prefilled for the person')
  assert.equal(resizeJudges([], 3).length, 3)
  assert.equal(resizeJudges([], 99).length, JUDGE_LIMIT)
  const kept = resizeJudges([{ ...emptyJudge(), model: 'keep-me' }, emptyJudge(), emptyJudge()], 1)
  assert.deepEqual(kept.map(judge => judge.model), ['keep-me'], 'shrinking drops from the end and keeps what was written')
  const draft = draftWith([{ surface: 'claude-cli', model: 'claude-sonnet-5', executable: '', efforts: ['max'], noask: false }])
  draft.judges = [
    { surface: 'codex-cli', model: 'gpt-5.6-sol', effort: 'high', executable: '', prompt: 'Score the program against the task.' },
    { surface: 'claude-cli', model: 'claude-sonnet-5', effort: 'low', executable: '', prompt: 'Also score it.' },
    { surface: 'gemini-cli', model: '', effort: 'medium', executable: '', prompt: '' },
  ]
  assert.deepEqual(judgeProblems(draft).map(problem => [problem.kind, problem.index]), [['contestant', 1], ['incomplete', 2]])
  assert.match(judgeProblems(draft)[1].text, /Judge 3 needs an exact model id and a judge prompt/)
  const { config, conditions, files } = generatePipeline(draft, settings())
  assert.deepEqual(conditions.map(item => item.id), ['claude-claude-sonnet-5-max'], 'judges never become contestant conditions')
  assert.deepEqual(config.judges, [
    { id: 'judge-1', provider: 'openai', surface: 'codex-cli', model: 'gpt-5.6-sol', effort: 'high', executable: null, prompt: 'Score the program against the task.' },
    { id: 'judge-2', provider: 'anthropic', surface: 'claude-cli', model: 'claude-sonnet-5', effort: 'low', executable: null, prompt: 'Also score it.' },
  ])
  assert.deepEqual(JSON.parse(files['harness/surfaces.json']).judges, config.judges, 'each judge and its full prompt reach the harness')
  assert.match(files['harness/README.md'], /Judges: judge-1 \(codex-cli, gpt-5\.6-sol, high\); judge-2 \(claude-cli, claude-sonnet-5, low\)/)
  const normalized = normalizePipelineDraft({ judges: [{ surface: 'ghost' }, { surface: 'gemini-cli', model: ' m ', effort: 'ultra', prompt: 'p'.repeat(30000) }] }).judges
  assert.equal(normalized.length, 1); assert.equal(normalized[0].model, 'm'); assert.equal(normalized[0].effort, 'medium'); assert.equal(normalized[0].prompt.length, 20000)
  assert.deepEqual(normalizePipelineDraft({ rows: [] }).judges, [], 'a draft saved before judges existed opens with none')
})

const FAKE_CLAUDE = `
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('fake-claude 1.0\\n'); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
const control = process.env.FAKE_REPLY_FILE && existsSync(process.env.FAKE_REPLY_FILE) ? readFileSync(process.env.FAKE_REPLY_FILE, 'utf8') : ''
let result = control || ('Here is the program for: ' + prompt.slice(0, 40).replace(/\\n/g, ' ') + '\\n\`\`\`python\\nclass Algo(QCAlgorithm):\\n    pass\\n\`\`\`')
const plant = join(process.cwd(), 'CLAUDE.md')
if (existsSync(plant)) { const marker = (readFileSync(plant, 'utf8').match(/LB-CANARY-[A-Z0-9]+/) || [])[0]; if (marker) result = marker + '\\n' + result }
const model = args[args.indexOf('--model') + 1]
process.stdout.write(JSON.stringify({ result, is_error: false, num_turns: 1, duration_ms: 12, duration_api_ms: 9, usage: { input_tokens: 21, output_tokens: 34, cache_read_input_tokens: 0 }, modelUsage: { [model]: { inputTokens: 21 } }, session_id: 'fake' }) + '\\n')
`

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = join(root, 'fake-claude.mjs'), reply = join(root, 'reply.txt')
  await writeFile(fake, FAKE_CLAUDE)
  const draft = { ...emptyPipelineDraft(), root: join(root, 'room'), rows: [{ surface: 'claude-cli', model: 'claude-sonnet-5', executable: fake, efforts: ['low'], noask: false }] }
  // The shape test (short and fast means a provider notice) is calibrated to a real claude draw at max effort; a fake
  // answers in milliseconds, so it is off here and exercised on its own below.
  const current = { ...settings(), shapeTest: false, envAllowlist: ['PATH', 'SystemRoot', 'windir', 'FAKE_REPLY_FILE'] }
  const generated = generatePipeline(draft, current)
  for (const [path, contents] of Object.entries(generated.files)) { await mkdir(join(root, 'harness'), { recursive: true }); await writeFile(join(root, path), contents) }
  const run = (script, args, input, extraEnv = {}) => spawnSync(process.execPath, [resolve(root, script), ...args], { cwd: root, input, encoding: 'utf8', env: { ...process.env, FAKE_REPLY_FILE: reply, ...extraEnv }, timeout: 120000, windowsHide: true })
  return { root, reply, generated, run }
}
const request = { version: 1, projectSha256: 'a'.repeat(64), trial: { id: 't1', taskId: 'task-1', conditionId: 'claude-claude-sonnet-5-low', replicate: 1 }, attempt: 1, prompt: 'Buy SPY when its close crosses above its 100-day SMA.', input: null, model: { provider: 'anthropic', id: 'claude-sonnet-5' } }

test('the harness refuses without a same-day canary, certifies the surface two-sided, then draws one envelope', async t => {
  const { root, run, generated } = await project(t)
  assert.deepEqual(generated.conditions.map(item => item.id), ['claude-claude-sonnet-5-low'])
  const refused = run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low'], JSON.stringify(request))
  assert.equal(refused.status, 3); assert.match(refused.stderr, /REFUSING: no same-day canary pass for claude-cli/)
  const canary = run('harness/canary.mjs', [], '')
  assert.equal(canary.status, 0, canary.stderr + canary.stdout)
  assert.match(canary.stdout, /CANARY PASS - room certified/)
  const pass = JSON.parse(await readFile(join(root, 'room', `CANARY-PASS-${new Date().toISOString().slice(0, 10)}.json`), 'utf8'))
  assert.deepEqual(pass.certified, ['claude-cli']); assert.equal(pass.results[0].plantFired, true); assert.equal(pass.results[0].cleanSilent, true)
  const drawn = run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low'], JSON.stringify(request))
  assert.equal(drawn.status, 0, drawn.stderr)
  const envelope = JSON.parse(drawn.stdout)
  assert.match(envelope.output, /class Algo\(QCAlgorithm\)/)
  assert.deepEqual(envelope.identity, { provider: 'anthropic', id: 'claude-sonnet-5', surface: 'claude-cli', version: 'fake-claude 1.0' })
  assert.deepEqual(envelope.completion, { status: 'complete', reason: 'The surface returned a final message.' })
  assert.equal(envelope.usage.inputTokens, 21); assert.equal(envelope.usage.outputTokens, 34); assert.equal(envelope.usage.generationMs, 9)
  assert.equal(envelope.harness.canary, `CANARY-PASS-${new Date().toISOString().slice(0, 10)}.json`)
  // The record lists every profile file above the room, hashed; a room under a
  // user profile that carries a CLAUDE.md shows it here rather than hiding it.
  assert.equal(envelope.harness.isolation.cwdEmpty, true); assert.ok(Array.isArray(envelope.harness.isolation.ancestorProfiles))
  for (const found of envelope.harness.isolation.ancestorProfiles) assert.match(found.sha256, /^[0-9a-f]{64}$/)
  assert.equal(envelope.harness.argv[0], process.execPath); assert.ok(envelope.harness.argv.includes('--no-session-persistence'))
  assert.equal(envelope.harness.sentSha256, envelope.harness.promptSha256, 'nothing appended on the base condition')
})

test('a provider notice is refused, not banked; an appended instruction changes only what was sent', async t => {
  const { root, run, reply } = await project(t)
  assert.equal(run('harness/canary.mjs', [], '').status, 0)
  await writeFile(reply, "You've hit your session limit · resets 3pm")
  const blocked = run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low'], JSON.stringify(request))
  assert.equal(blocked.status, 3); assert.match(blocked.stderr, /provider-blocked/)
  const envelope = JSON.parse(blocked.stdout)
  assert.deepEqual(envelope.completion, { status: 'incomplete', reason: 'provider-blocked' })
  await rm(reply, { force: true })
  const appended = run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low', '--append', 'You will NOT return anything except for the program.'], JSON.stringify(request))
  assert.equal(appended.status, 0, appended.stderr)
  const sent = JSON.parse(appended.stdout)
  assert.equal(sent.harness.appended, true); assert.notEqual(sent.harness.sentSha256, sent.harness.promptSha256); assert.equal(sent.harness.promptSha256, JSON.parse(blocked.stdout).harness.promptSha256)
  // With the shape test on, the same fast short answer is refused as a notice: the setting is the claude-at-max calibration.
  const config = JSON.parse(await readFile(join(root, 'harness/surfaces.json'), 'utf8')); config.providerNotices.shapeTest = true
  await writeFile(join(root, 'harness/surfaces.json'), JSON.stringify(config))
  const shaped = run('harness/draw.mjs', ['--surface', 'claude-cli', '--model', 'claude-sonnet-5', '--effort', 'low'], JSON.stringify(request))
  assert.equal(shaped.status, 3); assert.equal(JSON.parse(shaped.stdout).completion.reason, 'provider-blocked')
})
