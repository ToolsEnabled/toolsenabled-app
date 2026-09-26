// What a draw records. The harness always computes the full envelope (the
// response text, the served identity, token usage, wall time, the command
// line, failure evidence); this policy says which of it is kept in the
// retained response, so a study can register "only the extracted answer and
// its hash" as readily as "everything". Dropping a field is a registered
// decision, visible in surfaces.json and the frozen input manifest.
const text = value => String(value ?? '').trim()
export const RECORD_OUTPUT_MODES = Object.freeze([['all', 'The full response text'], ['extracted', 'Only the part a pattern matches, with the hash of the full text']])
export const RECORD_EVIDENCE_MODES = Object.freeze([['failures', 'Exit status and stderr/stdout tails on failure only'], ['always', 'On every draw'], ['never', 'Never']])
export const RECORD_FLAGS = Object.freeze([
  ['tokens', 'Token counts', 'input, output, cached and reasoning tokens as the provider reports them'],
  ['time', 'Timing', 'wall time of the draw and the provider\'s generation time'],
  ['provider', 'Provider and served model', 'which provider answered and the exact model it served; off records only the requested model'],
  ['toolCalls', 'Tool calls and turns', 'how many turns and tool calls the surface reports'],
  ['argv', 'The command line', 'the exact arguments the vendor CLI was started with, prompt elided'],
])
// Working directories: a draw's fresh directory is removed after the draw
// unless the study keeps them (inspection of what a tool-using agent wrote).
export const RECORD_KEEP_DRAWS = Object.freeze(['keepDraws', 'Keep every draw\'s working directory in the room', 'what the agent wrote or ran stays on disk under the room for inspection; off removes each directory after its draw'])
export function emptyRecordPolicy() { return { output: 'all', pattern: '', flags: '', tokens: true, time: true, provider: true, toolCalls: true, argv: true, evidence: 'failures', keepDraws: false } }
export function normalizeRecordPolicy(raw) {
  const policy = emptyRecordPolicy()
  if (!raw || typeof raw !== 'object') return policy
  policy.output = raw.output === 'extracted' ? 'extracted' : 'all'
  policy.pattern = String(raw.pattern ?? '').slice(0, 2000)
  policy.flags = text(raw.flags).replace(/[^imsu]/g, '').slice(0, 4)
  for (const [key] of RECORD_FLAGS) policy[key] = raw[key] !== false
  policy.evidence = ['failures', 'always', 'never'].includes(raw.evidence) ? raw.evidence : 'failures'
  policy.keepDraws = raw.keepDraws === true
  return policy
}
export function recordProblems(policy) {
  const current = normalizeRecordPolicy(policy), problems = []
  if (current.output === 'extracted') {
    if (!current.pattern) problems.push({ kind: 'pattern', text: 'Recording only the extracted output needs a pattern.' })
    else { try { new RegExp(current.pattern, current.flags) } catch (error) { problems.push({ kind: 'pattern', text: 'The extraction pattern is not a valid regular expression: ' + error.message }) } }
  }
  if (current.provider === false) problems.push({ kind: 'provider', text: 'Without the served model, accounting cannot show that a provider silently served a different model.' })
  return problems
}
// Applies the policy to one envelope. Free of outside references so the
// harness embeds this very function and the page previews the same result.
export function applyRecordPolicy(policy, envelope) {
  const p = policy || {}, out = JSON.parse(JSON.stringify(envelope || {}))
  out.harness = out.harness || {}
  out.usage = out.usage || {}
  if (p.output === 'extracted') {
    let matched = null
    try { const m = new RegExp(String(p.pattern || ''), String(p.flags || '').replace('g', '')).exec(String(out.output || '')); if (m) matched = m[1] !== undefined ? m[1] : m[0] } catch (error) { matched = null }
    out.harness.extraction = { pattern: String(p.pattern || ''), flags: String(p.flags || ''), matched: matched !== null, fullChars: String(out.output || '').length }
    out.output = matched === null ? '' : matched
  }
  if (p.tokens === false) for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']) delete out.usage[key]
  if (p.time === false) { delete out.usage.generationMs; delete out.harness.wallMs }
  if (p.toolCalls === false) { delete out.usage.toolCalls; delete out.usage.turns }
  if (p.argv === false) delete out.harness.argv
  if (p.provider === false && out.identity) { out.identity = { provider: out.identity.provider, id: out.harness.requestedModel || out.identity.id, surface: out.identity.surface }; delete out.harness.servedModel }
  if (p.evidence === 'never') delete out.harness.evidence
  return out
}
export function recordSummary(policy) {
  const current = normalizeRecordPolicy(policy)
  const kept = RECORD_FLAGS.filter(([key]) => current[key]).map(([, label]) => label.toLowerCase())
  return (current.output === 'extracted' ? 'Only the text matching /' + current.pattern + '/' + current.flags + ' (with the full text\'s hash)' : 'The full response text') + '; ' + (kept.length ? kept.join(', ') : 'no other fields') + '; failure evidence ' + current.evidence + (current.keepDraws ? '; working directories kept' : '') + '.'
}
