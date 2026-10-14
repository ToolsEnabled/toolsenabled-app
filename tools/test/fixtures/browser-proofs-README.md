# Browser proofs: the `run-*.mjs` family

Every `tools/test/fixtures/run-*.mjs` file paints part of the product in a real, headless Chromium through Playwright and judges what it sees. These are the only proofs for facts a DOM stand-in cannot supply: painted geometry, computed styles, real pointer and keyboard input. None of them is a unit suite and none of them is started by `npm test`.

`tools/test/fixtures/browser-proofs.json` declares each driver as exactly one of three coverage classes, and `node tools/check-browser-proofs-discovered.mjs` (a gate in `npm test`) fails by name on any driver that is not declared, on any declaration whose file is gone, and on any malformed declaration. Declaration is not execution: the guard says so on every line it prints.

| class | meaning | counted as coverage? |
|---|---|---|
| `required` | a release qualification must verify an attributable receipt from one real execution | only with that receipt |
| `manual` | hand-run by the named owner or document when its surface changes | never |
| `platform-limited` | runnable only on the named platform | never |

## Receipts for required proofs

A required proof discharges a ledger item (today: `run-buttons-carry-app-style.mjs` for T35, the owner-reported unstyled controls). The driver writes `results.json`, which now carries its own identity (`driver.file`, `driver.sha256`), `platform`, `arch`, `origin` and `startedAt`. Release qualification runs

```sh
node tools/check-browser-proofs-discovered.mjs --receipts private/browser-proof-receipts
```

against the candidate checkout and expects `private/browser-proof-receipts/<driver stem>/results.json` for every required proof. A receipt is accepted only when its recorded driver sha256 equals the driver bytes in that checkout, its origin is a loopback server, its errors list is empty, its checks list is nonempty and no request left the origin. Anything else is reported as `missing-required-browser-proof`, `unreadable-browser-proof-receipt`, `unattributable-browser-proof` or `failed-browser-proof`, and the qualification is red. There is no skip, waiver or baseline for a required proof. `private/` is git-ignored; a receipt never enters the source tree.

## Running the family on Linux

The drivers are not Windows-specific; only their older instructions were. From the checkout root, with its Node dependencies available:

1. Serve the tree on a loopback origin. `npm run dev:renderer` serves it at `http://127.0.0.1:4600`, which is the family's default `BENCHMARK_TEST_ORIGIN`. The `run-tree-*.mjs` drivers start their own loopback Vite server and need no origin.
2. Point the driver at a Playwright package that has its Chromium installed (`npx playwright install chromium` in that package's checkout). The `run-research-*.mjs` and `run-buttons-*.mjs` drivers read `MC_PLAYWRIGHT_ROOT` (the package directory or entry module); the `run-tree-*.mjs` and Page 2 native drivers read `PLAYWRIGHT_MODULE`. Chromium runs headless, so no display server or Xvfb is needed.
3. Send output to a scratch directory outside every product profile: `BENCHMARK_TEST_OUTPUT=<scratch>/<driver stem>`. Never point a driver, a state root or a vault path at a running installation's private profile; the drivers never read one, and a measurement engine that inherits `TOOLSENABLED_STATE_ROOT` from an agent shell has already written into the live audit ledger once (F-2026-0910-005).

For example, the required proof:

```sh
MC_PLAYWRIGHT_ROOT=<playwright package> \
BENCHMARK_TEST_ORIGIN=http://127.0.0.1:4600 \
BENCHMARK_TEST_OUTPUT=<scratch>/run-buttons-carry-app-style \
node tools/test/fixtures/run-buttons-carry-app-style.mjs
```

Exit 0 with a `results.json` means no visible control painted as the browser default; exit 1 names each one. To hand the receipt to a qualification, copy that `results.json` to `private/browser-proof-receipts/run-buttons-carry-app-style/results.json` in the candidate checkout whose driver bytes produced it.

The two `platform-limited` drivers keep their own instructions: `page2-layout-README.md` (Windows development account) and `page2-zoom-linux-README.md` (Linux, takes a Chromium binary path). The `run-research-*.mjs` family is described in `docs/research-benchmark-builder.md` and belongs to the Research lanes; the `run-tree-*.mjs` family in `docs/NATIVE-DEVELOPMENT.md`.

## What this does not do

It does not run any driver. A green `npm test` says every driver is declared, not that any proof was executed; only the receipts mode above, run by a qualification against the exact candidate, turns a required proof green, and only for the tree whose driver bytes it names.
