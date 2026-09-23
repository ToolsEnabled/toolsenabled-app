# Reusable cross-surface regression tests

Run from the App checkout on Linux or Windows with the project's supported
Node and installed dependencies. No npm install, browser download, live login,
paid provider, research action, device enrollment or publication is performed.
These are regression selections, not a replacement for the existing cut gates.

## Real user paths

Print ordered actions and expected results without opening a window:

```text
node tools/surface-tests.mjs paths
node tools/surface-tests.mjs paths --surface mobile
node tools/surface-tests.mjs list --surface browser,mobile --profile full
```

The same path definitions drive the automated browser checks and appear in the
JSON plan. Each mobile case follows 23 steps in one page and one context:

1. Open Home once, press Quick settings, then all settings.
2. Type a settings search, try an unmatched query, clear it, and press Back.
3. Use Home's Open computers link, read the signed-out gate, and tap Explore the demo.
4. Find Manager, verify the no-match state, clear the query, collapse and expand.
5. Open an agent, verify its identity, switch Details → Chat, close, reopen that
   same agent, and close again.
6. Use the visible Home link and check the final page for overflow and exceptions.

Desktop cases follow the same Home → Settings → Computers → Home navigation.
The driver uses visible controls after initial entry; it does not jump directly
to each route or inject product state. Text entry uses browser keyboard events.
Mobile actions use emulated touch; this is not physical-phone input evidence.
Smoke/full change the viewport/browser matrix, not the required journey steps.

Reports include each action, expected result, observed result, timing and status.
The checkpoint records RUNNING before an action. A failed step keeps its error
and a failure screenshot when available; dependent steps remain NOT_RUN.
A missing step, changed order, unfinished case or unconfirmed context closure
cannot pass. The exact requested cases remain visible even if launch is blocked.
Failed-driver evidence is retained in report.json and the report's path tables.

The paths command also describes manual account/device connection, remote
tree/chat, reconnect, and native installation paths with their prerequisites.
The mobile and phone selections include hosted login/logout, physical Safari
login/logout, and Safari-to-desktop FRA claim and reconnect paths. These use the
hosted `/signin/` and `/account/` routes; desktop connection controls stay on the
owned Linux/Windows desktop. Unknown hosted selectors require fresh visible
controls. Each surface switch requires confirmed window closure and a supported
endpoint that remains alive with its UI closed; otherwise the path is blocked.
These are manual acceptance plans, not automated coverage or executed results.
Conditional provider work requires an explicit task/budget; never mark an
omitted conditional step passed. Keep one owned UI window at a time, confirm
closure before opening the next, and record BLOCKED if the flow cannot do that.
Never record passwords, one-time connection codes, or account content in evidence.

## Quick start

```text
npm run test:surface-runner
npm run test:surfaces -- list --profile full --surface all
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --only fra-identity,fra-relay,fra-authority
```

Replace absolute paths for the current OS. The last command runs six reviewed
in-memory FRA leaves (claims, encryption, controller routing, relay closure,
browser authorization, workspace policy), in retained sterile environments.
Each leaf runs separately under the existing Linux/Windows descendant owner.
No fixture deletion is needed in this selection. Legacy assertion programs
retain their process-exit contract; no fabricated assertion count is added.

`--out` must be a new directory whose parent exists, outside both repositories.
It is created privately and never reused or deleted. JSON, Markdown, per-job
stdout/stderr, driver JSON, screenshots and generated profiles stay available.
Source-only tests record the current Git ref and a working-change digest;
source changes during a run make the final result fail attribution.

Chat, chat-replies and layout (smoke/full), plus agents and settings (smoke),
use reviewed source reads and in-memory DOM/storage fixtures. Their strict
per-file profiles are retained, so these selections also run with the default
cleanup refusal:

```text
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --only chat,chat-replies,layout --profile full
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --only chat-replies --profile smoke
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --only agents,settings --profile smoke
```

The exact allowlist lives in `fixture-policy.mjs`; an unreviewed file keeps the
cleanup prerequisite. Smoke chat-replies covers the eight T890 suites; full adds
the completed close/reopen, node-switch, and mid-tools-arrival user-path suite.
This is source coverage, with the exact working-change digest recorded, and does
not qualify the packed runtime or physical phone.

The other selections reuse existing suites which may delete their OWN temporary
fixtures. The default is to refuse those jobs. Obtain the person's required
deletion approval first; only then pass `--fixture-cleanup approved`. This flag
records a prerequisite choice, not authority to delete anything outside tests.
The runner never deletes source, accounts, devices, owner profiles or reports.

```text
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --profile smoke --jobs 2 --budget-ms 300000 --timeout-ms 60000 --fixture-cleanup approved
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --profile full --jobs 1 --budget-ms 1800000 --timeout-ms 300000 --fixture-cleanup approved
```

Use `--only login,remote-ui,chat,settings` for a narrow retry. Omitted groups are
not covered; the exact selection is recorded. There is no pass-result cache.
`full` means the full curated catalog, not every feature of the product.
One heavy build/test slot must still be coordinated before a broad run.

## Coverage catalog

| Group/surface | Checks |
| --- | --- |
| login | Hosted sign-in handoff, PKCE, cancellation, account store, account route |
| remote-ui | Remote tree/reconnect rendering, session nonce, device settings access |
| agents | Session controls, slot admission, tree lifecycle, recovery, provider isolation |
| chat | Enter/repeat/stop, phone sheet, composer bounds, output, attachments, approvals |
| chat-replies | T890 final reply after tools, live rail replay, tree resume/currentness, empty-turn transcript, native reconnect renderer, owner/reply ordering, session text reconciliation; full adds completed close/reopen, node switch, and mid-tools arrival |
| settings | Quick settings persistence, multi-word search, batch changes, presentation/tier reachability |
| layout | 320px floor, phone sign-in gate, route links, ledger/canvas, metrics layout |
| packaging | Capability helper closure/index, renderer provenance, staged renderer guard |
| fra-identity | Device claims/refusals/identity, encrypted session and handshake refusals |
| fra-relay | Relay close/reconnect/renewal, desktop controller fixed-route and stale-write refusals |
| fra-authority | Browser identity/freshness, workspace policies/handles/refusals, remote tier parity |
| fra-bridge | Local/composite bridge, web client, sealing error translation |
| inspector | Generic mobile-tool scope, explicit input semantics, sticky remote cleanup |
| registry | Shipped inventory, confinement, MCP refusal/read-failure boundaries |
| browser | Real packed renderer, desktop viewports, Home/Settings/Computers, search, overflow, exceptions |
| mobile | Chromium/WebKit emulation, portrait/landscape/320px, ordered PG2 search/no-match/recovery/branches/identity/chat/details/close/reopen/Home |
| hosted | Existing real anonymous website sign-in gate, mouse/touch/keyboard reachability |
| packaged | Existing native Home driver; full also selects Page2 (instrumented-copy scope retained) |
| phone | Explicitly BLOCKED until a connected device and bound inspector session are supplied outside this runner |

Browser smoke uses Chromium: one desktop viewport or two phone viewports.
Full adds WebKit, two desktop viewports or four phone orientations. The browser
driver clicks/taps actual controls and inspects the real candidate renderer;
only the product's own demo is used, with no injected API responses. Search
uses browser input automation, NOT physical keyboard certification.

## Post-cut / deployed surfaces

Always pass the controller's exact immutable source pair and unpacked artifact.
Dirty, unresolved, mismatched or missing packed build-info refuses. There is
no fallback to a local dist folder, a running Dev window, LIVE owner state or
an old release. Archive identity is checked again after execution.

```text
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --surface browser,mobile --release ABS_UNPACKED_RELEASE --expect-app APP_SHA40 --expect-engine ENGINE_SHA40 --playwright-root ABS_INSTALLED_KIT --browsers-path ABS_BROWSER_CACHE --profile full --budget-ms 900000 --timeout-ms 600000 --fixture-cleanup approved
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --surface packaged --release ABS_PLATFORM_RELEASE --expect-app APP_SHA40 --expect-engine ENGINE_SHA40 --budget-ms 900000 --timeout-ms 600000 --fixture-cleanup approved
node tools/surface-tests.mjs run --engine ABS_ENGINE --out FRESH_ABS_OUTPUT --surface hosted --origin https://TEST_HOST --mount /app/ --expect-app APP_SHA40 --expect-engine ENGINE_SHA40 --playwright-root ABS_INSTALLED_KIT --browsers-path ABS_BROWSER_CACHE --budget-ms 900000 --timeout-ms 600000 --fixture-cleanup approved
```

Hosted requires real same-origin `MOUNT/build-info.json` with clean schema-v2
App+Engine provenance, before AND after the test. If the deployment does not
expose it, that identity proof is unavailable; don't substitute another build.
Hosted permits same-origin GET/HEAD only. No credentials are requested, loaded,
or replayed. Authenticated login/logout and cross-computer FRA remain separate
live acceptance, using test accounts and explicit endpoints after a qualified cut.

Linux and Windows must each run their own packaged artifact. Do not change
accounts: on the owner's Windows desktop use the explicit ToolsEnabled-Dev
connection only. Never connect to the excluded research hotload port.
Existing packaged-QA sandbox, disposable-worker and native custody checks are
left intact; missing permission/host readiness never downgrades to a mock pass.

## Results and scheduling

`list` and `paths` return success when they produce a plan, including a plan with
blocked prerequisites. The exit statuses below apply to `run`; plan output is
never evidence of execution. Hosted run results must reconcile the complete
eight-case Chromium/WebKit matrix, individual checks, and valid completion
timestamps. This establishes report completeness, not independent freshness.

- Exit 0: every selected job completed and passed. Exit 1: a failure. Exit 2:
  unavailable prerequisite, BLOCKED or NOT_RUN. Skips are not passes.
- Complete TAP plans/counts are validated by the existing Engine validator;
  engine summaries must contain each requested leaf exactly once. Browser
  reports require positive nonempty check evidence. Reports never infer that
  process exit proves a physical phone tab was closed.
- Timeouts and a total wall-clock budget are bounded. Timed-out mutations are
  not replayed. No new work starts after unconfirmed descendant cleanup.
  Admission is rechecked after identity verification and immediately before
  each launch. Expired selections remain NOT_RUN; already-admitted work still
  completes its bounded cleanup and evidence checks.
- At most two lightweight App source groups may overlap with `--jobs 2`, in
  separate profiles. Existing siblings finish their owned scopes; the next
  batch is blocked on a cleanup failure. Engine groups and all GUI/browser
  jobs are serial. Each browser page/context closes before the next opens.
- Checkpoint reports begin with NOT_RUN placeholders, so an interrupted run
  cannot leave behind a partial PASS report.

The runner's own in-memory contract suite is part of ordinary `test:data`
discovery. Direct `test:surface-runner` runs just those contracts quickly.
Broader packaging/source/native gates remain mandatory for a qualified cut.
