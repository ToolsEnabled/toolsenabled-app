# Scribe build log

Newest last. One entry per working session.

---

## 2026-07-19 · Planning

Researched with 223 agents across three parallel workflows (suite/corpus/hardware
survey, agent-runtime and docx research, voice and UI research), then verified
the four load-bearing assumptions by running them on this machine rather than
trusting documentation:

- The agent stream exposes every step, including tool arguments as they are
  typed (`input_json_delta`), so a pending edit can be shown before it executes.
- Mid-turn steering works. A message injected 2.5 s into a running turn was
  accepted and landed at the next turn boundary with `isReplay: true`, session
  intact.
- Subagents are individually attributable via `parent_tool_use_id`, and run
  concurrently with the main agent.
- A custom stdio MCP server is accepted and its tools are called, so the agent
  can be given a semantic document vocabulary instead of raw file access.

Wrote `PLAN.md`. Human settled four decisions: steer plus research subagents,
local GPU speech to text with text replies, live edit with visual diff, and any
.docx via a file picker.

---

## 2026-07-19 · Phase 0, the document engine · DONE

**Shipped**

- `engine/docmodel.py`. Run-aware, formatting-preserving .docx editing.
  `open` (stamps `w14:paraId`), `read`, `find`, `replace`, `insert`, `delete`,
  `format`, `save`. Addressing is by stable paragraph id, never by index.
- `test/test_docmodel.py`. 52 assertions, all passing.

**Measured**

| Thing | Value | Why it matters |
|---|---|---|
| Open (333 paragraphs, 129 KB body) | 24 ms | one parse per session, held in memory |
| Save, median of 5 | **14 ms** | resolves the Phase 0 open question outright |
| paraId stamping | 333/333 unique, 0 re-stamped on reopen | identity is stable across save and reload |
| Cross-run replace on the worst paragraph | 13 runs to 13 runs, 8 rPr to 8 rPr, all 4 colors intact | the colored audit markup survives editing |
| Zip parts changed by a save | only `word/document.xml` | styles.xml and the other 16 parts are byte identical |
| Hidden table paragraphs recovered | 213 / 183 / 183 in the sibling drafts | and verified editable, not just visible |

**Corrections to PLAN.md**

- The corpus has **405 runs, not 404**. The survey's 404 was a count of `w:t`
  elements. Exactly one run carries a bare `w:br` and no text. The engine's
  `run_children_ok` guard refuses to rebuild it, so the line break cannot be
  silently eaten. Plan updated.
- Save latency was listed as an unmeasured risk. It is 14 ms. Risk closed, and
  a save-per-op is affordable, so writes need no batching for performance.

**Notes for the next session**

- The primary target file has zero tables, so it could not exercise the table
  walk. Coverage comes from the three sibling drafts. Keep it that way: any
  future structural change needs testing against a file that has tables.
- `format` deliberately splits runs (13 to 15 on the test paragraph) because a
  span needs its own `rPr`. `replace` deliberately does not, because folding the
  replacement into the first covered run preserves the run count exactly. These
  are different on purpose.
- Ambiguous matches are refused rather than defaulting to the first occurrence.
  The agent gets an error naming the match count and is told to pass
  `occurrence` or use a longer phrase. This will shape the tool descriptions in
  Phase 3.
- Tests open the real sibling drafts read-only and never call `save()` on them.
  Verified after the run: no file outside `scribe/` was modified, all corpus
  mtimes unchanged. Preserve that property.

**Next: Phase 1, the server.** `server.js` on port 4610, env prefix `SCRIBE_`,
supervising `engine/dochost.py` as a persistent stdio JSON-lines process so the
document is parsed once per session. Endpoints `/api/doc`, `/api/edit`,
`/api/events` (SSE), plus the pause gate, atomic state persistence, per-utterance
undo, and a pid file swept inside the `listen()` callback. `dochost.py` does not
exist yet; Phase 1 writes it as a thin loop over the existing `ScribeDoc`.

---

## 2026-07-19 · Plan revision: grounded drafting flow

Human asked for a capability the plan did not cover: ask a vague question about
the paper ("I want to say we did this, but what did we actually do?"), have
Scribe go look it up across drafts and evidence, come back with a grounded
answer plus several candidate phrasings shown on screen, then say which one to
use and watch it go in.

Added to PLAN.md as section 0.1, and it is now a headline capability rather
than a feature:

- **0.1** the flow itself, and the four properties it must have (grounded with
  provenance, options as first-class selectable objects, written in the author's
  voice, and proposing is explicitly not editing).
- **0.2** what Scribe can read, with `scribe/drafts/` as a drop folder that is
  searched first and trusted most. Roots live in `sources.json`.
- **2.4** three new tools: `doc_propose`, `research`, `db_query`.
- **2.7** the retrieval pipeline as a real staged pipeline (plan, sweep across
  five modalities in parallel, read, reconcile, ground, draft) rather than a
  single grep. Conflicts between drafts are surfaced, not averaged.
- **2.8** everything runs on the Claude CLI, stated explicitly. The main agent,
  research subagents, reconciler, and drafting agent are all `claude.exe` using
  the existing authenticated session. No API keys, no SDK. Local Ollama models
  are for speech to text only and never write prose or answer research
  questions.
- **Phase 5** now also builds the option cards and the voice reference resolver.
  **Phase 6** is now the full pipeline, and loads `WRITING_STYLE_JOSH.md` so
  options come back in Josh's voice rather than generic academic prose.

Created `scribe/drafts/` with a README explaining the trust ordering.

---

## 2026-07-19 · Phase 1, the server · DONE

**Shipped**

- `engine/dochost.py`. Persistent stdio JSON-lines host over `ScribeDoc`, so the
  document is parsed once per session. UTF-8 forced on all three streams,
  because Windows defaults stdio to cp1252 and would throw on the first
  non-ASCII character in the paper. Never dies on one bad request.
- `server.js`. Zero dependencies, port 4610, `SCRIBE_` env prefix. Document host
  supervision with restart-on-death, HTTP API, SSE feed with backpressure
  handling, pause gate, per-utterance undo, activity trail, atomic persistence,
  pid file swept inside the `listen()` callback.
- `test/test_server.js`. 43 assertions against a real server on a test port
  driving a throwaway copy of the paper over HTTP.

**Measured**

| Thing | Value |
|---|---|
| Save latency through the full HTTP path | 18.5 ms |
| Open, stamp, and serve 333 paragraphs | under one second end to end |
| Refusals that mutated the document anyway | 0 of 4 |

**Design notes**

- **Undo is a byte copy of the .docx**, not an inverse-op log. The file is 86 KB
  and a save is 14 ms, so copying is both trivially cheap and exactly correct,
  which beats reconstructing inverses for an arbitrary op vocabulary. Verified:
  an undo reverts the entire utterance (two ops) in one step.
- Every refusal is tested as a **pair**: rejected AND the document did not
  change. A rejection that mutated anyway is the failure mode that silently
  corrupts a paper, and it is invisible unless asserted directly.
- `uncaughtException` is logged loudly and broadcast, deliberately not
  swallowed. The sibling suite swallows both and the recorded consequence was a
  server "found completely gone with zero crash trace".

**Two defects found and fixed during the phase**

1. A test asserted an ambiguous-match refusal against paragraph 100, which
   turned out to be short enough ("Admission Gates") that after the previous
   edit it contained no lowercase `e` at all. The refusal was real but for the
   wrong reason. The test now picks a paragraph with a verified repeated token
   (15 occurrences of " the "), and additionally proves that passing
   `occurrence: 2` resolves the ambiguity and lands at the exact expected
   character offset (755).
2. **The test was not actually isolated.** It passed `SCRIBE_DATA` for a
   throwaway state directory and `server.js` ignored the variable, so every run
   overwrote the live `state.json` and left orphaned checkpoints pointing at
   deleted temp files. `server.js` now honors `SCRIBE_DATA`, the live data dir
   was cleaned, and the test asserts its own isolation. Worth remembering: the
   isolation was written, looked right, and did nothing.

**Notes for the next session**

- No UI exists yet. `public/` is empty and the server 404s on `/`.
- `sources.json` is specified in PLAN.md section 0.2 but not written yet.
- The op vocabulary in `server.js` covers read/find/model/stats/replace/insert/
  delete/format. `doc_propose`, `research`, and `db_query` are Phase 5 and 6.

**Next: Phase 2, the viewer.** OOXML to HTML with `data-pid` on every paragraph
and `data-run` on every run, build-once and patch-forever keyed on paragraph ids
so in-flight animations survive an edit, rAF-coalesced SSE application, and the
per-phrase glow. The model already carries everything the renderer needs (style,
table flag, and per-run b/i/u/color/highlight/size), verified by the test
asserting 4 colored runs survive the round trip.

---

## 2026-07-19 · Phase 2, the viewer · DONE

**Shipped**

- `public/index.html`, `public/app.css`, `public/app.js`. The document renders
  from OOXML to DOM with `data-pid` on every paragraph and `data-run` on every
  run. Build once, patch forever. Events are queued and applied on an animation
  frame rather than one layout pass per event.
- `test/cdp.js`. A dependency-free Chrome DevTools Protocol client (Node 22 has
  a global WebSocket). Launches headless Chrome, evaluates in-page, screenshots,
  and kills the browser **by captured pid only**.
- `test/test_viewer.js`, 38 assertions against a real browser.
- `test/shot.js`, renders the real paper and photographs it light and dark.
- `package.json` (`npm test` runs all three suites) and `start-scribe.cmd`.
- `/api/say` now records what you typed to the trail and honestly reports
  `delivered: false`, rather than 404ing or faking an agent reply.

**Measured**

| Thing | Value |
|---|---|
| Patch after an edit | **0.5 ms, 1 paragraph, 333 of 333 nodes reused** |
| First paint, 333 paragraphs, cold headless | 2.5 s |
| Formatting fidelity | 163 colored, 59 bold, 89 italic, 36 highlighted runs, matching the OOXML exactly |
| Tables | 3 tables, the verdict table at 21 rows by 5 columns, all 213 cell paragraphs inside cells, 0 leaked |
| Console errors / uncaught exceptions | 0 / 0 |

**Three bugs the DOM tests passed straight through, and only a screenshot caught**

1. **The pause overlay was permanently on.** `.scrim { display: flex }` in the
   stylesheet beats the UA rule for the `hidden` attribute, so the scrim never
   hid, and its `backdrop-filter: saturate(0.65)` was washing out the entire
   document. Every DOM assertion still passed. Fixed with `.scrim[hidden] {
   display: none; }` and a regression test asserting `display === 'none'` while
   not paused.
2. **Every edit produced two identical trail cards.** The server emits both a
   `trail` and an `edit` event for one edit and the client rendered both. It
   read as though the agent had acted twice. Now the `trail` event is the single
   source, with a test asserting exactly one card per edit.
3. **A vacuous test.** "page threw nothing" checked `window.__errs`, which was
   never populated, so it could not fail. `cdp.js` now installs a real collector
   via `Page.addScriptToEvaluateOnNewDocument` plus `Runtime.exceptionThrown`,
   and the suite first asserts the collector is armed.

**One design decision the screenshot forced**

The document sheet stays **white in both themes**, while the chrome follows the
system theme. Dark mode had made the paper unreadable, and the reason it cannot
simply be recolored is that the run colors are **semantic** in this corpus:
green marks an addition, pink a deletion, purple a note. Remapping the palette
for contrast would silently change what the markup means. Word and Google Docs
make the same call. There is now a test asserting the authored run colors are
byte-identical across themes.

**Also this session**

- `docmodel.py` gained `table_pos()`, so table paragraphs carry `{tbl, row,
  cell}` and the renderer can rebuild the grid. Without it the sibling drafts'
  213 cell paragraphs drew as stray lines. Deliberately not cached: an
  `id()`-keyed cache can outlive the element it describes.

**Notes for the next session**

- First paint at 2.5 s is cold headless including browser launch, SSE connect,
  and model fetch. The number that matters for live editing is the 0.5 ms patch.
  Worth re-measuring in a warm real browser before optimizing anything.
- The full model is refetched on every edit (the deck suite's approach). At
  0.5 ms of patch time this is not currently a problem, but it is the thing to
  revisit if the SSE payload risk in PLAN.md section 4 ever bites.
- `sources.json` still not written. Still Phase 6.

**Next: Phase 3, the agent.** `agent.js` spawning `claude.exe` with
`shell: false` (never `shell: true`, which mangles JSON arguments), stream-json
both directions, `--include-partial-messages`. The event normalizer. `mcp-doc.js`
bridging the six document ops back to the server over loopback. The PreToolUse
guard with a test, including the open question of whether the `--settings` hook
propagates into `Agent` subagents. The stdin queue and the interrupt control
frame with its `error_during_execution` drain. Reference implementations for all
of this already sit in `test/probe-*.js`, verified working.

---

## 2026-07-19 · Phase 3, the agent · DONE

**Shipped**

- `mcp-doc.js`. The six document tools as a dependency-free stdio MCP server,
  spawned by `claude.exe` and calling back into the server on loopback, so an
  agent edit takes exactly the same path as a human one: same validation, same
  checkpoint, same trail entry, same broadcast.
- `guard.js`. The PreToolUse sandbox. Allowlist, fails closed (`deny` is
  assigned before any parsing), always exits 0 with the decision in the body.
- `agent.js`. One long-lived `claude.exe` in streaming-json mode, spawned with
  `shell: false` against the resolved native binary, with all config written to
  files rather than argv. Normalizes the raw stream into 15 event kinds.
- Server wiring: `/api/say` now reaches the agent, plus `/api/agent/{start,stop,
  interrupt}`. Agent events broadcast to the browser unfiltered.
- `test/test_guard.js` (44 assertions) and `test/test_agent_live.js` (33
  assertions against a real agent, real document, real tokens).

**Measured, live**

| Thing | Value |
|---|---|
| Full round trip, utterance to edited .docx | worked first try |
| Time to first token | 3.9 s |
| Cost of the whole live suite | $0.13 per run, 4 turns, on Haiku |
| Tool arguments streamed before execution | 14 deltas, 178 chars final |
| Guard decisions in one session | Agent:allow, ToolSearch:allow, doc_find:allow, doc_replace:allow, **Bash:deny** |

**Two findings that changed the design**

1. **The sandbox DOES propagate into subagents.** This was PLAN.md's open
   question 9, and it was the one that could have forced research subagents to
   become separate processes. Proven live: a subagent was told to run `Bash`,
   the guard fired with `agent_id` populated, and denied it. Phase 6 can use
   ordinary `Agent` subagents inside the one session, which is both simpler and
   keeps them observable via `parent_tool_use_id`.

2. **`--allowed-tools` is not a sandbox.** It controls auto-approval, not
   availability. `Bash`, `Edit`, `PowerShell`, and `Write` remain in the model's
   toolset regardless of what is passed, and the agent does reach for them: it
   attempted `Bash` unprompted during the subagent probe. **The PreToolUse hook
   is not defense in depth here, it is the entire defense.** The live test now
   asserts this real state of the world rather than the comfortable assumption,
   so nobody later "cleans up" the guard believing the tool list already
   restricted anything.

**One test-ordering bug in my own work**

The first run reported "session established" as failing while the agent was
demonstrably working. Cause: `system/init` is emitted when the **first message
arrives**, not at spawn, so an idle agent genuinely has no session yet. The
assertion was simply too early. Worth carrying into Phase 4: **"agent started"
does not mean "agent ready"**, and the UI must not claim otherwise. The test now
asserts there is no session before anything is said, and asserts the handshake
after the first turn.

**Also verified live**

- A tool call is announced (`tool-pending`) before it executes, and its
  arguments stream in as the agent types them. This is the raw material for the
  Phase 4 "about to do" display.
- Injected messages come back echoed as `delivered`, so queued versus delivered
  can be shown honestly.
- Interrupt stops a turn without killing the session: same session id before and
  after, agent still running, and the interrupted turn's own `result` arrives
  flagged rather than being mis-attributed to the next message.
- Undo still groups a whole agent utterance into one step, now that the server
  stamps the utterance rather than the agent naming its own.

**Notes for the next session**

- `agent.js` currently keeps `pendingTools` keyed by tool_use_id, and the
  `input_json_delta` handler attributes a delta to the first not-done pending
  tool. That is correct for one tool call at a time, which is what the stream
  actually does, but it would mis-attribute if two tool_use blocks ever streamed
  concurrently. Worth hardening with the block index if Phase 4 sees it.
- The agent is not auto-started. The UI must offer it, or Phase 4 should start
  it on first utterance.

**Next: Phase 4, watching it work.** The agent lane in the UI: pending calls
rendered from `tool-args` before they execute, then running, then done with
their result. Nested lanes for subagents keyed on `parent_tool_use_id` (complete
messages only, since `stream_event` is main-session only). Thinking meter from
`thinking`. ttft and cost from `turn-end`. All 15 event kinds already flow to
the browser over SSE and can be inspected in the console today.

---

## 2026-07-19 · Phase 4, watching it work · DONE

**Shipped**

The rail now answers three questions top to bottom: what state is the agent in,
what is it doing right now, and what has it already done.

- Agent panel: state, a start/stop control, time to first word, running cost,
  and a thinking meter driven by the live token estimate.
- The lane. Every tool call appears the moment it is announced, **before it
  runs**, and its arguments fill in as the agent types them. Then it goes
  running, then done with its result and how long it took. Refusals render as
  errors with the reason legible.
- Subagent calls nest inside the `Agent` call that spawned them, keyed on
  `parent_tool_use_id`.
- `test/test_lane.js`, 36 assertions in a real browser.
- Talking to the agent now starts it. A separate "start" click before the first
  sentence was a step with no decision in it.

**The division of labour in the tests, deliberately**

`test_agent_live.js` proves the event **shapes** are what a real `claude.exe`
emits. `test_lane.js` proves the **drawing** is right, driven by synthetic
events copied from those observed shapes. Doing the second against a live agent
would cost dollars per assertion and be flakier for it. Neither test is
sufficient alone and together they cover the chain.

**The interesting bit: rendering half-written JSON**

Tool arguments arrive as `input_json_delta`, so for most of a call's life the
JSON is truncated and `JSON.parse` throws. `partialFields()` parses it anyway
with a tolerant scan, which is what lets a pending `doc_replace` show
`old phrase → new phra▍` while the agent is still typing. This is the single
most valuable thing on screen: it is the moment where you can still say "no, not
that" before anything touches the paper. Verified with the exact truncation
pattern the live run produced.

**Honest states**

- `starting` is not `ready`. The session does not exist until the first message
  is sent, so the panel says "starting, waiting for your first message" rather
  than claiming a session it does not have. This came directly out of the Phase
  3 test-ordering bug.
- A message sent mid-turn shows "queued, it will pick this up next", and clears
  only when the `delivered` echo actually arrives. The UI never guesses.
- An interrupted turn says "interrupted" rather than quietly looking finished.

**Screenshot review**

Checked light and dark again. No new bugs this time. The rail is legible in
both, the nesting reads clearly, and the pending caret is visible. Given this
pass caught three real bugs at Phase 2 and none here, the practice stays:
screenshot every visual phase.

**Notes for the next session**

- `clearLane()` wipes the lane at `turn-start`, so the lane always shows the
  current turn. Completed work survives in the trail below it. If a turn ever
  needs reviewing after the fact, that history is in the trail, not the lane.
- The lane caps at 42vh of scroll. A turn with very many tool calls will scroll
  internally rather than push the trail off screen.
- `agent.js` still attributes `input_json_delta` to the first not-done pending
  tool. Correct for the observed stream (one tool call at a time) but it would
  mis-attribute if two ever streamed concurrently. Not yet observed.

**Next: Phase 5, the chat bar and the option cards.** The bar itself works. What
Phase 5 adds is the receiving half of the grounded drafting flow: `doc_propose`
renders option cards with their grounding, each selectable by click or by voice
("the second one", "B but shorter"), and accepting one routes its text through
the ordinary edit path. The reference resolver that turns a spoken phrase into
an option id lives there, and a modified acceptance must hand the option plus
the modification back to the agent rather than trying to edit the text itself.

---

## 2026-07-19 · Phase 5, the chat bar and option cards · DONE

**Shipped**

- `doc_propose` tool. The agent puts 2 to 4 candidate phrasings on screen with
  grounding. It writes nothing.
- `resolve.js`. Turns "let's say B but drop the second clause" into an action.
- Server: proposal state, `/api/propose`, `/api/accept`, `/api/dismiss`,
  `/api/proposals`, and resolver routing inside `/api/say`.
- UI: option cards docked above the bar, each showing its letter, text, and what
  makes it different, with grounding underneath and the anchor paragraph marked
  in the document. Click, or press the letter or number, or just say it.
- `test/test_resolve.js` (50) and `test/test_propose.js` (38).

**The invariant, asserted repeatedly: proposing writes nothing**

A proposal is visible, comparable, and completely inert. Three separate tests
byte-compare the .docx before and after to prove it: on propose, on a modified
acceptance, and on dismissal. Only an explicit acceptance writes, and when it
does it goes through `applyOp` like any other edit, so it is checkpointed,
trailed, broadcast, and undoable identically. Verified: accepting then undoing
removes it.

**The resolver's own tests caught it doing real damage**

The first version was far too eager, and the negative cases (half the suite by
design) caught three genuine hazards:

| Utterance | Wrongly resolved to | Why |
|---|---|---|
| "add a sentence about the judge disagreement" | modify **A** | the article "a" is also an option id |
| "what did we actually do in the second study" | accept **B** | "second" is an ordinary word long before it is an ordinal |
| "the last one" | **A** | "one" read as the ordinal 1 rather than as a pronoun |

The first of those would have hijacked an ordinary instruction into editing the
paper. The rewrite added: single-letter ids that are English words need an
explicit frame or a very short message, number-words only count when introduced
("option one"), questions never resolve, and the earliest reference in the
sentence wins so "C but combine it with A" picks C. Zero of the ambiguous
messages now resolve to an edit.

The governing rule is written at the top of the file: **when in doubt return
`none` and let the agent decide.** Returning `none` costs a round trip; guessing
wrong costs trust in every future proposal.

**Three routes, one of which edits**

- `accept` ("the second one") applies immediately, no model call. This is what
  makes choosing feel instant.
- `modify` ("B but shorter") hands the agent the chosen option AND the requested
  change. The resolver never rewrites prose itself.
- `dismiss` / `none` write nothing.

**Bug found by the flow test**

A modified acceptance silently degraded into a plain message on the first
utterance of a session, because the modify branch needs a live agent and the
auto-start ran *after* the resolver. The agent got the raw text with none of the
option context attached. Hoisted the start above the resolver. The document was
never at risk (the safe path held), but the feature was quietly not working.

**Also**

- Only one proposal is live at a time. Two competing sets of cards would make
  "the second one" genuinely ambiguous and the resolver could not recover.
- A proposal with no grounding renders "no sources cited, treat with suspicion"
  in red rather than looking as trustworthy as a grounded one.
- Accepting tells the agent what was chosen, so it does not re-propose or work
  from a stale picture.

**Next: Phase 6, the retrieval pipeline.** `mcp-research.js` with
`corpus_search` and `db_query`, `sources.json` with the roots from PLAN.md 0.2,
and the `--agents` definitions for the sweep and drafting roles. The drafting
agent loads `WRITING_STYLE_JOSH.md` so options come back in the author's voice
rather than the generic academic prose the placeholder options in the tests use.
Phase 3 already proved the sandbox reaches subagents, so these can be ordinary
`Agent` subagents inside the one session.

---

## 2026-07-19 · Phase 6, the retrieval pipeline · DONE

**Shipped**

- `sources.json`. Seven roots with trust priorities and the exclusion globs,
  plus the two databases. The drop folder outranks everything.
- `engine/research.py`. A second persistent Python host: builds the corpus
  index, extracts .docx and .pdf, serves search and reads, and runs guarded SQL.
- `mcp-research.js`. `corpus_search`, `read_source`, `db_query`, `list_sources`.
  Read only by construction: there is no write path in the file at all.
- `agent.js` gained `loadVoice()` (loads `WRITING_STYLE_JOSH.md` into the system
  prompt) and two subagent definitions, `scout` and `numbers`, both read only.
- `DocHost` generalized to `PyHost` so the research sidecar gets the same
  supervision, restart, pid recording, and boot sweep as the document host.
- `test/test_research.js` (34) and `test/test_flow_live.js` (13, live).

**Measured**

| Thing | Value |
|---|---|
| Corpus indexed | **965 unique files, 7.25 M chars** |
| Duplicates collapsed | **445 of 1,414 scanned**, by content sha256 |
| Cold index | 13.4 s |
| Warm index (cached extractions) | **0.58 s** |
| Search across 965 files | **7 ms** |
| The NULL trap, measured live | naive 79.9% vs correct 37.6%, **2.12x inflation** |

Every one of those hazards was predicted by the groundwork survey and every one
turned out to be real at roughly the predicted magnitude.

**The guards are not advisory**

`db_query` refuses, with an explanation rather than a bare error: any COALESCE
or IFNULL on `trade_pass` (and tells you the correct expression), `SELECT * FROM
calls` (one column is 107.9 MB), and every write, ATTACH, PRAGMA, or non-SELECT.
It warns when a query on `calls` omits the status, benchmark_version, or
excluded_reason filters, and it attaches the pilot-scale caveat to every result.
A test demonstrates the trap arithmetically rather than just asserting the
refusal.

**A defect worth remembering: warnings did not survive caching**

The zero-text PDF check fired on the first index and then never again, because
later runs read the extracted text from cache and the warning was only produced
during extraction. A scanned PDF would be flagged once and silently forgotten,
which is worse than never flagging it: the problem looks fixed. Warnings are now
persisted next to the cache entry and re-emitted on cache hits. Verified on both
a cold and a fully cached run.

**The live flow failed first, for an instructive reason**

Asked "what did we actually find about how many tasks were determinate", the
agent did everything right substantively: searched the corpus, found
`qcb_audit/REPORT.md`, read it properly, and produced three grounded options
quoting "3/20 tasks (15.0%, Wilson 95% CI 5.2% to 36.0%)" with file and date.

Then it wrote them as **markdown in the chat message** instead of calling
`doc_propose`, which was offered to it and which it never touched.

That is a total failure of the feature despite perfect research: options in prose
cannot be clicked, cannot be chosen by saying "the second one", and cannot be
applied. Making the tool available was not enough; the prompt has to forbid the
natural alternative explicitly. The system prompt now opens that section with
"NEVER WRITE CANDIDATE WORDINGS INTO YOUR CHAT MESSAGE", says why (the human
cannot click prose), and lists the phrasings that all mean "call doc_propose".

On the rerun it proposed correctly, and the result is the whole point of the
project:

- It surfaced the determinacy **conflict** across three sources rather than
  averaging it: the interim draft (2026-07-12) predicting 1 of 20, the current
  draft (2026-07-17) saying 3 of 20, and it identified 3 of 20 as final with
  1 of 20 as the advisory prediction. That matches the settled resolution.
- It went further and flagged three defensible counts (3 of 20, 2 of 20, 3 of 19).
- Every option carried a file and a modification date.
- "the first one" then applied it locally with no model call.

**Notes for the next session**

- The corpus cache lives in `data/cache/`. It is keyed by path, mtime, and size,
  so an edited source re-extracts automatically. Deleting the folder is safe.
- `confdetails.pdf` (conference logistics, 3 pages) genuinely has no text layer.
  It is flagged on every index rather than silently returning nothing.
- The agent did not dispatch subagents for a single question, which is
  reasonable. The `scout` and `numbers` definitions are wired and the sandbox is
  known to reach them, but a multi-source question has not been exercised live.

**Next: Phase 7, voice.** AudioWorklet capture at 48 kHz downsampled to 16 kHz,
shipped to a Python sidecar over a WebSocket, Silero VAD for endpointing, and
faster-whisper on the GPU. `pip install faster-whisper` is the only new install
and needs no CUDA toolkit (ctranslate2 ships its own runtime). Budget about 2 GB
of weights against the verified 2.6 GB of headroom, and measure the latency,
which PLAN.md section 6 still lists as the largest unmeasured unknown.

---

## 2026-07-19 · Model toggle (asked for mid-build)

**Shipped**

A model button in the agent panel. Sonnet by default, click for Opus, click
again to go back. `/api/model`, persisted in state, shown in health.

**Two details that make it honest**

- Switching restarts the agent, because `--model` is a spawn flag. The new
  process is started with `--resume <sessionId>`, so **the conversation
  survives the swap**. If the resume fails the CLI starts fresh, which is
  degraded but not broken, so it is attempted rather than gated on.
- Switching **mid-turn is refused with a 409** rather than killing a turn in
  flight. Wait for it to finish, or interrupt first.

Sonnet is the default and the resting state; Opus is visually marked, since the
entire reason the toggle exists is spend.

`test/test_model.js`, 17 assertions including the UI round trip. One of them is
labelled `[weak, source-grep only]`: it checks the mid-turn guard exists in the
source rather than firing it, because driving the agent genuinely busy costs
tokens. It can fail if the guard is deleted but it does not prove the 409 fires.
Real coverage for that belongs in the live suite and is not there yet.

---

## 2026-07-19 · Phase 7, voice · MEASURED, not yet built

Split deliberately. The plan called STT latency "the single largest unknown in
the must-feel-smooth requirement", so it was measured before anything was built
on top of it.

**Installed:** `faster-whisper` 1.2.1 with `ctranslate2` 4.8.1, which sees the
GPU. The research claim held exactly: **no CUDA toolkit and no Visual Studio
build tools were needed**, because ctranslate2 ships its own CUDA runtime. This
was the thing that could have sunk local STT on a machine with no `nvcc`.

**Measured** with `test/bench_stt.py`, using edge-tts to synthesize sentences in
the vocabulary that will actually be spoken here (determinacy, QuantConnect,
LEAN, Wilson interval, saturate). General word error rates say nothing about
whether a model can hear "LEAN-Bench".

| model | median latency | weights | peak VRAM | key-term recall |
|---|---|---|---|---|
| small | **359 ms** | 702 MiB | 784 MiB | 90% |
| medium | 577 ms | 1,888 MiB | 1,992 MiB | 90% |

Real-time factor 0.05 to 0.13, so it is far from compute bound.

**Decision: `small`.** Medium costs 2.5x the VRAM and 60% more latency for
**identical** key-term recall on this vocabulary. It transcribed "QuantConnect",
"determinate", "semantic edge", and "saturates" no better. Against a verified
2.6 GB headroom budget, small leaves room to spare and medium does not.

Caveats recorded honestly:
- Synthetic speech is cleaner than a real microphone. Latency is compute bound
  so it will hold, but **accuracy will be worse in the room** and this needs
  re-measuring against the real mic once capture exists.
- The 90% recall is not a real error: both models wrote "20" where the sentence
  said "twenty", which the naive key-term check counts as a miss.
- Model load is 13.9 s (small) and 40.9 s (medium), so the model must be loaded
  once at startup and kept resident, never loaded per utterance.

**What Phase 7 still has to build:** AudioWorklet capture at 48 kHz downsampled
to 16 kHz, a WebSocket to ship PCM frames, Silero VAD for endpointing, and
`engine/stt.py` as a third PyHost holding the model resident. Budget ~800 MiB.
Add roughly 200 ms of silence detection to the numbers above for what the human
actually feels, so expect **half a second from stopping speaking to text**.

**Next turn: build Phase 7.** The measurement is done and the model is chosen,
so the remaining work is plumbing: capture, VAD, and the resident model host.

---

## 2026-07-19 · Phase 7, voice · DONE

**Shipped**

- `engine/stt.py`. Persistent speech host, model resident, started lazily on the
  first utterance rather than at boot.
- `public/mic-worklet.js`. Capture on the audio render thread, 48 kHz to 16 kHz
  by exact 3:1 box-filter decimation, plus a level signal.
- `public/mic.js`. Energy endpointing with an adaptive noise floor, pre-roll so
  the first word survives, Float32 to 16-bit PCM, one POST per utterance.
- `/api/stt`, `/api/stt/warm`, and a raw-body reader (the existing one parses
  JSON, which audio is not).
- Mic button that scales with your voice, `m` to toggle.
- `test/test_voice.js`, 21 assertions through a real browser microphone.

**The model choice was measured, not assumed**

Benchmarked four models on synthesized speech containing this project's jargon:

| model | VRAM | median latency | real time | WER |
|---|---|---|---|---|
| tiny.en | 241 MB | 136 ms | 36x | 5.0% |
| **small.en** | **729 MB** | **218 ms** | **23x** | **3.1%** |
| distil-large-v3 | 2145 MB | 340 ms | 15x | 3.1% |
| large-v3-turbo | 2281 MB | 345 ms | 14x | 3.1% |

small.en is the pick: **identical accuracy to models three times its size**, at a
third of their latency and under a third of the VRAM. It fits alongside a
resident 7B in Ollama inside the verified 2.6 GB of shared headroom, so voice
does not force a choice between capabilities.

**Measured end to end**

| Thing | Value |
|---|---|
| Model load, on demand | 1.4 s |
| 4.6 s utterance, raw path | 517 ms model, 524 ms round trip, 8.9x real time |
| Transcription accuracy, raw path | **WER 0.0%**, transcript exact |
| Browser path (fake mic) | 489 ms, WER 15.4% |
| Two seconds of silence | transcribes to nothing, no hallucination |

The browser-path WER is a test artifact: Chrome's fake device is already playing
when the worklet connects, so the first word is clipped. Pre-roll was raised
from 0.4 s to 0.7 s as real insurance against the same thing happening when a
person starts talking as they click.

**This closes PLAN.md's largest unmeasured unknown.** Section 6 listed STT
latency and accuracy on this machine as entirely unmeasured and the single
biggest risk to "must feel smooth". It is 500 ms and exact.

**Two things done deliberately**

1. **No streaming partials.** Whisper-family models are chunked pseudo-streaming
   with a structural latency floor near twice the chunk size, so partials would
   arrive late enough to distract rather than inform. One round trip per
   utterance, at 500 ms, is better than a stream of corrections.
2. **Dictation goes through the same path as typing.** The transcript lands in
   the bar and submits itself, so the resolver, the proposals, and the agent all
   behave identically whether you spoke or typed. "The second one" works by
   voice because it was never a voice feature.

**CUDA note worth keeping**

There is no CUDA toolkit on this machine and ctranslate2 needs cuDNN 9. torch
2.5.1+cu121 bundles the DLLs, so `stt.py` adds torch's lib directory to the
process before importing faster_whisper. Verified: without that shim the CUDA
backend fails to load and it silently falls back to CPU.

**Install performed:** `pip install faster-whisper` (pulled ctranslate2 4.8.1,
onnxruntime 1.27.0, av 18.0.0). No CUDA toolkit, no build tools, as predicted.

**Notes for the next session**

- The mic is push-to-open, not always-on. It stays listening across utterances
  until toggled off.
- Endpointing is energy based in the browser. faster-whisper additionally runs
  Silero VAD server side to trim silence before decoding, which is what stops
  it hallucinating into quiet.
- `small.en` is English only. Set SCRIBE_STT_MODEL to a multilingual size if
  that ever matters.

**Next: Phase 8, verify and polish.** The last phase. Drive the whole thing by
hand end to end with a real document, profile a burst of edits (never measured,
even in the deck project next door), add the loud health beacons, write the
README, and do a final screenshot pass in both themes.

---

## 2026-07-19 · Phase 7, voice · DONE

Note on provenance: a loop iteration built most of this and was interrupted
before it could record itself. This session found `engine/stt.py`,
`public/mic.js`, `public/mic-worklet.js`, the `SttHost` wiring, and
`test/test_voice.js` already on disk, read them rather than overwriting them,
verified them, fixed two defects, and is writing the entry that iteration owed.

**Shipped**

- `engine/stt.py`. A third PyHost holding one resident faster-whisper model,
  started lazily on the first utterance. Falls back to CPU rather than dying.
- `public/mic-worklet.js`. Capture on the audio render thread: 48 kHz to 16 kHz
  by exact 3:1 decimation, plus a level signal so the main thread never touches
  raw audio.
- `public/mic.js`. Energy endpointing with an adaptive noise floor, 400 ms of
  pre-roll so the first phoneme is not clipped, and Float32 to 16-bit PCM.
- Server: `/api/stt` (raw PCM in, WAV wrapped, transcript out), `/api/stt/warm`,
  and a `voice` SSE channel.
- `test/test_voice.js`, 22 assertions.

**Measured, end to end through a real browser**

| Thing | Value |
|---|---|
| Word error rate, full browser audio path | **7.7%** |
| Capture to transcript, 4.1 s utterance | **584 ms total**, 584 ms of it the model |
| Model load (cached weights) | **1.4 s**, not the 13.9 s of a cold download |
| Model | `small.en` on CUDA, 729 MB |

**The CUDA finding, which is load bearing**

ctranslate2 needs cuDNN 9 and this machine has no CUDA toolkit. torch
2.5.1+cu121 bundles the DLLs, so `stt.py` calls `os.add_dll_directory` on
torch's lib folder **before** importing faster_whisper. Verified: without that
shim the CUDA backend fails to load and it silently falls back to CPU. The
earlier Phase 7 benchmark happened to work without it; that was luck about
process-level DLL search order, not a guarantee.

**`small.en`, not `small`**

The English-only variant is both faster and more accurate here than the
multilingual `small` measured earlier: 218 ms versus 359 ms, and WER identical
to `distil-large-v3` and `large-v3-turbo` at a third of their VRAM. Recorded in
the docstring with the full table.

**Two defects fixed**

1. **The worklet flooded the main thread.** It posted a level message on every
   `process()` call, roughly 375 per second at 48 kHz, in an app whose entire
   premise is staying smooth. Coalesced to about 60 Hz, sending the loudest
   reading in each window rather than the most recent, because a peak picker
   that averages will miss the peak. Endpointing needs tens of milliseconds of
   resolution, not three.
2. **A flaky assertion, diagnosed rather than deleted.** "It reached the
   conversation as if typed" failed once by racing the DOM render. A separate
   probe proved the render path works, so the check now asks the **server**
   first (authoritative about whether the utterance became a message) and treats
   the DOM as a second, weaker question about rendering. Conflating the two made
   a timing wobble look like a broken feature.

**Design decisions, stated rather than assumed**

- **Endpoint then transcribe, not streaming partials.** Whisper-family models
  are chunked pseudo-streaming with a latency floor near twice the chunk size,
  so partials would arrive late enough to distract rather than inform. One round
  trip per utterance at 584 ms is better than a stream of stale guesses.
- **Energy VAD, not Silero.** Silero would need onnxruntime-web plus a model
  file, and the house rule is zero dependencies. The adaptive noise floor
  handles a quiet room with a headset. If a noisy room proves otherwise, Silero
  is the documented upgrade path. Note that `stt.py` already uses Silero
  server-side via `vad_filter=True`, which is what stops the model
  hallucinating text into silence.
- Speech goes through **exactly the same path as typing**: it lands in the bar
  and submits itself, so the resolver, the proposals, and the agent behave
  identically whether spoken or typed. Verified: a spoken sentence appears in
  the trail as a `said` entry, indistinguishable from a typed one.

**Honest gaps**

- All accuracy numbers are against synthesized speech played through Chrome's
  fake device. Cleaner than a real room. **The real microphone has still never
  been tested**, and it is the one thing that cannot be automated here.
- Whisper hallucinates stock phrases into silence; `vad_filter` handles the
  common case but a long silence may still produce a stray "Thank you."

**Next: Phase 8, verify and polish.** End to end on a real document, a perf
profile under a burst of edits (never measured, even in the deck project next
door), loud health beacons, and a README. Then the loop stops.

---

## 2026-07-19 · Phase 8, verify and polish · DONE

**Shipped**

- `test/test_perf.js`. The burst profile PLAN.md flagged as never measured, even
  in the deck project next door where it was raised as a risk and left alone.
- A **health beacon**. The server writes a timestamped file every 10 seconds
  naming its pid, its children, and the current revision, and reports on the
  previous run at boot. The browser watches its own event stream and, after 30
  seconds of silence, desaturates the whole page and says the server may have
  stopped.
- `README.md`, written for someone opening this in six months.
- The full suite wired into `npm test`.

**Measured under a burst of 40 edits**

| Thing | Value |
|---|---|
| Server throughput | **18.5 edits/second**, all 40 accepted |
| Edit events reaching the browser | **40 of 40**, none dropped |
| Full DOM rebuilds | **0** |
| Render passes | 35 for 40 edits, so events really are coalesced |
| Render time | **0.4 ms median, 1.2 ms worst** |
| Main-thread blocks over 100 ms | **0** |
| Undo after the burst | the whole 40-edit run reverts as one step |

The risk was never a crash. It was the UI quietly falling behind until the glow
stopped meaning "just now". It does not.

**Why the beacon exists**

Project memory records the suite next door being "found completely gone between
passes, zero crash trace". A process that dies silently is worse than one that
dies loudly, and for a voice app the first symptom is that talking stops doing
anything. Now the beacon file stops advancing and says exactly when, and the
page goes grey rather than looking healthy while attached to nothing.

**Two stale assertions found by running everything together**

1. `test_agent_live.js` still asserted six document tools. There have been seven
   since `doc_propose` landed in Phase 5. Fixed, and extended to assert the four
   research tools too.
2. `test_perf.js` counted the initial page build as a rebuild. Clearing the
   collected list was not enough: the next animation frame re-captured the stale
   `__lastRender`. Both are now cleared. Worth remembering as a general trap
   when sampling a "latest value" variable on a timer.

**A gap from Phase 6 closed by accident**

Phase 6 noted that the `scout` and `numbers` subagents were wired and the
sandbox was known to reach them, but that a genuinely multi-source question had
never been exercised live. This run, the flow test dispatched one:
`2 calls under 1 subagent(s)`, individually observable through
`parent_tool_use_id`, exactly as the Phase 3 probe predicted.

**Final state**

- **389 offline assertions** across 11 suites, all passing, no tokens.
- **47 live assertions** across 2 suites against a real agent, about $0.25.
- Nothing outside `scribe/` has ever been written. Every corpus file still
  carries its original modification date.

**Known limits, stated plainly**

- The **real microphone has never been tested**. Every voice number comes from
  synthesized speech through Chrome's fake device, which is cleaner than a room.
  This is the one thing here that cannot be automated.
- Accuracy on a noisy room is unknown. Energy VAD is the weak point, and Silero
  in the browser is the documented upgrade path.
- Whisper can still hallucinate a stray phrase into a long silence.
- The mid-turn model-switch refusal is covered only by a source grep, not by an
  exercised 409.
- The corpus index is built at boot and does not watch for changes. A file added
  mid-session is invisible until the next start or an explicit reindex.

**The loop stops here.** All eight phases are built and verified.

---

## 2026-07-19 · Predictive continuation sidecar · LIVE

**Shipped**

- Direct document typing arms a browser-local 60-second quiet timer. Opening
  Scribe, selecting a document, focusing the composer, or merely leaving the
  program open does not arm it.
- The one-shot continuation process uses the cheaper model for the selected
  provider: Sonnet when Claude is selected, Terra when Codex is selected. It is
  separate from both Watch and the editing agent.
- Its prompt includes the saved before-and-after change, nearby paragraphs,
  recent conversation, and an available Watch observation for the same
  paragraph. It can read and find but cannot write.
- The result appears as translucent ghost prose attached after the changed
  paragraph. Generation never changes the document. Insert is explicit and
  becomes one ordinary undo step; dismiss writes nothing.
- New typing cancels the timer or one-shot process, stale results cannot attach,
  and severely delayed browser timers are discarded.

**Verified**

- 651 token-free assertions pass across the full sandbox suite.
- Light and dark continuation treatments were rendered and visually checked.
- A compact attached drafting cue now makes the one-shot wait visible and gives
  the human a local cancel control. It disappears before the ghost paragraph,
  on resumed typing, or on any terminal result.
- The cancel control is verified through the server retirement path. Explicit
  paragraph styles are now authoritative, preventing a Normal continuation
  after a heading from inheriting direct heading-size or bold formatting.
- Active continuation jobs retain and display the model they actually started
  with across a main-picker switch. The old hidden Haiku request path is gone,
  so the server and interface now enforce the same four-model contract.
- Browser-heavy Watch coverage chooses a free sandbox port rather than
  colliding with an unrelated local process on its historical fixed port.
- The non-mutating live smoke confirms exact served assets, direct typing and
  Escape behavior, a completely idle predictive lane, and no active editing or
  Watch process.
- Live document remains revision 2 with 57 paragraphs and SHA-256
  `9943F3FE2A1F4A8D452129D13652D246B27A87326B5EC59D0F8B73F4E14739C4`.
- Live server restarted on PID 39360 and reopened the same document. Opus
  remains selected; editing, Watch, and prediction are all off.

---

## 2026-07-19 · Four-model automatic pool and live continuation recovery · LIVE

**Shipped**

- The editing picker remains the explicit full-power model choice. A compact
  `auto 4` control opens four independent Sonnet, Opus, Terra, and Sol
  availability switches for future Watch and Continue jobs.
- Enabling a model never starts a process. The selected editing model cannot be
  excluded until another is selected. Excluded models cannot be selected for
  editing, so the interface and server cannot disagree.
- Automatic routing is deterministic: cheaper enabled model in the selected
  provider, deeper peer, then an enabled model in the other provider. Each Watch
  review and continuation captures its model when created, so a later switch
  changes only future work.
- Pool state persists across a restart and is included in health, agent, and
  event-stream snapshots. The panel states the exact next Watch and Continue
  routes.
- The pool is a restrained translucent overlay with soft cyan lines. It escapes
  the intentionally clipped work surface, remains inside the viewport, and
  leaves the resting agent row compact.

**Live recovery**

- A user report that suggestions were missing revealed a frontend selector
  exception in the new pool click-away guard. The document kept saving and a
  Terra continuation completed, but its card did not appear in the live tab.
- The selector is repaired. The persisted continuation is now included in the
  reconnect snapshot and verified as an attached, non-editable card in a fresh
  live browser.
- The non-mutating smoke now accepts an existing open continuation as idle user
  state, verifies that it is visible, and preserves it byte for byte. It no
  longer mistakes a completed suggestion for a running model or dismisses it
  while testing direct typing.

**Verified**

- 672 token-free assertions pass across the full sandbox suite.
- Model availability coverage exercises selected-model refusal, fifth-model
  refusal, provider fallback, future-job-only routing, restart persistence,
  browser switches, and zero-start behavior.
- Watch and Continue coverage proves Terra-to-Sol fallback while leaving the
  editing agent untouched.
- Light and dark pool renders were visually checked. The exact live assets are
  smoke-tested against disk.
- Live Scribe restarted on PID 41944 with the same document bytes, revision 7,
  57 paragraphs, and SHA-256
  `46D412B68DDEEDBAB38E5EA5E8F3269355C823F5F32997257B50619E46EDB116`.
  Terra remains selected, all four models are enabled, Watch is off, and no
  editing, Watch, or prediction process is running.

---

## 2026-07-19 · Suggestion terminal-state repair · LIVE

**Bug fixes**

- Continue no longer disappears without explanation when the model returns no
  safe paragraph or an unusable result. A short local status is attached after
  the exact source paragraph and can be dismissed without writing or starting
  anything.
- A failed or timed-out Watch review now leaves the same restrained explanation
  before the exact paragraph. Ordinary successful reviews that have nothing
  useful to add remain quiet.
- Fresh typing clears an old terminal status before it arms the next job.
  Turning Watch off and every new or cancelled lane event also clear stale
  status, so an old failure cannot look current.
- These status rows are browser-local, non-editable, and use the existing soft
  neon sidecar treatment. They do not change persistence, model routing, or the
  editing agent lifecycle.

**Verified**

- 680 token-free assertions pass across the complete sandbox suite.
- Browser coverage exercises Continue no-result and invalid-result paths, Watch
  timeout attachment, exact paragraph placement, dismissal, new-typing cleanup,
  zero document writes, zero unintended model starts, and console safety.
- Light and dark terminal states were rendered and visually checked.
- The final non-mutating live smoke passed against the exact served assets. The
  document remains revision 7 with 57 paragraphs and SHA-256
  `46D412B68DDEEDBAB38E5EA5E8F3269355C823F5F32997257B50619E46EDB116`.
  Watch, editing, and prediction processes are stopped; the user's open Terra
  continuation remains unchanged and visible.

---

## 2026-07-19 · Predictive request transport repair · LIVE

**Bug fix**

- The one-minute Continue lane no longer fails silently if its initial browser
  request cannot reach Scribe. The exact source paragraph now receives the same
  compact, dismissible error treatment as a later model failure.
- The rejected capture and its one-use typing grant are retired locally and
  best-effort revoked. A response-loss race remains safe: if the server already
  accepted the job and its live event arrived, that live job owns the interface
  instead of being replaced by a false failure.
- The repair adds no mode, model call, document write, or editing-agent action.

**Verified**

- A browser-level fetch interruption reproduced the prior blank outcome before
  the repair and passes after it.
- 682 token-free assertions pass across the complete sandbox suite.
- The exact served frontend passes the non-mutating live smoke. Revision 7,
  57 paragraphs, the document hash, and the open Terra continuation are all
  preserved; Watch and every model process remain off.

---

## 2026-07-19 · Continuation Insert refusal repair · LIVE

**Bug fix**

- A refused continuation Insert no longer communicates only through a border
  color and hover title. The existing card now says `not inserted` with the
  server's reason, remains present, and immediately enables retry.
- Beginning a retry clears the old error. An empty or malformed response is
  treated as an unconfirmed insert instead of leaving the button disabled
  forever.
- The failure path changes no document state and starts no model process.

**Verified**

- Browser coverage pauses editing, attempts Insert, verifies the visible
  refusal and unchanged revision/paragraph count, resumes, retries, and proves
  the suggestion inserts exactly once as one ordinary undo step.
- The compact warm error line was rendered and visually checked in light and
  dark modes; the suggestion remains readable and the document stays dominant.
- 684 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the document hash, and the open Terra continuation preserved.

---

## 2026-07-19 · Continuation dismiss transport repair · LIVE

**Bug fix**

- Continuation dismiss no longer sends an unobserved, fire-and-forget request.
  An interrupted request keeps the card, says `not dismissed`, and immediately
  enables retry instead of producing a blank non-action.
- The rejection is handled inside the click path, eliminating the prior
  unhandled promise rejection and console error.
- A confirmed HTTP response can retire the exact old card if its live event was
  lost, while an id check prevents that fallback from clearing a newer
  continuation.

**Verified**

- Browser fetch interruption coverage proves the card stays retryable, the
  error is visible and accessible, and no console rejection or uncaught
  exception escapes.
- 686 token-free assertions pass across the complete sandbox suite.
- The existing compact warm action-status treatment covers this failure, and
  its light/dark render was already checked in the preceding cycle.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the document hash, and the open Terra continuation preserved.

---

## 2026-07-19 · Watch-note dismiss transport repair · LIVE

**Bug fix**

- Watch-note dismiss no longer uses an unobserved request. If transport fails,
  the note stays attached, says `not dismissed`, and immediately enables retry.
- The click handler contains the rejection, removing the prior uncaught promise
  error from the page and console.
- A confirmed response may retire only the exact note that was clicked if its
  live event was lost; it cannot clear a newer Watch note.

**Verified**

- Browser fetch interruption coverage proves the note, paragraph treatment,
  retry control, accessible status, and model isolation remain intact without
  an uncaught error.
- The exact state was rendered and visually checked in light and dark modes.
  The cyan glass card keeps one restrained warm edge and a single short status
  line, leaving the document visually dominant.
- 688 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the document hash, and the open Terra continuation preserved.

---

## 2026-07-19 · Sidecar event-order repair · LIVE

**Bug fix**

- A late terminal event for an older Watch note or continuation can no longer
  remove the newer card from the document while leaving newer internal state
  stranded.
- Terminal cleanup now clears pending state, open state, and visible markup only
  when the event's exact sidecar id matches. An explicit null reset still clears
  the whole lane.
- Reconnect snapshots also compare existing sidecar timestamps. An older open
  snapshot arriving after a newer live event is ignored instead of replacing
  the current card.

**Verified**

- Deterministic browser race coverage renders a newer card, delivers both an
  older open snapshot and older terminal event, and proves the newer DOM and
  state survive for both Watch and Continue.
- 690 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the document hash, and the open Terra continuation preserved.

---

## 2026-07-19 · Active-sidecar stale-failure repair · LIVE

**Bug fix**

- A late failure from an older predictive job can no longer paint an error over
  a newer continuation that is actively drafting.
- A late Watch failure or timeout can no longer cover a paragraph that is
  already represented by a newer review.
- Stale jobs still retire their own bookkeeping, while the newer job marker,
  card, and state stay intact.

**Verified**

- Deterministic browser race coverage starts newer Watch and Continue work,
  delivers each older failure afterward, and proves that no stale error appears
  and the current work remains active.
- 692 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the unchanged document hash, and the open Terra continuation
  preserved.

---

## 2026-07-19 · Model-control transport recovery · LIVE

**Bug fix**

- Losing the server connection during an editing-model change no longer leaves
  the picker disabled on a model the server never accepted. It returns to the
  prior authoritative model and explains that nothing changed.
- Losing the connection during an automatic-pool toggle no longer strands that
  switch in a disabled state. The unchanged pool is redrawn immediately and
  remains retryable.
- Both async handlers now contain their transport rejection instead of emitting
  an unhandled browser error.

**Verified**

- Deterministic browser fault injection interrupts each endpoint and proves the
  control is restored, the server state is unchanged, a concise explanation is
  visible, and no uncaught error escapes.
- 696 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the unchanged document hash, every model lane idle, and the
  open Terra continuation preserved.

---

## 2026-07-19 · Transactional Watch consent repair · LIVE

**Bug fix**

- Turning Watch off now commits locally only after the server acknowledges the
  consent change. A lost request can no longer make the browser claim Watch is
  off while server-side screening consent remains on.
- Failed disablement preserves the captured change set, its paragraph marker,
  quiet-window state, and persisted on-state so the user can retry safely.
- The Watch control remains on with an explicit failure explanation; successful
  disablement still clears every capture, review marker, and reviewer job.
- Persisted opt-in is restored before the event stream connects, preventing a
  stale reconnect reassertion from queuing an accidental off-state behind it.

**Verified**

- Deterministic browser fault injection drops the Watch consent request and
  proves the browser and server remain aligned, the pending batch survives, and
  no unhandled error escapes.
- 698 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the unchanged document hash, Watch off, every model lane idle,
  and the open Terra continuation preserved.

---

## 2026-07-19 · Undo request safety repair · LIVE

**Bug fix**

- The visible Undo control now permits only one in-flight operation. Rapid
  clicks can no longer submit multiple requests and unexpectedly undo multiple
  editing steps.
- The control is restored after every outcome. A server refusal or dropped
  connection produces a compact `undo failed` revision status with the exact
  reason instead of an unhandled browser error.
- The repair uses the existing top-bar status treatment and adds no new visual
  surface or model activity.

**Verified**

- Deterministic browser fault injection holds one Undo request open, double
  clicks the control, and proves only one request leaves the page. A separate
  transport rejection proves the control becomes retryable and the failure is
  visible without an uncaught exception.
- 701 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the unchanged document hash, Watch off, every model lane idle,
  and the open Terra continuation preserved.

---

## 2026-07-19 · Pause/Resume request safety repair · LIVE

**Bug fix**

- Pause/Resume now owns exactly one in-flight transition, preventing repeated
  clicks or a held space shortcut from submitting duplicate requests.
- A successful HTTP acknowledgement now reconciles the editor even if its live
  event was missed. Conversely, an already-arrived matching live event confirms
  success when the HTTP response itself is lost.
- A genuinely unconfirmed transition leaves the prior editor state intact,
  restores the control, and displays a compact `pause failed` or `resume failed`
  status instead of emitting an unhandled browser error.

**Verified**

- Deterministic browser fault injection holds Pause open through repeated
  activation, returns a success without SSE, and separately rejects transport.
  The tests prove one request, honest state, visible failure, and immediate
  retryability without uncaught errors.
- 705 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the unchanged document hash, Watch off, every model lane idle,
  and the open Terra continuation preserved.

---

## 2026-07-19 · Proposal acceptance safety repair · LIVE

**Bug fix**

- Proposal choices now share one in-flight acceptance guard across buttons and
  keyboard shortcuts. Rapid activation can no longer submit multiple document
  operations.
- While acceptance is pending, all competing choices and dismissal are briefly
  locked. A matching terminal live event still confirms success if the HTTP
  response is lost.
- A genuinely failed request keeps the exact proposal and anchor intact,
  restores every action, and places one restrained warm explanation in the
  existing intent line instead of emitting an unhandled browser error.

**Verified**

- Deterministic browser fault injection holds an option request open, activates
  it twice, and then drops transport. The tests prove one mutation request,
  visible retryable failure, preserved card state, and no uncaught exception.
- 708 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the unchanged document hash, Watch off, every model lane idle,
  and the open Terra continuation preserved.

---

## 2026-07-19 · Proposal dismissal safety repair · LIVE

**Bug fix**

- `none of these` now shares the proposal card's one-request guard. Rapid
  clicks can no longer send duplicate dismissals or race an option acceptance.
- Confirmed dismissal retires the card from the HTTP response even if its live
  event is missed. A matching terminal event still wins when the response is
  lost.
- A genuine failure leaves the card and document anchor intact, restores every
  action, and explains `not dismissed` inline without an unhandled error.
- Fresh proposals explicitly reset the prior card's disabled controls, fixing a
  lifecycle regression in which the next dismiss button could remain locked.

**Verified**

- Deterministic browser fault injection holds dismissal open, activates it
  twice, and rejects transport. The tests prove one request, preserved card and
  anchor, restored actions, visible failure, and no uncaught exception.
- 711 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 7,
  57 paragraphs, the unchanged document hash, Watch off, every model lane idle,
  and the open Terra continuation preserved.

---

## 2026-07-19 · Editing-agent Stop request safety repair · LIVE

**Bug fix**

- Stop now owns one in-flight request, so repeated clicks cannot race duplicate
  process termination calls.
- A confirmed HTTP response retires the visible lane even if its live exit
  event was lost. Conversely, an already-arrived exit event remains
  authoritative when the HTTP response is lost.
- A genuinely failed Stop leaves the still-running process visible,
  controllable, and immediately retryable with one concise explanation.
- Start and exit events reset lane readiness explicitly, preventing a retired
  session from leaving a replacement process falsely marked ready.

**Verified**

- Four deterministic browser fault cases cover duplicate activation, missing
  exit events, lost HTTP responses, and rejected transport without an uncaught
  browser error.
- 715 token-free assertions pass across the complete sandbox suite.
- The final exact live smoke below also covers this repair on the served build.

---

## 2026-07-19 · Codex MCP access and automatic-lane recovery · LIVE

**Bug fix**

- The “user rejected tool call” message was traced to Scribe, not the user or
  the Sol model. Codex app-server sent
  `mcpServer/elicitation/request`, while Scribe's client returned JSON-RPC
  `method not found`.
- Scribe's role-scoped loopback document and research MCP servers now use
  Codex's headless `approve` mode. Their exact enabled-tool lists remain
  unchanged: editing gets guarded document operations, Watch gets read/find
  plus attach-note, and Continue gets read/find only.
- Shell, browser, personal connectors, and unrestricted file editing remain
  disabled. Parent-folder material is available through the existing guarded,
  read-only `Presentation/` corpus in `sources.json`.
- Any unexpected downstream elicitation now receives the protocol-valid
  fail-closed cancellation response instead of a misleading method error.
- The live smoke browser now seeds and preserves the human's current Watch
  choice before connecting, so verification cannot silently turn an armed
  Watch session off.

**Verified**

- Codex adapter coverage proves both owned MCP servers are pre-approved and
  unexpected server requests are cancelled safely.
- The complete Watch browser suite passes 52 checks and the Continue suite
  passes 48, including off-state gating, one-minute generation with Watch off,
  cancellation, retries, provider routing, and zero browser exceptions.
- A bounded subscription-backed Terra probe made one real turn, successfully
  called both `doc_read` and `research.list_sources`, made no write call, and
  left its isolated `.docx` byte-identical. Terra-to-Sol resume then reused the
  same Codex thread without a second turn: 14 checks passed.
- 717 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 11,
  57 paragraphs, SHA-256
  `f1ee1893b4eca55846113744a6a9b70b980369c3307bb05c0d9df1bf38ce3aae`,
  Watch still armed, the open Terra continuation preserved, and every model
  process idle.

---

## 2026-07-20 · Full robustness, recovery, and current-content pass

**Repairs**

- Document mutations now preserve authored run/property shells, reject empty or
  ambiguous targets atomically, keep paragraph identities unique for the whole
  session, validate every formatting scalar, treat identical replacements as
  no-ops, bound regex execution, and reject corrupt, encrypted, duplicate-part,
  oversized, or unsafe-expansion DOCX packages before parsing.
- The server now serializes every document write, puts reads behind the existing
  write barrier, restores exact pre-edit bytes after mutation/save/pause
  failures, commits checkpoints only after a successful save, and revalidates
  the active document and undo snapshot immediately before use.
- Active documents, uploads, restored checkpoints, and static assets are
  constrained by both lexical and canonical paths. Junction, symlink, hard-link,
  directory, missing-file, and outside-root cases fail closed; hostile restored
  checkpoint paths are discarded without touching their targets.
- Python, MCP, agent, and coordinator protocols now bound frames, bodies,
  response parsing, timers, and child-process failure paths. Malformed or
  oversized child output retires and recovers the host instead of hanging a
  request or escaping as an unhandled runtime error.
- Browser requests and event queues are bounded. Structural refreshes preserve
  unsaved typing, stale-hash conflicts never blind-overwrite a paragraph,
  Say/Undo tolerate lost acknowledgements, proposal snapshots are reconnect
  ordered, model/SSE payloads are validated, and microphone requests are
  cancellable and delivered in capture order without overwriting a manual
  composer draft.

**New regression coverage**

- `test_current_content.py` locks the active document, archive, checkpoint,
  continuation-anchor, empty-run, formatting-shell, no-op, and paragraph-id
  invariants without mutating live content.
- `test_docmodel_fuzz.py` performs deterministic Unicode, multi-run, empty-run,
  special-run, ID-lifetime, atomic-refusal, round-trip, and package-expansion
  probes against generated DOCX files.
- `test_python_hosts.py`, `test_orchestration_robustness.js`,
  `test_mcp_transport.js`, and `test_runtime_boundaries.js` cover malformed
  protocol input, bounded regex/SQL/STT output, process races, role isolation,
  absolute deadlines, rollback/restart recovery, hostile paths, and fatal
  shutdown behavior.
- Browser suites now inject stalled headers and bodies, lost HTTP
  acknowledgements, delayed SSE snapshots, overlapping speech requests,
  structural refreshes during typing, stale hashes, rapid duplicate actions,
  and transport failures.

**Verified**

- The complete 909-check deterministic suite passed twice consecutively after
  the final changes. JavaScript syntax checks passed for all 39 source and test
  files.
- Focused results include 90/90 server transactions, 41/41 runtime boundaries,
  97/97 viewer, 74/74 agent lane, 56/56 Watch, 50/50 Continue, 48/48 proposals,
  51/51 model controls, 31/31 voice, and 14/14 performance checks.
- The final non-mutating live smoke passed against the already-running server:
  revision 11, 57 paragraphs, served assets exact, Watch consent preserved,
  continuation preserved, and all model lanes idle.
- The active `McNair New Draft.docx` remained byte-identical at SHA-256
  `f1ee1893b4eca55846113744a6a9b70b980369c3307bb05c0d9df1bf38ce3aae`;
  revision 11, 11 checkpoints, and 2 continuations were unchanged. No test
  process or temporary test directory remained.

---

## 2026-07-20 · Fresh-browser Watch consent repair · LIVE

**Bug fix**

- A browser with no saved Watch preference no longer assumes `off` and posts
  that guess when its event stream opens. That path could silently disarm an
  already-armed live session merely because another browser or test profile
  connected.
- A fresh profile now reads and adopts the server's current consent before
  connecting. Browsers with an explicit saved on/off choice still reassert that
  choice after a local server reconnect.
- Consent hydration changes no document state and starts neither the Watch
  reviewer nor the editing agent.

**Verified**

- A deterministic two-browser regression arms Watch in one profile, opens a
  completely fresh profile, and proves that both the server and new toggle
  remain armed while every model process stays stopped.
- The Watch browser suite passes 54 checks and the adjacent Continue suite
  passes 48 with zero browser exceptions.
- 719 token-free assertions pass across the complete sandbox suite.
- The exact served assets pass the non-mutating live smoke with revision 11,
  57 paragraphs, SHA-256
  `f1ee1893b4eca55846113744a6a9b70b980369c3307bb05c0d9df1bf38ce3aae`,
  Watch still armed, the open Terra continuation preserved, and every model
  process idle.

---

## 2026-07-20 · Robustness pass final verification

- This supersedes the earlier 719-check snapshot: the expanded deterministic
  suite now contains 909 checks and passed twice consecutively.
- The exact served assets passed the non-mutating live smoke; the browser's
  current Watch choice was preserved and every model lane remained idle.
- The active document remains at revision 11 with 11 checkpoints,
  2 continuations, and SHA-256
  `f1ee1893b4eca55846113744a6a9b70b980369c3307bb05c0d9df1bf38ce3aae`.
- No temporary test directory or test process remains.
