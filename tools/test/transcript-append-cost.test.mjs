// WHAT ONE APPENDED TURN COSTS, and that turn 16,000 costs what turn 1,000 did.
//
// The store keeps a bounded EXCERPT — the newest maxLines spoken lines and the
// newest maxActionLines action lines — so the record it writes is the same size
// whatever the conversation behind it has grown to. What used to grow was the
// work of producing it: save() cleaned every line the caller held (one object
// each) and then ran five more whole-array passes before throwing all but the
// excerpt away, and src/views/computers.js's persistTranscript() bracketed that
// with a get() so the WHOLE envelope — every conversation stored for the
// computer — was parsed and re-cleaned twice per turn.
//
// MEASURED 2026-09-03, 200 appends per point, a 60-line conversation, each
// append doing exactly what persistTranscript() does:
//
//     conversations stored     before      after
//                        1    0.153 ms   0.050 ms
//                        8    0.876 ms   0.394 ms
//                       23    2.514 ms   0.948 ms
//
// and against the length of the conversation handed to save() (one stored
// conversation, 300 appends):
//
//     lines handed in     before      after
//               1,000    0.290 ms   0.190 ms
//               4,000    0.659 ms   0.288 ms
//              16,000    2.460 ms   0.815 ms
//
// THE ASSERTIONS BELOW ARE NOT THOSE NUMBERS. A wall clock on a machine running
// sixty lanes is not a test. They assert the WORK, counted where the work is
// observable: how many line objects the store builds, how many times it goes to
// storage, and how many characters it writes. Each entry counts its own reads,
// so "looked at" and "built" are the entries' own answers rather than a guess
// about the implementation.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TRANSCRIPT_LIMITS, createTranscriptStore } from '../../src/session-transcript-store.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const COMPUTER = 'c1'
const EXCERPT = TRANSCRIPT_LIMITS.maxLines + TRANSCRIPT_LIMITS.maxActionLines

/* The same face safeTreeStorage presents, counting what crosses it. Text both
   ways, as the real seam does (JSON.parse in, JSON.stringify out), so
   "characters written" is the real cost of the write and not a shape. */
function countingSeam() {
  const held = new Map()
  const counts = { reads: 0, writes: 0, charsWritten: 0 }
  return {
    counts,
    read(key) {
      counts.reads += 1
      return held.has(key) ? JSON.parse(held.get(key)) : null
    },
    write(key, value) {
      const text = JSON.stringify(value)
      counts.writes += 1
      counts.charsWritten += text.length
      held.set(key, text)
      return true
    },
  }
}

/* A conversation whose entries say when they were read. `who` and `text` are
   read to decide whether an entry can be part of the excerpt at all; `at` is
   read only when a line object is actually BUILT for it, so the two counters
   separate "looked at" from "paid for". */
function countedConversation(count, { every = 0 } = {}) {
  const seen = { looked: new Set(), built: new Set() }
  const lines = Array.from({ length: count }, (_, i) => {
    const action = every > 0 && i % every === 0
    const who = action ? 'action' : (i % 2 ? 'agent' : 'you')
    /* Fixed width, both of them: a longer conversation must differ from a
       short one in how MANY entries it has, never in how wide one entry is,
       or "characters written" would measure the fixture. */
    const text = `entry ${String(i).padStart(6, '0')}`
    return {
      get who() { seen.looked.add(i); return who },
      get text() { seen.looked.add(i); return text },
      get at() { seen.built.add(i); return 1_000_000 + i },
      ...(action ? { state: 'done', tool: 'Command' } : {}),
    }
  })
  return { lines, seen }
}

/* One appended turn, exactly as src/views/computers.js's persistTranscript()
   files it: the window's whole held conversation, with the fields this window
   does not know left for the record to answer. */
const appendTurn = (store, nodeId, lines) => store.save(nodeId, {
  lines,
  threadId: null,
  effort: null,
  provider: null,
  keepUnknown: true,
})

/* One appended turn, and what it cost, at a stated conversation length. */
function appendCost(count) {
  const seam = countingSeam()
  const store = createTranscriptStore({ computerId: COMPUTER, storage: seam })
  const { lines, seen } = countedConversation(count)
  assert.equal(appendTurn(store, 'n1', lines), true, `the first save of ${count} entries must land`)
  seen.built.clear()
  const before = { ...seam.counts }
  lines.push({ who: 'agent', text: 'one more turn', at: 9_000 })
  assert.equal(appendTurn(store, 'n1', lines), true, 'the appended turn must land')
  return {
    built: seen.built.size,
    reads: seam.counts.reads - before.reads,
    writes: seam.counts.writes - before.writes,
    charsWritten: seam.counts.charsWritten - before.charsWritten,
  }
}

test('appending one turn to a 1,000-entry transcript builds no more lines than the excerpt holds', () => {
  const cost = appendCost(1_000)
  assert.ok(
    cost.built <= EXCERPT,
    `one append to a 1,000-entry transcript built ${cost.built} line objects; the excerpt is ${EXCERPT}`,
  )
})

test('the work of one append does not scale with the count', () => {
  /* Every length here is past the excerpt, so the record written is the same
     size at all of them and any difference in the work is growth, not content.
     16,000 is 16x 1,000: work that scaled with the count could not hide. */
  const measured = [1_000, 2_000, 4_000, 16_000].map(count => ({ count, ...appendCost(count) }))
  const first = measured[0]
  assert.deepEqual(
    measured.map(row => row.built),
    measured.map(() => first.built),
    `line objects built per append: ${measured.map(row => `${row.count}->${row.built}`).join(', ')}`,
  )
  /* Not equality, and the whole of the difference is DIGITS: the record says
     how many entries were left out, and 15,960 is two characters wider than
     960. Every other field is fixed width above, so eight characters is a
     ceiling on "the counters got bigger" and a floor no growth could sneak
     under -- one extra line would cost about forty. */
  const written = `characters written per append: ${measured.map(row => `${row.count}->${row.charsWritten}`).join(', ')}`
  const largest = measured[measured.length - 1]
  assert.ok(
    largest.charsWritten - first.charsWritten <= 8,
    `${largest.count / first.count}x the conversation wrote ${largest.charsWritten - first.charsWritten} more characters — ${written}`,
  )
  for (const row of measured) {
    assert.ok(row.charsWritten <= TRANSCRIPT_LIMITS.maxRecordChars, `an append wrote past the per-record ceiling — ${written}`)
  }
  assert.deepEqual(
    measured.map(row => row.reads),
    measured.map(() => 1),
    `envelope reads per append: ${measured.map(row => `${row.count}->${row.reads}`).join(', ')}`,
  )
  assert.deepEqual(measured.map(row => row.writes), measured.map(() => 1))
})

test('one appended turn goes to storage once, not twice', () => {
  const cost = appendCost(60)
  assert.equal(cost.reads, 1, 'an append must read the envelope once, not once to look and once to save')
  assert.equal(cost.writes, 1)
})

/* The point of the whole exercise: cheaper, never different. */
test('the excerpt kept is the same one the whole-conversation pass kept', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: countingSeam() })
  const lines = Array.from({ length: 1_000 }, (_, i) => ({
    who: i % 2 ? 'agent' : 'you',
    text: `entry ${i}`,
    at: 1_000 + i,
  }))
  assert.equal(appendTurn(store, 'n1', lines), true)
  const kept = store.get('n1')
  assert.equal(kept.lines.length, TRANSCRIPT_LIMITS.maxLines)
  assert.equal(kept.lines[kept.lines.length - 1].text, 'entry 999', 'the newest line must survive')
  assert.equal(kept.lines[0].text, `entry ${1_000 - TRANSCRIPT_LIMITS.maxLines}`, 'the excerpt must start where the bound does')
  assert.deepEqual(
    kept.lines.map(entry => entry.text),
    lines.slice(-TRANSCRIPT_LIMITS.maxLines).map(entry => entry.text),
    'the kept lines must be the newest maxLines, in the order they were spoken',
  )
  assert.ok(kept.trimmed > 0, 'a record that left older lines out must say so')
})

test('both bounds still hold their own newest, in the order the conversation ran', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: countingSeam() })
  /* Every fifth entry is an action, so the excerpt has to keep the newest
     maxLines words AND the newest maxActionLines commands out of one stream. */
  const { lines } = countedConversation(600, { every: 5 })
  assert.equal(appendTurn(store, 'n2', lines), true)
  const kept = store.get('n2').lines
  const words = kept.filter(entry => entry.who !== 'action')
  const acted = kept.filter(entry => entry.who === 'action')
  assert.equal(words.length, TRANSCRIPT_LIMITS.maxLines)
  assert.equal(acted.length, TRANSCRIPT_LIMITS.maxActionLines)
  assert.equal(words[words.length - 1].text, 'entry 000599')
  assert.equal(acted[acted.length - 1].text, 'entry 000595')
  const moments = kept.map(entry => entry.at)
  assert.deepEqual(moments, [...moments].sort((a, b) => a - b), 'the excerpt must read in the order it was spoken')
  assert.equal(acted[0].tool, 'Command', 'an action keeps its own fields through the cheaper pass')
})

test('what this window does not know is kept, and what it does know still wins', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: countingSeam() })
  const said = [{ who: 'you', text: 'start', at: 1 }]
  store.save('n3', { lines: said, threadId: 'thread-1', effort: 'high', provider: 'codex' })
  /* The window that appends the next turn knows none of the three. */
  assert.equal(appendTurn(store, 'n3', [...said, { who: 'agent', text: 'done', at: 2 }]), true)
  const kept = store.get('n3')
  assert.equal(kept.threadId, 'thread-1', 'an append must not null the engine thread name')
  assert.equal(kept.effort, 'high')
  assert.equal(kept.provider, 'codex')
  /* A window that DOES know is the live fact and overwrites. */
  store.save('n3', { lines: said, threadId: 'thread-2', effort: 'low', provider: 'claude', keepUnknown: true })
  const fresh = store.get('n3')
  assert.equal(fresh.threadId, 'thread-2')
  assert.equal(fresh.effort, 'low')
  assert.equal(fresh.provider, 'claude')
  /* And a caller that has not asked to keep anything still REPLACES, so
     "forget the thread name" is still a thing a caller can say. */
  store.save('n3', { lines: said })
  assert.equal(store.get('n3').threadId, null, 'save without keepUnknown must still replace the record whole')
})

/* THE VIEW'S HALF, EXECUTED THROUGH ITS NESTED FUNCTION SOURCE.
 *
 * src/views/computers.js imports three stylesheets and reaches echarts, a
 * canvas and a ResizeObserver at module load, so a plain Node process cannot
 * import it -- the same measurement tools/test/tree-chat-transcript.test.mjs
 * records. Extract the actual function, run it over the real store, and count
 * storage reads and writes. Verify the saved lines and retained metadata too:
 * a cheap save that silently discards either is still a failed append. */
test('the view persists an appended turn with one envelope read', () => {
  const view = readFileSync(join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src', 'views', 'computers.js'), 'utf8')
  const seam = countingSeam()
  const transcriptStore = createTranscriptStore({ computerId: COMPUTER, storage: seam })
  const previous = { lines: [{ who: 'you', text: 'first', at: 1 }], threadId: 'thread-known', effort: 'high', provider: 'claude', account: 'account-known' }
  assert.equal(transcriptStore.save('n1', previous), true)
  const lines = [...previous.lines, { who: 'agent', text: 'appended', at: 2 }]
  const persistTranscript = new Function(
    'transcriptStore', 'treeStore', 'sessionNodeIds', 'sessionTranscripts',
    'sessionThreadIds', 'sessionEfforts', 'sessionAccountNames', 'LAUNCH_TIERS',
    `${declaredFunctionSource(view, 'persistTranscript')}\nreturn persistTranscript`,
  )(
    transcriptStore, { getNode: () => ({ tier: 'claude-sonnet' }) },
    new Map([['s1', 'n1']]), new Map([['s1', lines]]),
    new Map(), new Map(), new Map(), LAUNCH_TIERS,
  )
  const before = { ...seam.counts }
  persistTranscript('s1')
  assert.equal(seam.counts.reads - before.reads, 1, 'the actual view save must read the envelope once')
  assert.equal(seam.counts.writes - before.writes, 1, 'the actual view must persist the appended turn')
  const saved = transcriptStore.get('n1')
  assert.deepEqual(saved.lines, lines)
  for (const field of ['threadId', 'effort', 'provider', 'account']) {
    assert.equal(saved[field], previous[field], `the actual view must preserve the ${field} it does not know`)
  }
})
