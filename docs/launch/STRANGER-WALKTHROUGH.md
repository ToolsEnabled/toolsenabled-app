# The stranger walkthrough

What a person who has never seen this product actually meets, in order, and what stops
them. Written 2026-08-12 against this working tree (`packaging/capability-layer`).

**This is a paper walk plus code reading.** No installer was run, nothing was built, and
no machine was changed. One read-only measurement was taken:
`Get-AuthenticodeSignature "release\ToolsEnabled Setup 1.0.6.exe"` → **NotSigned**.

The launch gate is: *find it, understand it, install it, reach a running agent — proven
on a machine with no history.* Sections 1–3 say why today's evidence does not prove that.
Section 4 is the test that would.

---

## 1. What `tools/stranger-onboarding-qa.mjs` measures — and what it does not

### Its four machine states (`SCENARIOS`, lines 206–260)

| Scenario | Machine state | What it asserts |
|---|---|---|
| `bare` | no `codex` on PATH, no sign-in | readiness answers `AGENT_CODEX_CLI_NOT_INSTALLED`; setup **and** home carry `winget install OpenAI.Codex` on the glass |
| `signed-out` | a **real copy of the owner's** Codex staged into the profile's `APPDATA`, nobody signed in | readiness answers `AGENT_CONFINEMENT_SIGNED_OUT`; `codex login` is on the glass |
| `auth-no-cli` | `auth.json` present, no `codex` anywhere | readiness must **not** say ready — the state that used to lie |
| `broken-cli` | `codex.cmd` that runs and exits 1, plus a fake `auth.json` | readiness passes *by design*; the **press** must say "did not answer when asked its version", and the ledger and home must record one refused run |

### What it genuinely asserts

It is a strong instrument and its strength is that it drives a **packaged** build by
clicking, never by assigning `location.hash` — enforced against its own source
(`auditSelf`, lines 117–129). It isolates `LOCALAPPDATA`, `USERPROFILE`, `APPDATA`,
`CODEX_HOME` and rebuilds `PATH` from Windows system directories alone (lines 262–307),
so "no CLI" really means none. It stages a *copy* of `release/win-unpacked` so the
artifact is not mutated. Its exit codes distinguish a product failure (1) from a harness
that never attached (2) — and the file warns, correctly, never to read it through a pipe.
Within its fence it walks the whole first run: permission question → folder → sign-in →
autonomy → review → home → agent page → press → back to home.

### The gap between "that QA passes" and "a person got there"

Everything before the app's first window is outside it, and so is the largest half of
what the product can do:

1. **It never gets the software.** It starts from `release/win-unpacked` — an unpacked
   directory that only exists on a build machine. Finding a download, transferring it,
   verifying it, SmartScreen, the NSIS installer, the Start-menu shortcut: none of it is
   touched.
2. **It runs on the owner's machine.** Same registry, same Defender/SmartScreen posture —
   which the owner has lowered as far as it goes on both machines. A fresh
   `--user-data-dir` is a fresh *profile*, not a fresh *machine*.
3. **The window is never shown.** `MC_SMOKE_HEADLESS=1` gives `{ show: false }`
   (`shell/window-options.cjs:18`). Everything is read as `innerText`. Nothing about what
   a person *sees* — legibility, layout, whether the screen paints at all on a default
   GPU — is measured.
4. **No scenario ever reaches a running agent.** `signed-out` has a CLI and no sign-in;
   `broken-cli` has a fake token and a CLI that cannot run. There is no state with a real
   CLI *and* a real sign-in, so the suite has never once asserted that an agent answers.
   Its own header records why: the only time that was achieved, it was achieved by
   copying the owner's credential, which a customer cannot do (lines 6–17).
5. **It cannot run on a bare machine anyway.** The `signed-out` scenario copies the real
   Codex from `%APPDATA%\npm\node_modules\@openai\codex` and throws `HarnessError` — exit
   2, NO VERDICT — when it is absent (lines 296–303). The suite that asks "can a stranger
   succeed" requires the owner's own install to be present.
6. **It walks one path of several.** It always presses `Continue` on the preselected tier
   and always answers `assisted`. It never presses **Skip the rest for now**, which is on
   every step (`src/views/setup.js:320`) and applies `SAFE_ANSWERS` → `observe` → *no
   write flags at all* (`src/setup-profile.js:224–228`). A person who skips gets a product
   with no Start control anywhere, and no scenario covers that.
7. **It presses exactly one control, and refuses to press the other.** By design it
   asserts no mission-bridge control is on the agent page and aborts if one appears
   (lines 456–489). So the dispatch surface — the Codex **and Claude** lanes, section 3 —
   is not merely unmeasured, it is deliberately out of bounds.

`0/0 checks passed` on that suite therefore means: *given a build already unpacked on a
machine that already has Codex, the four blocked states explain themselves honestly.*
It does not mean a stranger got anywhere.

---

## 2. The walk, from a cold start

### Step 1 — finding the download. **No longer a hard stop.**

**Snapshot taken 2026-09-09, before the 1.0.43 publication.** A public download page exists at
`https://toolsenabled.ai/download/` and served an installer when it was read back on that date. The
measurement this section was built on — `docs/WEBSITE-DOWNLOAD-WIRE-PLAN.md` §3 W1/W2 finding zero
download controls across all 12 routes and no landing page, and §4 finding no declarable installer
candidate — was true when it was taken and had stopped being true by that date. Which platforms and
versions that page offers is whatever it lists at the time you read it; this document does not track
it and should not be quoted for it.

The product's own onboarding page has been corrected to match: `public/help/getting-started.html`
section 1 now sends the reader to that address instead of saying there is no download page. What
has not changed is that the page ships **inside** the installer, and nothing in `src/` links to it
(the only references outside `artifacts/` are the payload boundary file and
`tools/onboarding-doc-qa.mjs`). The one document written for a stranger is still only readable by
someone who has already completed the two steps it explains.

**What stops them:** less than it did. A stranger can now reach an installer without knowing
somebody. The guide explaining the rest of the walk still lives on the far side of installing it.

### Step 2 — the unsigned-publisher warning. **Survivable, if they were warned.**

`package.json` `build.win.signExecutable: false`; measured today, the shipped
`ToolsEnabled Setup 1.0.6.exe` is **NotSigned**. On a default-security Windows machine
that downloaded the file (mark-of-the-web present), Defender SmartScreen shows *"Windows
protected your PC"* with no publisher name; the continue path is **More info → Run
anyway**. `getting-started.html:196–212` explains exactly this, including that the
warning's *absence* on a USB copy is not evidence of a signature.

**What stops them:** the explanation is inside the thing they cannot open yet. A stranger
meeting a blue full-screen block on an unsigned binary from a person, with no publisher
name and no page to check against, has every reason to stop — and the reasonable ones will.
Whatever hands over the installer must carry the SmartScreen paragraph, the byte count and
the SHA-256, *outside* the installer.

### Step 3 — install. **Should be clean.**

One-click per-user NSIS (`package.json` `build.nsis`: `oneClick: true`,
`perMachine: false`). No admin prompt, no folder chooser, no Next buttons; lands in
`%LOCALAPPDATA%\Programs\toolsenabled`, state under `%APPDATA%\ToolsEnabled` and
`%LOCALAPPDATA%\ToolsEnabled`. **Unverified on a clean machine:** whether Defender's
real-time scan or a controlled-folder-access policy interferes with an unsigned NSIS
per-user install — nobody has watched this on default settings.

### Step 4 — first run. **Two things start, not one.**

The window opens on the permission question: `shouldOpenSetup` forces
`location.hash = '#/setup'` and hides the navigation chrome (`src/main.js:251–267`).

Behind it, the app starts its own capability layer as a child of the Electron binary run
as Node (`shell/capability-layer.cjs:1–26`), which is what puts an action bridge on
127.0.0.1:4610-4619 for the renderer to find (`src/mission-bridge.js:46–50`). A stranger
sees none of this — but a default-security machine may: **an unsigned application binding
a localhost listener within seconds of first launch is exactly what a third-party firewall
prompt is for.** Nothing has ever measured that prompt. If the layer fails to announce a
port in 30 s the app carries on with `CAPABILITY_START_TIMEOUT` and every write action
answers `BRIDGE_UNREACHABLE`.

### Step 5 — the permission question. **Answerable by not deciding.**

Three choices, `guided` preselected and labelled *Recommended*
(`src/setup-state.js:15–40`). Continue is the only control; it writes the level and
advances (`src/views/setup.js:264–290`). If the copy cannot record a level the screen
still renders and Continue is disabled with a stated reason — fail-closed and honest, but
on a machine where that happens the walkthrough is over.

### Step 6 — the folder. **Fine, and quietly consequential.**

*"Which folder should your assistant work in?"* (`src/views/setup.js:498–553`), defaulting
to `%USERPROFILE%\Documents\<leaf>` (`capability/src/lib/setup/workspace.js:47–50`), with
a native picker via `mcSetup.chooseWorkspace`. The step fails open. At `guided` it is one
folder and that folder is the whole world the assistant can reach — the person is choosing
their blast radius while being told they are choosing a folder.

Then a sign-in step that is explicitly optional (**Not now** advances), then *"How much
should it do without asking you?"*. Answering `assisted` is what switches on
`agent-session` and `dispatch`; `observe` — and **Skip** — switch on nothing
(`src/setup-profile.js:224–228`).

### Step 7 — the review, and the first true sentence about Codex.

The review names Codex before Finish and gives the commands, not the concept
(`src/views/setup.js:657–692`): `winget install OpenAI.Codex`, the npm alternative, then
`codex login`. It does not block Finish, deliberately. This screen is good, and it is the
first time a person learns the product does not contain the thing that runs an agent.

### Step 8 — reaching a running agent. **Not without work nobody told them about.**

Home says *"Not ready yet"* until the engine is ready (`src/local-activity.js:411`), and
`AGENT_CODEX_CLI_NOT_INSTALLED` / `AGENT_CONFINEMENT_SIGNED_OUT` carry the remedy in
words (`src/agent-availability-copy.js:89,103`). Presence is answered without spawning
(`codexCommandIsMissing`, `shell/agent-host.cjs:368–405`), so a broken install passes
readiness and explains itself at the press instead
(`CODEX_VERSION_DETECTION_FAILED`, line 182). Settings, under "This computer"
(`#/settings?setting=this_computer_programs`, still reachable at the old `#/guide`),
repeats the two commands (`src/first-run-needs.js`, `FIRST_RUN_NEEDS`).

So the single-agent path is honest and completable — **if** the person will open Windows
Terminal, install a second program, create an OpenAI account, and sign in. That is the
real shape of "reach a running agent", and it has never been walked end to end by anyone
who was not already the owner.

---

## 3. The dependencies a stranger will not have

Nothing in the product installs any of these. Two of the three are not even named to the user.

**A. Codex, for the in-app Start button.** Any `codex` resolvable by `PATHEXT`, or the npm
layout `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`
(`shell/agent-host.cjs:370–400`). `winget install OpenAI.Codex` satisfies this. **Stated
in the product** — review screen, home, guide, help page.

**B. Codex, for a dispatched lane — a stricter requirement, and the product tells them the
wrong one.** A bridge dispatch resolves Codex through
`capability/src/lib/mission-bridge/codex-native-pair.js`, which accepts **only** a stable
npm `@openai/codex` install with its matching native package
(`@openai/codex-win32-x64`), version-probed and Authenticode-verified against signer
`OpenAI OpCo, LLC`, found under `%APPDATA%\npm\node_modules` or `npm_config_prefix`
(lines 1–20, 73–87, 299–335). A winget portable-zip install does **not** satisfy it. So a
person who follows the product's own first-line instruction gets Start working and gets
`BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE` on dispatch (`actions.js:642–655`), with no copy
anywhere explaining that the two paths want different installs. **Not stated anywhere.**

**C. Claude, for a Claude lane.** `executableFor('claude')` resolves exactly
`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
(`cli-provider-gateway.js:210–213`). If that file is absent it falls back to the bare name
`claude`, which `spawn` without a shell cannot resolve to `claude.cmd` → ENOENT →
`BRIDGE_CLAUDE_SPAWN_REFUSED` (`actions.js:532–537`). And a `.cmd` path is refused on
purpose: `commandKind` accepts only `codex`/`codex.exe`/`claude`/`claude.exe` and raises
`AGENT_LANE_COMMAND_REFUSED` — *"command shims are refused"*
(`capability/src/lib/agent-lane.js:199–205`) → `BRIDGE_CLAUDE_UNAVAILABLE`. The refusal is
correct; the silence around it is not. The only string in the product resembling guidance
is the gateway's internal `installHint` *"Install Claude Code, then sign in with
`claude auth login`"* (`cli-provider-gateway.js:91–96`), which reaches no screen. The write
flag that exposes the surface says the product *"hands a job to a Codex or Claude agent"*
(`src/write-flags.js:4`). **Not stated anywhere a user can read.**

### What the product must tell them

Wherever it already names Codex — review screen, Settings under "This computer", home
remedy, help page — it
must additionally state, per provider and as a command, not a concept:

1. **Both Codex installs, and which surface each serves.** If the lane path requires the
   npm native package, `npm install -g @openai/codex` is the instruction for anyone who
   wants dispatch, and the winget line must say what it does *not* enable. Better: make
   the two paths accept the same install and delete the distinction.
2. **Claude, with the exact command and the exact reason a shim fails.**
   `npm install -g @anthropic-ai/claude-code`, then `claude` (sign-in), plus one sentence
   saying a `.cmd` shim on PATH is not enough and why — otherwise a person with a working
   `claude` in their terminal will read the refusal as a product bug.
3. **Node itself.** Both npm instructions presuppose Node; only the Codex winget line does
   not. If npm is the required route for lanes, Node is a named prerequisite and needs its
   own line.
4. **A readiness row per provider, before the press.** The Codex probe pattern
   (`codexCommandIsMissing`) exists and works; there is no Claude equivalent, so a Claude
   lane's only feedback is a refusal after the fact.

---

## 4. The clean-environment test

A default-security environment is a **prerequisite** for this phase. Both owner machines
have security lowered as far as it goes, so neither can produce this evidence. Run this
on a VM; it is a checklist, not a description.

### The machine

- [ ] Windows 11 Home or Pro, current retail build, **fresh install** — not a clone of a
      developer image, no domain join, no policy templates.
- [ ] A **standard (non-administrator)** local user for the whole run. The install claims
      to need no admin; that claim is under test.
- [ ] Defender **on**, real-time protection **on**, SmartScreen for apps and Edge at
      **default** (`Warn`), UAC at default. Nothing added to exclusions.
- [ ] **No Node.js, no npm, no git, no Windows Terminal customisation, no VS Code, no
      Cursor** — the VS Code Codex fallback in `cli-provider-gateway.js:166–200` must not
      be able to satisfy anything.
- [ ] No OpenAI or Anthropic credential in the environment, registry, or user profile.
      `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` must be unset.
- [ ] Snapshot the VM **here**, before anything is copied in. Every failed run restores to
      this snapshot; a machine that has been through the walk once is no longer clean.

### The materials, delivered the way a customer would get them

- [ ] A **declared** installer: the frozen `ToolsEnabled Setup <version>.exe`, its byte
      count, its SHA-256 taken on the frozen copy, and the build ref
      (`docs/WEBSITE-DOWNLOAD-WIRE-PLAN.md` §5.2). Without a declaration this test cannot
      start, and that is the correct outcome.
- [ ] Transferred over **HTTP(S)**, not a shared folder or a pasted path, so the file
      carries the mark-of-the-web and SmartScreen behaves as a customer's would.
- [ ] Whatever prose the customer would get with it — nothing more. Not this repo.

### The run — one person, no help, notes taken at every screen

1. [ ] Verify size and hash per `getting-started.html:176–190`. **Pass:** both match.
2. [ ] Double-click the installer. **Record:** the exact SmartScreen text, the exact number
       of clicks to proceed, whether any UAC prompt appears. **Pass:** the app opens with
       no administrator password.
3. [ ] **Record any firewall or Defender prompt in the first 60 seconds** — the capability
       layer binds 4610-4619 on first launch. **Pass:** either no prompt, or a prompt the
       written instructions predicted.
4. [ ] First window is the permission question with chrome hidden. **Pass:** it paints, and
       Continue works on the preselected `guided`.
5. [ ] Walk folder → sign-in (choose **Not now**) → autonomy (`assisted`) → review.
       **Pass:** the review names Codex and shows a command that can be copied.
6. [ ] Finish. **Pass:** home says *"Not ready yet"* and names
       `winget install OpenAI.Codex` on the glass.
7. [ ] Follow only what the product said: run the install command, run `codex login`,
       create an OpenAI account if needed, reopen the app. **Record wall-clock time and
       every place the person had to guess.** **Pass:** home stops saying *"Not ready yet"*.
8. [ ] Agent page → type a prompt → Start. **Pass:** an agent **replies**. This is the
       assertion no existing suite makes.
9. [ ] Dispatch a Codex lane. **Expected today: it refuses**
       (`BRIDGE_CODEX_NATIVE_PAIR_UNAVAILABLE` — §3B). Record the exact sentence shown.
10. [ ] Dispatch a Claude lane. **Expected today: it refuses** (§3C). Record the exact
        sentence shown.
11. [ ] Restore the snapshot; second run, same person, this time press **Skip the rest for
        now** on step one. **Record what the product offers them** — on `observe` no write
        flag is on, so no Start control is rendered anywhere.

### What "passed" means

**Passed** = steps 1–8 completed by one person who had never seen the product, on the
machine described, using only materials that were handed to them, with no console, no
repo, and no help from anyone who built it — and the sentences at steps 9, 10 and 11 each
named a cause and a next action rather than an identifier.

Anything less is a **finding**, and every finding is copy or packaging, not opinion:
a step where the person asked "what do I do now?" is a missing sentence; a step where they
stopped is a blocker. **Timing is evidence too** — record how long step 7 took, because
"install a second program and create an account with a third party" is the largest thing
this product asks of a stranger and nothing has ever measured what it costs them.

**And the harness stays honest about its own scope:** running
`node tools/stranger-onboarding-qa.mjs` on that VM would be measuring the *packaged
directory*, not the *installed product*, and its `signed-out` scenario would exit 2 (NO
VERDICT) for want of the owner's Codex. That suite is a good instrument for the four
blocked states; it is not this test, and it cannot become it.
