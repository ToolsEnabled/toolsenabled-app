# The settings rows that described features nobody built

Removed from `src/views/settings.js` on 2026-08-20 by the settings-truth lane.
**These are unbuilt intentions, not deleted features.** Every wording below was
written, reviewed and shipped; what was never written was anything that reads the
value. They are kept verbatim so that whoever builds one of these features does
not have to re-invent the sentence a person reads beside it.

## Why they were removed rather than left on the page

Each row below drew a working control — a switch that moved, a slider that
filled, a stepper that counted, a value that survived a restart — and changed
nothing. Nothing anywhere in the product read the `mc.set.<id>` key it wrote.
Nothing on screen distinguished them from the twenty-two rows that worked.

Removing a dead row is not removing a feature; there was no feature. The
described behaviours — chart quality, a frame cap, a Sankey gap, a thread memory
span, a simulation tick bias — do not exist anywhere in the tree, so "wiring"
them would mean building them.

This follows the precedent already recorded in `src/views/settings.js`, where
`offline_fallback` was deleted on 2026-08-13 for exactly this reason rather than
left as a row, on the owner's ruling that a user setting is a registry row, a
real enforcement AND a control in the software — or it is a lie.

## Bringing one back

Build the behaviour first and give it a reader; then restore the row. A row
restored without a reader fails `tools/test/settings-rows-do-something.test.mjs`,
which derives the dead set from the source at run time and names every offender.
That is deliberate: the defect was never that somebody wrote seventy-four bad
rows, it was that nothing could tell a real control from a drawn one.

Two of these rows also **misdescribed the state they were in**, which is worth
knowing before reusing their wording:

- `brace_stroke_width` declared `def: 1.25` while the shipped braces draw at a
  hardcoded `stroke-width="1.5"` in `src/views/home.js` (five places in one SVG
  template). It misreported the current value as well as failing to change it.
- `drawer_width` offered 280–440px against a drawer fixed at `width: 320px` in
  `src/styles.css`. There is no `--drawer-width` custom property to drive.

And one was an accessibility promise: `contrast_curve` offered to "make the
lighter, secondary text darker and easier to read" to the person least able to
detect that nothing had happened. If that feature is ever built, build it first.

---

## Appearance

Two rows in this section worked and stayed: `theme` and `ui_font`.

```js
  { id: 'display_density', section: 'Appearance', name: 'Display density', desc: 'How tightly packed busy screens are. Comfortable gives everything more room; compact fits more on screen.', depth: 1, type: 'seg', options: ['comfortable', 'compact'], def: 'comfortable' },
  { id: 'contrast_curve', section: 'Appearance', name: 'Contrast curve', desc: 'Make the lighter, secondary text darker and easier to read, without changing the theme.', depth: 1, type: 'seg', options: ['standard', 'strong'], def: 'standard' },
  { id: 'role_hue_emphasis', section: 'Appearance', name: 'Emphasize role colors', desc: 'Make each agent role’s color stand out a little more.', depth: 1, type: 'toggle', def: false },
  { id: 'chrome_edge_weight', section: 'Appearance', name: 'Chrome edge weight', desc: 'How visible the thin outlines around buttons and panels are.', depth: 2, type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 42 },
  { id: 'drawer_width', section: 'Appearance', name: 'Settings drawer width', desc: 'How wide the quick settings panel (behind the gear button) opens.', depth: 2, type: 'stepper', min: 280, max: 440, step: 8, unit: 'px', def: 320 },
  { id: 'surface_frost', section: 'Appearance', name: 'Surface frost retention', desc: 'How much frosted-glass blur panels keep. Lower is clearer, higher is softer.', depth: 3, type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 58 },
  { id: 'brace_stroke_width', section: 'Appearance', name: 'Brace stroke width', desc: 'The thickness of the curly-brace lines that frame the home panel, in fractions of a pixel.', depth: 4, type: 'stepper', min: 0.75, max: 2, step: 0.25, unit: 'px', def: 1.25 },
```

## Text & Reading

One row in this section worked and stayed: `text_size`.

```js
  { id: 'numeric_font', section: 'Text & Reading', name: 'Mono numeric values', desc: 'Show numbers and IDs in a fixed-width font, so digits line up as they change.', depth: 1, type: 'toggle', def: true },
  { id: 'reading_line_height', section: 'Text & Reading', name: 'Reading line height', desc: 'How much vertical space lines of text get in descriptions and messages.', depth: 1, type: 'seg', options: ['tight', 'standard', 'open'], def: 'standard' },
  { id: 'timestamp_verbosity', section: 'Text & Reading', name: 'Timestamp detail', desc: 'How times are shown: “5 minutes ago” (relative), clock time, or the full date and time.', depth: 2, type: 'select', options: ['relative', 'clock', 'full'], def: 'relative' },
  { id: 'reading_measure', section: 'Text & Reading', name: 'Reading measure', desc: 'The longest a line of text may grow before it wraps, measured in characters.', depth: 2, type: 'stepper', min: 56, max: 92, step: 2, unit: 'ch', def: 72 },
  { id: 'caps_tracking', section: 'Text & Reading', name: 'Micro-cap tracking', desc: 'The letter spacing of the small ALL-CAPS labels used in navigation.', depth: 3, type: 'range', min: 6, max: 18, step: 1, unit: '%', def: 12 },
  { id: 'baseline_nudge', section: 'Text & Reading', name: 'Tabular baseline nudge', desc: 'Nudge columns of numbers up or down so they sit level with the text beside them.', depth: 4, type: 'stepper', min: -2, max: 2, step: 0.25, unit: 'px', def: 0 },
```

## Motion & Effects

Two rows in this section worked and stayed: `reduce_motion` and `glow`.

```js
  { id: 'view_transitions', section: 'Motion & Effects', name: 'View transitions', desc: 'Fade smoothly from one page to the next instead of switching instantly.', depth: 1, type: 'toggle', def: true },
  { id: 'entry_response', section: 'Motion & Effects', name: 'Entry response', desc: 'How long newly appearing panels take to settle into place.', depth: 2, type: 'range', min: 120, max: 600, step: 20, unit: 'ms', def: 420 },
  { id: 'hover_response', section: 'Motion & Effects', name: 'Hover response', desc: 'How quickly controls change shade when the pointer passes over them.', depth: 2, type: 'select', options: ['immediate', 'clinical', 'soft'], def: 'clinical' },
  { id: 'checkpoint_halo_decay', section: 'Motion & Effects', name: 'Checkpoint halo decay', desc: 'How long the glow around a checkpoint stays visible after it pulses.', depth: 3, type: 'range', min: 120, max: 1600, step: 40, unit: 'ms', def: 800 },
  { id: 'view_morph_snapshot_bias', section: 'Motion & Effects', name: 'View-morph snapshot bias', desc: 'During the crossfade between pages, whether the old or the new page holds the frame longer.', depth: 4, type: 'range', min: -100, max: 100, step: 5, unit: '%', def: 0 },
```

## Fleet Graph

The whole section was inert and the heading was removed with it.

```js
  { id: 'graph_layout', section: 'Fleet Graph', name: 'Graph layout', desc: 'How the map of your agents arranges itself: balanced, tighter, or spread wide.', depth: 1, type: 'seg', options: ['balanced', 'compact', 'wide'], def: 'balanced' },
  { id: 'agent_labels', section: 'Fleet Graph', name: 'Agent labels', desc: 'Keep each agent’s name visible on the map without zooming in.', depth: 1, type: 'toggle', def: true },
  { id: 'group_by_machine', section: 'Fleet Graph', name: 'Group by machine', desc: 'Group agents on the map by the computer they run on.', depth: 1, type: 'toggle', def: true },
  { id: 'link_detail', section: 'Fleet Graph', name: 'Link detail', desc: 'How much is written on the lines that connect agents to each other.', depth: 1, type: 'seg', options: ['quiet', 'full'], def: 'quiet' },
  { id: 'edge_tension', section: 'Fleet Graph', name: 'Edge tension', desc: 'How curved the connecting lines between agents are drawn.', depth: 2, type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 54 },
  { id: 'collision_padding', section: 'Fleet Graph', name: 'Collision padding', desc: 'Extra breathing room kept between neighboring agents so they never touch.', depth: 2, type: 'stepper', min: 0, max: 48, step: 2, unit: 'px', def: 16 },
  { id: 'tier_vertical_gain', section: 'Fleet Graph', name: 'Tier vertical gain', desc: 'The vertical distance between levels of the map, from managers down to their agents.', depth: 3, type: 'range', min: 70, max: 150, step: 2, unit: '%', def: 100 },
  { id: 'leader_line_elbow_radius', section: 'Fleet Graph', name: 'Leader-line elbow radius', desc: 'How rounded the corner is where a label’s pointer line turns.', depth: 4, type: 'stepper', min: 0, max: 24, step: 1, unit: 'px', def: 6 },
```

## Metrics

The whole section was inert and the heading was removed with it.

```js
  { id: 'metrics_window', section: 'Metrics', name: 'Default time window', desc: 'The time span charts open with: the last hour, the last day, or the last week.', depth: 1, type: 'seg', options: [['1h', '1 h'], ['24h', '24 h'], ['7d', '7 d']], def: '24h' },
  { id: 'metrics_auto_refresh', section: 'Metrics', name: 'Auto refresh', desc: 'Keep charts moving as new readings arrive in the demonstration.', depth: 1, type: 'toggle', def: true },
  { id: 'zero_baseline', section: 'Metrics', name: 'Zero baselines', desc: 'Start chart scales at zero where possible, so bar and line sizes compare honestly.', depth: 1, type: 'toggle', def: true },
  { id: 'unit_mode', section: 'Metrics', name: 'Unit mode', desc: 'How chart numbers are labelled: adaptive picks a handy unit, absolute shows the exact value, normalized shows relative scale.', depth: 2, type: 'select', options: ['adaptive', 'absolute', 'normalized'], def: 'adaptive' },
  { id: 'anomaly_sensitivity', section: 'Metrics', name: 'Anomaly sensitivity', desc: 'How unusual a reading has to be before a chart highlights it.', depth: 2, type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 62 },
  { id: 'sankey_node_gap', section: 'Metrics', name: 'Sankey node gap', desc: 'The vertical gap between the blocks of the token-flow diagram (the Sankey chart).', depth: 3, type: 'stepper', min: 4, max: 40, step: 2, unit: 'px', def: 14 },
  { id: 'heartbeat_trace_persistence', section: 'Metrics', name: 'Heartbeat trace persistence', desc: 'How long finished heartbeat blips stay visible on the rolling trace.', depth: 4, type: 'range', min: 5, max: 120, step: 5, unit: 's', def: 30 },
```

## Chat & Threads

The whole section was inert and the heading was removed with it.

```js
  { id: 'thread_sort', section: 'Chat & Threads', name: 'Thread order', desc: 'Which conversations come first: the most recent, or the most important.', depth: 1, type: 'seg', options: ['recent', 'priority'], def: 'recent' },
  { id: 'enter_to_send', section: 'Chat & Threads', name: 'Enter to send', desc: 'Press Enter to send a message; Shift+Enter starts a new line instead.', depth: 1, type: 'toggle', def: true },
  { id: 'collapse_resolved', section: 'Chat & Threads', name: 'Collapse resolved threads', desc: 'Shrink finished conversations down to one quiet summary line.', depth: 1, type: 'toggle', def: true },
  { id: 'thread_preview_lines', section: 'Chat & Threads', name: 'Thread preview lines', desc: 'How many recent lines you can see of a conversation before opening it.', depth: 2, type: 'stepper', min: 1, max: 8, step: 1, unit: 'lines', def: 3 },
  { id: 'chat_timestamp_mode', section: 'Chat & Threads', name: 'Message timestamps', desc: 'How message times are shown inside a conversation: relative, clock time, or hidden.', depth: 2, type: 'select', options: ['relative', 'clock', 'hidden'], def: 'relative' },
  { id: 'thread_memory_span', section: 'Chat & Threads', name: 'Thread memory span', desc: 'How much conversation history the demonstration keeps per thread (its context window).', depth: 3, type: 'range', min: 8, max: 128, step: 8, unit: 'k', def: 64 },
  { id: 'chat_stream_cadence_jitter', section: 'Chat & Threads', name: 'Chat stream cadence jitter', desc: 'How unevenly the demonstration streams text in, to read like natural typing.', depth: 4, type: 'range', min: 0, max: 240, step: 10, unit: 'ms', def: 40 },
```

## Comms Board

The whole section was inert and the heading was removed with it.

```js
  { id: 'board_mode', section: 'Comms Board', name: 'Default board mode', desc: 'Open the comms page as one single timeline, or as a board per channel.', depth: 1, type: 'seg', options: ['timeline', 'channels'], def: 'timeline' },
  { id: 'pin_owner_messages', section: 'Comms Board', name: 'Pin owner messages', desc: 'Keep your own instructions pinned in view as new messages stream past.', depth: 1, type: 'toggle', def: true },
  { id: 'show_machine_tags', section: 'Comms Board', name: 'Machine tags', desc: 'Show which computer each message came from, next to the message.', depth: 1, type: 'toggle', def: true },
  { id: 'channel_density', section: 'Comms Board', name: 'Channel density', desc: 'How tightly packed the channel list on the left is.', depth: 2, type: 'seg', options: ['calm', 'dense'], def: 'calm' },
  { id: 'packet_highlight', section: 'Comms Board', name: 'New-message highlight', desc: 'Flash a message briefly as it arrives on the board.', depth: 2, type: 'toggle', def: true },
  { id: 'lane_arrival_hold', section: 'Comms Board', name: 'Arrival hold', desc: 'How long new activity stays highlighted before fading back to normal.', depth: 3, type: 'range', min: 0, max: 1600, step: 50, unit: 'ms', def: 450 },
  { id: 'comms_queue_fairness', section: 'Comms Board', name: 'Queue fairness', desc: 'When several channels are equally busy, how evenly the demonstration spreads new messages between them (its fairness coefficient).', depth: 4, type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 50 },
```

## Ledger

One row in this section worked and stayed: `ledger_archive`, which is an action rather than a stored value.

```js
  { id: 'ledger_register', section: 'Ledger', name: 'Open the ledger on', desc: 'Which list the ledger opens with: requests (R items) or questions (Q items).', depth: 1, type: 'seg', options: [['r', 'R items'], ['q', 'Q items']], def: 'r' },
  { id: 'expand_evidence', section: 'Ledger', name: 'Expand evidence', desc: 'Show a record’s evidence line as soon as you open it, without a second click.', depth: 1, type: 'toggle', def: false },
  { id: 'show_done', section: 'Ledger', name: 'Show completed items', desc: 'Keep finished requests visible in the list instead of hiding them.', depth: 1, type: 'toggle', def: true },
  { id: 'ledger_age_format', section: 'Ledger', name: 'Age format', desc: 'How a request’s age is shown: elapsed time (“3 h”), the exact time it was claimed, or both.', depth: 2, type: 'select', options: ['elapsed', 'claimed-at', 'both'], def: 'elapsed' },
  { id: 'root_rollup', section: 'Ledger', name: 'Root rollups', desc: 'On a request that was split into sub-items, show a summary of how the sub-items are doing.', depth: 2, type: 'toggle', def: true },
  { id: 'gate_signal_hold', section: 'Ledger', name: 'Gate signal hold', desc: 'How long a request keeps its “gated” emphasis after the gate changes state.', depth: 3, type: 'range', min: 0, max: 24, step: 1, unit: 'h', def: 4 },
  { id: 'collision_row_hysteresis', section: 'Ledger', name: 'Collision-row hysteresis', desc: 'How close a row’s columns may get before it re-arranges itself — the wait (hysteresis) stops flickering.', depth: 4, type: 'range', min: 0, max: 32, step: 1, unit: 'px', def: 8 },
```

## Performance

The whole section was inert and the heading was removed with it.

```js
  { id: 'power_profile', section: 'Performance', name: 'Power profile', desc: 'Trade snappiness against battery and background work.', depth: 1, type: 'seg', options: ['balanced', 'quiet'], def: 'balanced' },
  { id: 'chart_quality', section: 'Performance', name: 'Chart quality', desc: 'How finely charts are drawn. High looks sharper and uses more battery.', depth: 1, type: 'seg', options: ['standard', 'high'], def: 'standard' },
  { id: 'background_updates', section: 'Performance', name: 'Background updates', desc: 'Let pages you are not looking at keep their demonstration data ticking.', depth: 1, type: 'toggle', def: true },
  { id: 'graph_frame_cap', section: 'Performance', name: 'Graph frame cap', desc: 'Cap how many frames per second the agent map animates at.', depth: 2, type: 'select', options: [['30', '30 fps'], ['60', '60 fps'], ['auto', 'Adaptive']], def: 'auto' },
  { id: 'data_history', section: 'Performance', name: 'In-memory history', desc: 'How many minutes of demonstration samples the open charts keep in memory.', depth: 2, type: 'range', min: 5, max: 120, step: 5, unit: 'min', def: 30 },
  { id: 'reflow_debounce', section: 'Performance', name: 'Reflow debounce', desc: 'How long the layout waits during rapid window resizing before refitting itself.', depth: 3, type: 'stepper', min: 0, max: 240, step: 10, unit: 'ms', def: 40 },
  { id: 'layer_promotion_threshold', section: 'Performance', name: 'Layer-promotion threshold', desc: 'How many moving things it takes before a panel gets its own graphics layer (a rendering optimization).', depth: 4, type: 'stepper', min: 1, max: 64, step: 1, unit: 'nodes', def: 12 },
```

## Data & Sim

This section kept `scenario_tick_rate` and the seven `live_*` rows, all of which work.

```js
  { id: 'seed_mode', section: 'Data & Sim', name: 'Seed mode', desc: 'Whether the demonstration replays the same history every time (stable) or varies it (varied).', depth: 1, type: 'seg', options: ['stable', 'varied'], def: 'stable' },
  { id: 'retain_samples', section: 'Data & Sim', name: 'Retain samples on navigation', desc: 'Keep a page’s demonstration data when you navigate away and come back.', depth: 1, type: 'toggle', def: true },
  { id: 'event_variance', section: 'Data & Sim', name: 'Event variance', desc: 'How bursty the demonstration workload looks: steady, or arriving in waves.', depth: 2, type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 35 },
  { id: 'failure_rate', section: 'Data & Sim', name: 'Practice problems', desc: 'How often the demonstration shows a problem it recovers from, as a percentage. It is there so the screens have something to show.', depth: 2, type: 'range', min: 0, max: 20, step: 1, unit: '%', def: 3 },
  { id: 'sample_bucket', section: 'Data & Sim', name: 'Sample bucket width', desc: 'How many seconds of raw demonstration ticks are grouped into one chart point.', depth: 3, type: 'stepper', min: 1, max: 60, step: 1, unit: 's', def: 5 },
  { id: 'sim_worker_tick_bias', section: 'Data & Sim', name: 'Sim worker tick bias', desc: 'Whether the demonstration favors the freshest data or does more work per batch.', depth: 4, type: 'range', min: -100, max: 100, step: 5, unit: '%', def: 0 },
```

## Developer

The whole section was inert and the heading was removed with it.

```js
  { id: 'diagnostic_labels', section: 'Developer', name: 'Diagnostic labels', desc: 'Show small internal component names beside live surfaces, useful for reporting a problem precisely.', depth: 1, type: 'toggle', def: false },
  { id: 'log_level', section: 'Developer', name: 'Console detail', desc: 'How much diagnostic detail the demonstration writes to the console.', depth: 1, type: 'seg', options: ['quiet', 'normal', 'verbose'], def: 'normal' },
  { id: 'copy_ids', section: 'Developer', name: 'Copy stable identifiers', desc: 'When you copy a row, agent, or channel, copy its permanent ID rather than its display name.', depth: 1, type: 'toggle', def: true },
  { id: 'expose_timings', section: 'Developer', name: 'Expose render timings', desc: 'Show how long each screen took to draw, in development-only readouts.', depth: 2, type: 'toggle', def: false },
  { id: 'mock_failures', section: 'Developer', name: 'Show practice problems', desc: 'Let a pretend problem appear on a screen that is actually healthy, so you can see what this program does when something goes wrong.', depth: 2, type: 'toggle', def: false },
  { id: 'observer_budget', section: 'Developer', name: 'Observer callback budget', desc: 'The soft time limit for one internal resize or layout callback, in milliseconds.', depth: 3, type: 'stepper', min: 1, max: 24, step: 1, unit: 'ms', def: 8 },
  { id: 'tier_guide_hairline_alpha', section: 'Developer', name: 'Tier-guide hairline alpha', desc: 'How faint the thin guide lines between the map’s levels are (their alpha).', depth: 4, type: 'range', min: 1, max: 20, step: 1, unit: '%', def: 7 },
```

---

## One consequence worth knowing

A person who moved any of these rows off its default already has an
`mc.set.<id>` key stored for it. Those keys are now orphans: nothing writes
them and nothing reads them. They are harmless, but when signed in they are
still counted by the Account page's "N recorded against this account" sentence
(`shell/product-account.cjs` → `src/account-markup.js`), because that count is
a count of `mc.set.*` keys by prefix and does not consult the catalogue. A
cleanup pass would need to reconcile stored keys against declared rows, and is
deliberately NOT part of this change — it deletes stored user data, which is a
separate decision from removing a control.
