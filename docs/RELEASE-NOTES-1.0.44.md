# ToolsEnabled 1.0.44

*Released 2026-09-11*

Publication pending. This is the prepared release note; it is not a publication receipt.

1.0.44 is a Linux release. Its subject is the Research page. That is the one surface held to the
full public-release standard here. The rest of the product is carried forward unchanged from
1.0.43, except where this note says otherwise.

## Highlights

- A research report is now written to be read by a reviewer who was not in the room. Every
  table is introduced in a plain sentence that says what the table is for. The method and run
  sections are recorded as structured blocks. The qualification and native-verification
  receipts appear in the report instead of only in a log.
- A run now reports what actually happened rather than what was intended. It reports the request
  the runner really sent, and the tool policy each attempt really applied beside the one its
  condition declared. It also reports the model identity and usage the adapter itself returned.
- A project exported from the Research page is a standalone artifact. It can be opened, read
  back and reported on by a build that cannot rebuild it. The report says plainly that it
  could not be rebuilt, rather than quietly presenting a rebuild as the original.

## Added

- Qualification and native-verification receipts, carried through the exported command-line
  runner and `evidence.json` and rendered in the report's protocol and integrity sections.
- Read-back of the project archives the Research page writes, so an archive this product
  produced can be reopened by this product.
- A summary of the export manifest in the report's integrity section, and the recorded
  container arguments beside the qualification receipts.
- Refusals that stop a study from recording a result it cannot support. These are refused:
  - An attempt that used tools while its condition declared none.
  - A declared tool restriction the study has no way to observe.
  - A Python code block with prose wrapped around it, before it reaches the engine.

## Changed

- Archived evidence is verified against what ran at the time, not against today's extractor.
  An archive does not change verdict because the reader was upgraded.
- A reply that carried a program in the wrong shape is now reported as its own outcome. It is
  kept separate from a reply that carried no program at all.
- Opening an exported project no longer implies the project was verified; verification is
  reported as its own step with its own receipt.
- The install record below is the Linux package this release ships.

## Fixed

- A report could not be rendered at all for a project the current build cannot rebuild. It now
  renders, and states the limitation in the report.
- Sending to an ended agent no longer fails silently; the session is recovered first.
- The Roles modal is no longer hidden behind the wide-tree rail.
- Stop no longer strands the person with a disabled control and a permanent "stopping" state if
  closing a session throws.
- A phone-canvas test asserted a line the source no longer spells, so it no longer guarded what
  it claimed to guard.

## Known issues

- **A price page ships that cannot take payment.** We are not collecting payments at first
  public launch. The routes `#/subscribe` and `#/pricing` are still reachable by typing the URL.
  They render prices from a catalog generated on 2026-08-12, including a Team price and a
  three-seat minimum that are not authorised. Nothing can be charged: signup refuses unless the
  build is in test billing mode, and no checkout path exists. There is no link to these routes
  anywhere in the app. (R1214)
- Publication of the 1.0.43 Linux packet is still pending an unreachable jump host, so the
  download page may lag this note.
- Page 2 does not yet use the extra room at small text sizes: there is still noticeable empty
  space around the two boxes. We could not state a measure for how much space it ought to use.
  So that change is deliberately left out of this release rather than guessed at. (R1206)
- The tree context cards ship in four sizes where three were asked for. We kept `mini` rather
  than remove a size someone may already have chosen. (R1207)
- The ordinary half of the research G8 work is not in this release; it is deferred to 1.0.45.
  What did land is the G5/G6 editor closure, typed endpoints and the in-repo docs stage. (G8)
- Loading a project snapshot from a paired computer's workspace still is not supported, and the
  refusal is unchanged. Supporting it would need a separately reviewed change; nothing here
  widens that path. (remote workspace)

## Install

One platform is cut from this source tip, so this note carries one record. The digest cannot be
written now: the artifact it would describe does not exist yet, and an invented hash is worse
than a missing one. The Linux cutter fills this record in the packet copy of this note from its
own receipt. Then `npm run check:release-notes` must exit 0 against that packet copy before
anything is published.

### Linux package

| Item | Value |
| --- | --- |
| Package | pending |
| Platform | Linux |
| Bytes | pending |
| SHA-256 | pending |
| Signed | pending |

## Publisher and copyright

Published by ToolsEnabled, Inc. (in formation)

Copyright © 2026 Joshua Pinckard

ToolsEnabled was founded and created by Joshua Pinckard. The original platform was developed by directing autonomous AI-agent fleets through the system's own evolving coordination architecture.

Contributors and maintainers are never founders.
