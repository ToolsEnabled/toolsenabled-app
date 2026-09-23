// The third contract: EXTRACTION.
//
// An adapter contract says how a response is fetched, and a grader contract
// says how it is scored. Between them sits the question neither answers: given
// one reply, which bytes are the candidate program? Until this module existed
// that answer lived in the Lean vertical as pythonSource(), and audit.mjs and
// readiness.mjs imported it, so the core reached into a vertical to parse a
// response and every benchmark silently inherited Lean's Python-shaped rules.
//
// Extraction is a declared per-project POLICY here, not hardcoded behaviour.
// "Take the whole reply unless it is one fenced block" stops being a fact about
// the codebase and becomes pick/mode/prose values a project states and freezes,
// so Lean Bench can stay strict while a third party is lenient and both stay
// reproducible: the same reply and the same policy always extract the same
// bytes, and a reader can see which rule produced them.
import { invariant, object } from './prompts.mjs'

export const EXTRACTION_POLICY_VERSION = 1

// Two different things can be wrong with a reply, and a reader must be able to
// tell them apart: the reply carried a program in the WRONG SHAPE (prose around
// it, or several blocks), or it carried NO program at all. Both refuse before
// any container, but they are not the same finding, and neither is a program
// that really ran and crashed. These are core vocabulary, not Python concepts.
export const SOURCE_FORMAT_VIOLATION = 'format-violation'
export const SOURCE_NO_PROGRAM = 'no-program'

// mode     where the program sits in the reply
//   fenced    a markdown code fence is accepted, and a bare reply is too
//   raw       the whole reply is the program; a fence is a format violation
//   envelope  the reply is JSON and one declared field holds the program
//   custom    the vertical supplies extract(); the core does not guess
// pick     which fence counts when the reply has more than one: only/last/largest
// prose    what a fence surrounded by other text means: refuse or allow
export const EXTRACTION_MODES = Object.freeze(['fenced', 'raw', 'envelope', 'custom'])
export const EXTRACTION_PICKS = Object.freeze(['only', 'last', 'largest'])
export const PROSE_BEHAVIOURS = Object.freeze(['refuse', 'allow'])
const DEFAULT_MAX_BYTES = 1024 * 1024

function refuseShape(condition, message) {
  try { invariant(condition, message) } catch (error) { error.sourceFailure = SOURCE_FORMAT_VIOLATION; throw error }
}

export function sourceFailureClassification(error) {
  return error?.sourceFailure === SOURCE_FORMAT_VIOLATION ? SOURCE_FORMAT_VIOLATION : SOURCE_NO_PROGRAM
}

export function validateExtractionPolicy(policy) {
  invariant(object(policy), 'An extraction policy is required.')
  invariant(policy.version === EXTRACTION_POLICY_VERSION, `Unsupported extraction policy version: ${policy.version}. This runtime declares ${EXTRACTION_POLICY_VERSION}.`)
  invariant(EXTRACTION_MODES.includes(policy.mode), `Extraction mode must be one of ${EXTRACTION_MODES.join(', ')}.`)
  invariant(EXTRACTION_PICKS.includes(policy.pick), `Extraction pick must be one of ${EXTRACTION_PICKS.join(', ')}.`)
  invariant(PROSE_BEHAVIOURS.includes(policy.prose), `Extraction prose behaviour must be one of ${PROSE_BEHAVIOURS.join(', ')}.`)
  invariant(typeof policy.language === 'string' && policy.language.trim(), 'An extraction policy must name the language its programs are written in.')
  invariant(typeof policy.label === 'string' && policy.label.trim(), 'An extraction policy must carry the display name used in refusal messages.')
  invariant(Number.isSafeInteger(policy.maxBytes) && policy.maxBytes > 0, 'An extraction policy must bound the reply size it accepts.')
  if (policy.mode === 'envelope') invariant(typeof policy.field === 'string' && policy.field.trim(), 'An envelope policy must name the field holding the program.')
  if (policy.mode === 'custom') invariant(typeof policy.extract === 'function', 'A custom policy must supply extract(text, policy).')
  return policy
}

// A declared policy is frozen at declaration so a vertical cannot be edited into
// a different extraction rule after a project has been compiled against it.
export function declareExtractionPolicy({ mode, language, label, pick = 'only', prose = 'refuse', maxBytes = DEFAULT_MAX_BYTES, sizeLabel, field, extract, note } = {}) {
  return Object.freeze(validateExtractionPolicy({
    version: EXTRACTION_POLICY_VERSION, mode, language, label: label ?? language, pick, prose, maxBytes,
    sizeLabel: sizeLabel ?? `${maxBytes} bytes`,
    ...(field ? { field } : {}), ...(extract ? { extract } : {}), ...(note ? { note } : {})
  }))
}

// The comparable, serializable form of a policy. A function cannot be frozen
// into a project, so a custom policy is identified by its declared note.
export function extractionPolicyRecord(policy) {
  const { extract: _extract, ...rest } = validateExtractionPolicy(policy)
  return Object.freeze({ ...rest })
}

// A line that opens with ``` outside every string literal and comment cannot be
// code in a backtick-free language such as Python, so it starts a markdown code
// block amid other text. An unclosed one-line quote, such as an apostrophe in
// prose, ends with its line.
function codeBlockAmidText(text) {
  let quote = '', lineStart = true
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index++
      else if (char === '\n' && quote.length === 1) { quote = ''; lineStart = true }
      else if (text.startsWith(quote, index)) { index += quote.length - 1; quote = '' }
      continue
    }
    if (lineStart) {
      let first = index
      while (text[first] === ' ' || text[first] === '\t') first++
      if (text.startsWith('```', first)) return true
    }
    lineStart = char === '\n'
    if (char === '#') { const end = text.indexOf('\n', index); if (end < 0) return false; index = end - 1 }
    else if (char === '"' || char === "'") { quote = text.startsWith(char.repeat(3), index) ? char.repeat(3) : char; index += quote.length - 1 }
  }
  return false
}

// The fence tags a policy accepts: an untagged fence, the policy's language, and
// that language's conventional short forms.
const LANGUAGE_ALIASES = Object.freeze({ python: ['py'], javascript: ['js'], typescript: ['ts'], csharp: ['cs'] })
function tagsFor(language) {
  const name = language.toLowerCase()
  return ['', name, ...(LANGUAGE_ALIASES[name] || [])]
}

// Every fence in the reply, in source order, so pick can choose between them.
function fences(text, language) {
  const tags = tagsFor(language)
  const pattern = /```([A-Za-z0-9_+-]*)[ \t]*\n([\s\S]*?)\n[ \t]*```/g
  const found = []
  for (const match of text.matchAll(pattern)) {
    if (!tags.includes(match[1].toLowerCase())) continue
    found.push({ body: match[2], start: match.index, end: match.index + match[0].length })
  }
  return found
}

function chooseFence(found, pick) {
  if (pick === 'last') return found.at(-1)
  if (pick === 'largest') return found.reduce((best, row) => (best.body.length >= row.body.length ? best : row))
  return found[0]
}

function replyText(output, policy) {
  const text = typeof output === 'string' ? output.trim() : typeof output?.code === 'string' ? output.code.trim() : ''
  invariant(text && text.length <= policy.maxBytes, `The system did not return ${policy.label} source (maximum ${policy.sizeLabel}).`)
  return text
}

// Returns the candidate program's bytes. Refuses with a tagged error that
// sourceFailureClassification can name; it never returns a sentinel, because a
// caller that forgot to check one would grade prose as a program.
export function extractSource(output, policy) {
  validateExtractionPolicy(policy)
  const text = replyText(output, policy)
  if (policy.mode === 'custom') return policy.extract(text, policy)
  if (policy.mode === 'envelope') {
    let envelope = null
    try { envelope = JSON.parse(text) } catch { envelope = null }
    refuseShape(object(envelope) && typeof envelope[policy.field] === 'string' && envelope[policy.field].trim(),
      `Return one JSON object whose ${policy.field} field holds the ${policy.label} program.`)
    return envelope[policy.field]
  }
  if (policy.mode === 'raw') {
    refuseShape(!text.startsWith('```') && !codeBlockAmidText(text), `Return one ${policy.label} program as plain text, without a code block.`)
    return text
  }
  // fenced
  // pick:'only' is the strictest reading: the WHOLE reply is one fence, or the
  // whole reply is the program. It is checked first and separately, because the
  // bare-reply branch below must not apply the prose rule a lenient policy set.
  if (policy.pick === 'only') {
    if (!text.startsWith('```')) {
      refuseShape(!codeBlockAmidText(text), `The response has text outside its code block. Return one ${policy.label} program, without multiple code blocks or surrounding prose.`)
      return text
    }
    // The tag and whitespace handling here is deliberately the shape Lean Bench
    // froze: the opening run swallows blank lines before the body, and only an
    // untagged fence or the policy language's own tags are accepted.
    const fence = /^```([A-Za-z0-9_+-]*)\s*\n([\s\S]*?)\n```\s*$/.exec(text)
    refuseShape(fence && tagsFor(policy.language).includes(fence[1].toLowerCase()) && !fence[2].includes('```'),
      `Return one ${policy.label} program, without multiple code blocks or surrounding prose.`)
    return fence[2]
  }
  const found = fences(text, policy.language)
  if (found.length === 0) {
    // No fence this policy accepts. The reply is the program, unless a block it
    // does not recognize is sitting inside it.
    refuseShape(!text.startsWith('```') && !codeBlockAmidText(text), `Return one ${policy.label} program, without multiple code blocks or surrounding prose.`)
    return text
  }
  const chosen = chooseFence(found, policy.pick)
  if (policy.prose === 'refuse') {
    const bare = text.slice(0, chosen.start).trim() + text.slice(chosen.end).trim()
    refuseShape(bare === '', `The response has text outside its code block. Return one ${policy.label} program, without surrounding prose.`)
  }
  return chosen.body
}
