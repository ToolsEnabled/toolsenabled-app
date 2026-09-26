# ToolsEnabled `1.0.46`

*Planned `2026-09-23`*

This is a source release plan, not a published release or an installation
qualification record. Both platform artifacts and their measurements are pending.
The published 1.0.45 Beta preview remains available separately.

## Highlights

- Sending a pasted image after stopping a conversation now resumes that
  conversation. Once accepted, the image clears from the draft that was sent.

## Added

- No new product features are claimed in this maintenance release.

## Changed

- Closing or stopping during image preparation preserves the draft and holds
  delivery. A draft whose admission is uncertain cannot silently create a
  second delivery operation when its composer reopens.
- Release checks distinguish an unmeasured source plan from measured download
  records. Validation profiles can be retained for review.

## Fixed

- Accepted image messages retain their turn and preview when the conversation
  closes and reopens in the same app session.
- Edits made while an earlier image is being sent retain the newer draft.
- Windows cut scratch directories now use the product's existing state
  boundary, so generated vault and provider folders are not mistaken for
  operator identity data. Identity and full profile-path checks remain active.

## Security

This release carries a security pass over Full Remote Access and the credential
vault. Each item below has a test that fails on the old code and passes on this
one. Those tests now run on every later build too.

- The vault applies your per-credential switches only when a request says who is
  asking. A request that named nobody was treated as the program acting for
  itself, and was allowed. Full Remote Access named nobody. So a credential you
  had switched off for an agent could be read again by asking your paired
  computer for it. All three paths that run a tool now say who is asking. The
  name is fixed in the program, and a caller cannot supply or change it.
- A paired computer's key is now remembered the first time it is seen. A later
  connection offering a different key for that same computer is refused.
- The connection challenge is now a fixed shape and length. The other side
  cannot steer it.
- Folder rules now exclude credential folders at every depth, not only at the
  top. They also name private keys, keystores and the usual credential files.
- Each page of folder results now gets its own handle. One caller can no longer
  use up a shared limit and cause another caller's request to be refused.
- The folder the program keeps its state in is created private. If it is found
  any other way, it is repaired.
- The vault's two check tools now ship with this copy of the program. An
  installed copy can report a credential store whose permissions are too wide.

### Privacy of the files we distribute

- The owner's home folder path has been removed from 84 files that were tracked
  in the product source. A copy of that source no longer carries it.

## Known issues

- Final installed 1.0.46 validation and full source and lifecycle qualification
  are pending. The stopped-image path passed nine development-native checks,
  including conversation close and reopen; that is not an installed-artifact
  qualification claim.
- The complete Windows installed provider journey is not yet independently
  verified. Physical-phone testing is also incomplete.
- Pasted image previews may be unavailable after the app fully closes and restarts.
  The message transcript and turn records remain saved.
- FRA is **not independently tested yet** and is **only for testing purposes**.
- A stopped conversation draft mixing pasted images with earlier native file
  selections may require those files to be attached again. The draft is retained
  when the successor session lacks their access grant.

## Install

These are planned filenames. No 1.0.46 download, byte count, digest, or signing
result is claimed here. Each platform requires its own measured record before
publication.

### Windows installer

| Item | Value |
| --- | --- |
| Package | ToolsEnabled-Setup-1.0.46.exe |
| Platform | Windows |
| Bytes | 118,844,808 |
| SHA-256 | `57073dfbd7c0908cdd08751f591f7817b9f99e32480b7ef73d07f0c454f48e85` |
| Signed | yes: ToolsEnabled, Inc. (Authenticode, timestamped; issuer Microsoft ID Verified CS AOC CA 03). Read back Valid on Windows for the installer, the installed program and its uninstaller |

### Linux package

| Item | Value |
| --- | --- |
| Package | toolsenabled_1.0.46_amd64.deb |
| Platform | Linux |
| Bytes | 117,759,088 |
| SHA-256 | `de564616490f0c4257c1fcc5c7ad2a2ce83a94800bb215971c75a117e57ec9f6` |
| Signed | no, unsigned |

## Publisher and copyright

Published by ToolsEnabled, Inc.

Copyright © 2026 Joshua Pinckard

ToolsEnabled was founded and created by Joshua Pinckard. The original platform was
developed by directing autonomous AI-agent fleets through the system's own evolving
coordination architecture.

Contributors and maintainers are never founders.
