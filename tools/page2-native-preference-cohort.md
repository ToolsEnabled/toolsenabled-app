# Held native preference cohort

This adds six callable cases to `page2-native-audit.cjs`. They are prepared
native checks, with no GUI execution or native coverage credited yet. They
require only the existing `setup` case; selection through the maintained
driver also selects its `startup` prerequisite. They use the current owning
account's isolated QA app and require its ToolsEnabled product account to be
signed out. They neither sign in nor start a provider session.

| Case | Proposed function ID | Actual action and applied readback |
| --- | --- | --- |
| `quick-preference-theme` | `appearance.quick.theme` | Click every other offered Theme button, then restore the original. Match `mc.theme`, `data-theme`, and the changed computed `--bg`. |
| `quick-preference-ui-font` | `appearance.quick.font` | Click every other offered Font button, then restore. Match `mc.font`, computed `--font-ui`, and the body's actual font stack. |
| `quick-preference-text-size` | `appearance.quick.text-size` | Click the other offered sizes, then restore. Match `mc.text`, body zoom and the layout's `--zoom`; Default must clear both inline overrides. |
| `quick-preference-glow` | `appearance.quick.glow` | Use native Home/End keys on the real slider, then an arrow beyond each visited endpoint. Match `mc.set.glow` and computed `--glow`; the endpoint must hold. Restore by native Home/End and at most 100 arrow presses. |
| `quick-preference-reduce-motion` | `appearance.quick.reduce-motion` | Click the visible checkbox label, then restore. Match `mc.set.reduce_motion` and the actual body class. |
| `home-preference-reading-width` | `home.reading.width` | Open Home's Full view and click its width control. Match `mc.home.chat-width`, the mounted width attribute, pressed state, label and computed `--reading-max`; preserve the selected subject. Restore through that same control. |

The five appearance cases also compare the corresponding full Settings row
after every action. Save and Discard remain disabled: these immediate drawer
changes must not leave an unsaved Settings draft. Each case remounts the actual
route and checks the selected value again before restoring it. Home's width
case closes and remounts the actual Home view; it records whether that view
is labelled as example data and makes no conversation/provider claim from it.

Every read receipt binds the selected keys across the real renderer storage,
`window.mcPrefs.read`, and the exact `renderer-prefs.json` named by the preload
inside this run's user-data directory. Missing bridges, unsettled or unknown
account state, a signed-in product account, damaged/refused storage, wrong
file paths, symlinks/junctions and hard links earn no credit. Unrelated durable
values remain hashed and unchanged. The count and digest of actual
`agent_session_start` event identities must also remain unchanged; this is a
no-new-start observation, not a new signature-verification claim.

Restoration is a named, visible operation and runs once even when the tested
action fails. The original failure remains a failure. A failed restoration
retains both errors and prevents subsequent preference edits. Theme, Font,
Text size and Home width have no visible "unset" action: if their original key
was absent, selecting the original effective default writes its canonical
value. The restoration receipt reports `canonicalDefaultWritten: true` in
that precise situation. Glow and Reduce motion remove their key at default.
No script deletes or writes a preference behind the UI.

The exact retained/remount steps are `preference-<id>-retained-after-remount`
for the five appearance setting IDs (`theme`, `ui_font`, `text_size`, `glow`,
`reduce_motion`), and `preference-reading-width-retained-after-remount` for
Home. Their restoration steps are `preference-<id>-restore-owned-choice`,
with Home's ID spelled `reading_width`. Each selected appearance target has
its own `preference-<id>-choose-<value>` step. Home's input receipt is
`preference-reading-width-selected`. Receipt key/value/file/hash fields bind
each step to the exact preference and run.

Source authorities:

- `src/quick-settings.js`: `appRows`, `wire`, `renderQuickSettings` and the real
  `#theme-seg`, `#font-seg`, `#text-seg`, `#set-glow`, `#set-motion` controls.
- `src/main.js`: `openDrawer`, `closeDrawer` and the boot call to
  `applyStoredAppearance`; `index.html` supplies the actual shell controls.
- `src/views/settings.js`: `onQuickSetting`, `syncSetting`, the five actual
  settings definitions, and `applyStoredAppearance`'s durable event listener.
- `src/theme-choice.js`, `src/font-choice.js`, `src/text-size.js`,
  `src/appearance-persistence.js`: offered values and storage/application rules.
- `src/styles.css` and `src/theme-refinements.css`: actual theme and font CSS.
- `src/views/home.js`: `openTakeover`/`closeTakeover`;
  `src/home-chat-reading.js`: the width click and `mc.home.chat-width` writer;
  `src/home-chat.css`: the 900px/1400px reading width contract.
- `public/durable-storage.js`, `shell/fleet-profile-preload.cjs`,
  `shell/renderer-prefs.cjs`, and `shell/main.cjs`: durable cache, exact live
  read IPC, stored file and sender checks. `shell/spawn-record.cjs` supplies
  the event identity shape used for the no-new-start observation.

The proposed six IDs are absent from the reviewed 338-function catalog. Adding
them increases that denominator to 344 if no other inventory changes occur;
it does not close six of the existing 200 gaps. The frozen catalog and its
current 54 cases remain unchanged until an explicitly reviewed integration.

Saved conversation-source filters and transcript archive settings stay out of
this cohort because their full Settings Save uses a native confirmation for
which the current owned picker has no exact-message acceptance operation.
Account switching, account-scoped preferences, cold app restart durability,
provider behavior, malformed-storage recovery, and inaccessible controls stay
unproved. No dialog replacement or storage fixture is substituted for them.

Validation is the isolated `page2-native-preference-evidence.test.mjs` suite:
source-vocabulary checks, adversarial receipt/application checks, actual owned
file/link tests and restoration failure controls. It is source evidence only.
The adjacent source suites are listed in the durable handoff; an existing
`text-size-window-fit` sweep reports four unscaled `dvh` lengths in
`src/tree-graph.css`. That unrelated failure is preserved, with no product CSS
change or expectation weakening in this cohort.
