# Scribe

Talk to one CLI-backed agent and watch it edit your paper, a phrase at a time.

```
cd scribe
npm start          # or double-click start-scribe.cmd
```

Then open **http://127.0.0.1:4610**. Not `localhost`, not a LAN address: the
microphone only works on `127.0.0.1`.

Click **open document** in the upper left and choose a `.docx`. Scribe places a
working copy in `scribe/data/documents/` and edits that copy, so the original
file you selected stays untouched. Put reference-only drafts in
`scribe/drafts/`; those are searchable but are never opened for editing.

The first time a document is opened, Scribe snapshots it into `scribe/originals/`
(a pristine baseline, written once and never rewritten). As you work, it mirrors
the latest committed version into `scribe/output/`, so the newest file is always
there without reaching into `data/documents/`. Neither the baseline nor the file
you picked is changed as you edit.

The **save** button (top strip, beside undo) is the one exception: press it and
Scribe asks to confirm, then writes the current version back over the original
file you opened. In Chrome or Edge this overwrites that exact file on disk (you
grant write access once via the file picker; a full page reload asks again). In
browsers without the File System Access API, or after a reload, save downloads a
copy named like the original for you to place yourself.

---

## What it is

One chat bar, one document, one editing agent.

You say what you want. The agent goes and looks things up, then either makes the
edit or offers you wordings to choose from. You see every tool call **before it
runs**, with its arguments filling in as the agent types them, and the changed
phrase lights up in the document the moment it lands.

Work and conversation float over the document viewer as translucent,
neon-edged surfaces rather than occupying an opaque side rail. Work stays
compact and follows the newest tool activity automatically; the old visible
changes list is gone. Conversation is grouped into ordered question-and-answer
exchanges, survives reconnects without duplicate cards, retains complete future
responses, and formats paragraphs, lists, bold text, and inline code for
readability. Thinking is only a small ambient indicator rather than token-count
noise, and each finished answer has a read-aloud replay control.

It remains intentionally smaller than a word processor, but the page is
directly editable in the basic way: click an existing paragraph and type.
A 650 ms typing pause saves the paragraph immediately; Enter or click-away also
saves, while Escape discards only typing that has not autosaved yet. Scribe
preserves the paragraph's Word formatting and puts every save through the same
revision, glow, activity, checkpoint, and undo path as an agent edit.
Backspace at the start of a paragraph or Delete at the end joins it with its
adjacent paragraph as one two-hash-guarded, formatting-preserving undo step.
Paragraphs in different table cells or document regions are never joined.
If a concurrent structural change removes a paragraph with unsaved typing,
Scribe exposes the exact draft in a copyable **recovered typing** panel.

The optional **watch** toggle is separate from that agent. Server-side consent
starts off, so opening Scribe launches no model. Once watch is on, it groups
your direct typing until you have been quiet for 25 seconds, then sends the
before-and-after text to its own read-only model session. If that sidecar finds
one genuinely useful fact, likely unspoken question, caution, or next step, it
attaches a compact note to the changed paragraph. If it finds nothing useful,
it stays silent. Turning watch off cancels its queued work and stops only that
sidecar. The sidecar also closes after a completed review rather than idling
between typing bursts. A failed or timed-out review leaves a short, dismissible
explanation beside the paragraph without changing the document.
It cannot edit, propose wording, dispatch subagents, or start, stop, queue
behind, interrupt, or otherwise affect the editing agent.
If the local server reconnects, the browser reasserts the Watch state already
visible on its toggle; that consent sync alone never launches a model.
A new browser profile first adopts the live session's current Watch consent, so
merely opening another window cannot silently turn an armed session off.

Arming watch alone makes no model call; its first call happens only after a
saved change sits quiet. With watch off, the editing model is likewise called
only when you actually send it a message. There is no separate manual start
action: the stop control appears only while that message-triggered process
exists. Accepting or dismissing an on-screen wording choice is resolved locally
and does not spend a model turn.

Direct document typing also arms a separate one-minute continuation timer,
whether Watch is on or off. If no new keystroke arrives, Scribe gives the saved
change, nearby paragraphs, recent conversation, and any Watch note that arrived
first to the cheaper model from the selected provider: Sonnet for Claude or
Terra for Codex. It returns a short suggested next paragraph as translucent
ghost prose attached to the paragraph you changed. The document is not changed
until you press **Insert**; dismissing it writes nothing, and an insertion is one
ordinary undo step. If insertion is refused, the card stays retryable and says
plainly that nothing was inserted. Resuming typing cancels the timer or
in-flight prediction.
Opening Scribe, selecting a document, or leaving a sleeping browser open never
starts this lane: it is armed only by a recent document keystroke, and a badly
delayed timer is discarded. If the continuation model fails or safely returns
no paragraph, a short attached explanation replaces the drafting cue.

Scribe also keeps a rolling 30-second record of saved direct typing locally in
the browser, even when continuous Watch is off. It does not submit or screen
that buffer on its own. Press **Alt+Shift+W** to request one immediate,
read-only review of that recent typing. If Watch is already on, the same
shortcut flushes the current change set immediately and the next edit starts a
fresh 25-second quiet window. Repeating the shortcut without new typing does
not submit the same change twice.

The browser reads each completed direct-agent response aloud automatically.
A new Watch note uses only a soft arrival chime; its small speaker button reads
that suggestion aloud on demand. Both audio paths are browser-local and add no
model or API usage.

## The flow it was built for

```
you    "I want to say something about how many tasks were determinate,
        but what did we actually find?"

scribe  searches your drafts, the audit, and the databases

scribe  "Here is what the evidence says, with sources. Three ways to put it:"
        [A] Only 3 of 20 tasks were determinate.
        [B] The screen found 3 of 20 determinate, and the advisory pass
            predicted 1.                                    ← sources attached
        [C] Few tasks were determinate.

you    "the second one"          (or click it, or press B)

scribe  writes it in, glows the phrase, records what changed and why
```

Say **"B but drop the second clause"** and it hands the agent your chosen option
plus your change, rather than guessing at the rewrite itself.

## Talking to it

Click the microphone, or press `m`. Speak, then stop. About half a second later
your words arrive exactly as if you had typed them.

Speech never streams to the server. Audio stays in the page until you finish a
sentence, then one utterance is uploaded and transcribed locally on your GPU.
Nothing is sent anywhere else.

You can talk **while it is working**. Your message lands at the next safe point
and the rail tells you honestly whether it is queued or delivered. To stop it
mid-task, press the interrupt.

Scribe does not discard a message it cannot deliver. The draft returns to the
composer with the reason, ready to retry, and rapid Enter presses are folded
into one delivery attempt.

## What it can read

Read only, always. Nothing outside `scribe/` is ever written.

| | |
|---|---|
| `scribe/drafts/` | your drop folder. Searched first, trusted most. Put anything here. |
| the open document | itself |
| `Presentation/` | the other drafts, the style guide, audit reports |
| `7.1 Research/` | the evidence tree, minus the noise |
| the two databases | opened read only, with guards |

The checked-in `sources.json` is deliberately empty and has `configured: false`.
Add only roots and databases owned by the current account, then set
`configured` to `true`. Research commands refuse before probing the filesystem
until that explicit configuration exists. Never copy source paths from another
user profile or checkout.

Every answer carries the file it came from **and that file's date**. When two
drafts disagree, Scribe says so and gives you both, because averaging a conflict
is how a settled question gets reopened by mistake.

## What it cannot do

- Touch a file other than your document. The agent has no shell and no file
  access at all; its only route to the page is a fixed set of document
  operations.
- Edit while paused. Press space, or the pause button, and every write stops.
- Lose your work. A backup is taken before the first edit of a session, every
  utterance is a checkpoint, and undo rolls back a whole instruction rather than
  one operation at a time.
- Quietly answer from memory. If it did not look something up, the options say
  "no sources cited" in red.
- Let the watch sidecar change the paper. Its MCP surface contains only read,
  find, and attach-note, backed by a second read-only guard allowlist.
- Let a predictive continuation silently enter the paper. Its one-shot process
  can only read and find, then retires; only the visible Insert control writes.

## Controls

| | |
|---|---|
| click a paragraph | edit its text directly |
| 650 ms pause / `Enter` / click away | save direct typing |
| `Escape` | cancel direct typing that has not autosaved yet |
| `Backspace` at a paragraph start / `Delete` at its end | merge adjacent paragraphs as one formatting-preserving, undoable edit |
| watch | continuously review human typing after 25 seconds of quiet |
| 60-second pause after typing | draft a read-only next paragraph with the preferred enabled automatic model |
| Insert on a continuation | add the ghost paragraph as one undoable edit |
| `space` | pause and resume all editing |
| `/` | jump to the chat bar |
| `m` | microphone |
| `A` `B` `C` or `1` `2` `3` | pick an option when some are on screen |
| `chat` | open the floating Work and conversation surfaces on compact screens |
| `Alt+Shift+W` | review the last 30 seconds of saved typing now |
| the model picker | Sonnet or Opus through Claude CLI; Terra or Sol through Codex CLI |
| `auto 4` | include or exclude each model from future Watch and Continue jobs |
| undo | reverts the last thing you asked for, in full |

Switching models restarts the agent. The conversation resumes when you switch
within the same provider (Sonnet to Opus, or Terra to Sol). Switching between
Claude and Codex starts a clean provider session because their session ids are
not interchangeable. Scribe refuses every switch mid-turn rather than killing
work in flight.

The editing picker and automatic pool are deliberately separate. The picker
chooses the full-power model used when you send an editing message. `auto 4`
opens four independent availability switches for future Watch and Continue
jobs. The selected editing model stays enabled; choose another editing model
before excluding it. Changing availability never starts a process and never
reroutes work already in flight.

Automatic work first prefers the cheaper enabled model in the selected
provider, then its deeper peer, then an enabled model from the other provider.
The panel states the exact models that the next Watch and Continue jobs will
use. Watch still requires its explicit toggle. Continue remains separately
gated by a recent saved typing change and one minute of quiet.

## How it is put together

```
browser  ── SSE ──┐
                  ▼
              server.js  (node, no dependencies, port 4610)
                  ├── dochost.py    the document, parsed once, edited by run
                  ├── research.py   the corpus index and guarded SQL
                  ├── stt.py        one resident speech model
                  ├── agent.js      provider-neutral editing agent
                        ├── claude.exe   Sonnet / Opus, streaming JSON
                        ├── codex.exe    Terra / Sol, app-server JSONL
                        ├── mcp-doc.js        8 document tools
                        ├── mcp-research.js   4 read-only research tools
                        └── subagents         observable, sandboxed
                  └── selected CLI  separate watch sidecar
                        └── read, find, attach-note only
```

Every process is supervised, its pid recorded, and swept at the next boot if it
is orphaned. The server writes a heartbeat every 10 seconds, and the page
desaturates if that heartbeat stops, so a dead server is visible instead of
silent.

Both providers use their cached subscription login. Scribe removes
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CODEX_API_KEY` from model child
processes so a shell variable cannot silently move a run onto API billing.
Inside the headless Codex client, Scribe's two loopback MCP servers are
pre-approved because their exact tool lists are already restricted by role.
The shell remains disabled, the Codex sandbox remains read only, and an
unexpected MCP elicitation is cancelled rather than being mislabeled as a
user-rejected tool call. The configured `Presentation/` corpus is read through
the guarded research tools, not through unrestricted filesystem access.
An individual turn failure leaves its authenticated CLI session available for
the next message; only a real process failure changes the lane into a retryable
start state. Watch and continuation failures remain inside their own sidecars
and never change the editing agent's lifecycle.

## Running the tests

```
npm test           # complete deterministic suite, no tokens spent
npm run test:current # active document, checkpoints, and formatting regressions
npm run smoke:live # free, non-mutating check of the running local session
npm run test:configured # opt-in document/browser suite against your selected fixtures
npm run test:live  # configured suite plus a real agent, about $0.25
npm run bench:stt  # re-measure speech latency on this machine
```

Before `test:configured` or `test:live`, set `SCRIBE_TEST_DOCX` to an absolute
DOCX path owned by the current account. Set `SCRIBE_TEST_LEGACY_DOCX` as well
for the two-document compatibility checks. There is no fallback path: missing,
relative, or sibling-profile inputs refuse before access. The live tests remain
separate because they cost money; the configured browser and voice checks are
also separate because they require those explicit local fixtures.
`test:current` is also non-mutating: it copies the active document for edit
probes and verifies the checked-in document and checkpoint bytes afterward.

The deterministic suite also includes seeded synthetic DOCX mutation fuzzing,
exact manifests for the current document and its checkpoints, malformed
JSON/process-output tests, transaction rollback and restart fault injection,
managed-path escape checks, browser reconnect/race simulations, and a real
40-edit burst followed by undo. Each server and editable document used by those
tests lives in an isolated temporary directory.

## Measured on this machine

| | |
|---|---|
| Document save | 14 ms |
| Render after an edit | 0.4 ms median, 333 of 333 nodes reused |
| Sustained edit burst | 18.5 edits/second, no dropped events |
| Corpus search | 7 ms over 965 files |
| Speech, stop talking to text | 584 ms, 7.7% word error rate |

## Things worth knowing

- **The page stays white in dark mode.** Your run colors are semantic (green is
  an addition, pink a deletion, purple a note) and were authored for white
  paper. Recoloring them for contrast would change what they mean.
- **Proposing writes nothing.** Options on screen have not touched the file.
- **`trade_pass IS NULL` means the gate was never reached**, not that it failed.
  The database tool refuses to let anything treat it as a failure, because doing
  so inflates the failure rate 2.12x.
- **The leanbench database is a pilot**: 264 calls, $2.65. Every answer drawn
  from it says so.

## Details

`PLAN.md` is the design, and section 1 is everything that was measured rather
than assumed. `PROGRESS.md` is the build log, including what broke and why.
