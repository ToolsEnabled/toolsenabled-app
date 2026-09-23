# Explicit existing-account selection for native QA

The optional paired arguments `--codex-profile-home PATH` and
`--codex-account-id-sha256 SHA256` require `--real-provider`. The expected hash is
SHA-256 of the existing ChatGPT credential's `tokens.account_id` string. It is an
account identity check, not evidence of provider capacity or a successful turn.
Both arguments must be supplied explicitly by the maintained pre-cut config;
ambient `CODEX_HOME` is not used to choose an identity.

The selected source must be a canonical path below the invoking operating-system
account's home. Linux requires the same non-root UID throughout that path.
Windows uses the maintained owning-profile guard before probing any selected
path; a Linux path or a different Windows profile is refused. Directory links,
credential symlinks and unbounded or malformed records are refused. An existing
product hardlink at the exact owned `auth.json` leaf is permitted for a read:
the preparation never writes its inode. API-key and mixed API-key billing records
are refused.

The helper reads only that source credential and copies its exact verified bytes
to a new private `toolsenabled-native-account-*` directory under the owning
account's `.cache` (Linux) or `AppData/Local/Temp` (Windows). This directory is
outside the evidence tree. POSIX directory/file modes are 0700/0600; Windows
retains the owning profile's existing temporary-directory access boundary.
The exclusive auth file is newly created;
the source and copy must have different file identities. No source config,
sessions, account settings, models, or other sign-ins are copied or modified.

The application then uses its existing `createAccountRegistryStore.add`,
`setPolicy`, and `switchTo` operations against fresh **QA-only** stores. The only
entry is `QA selected Codex`, pointing to the private copy, with the supported
Codex manual selection policy. The normal engine's registry resolver and confined
session planner remain the authority. Their account probe and credential refresh
can change the private copy; the original source hash must remain unchanged.

Before input can start a provider, the real `mcProviders.accounts()` read must
return the sole expected directory, name, provider, provisioned sign-in, active
account, explicit `chosenByProvider.codex` pin, and Codex manual policy. Further
checks bracket every selected native case. The account list remains exact even
when Setup mirrors its visible failover choice into the global selection policy.

`mcAgent.sessionAccounts()` is a supplemental identity read. Each successful
start in the current app opening that has no subsequent matching signed END must
have its exact agent/session account row. END resolves the original **start
intent**, with the same agent and session. Cold app openings and confirmed closed
sessions do not invent retained rows. The required start/outcome references are
bound to the real verified history API using unchanged ledger bytes, total count,
and exact returned projection. The API has no direct hash attestation; the receipt
describes this consistency check, not a new cryptographic product contract.
Account rows alone do not prove a successful response. Existing native provider
case assertions and signed outcomes remain required.

All receipts contain only paths, file metadata, counts, statuses and SHA-256
hashes. No token, account ID, or credential bytes are written to report/actions.
`provider-account-custody.json` is durable before the first credential write so
an interrupted preparation can still be cleaned. Its allocated/prepared stages
are custody evidence, never native credit.

The native driver cannot complete credential cleanup by calling
`application.close()` alone. The outer runner must first prove its owned process
guardian closed, then import the exact hash-bound staged helper and call
`finalizeProviderAccount(receipt, {qaRoot, accountHome, platform,
processesClosed: true})`. The finalizer checks the original source again, unlinks
only this run's generated `agent-home/**/auth.json` names, and removes the recorded
temporary directory after checking its original device/inode. It leaves old run
artifacts and all owner source files alone. Malformed generated credentials remain
identity failures while their bounded owned names are removed. An incomplete
allocation can be cleaned without earning account or native proof.

The generated credential scan never traverses symbolic links. Non-auth links,
including Codex's `tmp/arg0` bootstrap entries, are ignored and left in place;
the scan makes no credential claim about their targets or other files. A linked
`auth.json` refuses account identity proof. After process closure its own leaf
may be unlinked only after the owned parent, leaf type and device/inode are
rechecked. That removal retains a link identity error and null credential
hashes; it cannot earn a pass, and its target is never read or removed.

The outer runner preserves the raw report and writes a separate cleanup receipt
bound to its accepted guardian proof, helper hash and original report/custody
hash. Full credit requires the expected account hash, successful actual native
results, unchanged original source, no retained temporary/generated credentials,
and no cleanup errors. Direct invocation without this outer finalization leaves
explicit-profile runs incomplete.

Source tests use synthetic sign-ins and the actual product registry store. They
cover wrong identities, invalid billing/records, path redirection, existing
registries, missing or borrowed account rows, correct and incorrect signed END
joins, private-copy isolation, interruption custody, credential refresh, and
failure cleanup. They launch no provider or GUI and earn no native coverage.
