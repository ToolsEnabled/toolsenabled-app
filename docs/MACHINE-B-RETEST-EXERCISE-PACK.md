# Machine B — retest exercise for the next candidate

Authored on Machine A, 2026-08-11, lane R1260 t5a.
Companion data file: `docs/machine-b-retest-gates.json` (machine-readable, same content).

---

## First line, plainly

**This is not a candidate declaration and not a transfer authorization.** No candidate
exists as of writing, so nothing here names one. This is the *exercise* to run when a
declared candidate arrives — written now, deliberately, so that the retest is designed
before the artifact exists rather than improvised after it lands.

**Delivery of this pack to you is owned by a different lane (R1237 D3), not by me.** If
you are reading it, that lane delivered it.

Every field in `candidate` in the JSON companion is `null`. **If any of them is still
null when you receive a build, refuse intake.** An absent field is not a pass. That rule
is the whole reason this pack exists in this shape.

---

## What changed on our side since your 2026-08-09 verdict

Four things, and one of them will fail your matrix as written if you do not know it.

1. **The product was renamed.** `Mission Control` → `ToolsEnabled`; appId
   `com.toolsenabled.missioncontrol` → `com.toolsenabled.desktop`. A USPTO search
   returned 17 live marks for the old name in the relevant classes. Your matrix has been
   amended twice for this; make sure you hold the **second** amendment.
2. **A licence was chosen.** `AGPL-3.0-or-later`. Prior handoffs said `UNLICENSED`.
3. **The version moved to 1.0.6.**
4. **A new BLOCKER was found on our side** — the adoption trap, PF5 below. It is the most
   likely way this retest produces a *false* blocker against you.

---

## The five findings you must re-drive, and what we claim about each

Read our claims as **claims to check**, never as coverage. Our own record is that roughly
fifteen defects this sprint shipped past a green test suite and not one was caught by a
test. A green suite on our side is not evidence on yours.

### PF1 — silent relaunch · BLOCKER · **we claim nothing**

You found: first run opened from installer completion; every normal relaunch afterwards
produced no window and exit code 0, with zero-byte stdout/stderr, no WER entry and no
crash report, across executable, Start Menu shortcut, shortcut target plus working
directory, and direct launch.

**Our status: unverified for any current build.** No lane here has demonstrated a clean
close-and-relaunch cycle on a declared candidate. A related but *different* fix is
claimed — settings surviving a forced port change — and it must not be quoted as
clearing this row.

Drive it as you did before, and add one thing: relaunch **three** times, not two, and
capture the PID/child/window/exit timeline for each. A defect that appears on the third
cycle is exactly the kind this product has shipped before.

### PF2 — publisher identity · SERIOUS · **partially evidenced, with a trap**

You found: Apps & features and the uninstall registry entry showed no publisher.

**The trap:** a lane here measured the built executable's VersionInfo `CompanyName` as
`ToolsEnabled, Inc. in formation` and that is genuine — but it is the **file resource**,
which is a *different field* from the Installed Apps publisher, which comes from the
**uninstall registry `Publisher` value**. Your finding was about the registry field.

**Do not let a correct `CompanyName` be quoted as clearing this row.** Read three things
separately and report them separately: the file VersionInfo, the uninstall registry
`Publisher` value, and what the Installed Apps UI actually displays. Your matrix already
says metadata alone is insufficient; this is the concrete reason why.

Authenticode remains separate again: the installer is **unsigned**, so expect a
SmartScreen unknown-publisher warning and record the exact click count.

### PF3 — uninstall retention · SERIOUS · **open, and there is a contradiction to escalate**

You found: uninstall removed the registry entry, the install directory and the shortcut,
but showed no clear progress window and **retained all 59 user-data files, 9 368 864
bytes**, including saved theme state.

**There is a genuine design contradiction here and neither of us should resolve it
alone.** Your matrix says *"Retained userData is a defect under the handoff."* The
shipped code (`shell/userdata-adoption.cjs`) **deliberately preserves and adopts**
userData across the rename, and writes a durable adoption record. Those two requirements
cannot both be satisfied by one build.

**Escalate this to the owner before recording a verdict on "Removal and leftovers."**
The question is a product decision — *does uninstall delete a user's data?* — not a
defect for either machine to decide unilaterally. Record what the build does; hold the
verdict.

Separately, a lane here reports the **uninstaller ignores silent mode**: it opens a modal
and blocks forever while returning success to the caller. Worth an explicit probe.

### PF4 — simulated data labelled live · SERIOUS · **materially improved, not cleared**

You found: after an explicit `View simulated` action, Metrics showed operational-looking
totals (`AGENTS LIVE 28 of 91 spawned`, `TASKS CLOSED 49`, `TOKEN FLOW 4.9M`) on a page
carrying a green `live` label.

**Measured by me on the current built renderer**, so you know exactly what we do and do
not claim:

- The exact string `View simulated` is **still present** in dist and app.asar (an earlier lane claim of absence was refuted by the harvest verifier's re-measurement). Where and whether it renders is a row for B to settle.
- The default Metrics state shows `—` and `unavailable` on every tile, under
  *"live projection unavailable · No local agent fleet host detected on this machine."*
  No fabricated numbers appear by default.
- Explicit labels now exist in the bundle, including *"Demonstration data. Nothing in it
  is running on this computer."*, *"sample board — demonstration traffic, not a live
  fleet"*, and *"Terminate unavailable in simulated mode; no live bridge request will be
  sent."*

**What is NOT established, either way:** whether any remaining path can still put a green
`live` badge over fabricated numbers. I measured the renderer in a browser with no host;
I did not drive the installed app's simulated mode. **That is your row to settle**, and
it is the one where our evidence is weakest.

### PF5 — the adoption trap · BLOCKER · **open, and it will bite you first**

**Read this before you install anything.**

If `%APPDATA%\Mission Control` exists on the test machine from any pre-rename install,
the renamed build **adopts it**, then **cannot decrypt** the adopted
`agent-spawn-key.enc`. The result is that **Start is permanently disabled and nothing on
screen explains why.** Clean A/B on our side: with the folder absent, a fresh key is
created and a session runs.

Your machine may well carry that folder from the 2026-08-09 exercise.

**Procedure:** before installing, rename `%APPDATA%\Mission Control` aside and record
that you did it. Then run the retained-profile row **deliberately**, as its own exercise,
rather than tripping over it by accident and recording a false BLOCKER against first run.

### PF6 — seeded topology · SERIOUS · **improved in the renderer, configurability unverified**

You found a fixed two-machine roster seeded with TEST-NET addresses and no configuration
for host, endpoint, roster, account, owner identity or machine identity.

**Measured by me:** the machine selector now reads `All / Computer 1 / Computer 2` with
no addresses present. Whether the roster is **configurable** is not established. That
half is still yours.

---

## Traps that produce a FALSE verdict

These are ways this retest can lie to you. Each has a specific avoidance.

| # | Trap | Produces | Avoid by |
|---|---|---|---|
| T1 | Pre-rename `%APPDATA%\Mission Control` present | **False BLOCKER** — Start disabled, looks like a fresh-install defect | Rename it aside first; record that you did |
| T2 | Probing **braced** GUID registry keys | False "neither present", which your matrix classes **INCONCLUSIVE, not a pass** | Key names are **unbraced**. Probe both `HKCU\Software\<guid>` and `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<guid>` |
| T3 | Hashing a file at a path inside a build output directory | Certifying a build nobody can reproduce | Hash **only** the frozen copy. That directory reuses one filename per build, so a hash quoted against it expires on the next rebuild **with no change to the filename** |
| T4 | Accepting file `CompanyName` as evidence for the Installed Apps publisher row | **False PASS** on PF2 | Read the registry `Publisher` value and the Apps UI separately from the file resource |
| T5 | Taking every "Recommended" setup answer and concluding there are no working controls | Either a false blocker **or a real finding** — but they must not be confused | Run first run **twice on separate fresh profiles**: once accepting every Recommended answer, once choosing the most permissive. Report the two click-paths separately |
| T6 | Reading our green suite as evidence | False PASS | Treat every A-side claim in this document as a claim to check |

### On T5, specifically

A lane here previously measured that the recommended setup answer granted **zero write
flags**, and that the flag governing agent sessions was one of the ones it did not grant
— so a user who accepted the recommendation had **no control anywhere in the product that
starts an agent**. Whether that is still true of the new candidate is **unverified**.

Driving the current renderer, I saw the setup screen ask *"How much should the assistant
be allowed to do?"* with three permission levels, exactly one of them marked
`Recommended`, and a **Continue** button correctly disabled where the level could not be
recorded. That is a different question from the autonomy question the earlier measurement
was about, so the earlier finding may or may not still apply. **Please settle it by use.**

---

## The 21 mandatory gates, with retest focus

Full machine-readable form in `docs/machine-b-retest-gates.json`. Prior findings mapped
to the gates they touch:

| # | Gate | Prior findings in play |
|---|---|---|
| 1 | Immutable declaration | — (refuse if any field is null) |
| 2 | Intake identity | — |
| 3 | Phase 1 baseline | PF5 |
| 4 | Trust UX | PF2 |
| 5 | Install | — |
| 6 | Product identity | PF2 |
| 7 | appId | — (GUID carve-out, four outcomes) |
| 8 | First run | PF1, PF5 |
| 9 | Privacy and stranger fit | PF4, PF6 |
| 10 | Navigation/configuration | PF5, PF6 |
| 11 | Live versus simulated | PF4 |
| 12 | Persistence and relaunch | PF1 |
| 13 | Retained-profile regression | PF5 |
| 14 | Reboot persistence | PF1 |
| 15 | Uninstall UX | PF3 |
| 16 | Removal and leftovers | PF3 — **blocked on contradiction C1, escalate first** |
| 17 | Resource compliance | — |
| 18 | Phase 2 qualification | — |
| 19 | Phase 2 cleanliness | PF5 (check **both** product names) |
| 20 | Phase 2 protocol | — |
| 21 | Certification | — (same immutable candidate for every row) |

### The appId carve-out, restated because it is easy to get wrong

The install and uninstall registry key names are the **bare, unbraced** GUID
`21cb002d-a6ac-5e62-b88d-ba3c87d67396`, which is the UUIDv5 of the **old** appId. That is
pinned **deliberately** — it is how this installer finds and replaces a pre-rename
install instead of forking beside it. It is **not** a legacy identity.

- old GUID present, alone → **PASS**
- `1de271ec-9b43-59e5-b4aa-0fd300d862cb` present → **FAIL** (pin lost, base forked)
- both present → **FAIL** (the side-by-side defect this row exists for)
- neither present anywhere probed → **INCONCLUSIVE, not a pass** — resolve whether
  nothing is installed or you probed the wrong key name before recording anything

A per-user install writes neither HKLM key, so absence there proves nothing.

---

## Suggested order

1. Intake: verify every declaration field is non-null, then independently measure bytes
   and SHA-256 on the frozen copy **before executing anything**.
2. Baseline under **both** product names.
3. **Rename `%APPDATA%\Mission Control` aside** (T1) and record it.
4. Trust UX → Install → Product identity → appId.
5. First run, then **three** close/relaunch cycles (PF1).
6. Privacy, navigation, live-vs-simulated (PF4 is the weakest evidence we hold).
7. Persistence, reboot.
8. Retained-profile regression — restore the renamed folder and run PF5 **deliberately**.
9. Uninstall UX, then leftovers — **hold the verdict on leftovers pending C1**.
10. Phase 2 on a clean guest when one is available.

## What would make us withdraw the candidate ourselves

So you are not the only backstop: if any of these is true, tell us and stop.

- Any declaration field is null, or the SHA-256 you measure differs from the declared one.
- The installer produces two install trees, two uninstall entries, or both GUIDs.
- Any user-visible identity string contains "Mission".
- Start is disabled with no explanation on a machine where the pre-rename folder was
  renamed aside (that would mean PF5 has a second, unknown cause).
