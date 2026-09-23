/* THE SELF-MAINTAINING HALF OF THE DESK-VS-REMOTE REPAIR.
 *
 * tools/test/reader-remedy-coverage.test.mjs holds SIX named sources shut --
 * REFUSAL_REMEDY, START_REFUSAL, UNAVAILABLE_TEXT (via startRefusalSentence),
 * ENGINE_REASON, EXTERNAL_CAPABILITIES steps, ACCOUNT_PANEL / PROVIDER_SIGN_IN
 * -- and says so itself: "this list is the thing to extend when a seventh
 * source appears, not a closed set. A lint that knows about six sources and
 * stops looking is the same mistake the two-shape whitelist made, one level
 * up." That prediction came true twice over on 2026-08-25: src/ledger-copy.js
 * (an EIGHTH source) and a `remedy` override written inline in
 * src/mission-bridge.js (which was never a named "table" for a human to add
 * to a list) both carried "close ToolsEnabled and open it again" to a
 * relay-reachable screen with no twin and no readerRemedy call anywhere
 * downstream.
 *
 * So this scans instead of enumerating. It walks every string and template
 * literal under src/ (excluding refusal-copy.js itself, whose desk/remote
 * correspondence is already held shut from both ends by the coverage test
 * and by tools/test/refusal-copy.test.mjs) and asks the same two questions
 * of every one that carries a physical instruction: does readerRemedy()
 * change it under viaRelay, and does the change actually address somebody
 * standing somewhere else. A string added next month in a FILE NOBODY HAS
 * WRITTEN YET is caught the same way these two were -- by what it says, not
 * by which table it was filed under.
 *
 * TWO KINDS OF LITERAL, two ways of checking them:
 *
 *   PLAIN   (`'...'`, `"..."`, or a template with no `${}` at all) -- the
 *           exact runtime string is right there in the source, so this calls
 *           the real readerRemedy() on it, the same call a renderer makes.
 *   TEMPLATE (a template literal with one or more `${}`) -- the interpolated
 *           value (a command, a section title) is not known statically, so
 *           this builds a SHAPE: the literal's static runs, in order, joined
 *           by a wildcard. A shape that fully matches some real
 *           REMOTE_TWIN key -- the same static runs, in the same order, with
 *           the real command sitting where the wildcard sat -- proves a twin
 *           exists for exactly this template, without needing to know what
 *           CODEX_SETUP_COMMANDS.install currently resolves to.
 *
 * WHAT THIS DOES NOT DO. It does not prove a readerRemedy() call sits
 * downstream of every desk-shaped literal it clears -- src/refusal-copy.js
 * having a twin and a renderer actually calling readerRemedy() are two
 * different facts, the same two facts the top-of-file comment in that module
 * spent its length keeping apart. Clearing this scan is necessary, not
 * sufficient; tools/test/reader-remedy-coverage.test.mjs's two-part check
 * (has a twin, AND the twin addresses somebody elsewhere) still runs
 * separately over the six named tables for that reason, and this scan's own
 * "already remote-shaped" and "known desk-only" exemptions below name their
 * evidence rather than asserting it, so a wrong one is falsifiable by
 * reading the same citation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractStringLiterals } from './user-visible-strings.mjs'
import { REMOTE_TWIN_KEYS, readerRemedy } from '../../src/refusal-copy.js'

/* THE FAITHFUL READING, not the visible-text one.
 *
 * tools/lib/user-visible-strings.mjs's own textOfChunk() collapses whitespace
 * and TRIMS each chunk -- exactly right for comparing what a person reads,
 * and exactly wrong here: this file rebuilds the runtime string a template
 * literal actually produces, and the space right before or after a `${}` gap
 * is part of that string. Trimming it independently on each side of the gap
 * silently deletes it, which first showed up as a real false positive while
 * building this scan: src/account-panel-copy.js's PROVIDER_SIGN_IN.lead()
 * reads `` `...terminal window with ${program}'s own sign-in...` `` --
 * trimmed, the two static runs join as "...withCodex's own..." with the
 * space gone, which no longer matches DESK_SIGNIN_LEAD's `with (.+)'s own`
 * and reads as an unguarded desk phrase that in truth already has a pattern
 * covering it. This only unescapes; it collapses nothing and trims nothing. */
function exactChunkText(raw) {
  return String(raw ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\(['"`\\$])/g, '$1')
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SCAN_ROOT = path.join(REPO_ROOT, 'src')

/* An instruction that requires hands ON THE MACHINE. Deliberately narrow --
   see tools/test/reader-remedy-coverage.test.mjs's own note beside its copy
   of this pattern for why "open windows terminal" and "open ToolsEnabled"
   stay in it even though nothing today needs them alone: the next phrasing
   will not be worded like the ones already fixed, and a pattern that only
   matches yesterday's fixes can only ever report zero. Kept as ONE copy
   would be better than two, but the coverage test's copy predates this file
   and the two are asserted equal below rather than merged, so an edit to
   either without the other fails loudly instead of drifting quietly. */
/* `open ToolsEnabled(?!\.ai)` -- NOT just `open ToolsEnabled` -- because this
   scan is case-insensitive and src/machine-tabs.js's MACHINE_TAB_NO_BRIDGE
   genuinely says "Open toolsenabled.ai in a browser and sign in to choose
   one there", which is a link to the WEBSITE, not an instruction to open the
   desktop app; without the lookahead it read as the same physical
   instruction every "open ToolsEnabled" is. Found by this scan running
   against real files rather than eight hand-picked tables, none of which
   happen to say "toolsenabled.ai" -- which is exactly why
   tools/test/reader-remedy-coverage.test.mjs's copy of this pattern never
   needed the fix. Both copies carry it now; see the drift-check test in
   tools/test/desk-phrase-remote-twin.test.mjs. */
export const PHYSICAL_INSTRUCTION = /close the whole app|close ToolsEnabled|close the app|open a new terminal|open a terminal|open windows terminal|open ToolsEnabled(?!\.ai)|open it again|open it a second time|reinstall|terminal window|windows terminal|paste this line/i

/* A sentence written for somebody elsewhere has to say whose computer it
   means or where they are acting from. */
export const ADDRESSES_A_REMOTE_READER = /that computer|from here/i

/* refusal-copy.js is the mechanism, not a customer of it: REMOTE_TWIN's own
   VALUES often repeat the desk phrase back ("On that computer, close
   ToolsEnabled...") while genuinely addressing a remote reader, which this
   scan's coarser check would misread as a bare desk sentence with no twin.
   Its own correspondence is held shut by reader-remedy-coverage.test.mjs and
   refusal-copy.test.mjs; this file does not re-derive that proof. */
const EXCLUDE_FILES = new Set([
  path.join(SCAN_ROOT, 'refusal-copy.js'),
])

/* WHOLE FILES VERIFIED, THIS SESSION (2026-08-25), TO BE UNREACHABLE BY A
 * BROWSER DRIVING A COMPUTER OVER THE RELAY -- each by architecture, not by
 * luck, and each citation is evidence a later reader can check rather than
 * a claim to take on trust. A file-level exemption is used only where the
 * unreachability is true of everything the file renders, not of one string
 * picked out of it -- src/connect-computer-settings.js, which mixes
 * desk-only content with a genuinely relay-reachable section, is NOT here
 * for exactly that reason; see ALREADY_REMOTE_SHAPED below for its one
 * relay-facing sentence instead. */
const EXEMPT_FILES = new Map([
  [path.join(SCAN_ROOT, 'device-claim-flow.js'),
    'the disconnect and cancel-waiting ceremony this file drives has no bridge over the relay to fire it from: canDisconnect() in src/connect-computer-settings.js refuses the control before ever asking the bridge when viaRelay() is true, and tools/test/connect-computer-ui.test.mjs "a browser reading through the relay is never offered the control" documents the reason in its own comment -- "The joined phase is not reachable over the relay (there is no bridge there)". No bridge means begin()/cancel() never fire for a relay reader, so DISCONNECT_REMEDY and the cancel-refused sentence are never shown to one.'],
  [path.join(SCAN_ROOT, 'account-state.js'),
    'accountBridge() reads `scope.mcAccount`, and this file\'s own SIGNED_OUT.reason states the fact this exemption rests on: "This page is running in a browser rather than the installed application, so there is no account on it to sign in to." mcAccount does not exist off the installed app, relay-driven or not, so readActionResult()\'s desk-worded fallback is only ever reached from inside the installed app itself.'],
  [path.join(SCAN_ROOT, 'setup-review-readiness.js'),
    'every desk-worded instruction this module produces is the not-viaRelay arm of a branch written beside a relay arm that names "that computer" or "the computer you are driving" and keeps its next step after that name: codexReadiness() defaults `viaRelay` from currentDataSource() and decides per branch, so a browser reading over the relay is handed the relay arm by the ternary itself -- the desk arms are unreachable there by construction, not by an assumption about where setup can be opened. Its one consumer, src/views/setup.js codexReadinessMarkup(), renders block.lines verbatim and adds no second translation pass (an earlier hand-rolled replace() sweep there was removed: the relay line "On that computer, open Windows Terminal and run:" still contains the lowercase desk phrase, so the sweep double-prefixed it).'],
  [path.join(SCAN_ROOT, 'account-reset-copy.js'),
    'src/views/account.js resolveBridge()/resetBridge() reads `globalThis.mcLocalData` (plan()/erase()) -- a THIRD bridge name, distinct from mcAccount and mcAgent, that exists to erase THIS installation\'s own disk. Nothing in this module or its one consumer branches on currentDataSource()/viaRelay anywhere, and its own copy states the reason: SIGN_OUT_LIMITS says outright "There is no server involved — an account here exists only on this computer." A relay tunnel forwarding a request to erase the browser-hosting machine\'s disk, or the driven machine\'s disk, is not a feature this product offers today; this whole surface is desk-only.'],
])

/* FINDINGS THIS SESSION (2026-08-25) COULD NOT RESOLVE EITHER WAY, and are
 * named here rather than silently passed so the guard stays green without
 * pretending the question is answered. Each gates on a global this
 * repository does not define -- `window.mcAgent.tools`,
 * `window.mcAccount.getSetting` -- built by another lane (the desktop preload
 * and the website's relay proxy), so whether it answers for a relay-driven
 * page is a fact this checkout cannot look up, not a fact this checkout
 * looked up and found absent. "Could not look" and "not there" are
 * different, and this scan only ever established the first for these two.
 * (src/research-settings.js was the third entry here; it no longer waits on
 * the answer -- see DESK_ARM_OF_LIVE_RELAY_TERNARY below.) DO NOT read this list as
 * "verified safe" -- it is "unresolved, escalated in the pass's report,
 * needs an answer from whoever owns the relay-side bridge implementation."
 * A confirmed answer either way should turn each into a real
 * EXEMPT_FILES/ALREADY_REMOTE_SHAPED entry with its evidence, or a fixed
 * source string with a twin -- never stay here. */
const UNVERIFIED_REACHABILITY = new Set([
  // src/quick-settings.js populateResearchTools(): gates on `window.mcAgent.tools`
  // AND `window.mcAccount.getSetting` both existing. mcAccount is confirmed
  // ABSENT off the installed app (see account-state.js's EXEMPT_FILES entry
  // above), which would make this desk-only too by the same reasoning --
  // except mcAgent is confirmed PRESENT over relay (src/views/metrics.js's own
  // comment: "'local' / 'relay' — the real records, over the bridge this page
  // has always read"), so it is not certain mcAccount here means the SAME
  // narrow current()/signIn() bridge account-state.js checks, or a broader
  // object that also answers getSetting() over relay.
  '<p class="drawer-tools-note">This copy cannot list agent tools. Open ToolsEnabled from its installed app to change them.</p>',
  // src/research-experiments.js dispatchExperiment(): refuses when the CALLER
  // did not pass a startAgent/persist function, which is a wiring question
  // one level removed from any global this file reads directly -- could not
  // trace the caller to a relay/local answer in this pass.
  'This copy cannot start workers from the bench. Open ToolsEnabled from its installed app.',
])

/* THE DESK ARM OF A LIVE viaRelay() TERNARY, VERIFIED IN SOURCE (2026-08-25).
 * Each literal here is the not-relay arm of a `${viaRelay() ? relay : desk}`
 * expression whose relay arm sits BESIDE it in the same template, names the
 * driven computer in words, and hands the relay reader a step they can take
 * from where they sit. The desk sentence is unreachable over the relay by
 * that ternary -- checkable by reading the two arms together -- not by a
 * claim about a bridge another lane owns. Unlike EXEMPT_FILES this is
 * per-literal: the file around it may serve relay readers freely. */
const DESK_ARM_OF_LIVE_RELAY_TERNARY = new Set([
  // src/research-settings.js bodyMarkup(), the `!shell` branch: the relay arm
  // reads "This browser could not reach ToolsEnabled on the computer you are
  // driving, so it cannot show these switches. Make sure ToolsEnabled is open
  // on that computer, then reload this page." -- "that computer", and a reload
  // a relay reader can actually do. The desk arm below renders only when
  // viaRelay() is false. This entry replaces the UNVERIFIED_REACHABILITY note
  // that held the pre-split <p> literal: whether `window.mcSettings` answers
  // for a relay-driven page is STILL a fact owned by another lane (a fourth
  // distinct bridge name, after mcAccount, mcAgent and mcLocalData), but the
  // copy no longer waits on that answer -- whichever way it lands, a relay
  // reader who reaches this branch is shown the relay arm.
  'This window could not reach the installed application, so it cannot show these switches. Close it and open it again.',
])

/* CONFIRMED, THIS SESSION, TO BE THE MOCK/NO-CONNECTION STATE ONLY -- a
 * literal reachable when there is genuinely no computer being driven at all
 * (a signed-out browser, the example toggle), never when a real computer,
 * local or relayed, is behind the page. "Open ToolsEnabled on a computer"
 * is the correct floor instruction in that state precisely because there is
 * no SPECIFIC computer for "that computer" to refer to yet -- unlike the
 * REMOTE_TWIN cases, there is no better sentence to write here, so this is
 * an exemption rather than a fix. */
const NO_COMPUTER_AT_ALL = new Set([
  // src/local-metrics.js LOCAL_METRICS_COPY.noChannel / LOCAL_USAGE_COPY.noChannel:
  // both fire only when `globalThis.mcAgent` itself does not exist. Confirmed
  // by src/views/metrics.js's own header comment -- "'local' / 'relay' — the
  // real records, over the bridge this page has always read — readLocalRuns()
  // / readLocalUsage()" -- so a relay reader (who by definition has that
  // bridge, tunnelled) never lands on noChannel; only a bridgeless browser does.
  'This page is open in a web browser, so there is no computer here keeping a record of agent runs. Open ToolsEnabled on a computer and this fills in as you use it.',
  'This page is open in a web browser, so there is no computer here keeping a record of what your agents use. Open ToolsEnabled on a computer and this fills in as you use it.',
  // src/local-activity.js describeHome() HOME_MODES.NO_HOST headline: set by
  // `if (!sessions.supported) return HOME_MODES.NO_HOST`, the exact same
  // readLocalRuns() answer local-metrics.js checks above, so the same proof
  // applies -- a relay reader's mcAgent answers `supported: true`.
  'Open ToolsEnabled on your computer to see what has run there',
  // src/views/computers.js START_NEEDS_APP_TEXT: its own comment says who
  // reaches it -- "The example fleet, the browser preview and the website's
  // screenshots all run this same view with no agent bridge on `window`" --
  // which is the mock/no-source state by name, not a relay reading (relay
  // means a bridge IS on window, tunnelled to a real machine).
  'Starting an agent needs the installed ToolsEnabled application. This page is a preview of it, so nothing here can start one. Open ToolsEnabled on your computer to grow a real tree.',
])

/* DESCRIPTIVE, NOT IMPERATIVE -- "reinstall" as a noun describing what
 * survives a future reinstall, never an instruction telling the reader to go
 * reinstall something right now. PHYSICAL_INSTRUCTION's bare `reinstall`
 * cannot tell the two apart from the substring alone; a human read both and
 * confirmed neither asks the reader to do anything, so a "that computer"
 * rewrite would not change what either sentence tells someone to DO -- only
 * a softer, mechanical "this"->"that" swap remains open (both sentences are
 * genuinely about the driven computer's own disk, not the reader's browser,
 * so unlike src/views/checkout.js's trap that swap would not even be wrong
 * here -- it is simply outside PHYSICAL_INSTRUCTION's job, which is
 * instructions, not every bare mention of the machine). */
const DESCRIPTIVE_NOT_IMPERATIVE = new Set([
  // src/permission-guidance.js RISK_PROFILES.uninstall_data.capabilities[0]
  'On "keep my data", reinstalling later picks up exactly where you left off.',
  // src/views/settings.js SETTINGS_ROWS uninstall_data .desc, the four `+`-joined
  // pieces merged back into one sentence by this scan's own concatenation seam.
  'Uninstalling removes the program. It does not remove your saved credentials, your linked accounts, the signed record of every action taken, your agent history or your settings — those stay on this computer so a reinstall picks up where you left off. Choose what should happen to them.',
])

/* LITERAL TEXT (or, for a template literal, its exact static runs with a
   wildcard standing in for each interpolated part) THAT ALREADY ADDRESSES A
   READER STANDING SOMEWHERE ELSE, in words ADDRESSES_A_REMOTE_READER above
   does not recognise. Each entry is load-bearing: delete it and the guard
   should turn red on the string it names -- that is the mutation check this
   file's own test runs. */
const ALREADY_REMOTE_SHAPED = [
  /* src/connect-computer-settings.js statusLine(), the `phase === 'absent'
     && viaRelay` branch: painted ONLY for a relay reader (the `viaRelay`
     guard sits directly above it in source, and
     tools/test/connect-computer-ui.test.mjs "read over the relay, the
     absent state says the computer is on the account and where the switch
     lives" drives exactly this branch), and it already says where the
     switch is in words this scan's pattern does not match -- "on the
     computer itself" rather than "that computer". The `￿` marks each
     interpolated gap (CONNECT_SECTION, WEB_DRIVE_CONTROL_LABEL); the scanner
     below turns those into wildcards on both sides of the comparison. */
  'That is how this browser is reading it. Whether a browser may drive it is decided on the computer itself: on it, open ToolsEnabled, go to Settings, open “￿” and set “￿”.',
]

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* A regex built from a literal's static runs, in order, with a lazy wildcard
   standing in for every `${}` gap. `[\s\S]*?` also happily matches straight
   through the literal `￿` placeholder a hand-written ALREADY_REMOTE_SHAPED
   reference uses for its own interpolated gap, so testing this regex against
   such a reference needs no special-casing on that side either. */
function shapeRegexFor(chunks) {
  const parts = chunks.map(chunk => escapeRegExp(chunk))
  return new RegExp(`^${parts.join('[\\s\\S]*?')}$`, 's')
}

/* A FEW STAND-IN VALUES, tried in every `${}` gap of a templated literal
   together, to see whether readerRemedy()'s three DESK_PATTERNS (not just the
   REMOTE_TWIN exact-match table) already cover it. This is why
   src/account-panel-copy.js's PROVIDER_SIGN_IN.lead()/.opened() -- each one
   `${program}'s own sign-in already running in it...`, matched against
   DESK_SIGNIN_LEAD/DESK_SIGNIN_OPENED -- do not need a twin of their own: the
   pattern's capture group accepts any of these candidates, so it accepts the
   real one too. A candidate cannot prove ABSENCE of coverage, only presence
   -- which is why this runs ALONGSIDE the REMOTE_TWIN shape check below
   rather than instead of it. */
const TEMPLATE_CANDIDATES = Object.freeze(['Codex', 'codex login', 'X'])

function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) { listSourceFiles(full, out); continue }
    if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * Every string/template literal under src/ that reads as a physical
 * instruction and has neither a real readerRemedy() translation (plain
 * literals) nor a matching REMOTE_TWIN / ALREADY_REMOTE_SHAPED shape
 * (templated literals), and is not inside an EXEMPT_FILES entry.
 *
 * @returns [{ file, line, text, reason }] -- `file` repo-relative,
 *          `text` the literal's own characters (never a line number alone:
 *          this is the evidence a report should quote).
 */
export function scannedFileCount({ scanRoot = SCAN_ROOT } = {}) {
  return listSourceFiles(scanRoot).filter(file => !EXCLUDE_FILES.has(file)).length
}

/* THE `+`-CONCATENATION SEAM. This product writes its longer copy as
   adjacent string literals joined by `+`, one per line --
   `'Sign out ends this sign-in on this computer. '\n  + '"Sign out everywhere" also refuses...'`
   -- and extractStringLiterals(), which walks quotes and `${}` gaps, has no
   idea `+` means "one sentence, two literals": it reports each side as its
   own complete literal. Read alone, the SECOND half often starts mid-clause
   and either says nothing alarming on its own or -- worse -- LOOKS like a
   bare desk sentence with the "that computer" from the FIRST half stripped
   away, which is how src/machine-tabs.js's MACHINE_TAB_STILL_FINISHING was
   first mis-flagged while building this scan: its own sentence opens "That
   computer has not finished..." and the physical instruction sits in the
   continuation on the next line, alone.
   A FIRST DRAFT OF THIS MERGE USED "starts lower-case" as the join signal
   and was wrong: this codebase's composed-fragment TABLES (UNAVAILABLE_TEXT
   and friends) write every entry lower-case on purpose -- see
   src/agent-availability-copy.js's own header, "lower-case first and carry
   no full stop of their own because startRefusalSentence() composes them" --
   so that draft merged unrelated OBJECT PROPERTIES together whenever two
   happened to sit on adjacent lines, which is not this seam at all. The
   actual, unambiguous signal is narrower and does not guess: a literal is a
   continuation of the one immediately before it only when the RAW SOURCE
   LINE it starts on, trimmed, itself begins with `+` -- which is what this
   codebase's own formatting always does at a concatenation join and never
   does at a property boundary (`key: '...'` or a bare `'...',` start with
   the key or the quote, never the operator). */
function mergeConcatenations(literals, sourceLines) {
  const groups = []
  for (const literal of literals) {
    const cleanChunks = literal.chunks.map(chunk => exactChunkText(chunk.text))
    const templated = literal.chunks.length > 1
    const previous = groups[groups.length - 1]
    const lineStartsWithPlus = (sourceLines[literal.line - 1] || '').trimStart().startsWith('+')
    if (!templated && previous && !previous.templated && lineStartsWithPlus) {
      previous.chunks[previous.chunks.length - 1] += cleanChunks[0]
      previous.endLine = literal.line
      continue
    }
    groups.push({ line: literal.line, endLine: literal.line, templated, chunks: [...cleanChunks] })
  }
  return groups
}

export function scanForUnguardedDeskPhrases({ scanRoot = SCAN_ROOT } = {}) {
  const violations = []
  let files
  try {
    files = listSourceFiles(scanRoot).filter(file => !EXCLUDE_FILES.has(file))
  } catch (error) {
    const relRoot = path.relative(REPO_ROOT, scanRoot).split(path.sep).join('/') || '.'
    return [{ file: relRoot, line: 0, text: `[scan error: ${error.message}]`, reason: 'walker-error' }]
  }
  for (const file of files) {
    const relFile = path.relative(REPO_ROOT, file).split(path.sep).join('/')
    const exemptReason = EXEMPT_FILES.get(file)
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch (error) {
      violations.push({ file: relFile, line: 0, text: `[scan error: ${error.message}]`, reason: 'walker-error' })
      continue
    }
    let literals
    try {
      literals = extractStringLiterals(source)
    } catch (error) {
      violations.push({ file: relFile, line: 0, text: `[scan error: ${error.message}]`, reason: 'walker-error' })
      continue
    }
    const sourceLines = source.split('\n')
    for (const group of mergeConcatenations(literals, sourceLines)) {
      const joined = group.chunks.join(' ')
      if (!PHYSICAL_INSTRUCTION.test(joined)) continue
      if (ADDRESSES_A_REMOTE_READER.test(joined)) continue
      if (exemptReason) continue
      if (UNVERIFIED_REACHABILITY.has(joined)) continue
      if (DESK_ARM_OF_LIVE_RELAY_TERNARY.has(joined)) continue
      if (NO_COMPUTER_AT_ALL.has(joined)) continue
      if (DESCRIPTIVE_NOT_IMPERATIVE.has(joined)) continue

      if (!group.templated) {
        const exact = group.chunks[0]
        const remote = readerRemedy(exact, { viaRelay: true })
        if (remote !== exact && ADDRESSES_A_REMOTE_READER.test(remote)) continue
        violations.push({ file: relFile, line: group.line, text: exact, reason: 'no-remote-twin' })
        continue
      }

      const regex = shapeRegexFor(group.chunks)
      const hasTwin = REMOTE_TWIN_KEYS.some(key => regex.test(key))
      const alreadyShaped = ALREADY_REMOTE_SHAPED.some(ref => regex.test(ref))
      const candidateCovers = TEMPLATE_CANDIDATES.some((value) => {
        const candidate = group.chunks.join(value)
        const remote = readerRemedy(candidate, { viaRelay: true })
        return remote !== candidate && ADDRESSES_A_REMOTE_READER.test(remote)
      })
      if (hasTwin || alreadyShaped || candidateCovers) continue
      violations.push({ file: relFile, line: group.line, text: joined, reason: 'templated-no-remote-twin' })
    }
  }
  return violations
}
