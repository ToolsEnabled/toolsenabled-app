# Presentation Suite

Presentation Suite is a local coordinator for editing a PowerPoint deck through
one validated model while dashboards and optional Claude or Codex agents watch
the same live state. Every deck mutation goes through the coordinator, is
recorded for undo/redo, and is blocked by the global pause.

The project has zero npm package dependencies. It is not dependency-free as a
whole: rendering and linting require Python, and true thumbnails and PDF export
require desktop PowerPoint on Windows.

## Requirements

- Node.js 18 or newer.
- Python 3 with `python-pptx` for import, PPTX rendering, font linting, and the
  Python test suites.
- Windows plus a locally installed desktop PowerPoint for real thumbnail and
  PDF export. The dashboard still has model-derived fallbacks without Office.
- Chrome, Edge, or Chromium is optional. The real-browser smoke test skips
  cleanly when none is installed.
- `pypdf` is optional. The current-content suite uses it only when the
  on-demand PDF is at the current model revision.
- Claude CLI or Codex CLI is needed only for the corresponding live agent
  provider and the explicitly provider-dependent tests.

There is no `npm install` step for this project itself.

## Start and use it

From `Presentation/`:

```text
node suite/server.js
```

Or from `Presentation/suite/`:

```text
npm start
```

Open `http://127.0.0.1:4599/` for the dashboard or
`http://127.0.0.1:4599/studio` for the focused deck and agent view.

The editor CLI is `node suite/ppt.js` from the project root, or `node ppt.js`
from this directory:

```text
ppt status
ppt show
ppt search "quarterly churn"
ppt title "Investor Update"
ppt add-slide --layout content --title "Agenda"
ppt set-text s1 e1 "Welcome"
ppt set-bullets s2 e4 "Revenue up 22%" "Two new markets"
ppt set-color s2 e4 "#144D8C"
ppt set-corners s3 e2_24 sharp
ppt set-box s3 e2_24 --h 0.09
ppt add-shape s1 "#2A78D6" --x 0.10 --y 0.08 --w 0.80 --h 0.06
ppt delete-decor s1 d_generated_1
ppt lint
ppt time
ppt protect s8 path-guy
ppt protections --json
ppt protections --history --json
ppt unprotect s8 path-guy
ppt undo
ppt redo
```

Run `ppt help` for the complete command reference. Set
`SUITE_EDITOR="your-name"` so commands have one stable identity in presence,
locks, tasks, and history.

## Source data and generated artifacts

`data/model.json` is the editable source of truth. In the current overlay
workflow, `data/base.pptx` is the pristine imported deck and model elements
refer to real shapes in that file.

The important derived and durable files are:

- `presentation.pptx`: the last successfully published render.
- `data/render-state.json`: the exact model revision, byte size, and SHA-256 of
  that published PPTX.
- `data/thumbs/slide-N.png`: PowerPoint-rendered slide thumbnails.
- `data/presentation.pdf`: the last successful on-demand PDF export.
- `data/state.json`: pause, durable content protections and their bounded audit
  history, provider/profile, spend, and `pdfRev` state.
- `data/element-history.json`: durable stable-ID object versions (ten visible
  versions and three nested restore checkpoints per object). Generated image
  and video revisions are deduplicated by content under
  `assets/.element-history/`.
- `data/board.json`: notes, tasks, and standing loops.

The coordinator does not treat an unmarked or mismatched PPTX as current.
`GET /api/state` exposes `presentation.current`, and `GET /api/pptx` refuses to
serve a file whose revision marker, size, or hash does not match the live
model.

## Import an existing deck

```text
python suite/import_pptx.py path/to/deck.pptx
```

Import is validate-first and transactional. It builds staged copies of
`data/base.pptx`, `data/model.json`, and `presentation.pptx`, validates the
package and generated references, then commits the set. A failed validation or
mid-commit error preserves or restores the previous destinations.

The imported model is an overlay, not a flattened reconstruction. Editable
text and decorative shapes retain references to their backing PowerPoint
shapes, while unrelated images, tables, layouts, rich runs, and formatting
remain in the pristine base deck.

Import while the server is stopped. If it is already running, restart it after
the import because the coordinator loads the model once at boot.

## Supported edits and mode boundaries

Accepted native layouts are:

`title`, `content`, `bullets`, `section`, `titleonly`, `blank`, `two`, and
`compare`.

An overlay deck can contain both kinds of slide:

- An imported slide has an integer `src` and real backing shapes in
  `base.pptx`.
- A slide created with `add-slide` has no `src` and is rendered natively.

The edit boundary is strict:

- Backed imported text elements support text or bullet replacement, font,
  color, size, bold, alignment, fill, box geometry, sharp-corner conversion
  when it is a rectangle-family AutoShape, and deletion. Deleting one removes
  its real backing shape from the rendered PPTX.
- Backed imported decor supports fill when colorable and box geometry when it
  has a real shape id. Eligible rectangle-family AutoShapes also support
  `set-corners sID targetID sharp`.
- `set-corners` is intentionally narrow. Import (and a one-time legacy-model
  migration) records trusted `sourcePreset` metadata only for non-placeholder
  rectangle/card AutoShapes. The operation refuses placeholders, text boxes,
  pictures/media, connectors/lines, groups, circles/icons, and generated
  objects. The persisted `corners: "sharp"` intent is reapplied from pristine
  `base.pptx` on every render by changing only that shape's existing
  `p:spPr/a:prstGeom` preset to `rect`; its PowerPoint shape id, text, fill,
  line, transform, z-order, and animation target remain intact.
- `add-shape`, `add-image`, and `add-video` work on imported slides and
  suite-created native slides. On an imported slide, generated decor is
  layered above the pristine backing content and never replaces a source
  shape. On a native slide, generated decor follows model order behind native
  text, which supports full-slide backgrounds and reusable visual overlays.
  Rectangle fill is exact `#RRGGBB`; every x/y/w/h value is a slide fraction.
- `add-image` adds a generated PNG, JPEG, or GIF from this project's `assets`
  folder. `add-video` adds generated media from an `assets/*.mp4` H.264 file;
  PowerPoint embeds the MP4 in the PPTX instead of linking it, with autoplay
  and looping enabled by default. Both commands use strict fractional boxes.
- `set-box` and `delete-decor` support generated rectangles, pictures, and
  media. Imported or backed decor is deliberately refused by `delete-decor`
  so the command cannot delete source slide artwork. Media playback is
  separate from object entrance builds and is not a `set-animation` target.
- Adding an element to an imported slide is rejected; it is never stored as
  invisible model-only content.
- Imported slide layouts cannot be changed. Read-only or unbacked imported
  elements are rejected instead of producing a render that ignores the edit.
- Native slides support add/delete element, content, style, fill, layout, and
  generated-decor edits. Native text geometry remains automatic, so
  `set-box` rejects native text but moves or resizes generated native decor.
- Box coordinates are finite fractions in `[0, 1]`; width and height must be
  greater than zero.
- `set-theme` supports one `--accent "#RRGGBB"` value and affects natively
  constructed content. `accent2` is not supported and is rejected.

All raw `POST /api/edit` payloads receive the same type, range, identity, and
renderability validation as CLI and MCP edits.

## Render, thumbnail, and PDF publication

An accepted edit first commits a new model revision. The debounced renderer
then captures that revision and writes a private staging PPTX. Before
publication the coordinator:

1. confirms the captured revision is still current and the deck is not paused;
2. validates the staged file as a real PPTX package, including required ZIP
   members;
3. atomically replaces `presentation.pptx`; and
4. writes an exact `data/render-state.json` marker with revision, size, and
   SHA-256.

A corrupt result cannot replace the previous presentation. A renderer that
finishes after a newer edit is discarded as superseded. Private stages are
cleaned after completion and stale stages are swept at boot. If an unpaused
server starts with a missing or mismatched marker, it schedules a verification
render; a paused server remains frozen and reports the stale artifact until
resume.

Thumbnails are generated only from a successfully published captured deck.
They are best-effort because they depend on PowerPoint COM; both pages retain a
model fallback. In Studio, an unknown thumbnail revision or any lag, including
one revision, is amber. A matching successful revision is current, and an
actual render or thumbnail failure is red.

Studio's single-slide entrance-build controls are a labelled approximation,
not PowerPoint playback. The final PowerPoint-rendered PNG remains the
canonical slide image. While an animated object is pending, Studio reconstructs
only that object's model-defined bounding region from slide geometry and
model-bound source artwork, then reveals the final thumbnail pixels with the
stored click grouping, delay, duration, and effect. A final raster cannot
recover every exact pre-animation pixel, rich-text run, crop, or PowerPoint
easing choice. The exported PPTX is therefore authoritative for exact playback.
Missing targets or geometry fall back to the unmodified static thumbnail.
Previous, Next, Reset, and Play are available as buttons; Page Up or
Shift+Space, Page Down or Space, Home, and End provide keyboard equivalents.
Reduced-motion users get the same steps without motion.

PDF export is on demand:

```text
ppt export-pdf
```

Each request captures the model and revision, renders a private source PPTX,
exports to a private PDF, checks the `%PDF-` signature, and atomically publishes
`data/presentation.pdf`. Only requests for the exact same captured revision
share work; different revisions are serialized so PowerPoint jobs do not race.
`pdfRev` advances only after the matching PDF and state are durable. A timeout
or failed renderer/exporter cannot overwrite the canonical PDF, and any
publication or state failure cannot falsely advance `pdfRev`.

`GET /api/pdf` serves the last successful PDF, which may intentionally be
behind the model. The dashboard and `GET /api/state` expose `pdfRev` so that
staleness is explicit.

## Lint and timing

`ppt lint` combines model checks with effective font data from the rendered
PPTX:

- em or en dashes in visible text, bullets, or notes;
- explicit font sizes below 20pt;
- title-sized header alignment outliers;
- non-empty speaker notes; and
- font-family outliers across effective PowerPoint text runs.

The font helper resolves direct, paragraph-default, and inherited fonts where
possible. An execution/parsing failure becomes a `font-lint-error` issue, and
unresolved inherited runs become `font-lint-coverage`; neither can masquerade
as a clean lint pass.

```text
ppt lint
ppt lint --json
ppt time
ppt time --json
```

Timing is a visible-word estimate at 135 words per minute, with the configured
11-minute target and 12-minute cap. It is a sanity check, not a replacement for
a rehearsal.

## Pause, history, and coordination

Pause is fail-closed:

- the durable global flag gates edit, undo, redo, and new agent spawns;
- the server applies and verifies the Windows read-only bit on both
  `presentation.pptx` and `data/model.json`; and
- every client receives the pause state over SSE.

Repeated pause/resume requests re-check the file state. If an OS lock step
cannot be verified, the error is visible and a committed pause remains in
force rather than silently reopening edits.

Board notes, task coordination, and loop configuration remain available while
paused, but any resulting deck change still passes through the pause gate.

Durable content protections are a separate, human-controlled hard gate:

- `ppt protect sID` freezes a whole slide, while
  `ppt protect sID objectID` freezes one text element or decor object
  (including pictures and media);
- `ppt protections [--json]` lists the active canonical stable-id records,
  `ppt protections --history [--json]` lists the durable lock/unlock decisions
  so a human unlock is distinguishable from initial absence, and
  `ppt unprotect ...` is the explicit human unlock;
- agents cannot create or remove protections; and
- edit, slide delete/move, undo, and redo are refused before model or history
  mutation whenever their stable target scope intersects a protection.

Protections are stored atomically in `data/state.json`, survive restart, appear
in `GET /api/state`, and publish a `protections` SSE event after a successful
durable toggle. Missing `protections` is accepted for legacy state files, but
a present malformed or stale record fails startup closed instead of being
silently discarded.

Every changed lock or unlock also appends a validated `protectionHistory`
record (action, stable target, human actor, and timestamp), capped at the most
recent 200 entries and committed in the same atomic state write. The ledger is
returned by `GET /api/state` and `GET /api/protections`, and is included with
the protection SSE event. This makes an explicit unlock auditable as a rejected
approval even after the active protection disappears; an idempotent request
does not manufacture another audit event.

Studio exposes the same protection model as a simple inverse tree. Double-click
an item to lock or unlock it. A locked slide may have several explicitly
editable children; conversely, an unlocked slide may contain several directly
locked children. Single-clicking an item opens its solid History sheet. The
sheet shows its last ten versions, can restore any visible version, and keeps
three nested `Undo restore` checkpoints. Restoring the fifth card truncates the
active list to five; Undo restore puts back the prior current object and its
complete ten-card list. Object restore is human-only, pause-gated, stale-head
checked, and protection-aware. On desktop every Studio side sheet reserves
layout space and reflows the editor instead of covering it.

Tasks are durable `open -> claimed -> done` records. Claims require an
identity, cannot steal assigned or already claimed work, and a worker cannot
complete another worker's task. Lead and human surfaces retain oversight. On
restart, stale claims are atomically returned to `open`; unfinished lead
assignments are reawakened only after the stale child-PID sweep completes and a
real Studio viewer is present. Completed tasks are never reawakened.

Wake behavior is deliberately narrow:

- A task created by `lead` and assigned to a worker is committed first, then
  wakes that worker or spawns it if a slot is available.
- An unassigned task is only stored for later claiming.
- A task assigned from another surface is also stored; use chat to wake the
  lead or let the intended session poll/claim it.
- `POST /api/tasks/update` changes only an existing `open` task. It requires
  `id` and `by`, and accepts `text`, `assignee`, and `wakeWorker`. Setting
  `wakeWorker` to `false` holds the task durably: its id, created timestamp,
  progress, instruction, and assignment remain, but restart recovery will not
  wake it. Setting it to `true` queues the assigned worker and dispatches only
  while unpaused with a real viewer present.
- Changed text and assignments retain their prior values in the task's newest
  50 `revisions` entries. Holding does not retract a message already delivered
  to a live worker; interrupt or dismiss that worker separately when needed.

The CLI mirrors this with `ppt task-update`, `ppt task-hold`, and
`ppt task-wake`. The lead MCP surface exposes the same operation as
`ppt_task_update`; workers cannot call it.

The Agent Studio chat route wakes or spawns the lead. The lead dispatches
slide-scoped tasks across the active profile's worker pool: one in `low`, two in
`normal`, and up to twelve in `extra` (subject to the environment ceiling).
`beast` is the one-click extra-extra-high mode. It keeps the selected provider,
gives the general lane 30 independent slots and the image/video lane 10
independent slots, and starts every new agent on the provider's heavy model:
Claude Opus or GPT-5.6 Sol. It uses the suite's `ultra` reasoning tier (mapped
to Claude Code's highest `max` effort) and trusted full access. The separate
human Fast toggle defaults OFF and applies to the next spawn only: Codex uses
the Fast request path when it is ON, while Claude reports it unavailable and
continues on standard service. Task routing and the selected
pool are persisted before a worker is woken, so restart recovery retries the
same assignment instead of reclassifying it.
On `low`, `normal`, and `extra`, Claude workers are guarded so shell commands
can only reach the blessed `ppt.js`. On `beast`, Claude does not load that
restrictive hook or its Bash-only/Task/Edit denylist: it launches with its
default built-in tools, configured plugins/connectors/MCP, Task/Agent
subagents, and trusted shell/filesystem/web access. Codex remains explicitly
trusted on every profile. Both full-access paths can inspect visuals and
generate image/video assets through available tools or code. Their prompts
still prefer the validated `ppt` CLI or role-gated `ppt_*` tools for supported
presentation mutations so those edits share the suite's validation, pause,
history, rendering, and lock boundaries. Browser/computer and connector tools
remain host- and account-dependent; enabling access does not manufacture a
plugin or connector that is not installed or exposed by the provider.

## HTTP API summary

- Deck: `GET /api/state`, `POST /api/edit`, `GET /api/pptx`.
- History: `GET /api/history`, `POST /api/undo`, `POST /api/redo`, plus
  `GET /api/object-history`, `POST /api/object-history/restore`, and
  `POST /api/object-history/undo-restore` for stable per-object versions.
- Controls: `POST /api/pause`, `POST /api/resume`.
- Protections: `GET /api/protections`,
  `POST /api/protections/toggle`.
- Analysis: `GET /api/lint`, `GET /api/timing`.
- Coordination: `/api/board`, `/api/tasks`, `POST /api/tasks/update`,
  `/api/locks`, `/api/loops`, and `/api/status`.
- Agents: `POST /api/chat`, `GET /api/agents`,
  `GET|POST /api/agents/fast-mode`, `POST /api/agents/interrupt`, and
  `POST /api/agents/stop`.
- PDF: `POST /api/pdf/export`, `GET /api/pdf`.
- Live updates: `GET /api/events`.

Control POSTs require JSON. Request bodies are bounded, malformed JSON receives
a structured error, and browser requests with a foreign `Origin` are rejected.

## Tests

Run the complete deterministic and current-content suite from this directory:

```text
npm test
```

`npm test` now runs both:

```text
npm run test:core
npm run test:robustness
```

The scripts are split into short groups so they remain readable and do not hit
Windows command-length limits:

```text
npm run test:core:server
npm run test:core:state
npm run test:core:agents
npm run test:core:frontend

npm run test:robustness:server
npm run test:robustness:protocol
npm run test:robustness:frontend
npm run test:robustness:render
```

Coverage includes:

- edit validation, pause transitions, atomic model/state/board/protection
  persistence, presence, advisory locks, hard protection enforcement,
  undo/redo, the agent guard, and durable ten-version/three-checkpoint object
  restore behavior (`protections.test.js`, `element-history.test.js`);
- adversarial HTTP bodies and control contracts
  (`backend-robustness.test.js`, `control-contract.test.js`);
- staged PPTX publication, exact render markers, boot recovery, PDF revision
  races, exporter timeouts, and persistent COM-host lifecycle isolation
  (`render-pipeline.test.js`, `pdf-export-race.test.js`,
  `com-host.test.js`);
- isolated BEAST activation and restart preservation, including exact task
  fingerprints, protected artifact hashes, zero dispatch while paused with no
  viewer, the 30+10 split, Opus/ultra/standard-speed/full-access settings, and persistence
  across a second boot (`diagnostics/beast-restart-preservation-smoke.js`);
- fake-process Claude/Codex lifecycle, queue isolation, malformed frames,
  bounded buffers, request timeouts, late-turn isolation, and viewer-idle
  cleanup that protects active/queued turns while restoring durable task wakes
  (`agent-lifecycle.test.js`, `reaper-safety.test.js`,
  `codex-agent-protocol.test.js`);
- Studio/dashboard state, history latches, action failures, CDP framing, and a
  real-browser current-content smoke pass (`frontend-state.test.js`,
  `frontend-history.test.js`, `frontend-actions.test.js`,
  `cdp-lifecycle.test.js`, `frontend-browser-smoke.test.js`);
- transactional import, rich-run-preserving overlay deltas, native rendering,
  imported deletion, strict corner eligibility, real PPTX sharp-corner
  round-trip/animation identity, and effective-font linting
  (`render_tools.test.py`);
- the committed model/base reference graph, current render deltas, rich-run
  canaries, fonts, thumbnails, and current PDF when applicable
  (`current_content.test.py`); and
- PowerShell parsing, literal paths, staged rollback, COM ownership, and RCW
  release (`export_scripts.test.ps1`).

Robustness tests use disposable directories, fake renderer/exporter processes,
and loopback servers. They never mutate the committed deck or data. The browser
suite owns one temporary profile and one captured browser PID; it skips when no
supported browser is present. The PowerShell suite inspects and exercises pure
helpers without launching PowerPoint.

The only provider-dependent tests stay separate because they spawn a real
Claude child and can consume subscription usage:

```text
npm run test:reaper
npm run test:loops
npm run test:recovery
npm run test:agents
```

## Configuration

Core settings:

- `SUITE_PORT` (default `4599`)
- `SUITE_HOST` (default `127.0.0.1`)
- `SUITE_EDITOR` (stable editor identity)
- `SUITE_PYTHON` (default `python`)
- `SUITE_AGENT_PROVIDER` (`claude` or `codex`, seed for fresh state)
- `SUITE_USAGE_PROFILE` (`low`, `normal`, `extra`, or `beast`, seed for fresh
  state)
- `SUITE_MAX_WORKERS` (default and hard safety ceiling `30`; lower values reduce
  every profile's general-worker limit)
- `SUITE_MAX_MEDIA_WORKERS` (default and hard safety ceiling `10`; lower values
  reduce the BEAST image/video-worker limit)
- `SUITE_CLAUDE_EXE` and `SUITE_CODEX_EXE` (executable overrides)
- `SUITE_ALLOWED_ORIGINS` (additional comma-separated browser origins)
- `GUARD_LOG` (optional Claude guard audit log)

Relevant safety timeouts and limits:

- `SUITE_HTTP_TIMEOUT_MS`: CLI HTTP timeout. Ordinary commands default to
  75 seconds; `export-pdf` uses a 180-second default when this override is
  unset.
- `SUITE_MCP_HTTP_TIMEOUT_MS`: MCP-to-coordinator timeout. Ordinary tools
  default to 15 seconds; `ppt_lint` uses 45 seconds so the font helper's legal
  30-second window can complete.
- `SUITE_REQUEST_BODY_TIMEOUT_MS`: incomplete request-body timeout, default
  15 seconds.
- `SUITE_HEADERS_TIMEOUT_MS`: HTTP header timeout, default 10 seconds.
- `SUITE_CODEX_RPC_TIMEOUT_MS`: Codex app-server request timeout, default
  30 seconds.
- `SUITE_CODEX_STDOUT_FRAME_LIMIT`: maximum Codex JSONL frame/buffer size,
  default 4 MiB.

Provider/profile selections made in Studio or through `ppt provider` and
`ppt profile` persist in `data/state.json` and take precedence over fresh-state
environment seeds after restart.
