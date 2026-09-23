# Native Page 2 control supplements

`tools/lib/page2-native-controls-scenarios.cjs` exports ten real UI scenarios for
the shared `tools/page2-native-audit.cjs` runner. Import its `scenarios` beside
the shared scenario list and pass their concatenation to `selectScenarios`.
The module imports the shared locator and input helpers; it never replaces an
application bridge, provider reply or native dialog.

| Case | Control inventory | Observable check |
|---|---|---|
| `conversation-search` | H24 | Existing replies filter and restore; the draft survives. |
| `conversation-shelf-controls` | G24–G26 | Both named chats open; hide/show and expand/restore retain the draft. |
| `board-zoom-controls` | G10–G12 | Out/in/fit change view scale while node identities stay intact. |
| `saved-history-bounds` | R16–R17 | Saved replies load; archive/live geometry is separate; close remains clickable. |
| `named-profile-create-refresh` | B17–B18, C08 | Cancel saves nothing; native creation is selectable immediately; Set makes no provider start. |
| `staged-cross-tree-reparent` | G19, R08–R09 | Only the staged Observer moves to Manager and selects the destination setup folder. |
| `staged-remove-confirmation` | P31, P34 | Back preserves all nodes; confirm removes only Observer and keeps earlier signed records. |
| `named-profile-remove-refresh` | B19 | Removing the unused named profile removes it from the next composer immediately. |
| `permission-level-display` | D03 | Details reports the recorded level; this does not prove provider sandbox enforcement. |
| `idle-stop-first-message-resume` | P29, P22 | Idle Stop remains usable, retains the draft and the first resume-triggering reply appears once. |

G24–G26 name the current conversation shelf's open, hide/show and expand/restore
controls. B17–B19 name named-folder cancellation, creation/refresh and deletion/
refresh. These additions describe the current UI instead of treating old
floating-chat IDs as proof of the shelf. R17 covers archive bounds and toggle
reachability; this module does not claim paginated history beyond the loaded
page.

Run through the shared entrypoint with its normal account/path checks and
`--real-provider`. All fixtures stay beneath its new QA directory. The Observer
is staged and removed without a provider run. Stop/resume uses the already
verified Manager and makes one real follow-up request. Required shared cases
are explicit; a missing or failed prerequisite remains unrun, never passed.
Only the final native report constitutes execution evidence for these cases.
