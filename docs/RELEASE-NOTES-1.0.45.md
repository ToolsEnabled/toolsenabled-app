# ToolsEnabled 1.0.45

*Released 2026-09-15*

ToolsEnabled 1.0.45 is the official public Beta for Linux and Windows. Each
platform's release packet records the exact source pair, artifact digest and
qualification results. Publication requires both platform cuts to pass.

The Windows half of this release is about the agent tree and the conversations
that hang off it. Saved trees are read through a checked authority. A
conversation keeps its identity and draft while you move around it. The
controls in a chat do what they look like they do.

## Highlights

- Agent conversations retain their request, reply and tool context after reload.
- The tree supports Claude, Codex, Grok, Local and AGY sessions with accurate
  availability, completion and Stop behavior.
- Each current Ledger category has a reset control with a confirmation warning:
  Tasks, Rules, Asks and Purchases.
- Saved agent trees are read through a verified authority adapter instead of a direct read. A
  tree too large for one bridge response is recovered a page at a time rather than lost.
- A full-conversation chat now behaves like the rail chat. The slash Loop row opens a loop control
  you can see and use. Tabs and drafts survive switching. Supplied thinking stays visible while
  the reply is still mid-sentence.
- A reply appears word by word as the agent speaks it. The thinking that produced it stays
  visible until those words begin, then folds away — still there to open again.

## Added

- Ledger reset warnings show current counts and reject stale confirmations.
  Purchase resets recover an interrupted update across the Ledger and prompts.
- ACP exit diagnostics retain bounded process exit evidence for troubleshooting.
- Exact native desktop Stop receipts on remote conversations, paired to one session.
- Paged recovery of a desktop tree after an oversized bridge response.
- Multiline prompts in native tree conversations.
- Confirmed workspace recovery offered after an agent start is refused.
- Native saved-tree boundaries and reported activity shown on phones.
- A workspace picker when the Documents hint is unavailable.
- A vault credentials page in Settings. It lists the names of the records on file. It shows nothing
  that narrows a value. Adding a credential goes through the product's own request flow.
- Removing a credential asks you once, and removes exactly what you approved. The approval is tied
  to the record it was shown for. One removal spends it, and it expires. A removal is reported only
  after it has actually resolved. A store that cannot be listed says why rather than drawing an
  empty list.
- Engine: real MCP entry contracts with verified refusal exit and session binding, and owner proxy
  dispatch modes with session cancellation.

## Changed

- Large tree boxes keep their dimensions and use the bottom box for context.
  Status indicators occupy the top box. Circles use more of their card for context.
- Autonomous+ uses bounded recovery delays and retains its retry budget across
  reloads. Stop and permission holds remain authoritative.
- Linux packaged UI failures stop the cut before installation and tagging.
  Packet install details come from the measured package, and the completed note
  must pass validation before the immutable build tag is created.
- Cuts use fresh dependencies and verify the frozen app/engine source pair
  before and after each operation. Tagging requires the actual packaged and
  installed qualification records.
- Ratchets reject new failure identities even when the total failure count
  stays the same or falls. Updating a baseline cannot absorb a regression.
- The cutter puts its scratch directories under the per-user temporary root. It no longer follows
  the temporary path the packaging chain rewrites underneath it. A cut writes where it meant to.
- A cut now checks that the engine it was told to use is the engine it packed. The declared source,
  the packed engine's own recorded revision and its helper programs all have to agree. The five
  checks over what was packed run at that point, before the ratchet, rather than later.
- The release qualification's list of test files is reconciled against the tree on both sides. A
  file that landed without being listed is refused. So is a listed file that was renamed away.
  Neither passes unnoticed any more.
- A cut is fenced off the installation it is running on. Every setting that can point this product
  at a different folder, database or file is cleared first, then pointed inside the cut's own
  scratch. The list is the product's own, in `shell/capability-path-environment.cjs`. A new place
  the product saves to joins the fence when it is added, rather than being remembered separately.
  Without that, a cut inherits the live state folder and vault from whoever started it, and writes
  its test records into the owner's own ledger.
- Saved desktop trees are read through a verified authority adapter, and native workspace authority
  is mounted independently of the legacy read path.
- Machine switch outcomes are kept across views behind intent fences, and each prepared choice
  intent is consumed exactly once.
- Settings sections are laid out against the actual content width, so a section stays readable and
  reachable instead of overflowing.
- Session diffs are loaded from the folder they were registered in rather than a guessed one.
- Electron's recovery cache and temporary files stay inside the candidate instead of leaking into
  the surrounding tree.
- Native tree refusal copy is plain language: a refusal says what happened in words a person reads.
- Read-only mobile controls are labelled as read-only, and a closed native detail stays closed.
- Custody reporting is bound to one original owned job, and missing custody provenance is refused
  before a native replay rather than replayed anyway.
- Windows tool prerequisites are all reported, and reporting them does not grant admission.
- The Metrics page states the period and the account scope it is showing, and offers a
  local-computer scope. An empty page can then be told apart from an empty account.
- Engine: Claude display names are recognised when an allowance window is selected, and Claude model
  scope is preserved in legacy quota windows.
- Accounts and FRA: hosted account authority expires at the session deadline. Unavailable hosted
  workspaces stay on their real source. The account usage contract between the window and the
  program is aligned with the measured Gemini explanation. Native FRA trees refresh and open the
  exact desktop conversation.

## Fixed

- **Screen control could not be turned on at all on Windows**. The hold-to-stop chord was
  Control+Alt+Escape everywhere. Windows keeps that one for itself, so it refused to register the
  chord, and turning screen control on failed. On Windows the chord is now
  Control+Alt+Shift+Escape, and that is what the indicator shows you. Other platforms keep
  Control+Alt+Escape. There is no list of fallbacks, on purpose. Holding the chord is also what
  reserves desktop input across programs. It has to be one known chord, not whichever one was free.
- Fast Local completion no longer races the terminal acknowledgement.
- Grok and AGY availability agrees with the actual provider launcher.
- Queued tree batches preserve owner priority and resumed child identity.
- Stop waits for owned host commands to terminate before releasing the session.
- Request and reply turn identities survive native session reconnects.
- Branch headings count the agents in the displayed branch.
- Relayed agents appear on the canvas when the local saved tree is empty.
- Unplaced chats retain drafts and sessions while navigating between pages.
- Linux authorization finds the registered browser and closes its terminal
  after successful completion; provider refusals remain visible.
- Audit file inspection runs in a separate process, preserving SQLite locks.
- The installer's classification of shipped files includes the Ledger reset and audit inspection
  modules used by the repaired source pair.
- Cut test diagnostics are retained as they arrive, including partial output
  after interruption, and quoted TAP diagnostics no longer break measurement.
- Research results stay with the account that started them. Saved local workers
  reconnect after a reload, and fast replies retain their native transcript.
- Each platform cut validates its measured release note before tagging. The
  release plan still names every platform that must qualify before publication.
- **Choosing `/loop` in a full tree conversation opened nothing you could see**. The interval control
  was rendered at zero size, outside the pointer, with focus left on the composer button. The same
  step in the right-rail chat worked. It now opens a visible, focused control in a fixed overlay and
  keeps the chat, the draft and the running stream.
- **Supplied thinking was folded away while the reply was still unfinished**, so a live turn looked
  idle until a whole sentence arrived. Thinking is now visible and open while speech is still
  forming, and Mini stays selectable from the card-size control.
- **Taking back a queued message no longer throws your words away**. While an agent is busy, a
  message you type waits in a strip above the box. Pressing Unqueue used to remove it and leave
  you with nothing. Unqueue now puts the waiting message back in the box when the box is empty.
  When the box already holds a draft, it keeps that draft exactly as you left it. It says the
  unqueued words in the conversation instead, so neither text is lost.
- A send that was actually delivered kept reporting an uncertain status. A confirmed native delivery
  now replaces it, and delayed desktop sends are reconciled after a native response failure.
- **An account limit stopped the retry that exists to handle it**. When a provider refused a turn
  because the account had hit a limit, the shell lost the machine meaning of that refusal. So the
  retry offered from the Accounts menu could not continue. The limit verdict is now carried on the
  failed turn. What you see explained about the limit is still incomplete — see Known issues.
- **A summary line no longer stops mid-sentence**. A tree card and the thinking slot each stand in
  for a whole run in a single line. A change in this release had them show whatever fragment had
  just arrived, so a card could read "A complete sentence. Pending". They now hold the unfinished
  tail until it forms a readable unit. A live reply in the conversation keeps showing its words as
  they arrive.

## Known issues

Nothing here is deferred. Every item below is **open**, with the person who owns it and when it is
expected. An item leaves this list only when it is fixed or when the owner accepts it by name.

- **OPEN — the installed Windows lifecycle rows are unexecuted rather than passed** *(Builder 7)*.
  The readiness adapters are available for all ten Windows rows. No row is unadapted. Eight rows
  have drivers. Two are deliberately left undriven, `advertised-integrations` and `update-delivery`.
  Qualifying those two needs three things that do not yet exist. A reviewed egress policy for the
  guest, which the current offline policy is not. A second attested guest, for the multi-machine
  path. And a real observed delivery path. A driver written without them would report a pass where
  nothing was exercised, so those rows stay refusals rather than assumptions. A lifecycle inventory
  was delivered. It was built from the measured bytes of the only installer on this machine,
  version 1.0.41. The program and the application archive were taken out of it and hashed. The
  validator accepts it, and it carries a single baseline. No qualification virtual machine with a
  guest credential exists on this machine. The host itself qualifies, but no machine present
  satisfies the configuration contract, and reaching an offline guest needs a credential that is not
  available here. So the installed-lifecycle rows remain unexecuted rather than passed. Nothing about
  the installed product's fresh-install, upgrade, uninstall or update-delivery behaviour is proven by
  this release.
- **INCLUDED IN THIS CANDIDATE — restored rows preserve an unknown result** *(Builder 8)*. When a
  conversation is reopened, an action row whose recorded state is absent or unrecognised is treated
  as unknown. It is shown as "no result came back". A known `done` state remains "finished". The fix
  and its tests are included in this combined candidate; verification on the merged tip and shared
  landing are still pending.
- **OPEN — a message between agents can be lost without anyone being told** *(Builder 10)*. A
  message accepted for delivery records a delivery receipt. If the receiving session is
  reassigned, resumed or closed before it reads the message, the message is dropped. Neither side
  is told — the sender's receipt says delivered. The paired engine now keeps a durable dead letter
  for a delivered message whose receiving queue was discarded. A sender that retries the same
  message is told it was dead-lettered. What has not been shown is that every reassign, resume and
  close path in this release files that dead letter. Until that is measured, treat a delivery
  receipt as "handed over", not "read".
- **OPEN — live thinking can open folded** *(Builder 6, 15:00Z)*. A saved transcript replayed when a
  conversation is opened folds a run that is still live and has produced no words yet. This happens
  in both the full conversation and the right-rail chat. The restore path settles the action runs
  unconditionally on replay.
- **OPEN — retrying after an account limit is only half-delivered** *(Builder 7, 14:30Z)*. The
  machine meaning of an account limit is restored in this release, so the retry offered from the
  Accounts menu can continue after a limit. Three things are still open. The person-facing filter
  that drops the provider's explanation is not yet narrowed. The program behind the window still
  drops that same sentence. The end-to-end retry from the Accounts menu has not been hand-tested.
- **OPEN — the queued-send surfaces are not fully walked** *(Builder 6)*. The happy path was
  hand-walked in the full conversation and the right-rail chat, and behaves as described. The
  cross-surface reply fault found earlier is fixed at this candidate. What remains open is the
  four-surface matrix walk.
- **OPEN — the display sharpness work rests on static evidence, not a before/after measurement**
  *(Builder 5, after the installer)*. The resting compositing hints were removed from the cards,
  chips and metrics rows. The top bar is now centred on whole pixels without a transform, checked
  by a gate. The visible before/after could not be measured on the build machine: every
  hidden-window configuration there reported software compositing. The change follows Chromium's
  documented rules; it is not a measured improvement.
- **OPEN — the Metrics page showed nothing for a day** *(Builder 2)*. The page scoped its 24-hour
  view to the signed-in account. But every session recorded since 2026-09-14T22:00Z carried the
  account identity `unauthenticated`. So the page showed nothing, while the home screen's unscoped
  tail still showed those runs. The page now states the period and account scope it is showing, and
  a local-computer scope is offered. On a fresh profile the page renders its counts and the record
  survives a restart. So the page and its persistence work. Why those sessions lost their account
  identity is still being traced.
- **OPEN — on Linux the vault page cannot list what your vault holds** *(T269)*. Measured against
  engine revision `bafd25a5b`. `createReader()` in `src/lib/vault-linux.js` returns exactly
  `presence` and `getMany`. Neither answers "what is in there". `getMany` needs the names, and the
  names are the question being asked. The module does export a top-level `list()`. It is deliberately
  not borrowed here. It is synchronous, and it resolves the vault from the surrounding environment —
  the very thing `createReader` exists to prevent. So the page says the limitation in words and names
  its own refusal code. It does not draw an empty list. An empty list would be a claim about your
  vault's contents that this seam has no grounds to make. Adding and removing a credential by name
  still work. The fix belongs in the engine. `createReader` needs a name verb that is asynchronous
  and bound to one state root.
- **OPEN — the regression driver for credential removal runs, but its checks are not yet reviewed**.
  Removing a credential works. It was run end to end in review, fully isolated. One approval
  carried through the tool's approval gate, the audit path and the vault lifecycle program, to a
  completed removal. A replay of the same approval was refused as already used. An approval
  presented for a different record was refused as a binding mismatch. The fenced driver that
  re-runs that walk is in this release's source tree. The packaged check suite that runs during a
  release cut discovers it and runs it on default settings. Run on its own without a packaged copy
  of the program, it stops and says so rather than guessing. What is still open is the review of
  its success checks and of the fence that keeps it inside a scratch vault. Until that review is
  done, read its result as "the walk ran", not as reviewed proof. A driver that can reach a real
  vault while asserting weakly is worse than none.
- **OPEN — nothing narrows the native-custody scratch directory on Windows** *(T270)*. The custody
  wrapper asks for mode `0700` when it makes its scratch directory. On Windows that request does
  nothing beyond the read-only bit. The ownership and permission walk that would enforce it runs
  only on Linux. The directory inherits whatever permissions its parent had. Measured as `0666`
  through Node's own file stat. No access-control step runs there at all. The test now pins that
  inherited value, so real narrowing has to change the test rather than quietly satisfy it.
- **OPEN — two files under `private/` are tracked in the repository** *(T271)*.
  `private/fleet-profile.owner.json` and `private/research-queue.authored.json` are committed, even
  though `.gitignore` excludes that folder. They were added deliberately in de-identification work
  on 2026-08-09. Neither reaches the installer. The packaging file list is an allowlist and does not
  include them. The list of what may ship names both as excluded. A built installer was searched by path,
  by name, and inside its archive with a positive control; it carried neither. The owner-data scanner
  is clean on the fleet profile. It reports the owner's name twice in the research queue, inside an
  authored note about commit authorship. Untracking them would not remove those bytes from history.
  That is the owner's call and is not done here.
- **OPEN — `tree-standalone-agent` check 148 fails, and did before this release** *(No owner yet)*.
  Pre-existing rather than introduced here, and it has not been assigned.
- **OPEN — the physical-phone path is unproven** *(Builder 2)*. Nothing about running this against a
  real iPhone was verified before release: the qualification laptop has no iOS Safari control tooling
  and none was installed. This is an absence of evidence, not a known failure.
- **CORRECTED — the compact tool catalogue reaches every provider, not "local sessions only"**
  *(Worker 88, 2026-09-17)*. Each new assistant is offered a short guide to the tool families
  available at its permission level. It is also offered a few relevant tool suggestions when a
  message clearly matches one. This entry used to say sessions on hosted providers received none of
  that. This was measured against engine revision `bafd25a5b`, the revision being cut for this
  release. It was measured at the permission level recorded as Standard, in the default
  tool-access mode.
  **Codex, Claude, Gemini, Grok and local sessions all receive it**. What decides is whether a
  session's plan wired this product's own tool servers — not which provider it is on — so no
  provider is singled out. Turn either half off under Settings → Tool discovery ("Introduce
  available tools", "Suggest relevant tools").

  There are two bounds on that reading. Both cost a reader more if left unsaid:
  - This reading depends on which copy of the engine is installed where you re-run it. Read that
    copy's revision before quoting any per-provider result. The original measurement used a copy at
    source reference `39ac2385`, 1,337 commits behind the revision being cut. That copy carries no
    launcher for Gemini, Grok or local, so those three refuse to start against it. That is a fact
    about one installed copy, never about the release. The revision being cut does carry those
    launchers. The qualification machine no longer stages `39ac2385`. It has since been restaged,
    and is being advanced to the revision being cut.
  - Gemini and Grok are planned only in the default tool-access mode. Asked for the wider mode, they
    are refused rather than widened, deliberately. Those engines expose only this product's own
    scoped tool servers and must never inherit the provider's native ones.

  Withholding the guide from a session whose plan wired no tool servers is deliberate and stays.
  Describing a toolkit an assistant cannot call is the misdirection this feature exists to end.
- **OPEN — running the test suites needs Node 22.19 or newer** *(Builder 6, 15:45Z)*. On Node
  22.14.0 the suite runner cannot load the thinking-transcript pipeline suite — a loader false
  positive, `ERR_REQUIRE_CYCLE_MODULE`, on a graph with no cycle. The shipped app never performs that
  import order, and the suite runs green under the shipped Electron's Node 24.18.1.

### Supported scope

Linux and Windows each require their own installer qualification. Paired conversation operations are supported; requests
for paired workspace snapshots are explicitly rejected.

Research version-2 studies reject unsupported stopping, escalation-budget and
wall-clock declarations before freezing. Historical version-1 metadata does not
grant modern experimental admission. Session execution limits are separate
settings.

Provider sign-in and client eligibility are reported separately from a completed
authenticated tool turn. A successful login alone is not provider qualification.

**What is proven about accounts, and what is not**. Real hosted sign-in was verified: the public
sign-in returned HTTP 200, the Account API returned HTTP 200, and the browser reached the account
page. Allowance refresh and native Stop were not proven with a real provider account before launch.
The isolated runtime held saved trees but no usable real provider account. Scripted Stop and rendered
Accounts checks passed against synthetic account, provider and transport replies. One caveat is kept
rather than rounded away. The full observer still reported failure, because the expected historical
Windows device label was absent at its immediate check. No claim about native entry follows from
the website result.

**Computer control, and the one thing it will not do**. Computer control was verified on three agent
seats. The verified actions were status, screenshot, capture of a window that is covered by another,
reading text from a capture, and release. Two limits are deliberate and stay in this release. An
agent will not click while a different application is in front. Asking to raise a named window
cannot pull it above a full-screen app the person is using. The person's foreground is not something
an agent takes. A qualification walk therefore reads by capture and text recognition. It clicks only
when the installed candidate is genuinely the front window. If it is not, the walk asks the operator
to bring that window forward by hand once.

**Security**. Lane F read four shell files for image delivery. The independent ruling is recorded in
`SECURITY-IMAGE-DELIVERY-LANE-F-20260915.md`. The gates are byte-identical, and the new `statFile`
metadata read happens only on authorized images. The refusal row also records the provider and
the generated explanation. Independent security tests are final at 18/18 pass.

## Install

The cutter fills this packet's install record from the exact staged package and
checks its digest again before recording these values. Compare the SHA-256 with
the package being installed.

### Linux package

| Item | Value |
| --- | --- |
| Package | pending |
| Platform | Linux |
| Bytes | pending |
| SHA-256 | pending |
| Signed | pending |

### Windows installer

| Item | Value |
| --- | --- |
| Package | pending |
| Platform | Windows |
| Bytes | pending |
| SHA-256 | pending |
| Signed | pending |

## Publisher and copyright

Published by ToolsEnabled, Inc. (in formation)

Copyright © 2026 Joshua Pinckard

ToolsEnabled was founded and created by Joshua Pinckard. The original platform was developed by directing autonomous AI-agent fleets through the system's own evolving coordination architecture.

Contributors and maintainers are never founders.

## FRA testing status

FRA is only for testing purposes. It has not been independently tested yet.
