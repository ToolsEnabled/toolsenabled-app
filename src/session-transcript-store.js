// The conversation, kept after the session that spoke it is gone.
//
// The window keeps each session's back-and-forth in memory (computers.js's
// sessionTranscripts) and says plainly that closing the window loses it. This
// store is the durable half the owner asked for (iteration 5 W7): a bounded
// excerpt of every conversation, saved per NODE — the circle on the tree —
// so a dead session can be resumed by a fresh agent that first reads what was
// said. The record also keeps the engine's threadId when one was reported, so
// a future engine-side resume has a name to ask for instead of a data gap.
//
// DELIBERATELY NOT inside the fleet-trees record: that parser is
// all-or-nothing on purpose (a broken forest must read as no forest), and one
// oversized transcript riding in it would erase every tree. Here the failure
// grain is one node's record: a damaged entry is dropped alone, and a damaged
// envelope degrades to empty rather than taking the page down.
//
// Storage crosses the SAME seam the forest uses (safeTreeStorage's read/write
// face), under its own key per computer. Everything is bounded: lines per
// node, characters per line, node records per computer, and the envelope's
// serialized size — a conversation is excerpted here, never archived.

export const TRANSCRIPT_STORAGE_KEY_BASE = 'mc.fleet.transcripts.v1'
export const transcriptStorageKey = computerId => `${TRANSCRIPT_STORAGE_KEY_BASE}:${computerId}`

/* THE CAPS, AND WHY THE LAST ONE IS COMPUTED RATHER THAN TYPED.
 *
 * THE DEFECT THAT MADE IT SO, measured 2026-08-18 against a hand-typed
 * `maxSerializedChars: 120_000`. One record at THIS FILE'S OWN per-record
 * bounds -- 40 lines of 600 characters -- serialises to 25,453 characters. So
 * the size cap bound at FOUR records and the 24-record cap below it never
 * bound at all. Saving a fifth node's transcript deleted the first node's
 * ENTIRE conversation, and `save()` returned true. On a research machine that
 * is destroyed work, not a trimmed excerpt.
 *
 * THE NUMBER IT AGREES WITH IS THE ONE THE STORAGE REALLY ENFORCES, and that
 * was measured on a staged packaged build rather than reasoned about. Driving a
 * save of eight full records answered:
 *
 *   Could not save setting "mc.fleet.transcripts.v1:<computer>":
 *   a settings value may not exceed 65536 characters
 *
 * That is shell/renderer-prefs.cjs's MAX_VALUE_LENGTH -- the shipped app backs
 * this page's storage with a bounded preferences file, so the envelope's real
 * ceiling is 64KB and always was. A store that believed in 120,000 was not
 * merely evicting too eagerly; above 64KB its writes were REFUSED outright and
 * the conversation simply stopped being saved.
 *
 * So the size cap is the storage's own limit, with headroom for the key and the
 * file's framing around the value, and the caps above it are what a SINGLE
 * conversation may grow to when there is room. Those two are not in conflict
 * once degrading means trimming: the record cap says how many conversations are
 * kept (24, all of them), the per-record caps say how large one may get, and
 * the envelope is the budget they share. When the budget binds, the fattest
 * records give up their OLDEST lines and every conversation survives -- see
 * save(). Nothing is ever deleted to make room while a line remains to give. */
const MAX_NODES = 24
const MAX_LINES = 40
const MAX_ACTION_LINES = 12
const MAX_LINE_CHARS = 600
const MAX_ACTION_CHARS = 240
const MAX_THREAD_ID_CHARS = 512
const MAX_ACCOUNT_NAME_CHARS = 64
const MAX_NODE_ID_CHARS = 128
const MAX_ACTION_TOOL_CHARS = 24
const MAX_TURN_STAMP_CHARS = 512
const LINE_WRAPPER_CHARS = JSON.stringify({ who: 'action', text: '', body: '', id: '', truncated: true, at: 1_700_000_000_000, state: 'working', kind: 'thinking', tool: '', turnStamp: '' }).length + MAX_ACTION_TOOL_CHARS + 3 * MAX_TURN_STAMP_CHARS + 1
const RECORD_WRAPPER_CHARS = JSON.stringify({ savedAt: 1_700_000_000_000, threadId: '', effort: 'medium', provider: 'claude', account: '', trimmed: 0, lines: [] }).length + 1
/* The provider whose session wrote `threadId`. A thread belongs to the program
   that made it, and a resume onto another program is a fresh start
   (src/tree-resume-decision.js). Unknown values read as null, never as a guess. */
const PROVIDERS = Object.freeze(['codex', 'claude', 'local'])
const RECORD_CHARS = RECORD_WRAPPER_CHARS
  + MAX_THREAD_ID_CHARS
  + MAX_ACCOUNT_NAME_CHARS
  + MAX_NODE_ID_CHARS + 3
  + MAX_LINES * (MAX_LINE_CHARS + LINE_WRAPPER_CHARS)
  + MAX_ACTION_LINES * (MAX_ACTION_CHARS + MAX_LINE_CHARS + LINE_WRAPPER_CHARS)
/* shell/renderer-prefs.cjs's MAX_VALUE_LENGTH. Mirrored rather than imported:
   this module is renderer-side and dependency-free by design, and the seam it
   writes through is a plain read/write pair that knows nothing about limits.
   The headroom covers the storage key travelling beside the value. */
const STORAGE_VALUE_CHARS = 64 * 1024
const STORAGE_HEADROOM_CHARS = 2_048

export const TRANSCRIPT_LIMITS = Object.freeze({
  maxNodes: MAX_NODES,
  maxLines: MAX_LINES,
  /* What the agent DID, bounded separately from what it SAID. A busy turn can
     emit thousands of tool events and a shared bound would let them push the
     conversation out of its own record. */
  maxActionLines: MAX_ACTION_LINES,
  maxLineChars: MAX_LINE_CHARS,
  maxActionChars: MAX_ACTION_CHARS,
  maxThreadIdChars: MAX_THREAD_ID_CHARS,
  maxAccountNameChars: MAX_ACCOUNT_NAME_CHARS,
  /* What ONE conversation may grow to when there is room -- the ceiling, not
     an allocation. RECORD_CHARS is exported so a caller can see the two
     numbers side by side rather than rediscovering the arithmetic. */
  maxRecordChars: RECORD_CHARS,
  maxSerializedChars: STORAGE_VALUE_CHARS - STORAGE_HEADROOM_CHARS,
  seedMaxChars: 6_000,
})

/* Three kinds of line, and only the first two are speech. An 'action' line is
   one thing the agent did -- a command it ran, a file it read -- kept so a
   conversation reopened tomorrow still shows the work, not only the words. */
const WHO = Object.freeze(['you', 'agent', 'action'])
const SPOKEN = Object.freeze(['you', 'agent'])
/* What became of one action, as a key rather than as words: the sentences
   belong to src/fleet-tree-copy.js, where the plain-language gate holds them. */
const ACTION_STATES = Object.freeze(['working', 'done', 'undone', 'waiting', 'refused', 'unknown', 'closed'])
/* The engine's persisted resume subset, drawn from shell/agent-host.cjs's
   EFFORT_KEYS — an unknown depth on a record reads as "none recorded", never
   as a value a resume would send onward for the boundary to refuse. `max` is
   a real Codex effort on the Astra catalog. Keep it here because a
   stopped-session choice is saved through this renderer envelope before a
   later reopen; dropping it to null would make the next launch silently fall
   back to the tier's MEDIUM default. `ultra` remains intentionally outside
   this persisted resume set: the app's provider vocabulary describes it as
   automatic task delegation rather than a reasoning-depth choice, and this
   bounded correction does not broaden the persisted set to that mode. */
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/* Is this a line at all, and whose? Exactly cleanLine's own three refusals,
   asked WITHOUT building anything -- boundLines needs to know a candidate's
   kind before it knows whether the candidate is worth cleaning. cleanLine
   calls it too, so the two can never drift into disagreeing about what a line
   is. */
function lineWho(line) {
  if (!line || typeof line !== 'object') return null
  if (!WHO.includes(line.who)) return null
  if (typeof line.text !== 'string' || line.text.length === 0) return null
  return line.who
}

function cleanLine(line) {
  if (lineWho(line) === null) return null
  const action = line.who === 'action'
  const cleaned = {
    who: line.who,
    text: line.text.slice(0, action ? TRANSCRIPT_LIMITS.maxActionChars : TRANSCRIPT_LIMITS.maxLineChars),
    at: typeof line.at === 'number' && Number.isFinite(line.at) ? line.at : null,
  }
  // The engine's turn identity lets a remote page merge recovered history
  // with this excerpt. Dropping it makes every reload append old replies.
  if (typeof line.turnStamp === 'string' && line.turnStamp.trim()
      && line.turnStamp.length <= MAX_TURN_STAMP_CHARS && !/[\x00-\x1f\x7f]/.test(line.turnStamp)) {
    cleaned.turnStamp = line.turnStamp
  }
  if (action) {
    if (typeof line.id === 'string' && line.id.length <= MAX_TURN_STAMP_CHARS && !line.id.includes('\0')) cleaned.id = line.id
    if (line.kind === 'thinking' && typeof line.body === 'string') {
      // The legacy settings envelope remains a bounded excerpt. The canonical
      // node transcript holds the full summary; never present this as complete.
      cleaned.body = line.body.slice(0, MAX_LINE_CHARS)
      cleaned.truncated = line.truncated === true || line.body.length > MAX_LINE_CHARS
    }
    if (['call', 'result', 'approval', 'thinking', 'turn'].includes(line.kind)) cleaned.kind = line.kind
    /* An action that lost what became of it reads as still running for ever,
       so the state rides with it -- from the closed set, never from the wire.
       The tool's NAME is already a display word chosen by the copy module
       (src/fleet-tree-copy.js), never an engine identifier, and it is bounded
       and stripped of anything but letters and spaces so a record copied in
       from anywhere cannot put markup or a path into that slot. */
    // Saving an excerpt must preserve a refusal or missing result. An
    // unrecognized state is also not evidence that the action succeeded.
    cleaned.state = ACTION_STATES.includes(line.state) ? line.state : 'unknown'
    cleaned.tool = typeof line.tool === 'string'
      ? line.tool.replace(/[^A-Za-z ]/g, '').slice(0, MAX_ACTION_TOOL_CHARS)
      : ''
  }
  return cleaned
}

/* THE TWO BOUNDS, APPLIED WITHOUT REORDERING ANYTHING -- AND WITHOUT READING
 * THE WHOLE CONVERSATION TO DO IT.
 *
 * Speech is capped at maxLines and actions at maxActionLines, each keeping its
 * own newest; the survivors are read back out in the order they were spoken,
 * because the order is the conversation.
 *
 * THE DEFECT THIS SHAPE CURES, MEASURED 2026-09-03 (scratch harness, 300
 * appends per point, one stored conversation, each append doing exactly what
 * persistTranscript() does per turn -- get() then save()):
 *
 *        lines handed to save()     before      after
 *                    10            0.222 ms   0.213 ms
 *                    60            0.222 ms   0.216 ms
 *                 1,000            0.392 ms   0.214 ms
 *                 4,000            0.841 ms   0.216 ms
 *                16,000            3.275 ms   0.216 ms
 *
 * The old shape cleaned EVERY line the caller held -- one allocation each --
 * and then ran five more whole-array passes (two filters, two slices into
 * Sets, one more filter) before throwing all but the newest 52 away. So the
 * cost of appending one turn grew with the length of the conversation that
 * turn was added to, for ever, to keep an excerpt whose size never changes.
 *
 * This walks BACKWARDS from the newest line, cleans only what it decides to
 * keep, and stops the moment both bounds are full. The lines older than that
 * are counted, not examined -- the record's excerpt cannot contain them, so
 * their contents are not information anybody is going to read.
 *
 * `dropped` therefore counts ENTRIES left out rather than well-formed lines
 * left out: an entry too damaged to be a line, sitting older than the cut, now
 * counts toward "older messages were left out" instead of silently not
 * counting. It was left out; the record did lose it. Nothing reads the number
 * as anything finer than "> 0" (src/views/computers.js's trimmed note). */
function boundLines(lines) {
  let spokenLeft = TRANSCRIPT_LIMITS.maxLines
  let actionsLeft = TRANSCRIPT_LIMITS.maxActionLines
  const kept = []
  let dropped = 0
  let index = lines.length - 1
  for (; index >= 0; index -= 1) {
    const who = lineWho(lines[index])
    if (who === null) continue
    const action = who === 'action'
    if (action ? actionsLeft > 0 : spokenLeft > 0) {
      if (action) actionsLeft -= 1
      else spokenLeft -= 1
      kept.push(cleanLine(lines[index]))
    } else dropped += 1
    if (spokenLeft === 0 && actionsLeft === 0) break
  }
  /* Everything older than where the walk stopped. `index` is the position of
     the oldest line kept, so the entries at 0..index-1 were never looked at --
     which is the whole point, and is why this is one subtraction. */
  if (index > 0) dropped += index
  kept.reverse()
  return { lines: kept, dropped }
}

function cleanRecord(record) {
  if (!record || typeof record !== 'object') return null
  if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt)) return null
  const threadId = typeof record.threadId === 'string' && record.threadId.length > 0
    ? record.threadId.slice(0, TRANSCRIPT_LIMITS.maxThreadIdChars)
    : null
  const effort = EFFORTS.includes(record.effort) ? record.effort : null
  const provider = PROVIDERS.includes(record.provider) ? record.provider : null
  /* An account name is an identity selector into the main-process registry.
     Never truncate one: a damaged/future value must not become the name of a
     different real account. Names are bounded by account-registry.cjs. */
  const account = typeof record.account === 'string'
    && record.account.length > 0
    && record.account.length <= TRANSCRIPT_LIMITS.maxAccountNameChars
    && !record.account.includes('\0')
    ? record.account
    : null
  /* HANDED STRAIGHT TO boundLines, NOT PRE-CLEANED. This used to read
     `record.lines.map(cleanLine).filter(Boolean)` first, which touched every
     entry of a conversation to build a copy of it that boundLines then threw
     all but the last few dozen entries of away. boundLines walks backwards
     from the newest line and calls lineWho/cleanLine only on what it keeps
     (see its own header for the measured cost), so the pre-pass was the same
     work done twice, and the half that was done eagerly was the half that
     grew with the conversation. */
  const bound = boundLines(Array.isArray(record.lines) ? record.lines : [])
  if (bound.lines.length === 0) return null
  /* HOW MUCH THIS RECORD HAS ALREADY LOST, carried on the record itself so the
     chat that opens it can admit the gap in words rather than showing a
     shortened conversation as if it were the whole one. */
  const before = typeof record.trimmed === 'number' && Number.isFinite(record.trimmed) && record.trimmed > 0
    ? Math.floor(record.trimmed)
    : 0
  return {
    savedAt: record.savedAt,
    threadId,
    effort,
    provider,
    account,
    trimmed: before + bound.dropped,
    lines: bound.lines,
  }
}

/** Read an envelope the seam handed back. A damaged envelope reads as empty
 *  and says so; a damaged RECORD inside a sound envelope is dropped alone —
 *  one broken conversation must not erase the others. */
export function parseTranscriptRow(raw) {
  const empty = { nodes: {}, damaged: false }
  if (raw === null || raw === undefined) return empty
  if (typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return { ...empty, damaged: true }
  const nodes = {}
  if (raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes)) {
    for (const [nodeId, record] of Object.entries(raw.nodes)) {
      if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128) continue
      const cleaned = cleanRecord(record)
      if (cleaned) nodes[nodeId] = cleaned
    }
  }
  return { nodes, damaged: false }
}

/* Oldest records leave first when a cap is hit. savedAt is the eviction key:
 * the record touched longest ago is the conversation most likely already
 * resumed or abandoned. `keep` is the record being saved, which is never the
 * one thrown out to make room for itself. */
function evictOldest(nodes, keep = null) {
  let oldestId = null
  let oldestAt = Infinity
  for (const [nodeId, record] of Object.entries(nodes)) {
    if (nodeId === keep) continue
    if (record.savedAt < oldestAt) { oldestAt = record.savedAt; oldestId = nodeId }
  }
  if (oldestId !== null) delete nodes[oldestId]
  return oldestId !== null
}

const envelopeChars = nodes => JSON.stringify({ v: 1, nodes }).length

/* GIVE UP LINES BEFORE GIVING UP A CONVERSATION.
 *
 * One pass drops the OLDEST line from every record that is above the average
 * size and still has more than one line -- the fattest conversations pay
 * first, and no record is ever emptied by this. Answers how many lines went,
 * so a pass that can do nothing more says 0 and the caller moves on to its
 * last resort. */
function trimFattestRecords(nodes) {
  const entries = Object.entries(nodes).filter(([, record]) => record.lines.length > 1)
  if (entries.length === 0) return 0
  const sizes = entries.map(([, record]) => JSON.stringify(record).length)
  const mean = sizes.reduce((total, size) => total + size, 0) / sizes.length
  let above = entries.filter((_, index) => sizes[index] >= mean)
  if (above.length === 0) above = entries
  for (const [, record] of above) {
    record.lines = record.lines.slice(1)
    record.trimmed += 1
  }
  return above.length
}

/**
 * The store. Same wiring discipline as createFleetTreeStore: a missing seam
 * or a bad computer id is a defect in the code, so it throws rather than
 * pretending. Every method re-reads the envelope — transcripts are written
 * once per turn, and a stale in-memory copy is how two views overwrite each
 * other's saves.
 */
export function createTranscriptStore({ computerId, storage, onLoss = null }) {
  if (typeof computerId !== 'string' || computerId.length === 0) {
    throw new TypeError('createTranscriptStore needs the computer id its records belong to')
  }
  if (!storage || typeof storage.read !== 'function' || typeof storage.write !== 'function') {
    throw new TypeError('createTranscriptStore needs a storage seam with read and write')
  }
  const key = transcriptStorageKey(computerId)
  const readNodes = () => parseTranscriptRow(storage.read(key)).nodes
  /* A save that loses anything says so. A listener that throws is the
     listener's defect and must not cost the write that was about to land. */
  const report = loss => {
    if (typeof onLoss !== 'function') return
    try { onLoss(loss) } catch { /* a broken listener never costs a save */ }
  }

  return Object.freeze({
    /** Save one node's excerpt. Clamps every bound, gives up the oldest LINES
     *  to fit, and answers whether the write really happened.
     *
     *  `keepUnknown` is for the caller that is APPENDING rather than replacing:
     *  a threadId, effort or provider it passes as null keeps whatever the
     *  stored record already says instead of nulling it. Opt-in, because a
     *  caller that means "forget the thread name" must still be able to say so.
     *
     *  WHY IT IS HERE AND NOT AT THE CALL SITE. src/views/computers.js's
     *  persistTranscript() did exactly this by hand -- a get() to read those
     *  three fields, then a save() -- and get() parses and re-cleans EVERY
     *  conversation stored for the computer, so each appended turn paid for the
     *  whole envelope twice. MEASURED 2026-09-03 (scratch harness, 200 appends,
     *  a 60-line conversation, each append doing get()+save() as the view does):
     *
     *     conversations stored     get()+save()     save(keepUnknown)
     *                        1        0.202 ms              0.114 ms
     *                        8        0.849 ms              0.457 ms
     *                       23        1.822 ms              0.930 ms
     *
     *  Same fields, same precedence, one envelope read instead of two -- and
     *  the two reads can no longer disagree, which they could when another
     *  window wrote between them.
     *
     *  `account` HAS NO DEFAULT, on purpose. For the three fields above, null
     *  only ever means "this window cannot tell". For the account it is a real
     *  answer -- the single-account case a freshly opened thread reports -- and
     *  it has to clear an older thread's name rather than silently pairing the
     *  two. So keepUnknown asks whether the caller SUPPLIED an account, not
     *  whether the one it supplied was null; a caller that omits the key keeps
     *  the stored answer, a caller that passes null clears it. */
    save(nodeId, { lines, threadId = null, effort = null, provider = null, account, keepUnknown = false } = {}) {
      if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > MAX_NODE_ID_CHARS) return false
      const record = cleanRecord({ savedAt: Date.now(), threadId, effort, provider, account, lines })
      if (!record) return false
      const nodes = readNodes()
      if (keepUnknown) {
        const kept = nodes[nodeId]
        if (kept) {
          if (record.threadId === null) record.threadId = kept.threadId
          if (record.effort === null) record.effort = kept.effort
          if (record.provider === null) record.provider = kept.provider
          /* Supplied-ness, not truthiness -- see the note on `account` in this
             method's own doc comment. cleanRecord has already turned an absent
             key into null on the record, so the question has to be asked of the
             argument. */
          if (account === undefined) record.account = kept.account
        }
      }
      nodes[nodeId] = record
      const removed = []
      while (Object.keys(nodes).length > TRANSCRIPT_LIMITS.maxNodes) {
        const held = new Set(Object.keys(nodes))
        if (!evictOldest(nodes, nodeId)) break
        for (const id of held) if (!(id in nodes)) removed.push(id)
      }
      /* DEGRADE BY TRIMMING, NEVER BY DELETING -- and this loop is the whole
         difference between an excerpt getting shorter and a person's work
         being destroyed. Lines go first, from the fattest records, until
         either it fits or every record is down to a single line; only then is
         a whole conversation given up, oldest first, and only then is a save
         that still cannot fit refused. The bound above makes this rare rather
         than routine: it is reached by JSON escaping, not by ordinary size. */
      let trimmedLines = 0
      while (envelopeChars(nodes) > TRANSCRIPT_LIMITS.maxSerializedChars) {
        const gave = trimFattestRecords(nodes)
        if (gave > 0) { trimmedLines += gave; continue }
        const held = new Set(Object.keys(nodes))
        if (!evictOldest(nodes, nodeId)) return false
        for (const id of held) if (!(id in nodes)) removed.push(id)
      }
      if (trimmedLines > 0 || removed.length > 0) {
        report({ nodeId, trimmedLines, removedNodeIds: removed, refused: false })
      }
      const wrote = storage.write(key, { v: 1, nodes }) === true
      if (!wrote) report({ nodeId, trimmedLines, removedNodeIds: removed, refused: true })
      return wrote
    },
    get(nodeId) {
      if (typeof nodeId !== 'string') return null
      return readNodes()[nodeId] || null
    },
    has(nodeId) {
      if (typeof nodeId !== 'string') return false
      return Boolean(readNodes()[nodeId])
    },
    remove(nodeId) {
      if (typeof nodeId !== 'string') return false
      const nodes = readNodes()
      if (!(nodeId in nodes)) return true
      delete nodes[nodeId]
      return storage.write(key, { v: 1, nodes }) === true
    },
  })
}

/**
 * The first message a resuming agent reads: the saved conversation, oldest
 * first, inside a frame that says whose words are whose. Bounded — when the
 * excerpt cannot fit, the OLDEST lines are dropped and the frame says so,
 * because the newest words are where the work stands.
 */
export function transcriptSeedText(lines, { recoveryDirectory = null, earlierMessages = false } = {}) {
  /* SPEECH ONLY. An action line is a command the agent ran, and framing one as
     "the agent before you said" would put words in a mouth -- the taking-over
     agent would read a shell command as a sentence somebody meant. */
  // Disk history holds full speech. cleanLine is the legacy DISPLAY excerpt
  // cleaner: using it here removed everything after character 600, including
  // completion evidence and owner corrections. Bound the packet as a whole.
  // A fresh session supplies its current tree, rules, role and tool context.
  // Replaying those marked additions as the person's speech both misattributes
  // them and lets their size evict the actual request from this bounded seed.
  const refreshedKinds = ['tree', 'requests', 'tasks', 'history', 'role', 'tools', 'capabilities']
  const kept = Array.isArray(lines) ? lines.filter(line => SPOKEN.includes(lineWho(line))
    && !(line.promptSource === 'toolsenabled' && refreshedKinds.includes(line.promptKind))) : []
  if (kept.length === 0 && !(earlierMessages && recoveryDirectory)) return ''
  const spoken = []
  let used = 0
  let dropped = earlierMessages
  let shortened = false
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const line = kept[i]
    const speaker = `${line.who === 'you' ? 'The person said' : 'The agent before you said'}: `
    let body = line.text
    const remaining = TRANSCRIPT_LIMITS.seedMaxChars - used
    if (speaker.length + body.length > remaining) {
      const files = Array.isArray(line.recoveryFiles) ? line.recoveryFiles.filter(file => typeof file === 'string' && file) : []
      const marker = '\n[Middle of this message omitted to fit. '
        + (files.length ? `Read its complete saved text before continuing this work: ${files.map(file => JSON.stringify(file)).join(', ')}.`
          : recoveryDirectory ? 'Read the complete message from the saved conversation identified below before continuing this work.'
            : 'The complete message is not attached. Obtain the missing text from the person before acting on it.') + ']\n'
      const room = remaining - speaker.length - marker.length
      // A short newer progress line must not evict a long opening request
      // whole. Use the remaining budget for its beginning and ending, while
      // keeping the newest speech already selected above.
      if (room < 128) { dropped = true; break }
      const head = Math.min(1000, Math.floor(room / 3))
      body = body.slice(0, head) + marker + body.slice(-(room - head))
      shortened = true
    }
    const said = speaker + body
    if (used + said.length > TRANSCRIPT_LIMITS.seedMaxChars && spoken.length > 0) { dropped = true; break }
    spoken.unshift(said)
    used += said.length
  }
  return [
    'You are taking over from an earlier agent whose session ended. This is that conversation, oldest first:',
    ...(dropped ? ['(Older messages were left out to fit.)'] : []),
    '',
    ...spoken,
    '',
    ...((dropped || shortened) && recoveryDirectory ? [
      `Full conversation for this circle: ${JSON.stringify(recoveryDirectory)}.`,
      'Recover omitted assignment details and constraints through your allowed file tools before acting. Read the text field in the saved .json entries; a matching .json.text file continues that entry. Files are ordered oldest first. Earlier entries may be outside this excerpt. Current role and tool rules still apply.',
      '',
    ] : []),
    ...(dropped && !recoveryDirectory ? ['Missing assignment details and constraints must be obtained from the person before acting on an incomplete request.'] : []),
    'This is a bounded speech excerpt, not the full task or communication record. Use current task and decision records to resolve gaps. Continue unfinished assigned work. Work the conversation shows as finished is finished — do not redo it. If complete or waiting for others, report that briefly and finish the turn.',
  ].join('\n')
}
