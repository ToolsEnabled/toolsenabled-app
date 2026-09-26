# Bounded work under a saved tree node

Page 2 bounded work uses an actual saved child of the selected live node. It
starts that child's declared identity through `mcAgent.start`, using the normal
role, profile, workspace, account, resource and signed start admission. It does
not translate a tree node into a declared legacy dispatch lane or fabricate a
legacy launch receipt.

The additional public start field has exactly five keys:

```js
boundedWork: { computerId, treeId, parentNodeId, parentSessionId, capMs }
```

`treeId` names the saved tree container. `requestKeys.treeAnchors` still starts
with the root node id. The child must already be saved below the exact live
parent, under the same owning window and selected profile. Main rechecks the
saved graph and retained workspace inode boundary at the provider root. Public
caps are integer milliseconds from 1,000 through 86,400,000. The monotonic clock
starts before the signed intent; startup consumes this time too.

Start returns its existing real `{sequence,eventHash}` record and a
`boundedWork` object containing the admitted identities, `action:'tree.dispatch'`,
`capMs`, numeric epoch-millisecond `startedAt`/`deadlineAt`, `state`, `reason` and
nullable `endedAt`. `mcAgent.workStatus({sessionId})` returns those fields at the
top level alongside `ok`, the actual start `record` and nullable `endRecord`.
Only the original owner can read that retained status. A reused session id cannot
borrow the previous receipt. Controllers must compare the exact receipt before
acting on a retained session. Bounded starts require the local owning window;
`agent:work-status` is explicitly omitted from the remote facade for the same
reason. Adding this command must preserve the facade's exhaustive inventory
check, including construction during desktop availability.

The cap belongs to the host and survives view retirement. Codex and Claude
starts must provide a retained process-tree cleanup receipt on Linux and Windows.
The Local tier has no such session lease and is refused for bounded work.
`mcAgent.close` uses the normal exact owned session operation. Status remains
`closing` or `close-failed` until cleanup is proven; a failed cleanup retains its
handle and resource debit for retry. `session_ended` reports `cap-reached` or
`parent-stopped` only after cleanup. An expired startup reports
`MC_TREE_BOUNDED_WORK_CAP_REACHED` after cleanup.

Native descendant sessions are separate provider roots. Their starts inherit
the parent's remaining cap before the signed intent, even if the request came
through agent delegation without a renderer cap field. Inherited records use
`action:'tree.delegate'` and name their `capSourceSessionId`. An explicitly
bounded nested start keeps `tree.dispatch` but can receive a shorter cap; the
returned positive duration may be below 1,000 ms. Closing or reaching the cap
of a parent awaits all of these child scopes, including children moved later.
No additional fanout or session-count limit is imposed. Tree ancestry remains
bounded to the existing 16 anchors. Automatic account recovery cannot start an
unbounded replacement of a bounded session.

This is a native session lifetime: a completed reply leaves its session ready
until Stop, cap, exit or parent closure. Turn completion is reported through the
existing turn events. `workStatus` describes session cleanup, not whether a reply
is currently running. A repeating controller must close a completed run and
confirm its exact session closed before starting the next saved child.

The maintained `test:data` runner includes `tree-bounded-work`,
`agent-host-bounded-work`, `tree-bounded-audit`, and `tree-lifecycle-main` tests.
They prove host/IPC/authority/audit behavior with local fixtures. The engine's
separate Linux and Windows containment tests execute harmless real processes.
Neither test scope by itself proves provider tool cancellation on turn interrupt;
native Page 2 provider testing is still required for that behavior.
