# Editing roles

Open **Computers → Roles** in the tree toolbar. The same workspace is available
under **Fleet overview → Organisation & roles → Open role workspace**.

The canvas includes every assignable role. Lines come from saved `manages`
relationships, grouped by role; card positions do not change the organisation.
Drag a card's handle, use its arrow keys, zoom, fit, or arrange the cards.
Choose a card or search the library to edit it.

Each role has its own draft. Switching roles, saving a different role, and
remounting the page preserve drafts for that computer during the page visit.
Save explicitly, or use Ctrl/Cmd+S. Drafts are not durable across an app restart;
export a role file to keep an unfinished draft outside the app.

- **Directions:** responsibilities, boundaries, and context/handoff, each with
  up to 6,000 characters on an updated engine. Line breaks reach the agent.
- **Functions:** choose installed defaults or an exact selection; search by ID
  or description, filter reads/actions/selected functions, and select or clear
  the visible results. Expand a function to see its actual input schema and a
  copyable call template. An empty selection means no ToolsEnabled functions.
- **Preview & file:** inspect the draft plus inherited operating guidance,
  copy directions, or export an editable `.role.json` file. Import opens a
  draft for review and never saves automatically.
- **New role / Duplicate:** start from a default role or reuse an existing
  sheet. A base supplies initial abilities, operating guidance, and function
  policy. Custom wording remains editable independently.
- **Researcher role:** opens the optional Lean Bench research draft with concise
  guidance on provenance, reusable compositions, experimental controls and
  reproducible evidence. Save it to add it to the library, then choose it for
  an agent if wanted. It inherits no base role, selects no fixed functions and
  changes no agent assignment. Existing Researcher roles and unsaved drafts are
  preserved. The portable source is `src/data/researcher.role.json`.

Saving uses the role revision that was read when editing began. If another
window saved first, both versions remain available for review. Choose the
saved version or keep the draft against the new revision, then save.
Restore defaults explicitly restores directions, functions, and action policy;
the confirmation names all three. Existing sessions need a restart to use the
new role binding.

Function selection narrows the shared ToolsEnabled registry. It does not
replace native provider permissions or change the role's enforced abilities.
Unknown saved function IDs remain visible as unavailable and inert. Older
engines without a catalog retain their saved function policy on direction edits.

## Default guidance and evidence

Default definitions live in the engine's `src/lib/roles/*.json`, loaded through
`agent-roles.js`. Installed overrides remain separate. Static imports include
all nine files in the packaged dependency closure.

The controller and manager defaults already delegated substantial work. This
revision strengthens their turn-level coordination duty and specifies an
assignment packet: current objective and user corrections, working folder,
entry files and findings, ownership/dependencies, artifact versions, available
functions, next action, and acceptance evidence. Execution/review roles consume
that packet first and request only missing or stale details.

The recent controller activity diagnosis identified a display defect while the
controller was working. It does not prove a fresh coordination failure. The
guidance changes address the user's stated history of busy dispatchers and the
existing requirement to process substantive reports; they are not evidence of
improved live-model performance. No new authority, reporting chain, or mandatory
review gate is introduced.

Verification covers the native editor with the real role store and dispatcher,
cross-role and remount draft preservation, stale-save refusal and explicit
resolution, role-file round trips, actual reporting connections, function schema
projection, and multiline Unicode context reaching the first adapter turn.
