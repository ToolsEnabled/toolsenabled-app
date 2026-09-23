# Preparing a fully qualified cut

Release preparation starts while implementation is still landing. A passing
development check, source selection, LIVE promotion or unpacked smoke has its
own scope. The release decision requires the exact distributable artifacts
and every required source, installed-product and lifecycle proof.

## Inspect before building

Run the read-only planner from the reviewed qualification harness:

```sh
node tools/release-packager/plan-readiness.mjs \
  --source-app /absolute/path/to/isolated-app \
  --source-engine /absolute/path/to/isolated-engine
```

On Windows, supply explicit directories inside the permitted account boundary.
For a standalone product, use `--product <product> --source-website <directory>`.
Omitting source paths describes only the registered contract.

The planner calls the source qualifier's existing inventory and entry-point
reconciliation. It reports added and missing test files, changed aliases,
unmapped commands, missing runner inputs and unresolved fixture contracts.
It neither executes candidate scripts nor edits the reviewed inventory. Exit
1 means preparation blockers remain; exit 2 means inspection failed. Exit 0
does not qualify a release. Inspect the report's target: the registered
Windows contract does not become a Linux contract when run on Linux.

The report describes the files inspected. It does not establish an immutable
Git identity or protect against concurrent source edits. Use isolated checkouts
at recorded commits, and rerun inspection when the integrated source changes.
Keep machine paths and raw evidence outside the distributable.

## Work before the final source selection

1. Reconcile each required suite and entry point with current source. Determine
   whether a missing entry was moved, replaced or accidentally dropped. Classify
   helpers by their actual invocation; do not turn missing tests, optional runs
   or changed aliases into automatic exclusions. Resolve fixture requirements
   with deterministic real inputs. An empty runner is still missing coverage.
2. Prepare the native qualification machines, toolchain and dependencies. Check
   actual VM identity, ownership, clean baseline, chosen runtime privilege,
   interactive desktop, network scope and bounded cleanup. A host with a
   hypervisor is a prerequisite, not an installed-product acceptance result.
3. Complete the registered executors and independent evidence verification for
   fresh install, durable critical journeys, upgrade, uninstall/reinstall,
   privilege/isolation/recovery, advertised integrations and update delivery.
   Existing driver functions and mock tests alone cannot register an adapter.
4. Complete the Linux native cut and qualification path. The `.deb` build
   configuration, installed manifest and sealed Linux smoke are useful inputs;
   Windows NSIS, PE, process ownership and receipt logic do not qualify Linux.
5. Preserve real published installers and their measured identities for the
   supported upgrade matrix. Select the same exact artifact at delivery,
   installation, runtime verification and declaration boundaries.

These activities can progress independently of feature work. Integration
retains ownership of the final app/engine pair and outstanding feature fixes.
Preparation reports should distinguish known defects, missing proof and work
already owned by another lane.

## Retrieval source proof

Integrate engine commit `f50b9973` with the retrieval qualification mapping in
this harness. The real CLI test now creates a disposable program copy and
literal ledger, SQLite and document inputs. It requires successful searches,
a genuine miss, and an unavailable-source result with their actual process
exit codes. Moving the ledger into the configured state root must refresh its
cached citation; removing it must stop stale ledger results from being served.

Run `node tests/retrieval/run.js` from the selected engine checkout. The fixed
report mapping requires every one of the 35 observed check lines and their
matching terminal count, including the disposable CLI proof. It counts one
assertion-file execution. The former report that substituted UNKNOWN for an
unexercised HIT cannot qualify. Source bytes and the shipped settings registry
remain bound by the normal source and artifact measurements.

This path was exercised on native Windows and Linux, including deliberate
reintroduction of the stale-location defect and an UNKNOWN-only CLI. Both
mutations fail the required CLI check. This source proof does not provide
installed-product evidence or implement the remaining Linux cut adapter.

Declaration checks also require the selected machine's existing
`private/owner-data-patterns.owner.json` in each isolated app checkout. Stage
the real profile as an ignored private input before verification and preserve
its restrictive permissions. Record its identity without exposing its contents.
A missing profile is a setup failure; an empty or invented profile cannot
replace the privacy check.

## Verify the landed candidate

1. Freeze the integrated app and engine commits and review inclusion of the
   intended changes. Resolve conflicts and preserve other work. Provision
   clean native build inputs, exact dependencies, privacy configuration and
   payload provenance in isolated build worktrees.
2. Run the complete required source checks on Windows and Linux. Examine
   terminal results and named unexecuted tests at their actual scope. Release
   accepts no failure baseline, unexplained skip or unmeasured required path.
3. Build through the native producer and run its privacy, license, dependency,
   payload, runtime, renderer and seal checks. Rehash after durable staging.
   A producer or changed runtime check cannot be skipped using old evidence.
4. Install the exact staged artifacts on disposable native machines. Exercise
   normal shortcut startup, first run, real provider start/response/stop,
   persisted results after full relaunch, supported upgrades, data retention,
   uninstall/reinstall and interrupted-update recovery. Observe Windows
   standard and administrator runtime profiles under the current contract.
   Qualify each supported Linux session and privilege path explicitly.
5. Exercise advertised integrations against the installed artifacts, including
   the authorized cross-machine/browser path, disconnect, revocation,
   cancellation and recovery. Bind service and peer identities in the proof.
   Keep payment behavior inert. Preserve the user's real work during testing.
6. Review the evidence against every assertion in the fixed release contract.
   Independently verify artifact bytes, source pair, harness implementation,
   environments, freshness and completed cleanup. Missing or indirect proof
   leaves the candidate unqualified.
7. Use the full cutter/declaration path only when it can earn the required
   receipt. Preserve the qualifying receipt and artifact hashes. Publication
   and LIVE activation remain their own operations under current authority.

## Release notes

The published note is part of the cut, not paperwork after it. Copy
`docs/RELEASE-NOTES-TEMPLATE.md` to `docs/RELEASE-NOTES-<version>.md` and fill it
from the lanes that landed the work; each lane owns the wording of its own entries.
Run `npm run check:release-notes` to confirm the note is structurally complete
before publication. That guard reads one markdown file: 0 clean, 1 incomplete, 2 a
setup problem such as no note at that path. A missing note exits 2 rather than 0,
so an unwritten note cannot pass by being absent. It measures no artifact and
replaces no gate below.

The planner is an early diagnostic, not an alternative release command.
`tools/lib/release-readiness.mjs`, the native producers, the cutter and their
executing gates remain the source of release requirements.
