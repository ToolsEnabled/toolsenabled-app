# Shared chat formatting and reading flow

Agent output previously depended on which transcript displayed it. Messages
used literal text, live Controls-rail replies stayed unformatted until finish,
and duplicate CSS rules made typography drift. The app now uses one Markdown
renderer, one message update helper, and one stylesheet across those surfaces.

## Result

- Clear paragraph and heading spacing, readable line lengths, nested and loose
  lists, aligned tables, task lists, quotes, and callouts. User input and activity
  retain their literal punctuation. Sender lines, message bodies, timestamps,
  source stamps, and Copy controls have separate places in each conversation.
- Fenced code has a visible language caption, syntax highlighting, a keyboard
  scrollport, Copy, and an independent Wrap setting. Whole-message Copy keeps
  the original source; code Copy keeps the rendered code's whitespace. Unknown
  languages and large blocks stay complete without guessed highlighting.
- Home coordinator/run conversations, shared agent/tree/rail chat components,
  Messages channel logs, board previews and expanded tiles, and saved history
  all share the same rendering and typography. Compact previews keep their
  existing fold behavior. Full Messages conversations start expanded and honor
  explicit saved disclosure choices.
- Streaming patches changed content while retaining settled paragraphs, code
  scrollports, selection, focused controls, and wrapping. The Controls rail
  batches deltas once per frame. The first live response removes the empty
  conversation notice.
- Home updates changed text even when a message retains its ID. Messages polls
  retain unchanged rows instead of rebuilding them. Overlapping route mounts
  compare their mounted channel cards, preventing a resolved conversation from
  remaining behind its initial loading card.

## Rendering contract and dependencies

`src/chat-markdown.js` uses pinned `markdown-it@15.0.1` with a CommonMark-based
parser, tables, strikethrough, explicit soft line breaks, and local task/callout
extensions. A narrow compatibility extension admits nested numbered procedures
starting above one without requiring an extra blank line; it uses the pinned
parser's list rule and has nested-list regression coverage.

Raw HTML remains text. Links admit HTTP(S) only and open with noopener/noreferrer.
Markdown images become labeled links, so reading a response does not fetch a
remote image. Message content cannot create application controls. Typography
and syntax colors support all five themes, reduced motion, forced colors, and
narrow panels.

`highlight.js@11.12.0` bundles its core and 16 selected grammars. Highlighting is
explicit by language, cached for 24 blocks, and skipped above 24,000 characters;
content is never truncated. Both packages and six transitive dependencies have
verbatim license notices in `THIRD-PARTY-LICENSES.md`. The dependency lock is
updated. The isolated new-dependency audit reported zero vulnerabilities.

## Verification

Evidence: `/home/redacted-profile/chat-formatting-20260908/evidence`.

- Chat/Home/Messages/tree/rail/history regressions: **730 passed, zero failed,
  four existing skips** (`final-regressions.log`). The skips cover existing
  scope-chip/mention and agent panelization work. Updated legacy tests assert
  the shared CSS and real code toolbar, replacing obsolete pseudo-element
  expectations. Two pre-existing VM fixture omissions were reproduced on base
  `dab95ccc1906a01545e8671c103d1ff5d108ee46` and supplied with their missing
  environment bindings (`baseline-harness-errors.log`).
- Real Chromium functional review: seven surface scenarios passed, including
  exact clipboard content, clipboard refusal, streaming selection/focus/draft
  stability, saved history, actual Home and Messages views with isolated data
  fixtures, polling, reload disclosure persistence, and expanded board tiles
  (`surface-review.mjs`, `surface-results.json`).
- Actual tree conversations at desktop and 390px widths, independent wrapping
  in two open conversations, and the actual agent detail page passed
  (`compact-review.mjs`, `compact-results.json`).
- Eleven edge scenarios passed: inert hostile HTML/URLs, no remote image fetch,
  exact code copy, 320/390/800/1440px layout bounds, local table/code scrolling,
  keyboard scrolling, Wrap, and syntax contrast in every theme. The minimum
  measured contrast among the exercised syntax tokens was 4.90:1
  (`edge-review.mjs`, `edge-results.json`). This is targeted contrast evidence,
  not a claim of a complete accessibility audit.
- Visual review exercised all five themes, rich structures, message/code Copy,
  and Wrap (`visual-review.mjs`). Representative screenshots:
  `chat-cobalt-desktop.png`, `chat-cobalt-mobile.png`, `chat-cobalt-table.png`,
  `home-coordinator-ember.png`, `messages-channel-ember.png`,
  `messages-expanded-ember.png`, `tree-conversations-white.png`, and
  `agent-detail-white.png`.
- Production build passed (`final-build.log`). JS bundle: 2,717.85 kB, 859.43 kB
  gzip. The existing large-chunk warning remains.
- License gate, 223-module identifier check, composed-output check (32 states /
  204 strings), suite discovery (854), driver discovery (86), and whitespace
  checks passed (`final-*.log`).

The browser drivers use an external local Playwright installation and explicit
review fixtures. They do not send provider messages or prove LIVE delivery.
They remain in the evidence directory instead of adding a machine-specific path
to the repository's normal test runner.

## Qualification and Windows

No engine source, native shell behavior, installer, LIVE selection, or promotion
was changed. Browser/Electron APIs and bundled dependencies are portable; no
platform-specific filesystem path is added to product code. Build validation
used Node 22.19.0 on Linux. The new transitive `entities` package requires Node
20.19.0 or newer for dependency installation/build. Native Windows execution
was not performed in this worktree.

The full repository qualification cannot run here because the isolated checkout
lacks `capability/`, `private/capability-source.owner.json`, and
`private/owner-data-patterns.owner.json`. The normal input guard reports these
with exit 3 (`final-test-inputs.log`); it was not bypassed. Final integration,
native qualification, and the actual LIVE runtime receipt remain with promotion
session `01a07f97-9ab9-73c1-b2b8-608b8661be3b`.
