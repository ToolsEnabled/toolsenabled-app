# Reading the computer's saved trees

`GET /v1/agent/desktop-tree` serves the paired computer's authoritative native
tree workspace through the existing agent facade. It is a read; it creates no
agent, watch, browser-local tree, or transfer of session ownership. The native
command is `agent:desktop-tree`. The browser cannot choose a preference key,
account, or computer through this route.

The ordinary response is:

```json
{
  "ok": true,
  "mayWrite": false,
  "desktopTree": {
    "version": 1,
    "computerId": "this-computer",
    "trees": [],
    "nodes": []
  },
  "sessions": [],
  "sessionsTruncated": false
}
```

`this-computer` is the native workspace identity within the computer selected
by the authenticated connection. Tree IDs, node IDs, tree membership and parent
links come from native persisted state. Drafts, terminal nodes and empty trees
remain present. The response also retains tree names/kind, role/naming fields,
message, status/note, reply preview, tier/effort, clocks, last turn ID and creation
metadata. Existing desktop display normalization applies to legacy fields;
`reply` is the same bounded preview the desktop stores, not a full transcript.
Profile pointers, editor-fork receipts and unrelated settings are excluded.

`sessions` uses the existing desktop-session metadata contract. Match its
`nodeId` and `sessionId` to the saved graph; `busy` describes actual provider
activity and can be unknown. A saved `running` status or an open session alone
does not establish that a provider is currently replying. Only the session list
can be truncated; topology is never truncated. Conversations keep using the
existing desktop transcript/send APIs and their permission checks. A consumer
must not hydrate an independently writable browser store and treat it as this
computer's tree.

## Bounded snapshot transfer

An ordinary response above the existing 96 KiB facade limit refuses with
`AGENT_FACADE_RESPONSE_TOO_LARGE`. Read `?page=0` to capture a point-in-time
snapshot, then `?page=N&snapshot=SHA256` for each remaining page. Each response
contains `desktopTreeSnapshot` with `version: 1`, `sha256`, total UTF-8 `bytes`,
zero-based `page`, total `pages`, and canonical base64 `data`. Chunks contain
64 KiB of serialized bytes, except the last. Validate and concatenate every
chunk, verify the complete SHA-256, then decode UTF-8 and parse JSON. Never merge
partial results or decode individual chunks as text.

The native facade retains one immutable snapshot, at most 65 MiB, for a fixed
30-minute window. This accommodates the native 64 MiB preference-record bound
plus metadata and up to 1040 individually verified pages. Reading pages does
not extend retention. A second capture in progress refuses with
`AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_BUSY`; a new completed capture replaces the
previous one. Expired/replaced cursors refuse with
`AGENT_FACADE_DESKTOP_TREE_SNAPSHOT_CHANGED`. An old cursor cannot erase a newer
snapshot. Close or bearer replacement immediately drops retained bytes.

Every page checks a private native lease bound to the original owner, device,
pair, connection generation and write-access setting. A failed check permanently
revokes that lease. This does not replace current pairing checks with cached
authority. Saved replies may continue changing while all pages of the captured
view remain consistent. Refresh after completing a transfer for newer activity.

Unreadable native preferences refuse `MC_AGENT_DESKTOP_TREE_UNAVAILABLE`, damaged
preferences refuse `MC_AGENT_DESKTOP_TREE_DAMAGED`, and invalid topology refuses
`MC_AGENT_DESKTOP_TREE_INVALID`. Only an actually absent native tree key is an
empty workspace. Older native builds may return an unknown-route refusal;
their open-session list is not an authoritative tree substitute.

Source and transport tests are not installed or mobile acceptance. Qualify this
API on the frozen native candidate and let the mobile/FRA team verify the exact
same tree IDs, hierarchy, drafts, completed nodes and conversations through its
own consumer.
