# Coordinator tree-node commands

This local, one-time bootstrap replaces a dead session attached to an existing
saved tree node, then delivers a separately reviewed first turn to the newly
bound session. It requires no UI automation, browser debugging, or Git window.

The two operations are intentionally separate:

1. `fresh-start-existing-node` removes the node's active transcript, diff,
   queued turns, and old runtime mappings; starts a clean provider session; and
   binds that session to the saved node and renderer event maps. It never uses
   `resumeThreadId`, never seeds a saved transcript, and cannot contain or send
   a prompt.
2. `send-to-bound-node` verifies the exact computer, tree, node, and new session
   binding before sending one bounded message. Its message is read from the
   writer's stdin and exists only inside the ACL-protected request file while
   queued. It is never placed in argv, a result, or an application log.

Back up the owning ToolsEnabled preferences before the clean start if the old
transcript must be retained as evidence.

## Storage boundary

`AGENT-SUPPORT-CHANNEL` remains a durable coordination mailbox. Its staged
copy stays mutation-dead; these commands neither create nor modify any file in
that mailbox.

App commands instead use the running application's private per-user data:

```text
<app.getPath('userData')>/coordinator-commands/
  requests/
  claims/
  results/
```

Main creates and protects those directories. On Windows, writable ACL entries
are accepted only for the current account SID, SYSTEM, and built-in
Administrators; any other group, user, or unresolved identity is refused. On
POSIX, the current uid must own private directories/files. Reparse points are
refused throughout the spool.

A request file alone never starts or sends anything. The coordinator must also
launch the same installed ToolsEnabled executable, under the owning user's
limited interactive token, with the one opaque switch emitted by the writer.
Electron forwards only that request ID to the primary. The helper process does
not focus or restore the window and exits after handoff. Main resolves its own
`app.getPath('userData')` again; no caller-supplied path crosses the executable
boundary. If no primary is running, the helper writes
`MC_TREE_COMMAND_PRIMARY_INSTANCE_REQUIRED` and exits without creating a
window; start ToolsEnabled normally, then prepare a new explicit request.

## 1. Create and hand off a clean start

Never hand-edit command JSON. From `app-reconciled`, run the writer as the same
Windows account that owns the installed app:

```text
node tools/write-tree-node-command.mjs \
  --user-data-root <exact-ToolsEnabled-userData-directory> \
  --action fresh-start-existing-node \
  --computer-id <persisted-computer-id> \
  --tree-id <persisted-tree-id> \
  --node-id <persisted-node-id> \
  --expected-session-id <old-session-id>
```

`--expected-session-id` is optional for a clean start but recommended. It
refuses the request if somebody rebound the node after preparation. The writer
prints machine-readable JSON with `requestId`, `requestFile`, `resultFile`, and
`launchArgument`; it does not launch the app.

Pass only `launchArgument` to the installed executable. Do not add a cwd, URL,
message, file, or Chromium/Electron option. The private command grammar refuses
all additional argv. Wait for the immutable result. A successful result names
the new `sessionId`; the node and event-routing map are already bound before
that result can be published.

### Launching a development or named-profile copy

A copy that is not the installed executable is launched the way Electron
launches an unpackaged app, and the grammar admits exactly that shape and no
more:

```text
<electron.exe> <appDirectory> --user-data-dir=<the same userData directory> <launchArgument>
```

Do not hand-roll that line. `tools/launch-tree-node-command.mjs` writes the
request and starts the helper with the argv `shell/tree-node-command.cjs`
builds (`treeNodeCommandLaunchArgv`), which is the same slot table the running
application parses (`treeNodeCommandRequestIdFromArgv`); the two cannot drift.
It takes the writer's options plus `--electron <electron.exe>` and, for a
development launch, `--app-dir <appDirectory>`; the profile switch is the
`--user-data-root` the request was spooled to. `--wait-seconds <n>` polls for
the result and prints it (exit 3 if none arrives).

```text
node tools/launch-tree-node-command.mjs \
  --user-data-root %APPDATA%\ToolsEnabled-Live \
  --electron <WF>\deps\app-node_modules\electron\dist\electron.exe \
  --app-dir <WF>\live \
  --action fresh-start-existing-node \
  --computer-id <persisted-computer-id> --tree-id <persisted-tree-id> --node-id <persisted-node-id> \
  --wait-seconds 120
```

The application directory may equally be spelled as the main script inside it;
both name the same application. `--user-data-dir` is optional but it is what
decides WHICH spool the helper reads, so a copy running on a named profile — the
live tier, a QA profile — must pass the same one the running app was started
with, or the helper looks in the default profile, finds nothing, and the request
is never answered. Only the single-token `=` spelling is accepted; everything
else the paragraph above refuses, it still refuses, and a packaged launch admits
neither the directory nor the profile switch.

MEASURED 2026-09-03: nine resume commands spooled against the live tier were
launched as `<electron.exe> <appDirectory> <launchArgument>` with no profile
switch. All nine request files were written; `claims/` and `results/` stayed
empty; the caller read the absent result as success.

MEASURED 2026-09-04 on Electron 43.3.0 (Windows): the argv the PRIMARY receives
in `second-instance` for the helper above is not in launch order. Chromium keeps
switches ahead of positional arguments and appends what the helper added to its
own command line before the lock, so the primary sees

```text
<electron.exe> --user-data-dir=<profile> <launchArgument> --allow-file-access-from-files --remote-debugging-port=<n> --remote-debugging-address=<a> <appDirectory>
```

(the two `--remote-debugging-*` switches only when outside control is on; the
running app appends them at start, and so does the helper). The grammar
therefore pins the executable first and fills the remaining slots in any order,
each at most once; Chromium's own switches and the ones the application itself
appends are dropped by name from closed lists, and any other token still
refuses. A restart spooled by the Controller circle at 2026-09-04T08:16Z was
refused `MC_TREE_COMMAND_ARGUMENT_INVALID` by the earlier order-bound grammar,
with no reason in the result; refusals now carry one (see below).

## 2. Create and hand off the sanitized first turn

Prepare a new `send-to-bound-node` request with the successful session id:

```text
node tools/write-tree-node-command.mjs \
  --user-data-root <same-ToolsEnabled-userData-directory> \
  --action send-to-bound-node \
  --computer-id <same-computer-id> \
  --tree-id <same-tree-id> \
  --node-id <same-node-id> \
  --expected-session-id <new-session-id>
```

For this action, the writer requires the sanitized message on standard input.
The coordinator should pipe bytes from its in-memory reviewed packet directly
to stdin; never add a `--message` argument or echo the words into a command
line. Empty, NUL-containing, or oversized input is refused.

Again, launch the installed executable with only the emitted opaque argument
and wait for its result. The renderer refuses the send unless
`RUN_SESSION_NODES[newSessionId]` points to that node and the tree store still
attaches the same session. Success reports identifiers only; it never repeats
the message.

## Recovery behavior

Main allows one claimed command at a time. It writes a closed failure if the
renderer reloads or disappears, rather than replaying an operation that may
already have reached a provider. It also owns a bounded completion timeout and
retries immutable result publication. Persistent publication failure is logged
by code and released so later commands are not wedged; recovery always requires
a new explicit request.

A launch that dies BEFORE the broker ever sees it now answers the same way. The
helper is spawned detached with its output discarded, so a console line or a
stderr write reaches nobody; a refused argv grammar
(`MC_TREE_COMMAND_ARGUMENT_INVALID`), a mismatched single-instance handoff
(`MC_TREE_COMMAND_ARGUMENT_MISMATCH`) and a launch with no primary instance to
receive it (`MC_TREE_COMMAND_PRIMARY_INSTANCE_REQUIRED`) each publish that code
into the request's own immutable result. The refusal claims the request exactly
the way a real consumer does, so a command another process is already running
is never overwritten — it is left alone and the refusal is dropped instead.

Since 2026-09-04 such a refusal also carries a `reason` beside `code`: one
bounded sentence (at most 512 characters, control characters folded to spaces)
saying which argument was refused and what the launch shape is, or that no
primary instance was running. A switch appears in it by name only, never with
its value. `reason` is optional in the result schema — every result written
before it still validates — and never appears on a success.

Nothing here makes an absent result mean success. If a request file is still in
`requests/` with nothing in `claims/` or `results/`, the launch never reached
this application at all — check that the executable, the application directory
and the profile switch are the ones the running copy uses.
