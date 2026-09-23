# Tree start: pick the folder, layer the instructions — brief (2026-08-16)

**Owner, verbatim (2026-08-16):** "i think we should abandon the split view. But
when a user starts a tree they should select a folder, they can have a default
folder, where the agents spawn, but also a session file that replaces classic
md files essentially though we should keep standard md instructions and users
need to be able to edit them easily and then global also essentially gets
injected."

This is a design brief with the reading stated back for correction. Nothing
here is built yet. It belongs to the fleet/computers-page and engine-onboarding
lanes, and it is placed AFTER the research showing unless the owner says
otherwise.

## What exists today (measured, so the brief starts from truth)

- **Split** is the computers page's second graph pane
  (`src/views/computers.js` ~746 `graph-split-btn`, `enableSplit()` /
  `disableSplit()` ~1631/1687, a saved preference read at ~2154). It is a
  view-only affordance — no state lives in it.
- A tree already has a **profile**: a select whose options are the main
  process's list of folders the person picked in the OS dialog, with "the
  product workspace" as the stated default (`computers.js` ~3256-3268,
  `setTreeProfile`); a change applies to agents started after. So "folder the
  agents spawn in" exists as a concept, but it is set on an existing tree's
  rail, not chosen at tree START, and there is no configurable *default folder*
  setting a person can change in-app.
- **Global instructions are already injected**: the engine's onboarding packet
  (`src/lib/agent-onboarding.js`) boots every agent with the owner's standing
  requests from the R ledgers — global, session, tree, thread scopes (owner's
  commits 62f0627 → 9b66540, 2026-08-15). This is the "global also gets
  injected" half, built.
- **Standard md instruction files** (CLAUDE.md / AGENTS.md in the working
  folder) are honoured by the CLIs the product spawns, but the product offers
  **no way to view or edit them in-app** today.
- There is **no per-session instruction file** the product writes for a tree.

## The reading, in five statements (correct any that are wrong)

1. **Remove the Split pane.** Owner-directed removal of a feature, so it is
   allowed; do it only once he confirms this is the "split view" he means, and
   remove the preference with it so nothing dangles.
2. **Starting a tree begins with choosing its folder.** The compose/door flow
   that starts the first agent of a tree asks for the folder first (OS dialog
   or a recent list), pre-filled with the **default folder**, which becomes a
   real setting: registry row + enforcement + an in-app control (the owner's
   standing rule for anything called a setting). The tree's profile becomes
   the folder chosen at start rather than a later rail edit; the rail keeps
   letting a person change it for agents started after.
3. **Keep and honour the standard md files, and make them editable in-app.**
   From the tree rail (and the agent page), open the folder's CLAUDE.md /
   AGENTS.md in a plain editor surface, create one if absent, save. No
   product-specific format; the CLIs keep reading them exactly as they do now.
4. **Add a per-session file** — the primary place for a tree's own working
   instructions instead of ad-hoc md files: written by the product when the
   tree starts (name and location to decide; likely inside the folder or the
   product's state root keyed by tree id), editable from the same surface as
   the md files, injected into every agent of that tree at boot alongside the
   global layer. Its relationship to the R ledger's SESSION/TREE scopes must be
   decided, not duplicated: either the session file IS the tree/session
   ledger's editable face, or it is a separate free-text file layered next to
   it. The owner's "replaces classic md files essentially" suggests free text a
   person writes, not a request register.
5. **Injection order and precedence, stated in the UI:** global (owner
   standing requests) → folder's standard md (honoured by the CLI as today) →
   this tree's session file. Which wins on conflict is a product decision the
   surface should state in one sentence rather than leave implicit.

## Open questions for the owner (answer in one line each; assumptions in brackets)

- Q1 Is "split view" the second graph pane on the computers page? [assumed yes]
- Q2 Should the session file live in the chosen folder (visible to the CLI, so
  it works even outside the product) or in the product's state root (clean
  folders)? [assumed: in the folder, dotfile-style, so the CLI honours it too]
- Q3 Is the session file the editable face of the R ledger's tree/session
  scope, or a separate free-text file? [assumed: separate free text; the ledger
  stays the request register]
- Q4 Before or after the research showing? [assumed after]

## Where the work lands

- App: `src/views/computers.js` (door/compose flow, tree rail, Split removal),
  a settings row + control for the default folder, an md/session-file editor
  surface, tests in `tools/test/`.
- Engine: `src/lib/agent-onboarding.js` (inject the session file next to the
  global layer), the settings registry row (`config/settings-registry.json`)
  with real enforcement, tests.
- Payload boundary: any new engine module classified after reading.
