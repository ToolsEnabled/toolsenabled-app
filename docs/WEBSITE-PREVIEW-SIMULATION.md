# The website's embedded product simulation

R1268 lane W1. Written 2026-08-11 by the lane that built it.

**The owner's shape for this surface, verbatim:** *"no need for preview of paid
services. just offer a preview / embedded simulation of the product on the website.
make the paid versions work when paid and make a nice subscription page for signing up"*

Two of those four clauses are other lanes'. This document is only the first one:
**a preview / embedded simulation of the product, on the website.**

---

## 1. What it is, and what it deliberately is not

`public/preview/` is a **self-contained page** that ships in the site build at
`/preview/`. It runs the product's core surfaces — the fleet tree, an agent
drill-in, the approvals queue, spend, and the record — from data generated in the
visitor's own browser from a fixed seed.

**It is not the application served in a browser.** That already exists: `dist/`
is the renderer, and R1260 lane t5a drove it as a stranger and reported the
result honestly — the software behaves well in a browser, but the site "drops a
stranger into the product dashboard" with no landing, no download, and every
panel correctly fail-closed to `—` because there is no shell behind it. A
fail-closed dashboard is the right behaviour and the wrong advertisement. A
buyer needs to see the product *working*.

**It is not an installable preview.** The download is the real, full product. The
owner corrected two earlier readings to land there. Nothing in this lane builds a
crippled build.

**It does not preview a paid capability.** The engine's gated set
(`src/lib/entitlement.js` `GATED_CAPABILITIES`) has exactly one member today,
`hosted-relay`, and what it sells is infrastructure we operate — not a feature.
There is nothing about a plan to demonstrate, and `assertUnpaid()` refuses to
render a capability card for anything in that set or for anything not on the
preview's own declared list.

### Why a separate page rather than a route in the app

| | the app at `/` | the preview at `/preview/` |
|---|---|---|
| JavaScript over the wire | 1 321 KB | 45 KB |
| CSS | 209 KB | 15 KB |
| total, measured | ~1.5 MB | **72 KB** |
| requests | dozens | **7** |
| navigation → painted surface | not measured here | **147–212 ms** |

The owner's standing weak-PC directive is the reason that table decides it. The
preview has no framework, no bundler step, no canvas, and no chart library: six
ES modules and one stylesheet, all static, all same-origin. It is also the
reason the tokens in `preview.css` are a **copy** of the product's rather than an
import — a file under `public/` ships verbatim and cannot reference the bundled
stylesheet. The copy is not allowed to drift: `tools/test/preview-honesty.test.mjs`
reads the role palette out of `src/styles.css` and fails when the six hexes stop
matching.

---

## 2. The honesty property, and why it is mechanical

Machine B raised the defect this is built against: **a green "live" indicator
painted over seeded data**, which makes fabricated activity look like a real
fleet doing real work. R1260 t5a re-measured it and reported honestly that it was
*"materially improved, not cleared"*, naming the open half as their weakest
evidence — whether a live badge can still sit over fabricated numbers.

A comment does not close that. A label somebody remembers to add does not close
it either, because forgetting is the failure mode. So the marking is a
**rendering-level property** in five parts, and each one fails the SURFACE rather
than logging a warning. All five live in `public/preview/honesty.js`.

1. **There is no live vocabulary to draw from.** `stateChip()` is the only way to
   paint a state and it accepts ids from `SIMULATED_STATES` only — every id in
   that frozen set begins `simulated-`, and every visible label begins
   `simulated · `. `stateChip('live')` throws. A renderer cannot paint a live
   state because the function that paints states has no such state.

2. **Unmarked data cannot appear.** `simValue()` is the only way to write a datum
   and it stamps `data-sim="1"`. The audit walks every data region and any text
   not inside a marked element is a violation. Hand-writing a number into the
   markup breaks the page instead of shipping.

3. **A liveness claim anywhere refuses the surface.** Text matching
   `LIVENESS_CLAIM`, or any element matching `LIVENESS_MARKERS` (`.live-dot`,
   `[data-status="live"]`, … — a dot has no words and still makes a claim),
   replaces the whole preview with a named refusal. The one exception is the
   disclosure banner, whose text is asserted to be **exactly** `DISCLOSURE`: the
   only node allowed to say the word is the one that says nothing is live.

4. **The marking cannot be removed at runtime.** A `MutationObserver` re-audits
   on every change, so deleting the banner or injecting a badge after mount
   produces the same refusal as authoring one. The refusal is **terminal** — it
   stops the clock, because a control the next repaint undoes is not a control.

5. **A paid capability is refused, and so is an unknown one.** `assertUnpaid()`
   mirrors the engine's closed gated set. An id in neither the gated list nor the
   preview's declared list is an *absence*, and absence is withheld and named.

There is no state in which a visitor sees fabricated activity plus a warning
about it. **The fabricated activity is what gets withheld.**

`tools/check-preview-honesty.mjs` is the second half, at build time, and it
polices three things the runtime guard structurally cannot: an authored claim on
a branch no browser happened to reach, any mention of a paid capability, and any
egress at all (absolute URL, socket constructor, loopback address, browser
storage, beacon). Exit codes follow `check-no-owner-data.mjs`: 0 clean, 1 a
finding, 2 a setup problem — and **an empty scan is a setup problem, not a clean
sweep**.

---

## 3. The two ways out, and why neither is a plain link

A preview that convinces has to lead somewhere. The lazy version is two anchors
pointing at paths somebody hopes exist, which ships a 404 to the one visitor who
was ready to buy — silently, because a dead link looks exactly like a working one
until it is clicked.

Both exits are **declared and then verified** (`public/preview/exits.js`):

- **Download.** Needs a complete build declaration: product, version, the full
  40-hex commit, the full 64-hex sha256, a positive integer byte size, and an
  **immutable** location — never inside a build directory, because a build
  directory reuses one filename and a hash quoted against it expires on the next
  rebuild with no change to the name. This is the contract from
  `docs/WEBSITE-DOWNLOAD-WIRE-PLAN.md` (R1260 t5a), whose rule is the one that
  matters: **no declaration ⇒ no download surface.**

- **Subscription.** Needs a path, and something static that proves the surface is
  in this build. R1268 lane W3 builds the subscription page as a **route inside
  the application shell** (`#/subscribe`) — measured in their worktree, not
  assumed — and a hash route **cannot be probed**: `fetch()` drops the fragment,
  so probing `/#/subscribe` requests `/`, which answers 200 on every deployment
  that has ever existed. The control would light up whether or not the page
  shipped. A check that cannot fail is not a check, and it is precisely the
  absence-read-as-consent shape this codebase keeps finding.

  So the declaration carries two fields: `href` (where a buyer is sent) and
  `probe` (a static artifact whose presence proves the surface shipped, defaulting
  to `href` when they are the same thing). The probe is W3's subscription
  catalogue, because the page cannot render plans without it. A declaration that
  is a route with no probe fails closed and says so.

**Today `DECLARED.download` is null on purpose.** There is no declared installer
candidate on this machine — t5a measured it, and Machine A's own candidate folder
says so in writing. The preview therefore shows a disabled control carrying the
reason in words. When a candidate is declared, filling that object in is the
whole wiring job, and `tools/test/preview-honesty.test.mjs` is the place that
notices it changed.

`DECLARED.subscribe` is `{ href: '/#/subscribe', probe: '/data/subscription-catalog.json' }`.
**That is a cross-lane dependency on R1268 W3.** If they land the catalogue under
a different name, that one constant moves and nothing else does. Until it resolves,
the control is disabled and says *"That page is not part of this build yet"* —
which is why the coordinator can merge the two lanes in either order without
either one shipping a dead link.

---

## 4. How to run it

```
node node_modules/vite/bin/vite.js build          # public/preview -> dist/preview
node tools/check-preview-honesty.mjs              # 0 clean · 1 finding · 2 setup
node --test tools/test/preview-honesty.test.mjs   # 52 tests
node tools/check-renderer-payload.mjs             # every preview file classified
node tools/check-no-owner-data.mjs public/preview
```

The browser drive needs Electron and takes its configuration from the
environment, never from argv — a bare URL as an Electron argv makes the binary
exit −1 before main runs, with no stdout and no stderr:

```
$env:CONTROLLER_DELEGATED="1"
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process .\node_modules\electron\dist\electron.exe `
  -ArgumentList "tools\preview-browser-drive.mjs" -Wait -PassThru -NoNewWindow
```

It asserts 148 things across 1024 and 1920, writes screenshots and `drive.json`
to `artifacts/preview-drive/`, and exits non-zero on any failure, on a vacuous
run, or on a hang.

### Three traps the harness had to be taught, recorded so the next one is not

1. **`app.exit(1)` returned 0.** Called after the app had begun quitting on its
   own, it produced exit code 0 with four assertions failing. `process.exit` is
   used instead. A harness that reports success while failing is worse than none.
2. **`capturePage()` on a hidden window returns the last painted frame.** The
   first pass wrote a file called `preview-1024-theme-tan.png` showing the WHITE
   theme, beside an assertion that correctly read `rgb(242,229,188)` off the DOM
   — green assertions, lying evidence. The window is shown now, and every capture
   is pixel-checked against the theme it claims to show.
3. **A hang is not a pass.** One run wedged inside `loadURL` and sat there until
   the caller's timeout, leaving silence and a green log of everything before it.
   There is a watchdog, a bound on every browser await, and a breadcrumb naming
   the phase.

---

## 5. What this lane did not do

No landing page (that is the W2-shaped gap t5a recorded as blocking, and it is
not this lane's fence). No subscription page. No entitlement or licence code. No
download wiring, because there is no declaration to wire. Nothing published,
deployed, or made publicly reachable.
