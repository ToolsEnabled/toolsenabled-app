# Native development

Run `npm run dev:native` to open the current checkout in the real Electron app with a separate, private profile. It watches renderer sources, rebuilds them with Vite, and reloads this instance after each successful build. Failed builds leave the last working screen open. If the machine has exhausted its file watchers, launch with `CHOKIDAR_USEPOLLING=true CHOKIDAR_INTERVAL=700 npm run dev:native`; the same rebuild/reload loop uses polling.

The window title begins with **ToolsEnabled Dev**. To reuse a development profile or name the window:

```sh
npm run dev:native -- --profile /absolute/path/to/your/dev-profile --label "Page 2 Dev"
```

The profile must meet the app's normal account and directory ownership rules. Defaults live under `~/.toolsenabled-native-dev/`. No existing app profile is reused by default. Finish or skip setup in the new window as usual. No agents are started by this launcher.

The checkout needs installed dependencies and its normal capability payload. Stage the payload with the existing `pack:capability` workflow and an exact engine commit; privacy checks still apply. Renderer data, native IPC, authentication and sandboxing all use the ordinary desktop shell.

This development instance explicitly opens an ephemeral loopback debugging port for automatic reload and UI inspection. Its profile contains `native-dev.json` with the window PID, supervisor PID, source checkout, URL and debugging origin. Closing the dev window stops its watcher. Shell or capability changes require restarting this instance; renderer reloads can reset unsaved UI state, so use a dedicated development profile.

Page 2 has one **Trees** home tab and full-width agent chat tabs. The top **+** menu creates a tree or a standalone agent; the canvas's grey **+** creates a tree, and an agent's **+** opens its conversation tab. **Trees on this canvas** stages a multiple-tree selection before applying it. **Fleet overview** opens the side panel.

Choose **Circles** or **Boxes**, with **Mini**, **Small**, **Medium**, and **Large** context sizes. Circle context cards can also be hidden. Zoom inward follows the nearby branch under the pointer; zoom outward uses the viewport centre. Fit restores the current selection's overview. The original hierarchy and bounded pan remain. The full layout is tried first; crowded branches use fewer visible nodes only when necessary for readability. Boxes retain real child names alongside an overflow group and can arrange separate trees on multiple rows. There is no ten-agent cap. Detached circle context cards keep their braces, with joined strokes, a clearer name/status header, and distinct task/action/update sections as space allows. Mini prioritizes immediate activity; repeated copies of the same original brief are omitted. Opening a card preserves its mounted conversation and draft. Editing temporarily fits every selected real node as a circle, with no embedding or culling, then restores the normal view.

A standalone agent created with **+ → New agent** can later join the tree without restarting. Drag its tab onto an open child **+** (or the box’s **Add agent** footer), or onto the grey canvas **+** to give it its own tree. Dragging reveals the Trees canvas and highlights the destinations. The chat header also offers **Add to tree**, with the agent and tree names in a destination picker. Placement preserves the mounted transcript, draft and attachments. The same native session receives its saved tree address; its provider, folder and permissions remain those of the running session. Pending placement prevents a duplicate start/restart or tab close. A refused placement leaves the original tab available. After successful placement, closing the chat tab leaves the tree’s session running. Reopening from the node restores its unsent draft, attachments and in-progress reply. Halt preserves the partial answer even when the provider does not send a final event.

**Split view** opens an empty second pane. Drag any actual agent there to inspect its descendants with that agent at the top. This only changes the view; it does not move the saved agent. The second pane can be closed or replaced with another drag.

**Link** starts a two-node selection at the full-tree-head level. The saved direct link appears as a straight dashed line with a **›** button at its midpoint. The button opens a compact popup with each agent's Chat action and a separate Remove link action. In Boxes mode it moves along the same straight line when needed to stay clear of another card, including during zoom. Links are bidirectional local messaging relationships, including across trees. They become usable when both sessions are running and survive their restarts. Example pages cannot write real links.

An actual agent's microphone button selects its voice contact and opens the shared voice controls. Selecting a contact while voice is off does not start recording; **Start voice** is explicit. Draft agents explain that they must first be started. Switching pages preserves an active voice contact, while stale selections from a previous page are discarded. Screen controls use the existing native screen-access bridge when present and explain its absence otherwise. Local speech requires the installed runtime and pinned models. Runtime data and temporary files belong to the development instance's own capability directory; restarting is required after host-source changes.

### Indicator examples

Cloud swarm and mechanical drift marks draw explicitly reported `agent.cloudLane` data. Missing token measurements stay neutral; missing drift data produces no drift warning. The current cloud task API does not supply per-agent token/drift telemetry, so a visual preview is separate from real task activity.

To show labeled, memory-only indicator examples in this checkout's running native instance, first open Computers, then run:

```sh
npm run dev:tree-indicators -- --record /absolute/path/to/dev-profile/native-dev.json
```

Use **Clear examples** in the preview, reload, or run the same command with `--clear`. Navigation or a newer fleet update also clears the preview. This command does not write fleet/session records, run agents, use providers, or start voice. It verifies that the supplied native instance belongs to this checkout and bounds the local debugging connection with timeouts.

### Focused interaction checks

The current headless development fixtures use fictional fleets and do not launch a visible Chrome window or paid agents. Set `PLAYWRIGHT_MODULE` to an installed Playwright entry module when it is outside this checkout:

```sh
node tools/test/fixtures/run-tree-interactions.mjs
node tools/test/fixtures/run-tree-box-forest.mjs
node tools/test/fixtures/run-tree-full-edit.mjs
node tools/test/fixtures/run-tree-circle-cards.mjs
node tools/test/fixtures/run-tree-standalone-placement.mjs
node tools/test/fixtures/run-tree-standalone-combined.mjs
node tools/test/fixtures/run-tree-link-popover.mjs
node tools/test/fixtures/run-tree-link-clearance.mjs
node tools/test/fixtures/run-tree-indicators.mjs
```

Each driver records its measurements, screenshots, errors and source hashes in its reported evidence directory. The older `run-page2-native.mjs` and `run-page2-interactions-native.mjs` drivers retain earlier native-flow evidence and selectors; they predate the current shared tree tabs and header. Use the current fixtures for these controls and separately inspect the real native development window against its instance record.

### Combined Page 2 card qualification

The shared-workspace cards use a header, activity sections, and footer with size-specific visibility. The former three-row arithmetic test (`tree-card-line-budget.test.mjs`) measured the retired markup and is superseded by `fixtures/run-tree-circle-cards.mjs`. Run that browser fixture when changing card geometry or composing Page 2: it measures every visible section and complete text line in all four sizes, both themes, with and without tool output, and verifies mounted chat/draft continuity. A passing source-only test does not substitute for this painted-layout check.
