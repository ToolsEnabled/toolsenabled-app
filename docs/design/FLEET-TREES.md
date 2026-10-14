# More than one tree per computer

**Owner's words:** "they should also be able to have more than 1 tree per computer",
alongside: the tree is empty until a session is started, empty nodes are drawn and
pressed to extend the structure, and pressing one opens a right-side panel for role
and message.

This is a specification, not an implementation. Every decision below is a decision,
not an option. Where a choice is genuinely the owner's it is marked in section 6.

---

## 1. What already exists (measured, not assumed)

Five facts the implementation has to build on. Nothing below invents a new engine
concept, and nothing below needs one.

1. **One computer, on a real install.** `src/declared-fleet.js` builds exactly one
   computer (`THIS_COMPUTER_ID`) from the declared organisation. The two-computer
   roster in `src/fleet-profile.js` is sample data. So "per computer" today means
   "on this computer", and the storage must still be keyed by computer so a second
   one never inherits the first one's trees.

2. **The engine already has trees.** `capability/src/lib/controller-launch-record.js`
   gives every launch a `parentLaunchId` and a `depth`, and enforces
   `MAX_FAN_OUT = 8` children per parent and `MAX_DEPTH = 3` (root is depth 0, so
   four levels). `src/agent-teams.js` already nests members under a lead to make
   that cap engage. The engine's eight is the BACKSTOP for every nested launch —
   teams, loops and grids — and is unchanged.
   **The tree's own width is four** (`TREE_BOUNDS.maxChildren` in `src/fleet-trees.js`),
   below that backstop, by the owner's decision of 2026-09-11: "ok it sounds like
   shipping with 4 width is best. we will defer the 8:1 implementation and research
   for now". Depth stays the engine's. A tree saved while the tree's width was eight
   can hold more than four live children under one parent; it loads, draws, moves
   and resumes as saved, and only a new seat under that parent is refused until it
   drops below four. One kind of tree is exempt: the tree a local research grid
   builds for itself is created `kind: 'experiment'` and seats the engine's eight
   (`EXPERIMENT_TREE_MAX_CHILDREN`), because "loops and grids dont even need to be
   tied together or to any of this" (the owner, 2026-09-11). Loops never take a
   tree seat at all: their runs are engine launches.

3. **Dispatch takes a fixed set of fields.** `actions.js` `dispatch` calls
   `exact(input, ['rootId','tier','objectiveRef','brief','cap','parentLaunchId'], …)`
   and refuses anything else. **A tree id cannot be sent to the engine.** Tree
   membership therefore lives in the app, and its durable spine in the engine is
   `parentLaunchId` and nothing else.

4. **Seats are a pool per kind, and the pool is small.** `actions.js` `TIERS`:
   the four Codex tiers hold one seat each (`astra`, `luna`, `terra`, `sol`); all three
   Claude tiers share `claude-1`, `claude-2`, `claude-3`, `claude-4`; the local tier
   holds `local-node-1` through `local-node-4`.
   `capability-defaults/config/agent-org.json` declares those twelve seats plus the
   controller. Astra is the default model for new circles and requires its own
   declared seat and management edge. **The shipped pool contains twelve seats.**
   Installed providers, credentials and resource admission still govern which can run.
   This dispatch roster does not guarantee that local resources can run every
   seat at once or set a ceiling on manually started app sessions.
   `declaredLane()` allocates a free seat and refuses with `BRIDGE_ALL_SEATS_BUSY`
   (HTTP 409) when there is none.

5. **A live session does not survive the window.** `src/agent-session-registry.js`
   holds one app-owned session and deliberately persists nothing, because "a live
   session cannot outlive the window that owns it".

---

## 2. What a tree is, and what makes two of them different

**A tree is one piece of work.** One tree, one job: the thing a person would name
in a sentence if you asked what they are doing.

Two trees on one computer are told apart by **the name a person gives them**, and by
nothing else. Not by structure — two trees can be the same shape — and never by an id.

**Trees can separate files too, per profile.** See section 8: a tree assigned a
session profile runs its agents in that profile's folder; a tree without one runs
in the product's shared workspace, exactly as every tree did before profiles.

- **Name.** Editable at any time. Until it is edited, the name is the first line of
  the first message sent in that tree, trimmed to one short line. Before any message
  exists, the name is **New tree**. Two trees are allowed to end up with the same
  name; the tab also shows how many agents are running, which separates them. Never
  disambiguate by numbering an id.

  **Settled.** Three naming schemes turned up at once — `treeName(position)` in
  `src/fleet-tree-copy.js` answering *Tree 1*, `addNode()` naming a tree after its
  first role, and this doc naming it after the first message. The coordinator decided
  the order: the name the person typed, then the first message they sent, then a
  count. `store.treeLabel(treeId)` is the single source and `tree.name` stays null
  until somebody renames it. A count is not an internal id and no gate would ever have
  caught it — but *Tree 1* beside *Tree 2* tells a person nothing about which job is
  which, and that is the only reason to have two.

---

## 3. Create, switch, remove

**Create.** A strip of tree tabs sits under the computer tabs, ending in **New tree**.
Pressing it makes an empty tree and switches to it. An empty tree is exactly the
first-run screen: one empty node and one line of explanation. No dialog, no name
prompt, no step before anything happens.

**At most one empty tree exists at a time.** Asking for a second while an empty one is
open switches to the empty one instead and says why. An unbounded pile of empty trees
is the same noise as an unbounded pile of empty nodes.

**Switch.** Press the tab. The right-side panel closes on switch — a panel belongs to
one node in one tree. Which node was selected is remembered per tree while the app is
open.

**Remove.** "Remove this tree" lives in the tree's own tab menu.

- A tree with nothing running is removed at once.
- A tree with running agents is removed only after they are stopped, and the ask says
  how many: *"Three agents are still running in this tree. Removing it stops them."*
- **If a stop is not confirmed, the tree is not removed, and the screen says so.** A
  removed tree whose agents are still running would leave work going with nothing on
  screen naming it — the exact failure `src/agent-teams.js` already refuses to allow.

**The tab strip only appears when there are two or more trees.** A tab strip with one
unnamed tab is furniture.

---

## 4. A tree whose agents have all finished

**It stays, in place, unchanged, until the person removes it.** It does not vanish and
there is no archive.

Three reasons:

1. The agents' work is why the person started it. Vanishing deletes their result.
2. History cannot be re-derived reliably. `defaultCountChildren` scans the audit tail
   with a limit of 200 events, so a tree the app throws away is not always
   reconstructable.
3. "Empty until a session is started" is about the first tree appearing when work
   starts. It says nothing about trees disappearing when work ends.

A finished tree reads **Finished** on its tab. Its nodes keep their names, roles and
last messages, and it still has empty nodes — so pressing one starts a new agent in
the same tree. That is what makes archiving unnecessary: a finished tree is a tree you
can pick back up.

**Across a restart, shape is saved and running is not.** The tree's nodes, names,
roles and messages are saved on this computer. No node is ever drawn as
running on the strength of a saved file. On start-up every saved node's state is
unknown until the engine answers, and a node the engine does not report as running
reads **not running now**. This follows `src/agent-session-registry.js`'s own rule:
persisting a claim that is false on the next launch is absence read as consent.

---

## 5. Trees share the seat pool, and what a person sees when it runs out

**Trees share one pool per computer. Nothing is reserved per tree.** Reserving would
idle a seat somebody could be using, and a person cannot see a reservation — so a
reserved-but-idle machine just looks broken.

So yes: **tree A can hold every seat and tree B cannot start.** That is the honest
consequence and the screen has to carry it.

**Before pressing.** The panel's kind chooser shows how many of that kind are free —
*"2 of 4 free"* — derived from what the engine reports. If the engine has not answered,
it shows nothing rather than a guess.

**The start button is never disabled on that count.** The count can be stale, and a
disabled button that was never pressed produces no truth at all. The person presses,
the engine answers, and the answer is what is shown.

**When the answer is the seat refusal**, the panel prints two lines.

*Line one is the shipped sentence, unchanged*, from `REFUSAL_REMEDY` in
`src/refusal-copy.js`:

> Nothing new was started, and nothing is wrong: every agent this copy can run at
> this level is already working. Wait for one of them to finish, or stop one from the
> fleet page, and then start this again.

Do not fork this wording. Four screens describing one condition four ways is a defect
this codebase has already paid for.

*Line two names who is holding them*, and it is the whole point of the change:

| Situation | Line two |
| --- | --- |
| Other trees hold them | Two other trees are holding them: "Ship the installer" has three, "Fix the login bug" has one. |
| This tree holds them all | This tree is already holding every agent this computer can run. |
| The app did not start them | This app did not start them, so it cannot say what has them. Wait, or stop one from the list below. |

Trees are named in that sentence, never identified. A tree's id must not appear in any
string a person reads.

**Drawing is not running.** A tree can be drawn wider than seven nodes. Empty nodes are
still offered, because planning past current capacity is legitimate; what is refused is
starting an eighth agent, and it is refused by the engine with the sentence above.

**Positions the engine would refuse are not drawn.** No empty node is offered as the
fifth child of a node, and none is offered below the fourth level. A node that can only
refuse is worse than no node.

---

## 6. What the owner decides, and nothing else here does

One thing, and it is small:

- **Whether the number of trees is capped at all.** This spec caps only empty trees
  (one), not filled ones.

Everything else above is a build decision and was made here. Section 8 is the one
thing this design does not decide, because it is not a design question: it is a
limitation to be weighed, and weighing it costs money and time that are the owner's.

---

## 7. The contract the tests hold

`src/fleet-trees.js` shipped while this was being written, and it is the store this
section describes. It is pure — no DOM, no view, no engine imports — so `node --test`
can hold it. Its own shape stands: one store per computer, a flat node list, and a
`{ ok, problems }` result on every write.

What that store already gets right, and what this design relies on:

- a fresh computer holds no trees and no agents, and nothing is seeded;
- `addNode()` with nothing passed makes a new tree, so a second tree costs one press;
- `extensionPoints()` answers *where a placeholder may be pressed* in one place;
- `moveNode()` re-hangs a branch under any legal parent — since 2026-08-13 across
  trees too, as a deliberate adoption (the branch joins the parent's tree; an
  emptied tree is removed). The earlier refusal guarded against a drag silently
  re-treeing a branch; the measured first run made the case for the reversal:
  every agent begins as its own single-node tree, so connecting two agents IS a
  cross-tree move, and the owner asked for it in words;
- `removeTree()` takes its agents with it rather than orphaning them;
- every refusal is a sentence, not a code.

**Five mismatches were found and closed:** the engine's caps adopted as `TREE_BOUNDS`,
a saved `running` demoted on load, `removeTree()` returning the removed records so the
caller can still stop what it removed, `seatShortageSentence()` added, and the
one-empty-tree rule moved into `createTree()` — which now calls `planTreeAdd()` rather
than remembering the rule separately, so the planner and the store agree by
construction. The suite that found them still guards each one.

### The record: there is one, and it is the store's

**This doc originally specified a second record shape, and that was a mistake it is
retracting.** It described nodes nested inside the tree with `agent: null` for an empty
one. The store already had a flat node list with a `draft` state, and `draft` is not a
detail — the owner's flow is *press the placeholder, **then** fill in role and
message*, so an agent exists, holding the person's typing, before any session does. The
nested shape cannot say that. Bridging the two (`treeNodesOf()`) has to map
*draft-with-typing* onto `state: 'unknown'`, which loses the one fact that state exists
to carry.

So: **the store's record is the record**, and its five states — `draft`, `starting`,
`running`, `finished`, `failed` — are the vocabulary. The coordinator ruled the same
way, and kept the nested shape as a **view projection**: `treeNodesOf()` runs one
direction only, stored record to drawn shape, and nothing maps back.

That makes the *draft-with-typing* row **not lossy**, and it must not be "repaired" by
adding a fourth state to the drawn shape. `draft` lives in the stored record and
flattens on the way to the pixels, which is where flattening belongs. Test 16 holds
that seam from the test side and a comment in `src/fleet-trees.js` holds it from the
code side. When the graph reads the store's record directly, `treeRecord()` and
`treeNodesOf()` can go — and test 16 is the thing that should survive that.

### One rule no test here can hold

**A message a person typed is drawn as text, never as markup a browser parses.** This
binds every view that draws one — the graph, the panel, a tab, a tooltip.

It is a requirement rather than a preference because the store deliberately allows
angle brackets in a message: people write `->` and `<see the note>` without meaning
markup, and refusing their typing to protect a view is charging them for that view's
bug. Escaping at rest is not the alternative either — that hands somebody their own
words back with `&amp;` in them.

**No test in this suite holds it, and that is a decision.** Every assertion available
here would check a proxy — that some view calls some helper by some name — and a proxy
fails the day the helper is renamed, which red-lights this suite for an edit that
changed nothing. A gate that cries wolf gets deleted, and it takes the real gates
beside it. Contrast the two guards that *are* here: a quoted sentence drifting, and a
`cwd` in a start call, are each **the fact itself** rather than a stand-in for it.

So this one is prose, and the honest cost is stated: if a view stops escaping, nothing
in this lane catches it. The rule is written where the decision that depends on it is
made, and here, where the feature is specified.

---

## 8. Session profiles: a tree can own its folder (limitation retired 2026-08-14)

**This section recorded a limitation — every agent on this computer ran in one shared
folder — until the owner ordered the feature that retires it (iteration 5, W6:
"different onboardings cause me a lot of issues when doing non toolsenabled work").
The old text's own closing line said the owner decides; he did.**

### What is true today, measured

- A **session profile** is a name plus a folder the person picked through the OS
  folder dialog. Profiles live in the MAIN process's own store
  (`shell/session-profiles.cjs`, `<userData>/session-profiles.json`), carried across
  upgrades by the adoption list.
- A tree may be assigned a profile (`setTreeProfile` in `src/fleet-trees.js`; the
  record's `profileId` is a pointer, additive and back-compatible). Agents started in
  that tree start in the profile's folder — where Codex discovers its instructions —
  so per-tree onboarding is a folder choice.
- **The renderer cannot select a working folder by passing a path.**
  `parseAgentStart()` accepts a `profileId`; the main process resolves it against
  folders the person picked, refuses unknown or stale ids loudly, and only then sets
  the session's `cwd`. A start that carries a raw `cwd` — which no caller in `src/`
  ever sent — is refused by name (`MC_AGENT_CWD_NOT_YOURS`): a hand-built IPC payload
  can name a profile or be refused; it cannot smuggle a working directory.
- A tree with no profile behaves exactly as every tree did before: the product's own
  `WORKSPACE_ROOT`.

**Checked, not just written**, in `tools/test/fleet-trees-multi.test.mjs`: no start
call in `src/` passes a raw `cwd`; the computers view's start request carries
`profileId`; and the boundary refuses a raw `cwd` by name.

- (Re-measured 2026-08-19.) A start may also carry `requestKeys` — the standing-
  request scope keys for the session's boot brief: the tree node ids above the
  node (top-down, its own id last) and the id of its own conversation. These are
  IDS the view already holds, bounded at the boundary like every other
  identifier; they key ledger FILENAMES through the engine's own key rule and
  can never name a path. They ride the START rather than the brief text because
  a resume sends no brief, and a restarted conversation is exactly when a
  thread-scoped rule must ride again.
- (Re-measured 2026-09-04.) A start may also carry `resumeManagerName` — the
  name the SAVED TREE gives this circle's manager at the moment of the resume,
  or `null` for a circle the saved tree now puts at the top of its tree. It
  rides the START for the same reason `requestKeys` does: a native resume sends
  no brief text, so `registerTreeSession()` never runs, and without this the
  host's only source for a resumed circle's manager is the tree-node-directory
  row from whenever that SESSION last registered — which a reparent performed
  while the circle was stopped never touches, because `treeStore.moveNode()`
  writes only the saved tree. It is a display NAME the view already holds,
  bounded at 120 characters at the same boundary, and like every other field
  here it can never name a path. Its neighbour `resumeAccount` is a selector
  into the main process's own account registry and may ride only beside the
  `resumeThreadId` it belongs to; the boundary refuses it by name
  (`MC_AGENT_INVALID_PAYLOAD`) if it arrives alone.
- (Re-measured 2026-09-03.) A Page 2 start may carry `treeIdentity`: the bounded
  display name on its circle and the bounded display name on its current manager
  circle, or `null` at the top. A resume sends no opening brief, so these names
  keep its local routing address aligned with the saved tree. They cannot name a
  folder or alter the profile resolution above.

- (Re-measured 2026-09-06.) A recovery start may carry `accountRecovery`, an
  object containing only a `recoveryId` bounded to 120 characters. The main
  process requires the prior session's saved start to belong to the same
  caller and re-resolves its profile and role through the ordinary start
  gates. This identifier adds no renderer-selected working folder.
  An explicit manual continuation may carry `continueFromAccount`, a bounded
  selector naming the saved account to exclude. Only the installed window may
  send it; the main process still resolves the profile and account itself.

The current start contract also accepts `resumeThreadProvider`, a bounded claim
about which provider owns the saved thread. It is limited to 64 characters,
requires `resumeThreadId`, and the host refuses a mismatched provider.
`delegationToken` is an opaque selector into host authorization, bounded to 128
characters. `boundedWork` carries the saved computer, tree and parent identifiers
plus a time cap from one second to 24 hours. The host verifies those identifiers
against its authenticated parent and saved tree. These fields supply no folder path.

(Re-measured 2026-09-21.) A replacement may also carry `historyHandoff`: nonempty
conversation text, limited to 160000 characters and excluding NUL. The host saves
it for the first turn and restores it when that turn is refused before acceptance.
This text is context for the conversation, not a working-folder selector;
`profileId` resolution and the raw `cwd` refusal still apply.

### What the product still does not claim

A profile keeps trees' folders apart only when the person assigns different folders.
Two trees pointed at one folder still share it, and nothing warns — a warning that
fires on a state the person deliberately chose is noise. The eight recorded incidents
of concurrent lanes clobbering uncommitted work remain the reason to assign folders;
the product now offers the boundary and leaves the choice where it was.

Bounds, restated here so a test can compare them against the engine's own source
rather than against this prose. `children-per-node` is the TREE's own width: it must
equal `TREE_BOUNDS.maxChildren` and stay at or below the engine's `MAX_FAN_OUT`. The
depth numbers are the engine's own:

```bounds
children-per-node: 4
max-depth-value: 3
levels: 4
agents-at-once: 12
codex-seats: 4
claude-seats: 4
local-seats: 4
```

`tools/test/fleet-trees-multi.test.mjs` holds this contract. It parses the engine for
every number above, so the doc cannot drift from the product quietly. Until
`src/fleet-trees.js` lands, the contract tests skip **loudly** and name the missing
file; the engine and copy tests run regardless, so the suite is never worth nothing.
Once the module exists, a missing export is a failure, not a skip — at that point the
contract is being broken rather than awaited.
