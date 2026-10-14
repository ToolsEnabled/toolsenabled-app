# Proposed Linux direct-FRA authority contract

2026-09-05. Design for implementation and qualification, not implemented support
or a release verdict. Reviewed engine `10b29b629154b87923731e21cc8fc226ef78b0dd`;
the five authority/binding/workspace/manifest modules below are unchanged in
`6a6f57a90a0372b5ddcac14307446d81413f0e2d`. This documentation changes no runtime,
permissions, enrollment, receipts, capability manifests, or LIVE selection.

See the [platform parity plan](linux-platform-parity-plan.md) for adjacent
custody, lifecycle, confinement, enrollment, and release requirements. Source
paths below are relative to the engine repository.

## Customer behavior to preserve

A normal supported Linux installation should connect to its enrolled peer,
discover its permitted tools, list/read its permitted workspace, reconnect,
cancel, and revoke access through the existing workflow. Routine directory
changes must not demand enrollment again. Standard setup should provision the
product-owned private root and qualified dependencies; manual permission repair
must not become the normal customer experience.

Preserve each already qualified operation and its approval/audit rules. A missing
Linux adapter limits the dependent feature; it must not become a blanket reason
to disable otherwise supported operations. Existing shared roots need a scoped
setup/migration choice or a separately qualified sharing policy, not an automatic
recursive chmod, silent relocation, or weaker authority profile.

The actual FRA workspace surface is **read-only**: `workspace.list` and
`workspace.read` in `src/lib/tool-registry.js`. This contract does not introduce
`workspace.write`, authorize path-based `host.*`/`repo.*` tools, or make every
other allowed remote tool ready merely because workspace reads work. A future
write capability needs its own public schema, permission/approval policy,
descriptor-relative mutation and conflict semantics, audit, and native evidence.

## Closed version agreement

Keep Windows behavior and digest bytes intact. Select the expected **server**
contract from its locally pinned per-machine manifest, independently of the
client's OS and local root verification. A peer offer, claimed platform, or
connection failure cannot select a different policy or trigger a downgrade.

| Contract | Existing Windows | Proposed Linux |
| --- | --- | --- |
| Root-access report | Schema 1, existing DACL policy/descriptor digests | Schema 2, `linux-posix-owner.v1` |
| Root identity | Existing v1 digest unchanged | `linux-dev-inode.v1`, separate digest domain |
| Transport binding | Version 1 | Version 2 |
| Capability manifest | Schema 5 | Schema 6 |
| Workspace policy | Schema 1 | Schema 2 |
| Secure frames / bound requests / bound responses | Protocol 2 / version 1 / version 1 | Unchanged; separate these constants from binding version |

The successful Linux report has exactly these fields; digest placeholders below
mean lowercase 64-character SHA-256 values, not accepted literal values:

```json
{
  "schemaVersion": 2,
  "valid": true,
  "authorityKind": "linux-posix-owner.v1",
  "policyDigest": "<linux-policy-digest>",
  "descriptorDigest": "<linux-authority-descriptor-digest>",
  "secretValuesEmitted": false
}
```

Both producer and consumer validate the exact known kind/policy combination;
well-formed arbitrary digests are insufficient. Keep raw paths, UIDs, account
names and ACLs out of transport and public health. A digest bound to an
authenticated session is not independent remote-kernel attestation.

Binding v2 retains every v1 binding field except `rootAclDigest`, replacing that
field with `rootAuthorityDigest` and adding `rootAuthorityKind` and
`rootIdentityScheme`. Do not label a Linux observation as a Windows ACL digest.
Use new `ToolsEnabled/FRA/transport-binding/v2` and
`ToolsEnabled/FRA/device-identity/v2` domains. The context covers every binding
field except its own digest. Device identity covers server host, identity scheme
and digest, authority kind and digest, and root-access policy digest. Unknown
versions, missing/extra fields, and mismatched kinds/policies refuse admission.

Manifest schema 6 keeps schema 5's exact top-level key set. Its closed
`transportPolicy` has these values: `bindingSchemaVersion: 2`,
`boundRequestSchemaVersion: 1`, `boundResponseSchemaVersion: 1`,
`protocolVersion: 2`, the existing `resultProjectorVersion`,
`rootIdentityScheme: "linux-dev-inode.v1"`,
`rootAuthorityKind: "linux-posix-owner.v1"`, the known Linux
`rootAccessPolicyDigest` and `workspacePolicyDigest`, and
`pathIdentityDisclosure: false`. No other keys are accepted. Existing tool-name,
desktop, excluded-tool, registry, permission, and result-projection checks remain.
Implement these branches in `src/lib/fra-capability-manifest.js` and
`src/lib/fra-transport-binding.js`, replacing their assumption of one global
Windows transport descriptor with validation of the pinned server contract.

Workspace policy schema 2 in `src/lib/fra-workspace-policy.js` retains schema 1's
keys and limits, changes the schema number, and adds `directoryLinkCount: "positive"`,
`pathComparison: "case-sensitive"`, `descendantMounts: "refused"`, and
`rootAuthorityLifetime: "shared-descriptor"`. Its policy digest uses a v2 domain.
`hardLinksRefused` continues to reject multiply linked regular files; normal
Linux directory link counts are not evidence of such a file alias.

An updated Linux client may validate a legacy Windows v1 server. A legacy
Windows client cannot validate a Linux v2 server: bidirectional Windows/Linux
support requires the updated Windows validator and the pinned Linux declaration.
Keep Windows emission at v1 initially. Add explicit version branches for binding
acceptance, workspace context, public readiness, and both receipt directions,
including rotation-proof checks. Current receipt formats already have their own
version history; do not conflate those versions with binding v1/v2. Do not clear
continuity records or repin changed identities to make an upgrade pass.

## One native authority lifetime

`src/lib/fra-root-access.js`, `src/lib/fra-transport-binding.js`, and
`src/lib/providers/fra-workspace-handles.js` need a private shared authority
object holding one root directory FD. Acquisition, identity/access measurement,
session binding, and workspace operations must refer to that object. A later
independent pathname open cannot inherit an earlier successful report.

The initial Linux policy requires kernel-derived nonroot `uid == euid`, the
selected installation owner's UID, a directory owned by that UID, exact mode
`0700`, and stable `dev/ino/uid/gid/mode` observations. Reuse or extract the
identity-check seam in `src/lib/owner-host-linux.js`; environment usernames are
not identity. Verify access and default ACLs through the opened object. Initially
refuse extended/default ACLs and unavailable inspection. Mode `0700` bounds
effective named permissions but does not establish that named/default ACLs are
absent. See the [Linux ACL rules](https://man7.org/linux/man-pages/man5/acl.5.html).

Walk ancestors without following symlinks. Require root/current-owner control
and no replacement rights for unrelated accounts; a root-owned sticky temporary
ancestor may contain a verified owner-private test directory. Check the observed
root against the acquired FD. The selected root may itself be a mount; refuse
descendant mount traversal, including same-filesystem bind mounts. Initially
qualify named native local filesystem/kernel combinations. Network/FUSE or other
unmeasured semantics require their own profile and evidence, not an assumed pass.

Hash persistent Linux identity from `dev/ino` under
`ToolsEnabled/FRA/root-identity/linux/v1`; hash the canonical UID/GID/mode/ACL
observation under `ToolsEnabled/FRA/root-authority/linux/v1`. Define the policy
descriptor separately under `ToolsEnabled/FRA/root-access-policy/linux/v1`.
Exclude link count, size, and timestamps from persistent identity/authority.
They may change during ordinary development. Device/inode continuity is not an
eternal machine identifier: replacement, inode reuse, remount, or migration
needs an explicit continuity policy, not automatic reenrollment.

Revalidate the retained authority before admitting a session and before/after
workspace operations. Authority drift invalidates dependent sessions without
returning read content. Close operation/session-owned FDs on refusal or teardown;
close the shared root FD when its last session/backend reference is released,
and on process shutdown. Trust in the kernel and privileged administrator remains an
assumption; a UID check does not isolate malicious processes with the same UID.
Agent confinement and custody remain separate requirements.

## Descriptor-relative workspace backend

Enumerate the opened directory, resolve descendants from the retained root FD,
and read only validated regular-file FDs. Use `openat2` with
`RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV`, suitable directory/
no-follow/nonblocking flags, type checks, bounded reads, and before/after
`fstat`. `O_NOFOLLOW` alone protects only the final component, and `st_dev` alone
does not catch every bind mount. See the
[openat2 contract](https://man7.org/linux/man-pages/man2/openat2.2.html).

A narrow native adapter or trusted isolated system-Python helper with an
inherited root FD is an implementation seam. Python supports descriptor-relative
opens and directory-FD enumeration; its helper would still need an explicitly
supported, tested `openat2` binding. See
[Python's OS interfaces](https://docs.python.org/3/library/os.html#os.open).
Do not return a child-process FD number as though the parent owns that FD. Pin
helper inputs in runtime integrity, bound its protocol/output/lifetime, and
refuse unavailable primitives rather than falling back to lexical confinement.

Require `nlink == 1` for regular files and a positive live directory link count.
Use case-sensitive identity/handle keys. Keep mutable metadata, including
directory link count, in stale-operation versions, separate from root continuity.
Retain pathless session-scoped handles, credential/history exclusions, cursor
expiry/single use, size/entry/session bounds, and durable anchored audit before
returning results. A fresh root listing must issue current handles after ordinary
directory edits; stale handles remain invalid. Customers must be able to refresh
the read-only view without restarting the app or establishing trust again.

## Readiness and actionable errors

These are proposed contract mappings, not currently shipped new error codes.
Expose the feature, adapter/contract version, observation time, bounded reason,
and safe recovery action. Preserve ordinary per-operation permission refusals.

| Condition | Feature state and customer behavior |
| --- | --- |
| Qualified prerequisites and accepted peer contract | `available`; allow the normal permitted operation, subject to its existing scope/approval/audit checks |
| No qualified adapter or incompatible peer contract | `unsupported`, proposed `FRA_LINUX_AUTHORITY_UNQUALIFIED` / `FRA_PEER_CONTRACT_UNSUPPORTED`; identify which component needs a supported build |
| Verified root permissions/ownership unsuitable, required local unlock or enrollment absent | `needs-owner-action`; explain the specific local setup/unlock/enrollment step; never repair or enroll silently |
| Authority changed after validation | Refuse with proposed `FRA_AUTHORITY_CHANGED`, invalidate affected sessions, and require verified local recovery without discarding the prior identity pin |
| Helper/probe timeout, unreadable state, or unestablished current authority | `unknown`, `FRA_ROOT_ACCESS_UNAVAILABLE`; retain diagnostics privately and offer a bounded readiness retry |
| Stale workspace handle/cursor or forbidden entry | Existing operation-level refusal; permit a fresh listing or selection of an allowed entry; do not mark all remote functionality unsupported |

Separate transport reachability, enrollment/authentication, accepted authority,
and operation readiness. No green direct-FRA readiness from import success, an
open port, SSH exchange, or a root probe alone. Do not automatically retry remote
writes or silently substitute another transport to bypass an unmet gate.

## Qualification and integration order

1. Freeze schemas, policy descriptors, digest vectors, compatibility matrix, and
   receipt/rotation transitions. Implement dual parsers without enabling Linux
   direct-FRA readiness. Exercise unknown fields/versions/kinds and downgrade
   rejection while preserving the Windows v1 capability set and receipts.
2. Implement the native authority and workspace backend as one lifetime. Test
   real private directories and untouched Linux stat values: normal setup,
   permitted listing/read/pagination, case-distinct names, spaces/Unicode,
   refresh after file/subdirectory edits, cancellation, cleanup, and reconnect.
   Pair each refusal with the corresponding permitted customer operation.
3. Exercise real symlinks, ancestor/root replacement, hard links, special files,
   UID/mode/access/default-ACL changes, native mount-namespace bind mounts,
   stale/replayed/cross-session handles, exhausted bounds, audit loss, helper
   failure, and unsupported primitives. Ownership/mount prerequisites unavailable
   in a runner remain explicitly untested; injected stats cannot replace them.
4. Integrate bridge/proxy, per-machine manifests, integrity inputs, both receipts,
   rotation and readiness projections together. On both real OSes, prove an
   authenticated accepted binding, tool discovery, a harmless permitted native
   workspace read, reconnect, revocation, and the matching negative controls in
   each direction. Qualify other permitted remote effects at their own boundaries.
5. Only then admit the qualified Linux direct-FRA profile in a customer build.
   Test the normal customer setup and existing supported workflows, recovery from
   unmet prerequisites, and Windows regression behavior. Record exact source
   commits, native dependencies, transport, test account/root scope, terminal
   outcomes, positive/negative evidence, and remaining limitations. Normal release
   and delivery gates still apply; this document requests no activation.

The read-only review measured a real Linux source directory with link count 24,
stable device/inode, matching owner UID, and functioning directory/no-follow
open flags. That confirms an incompatible assumption, not a working FRA session.
`tests/fra-workspace-refusals.test.js` currently substitutes `nlink: 1n`; it is
refusal-unit evidence, not native Linux qualification.

Still unqualified by this review: the proposed Linux authority/backend and wire
versions; native ACL/ownership/mount/race coverage; both direct Windows/Linux
customer directions; continuity/rotation/recovery with the new contract; and
each additional remote effect, filesystem/dependency combination, and packaged
installation. Website claim/relay/enrollment and process confinement/lifecycle
retain their separate acceptance work. SSH-carried cryptographic exchange does
not qualify those surfaces or the direct-FRA listener/workspace path.
