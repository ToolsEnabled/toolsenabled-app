'use strict'

/* WHAT EACH TURN COST, written down on the computer that spent it.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. Both engines report token usage on every
 * turn -- codex on `thread/tokenUsage/updated`, the Claude CLI on its `result`
 * packet -- and both re-emit it as a `usage` event that has crossed
 * mc-agent:event since the first day. Nothing ever wrote one down. So the
 * metrics page could say only that this product never sees a token count, which
 * was true of the RECORD and false of the PRODUCT: the count arrives, per turn,
 * already in the main process, and was dropped on the floor. The owner asked why
 * the metrics do not work; this is the half of the answer that is a missing
 * writer rather than a missing panel.
 *
 * WHAT IT IS. The same record as shell/spawn-record.cjs -- ed25519-signed,
 * hash-chained, fsync-appended, keyed to the OS keystore -- kept in its own
 * file. It is that module, not a copy of it: createSpawnRecorder() takes the
 * ledger's file name, and everything below is the shape of one usage record and
 * the reading of one usage event. There is exactly one chain implementation on
 * this machine, and this is not a second one.
 *
 * WHY ITS OWN FILE. history() reads at most 200 lines. A single busy session
 * writes a usage record per turn, so sharing the run ledger would push the runs
 * out of the only window the home screen can see -- a person with one long
 * conversation would open the product and be told nothing had ever run here.
 * See the note on `ledgerFile` in shell/spawn-record.cjs.
 *
 * WHAT IT NEVER DOES. It never computes a figure the engine did not report.
 * Absent is recorded as absent, never as zero: a zero is a claim, and a claim
 * signed with this chain's authority is worse than a blank. Every arithmetic
 * this feature does happens later, on a screen, over figures whose provenance is
 * still readable -- see src/local-metrics.js.
 */

const { createSpawnRecorder, SpawnRecordError, USAGE_STRING_FIELDS } = require('./spawn-record.cjs')

const USAGE_LEDGER_FILE = 'agent-turn-usage-records.jsonl'
const USAGE_ACTION = 'agent_turn_usage'

/* THE LABELS THAT RIDE WITH A READING, JUDGED BY THE WRITER'S OWN TABLE.
 *
 * The writer REFUSES a label outside its bounded shape, and that strictness is
 * the guarantee that a figure on a screen cannot be a path. But a person may
 * name a provider sign-in anything the registry allows -- any script, spaces,
 * "work (old)" -- and a label the ledger will not hold must never cost us the
 * READING it was attached to. So the caller bounds each label first and sends
 * null for one that does not fit, which every reader downstream already renders
 * as "the record does not say".
 *
 * WHY IT LIVES HERE AND NOT AT THE CALLER. It used to be four regular
 * expressions copied into shell/main.cjs beside the call, and copies of a rule
 * are a rule that can disagree with itself. The two directions of disagreement
 * are not symmetric and both are bad:
 *   caller stricter than writer  -> a good name is silently dropped to null.
 *     That is exactly the defect measured on 2026-09-03 and repaired in the
 *     `account` row of USAGE_STRING_FIELDS: 433 of 488 rows lost their sign-in.
 *   caller looser than writer    -> boundedUsage() throws, shell/main.cjs
 *     swallows it by design, and the whole TURN goes unrecorded -- a lost label
 *     becomes lost tokens.
 * Reading the writer's table is what makes the second case unreachable rather
 * than merely unlikely, so fixing one pattern can never open the other hole.
 *
 * Pure and exported so a test can walk every real name shape by value, without
 * an Electron process or a ledger. */
const USAGE_LABEL_PATTERNS = new Map(USAGE_STRING_FIELDS)

function usageLabel(field, value) {
  const pattern = USAGE_LABEL_PATTERNS.get(field)
  /* A field this record has no rule for is not a field this record can carry.
     Named rather than passed through, because passing an unbounded string to
     the writer is the one thing the table exists to stop. */
  if (!pattern) {
    throw new SpawnRecordError('SPAWN_RECORD_INVALID_USAGE', `There is no bounded shape for usage.${field}, so it cannot be labelled`)
  }
  return typeof value === 'string' && pattern.test(value) ? value : null
}

/* THE FIELD NAMES EACH ENGINE REALLY USES, MEASURED RATHER THAN ASSUMED.
 *
 *   codex 0.146 app-server (captured live 2026-08-14, recorded in
 *   src/agent-session-events.js): camelCase, and the record is a PAIR --
 *     { total: {totalTokens, inputTokens, cachedInputTokens, outputTokens,
 *               reasoningOutputTokens}, last: {…same…}, modelContextWindow }
 *   where `total` is the session's running total and `last` is the turn that
 *   just ended.
 *
 *   Claude CLI (`result` packet usage, re-emitted by claude-cli-adapter.js
 *   handleResult): Anthropic's own snake_case shape, flat, and already scoped to
 *   the turn -- { input_tokens, output_tokens, cache_creation_input_tokens,
 *   cache_read_input_tokens }.
 *
 * Aliasing two spellings of one figure onto one name is not inventing a number;
 * it is reading two dialects of the same sentence. Which figure a name means is
 * fixed here so that no screen has to guess, and a spelling nobody has measured
 * is simply absent rather than mapped by resemblance.
 */
const FIELD_ALIASES = Object.freeze({
  inputTokens: Object.freeze(['inputTokens', 'input_tokens']),
  /* Tokens served from the provider's cache. Codex calls it cachedInputTokens;
     Anthropic calls the same thing cache_read_input_tokens. */
  cachedInputTokens: Object.freeze(['cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens']),
  /* Writing to the cache, which BOTH engines report under their own name --
     `cacheWriteInputTokens` from codex, `cache_creation_input_tokens` from
     Anthropic. Deliberately NOT folded into the line above: writing to the cache
     is billed differently from reading it, and a page that added them together
     would be reporting a number neither engine reports.
     THE CODEX SPELLING WAS ADDED FROM A LIVE TURN, not from the capture this
     table was first written against: the capture in src/agent-session-events.js
     abbreviates the record and does not show it, so a real luna turn on
     2026-08-18 reported `cacheWriteInputTokens: 0` into a field this reader had
     no name for. It was reading zero as absent, which is the right way round for
     a missing field and the wrong answer for a reported one. */
  cacheCreationInputTokens: Object.freeze(['cacheCreationInputTokens', 'cacheWriteInputTokens', 'cache_creation_input_tokens']),
  outputTokens: Object.freeze(['outputTokens', 'output_tokens']),
  reasoningOutputTokens: Object.freeze(['reasoningOutputTokens', 'reasoning_output_tokens']),
  totalTokens: Object.freeze(['totalTokens', 'total_tokens']),
})

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const wholeNumber = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/* THE SPELLINGS THAT SAY THE INPUT FIGURE DOES NOT CONTAIN THE CACHE.
 *
 * Anthropic's `input_tokens` counts the uncached remainder and reports the cache
 * beside it; codex's `inputTokens` already contains its `cachedInputTokens`.
 * Same figure, two compositions, and the ONLY place on this machine that can
 * tell them apart is here, where the alias that answered is still known. One
 * line further on it is five numbers with no provenance -- which is how the
 * metrics page came to drop 853 million of the owner's 857 million recorded
 * tokens on the floor. See the `inputBasis` note in shell/spawn-record.cjs.
 *
 * A spelling nobody has measured is absent from this set and produces no claim,
 * which is the same rule FIELD_ALIASES itself follows: unknown stays unknown
 * rather than being mapped by resemblance. */
const CACHE_OUTSIDE_INPUT_ALIASES = Object.freeze(new Set(['cache_read_input_tokens', 'cache_creation_input_tokens']))

function readFigures(source) {
  const figures = {}
  let found = 0
  /* Null until a cache figure is actually read: a reading with no cache figure
     at all composes identically either way, and stamping it with a composition
     would be a claim about an engine made from a record that named none. */
  let inputBasis = null
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let value = null
    for (const alias of aliases) {
      const candidate = wholeNumber(source[alias])
      if (candidate !== null) {
        value = candidate
        if (field === 'cachedInputTokens' || field === 'cacheCreationInputTokens') {
          inputBasis = CACHE_OUTSIDE_INPUT_ALIASES.has(alias) ? 'excludes-cache' : 'includes-cache'
        }
        break
      }
    }
    figures[field] = value
    if (value !== null) found += 1
  }
  return { figures, found, inputBasis }
}

/**
 * What one `usage` event actually says about one turn, or null when it says
 * nothing this record can hold.
 *
 * THE `basis` IS THE POINT OF THIS FUNCTION. A codex record carries the
 * session's running total AND the turn that just ended; a Claude record carries
 * the turn alone. A reader that summed the wrong one would multiply a session's
 * spend by its number of turns and print a confident, enormous, wrong number.
 * So the turn's own figures are preferred, the cumulative reading is kept
 * BESIDE them rather than instead of them, and a record that offers only a
 * running total says `session-total` out loud so nothing downstream sums it.
 *
 * Pure, dependency-free and exported so a test can walk every shape without an
 * Electron process or a ledger -- the same contract src/agent-session-events.js
 * keeps for the readers on the other side of the channel.
 */
function turnUsageFrom(record) {
  if (!isPlainObject(record)) return null

  const turnFigures = isPlainObject(record.last) ? readFigures(record.last) : null
  const totalFigures = isPlainObject(record.total) ? readFigures(record.total) : null
  const flatFigures = readFigures(record)

  let basis
  let reading
  if (turnFigures && turnFigures.found > 0) {
    basis = 'turn'
    reading = turnFigures
  } else if (flatFigures.found > 0) {
    /* A FLAT RECORD IS THE TURN'S. Measured: the Claude CLI emits usage once,
       from the packet that ends the turn, and those figures are that turn's. */
    basis = 'turn'
    reading = flatFigures
  } else if (totalFigures && totalFigures.found > 0) {
    /* Only a running total was offered. It is recorded, and it is labelled, so
       that a reader takes the largest reading for the session rather than
       adding one per turn. */
    basis = 'session-total'
    reading = totalFigures
  } else {
    return null
  }
  const chosen = reading.figures

  const sessionTotal = totalFigures ? totalFigures.figures.totalTokens : null
  return Object.freeze({
    basis,
    /* Whether the reading ABOVE -- the one actually chosen, not its sibling --
       counts the cache inside its input figure. Null when it reported no cache
       figure, which is the honest answer and the one src/local-metrics.js reads
       as "this record does not say, so settle it from the figures or say
       unknown". */
    inputBasis: reading.inputBasis,
    ...chosen,
    /* The engine's own statement of how much room the model has. Not a token
       count and never summed with one. */
    contextWindow: wholeNumber(record.modelContextWindow) ?? wholeNumber(record.contextWindow),
    /* Kept so a screen can CHECK the turns it summed against what the engine
       says the session spent, and say so when they disagree, instead of
       asserting its own arithmetic. Null when the reading IS the total. */
    sessionTotalTokens: basis === 'turn' ? sessionTotal : null,
  })
}

/**
 * The writer.
 *
 * `recordTurn` refuses rather than degrades: a turn with no reading is not a
 * turn that cost nothing, and the only honest response to being handed one is
 * to write nothing at all. Every refusal is a SpawnRecordError with a code, and
 * the caller in shell/main.cjs swallows it -- a usage record that cannot be
 * written must never be able to stop an agent from answering.
 */
function createUsageRecorder({ safeStorage, directory, now } = {}) {
  const recorder = createSpawnRecorder({ safeStorage, directory, ledgerFile: USAGE_LEDGER_FILE, now })

  function turnRecord({ sessionId, principal = null, turnId = null, tier = null, account = null, status = null, failure = null, usage } = {}) {
    /* REFUSED HERE RATHER THAN LEFT TO THE WRITER, because the writer treats an
       absent usage field as "this record simply has none" -- which is right for
       the run ledger and wrong for this one. A usage record without a reading is
       a line claiming a turn happened and cost nothing. */
    if (usage === undefined || usage === null) {
      throw new SpawnRecordError('SPAWN_RECORD_INVALID_USAGE', 'A turn usage record needs a usage reading; there is nothing to record without one')
    }
    return {
      action: USAGE_ACTION,
      sessionId,
      principal,
      /* Deliberately empty. `details` is dropped by history() because it can
         carry a path, and this record has nothing that belongs in it -- every
         figure it holds is in the bounded `usage` field, by design. */
      details: {},
      /* `failure` rides here rather than in `details` for the reason
         boundedOutcome() gives at length: `details` is dropped by history()
         because it can carry a path, and a reason a person is meant to READ has
         to live in a field the writer bounds. A turn that ended well carries
         null, exactly as it carries null for a label the class would not hold. */
      usage: { ...usage, turnId, tier, account, status, failure },
    }
  }

  function recordTurn(input) { return recorder.record(turnRecord(input)) }
  function recordTurnAsync(input) { return recorder.recordAsync(turnRecord(input)) }

  /* The turns themselves, newest first, with the chain's verdict beside them.
     history()'s three rules hold unchanged here because this IS history(): no
     path, no signature, and it never throws. */
  function projectUsage(read, limit) {
    /* Filter before applying the caller's limit. A readable ledger line can
       still be unusable as a usage row (for example, after a partial restore
       wrote another action into this file). Letting history truncate first
       allowed that line to crowd a real turn out of `usage({ limit: 1 })`, so
       the UI reported no turn even though one was still readable immediately
       behind it. history() already caps its read at 200 lines. */
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20
    if (read.ok !== true) return read
    const entries = read.entries
      .filter(entry => entry.action === USAGE_ACTION && entry.usage !== null)
      .slice(0, bounded)
    return Object.freeze({
      ok: true,
      total: read.total,
      verified: read.verified,
      entries: Object.freeze(entries),
      ...(read.metrics ? { metrics: read.metrics } : {}),
    })
  }

  function usage({ limit = 200, metrics = null } = {}) {
    return projectUsage(recorder.history({ limit: 200, metrics }), limit)
  }

  async function usageAsync({ limit = 200, metrics = null } = {}) {
    await recorder.flush()
    return projectUsage(await recorder.historyAsync({ limit: 200, metrics }), limit)
  }

  return Object.freeze({
    availability: recorder.availability,
    verify: recorder.verify,
    ledgerPath: recorder.ledgerPath,
    recordTurn,
    recordTurnAsync,
    flush: recorder.flush,
    usage,
    usageAsync,
  })
}

module.exports = { createUsageRecorder, turnUsageFrom, usageLabel, USAGE_LEDGER_FILE, USAGE_ACTION }
