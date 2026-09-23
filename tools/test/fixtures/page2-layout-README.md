# Isolated Page 2 layout proof

Run `node tools/test/fixtures/run-page2-layout.mjs C:\Users\ToolsEnabled-Dev\AppData\Local\Temp\page2-layout-proof-<unique-suffix>` on the permitted Windows account.

This renderer-only fixture uses installed headless Chrome, an explicit fresh browser profile, a private loopback Vite server, and no application shell. Requests outside that server are blocked. It does not open LIVE, read its state, authenticate, or start providers. It writes screenshots and `measurements.json` beneath the supplied Temp directory.

Checks cover all three themes and offered text sizes: streaming/settled row separation, original-shrink negative control, bounded preview cards, long paths/code, keyboard disclosure, selection inside details, manual zoom preservation, and a compact viewport. A synthetic 1,000-node tree must retain its full model, reveal an initially culled `node-999` through hit-tested pointer clicks, and return to the complete overview. Timings describe this machine and run only, not 1,000 running processes or old-PC capacity.

The normal Node suites in `chat-output-layout.test.mjs` and `tree-graph.test.mjs` exercise the corresponding deterministic contracts. This fixture supplies the browser layout measurements those DOM stand-ins cannot provide. These are source-renderer screenshots; the integrated packaged application still needs its own acceptance check.

This driver is declared `platform-limited` (win32) in `browser-proofs.json`. For the whole `run-*.mjs` family, its coverage classes and how to run the family on Linux, read `browser-proofs-README.md`.
