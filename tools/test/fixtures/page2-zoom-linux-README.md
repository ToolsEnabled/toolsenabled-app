# Isolated Linux Page 2 zoom verification

From the repository root, with its existing Node dependencies available:

```sh
node tools/test/fixtures/run-page2-zoom-linux.mjs /absolute/path/to/chrome
node --test tools/test/tree-graph.test.mjs tools/test/tree-zoom-drill-reachable.test.mjs
```

The runner creates a new `/tmp/page2-zoom-linux-*` artifact directory and fresh Chromium profile. It uses a loopback Vite server (the actual chosen origin is recorded in requests), blocks page requests outside that origin, and launches Chromium with a minimal environment and isolated HOME/config/cache. It does not run the application shell, read live application/browser profiles, or invoke providers. The supplied executable must be a Linux Chromium binary. Vite cache is stored beneath the new artifact directory. SIGINT/SIGTERM and normal completion await teardown of the isolated browser process group and server. HMR and file watching are disabled so edits cannot invalidate an ongoing measurement.

The synthetic renderer imports production tree graph and text-size code. Twelve cases cover sparse (5) and dense (1,000) models, text sizes 0.9/1/1.12, and toolbar versus host fallback control placement. Pointer input uses CDP at button centers after `elementFromPoint` inspection, including obscured targets; it never calls `.click()` or graph zoom methods. Keyboard +/-/0 input goes to a production focusable graph node. Enter activates the focused zoom button. A separate +/-/0 sequence with toolbar button focus tests the sibling-toolbar event path, starting from an Enter-zoomed view so reset must change it. Native Space activates plus, minus, and reset with exact single-step assertions in both placements. A pointer reset after keyboard zoom verifies reset independently of blocked +/- controls.

Each case records before/after zoom, pan, inline/computed transforms, button rectangles, hit element, readout, focus, and model counts. Six screenshots per case record initial, pointer steps, and final keyboard/reset states. `measurements.json` includes browser version, source HEAD/status/diff provenance, exceptions, requests, and individual assertion failures; provenance is also saved before launch. Every recorded action must have painted matrix scale and readout consistent with zoom. Every reset must start displaced and restore initial zoom/pan within 0.001 CSS pixels/scale units. Blocked page requests fail the run. These page-target records do not establish whole-browser egress isolation; imported renderer dependencies include bridge modules, but the live shell and providers are not invoked. `browser-stderr.log` is diagnostic only. Exit 1 means at least one regression assertion failed; all cases still run to collect evidence.

This is an isolated renderer regression/reproduction lane, not packaged-app acceptance. A toolbar pass does not establish that every live layout uses the same geometry. The host fallback is the placement used by the existing page2-layout fixture when no graph toolbar exists.

Snapshots also record branch identity and visible/total agent counts. Toolbar shortcuts must either change zoom in the requested direction or cross into/out of a branch and reset to zoom 1. Three additional scenarios prepare the same real rooted layout and dispatch pointer minus, toolbar keyboard minus, or wheel-out. Each must restore the full tree and paint the reset scale; a subsequent wheel-out must continue zooming without stranding a branch. Branch preparation uses the production layout API; the tested input uses CDP.

Negative controls deliberately return exit 1 and run one bar/5/1 case:

```sh
node tools/test/fixtures/run-page2-zoom-linux.mjs /absolute/path/to/chrome --negative-control=freeze
node tools/test/fixtures/run-page2-zoom-linux.mjs /absolute/path/to/chrome --negative-control=blocked
```

The freeze control fixes the graph's painted transform before Enter while model zoom can still change; visual assertions must reject it. The blocked control attempts a reserved invalid-domain page fetch, which interception denies and the network gate rejects. Negative-control selection is recorded in provenance.
