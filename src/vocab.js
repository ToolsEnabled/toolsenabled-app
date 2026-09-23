// Vocabulary for the simulated fleet. The operational language is SITE data,
// not product data — the set that used to sit here was lifted from the working
// system this product was built on and named that system's own internals, so
// it now comes from the fleet profile (src/fleet-profile.js) and is replaced
// wholesale when a different profile is loaded.
//
// The SUBSYSTEMS list that used to live here was deleted rather than
// rewritten: nothing imported it, and its only content was the component
// inventory of that one fleet.

import { FLEET } from './fleet-profile.js'
import { ROLE_COLOR_NAMES, roleColorCss, roleColorHex, validRoleColorId } from './role-colors.js'

export const CHAT = FLEET.chat
export const CHAT_REPLIES = FLEET.chatReplies
export const CHAT_CONTEXT_REPLIES = FLEET.chatContextReplies

/* Role labels remain the vocabulary's job. role-colors.js owns cosmetic
   defaults and preferences; CSS variables keep mounted surfaces in sync without
   rebuilding a conversation. Literal hex getters are retained for data callers. */
const roleAppearanceFor = (label, id) => ({
  label, color: roleColorCss(id), glowColor: roleColorCss(id),
  get hex() { return roleColorHex(id) },
  get glow() { return roleColorHex(id) },
})
/* ROLES USED TO COVER ONLY SIX KEYS -- the fleet page's own legacy vocabulary
 * (coordinator/helper/shadow/manager/default/spawned) -- while the
 * organisation's declared Role library (ENGINE_ROLES in
 * src/orchestration-controls.js: controller, shadow-manager, planner,
 * manager, coordinator-assistant, builder, reviewer, worker, observer) has
 * had its own colours and names in ROLE_COLOR_NAMES/ROLE_COLOR_DEFAULTS
 * (src/role-colors.js) all along. Every consumer that indexes ROLES directly
 * -- rimRole() below, two sites in src/views/computers.js, three in
 * src/phone-ledger.js, the subtitle in src/tree-graph.js, and roleLabel() in
 * src/fleet-tree-copy.js -- degraded any of those nine declared roles to a
 * generic "Default"/"Agent" caption and a ring with no colour of its own,
 * because ROLES had no entry for them (measured by Builder 4, re-measured
 * against this commit by Controller 3). roleAppearance() below already fell
 * through to ROLE_COLOR_NAMES for an unlisted key, so it was never affected;
 * this is the same fallback applied structurally, so nothing has to fall
 * through anymore. ROLES now covers every key ROLE_COLOR_NAMES declares,
 * built the same way roleAppearance() already built an unlisted one, with
 * the six legacy entries and their exact historical labels kept verbatim by
 * applying them last -- 'coordinator'/'manager' keep the same label
 * ROLE_COLOR_NAMES already uses for them, but 'helper' and 'shadow' do not
 * (ROLE_COLOR_NAMES spells them "Coordinator's helper"/"Shadow manager
 * (legacy)"), and this file's own long-standing captions win for those two. */
export const ROLES = {
  ...Object.fromEntries(Object.keys(ROLE_COLOR_NAMES).map(id => [id, roleAppearanceFor(ROLE_COLOR_NAMES[id], id)])),
  coordinator: roleAppearanceFor('Coordinator', 'coordinator'),
  helper: roleAppearanceFor("Coordinator's Helper", 'helper'),
  shadow: roleAppearanceFor('Shadow Manager', 'shadow'),
  manager: roleAppearanceFor('Manager', 'manager'),
  default: roleAppearanceFor('Default', 'default'),
  spawned: roleAppearanceFor('Agent spawned', 'spawned'),
}

/** Paint the declared stable role ID, including roles from the Role library.
 * A cosmetic choice never changes the role's permissions or graph position. */
export function roleAppearance(id) {
  const key = validRoleColorId(id) ? id : 'default'
  return Object.hasOwn(ROLES, key) ? ROLES[key] : roleAppearanceFor(Object.hasOwn(ROLE_COLOR_NAMES, key) ? ROLE_COLOR_NAMES[key] : 'Agent', key)
}

/**
 * THE ROLE KEY A STYLESHEET IS ALLOWED TO BE HANDED, and the reason the rings
 * kept vanishing from page 2.
 *
 * A `role-<key>` class is the only channel by which `--rc` reaches an element,
 * and `--rc` is what draws the circle: `.computers .static-tree-graph
 * .node-glass` in src/tree-graph.css is `border: 1.5px solid var(--rc)`. When
 * this function returned only a six-key set, that set and ROLES' own keys
 * were the same six; ROLES has since grown to cover every declared org role
 * (see the comment above ROLES), but src/tree-graph.css still only spells out
 * a `.role-<key> { --rc: ... }` rule for those original six. This is not the
 * vanishing-ring defect below returning: `.static-tree-graph .node,
 * .static-tree-chip { --rc: var(--c-spawned); }` is a RESTING declaration that
 * matches every node regardless of which `role-<key>` class it also carries,
 * so `--rc` is never left undeclared. A role this stylesheet has no specific
 * rule for still gets a real ring, just the spawned grey rather than a colour
 * of its own — a known, reported limitation of the CSS side of this fix, not
 * a silent regression of the bug this function exists to prevent.
 *
 * A TREE NODE'S ROLE IS NOT FROM THAT SET. It is a one-line string the record
 * accepts verbatim (`optionalOneLine(entry.role, ...)` in src/fleet-trees.js),
 * and the ids that reach it come from the organisation's own Role library —
 * `roleRecordFor` in src/views/computers.js accepts any role the org declares,
 * which is how an agent spawning a tree circle names a `worker`. That produced
 * `class="node ... role-worker"`, for which no `--rc` is declared anywhere in
 * the shipped CSS.
 *
 * AND AN UNDECLARED CUSTOM PROPERTY DOES NOT FALL BACK TO THE OLD VALUE — it
 * takes the property out. `var(--rc)` with no declaration makes the whole
 * `border` shorthand invalid at computed-value time, so every longhand takes
 * its INITIAL value, and the initial value of `border-style` is `none`. Not a
 * grey ring, not a thin ring: no ring. That is the owner's "sometimes the
 * rings disappear on pg2 around the workers", and "sometimes" is exactly the
 * shape of it — the five roles the compose panel offers (ROLE_CHOICES in
 * src/fleet-tree-copy.js) are all declared, so a circle the person made by
 * hand keeps its ring and a circle an agent spawned loses it. This function
 * still refuses anything ROLES itself does not recognise (an unknown key
 * still falls to 'default'), which is the actual guarantee against a
 * completely undeclared `--rc`; it no longer confines the result to a
 * stylesheet-declared subset of ROLES, because ROLES now IS the declared
 * organisation's own set.
 *
 * The same rule is already written in src/components.js formatInlineText —
 * `Object.hasOwn(ROLES, resolved) ? resolved : 'default'` — for inline agent
 * names in chat. It was never applied to the canvas. This is that rule, given
 * a name, so the next surface that needs it imports it instead of re-deriving
 * it or forgetting to.
 *
 * 'default' rather than 'spawned' is deliberate: the label under the circle
 * already falls through `ROLES[role] || ROLES.default`, so an unknown role is
 * captioned "Default", and a circle captioned Default wearing the neutral grey
 * of "Agent spawned" would be two answers to one question.
 */
export function rimRole(role) {
  const key = typeof role === 'string' ? role : ''
  return Object.hasOwn(ROLES, key) ? key : 'default'
}

/* Account pools are the operator's own accounts, so the set comes from the
   profile too. POOLS.color / .glow are the ROLE hexes verbatim, and
   src/views/metrics.js deliberately reads NEITHER — pools take one neutral
   and providers take their own --prov-* categorical set, because a pool card
   and a role dot share a scroll and colour has to follow one entity. They are
   kept in step with ROLES above only so that stated invariant stays literally
   true for whoever checks it next.

   The pool IDS are join keys read as literal strings by src/views/metrics.js;
   see the comment on SAMPLE_POOLS in src/fleet-profile.js for why they cannot
   be renamed from the profile alone. */
export const POOLS = FLEET.pools

export const PROVIDERS = [
  { id: 'codex', label: 'Codex', color: '#008dab' },
  { id: 'claude', label: 'Claude', color: '#c85900' },
  { id: 'gemini', label: 'Gemini', color: '#3e63f0' },
  { id: 'local', label: 'Local', color: '#00956c' },
]

export function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)]
}
