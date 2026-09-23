# Scribe

A local studio where you talk to one CLI-backed agent and watch it edit your paper,
step by step, at the granularity of a single phrase.

Status: COMPLETE. All 8 phases built and verified, 2026-07-19.
389 offline assertions across 11 suites, plus 47 live against a real agent.
Plan written 2026-07-19. Every claim marked VERIFIED below was measured on this
machine today, not taken from documentation.

---

## 0. What this is

One chat bar. One document. One agent.

You speak or type. The agent works on the paper. You see every tool call it is
about to make while it is still typing the arguments, you see the edit land in
the document with the changed phrase lit up, and you see a running trail of what
it just did. You can talk over it at any moment and it adjusts without dying.
When you ask a question that is not an edit instruction, a research subagent
goes and answers it from the databases and the evidence tree, in a side panel,
without disturbing the edit in progress.

Non-goals: a Word replacement, a human word processor, multi-user editing, a
general chat app. Scribe is an instrument for watching an agent write.

### 0.1 The grounded drafting flow

This is the headline capability, not a side feature. The shape of it:

```
you    "I want to say we did this and that, but what did we actually do?"
         |
scribe  dispatches a retrieval pipeline across drafts, the research tree,
        and the databases. You watch the subagent lanes light up.
         |
scribe  "Here is what the evidence says, with sources. Three ways to put it:"
        [A] tight, one sentence          <- shown on screen as cards
        [B] fuller, names the numbers
        [C] hedged, flags the caveat
         |
you    "let's say B but drop the second clause"
         |
scribe  writes it into the paragraph, glows the changed span, and the trail
        records what changed and why
```

Four properties this flow must have, each of which drives a design decision:

1. **Grounded, never invented.** Every option carries provenance: which file,
   which paragraph, which query, and the file's mtime. The survey found the
   determinacy count stated two different ways across drafts (3 of 20 versus
   1 of 20), so an ungrounded answer will confidently resurrect a settled
   error. Sources are not decoration here, they are the safety mechanism.
2. **Options are first-class objects, not chat text.** They live in the model
   with ids, they render as cards, and they can be accepted by voice ("the
   second one", "B but shorter"). A phrasing buried in a paragraph of chat
   cannot be tracked visually, which is the whole point.
3. **Options are written in the author's voice.** `WRITING_STYLE_JOSH.md` is
   loaded into the drafting agent's system prompt. Zero em dashes, zero
   semicolons, bare "and"-chains, digits, fractions. Generic academic prose is
   a failure, not a neutral default.
4. **Proposing is not editing.** An option on screen has not touched the .docx.
   Only an explicit acceptance writes. This is the one place the "live edit"
   decision is deliberately softened, because the human is choosing between
   alternatives rather than directing a single change.

### 0.2 What Scribe can read

Read only, always. Nothing outside `scribe/` is ever written.

| Source | Path | Notes |
|---|---|---|
| Your drop folder | `scribe/drafts/` | put anything here, it is searched first and trusted most |
| The open document | whatever you picked | searched as itself |
| Sibling drafts and notes | `Presentation/*.{docx,md,pdf}` | the McNair drafts, style guide, audit reports |
| The evidence tree | `7.1 Research/` | 9,740 real files after exclusions, ~4.5 M tokens |
| The databases | `leanbench.db`, `results.db` | opened `mode=ro`, with the NULL-trap guards of section 1.9 |

Roots live in `scribe/sources.json` so they can be changed without touching
code. Every root carries an exclusion glob list, because the raw tree is ~95%
noise (node_modules, .venv, vendored LEAN source, market data, 2,984 JSON files
holding 565 M chars of backtest output).

### Constraints taken as given

Decided by the human on 2026-07-19:

| Decision | Choice |
|---|---|
| Layering | Steer mid-run, plus side-channel research subagents. No separate local echo layer, no rollback layer in v1. |
| Voice | Local GPU speech to text, agent replies in text only. No text to speech. |
| Edits | Live edit with instant visual diff. Not tracked changes, not approve-first. |
| Target document | Any .docx, via a file picker. No hardcoded paper. |
| Folder | `Presentation/scribe/`. Nothing outside it is modified, ever. |

---

## 1. Ground truth

Everything in this section was measured. Numbers here are load bearing, and the
implementation should fail loudly if reality stops matching them.

### 1.1 The agent runtime is fully observable (VERIFIED by probe)

`claude.exe` in `--output-format stream-json --input-format stream-json
--include-partial-messages` mode emits, in order, everything Scribe needs:

| Event | Carries | Used for |
|---|---|---|
| `system/init` | session_id, tools, agents, mcp_servers, permissionMode | boot handshake, sanity check |
| `system/status` | `requesting` | "thinking" spinner |
| `system/thinking_tokens` | running estimate, delta | live thinking meter |
| `stream_event / message_start` | **`ttft_ms`** | latency readout |
| `stream_event / content_block_start` | `tool_use` with id and name, input `{}` | announce the call before it runs |
| `stream_event / content_block_delta` | `input_json_delta.partial_json` | **render the pending edit as the agent types its arguments** |
| `stream_event / content_block_delta` | `text_delta`, `thinking_delta` | streaming prose and reasoning |
| `assistant` | complete `tool_use` block with final input | commit the call to the timeline |
| `user` | `tool_result` plus a structured `tool_use_result` field | result, correlated by `tool_use_id` |
| `result/success` | duration_ms, ttft_ms, num_turns, total_cost_usd, usage, permission_denials | end of turn readout |

Correlation is by `tool_use.id`, present on both the call and the result.

### 1.2 Mid-turn steering works (VERIFIED by probe)

A second user message written to stdin 2.5 s into a running turn was accepted,
and was replayed back on stdout with `isReplay: true` at the next turn boundary
(right after the in-flight tool call resolved), starting a fresh turn. The
session was never killed.

This is exactly the layering semantic: you talk while it works, it picks you up
at the next safe point. `--replay-user-messages` is what makes delivery
observable, so the UI can show queued vs delivered honestly instead of guessing.

For a hard stop there is a control frame,
`{type:'control_request', request_id, request:{subtype:'interrupt'}}`, already
proven in the deck suite at `suite/agents.js:274-283`. Research flags its sharp
edge: an interrupted turn still emits its own `result` with
`subtype='error_during_execution'`, which must be drained or the next turn's
output gets mis-attributed.

### 1.3 Subagents are individually observable (VERIFIED by probe)

Every event carries `parent_tool_use_id`. Main-agent calls carry `null`.
A subagent's calls carry the id of the `Agent` tool_use that spawned it. Probe
output, verbatim:

```
[ 10222ms] CALL   Agent                  id=toolu_01WjmiNd…  parent=null
[ 11996ms] CALL   mcp__doc__doc_outline  parent_tool_use_id=toolu_01WjmiNd…
[ 12846ms] CALL   mcp__doc__doc_replace  parent=null          <- main agent, concurrently
[ 14580ms] CALL   mcp__doc__doc_outline  parent_tool_use_id=toolu_01WjmiNd…
```

Two facts fall out, and both shape the UI:

1. Subagents run **concurrently** with the main agent, not sequentially. The
   timeline must be lanes, not a list.
2. Token-level streaming from subagents is NOT available. `stream_event` is
   main-session only, always `parent_tool_use_id: null`. Subagent lanes render
   from complete messages, so they update per tool call, not per token. Do not
   promise a streaming subagent view.

Naming trap, confirmed by probe and by research: the tool renamed `Task` to
`Agent` in CLI v2.1.63 and current builds are internally inconsistent. The
`tool_use` block says `Agent`, the `system/init` tools list says `Task`.
**Match both strings.**

### 1.4 Custom document tools work as MCP (VERIFIED by probe)

A 130-line dependency-free stdio MCP server was accepted
(`mcp_servers: [{"name":"doc","status":"connected"}]`), its tools appeared as
`mcp__doc__doc_outline` and `mcp__doc__doc_replace`, and the agent called them
and consumed their results, including an error path.

This is the architectural keystone. The agent never gets `Edit` or `Write` on
the .docx. It gets a **semantic document op vocabulary**, so every action it
takes is already a meaningful, renderable, undoable document operation rather
than a byte range that we would have to reverse engineer.

Observed cost: the agent spends one extra round trip on `ToolSearch` with
`select:` before first use, because MCP tools are deferred. Roughly 1.5 s, once
per session. Mitigation is to name the tools explicitly in the system prompt so
that one lookup is a single batched `select:`, which is what it already did.
Keep the tool count small.

### 1.5 Windows spawn hazards (VERIFIED the hard way)

- Spawning with `shell: true` **destroys JSON arguments**. `--mcp-config` with
  inline JSON arrived at the CLI as a mangled path and the process died. Spawn
  `claude.exe` **directly with `shell: false`**. The npm `claude` shim resolves
  to a real native binary at
  `AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
- Pass MCP config as a **file path**, never inline JSON.
- Hard-killing a parent orphans its children every time. Node's `kill()` is
  `TerminateProcess`, so no cleanup runs. The only mitigation that works is
  record-pids-then-sweep-at-next-boot, inside the `listen()` callback.
- Kill by recorded PID only. A blanket `taskkill /IM claude.exe` would murder
  the human's VS Code and terminal sessions.

### 1.6 The document problem (VERIFIED against the real corpus)

Measured on `LEAN-Bench_McNair_2026.docx`: 333 paragraphs, 129,033 body chars,
**405 runs**, 27 multi-run paragraphs, worst case 13 runs in one paragraph, 10
paragraphs with a run boundary mid-sentence, plus colored audit markup
(`0033CC` blue, `008000` green, pink highlight) carried at run level.

Correction, found in Phase 0: the survey reported 404 runs. The true count is
405. The 404 figure was counting `w:t` elements, and **exactly one run holds a
bare `w:br` with no text at all**. That run is unmodifiable by concatenation,
which is precisely why the engine refuses to rebuild any run holding non-text
children rather than silently eating the line break.

Three things break the naive approach:

1. `paragraph.text = "new"` in python-docx **clears every run** and writes one
   bare run. On paragraph 221 that collapses 13 runs to 1 and silently destroys
   the entire colored markup pass. This setter is banned in Scribe.
2. The target phrase frequently exists in **no single run**. Citations and
   highlighted clauses are their own runs inside one sentence. A
   `run.text.replace()` loop finds nothing.
3. Paragraphs 0 through 4 have **zero runs**. `paragraph.runs[0]` crashes.
4. `Document.paragraphs` **excludes table cells**, hiding up to 213 paragraphs
   in sibling drafts including the per-prompt verdict table. Walk
   `document.element.body` and recurse tables.

The corpus currently averages close to 1.00 runs per paragraph in three of four
files only because nobody has opened them in Word. The first time Word touches
a file, it splits runs at edit boundaries and stamps rsids. **Build run-aware
from day one. The fragmented file is the target, not the exception.**

### 1.7 Both hard problems are solved (VERIFIED)

**Stable paragraph identity.** OOXML has a native mechanism, `w14:paraId`, an
8-hex-digit per-paragraph id that Word itself maintains. The corpus has zero of
them (python-docx generated). Stamping all 333 and reloading:

```
RELOAD: 333 paragraphs, 333 carry w14:paraId, 333 unique
SIZE: 85,979 -> 89,319 bytes  (+3.9%)
```

This answers the identity-across-insert-and-delete question that nothing in the
deck suite solved. Ids are stamped once on open and are never index derived.

**Run-preserving replace.** A run-splitting algorithm applied to the worst
paragraph in the corpus, replacing a phrase that straddles a run boundary:

```
target paragraph 221: 13 runs, 8 with rPr
cross-run phrase: 'to 36.0%). Every diverg'
replace ok: True
after: 13 runs, 8 with rPr
```

Run count and formatting count both unchanged. The colored markup survives.
The algorithm is in `scratchpad/paraid_test.py` and ports directly.

### 1.8 Local compute (VERIFIED)

- CUDA works. torch 2.5.1+cu121 sees the RTX 4070 Laptop, 8188 MiB.
- **Ollama 0.32.1 is already installed and running** on 127.0.0.1:11434 with
  `qwen2.5:7b-instruct` (46 tok/s) and `nomic-embed-text` (60 ms embeddings).
- ffmpeg 8.0.1 is on PATH. Mic is `Microphone Array (Realtek(R) Audio)`.
- Real simultaneous headroom is **2.6 GB**, measured with a committed tensor.
  `torch.cuda.mem_get_info()` lies on this machine (reported 7 GB free when
  nvidia-smi said 2.6 GB). Always size from nvidia-smi. `torch.empty()` does
  not commit VRAM, so ceiling tests must `.fill_()` and `synchronize()`.
- No CUDA toolkit and no `nvcc`. Anything needing to compile CUDA is out.
  `faster-whisper` is fine: ctranslate2 ships its own CUDA runtime.
- Ollama's default `keep_alive` ages models out after ~30 min, costing an
  **18 s cold reload**. Set `keep_alive: -1` and pre-warm several times, because
  the first "warm" embedding call spiked to 8.7 s before settling to 60 ms.
- `getUserMedia` works on `http://127.0.0.1` with no TLS. It does **not** work
  on a LAN IP. If the server is ever rebound off loopback, voice dies silently.

### 1.9 The research substrate (VERIFIED)

`leanbench.db`, 111.8 MB, but **96.5% of it is one column**
(`calls.lean_results_json`, 107.9 MB). Never `SELECT *` from `calls`.

The NULL trap is confirmed and is stronger than previously recorded.
`trade_pass` is non-NULL only where `compile_pass=1 AND backtest_pass=1`. NULL
unambiguously means "gate never reached", never "failed". Naive
`COALESCE(trade_pass,0)` reports a 79.9% failure rate against a true 37.7%,
an inflation of **2.12x** (prior memory said 2.3x; correct the memory).

Every query the research subagent issues must carry the mandatory filter:

```sql
WHERE status='completed' AND excluded_reason IS NULL
  AND benchmark_version='LEAN-Bench-v2.0'   -- never pool v1.0 and v2.0
```

because `status` has four values (`completed` 192, `started` 54 abandoned
in-flight, `error` 13, `excluded` 5), the table mixes benchmark versions, and
the judge rubric changed between them. Pooling makes every v2.0 row look like a
catastrophic regression.

Scale honesty: 264 calls, $2.65, 74 minutes. **This is a pilot.** The subagent
must never describe it as large scale. It also holds only 7 real prompts, so it
**cannot** settle the 3-of-20 versus 1-of-20 determinacy question, which lives
in `qcb_audit/`.

Corpus: after excluding vendor noise, 9,740 files and ~4.5 M tokens, of which
the curated evidence layer is ~2,200 chunks. Ripgrep answers in 425 ms warm,
inside budget with no index. Embeddings are warranted only for cross-draft
paraphrase drift, and the FAISS plus `bge-base-en-v1.5` pipeline already exists
in `LEAN_RAG` and can be repointed. Dedupe by content sha256, not path: some
files exist in six identical copies. Never index the JSON (2,984 files,
565 M chars of backtest output).

---

## 2. Architecture

```
browser (127.0.0.1:4610)
  index.html / app.js / app.css      one chat bar, doc viewer, agent lanes
  audio-worklet.js                   48k capture -> 16k PCM frames
        |  SSE /api/events (down)    coalesced, applied on rAF
        |  POST /api/say (up)        typed or transcribed utterance
        |  WS /ws/audio (up)         PCM frames, voice only
        v
node server.js                       :4610, zero dependency
  ├── doc-host   <-- stdio JSON lines -->  engine/dochost.py   (python-docx + lxml)
  ├── agent.js   <-- normalized events --> selected CLI
  │                 ├── stream-json      claude.exe  (Sonnet / Opus)
  │                 └── app-server JSONL  codex.exe   (Terra / Sol)
  ├── mcp-doc.js  (spawned by the selected CLI, talks back over loopback)
  ├── mcp-research.js (sqlite + ripgrep, read only)
  └── stt-host   <-- stdio JSON lines -->  engine/stt.py       (Silero VAD + faster-whisper)
```

Five processes. Every one of them is supervised by `server.js`, every one has
its pid recorded, and the recorded pids are swept at next boot.

### 2.1 Why the CLI and not the Agent SDK

Research recommends the TypeScript SDK for its ~20 TypeScript-only hook events.
Scribe uses the CLI anyway, for three reasons: the CLI path is verified working
end to end on this exact machine today, it keeps the project at zero npm
dependencies matching the house style next door, and every event Scribe actually
needs (streaming tool inputs, tool results, subagent parentage, thinking, ttft,
cost) was observed coming out of the CLI. The SDK is a wrapper over this same
binary. Revisit only if `TaskCreated` or `FileChanged` hooks become necessary.

### 2.2 Why a Python sidecar and not python-per-op

python-docx import plus a 129 KB document parse is far too slow to pay per edit.
`dochost.py` is a **persistent process** holding the parsed document in memory,
speaking newline-delimited JSON over stdio. One parse per session.

**RESOLVED in Phase 0.** Measured on the 333-paragraph, 129 KB-body target:
**open 24 ms, save 14 ms** (median of 5, range 13 to 14). Two orders of
magnitude inside budget. The debounce ceiling design from the deck suite carries
over unchanged, and a save-per-op is affordable, so there is no need to batch
writes for performance.

### 2.3 Why we render the OOXML ourselves

The alternatives were considered and rejected. A PDF or image embed has no
addressable DOM, which kills per-phrase highlighting (the deck project rejected
it for the same reason). `docx-preview` and `mammoth` are dependencies that give
us their DOM, not ours, so mapping a node back to a paragraph id is guesswork.
Word COM inherits every orphan hazard for a preview we do not need.

The corpus needs a small, closed set of features: bold, italic, underline, run
color, highlight, size, paragraph style, List Bullet, and tables. That is a
few hundred lines and gives total control, including a `data-pid` on every
paragraph and a `data-run` on every run, which is what makes the glow land on
exactly the phrase that changed.

### 2.4 The op vocabulary

Small on purpose (MCP tools are deferred and cost a lookup round trip):

| Tool | Args | Notes |
|---|---|---|
| `doc_read` | `from`, `to` | paragraph ids, style, text, run markup |
| `doc_find` | `query`, `regex?` | returns paragraph ids and char offsets |
| `doc_replace` | `pid`, `find`, `replace`, `why`, `expect_hash` | run-splitting, formatting preserved |
| `doc_insert` | `after_pid`, `text`, `style`, `why` | new paragraph, gets a fresh paraId |
| `doc_delete` | `pid`, `why`, `expect_hash` | |
| `doc_format` | `pid`, `find`, `bold`/`color`/`highlight`, `why` | run-level styling |
| `doc_propose` | `anchor_pid`, `intent`, `options[]`, `grounding[]` | puts candidate phrasings on screen. Writes nothing. |
| `research` | `question`, `scope?` | runs the retrieval pipeline, returns findings with sources |
| `db_query` | `sql` | read only, mandatory filters enforced, NULL-trap guarded |

`doc_propose` is the flow of section 0.1. Each option is
`{id, text, note}` and each grounding entry is `{claim, source, mtime, quote}`.
The server assigns stable option ids, renders them as cards, and holds them
until the human accepts one, at which point the accepted text goes through the
ordinary `doc_replace` or `doc_insert` path. Proposals are never written to the
document by the propose call itself.

Every mutating op takes `why` (one line, drives the "what it just did" trail)
and `expect_hash` (sha1 of the paragraph as the agent last read it). A hash
mismatch is rejected with the current text so the agent re-reads and retries.
This is optimistic concurrency, and it is what stops an agent working from a
stale read from silently clobbering a human or a subagent.

Ops never take prose as a CLI positional. The deck project's PowerShell quoting
trap, where ASCII double quotes inside an argument are silently eaten and
truncate the value, makes positional passing untenable for prose. Everything
goes in a JSON body.

### 2.5 The sandbox

The agent gets a `PreToolUse` hook via `--settings` (fail closed: `deny`
initialized before the try block, always `exit 0` with the decision in the JSON
body). Allowlist only: the six `mcp__doc__*` tools, the research tools, `Agent`
AND `Task` (both spellings), and read-only `Read`/`Glob`/`Grep`. `Edit`,
`Write`, `Bash`, and `PowerShell` are denied outright, so there is no path to
the .docx except through the op vocabulary.

Research finding, load bearing: build this on **hooks, not `canUseTool`**.
`canUseTool` is silently skipped for anything auto-approved by `allowedTools` or
a permission mode, which is exactly how Scribe runs. Hooks fire on every call.

**RESOLVED in Phase 3: the hook DOES propagate into `Agent` subagents.** Proven
live: a subagent was instructed to run `Bash`, the guard fired with `agent_id`
populated, and the call was denied. Research subagents can therefore run inside
the one session as planned, and do not need to be sibling processes.

**Also found in Phase 3, and load bearing:** `--allowed-tools` controls
AUTO-APPROVAL, not AVAILABILITY. `Bash`, `Edit`, `PowerShell`, and `Write` remain
in the model's toolset regardless, and the agent does reach for them. The hook is
not defense in depth here, it is the entire defense.

### 2.6 Safety

- Backup to a timestamped sibling before the first write of a session, matching
  the existing `*.pre-audit-backup-*.docx` convention.
- Every op is a checkpoint. Undo is snapshot based, but snapshots clone the
  paragraph list only, not the whole document, because a full clone per op is
  O(document) on a 129 KB body.
- Undo granularity is **per utterance**, not per op. One spoken sentence
  produces many ops, and a per-op undo stack is unusable by voice.
- A global pause, enforced at the endpoint (HTTP 423), in the scheduler, and
  re-checked after every `await` that precedes a write. Coordination endpoints
  stay ungated so you can keep talking while frozen.
- Refuse to open a .docx that is currently locked by Word (`~$` lock file
  present), rather than fighting it.

---

### 2.7 The retrieval pipeline

"What did we actually do?" is not a grep. It is a staged pipeline, and every
stage stays inside the selected CLI's agent system so the whole thing is
observable in the lanes.

```
  plan      main agent turns a vague question into 3 to 6 concrete queries
    |
  sweep     parallel subagents, one per modality, each blind to the others:
    |         - drafts/    lexical, your drop folder, highest trust
    |         - siblings   the other McNair drafts and audit reports
    |         - tree       7.1 Research, with the exclusion globs
    |         - db         leanbench.db and results.db, read only
    |         - document   the open paper itself
    |
  read      promising hits are opened and read in full, not just matched
    |
  reconcile drafts disagree with each other. Conflicts are surfaced, not
    |       averaged. Newest mtime wins ties, and the loser is still reported.
    |
  ground    findings, each with file, mtime, and a verbatim quote
    |
  draft     2 to 4 phrasings in the author's voice, via doc_propose
```

Design rules, each earned from a measured hazard in section 1.9:

- **Dedupe by content sha256, not path.** Some files exist in six byte-identical
  copies, which would otherwise crowd out real matches.
- **Never `SELECT *` from `calls`.** One column is 107.9 MB.
- **Every database query carries the mandatory filter.** `db_query` rejects a
  query missing it, and rejects any `COALESCE(trade_pass` outright with an
  explanation, because that single mistake inflates the failure rate 2.12x.
- **Ripgrep first, embeddings only if lexical recall fails.** Warm lexical
  search answers in 425 ms over the whole tree. Embeddings exist to catch
  paraphrase drift across drafts ("tape" versus "trace", "semantic edge" versus
  "hidden platform semantics"), which is a real problem here but a second-tier
  one.
- **Three PDFs extract to zero text** and will pass silently as empty strings.
  Assert at least 200 chars per page after extraction and flag failures rather
  than reporting "nothing found".
- **Report scale honestly.** The database is 264 calls and $2.65. If a finding
  rests on it, the answer says "pilot", never "large scale".

### 2.8 Everything runs through authenticated CLIs, never direct APIs

Stated explicitly because it constrains every later choice. Sonnet and Opus run
through `claude.exe`; Terra and Sol run through the Codex app-server protocol.
Each uses the human's existing authenticated subscription session. There are no
SDK calls and no direct HTTP calls to either model API. Model child environments
omit provider API-key variables so an inherited shell setting cannot silently
change billing mode.

The locally installed Ollama models are used for **speech to text support only**
(Phase 7). They never write prose, never answer a research question, and never
touch the document. Local models exist here to make the microphone fast, not to
substitute for the agent.

Practical consequence: Claude subagents use the `Agent` tool and Codex
subagents use app-server collaboration items. Both normalize into the same
observable nested lane. The document and research MCP surfaces remain the
authority boundary regardless of provider.

## 3. Phases

Each phase is one working session and ends with something runnable and verified.
No phase depends on a later one.

**Phase 0. The document engine. DONE 2026-07-19.** 52/52 golden tests pass.
See PROGRESS.md.
`engine/dochost.py`. Load, stamp `w14:paraId`, extract a JSON model (paragraphs
with id, style, runs, formatting; tables included via a body walk), run-splitting
replace, insert, delete, format, atomic save with backup. Zero-run and
table-cell paragraphs handled. Golden test: round trip
`LEAN-Bench_McNair_2026.docx` and assert the zip parts are byte identical except
`document.xml`, and that run counts and `rPr` counts are preserved through a
cross-run replace. **Benchmark save latency and record it here.**

**Phase 1. Server and model. DONE 2026-07-19.** 43/43 integration tests pass.
`server.js` on port 4610, env prefix `SCRIBE_`. Persistent doc-host supervision,
pid file, boot sweep inside `listen()`. `/api/doc`, `/api/edit`, `/api/events`
(SSE with a snapshot frame and backpressure handling), atomic JSON persistence,
undo stack, pause gate. A `scribe` CLI to drive it headless for testing.

**Phase 2. The viewer. DONE 2026-07-19.** 38/38 browser tests pass.
OOXML to HTML with `data-pid` and `data-run`. Build once, patch forever, keyed
on paragraph ids so in-flight animations survive an edit. rAF-coalesced SSE
application. Per-phrase glow with `prefers-reduced-motion` honored. CSS
containment. This is where "minimalistic but sophisticated" is won or lost.

**Phase 3. The agent. DONE 2026-07-19.** 44 sandbox tests plus 33 live
end-to-end assertions against a real agent, all passing.
`agent.js` dispatches to the Claude stream-json transport or the Codex
app-server transport, both with `shell: false`, then normalizes both into one
event contract. `mcp-doc.js` bridges the op vocabulary back to the server.
Claude uses the tested PreToolUse guard; Codex uses a read-only sandbox, disabled
shell/connectors, MCP allowlists, and the same server-side role enforcement.
Both support queued input and interruption.

**Phase 4. Watching it work. DONE 2026-07-19.** 36/36 lane tests pass.
The agent lane: pending calls rendered from `input_json_delta` before they
execute, then running, then done with their result. Nested lanes for subagents
keyed on `parent_tool_use_id`, rendering from complete messages only. Thinking
meter from `thinking_tokens`. ttft and cost from `result`. The "what it just
did" trail from each op's `why`.

**Phase 5. The chat bar and the options cards. DONE 2026-07-19.** 50 resolver
tests plus 38 flow tests.
One input. Send injects into the live session. Honest queued vs delivered state
driven by `isReplay`. Interrupt control. No optimistic append: bubbles render
from the echo so there is exactly one transcript.
Plus the receiving half of the grounded drafting flow: `doc_propose` renders
option cards with their grounding, each card is selectable by click or by voice
("the second one", "B but shorter"), and accepting one routes its text through
the ordinary edit path. The reference resolver that turns a spoken phrase into
an option id lives here, and it must handle a modified acceptance ("B but drop
the second clause") by handing the option plus the modification back to the
agent rather than pretending to edit the text itself.

**Phase 6. The retrieval pipeline. DONE 2026-07-19.** 34 pipeline tests plus 13
live flow assertions.
The staged pipeline of section 2.7. Claude uses `--agents` definitions and
Codex uses collaboration items for the sweep, reconcile, and drafting roles.
`mcp-research.js` with
`corpus_search` (ripgrep first, content-sha dedupe, per-source exclusion globs,
PDF extraction with the zero-text assertion) and `db_query` (read only, `mode=ro`,
mandatory filters enforced, refuses `COALESCE(trade_pass` with an explanation).
`sources.json` with the roots of section 0.2 and a `scribe/drafts/` drop folder.
The drafting agent loads `WRITING_STYLE_JOSH.md` so options come back in the
author's voice. Sweep lanes render concurrently, conflicts between drafts are
surfaced rather than averaged, and every finding carries file plus mtime.

**Phase 7. Voice. DONE 2026-07-19.** 21/21 end-to-end tests through a real
browser microphone and a real GPU model.
AudioWorklet capture, 48k to 16k, WS frames. `engine/stt.py` with Silero VAD
endpointing and faster-whisper on GPU. `pip install faster-whisper` is the only
new install and needs no CUDA toolkit. Utterance-at-a-time, not streaming
partials: research shows Whisper pseudo-streaming has a structural latency floor
near twice the chunk size, and endpoint-then-transcribe is both simpler and
better for a "speak, then watch it act" loop. Budget ~2 GB of weights; drop the
local 7b before dropping STT quality.

**Phase 8. Verify and polish. DONE 2026-07-19.** 14 perf assertions, README,
heartbeat beacon. Full suite 389 offline plus 47 live, all passing.
End to end with a real document. Perf profile under a burst of edits (never
measured, even in the deck project). Loud health beacons, because the sibling
server was twice found silently gone with no crash trace and a voice app that
dies quietly is worse than one that dies loudly. README.

---

## 4. Risks

| Risk | Evidence | Response |
|---|---|---|
| docx save latency too slow for a live loop | unmeasured | benchmark in Phase 0 before building the debounce |
| Hook does not propagate to subagents | unverified | test in Phase 3; fall back to sibling processes |
| STT latency under concurrent GPU load | entirely unmeasured, the largest unknown | measure in Phase 7 against the real 2.6 GB budget |
| Word opens the file mid-session and fragments runs | expected eventually | run-aware from day one, so this is a non-event |
| Silent server death | happened twice next door, root cause unknown | health beacon, do not swallow `uncaughtException` |
| SSE payload size at document scale | the deck ships its whole model per edit; may not scale to a 129 KB body | measure in Phase 2, patch protocol only if it fails |
| VRAM ceiling | 2.6 GB verified, but with an inert tensor | budget to 2 GB of real weights |

---

## 5. House rules

- No em dashes. Comma, period, colon, or parentheses.
- Zero npm dependencies. Node builtins and vanilla JS. Python uses only what is
  already installed, except `faster-whisper` in Phase 7.
- Copy from the deck suite, never cross-require it. That project deliberately
  duplicates rather than couples.
- Nothing outside `Presentation/scribe/` is ever written. The deck suite, its
  data, `presentation.pptx`, and the research tree are strictly read only.
- Port 4610 and the `SCRIBE_` env prefix, so nothing collides with the deck
  suite on 4599 and `SUITE_`.
- Every measured number in section 1 is a claim this code makes about reality.
  If one stops being true, the code should say so out loud.
