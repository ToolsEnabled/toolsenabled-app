# Qualification on the Windows cutter

Everything in this document needs a Windows x64 host. Everything that could be
proved without one is already proved by `tools/test/installed-lifecycle-adapters.test.mjs`
and `tools/test/disposable-guest-contract.test.mjs`, which run on any platform.

Written 2026-09-11 against the 1.0.45 tree, on Linux, by the lane that registered
the seven installed qualification adapters. Nothing here was executed on Windows;
where an output below is marked *measured*, it was measured on Linux and the
registry it describes is source policy, identical on both platforms.

## 1. What changed, and what it does not mean

`assertCutQualification` used to throw on every platform, before any Git,
staging or build work, because the seven installed rows of the ToolsEnabled
readiness contract had no registered executor:

```
Release readiness blocked: required qualification adapters are unavailable
(fresh-install, durable-critical-journey, upgrade, uninstall-reinstall,
privilege-isolation-recovery, advertised-integrations, update-delivery).
Source tests, copied stages and mock/HTTP checks are not substitutes.
```

Each of those rows now names exactly one reviewed executor in
`tools/lib/adapters/installed-lifecycle.mjs`, so the cutter starts.

**It does not mean the product is qualified.** Four rows execute the
disposable-guest driver and refuse until that guest exists. Three rows have no
executable scenario at all and refuse by name. A cut still cannot produce a
readiness receipt today; it fails later, with a message that says what is
missing, instead of refusing to start at all.

## 2. Run one thing to get the verdict

```
node tools\release-packager\check-qualification-host.mjs ^
  --profile windows-x64-standard ^
  --evidence-root <private evidence directory> ^
  --harness-root <harness checkout> ^
  --runner-config <private evidence directory>\qualification-worker.json
```

Exit 1 with the blockers printed is the expected result today; exit 0 would mean
every prerequisite is met, which cannot happen until section 5 is done. The
command starts no machine, installer, job or product and writes nothing.

Its `guest.checks` array is the whole job list. On this Linux host it reports
(*measured*):

| check | status here | status to expect on the Windows cutter |
|---|---|---|
| `product`, `profile` | satisfied when supplied | same |
| `qualification-host` | blocked: `this host is linux/x64` | satisfied |
| `evidence-root`, `harness-root` | satisfied when the directories exist | same |
| `worker-config` | satisfied when the file below validates | same |
| `evidence-survives-teardown` | blocked if evidence sits inside the machine tree | same |
| `hyperv-host` | not-checked off Windows | run the PowerShell probe in section 4 |
| `guest-agent` | **blocked** while nothing supplies a guest | **blocked** while nothing supplies a guest |

The `guest-agent` row is a **shape** check: `probeDisposableGuest` starts nothing,
so it cannot tell a real guest from an object carrying the right `mode` string.
Do not read a satisfied row there as admission. Admission is
`createDisposableGuest`, which since 2026-09-17 resolves the declared machine
through `Get-QualificationVm` and requires an executed `attest()` whose result
matches that independently resolved machine — see section 5.1.

## 3. The worker description

`createDisposableGuest` takes the dedicated machine's description from the
qualification context's existing `runnerConfigPath` key, which
`normalizeQualificationContext` already accepts and which
`measureArtifactSubject` already measures into the qualification subject. Put it
in the private evidence directory, outside the product stage, and outside the
machine directory:

```json
{
  "schema": "toolsenabled.hyperv-qualification-worker",
  "schemaVersion": 1,
  "vmId": "<the dedicated VM's GUID>",
  "vmName": "ToolsEnabled-Qualification-<name>",
  "baselineCheckpointId": "<the powered-off baseline checkpoint's GUID>",
  "machineRoot": "<the directory holding only this VM>",
  "guestProfile": "<the owning account profile the guest will attest>",
  "networkPolicy": "offline"
}
```

`Assert-QualificationVmConfig` in `tools/lib/transport/QualificationVm.psm1`
enforces the same fields against the live machine; the Node check exists so an
operator sees every malformed field at once instead of one Hyper-V throw per
attempt. Passing the Node check is not admission.

## 4. Hyper-V host status

Not measured by Node; run it directly:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\lib\transport\Probe-QualificationHost.ps1
```

Exit 0 means available. Exit 2 prints `blockers`, which are drawn from: no
active hypervisor; firmware virtualization not reported enabled; the session is
not running under the chosen authorized administrator token; the account changed
during observation; or one of `Get-VM`, `Get-VHD`, `Restore-VMSnapshot`,
`Start-VM`, `Stop-VM`, `Copy-VMFile` is unavailable.

## 5. What must still be built, in order

### 5.1 The attested guest agent — blocks five rows

> Updated 2026-09-17. Admission is no longer shape-only. `createDisposableGuest`
> now refuses with one of five distinguishable codes —
> `DISPOSABLE_GUEST_SHAPE_ONLY`, `DISPOSABLE_GUEST_TOOLCHAIN_UNAPPROVED`,
> `DISPOSABLE_GUEST_MACHINE_UNRESOLVED`,
> `DISPOSABLE_GUEST_ATTESTATION_NOT_EXECUTED`,
> `DISPOSABLE_GUEST_ATTESTATION_MISMATCH` — and admits only when the host has
> resolved the machine itself through `Get-QualificationVm` **and** the guest has
> answered a fresh host challenge with an attestation carrying the
> `virtualMachineId` it reads inside that VM and the baseline checkpoint the host
> resolved. A guest may not vouch for itself: a stub that implements `attest()`
> cannot report a `virtualMachineId` for a machine it is not running inside, and
> it never reaches that comparison unless a real machine resolved first.
>
> **The admitting path is unproven.** No qualifying VM and no guest credential
> exist on the host where this was written, so every case exercised in
> `tools/test/disposable-guest-contract.test.mjs` is a refusal. Nothing here
> claims a guest has ever been admitted.

`tools/lib/drivers/installer-lifecycle.mjs` drives an interleaved session:
`resetBaseline`, install, `observeInstallation`, `launch`, then live CDP reads
and native input against the running renderer, `stop`, repeated per phase. It
requires all sixteen methods listed by `DISPOSABLE_GUEST_METHODS`, and
`guest.mode` must be `attested-disposable-guest`. The per-method obligations are
the comment block at the end of that driver.

`Invoke-QualificationVmRun` cannot serve that session as written. It is a
one-shot batch transport: restore the baseline, copy `driver.ps1` and
`request.json` into the guest, run that script to completion, read back one
bounded `result.json`, restore the baseline again. It is also deliberately
offline — `Get-QualificationVm` refuses any VM attached to a virtual switch —
so the host cannot reach the guest's loopback CDP endpoint at all, and
`connectQualificationCdp` accepts only a literal `ws://127.0.0.1:<port>/devtools/page/<id>`.

Closing that gap is the work. Until it is closed, every one of the four
executable rows refuses on the Windows host with:

```
Installed lifecycle qualification blocked: the attested disposable guest is
unavailable for windows-x64-standard: Disposable guest unavailable:
N prerequisite(s) are not met (...)
```

followed by each unmet prerequisite and its remedy.

### 5.2 The lifecycle inventory — blocks upgrade coverage

`tools/release-packager/lifecycle-inventory.toolsenabled.json` does not exist.
Its shape is enforced by `validateLifecycleInventory` in
`tools/lib/drivers/lifecycle-inventory-contract.mjs`: supported baselines (prior
release installers with `sha256`, `bytes`, runtime and shell hashes,
`contentLayout: "current"`), a `dataPolicy` naming the three uninstall modes,
the customer content kinds and roots and a committed declaration file, and an
`interruptionPolicy` with the three interruption points and recovery
`rerun-exact-candidate-and-reopen`. Check a draft with:

```
node tools\release-packager\check-lifecycle-inputs.mjs --inventory <absolute file>
```

### 5.3 Two rows with no executable scenario — blocks qualification outright

These are registered so the contract names one executor each, and they refuse
with a reason and a remedy rather than with a selector that returns a constant.
A constant selector would turn "unqualified" into a green assertion on a public
release, which is worse than the unregistered state this replaced.

> Corrected 2026-09-17. This section said **three** rows. It is **two**.
> `durable-critical-journey` now carries `driver: 'installer-lifecycle'` and
> `executableScenario: true` in `INSTALLED_LIFECYCLE_REQUIREMENTS`, and its three
> selectors are `journeyAssertion(...)` calls, not `null`. Measured with
> `node tools/release-packager/plan-readiness.mjs --product toolsenabled`, whose
> `unexecutableRequirements` is `["advertised-integrations", "update-delivery"]`.

| row | why it cannot run | what must be built |
|---|---|---|
| `advertised-integrations` | no driver walks the advertised provider matrix, exercises the multi-machine path, or observes the payment surfaces; the offline guest policy cannot reach a provider or a second machine | a matrix driver reading the shipped source of truth, a separately reviewed egress policy that is not the current offline policy, and a second attested guest |
| `update-delivery` | only `interrupted-upgrade:<baseline>` recovery is covered; nothing exercises the delivery path the product offers a user or proves the exact candidate is what that path selects | a delivery driver whose only acceptable outcome is the exact candidate. The 5.2 inventory it also named is now committed |

`payments-remain-inert` still needs a real observation of the installed product.
For 1.0.45 payments are out of the launch surface, but "the surface has none" is
an assumption, not evidence, and this row must not record it as one.

## 6. The cutter invocation, and where it now stops

Environment required before any side effect: `TOOLSENABLED_CUT_MODEL` and
`TOOLSENABLED_CUT_EMAIL` together, `TOOLSENABLED_CUT_SESSION`; optional
`TOOLSENABLED_CUT_LANE`. Leave every `TOOLSENABLED_BILLING_*` and
`MC_ALLOW_DIRTY_BUILD` unset.

```
node tools\release-packager\cut-release-candidate.mjs ^
  --repo <app checkout> ^
  --source-ref <40-hex app commit> ^
  --engine-source-ref <40-hex engine commit> ^
  --version 1.0.45 ^
  --staging <candidate dir> ^
  --readiness-output <private evidence dir>\receipt-1.0.45.json ^
  --readiness-context <private evidence dir>\context-1.0.45.json ^
  --keep-worktree
```

`--readiness-context` is a paths-only JSON file inside the private evidence
directory, with exactly these keys: `sourceRoots` (`app`, `engine`),
`stageRoot`, `harnessRoot`, `evidenceRoot`, and optional `runnerConfigPath` —
supply that last one, or the guest refuses at `worker-config`. All absolute; the
evidence root may not contain or be contained by the source, stage or harness
trees.

Order of events now:

1. attribution preflight, then `assertCutQualification` — passes;
2. if `--readiness-evidence` was supplied, its executor identities are checked
   against this build's registry before any Git or staging work;
3. Git, staging, the throwaway worktree, `npm ci`, `npm run dist`, the seal, the
   packaged QA suite;
4. `qualifyReleaseArtifact` runs the contract in order: the two source suites,
   `artifact-integrity`, then `fresh-install` — which is where the guest refusal
   in 5.1 lands. Nothing is tagged and no declaration is written.

## 7. Registry, as measured

`node --input-type=module -e "import { assertReadinessAdaptersAvailable } from './tools/lib/release-readiness.mjs'; const c = assertReadinessAdaptersAvailable('toolsenabled'); for (const r of c.requirements) console.log(r.id, '->', r.adapter.id, r.adapter.proofScope, JSON.stringify(r.profiles))"`

```
source:app                     -> source-suite:app:v1              complete-source-suite       ["build"]
source:engine                  -> source-suite:engine:v1           complete-source-suite       ["build"]
artifact-integrity             -> artifact-integrity:v1            exact-packaged-artifact     ["build"]
fresh-install                  -> fresh-install:v1                 exact-installer-lifecycle   ["windows-x64-standard","windows-x64-administrator"]
durable-critical-journey       -> durable-critical-journey:v1      exact-installed-desktop     ["windows-x64-standard","windows-x64-administrator"]
upgrade                        -> upgrade:v1                       exact-installer-lifecycle   ["windows-x64-standard","windows-x64-administrator"]
uninstall-reinstall            -> uninstall-reinstall:v1           exact-installer-lifecycle   ["windows-x64-standard","windows-x64-administrator"]
privilege-isolation-recovery   -> privilege-isolation-recovery:v1  exact-installed-desktop     ["windows-x64-standard","windows-x64-administrator"]
advertised-integrations        -> advertised-integrations:v1       exact-installed-desktop     ["windows-x64-standard","windows-x64-administrator"]
update-delivery                -> update-delivery:v1               exact-installer-lifecycle   ["windows-x64-standard","windows-x64-administrator"]
```

`node tools\release-packager\plan-readiness.mjs --product toolsenabled` exits 1
with `"status": "blocked"`, `"missingAdapters": []` and
`"unexecutableRequirements": ["advertised-integrations", "update-delivery"]`.
A registered adapter that can never run must not read as ready to run, so the
plan stays blocked and names those two rows with their reason and remedy.

> Corrected 2026-09-17. This section listed `durable-critical-journey` as a third
> unexecutable row; it is executable. The adapter `sha256` column above is also
> not a constant to copy — every row sharing
> `tools/lib/adapters/installed-lifecycle.mjs` reports that module's
> `installedLifecycleImplementationIdentity()`, which is a digest over the whole
> `COMPONENTS` closure. Editing any component, including
> `tools/lib/guest/disposable-guest.mjs`, changes it by design. Re-read it with
> the command at the head of this section rather than pinning a value.
