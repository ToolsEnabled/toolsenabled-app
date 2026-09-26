# Settings browsing and saving

Settings opens at Tool use and keeps one category per route, with one pending
draft across category and mode changes. Its 18 categories are grouped by task:

| Group | Categories |
| --- | --- |
| Agents & tools | Tool use, Agents & delegation, App permissions, Research, Local models |
| Your workspace | Home screen, Connect this computer, Setup, Notifications |
| Appearance & reading | Appearance, Text & Reading, Motion & Effects, Accessibility |
| System & data | Resources, Rules & approvals, Data & Privacy, What the screens show, System |

Simple, Advanced, and Expert choose how much is shown. Advanced is the default.
Simple keeps everyday choices, including tool mode, resource controls, and tree
conversation size. Advanced adds ordinary detailed controls. Expert adds
sensitive or specialized controls, including audit maintenance, P13 guidance,
permission profiles, function rules, and inheritance. The source of the exact
visibility rules is `src/settings-mode.js` and the per-control metadata.

Simple and Advanced are remembered as a window preference. Expert opens for
the current Settings visit after a local four-digit confirmation. Cancel,
Escape, an incorrect code, and reloading do not enter Expert. This is an
interface confirmation, not an authentication or enforcement boundary. Changing
the browsing mode never changes a product setting or an agent's effective access.

Search covers every category, including titles, descriptions, capabilities,
and setting IDs. Ordinary results appear regardless of browsing mode; Expert
results retain their entry button. Direct links reveal and focus the named
control without changing the remembered mode. Older category links still resolve.

## Drafts and immediate preferences

Pending Settings edits survive category and mode changes. Save validates the
whole draft, persists related product controls in a native batch, and refreshes
saved snapshots. Setup and Tool use share the same permission-policy draft.
Setup also reads account selection from the Accounts policy and shares screen
and write-permission draft entries with their individual Settings controls.
An unrelated Setup edit preserves those choices. When a preset and an individual
control affect the same preference, the later edit wins. Changing default account
selection preserves reserve percentages, ranking windows, and provider overrides.
Setup policy choices above the selected permission tier are disabled with an
explanation. Existing Accounts policy remains visible even when that tier would
not permit choosing it anew.
Successful writes are removed from the draft; a failed write remains pending
for correction or retry. If persistence succeeds but its audit recording fails,
the status reports that distinction instead of repeating the applied write.

The desktop Save/Discard bar stays visible while scrolling. Phone navigation
and the save bar scroll with the page. Segmented choices wrap within the page,
including at Large text size. Closing during a pending or active Save preserves
the native services until the window actually accepts the close.

The Quick settings drawer applies immediate preferences after storage accepts
them. Failed persistence keeps the previous choice and displays a retryable
error. Both interfaces use the same stored appearance preferences.

## Controls with additional contracts

Tool mode offers ToolsEnabled only, Both, and Native only. The mode is bound
when a provider session starts; changing the default does not rewrite a running
session. Codex still exposes some native read helpers. Agent questions and
purchase approval are separate settings. Disabling purchase approval requires
its own expiring, single-use local confirmation bound to the pending change.

Audit batching and credential checks expose bounded numeric controls with
paired sliders. Strict auditing disables batching. Credential-cache controls
explain their Windows-only applicability; Linux retains uncached custody.
Resource controls configure actual admission and launch pacing, with current
machine readback. Conversation-card size can be set globally or overridden per
computer and tree, including Off.

Audit maintenance is available in Expert under Data & Privacy. Inspection is
read-only. Rotation archives a healthy identity; repair archives unverifiable
history and creates a new identity for future signed records. Repair never
attests to the archived history. Interrupted maintenance has a separate recovery
path. Whole-vault or ownership failures remain refusals rather than triggering
a vault reset. These operations preserve unrelated vault entries, require a
fresh local confirmation, and require a restart before new work. Save or discard
pending edits before starting maintenance.

Audit maintenance and local-data removal seal new work and require an authentic
research-shutdown observation, confirmed capability-child exit, and closed
app-owned writers before changing stored data. A changed research registration
invalidates the observation. Cleanup failure requires a restart; it cannot be
retried in the same process as though a detached writer had closed. Local-data
removal remains available when credential sign-out fails, provided runtime
cleanup succeeds, and reports the sign-out result separately.
Removal stops account refresh and new account actions, then joins admitted
actions and seals both hosted and local account writers. Browser sign-in
attempts remain owned after their visible result until their listener, request,
response body, and browser-opening work actually finish. Cancellation alone
does not establish cleanup. The account cleanup deadline is monotonic and
bounded; missing acknowledgments or late completion require a restart and
prevent browser deletion and the file sweep. A settled remote sign-out refusal
remains visible separately from confirmed local cleanup.
Removal also closes the general SQLite store and seals retained preference
writers and both main-process diagnostic monitors. Queued monitor callbacks
cannot recreate performance or heap logs while the result window stays open.
It clears localStorage for every origin in the requesting window's
verified application Session before sweeping files, so old browser copies cannot
restore preferences or recovery checkpoints after a cold restart. Session and
directory ownership are checked before inventory and browser deletion, then
checked again after the bounded native clear. The final file measurement and
sweep are synchronous and adjacent.

An interrupted browser clear requires a restart and refuses the file sweep.
The result distinguishes confirmed browser deletion, uncertain deletion, and
refusal before deletion began. A lost or malformed reply cannot claim that data
is intact. Locked files remain explicitly listed when a sweep is incomplete.

If bridge startup fails, its real research supervisor's terminal cleanup
observation is delivered over the original private lifecycle channel before
disconnect. Missing, stale, replayed, or unrecognized observations remain a
refusal, including if an earlier accepted observation becomes invalid.

P13 guidance is an Expert, default-off preference applied on provider restart.
Editor Watch requires consent and a native source receipt. Copy starts a new
conversation from a bounded, verified source import through normal launch
controls. Take over remains unavailable until a real editor handoff can be
acknowledged. Historical registry entries without runtime consumers are not
presented as functioning settings merely because the registry contains them.

## Qualification

Regression coverage includes defaults and bounds, mode persistence, draft
dependencies and partial retries, storage failures, native confirmations,
runtime tool enforcement, resource admission, and provider source cleanup.
Browser qualification covers all categories, modes, themes, phone/desktop
widths, and text sizes. Native Linux and Windows qualification checks real
renderer/preload/main-process writes, on-disk state, reload, audit verification,
and source import in isolated profiles. An actual Linux Codex conversation and
context-bearing copy also passed. The Windows model attempt was refused by the
normal resource guard under measured memory pressure, so it does not establish
an authenticated Windows fork response. Browser host fixtures alone do not
establish native enforcement or external-service availability.
