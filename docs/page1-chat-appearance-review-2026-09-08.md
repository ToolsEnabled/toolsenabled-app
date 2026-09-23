# Page 1 full chat and appearance review

The full Home chat now uses the app's theme surfaces and typography, with larger
message text, clearer sender separation, a contained scrolling transcript, and
an anchored composer. Comfortable and Wide reading widths are saved locally.
Find supports Ctrl/Cmd+F, Enter/Shift+Enter, match counts, and opening matching
run details. Latest respects the different ordering of conversations and runs.

Switching views filters runs by their recorded computer, tree, and agent
identities. Drafts survive scope changes and closing/reopening full view. A
computer or tree activity view hides the coordinator composer and points to
individual run chats for replies. Example data remains visibly labeled.

Appearance adds Ember (deep red) and Cobalt (deep blue), including controlled
background glow, dark charts, role colors, native window colors, startup, and
saved preferences. Manrope and Source Sans 3 are bundled locally alongside the
existing font choices. Both appearance menus expose all five themes and six
font choices. Font licenses are included in THIRD-PARTY-LICENSES.md.

## Verification

- Production build passed after integration with the current tree changes.
- The final focused Home, appearance, storage, and desktop-theme test run
  passed 284 tests; the sample-activity suite passed another 9.
- Browser review passed 12 scenarios: real example conversations and streaming,
  search, draft retention, focus return, scope filtering, width persistence,
  all themes, 320/390/800/1440-pixel layouts, increased text size, and saved
  theme/font choices after reload. All six fonts loaded.
- An isolated coordinator transport fixture exercised the real Home composer:
  accepted sends clear the draft, failed sends preserve it, and new messages
  preserve a reader's scroll position. This does not certify provider delivery.
- Eight additional views covered Home, Computers, Metrics, and Settings in both
  new themes. Charts received the dark theme and selected font.
- Suite/driver discovery, renderer identifier checks, composed-output checks,
  and repository license checks passed. The composed-output check covered
  32 states and 204 strings with no findings.

The broader chat regression run exposed two inherited fixture errors:
`chat-agent-bridge-gated.test.mjs` has no `process` in its preload VM, and
`chat-pending-start-reason.test.mjs` has no `mockSource` in its extracted-function
VM. Both reproduce at the original `4826597c` base and after integration.
The full-suite input preflight also requires the gitignored capability payload
and private build configuration absent from this isolated worktree. No full
release or packaged-installer qualification is claimed.

Local screenshots, browser assertions, baseline comparisons, and test/build
logs are in `/home/redacted-profile/page1-chat-appearance-20260908/evidence`. Representative
screenshots are `chat-ember-1440-1.png`, `chat-cobalt-1440-1.png`,
`chat-cobalt-320-1.png`, `live-chat-cobalt.png`, and `appearance-cobalt.png`.
