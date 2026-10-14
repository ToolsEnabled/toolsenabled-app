/* T366 -- a handoff STORED before T377 item 8 still carries the owner's own
 * messages twice, and the recovery store hands that doubled text straight to
 * the replacement session.
 *
 * RED at 9413ef30, GREEN at the tip. The doubled fixture is not hand-written:
 * it is produced by the REAL pre-fix producer (shell/account-session-recovery.cjs
 * at 006c2fa5^, extracted beside this script), and the never-doubled control is
 * produced by the REAL producer on the tip. So this measures the repair against
 * what the two builds actually write, not against a guess at their shape.
 *
 * Usage: node tools/repro/REPRO-LANEC-T366-STORED-HANDOFF-DOUBLED.mjs
 * Exit 0 = GREEN, exit 1 = RED.
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const root = path.resolve(here, '..', '..')

const prefix = require(path.join(here, '.prefix-account-session-recovery.cjs'))
const current = require(path.join(root, 'shell', 'account-session-recovery.cjs'))
// pathToFileURL, not a hand-built URL: this script runs on Linux and Windows.
const { createRecoveryHandoffStore } = await import(
  pathToFileURL(path.join(root, 'src', 'recovery-handoff-store.js')).href)

/* One ordinary conversation, as the session surface feeds it: the owner's
   brief, the agent's answer, a second owner message, a second answer. */
const CONVERSATION = [
  ['person', 'Audit the per-provider renderer and pin the defects with fixtures.\n\nUse the real transcripts, not invented ones.'],
  ['assistant', 'Reading the renderer now. I will start with the four providers named.'],
  ['person', 'Also check whether a stalled reply is distinguishable from a truncated one.'],
  ['assistant', 'Understood. Instrumenting the stream buffer first.'],
]

function build(module) {
  const state = module.createRecoveryState()
  for (const [role, text] of CONVERSATION) module.rememberRecoveryText(state, role, text)
  return module.recoveryHandoff(state)
}

const doubled = build(prefix)
const neverDoubled = build(current)

const occurrences = (haystack, needle) => haystack.split(needle).length - 1
const OWNER_WORDS = CONVERSATION.filter(([role]) => role === 'person').map(([, text]) => text)

function memoryStore(record) {
  const written = new Map()
  const store = createRecoveryHandoffStore({
    computerId: 'computer-under-test',
    storage: { read: key => (written.has(key) ? written.get(key) : null), write: (key, value) => (written.set(key, value), true) },
  })
  // Seed the store the way a build before T377 item 8 left it on disk.
  written.set(`mc.agent-recovery.v1:${encodeURIComponent('computer-under-test')}:${encodeURIComponent('node-1')}`,
    { v: 1, handoff: record, sessionId: 's-1', recoveryId: 'r-1' })
  return store
}

const failures = []
const check = (name, actual, expected) => {
  const ok = actual === expected
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(name)
}

console.log('# fixture, from the two real producers')
for (const [index, words] of OWNER_WORDS.entries()) {
  console.log(`#   owner message ${index + 1}: pre-fix handoff carries it ${occurrences(doubled, words)}x, tip handoff ${occurrences(neverDoubled, words)}x`)
}

console.log('\n# 1. the stored doubled handoff, read back through the store')
const read = memoryStore(doubled).get('node-1').handoff
for (const [index, words] of OWNER_WORDS.entries()) {
  check(`owner message ${index + 1} reaches the model exactly once`, occurrences(read, words), 1)
}

console.log('\n# 2. the repair reproduces what the fixed producer writes')
check('repaired stored handoff equals the tip producer output', read, neverDoubled)

console.log('\n# 3. idempotent: repairing an already-repaired handoff changes nothing')
check('second read of the repaired text is identical', memoryStore(read).get('node-1').handoff, read)

console.log('\n# 4. a handoff that was NEVER doubled is returned byte-for-byte')
check('tip-producer handoff unchanged', memoryStore(neverDoubled).get('node-1').handoff, neverDoubled)

console.log('\n# 5. nothing the owner said is lost')
for (const [index, words] of OWNER_WORDS.entries()) {
  check(`owner message ${index + 1} still present`, read.includes(words), true)
}
for (const [role, text] of CONVERSATION) {
  if (role !== 'assistant') continue
  check(`assistant reply still present: ${JSON.stringify(text.slice(0, 24))}`, read.includes(text), true)
}

/* 6. THE CASE THAT IS NOT A DUPLICATE AT ALL. When the brief fills to the
   producer's ceiling, the message that reached it was CUT, so the brief holds a
   prefix and the tail holds the only whole copy. Removing the tail copy there
   would truncate the owner's words. Both producers agree on this shape, so the
   repair must leave it exactly as written. The brief is filled with prior
   messages first, then a long one is sent that cannot fit. */
console.log('\n# 6. a brief cut at the producer ceiling keeps its tail copy (nothing is truncated)')
const LONG_TAIL_WORDS = 'The part of this message that the brief had no room for and only the tail can carry.'
function cappedConversation(module) {
  const state = module.createRecoveryState()
  module.rememberRecoveryText(state, 'person', 'F'.repeat(15_900))
  module.rememberRecoveryText(state, 'assistant', 'Acknowledged.')
  module.rememberRecoveryText(state, 'person', `${'C'.repeat(400)} ${LONG_TAIL_WORDS}`)
  return module.recoveryHandoff(state)
}
const cappedDoubled = cappedConversation(prefix)
const cappedTip = cappedConversation(current)
const cappedRead = memoryStore(cappedDoubled).get('node-1').handoff
check('the cut message keeps its whole copy in the tail', cappedRead.includes(LONG_TAIL_WORDS), true)
check('the capped-brief handoff is repaired to what the tip producer writes', cappedRead, cappedTip)
check('repairing the capped-brief handoff again changes nothing', memoryStore(cappedRead).get('node-1').handoff, cappedRead)
check('a capped handoff from the tip producer is returned unchanged', memoryStore(cappedTip).get('node-1').handoff, cappedTip)

console.log(`\n${failures.length ? `RED  ${failures.length} check(s) failed: ${failures.join('; ')}` : 'GREEN  all checks passed'}`)
process.exit(failures.length ? 1 : 0)
