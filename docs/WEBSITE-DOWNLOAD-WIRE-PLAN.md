# Website: verification by use, and the download wire plan

R1260 T5.1 · Machine A · 2026-08-11
App tree base SHA `9723d2e9fe2f62e651e2a66c917cb6b386853b72` (branch `packaging/capability-layer`)

**Scope fence honoured: nothing was published, no DNS or hosting was touched, and no
candidate was declared. This document plans a wire; it does not connect one.**

---

## 1. The headline, in the owner's terms

R1113 says *"The website is functionally ready you can take a look."* Driven as a
stranger, that is **true of the demo and false of the website**.

The software renders and behaves honestly in a browser. But there is **no download
anywhere on it**, and the home page tells a first-time visitor:

> Open ToolsEnabled on your computer to see what has run there
> ...
> ToolsEnabled shows the agents that have run on a computer. **Open the installed app to see them.**

A stranger is instructed to open an application they do not have, from a page that
offers no way to get it. That is the gap T5.1 exists to close, and it cannot be
closed today because **there is no declared candidate to point at** (section 4).

---

## 2. How this was measured

Not asserted — driven. The built site was served and driven in a **plain Chromium
browser context with no Electron preload, no shell bridge and no node integration**,
which is exactly what a website visitor gets. Existing harnesses in this repo all
drive the app *with* its shell, so none of them ask this question.

| Step | Command | Result |
|---|---|---|
| Build | `node node_modules/vite/bin/vite.js build` | **exit 0**, 5.78 s, 743 modules |
| Serve | `vite preview --port 4699 --strictPort` | HTTP 200, 7 411 bytes |
| Drive | `electron tools/website-stranger-drive.mjs` | **exit 0**, 32.3 s, **12/12 routes measured**, `VACUOUS=false` |
| Dwell | `electron tools/website-approvals-dwell.mjs` | **exit 0**, 21.2 s |
| Wire guard | `node tools/check-download-wire.mjs dist` | **exit 0**, 117 ms, 36 files, 0 offers |

All exit codes read bare, never through a pipe.

Two environment hazards were hit and are recorded so the next lane does not lose time:

- **`ELECTRON_RUN_AS_NODE=1` is set in the agent environment.** Electron silently runs
  as plain node and the harness looks like it did nothing. It must be scrubbed.
- **A bare URL passed as an Electron argv makes the binary exit `-1`** before the main
  process runs at all — no stdout, no stderr. Measured: same script with `plainarg`
  exits 0, with `http://localhost:4699` exits −1. The harness therefore takes its
  configuration from the environment. A harness that took the URL positionally would
  have looked like a silent pass to any caller reading stdout.

---

## 3. What works, and what does not

### Works — verified by use

1. **All 12 routes load. None is blank.** `home, computers, comms, ledger, metrics,
   research, settings, setup, account, approvals` all render; `checkout` and `agent`
   redirect to home by design (`stopIsOffered` / missing params).
2. **Browser-mode honesty is genuinely implemented and it is good.** Home, computers,
   account and setup each detect the absent shell and say so in plain language rather
   than failing or faking: *"This page is running in a browser, not the installed app."*
3. **Fabricated data is not presented as live.** Metrics shows `—` and `unavailable`
   for every tile with *"live projection unavailable · No local agent fleet host
   detected on this machine."*
4. **Demo data is labelled.** *"Demonstration data. Nothing in it is running on this
   computer."*, *"sample board — demonstration traffic, not a live fleet"*, and
   *"Terminate unavailable in simulated mode; no live bridge request will be sent."*
5. **Controls that cannot work are disabled with a reason**, not dead: fleet editing is
   disabled with *"The hierarchy cannot be edited here…"*, and setup's **Continue** is
   disabled under *"This copy cannot record a permission level."* That is fail-closed.
6. **The rename is clean.** Zero occurrences of the pre-rename product name across all
   12 routes' markup. Title reads `home · ToolsEnabled`.
7. **Approvals fail-closes correctly**: *"The queue could not be read, so nothing here
   is a decision."*
8. Theme (White/Tan/Black) and text-size controls render and are reachable.

### Does not work — enumerated

| # | Finding | Severity | Evidence |
|---|---|---|---|
| W1 | **No download surface exists anywhere.** 0 download controls across 12 routes. Confirmed at artifact level: the only `download` token in the built bundle is `a.download` in a JSON-blob export helper, and all 13 `.exe` hits are `.exec(` regex false positives. | **Blocking for launch** | `dist/assets/index-*.js` |
| W2 | **No landing page.** The site drops a stranger straight into the product dashboard — no statement of what ToolsEnabled is, no features, no pricing, no download. R1090 asked for "a website with a demo"; the demo exists, the website around it does not. | **Blocking for launch** | route `#/` innerText is 280 chars, all of it browser-mode copy |
| W3 | **Every visitor's browser is made to probe its own localhost.** The page fetches `http://127.0.0.1:4610/v1/runtime`; on a public deployment that resolves to *the visitor's* machine. Blocked by CORS here, producing a console error on `#/` and `#/approvals`. Published as-is this is a per-visitor console error, a fingerprinting-adjacent behaviour, and an AV/proxy flag risk. | **Serious** | CORS errors captured on 2 routes |
| W4 | **Approvals takes 18–20 s to fail closed.** Sampled every 2 s: `LOADING` at t+2 s through t+18 s, `RESOLVED` by t+20 s. The end state is correct and honest; the wait before it is not. | **Serious** | `artifacts/website-stranger/approvals-dwell.json` |
| W5 | **No Content-Security-Policy.** Chromium raised the insecure-CSP warning. Acceptable in a local shell, a real hardening gap on a public origin. | **Moderate** | console warning on `#/` |
| W6 | `#/checkout` silently redirects to home, so the website has **no purchase path**. | **Moderate**, by design today | `bodyRoute=home` for `#/checkout` |
| W7 | The preview server binds **IPv6-only** (`[::1]`); `127.0.0.1` refused. A deployment note, not a product defect. | **Low** | `netstat` |

---

## 4. Why the download cannot be wired today

**There is no declared candidate.** This is not my inference — it is Machine A's own
coordinator record, `MACHINE-A-INSTALLER-CANDIDATE\DO-NOT-DECLARE-THESE-README.md`
(2026-08-11 20:20Z):

> **No file in this folder is a candidate.** Not the newest, not the largest.

Measured state of every binary a wire could plausibly point at:

| Location | Why it is not wireable |
|---|---|
| `MACHINE-A-INSTALLER-CANDIDATE\1.0.2`, `1.0.4` | Have declarations, but carry the **pre-rename** identity `Mission Control`, which `check-product-naming.mjs` now refuses |
| `MACHINE-A-INSTALLER-CANDIDATE\1.0.3`, `1.0.5` | **No declaration file at all** — no recorded byte count, no SHA-256 on a frozen copy, no build ref |
| `MACHINE-A-INSTALLER-DECLARATION.md` | Declares `Mission Control Setup 1.0.1.exe`, appId `com.toolsenabled.missioncontrol` — superseded by the rename |
| `wt-capability\release\ToolsEnabled Setup 1.0.6.exe` | Built from a **dirty tree**; asar stamped `dirty:true, overridden:true`; `cut-release-candidate.mjs:356` refuses it. That refusal is the gate working |

Pointing a public download at any of these would hand strangers a build nobody can
reproduce from git history. **The correct action today is the one the site already
takes: offer no download.**

---

## 5. The wire plan

### 5.1 The principle

> **The download surface is driven by a declaration, never by a path.**

A path is the wrong anchor because the build directory reuses one filename per build,
so a hash quoted against it expires on the next rebuild **and nothing in the filename
changes to say so**. A declaration is frozen, hashed on the frozen copy, and carries
its own build ref.

Corollary, and the reason this is a control and not a convention: **no declaration ⇒
no download surface.** Absence must refuse, not default to "show the button anyway".

### 5.2 The contract

`public/download.json`, emitted into `dist/` at build time, carrying exactly the fields
Machine B's acceptance-matrix *Immutable declaration* row requires:

```json
{
  "filename": "ToolsEnabled Setup <version>.exe",
  "version": "<semver>",
  "bytes": 0,
  "sha256": "<64 hex, taken on the FROZEN copy>",
  "productName": "<ProductName measured from the frozen PE>",
  "fileVersion": "<FileVersion measured from the frozen PE>",
  "productVersion": "<ProductVersion measured from the frozen PE>",
  "buildRef": "<full 40-char commit ref>",
  "publisher": "ToolsEnabled, Inc. in formation",
  "appId": "com.toolsenabled.desktop",
  "immutableLocation": "<frozen path OUTSIDE any build output directory>"
}
```

### 5.3 The control, already built and proven

`tools/check-download-wire.mjs` (+ `tools/test/download-wire.test.mjs`, 30 tests) enforces:

1. **Absence first** — a download offer with no declaration **refuses**.
2. Every required field present, non-empty and correctly shaped. A missing field and an
   empty field are tested **separately**, because they are two different ways to say
   nothing and a guard can catch one and miss the other.
3. An abbreviated `buildRef` or truncated `sha256` refuses.
4. `immutableLocation` pointing into `release/`, `dist/`, `out/` or `build/` refuses.
5. Declared bytes and SHA-256 must match the real file when it is reachable.
6. ProductName, FileVersion and ProductVersion must be read from that PE and match the
   manifest exactly; both embedded versions must identify the manifest release.
7. A malformed declaration refuses rather than being silently skipped.
8. **Vacuity guard** — a scan that saw zero files refuses success.
9. It does **not** flag the `a.download` blob-export idiom already in the bundle. A
   guard that cries wolf gets switched off, and then it protects nothing.

**Mutation-proven, not asserted.** The absence-read-as-consent defect was planted
(missing-field branch made a no-op):

| Stage | SHA-256 of guard | Suite |
|---|---|---|
| Before | `52D727F7…2180` | exit **0**, 30/30 pass |
| Planted | `FD241979…24A6` (plant confirmed landed) | exit **1**, **8 fail**, each naming `REFUSES when required field "<x>" is ABSENT` |
| Restored | `52D727F7…2180` — **byte-identical** | exit **0**, 30/30 pass |

The other 22 tests stayed green under the plant, so the kill was surgical rather than a
blanket break. `node tools/check-suites-discovered.mjs` exits **0** at 95/95, so this
suite is genuinely reached by the runner rather than landing outside it.

### 5.4 Order of operations (none of this is authorised by T5.1)

1. **Coordinator serialises both trees** so `require-clean-tree.mjs` exits 0. Currently
   red — the tree cannot state its own provenance while ~8 lanes hold it dirty.
2. `npm run pack:capability`, then `check-payload-current.mjs` exits 0.
3. Full `npm run dist` chain green.
4. **Freeze the installer out of `release/` first**, verify the copy byte-identical,
   and hash **only the frozen copy**.
5. Run packaged QA against the isolated build's own `release/win-unpacked`, never a
   pre-existing shared output directory.
6. Generate `download.json` from the frozen copy as the third artifact emitted from the
   same measured facts as `DECLARATION.md` / `declaration-facts.json`.
7. Add the download control to the landing surface (W1/W2) — **this is a design task
   that does not exist yet and is not in T5.1's fence.**
8. `node tools/check-download-wire.mjs dist --candidate-root <frozen dir>` must exit 0.
9. Only then does publishing become a separate, separately-authorised decision.

### 5.5 Fix W3 before any public deployment

The `127.0.0.1:4610` runtime fetch must be **suppressed on a non-loopback origin**. On a
public site it makes every visitor's browser probe their own machine. This is the one
finding here that gets worse rather than merely staying broken once the site is public.

---

## 6. What I did not do

- Did not publish, deploy, or touch DNS or hosting.
- Did not declare a candidate or create `download.json`.
- Did not add a download control — that is a design task outside this fence.
- Did not modify the shared trees; all work is in a detached worktree.
