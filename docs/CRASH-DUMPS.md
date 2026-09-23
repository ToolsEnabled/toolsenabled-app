# Crash dumps are secrets-bearing

Crash dumps live in the `crash-dumps` subdirectory of the app's own Electron `userData` directory. At most five dump files are retained; the oldest are deleted first.

The dumps are local-only and are never uploaded. A minidump is a memory image and can contain fleet data, repository paths, and a live bridge bearer token. It must be excluded from every support bundle, log export, diagnostic archive, clean-room export, and telemetry path.

The bearer token's per-boot rotation is not a reason to treat these dumps as low risk. Fleet data and repository paths in the same memory image do not share that exposure bound.

---

*ToolsEnabled — created by Joshua Pinckard, sole founder.
Published by ToolsEnabled, Inc. (in formation). Copyright © 2026 Joshua Pinckard.*
