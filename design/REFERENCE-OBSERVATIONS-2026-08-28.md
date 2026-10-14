# The owner's reference screenshots — structured observations

**Provenance.** On 2026‑08‑28 the owner supplied seven reference screenshots —
three of a desktop chat/workspace panel and four of a mobile app — with these
words: for the chat surface, "here is how I had wanted the chat surface to
look more like"; for mobile, "I wanted it to end up somewhere like this —
although these panels really don't have much to do with connecting to how our
software actually functions so you will have to modify. and do it in our 3
colors." **The original PNGs are committed beside this document**:
`design/chat/reference-d1-panel.png`, `reference-d2-composer.png`,
`reference-d3-scrolled.png` and `design/mobile/reference-m1-door-ledger.png`,
`reference-m2-sheet-detail.png`, `reference-m3-ledger-dense.png`,
`reference-m4-chat-narrow.png` — the images are the authority; this document
is the coordinator's same‑day structured observation of them, and the text
cloud agents (who cannot see images) build from. **The mocks are fictional
products** (a Codex‑style workspace; invented agents); only the design
language transfers. **Our surfaces render in the light white/tan/gray palette
with role/status accents from the existing token system** — the mocks are
dark; the owner's standing ruling keeps ours light.

**THE GOVERNING RULING, 2026‑08‑28 (supersedes any restyle reading of this
document):** the owner reviewed the shipped chat against these mocks and
ruled — in his words — "I like our version of chat so far better actually.
Let's just add in the functionality you see." So for every CHAT surface:
**the shipped Dense panel's design IS the visual authority; the mocks are a
FUNCTIONALITY reference only.** No brief may restyle the chat toward the
mocks — a brief adds a missing capability and renders it in the EXISTING
design language (current tokens, current class idioms, current density).
The chat functionality gaps to add, from D1–D3: real‑data panel header
(title/path/status; branch and context counter only when real data exists) ·
per‑message timestamps · activity‑card per‑row and total durations + a
collapse control · the inline diff card capability (file header, N‑of‑M
files, open‑diff door — reusing the existing diff editor) · working‑row live
counters (tools/files/±lines) where session data exists · attach chips
(name/size/remove). **THE MOBILE RULING, refined by the owner 2026‑08‑28:** "lean heavily on what
we've already built and designed rather than going in the new direction —
except the tree obviously. We like our software; the design is meant to help
you fill in the gap from the software to the mobile." So for M1–M4: wherever
the shipped software already has the thing — the chat panel, the phone sheet
(M2/M4‑proven), the agent page, sign‑in patterns, the token system — mobile
REUSES it at phone density; the mocks apply ONLY where the software has no
mobile‑sized answer yet. **The one sanctioned new direction is the TREE**: the
mock ledger's row grammar (role‑color bar · name · lineage/role line ·
elapsed/status · indentation with carets · ghosted dim rows) is wanted for the
mobile tree, rendered in our light palette. Everything else: ours first, mocks
fill gaps.

**Other binding rulings:** approval buttons keep the shipped vocabulary
("Refuse" / "Allow once" via `approvalDecisionWord`). Counters/chips with no
real data render NOTHING, never zeros or placeholders. The routing law:
canonical /app/ always shows the desktop graph (simulation when signed out);
the ledger lives only on the explicit mobile route, behind sign‑in.

---

## D1 — Desktop panel, full conversation view

- **Header bar**: small rounded‑square avatar with a single letter ("C") ·
  bold title "Engine workspace" · muted path "/workspace/engine" · a small
  bordered chip "main*" (branch, with dirty asterisk). Right side: "● LOCAL"
  status dot+word · "2.8k / 32k" context counter · "···" overflow button.
- **User message**: left‑gutter label "YOU" in small caps with "10:42"
  timestamp beneath it; the message body in a rounded bordered box (light
  border, no fill emphasis), plain sentences inside.
- **Agent reply**: gutter label "CODEX" + timestamp; body is PLAIN text —
  no box, no bubble.
- **Activity card** ("Gathered activity"): a bordered card. Header row:
  small green status dot · bold "Gathered activity" · muted "4 actions ·
  1.8s" · right‑aligned "Collapse ↑" text control. Rows: ✓ checkmark ·
  small‑caps action type (SEARCH / READ × 3 / TEST) · description text
  ("settings panel environment state"; "SettingsPanel.tsx ·
  environment-store.ts · SettingsPanel.test.tsx"; "pnpm vitest SettingsPanel
  --run") · right‑aligned per‑row duration (0.2s / 0.4s / 1.2s).
- **Diff card**: header row: "M" file‑status letter (orange) ·
  "src/components/SettingsPanel.tsx" · "+18" green "−4" red · right side
  "1 / 2 files" muted + "Open diff" bordered button. Body: unified diff with
  line numbers both sides; added lines green‑tinted with leading "+";
  context lines plain. Shown hunk: a `const environment = useEnvironment()`
  line, then added `const status = environment?.name ?? 'No environment';`
  and a loading‑derivation line, then a return with
  `<StatusRow loading={isLoading} value={status} />`.
- **Approval strip**: card with a LEFT ACCENT BAR (orange). Row 1: bold
  "Approval required" + two small bordered small‑caps chips "SHELL · WRITE".
  Row 2: the question in plain words: "Run pnpm test --update to refresh 2
  snapshots in this workspace?" Right‑aligned buttons: "Deny" (plain/outline)
  and "Approve once" (solid orange, white text).
- **Closing agent line**: plain text status sentence ("The implementation is
  ready. The focused suite passes; snapshot refresh is waiting for approval
  before I run the full check.").

## D2 — Composer close‑up

- **Working row** (above the composer): "● Working" green dot + bold word ·
  "Updating snapshot coverage" step description · "01:14" elapsed. Right
  side: "3 tools · 6 files · +64 −12" live counters.
- **Attach row**: "+ Attach" bordered button · an attached‑file chip
  "◇ settings-state.png 142 KB ×" (icon, name, size, remove ×) · hint text
  "Drop files or paste images".
- **Input**: large rounded box, placeholder "Ask a follow‑up or describe the
  next change…".
- **Chip row under the input** — left: "AGENT ▾" (dropdown pill),
  "EFFORT · HIGH" (static pill), "GPT‑5.6 SOL ▾" (model dropdown pill);
  right: a small square icon button · "■ HALT" (red‑outline pill) ·
  "+ QUEUE" pill · "SEND ⏎" solid dark‑teal button with return glyph.

## D3 — Same panel, scrolled

Confirms D1+D2 composition at page scale: transcript cards left‑aligned in
one column, working row pinned above the composer, composer pinned bottom.

## M1 — Mobile, signed‑out door + ledger (two phones side by side)

*(The left panel's simulation/rehearsal concept is CUT by the owner's routing
ruling — kept here only as visual language: type scale, chip treatment,
button pair.)*

- Left phone: small‑caps kicker "MACHINE CONTROL" + heading "Your agents." ·
  "···" overflow. A red‑outlined small‑caps chip "EXAMPLE, NOT YOUR DATA".
  Display‑size heading "See how a working tree feels." Muted paragraph. A
  bordered info card with bold mini‑title + two sentences. Button pair:
  solid‑light "Explore example" + dark "How it works". A roster list:
  avatar circle with time under it · name bold · small‑caps lineage line
  ("COORDINATOR · ROOT") · right status ("● running" red dot / "○ no
  signal" hollow).
- Right phone — **the ledger**: header "Computer 1" centered, ‹ › computer
  switcher arrows, gear, red small‑caps "0 SERVICES · EXAMPLE, NOT YOUR
  DATA" sub‑line. A rounded chat input ("can you open chrome") beside a
  light "Start tree" button. Then agent ROWS: each row = a colored
  left BAR (role color: teal/orange/blue/yellow/gray) · name bold ·
  small‑caps lineage/role line ("ROOT · COORDINATOR", "MARA / RESEARCH ·
  HELPER", "FINCH / SOURCES · SHADOW") · right column: elapsed big
  ("18:42" with tiny ELAPSED under) or "NO RUNTIME / NOT STARTED" · status
  chip ("● running", "● finished" green, "○ no signal", "1 failed" red).
  Tree structure via INDENTATION + collapse carets (▾/▸) on parents; a
  count badge ("2") on collapsed parents; GHOSTED (low‑opacity) rows for
  dim/spawned agents (Quill, Aster, Wren). Bottom bar: "Details" button ·
  zoom cluster "+ 1.00x −". Hint smallprint: "DRAG TO PAN · TAP A ROW FOR
  CHAT".

## M2 — Phone sheet chat + agent detail (two phones)

- Left — **the sheet** (over the dimmed ledger): grab handle · sheet header:
  agent color bar + "Finch" bold + small‑caps lineage "MARA / RESEARCH ·
  HELPER" + right "00:12:09 running" + close ×. A quick‑action row of three
  bordered buttons: "Reset positions" · "Edit" · "Open agent detail ↗".
  Chat: YOU messages right‑aligned in bordered boxes with tiny timestamps;
  agent replies left, boxed lighter ("All 3,439 passed. One had to be
  repointed — I put the reason in the record."). Composer: "Reply to
  Finch…" + light "Send" button.
- Right — **agent detail page**: back ‹ arrow · "● awake" tiny status ·
  avatar RING carrying elapsed ("18:42" inside the circle) · "Mara" big +
  small‑caps "COORDINATOR · ROOT" · right giant elapsed "00:18:42
  ELAPSED". Then small‑caps "RUNNING · STEP 3 OF 4" · step title bold
  "Prepare the release handoff" · one muted sentence ("Comparing the signed
  build notes with the verification record.") · a thin progress bar
  (accent‑filled portion). **Step list**: ✓ "Read the release brief"
  COMPLETE (muted small‑caps state under the name) with right time ·
  ✓ "Collect verification results" COMPLETE · ● (red/accent dot) "Reconcile
  material gaps" WORKING NOW · ○ "Write the handoff" WAITING. **Quiet log
  box**: a bordered box titled "QUIET LOG · <time> UTC" with 2–3 tiny
  monospace log lines ("read verification-summary.json" / "matched 14
  release checks" / "▸ checking 2 changed notes").

## M3 — Ledger, dense listing

Small‑caps kicker "EXAMPLE TREE" · heading "Release readiness" · red "Start
tree" button top‑right · muted "6 AGENTS · DRAG ANYWHERE TO PAN". The same
row anatomy as M1‑right at tighter density.

## M4 — Mobile chat panel (narrow)

- Header: back ‹ · "Polish account settings" bold + green "LIVE" chip ·
  muted "acme/web · feature/profile-density" context line · "···".
- Date divider centered small‑caps: "TODAY · 10:42".
- YOU message: bordered box, right‑edge "YO" avatar square.
- Agent turn: "▸ Codex 10:43" header then plain text.
- Activity card: "● Gathered activity" + right "3 STEPS · 4.2s"; ✓ rows
  ("Inspected profile route" 1.1s · "Read component tests" 0.8s ·
  "Searched avatar states" 2.3s).
- Diff card: monospace header "src/settings/ProfileCard.tsx" + "+18 −6";
  an `@@ −42,7 +42,12 @@` hunk line; red‑tinted removed line
  (`<div sc-camel-class-name="profile">`), green‑tinted added lines
  (`<section sc-camel-class-name="profile compact">` /
  `<Avatar status={status} />` / `<ProfileFields />` / `</section>`);
  footer "1 OF 3 FILES" left, "View full diff →" right.
- Approval card: "!" icon in an orange square · bold "Approval required" ·
  sentence "Run the focused test suite? This command only reads project
  files."
- Working row: "● Working — waiting for test approval" + right "00:18".
- Attach chip row: "▦ compact-spec.png ×" + "+ Attach".
- Input with typed text ("Also keep the mobile breakpoint below 480px.").
- Chip row: "Agent ▾" dark pill · a signal‑bars icon · "GPT‑5.6 SOL ▾" ·
  right: three small square icon buttons (one highlighted orange) · a
  solid teal circular/square send button with ↑ arrow.

---

## Translation table — mock concept → our product

| Mock | Ours |
|---|---|
| Codex / GPT‑5.6 SOL model chip | the session's real provider/model via the chips contract (`data-chat-chip="model"`), hidden when no data |
| workspace path + branch chip | real workspace path; branch chip only when real git state is wired (render nothing until then) |
| 2.8k / 32k context counter | absent until real token accounting exists (L2‑4 Tier 2 territory) |
| Deny / Approve once | **Refuse / Allow once** (`approvalDecisionWord`) |
| SHELL · WRITE badges | our real approval badges (already shipped) |
| Mara/Finch/... roster | the real tree: name · lineage · role from fleet data |
| SEARCH/READ/TEST rows | our real action rows via `actionRowWords` / `ACTION_TOOL_WORDS` |
| STEP 3 OF 4 + step list | our real session step data (the working row's source); no fake steps |
| QUIET LOG | the real transcript/log tail |
| EXAMPLE, NOT YOUR DATA | only where the simulation truly renders (signed‑out desktop graph), in our honest copy |
| dark surfaces | light white/tan/gray; role bars + status colors from existing tokens |
