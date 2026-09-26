# Linux development and the shared API boundary

Status: first action-contract increment implemented, 2026-09-05; broader
decoupling remains in progress. This is not a claim of complete Linux support.

The [Linux platform parity plan](linux-platform-parity-plan.md) maps native
security, lifecycle, desktop and FRA adapters to explicit acceptance tests.

## Decision

Develop from a checkout. Installer creation is a release/installation test,
not the normal edit/test loop. Keep one shared product/API and implement the
operating-system differences behind it. Do not fork Linux business logic or
expose an unauthenticated development listener.

## Existing contracts to retain

| Boundary | Current implementation | Work to formalize |
| --- | --- | --- |
| Renderer to desktop | `shell/preload.cjs`, validated IPC handlers in `shell/main.cjs` | Typed requests, replies and events; explicit native capability availability |
| Desktop/renderer to local action engine | Engine `src/lib/mission-bridge/server.js`, `/v1/runtime`, `/v1/bootstrap`, authenticated `/v1/status` and `/v1/actions/*` | Machine-readable schemas and compatibility negotiation derived from actual handlers |
| Agent tools | Engine tool registry and MCP surface | Generate schemas, effect/approval metadata and API documentation from the registry; do not hand-maintain a second catalogue |
| Remote machine | Existing FRA secure-session/transport-binding contracts | Retain peer enrollment, authentication, replay protection, workspace permissions and audit; add tested Linux platform adapters |
| Source synchronization | Git transport, with existing Filekeeper controls where bound | Separate source commit identity and dirty changes from protocol compatibility; combine only committed histories in isolated Git objects, never a running runtime or dirty checkout |

The desktop also directly requires engine modules, including the owner-host
session authority. Therefore the current product is **not** a fully separated
HTTP client/server. Move those boundaries deliberately, with their existing
permission and lifetime tests, rather than assuming a remote URL replaces them.

`/v1/runtime` currently describes process/endpoint discovery. It is not yet a
complete app/engine compatibility handshake. FRA's protocol version and an app
release label such as 1.0.41 are separate identities, not interchangeable API
versions.

## Contract acceptance criteria

1. One authoritative schema set generates validators, types and documentation.
   Existing tool schemas and handlers remain the authority during migration.
2. A client can determine API major version, supported capabilities and actual
   build identity before invoking a feature. An installed capability is not
   necessarily available, authenticated or authorized on this machine.
3. Unknown major versions and required missing features refuse explicitly.
   Additive optional changes preserve compatibility; breaking changes require
   a new contract major version and compatibility tests.
4. Requests, responses and streamed events define stable errors, request IDs,
   cancellation, reconnect/cursor behavior, and retry/idempotency semantics.
   Never automatically retry a write without a deduplication guarantee.
5. Windows and Linux run the same contract tests. Platform adapters own secret
   storage, filesystem/process ownership, agent isolation, desktop automation
   and service management. A missing adapter produces an explicit unsupported
   result, not an empty success or a disabled safety check.
6. Local bridge binding remains loopback-only. Source mode preserves bootstrap
   proof, exact origin/session checks, approval gates and signed audit. Remote
   access uses the enrolled remote transport, not a widened local listener.

## Implemented first increment

Authenticated `GET /v1/contract` now returns `{ ok: true, contract }`. Its action
names come from the actual engine route table, not a second catalogue. The
descriptor names the API major/minor version and explicitly states that action
registration is neither authorization nor readiness, and that writes must not
be automatically retried. It carries no token, proof, owner path or runtime data.

The schema and compatibility implementation are authoritative in engine
`src/lib/mission-bridge/api-contract.js`. Desktop
`tools/sync-bridge-api-contract.mjs` generates the browser module, TypeScript
declarations and JSON schema from a clean, exactly pinned engine commit.
`--check` refuses stale/missing generated artifacts. The Linux development
launcher runs that check; refresh regenerates before building renderer assets.

`bridgeApiContract({ requiredActions })` inspects through the existing local or
remote transport and reports malformed descriptors, unsupported API majors and
missing required actions explicitly. The descriptor's closed envelope has its
own `schemaVersion`; current minor-version compatibility permits additive
action registrations within that envelope. New envelope fields need a decoder
version change, not a silent promise that old clients will understand them.

This is contract inspection, not yet a mandatory negotiation step for every
existing product call. Full action input/output schemas, event contracts,
runtime capability availability and application-wide negotiation remain work
to do. Existing action authorization, approval and audit behavior is unchanged.
The native source smoke does perform authenticated contract inspection and
checks required actions before reporting a compatible engine.

## Development loop now versus next

Now: launch Electron directly against the checkout and built renderer. Reuse
the staged engine while its exact source ref matches. Renderer watch builds
need only a window reload. Main-process/engine changes need a controlled
restart; engine changes still pass the existing clean-commit staging gates.
None of these requires an installer or publishing a release.

Next: add an explicitly development-only source binding or separately launched
engine through the formalized contract. Keep source mode clearly distinct from
sealed release payloads. Do not forge a release manifest over dirty source,
reuse Windows credentials, hot-swap an active agent process, or weaken release
integrity checks merely to shorten the development loop.

Packaging remains necessary for installer/update behavior, shipped-resource
closure, executable fuses/signing, and final release acceptance. Source-mode
success is not evidence that these packaged checks have passed.

## Shared LIVE startup

The workspace launch adapters select compatible committed local, configured
Git and reachable peer histories. Their private source-sync mailbox is carried
over authenticated SSH; it is not a product API, a new network listener, or an
alternative FRA enrollment path. A missing peer uses local and cached Git
sources. Unfinished working files are preserved and are not silently committed.

A common source pair identifies a candidate, not a native build verdict. Each
OS builds immutable resources and runs its own normal checks before activation.
Source conflicts and failed checks keep the last validated runtime available.
An open LIVE session is never hot-swapped or forcibly restarted by source sync.
API compatibility and native capability readiness must still be checked even
when both machines name the same app and engine commits.
