# Existing native conversation Stop, version 1

This is a paired-person operation on one saved native node and its exact live
window-owned session. It uses the native person's confirmed-close cleanup. It
is separate from delegated tree commands and remote-created agent ownership.
The engine and ordinary `ownedAgentSession` rule are unchanged.

`GET /v1/agent/desktop-sessions` may return `desktopStopVersion: 1` and an
individual row's `stopTarget`:

```json
{"version":1,"treeId":"tree-id","nodeId":"node-id","sessionId":"session-id","revision":"64 lowercase hex characters"}
```

The revision binds native runtime, session object identity, saved tree/node
creation identity, membership and parent. Reply streaming does not invalidate
it. It is a comparison token, never an authority grant. Target publication
requires current write permission, pairing, an unbounded native session and a
ready native Computers controller. No controller is opened or navigated to by
this feature. Missing capability is explicitly unavailable. A replacement,
active recovery/continuation or automatic retry policy may still refuse the
request at the native controller; no other session is stopped as a substitute.

`POST /v1/agent/desktop-stop` accepts only `{requestId, target}`. `requestId` is a
lowercase UUID and target is the entire returned object. The body is bounded to
4096 bytes. `GET /v1/agent/desktop-stop-status?requestId=UUID` polls its receipt.
Both require the current paired account/connection. Write consent is rechecked
before admission and again at the exact native close edge. No browser-supplied
owner, principal, delegation, path or alternative action is accepted.

Receipts contain `ok`, `requestId`, `target`, `state`, `closed`, `savedState` and
an optional bounded `code`:

- `pending`: admitted, no completed Stop claimed.
- `completed`: exact host close confirmed and the authoritative native saved
  node records `finished` / `Stopped by you.`.
- `needs-attention`: the close or saved-state completion is uncertain.
  `closed:true,savedState:unconfirmed` preserves the host fact while refusing a
  saved-state claim. `closed:false,savedState:pending` retains the Stop target.
- `refused`, with `ok:false,outcome:not-sent`: no native close dispatched.

The same request ID and body returns the same operation, including after its
session disappears. Another body under that ID is refused. An unresolved Stop
cannot be repeated under another ID. At most 64 operations are retained;
completed/definitely refused receipts expire after a fixed 30 minutes.
Unresolved cleanup is not evicted. Disconnect/sign-out hides prior receipts
without cancelling already-admitted native cleanup. A native runtime restart
ends this in-memory journal; it must not trigger an automatic resubmission.

Native delivery uses a one-use private token redeemed only by the application's
own main frame. The trusted IPC event supplies the ordinary window principal.
The close lease is rechecked after the physical pairing read and immediately
before the existing `agent:close` implementation. Renderer claims cannot forge
a host close or a persisted native note. View exit/crash before redemption
refuses; exit during an admitted close preserves its host result and reports
saved state unconfirmed. There is one native saved store and no alternate tree.

A hosted consumer must retain the original request ID/target, fence all results
by account and chosen-computer generation, and refresh the authoritative tree
following confirmed cleanup. It must not infer stopped state, automatically
retry an uncertain POST, or replace its target with a newer session. Actual
Linux, Windows and hosted qualification is separate from source tests.
