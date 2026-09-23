# The Relay Agent Facade — completing Bob's scenario

**Status (2026-09-01): HISTORICAL DESIGN. The facade, browser binding, relay
supervision, and principal-aware command surface now exist in the current
sources. This document is not source or release authority, and it is not proof
that Bob's real cross-machine scenario passed. Current code and the active
private-release protocol win; the staging proof in section 10 remains a gate.**

The scenario this completes, in the owner's words: *"User Bob has connected his
computer at home and his computer at work and agents are running on both… Bob
hops on his friend's computer… logs in to our site and can check in and give
commands and adjust the workflow, etc — everything you can do in the real app —
except it isn't doing work on his friend's computer."*

What already works: a signed-in tab opens a sealed end-to-end session to Bob's
machine and carries mission-bridge requests through it (`src/mission-bridge.js`
transport seam → website `host-bridge.js` → vendored relay modules → engine
`online-fra-relay-shell.js` → the machine's own action bridge). What does not:
the app's views make 121 `window.mcAgent`/`window.mcOrg`/co. lookups that only
the Electron preload answers, so in a browser Bob can see bridge-route surfaces
but cannot start, message, or inspect an agent, and cannot read or edit the
org. The agent handlers live in `shell/main.cjs` — the Electron main process —
and the relay can only carry what the machine side serves as HTTP routes.

This document designs the missing piece: **the agent facade** (machine side), 
**the browser binding** (web side), the auth chain that joins them, events and
timeouts over the tunnel, supervision, publication order, tests, and failure
modes.

File and symbol citations use repository-relative paths. The app and engine
repositories are independent inputs; no personal profile or sibling checkout
is an authority for this contract.

Line numbers drift; the symbol names will not.

---

## 0. Corrections to the working premises — the code wins

These were found while verifying the premises this design was commissioned
under. Each changes the design and is folded in below.

1. **The tunnel targets ONE origin, and there is no route-registration seam.**
   The machine performs a tunnelled request via `localBridge.fetch(path, init)`
   (engine `src/lib/online-fra-relay-shell.js`, `serve()` ~line 253), and the
   production `localBridge` (`src/lib/online-fra-local-bridge.js`) resolves the
   origin **per call** from `state/mission-bridge-runtime.json` and refuses
   anything not loopback ("PATH ONLY… There is no parameter by which a
   tunnelled request can be sent anywhere else"). The mission-bridge server's
   route table is a frozen object (`src/lib/mission-bridge/server.js` `ROUTES`,
   ~line 56) with no extension point. So "register into the engine capability
   layer's route table" is not available as written; the shell's surface must
   reach the tunnel through a **composite localBridge** (§2), which is an
   engine change at the injection seam the relay shell already exposes.

2. **The browser's 300s timeout ceiling is dominated by a machine-side 30s
   cap.** `createLocalBridge({ timeoutMs = 30_000 })`
   (`online-fra-local-bridge.js` ~line 46) aborts every machine-side bridge
   call at 30s, and `serve()` imposes no larger budget. The website's
   documented `requestTimeoutMs: 300000` ceiling hack (`website/public/
   host-bridge.js`, `openRelay()`) therefore only moves *where* a long action
   dies: a tunnelled `cloud-launch` (240s budget, `src/mission-bridge.js`
   `ACTION_TIMEOUT_MS` line 493) fails **on the machine at ~30s today**, while
   the browser waits up to 300s for an answer that already died. The timeout
   design (§6) must thread a budget through *both* ends, not just the browser.

3. **Agent sessions are window-owned and die with the window.** Every driving
   channel checks `ownedAgentSession(event.sender, sessionId)`
   (`shell/main.cjs:591`), and `bindAgentOwner()` (`shell/main.cjs:621`)
   closes all of a window's sessions when its `webContents` is destroyed;
   `window-all-closed` quits the app. A remote caller has no `webContents`.
   Remote sessions need their own owner principal (§5), and Bob's scenario
   additionally requires the home machine's app to be *running* — today,
   closing the window ends everything. The resident-app question is an owner
   decision named in §8.

4. **`mc-org:read` returns a filesystem path today.** `agentOrgRecord.read()`
   returns `{ ok, org, roles, overlayFile }` (`shell/agent-org-record.cjs`
   ~line 203–209); `overlayFile` is an absolute path. On IPC that stays inside
   the app's own window; over the tunnel it would put a machine path in a
   browser on someone else's computer. The facade drops it (§4.2). (Candidate
   app-side cleanup independent of this design.)

5. **The tunnel already carries an idempotency key.** `x-request-id` is in
   `FORWARDABLE_REQUEST_HEADERS` on the machine side
   (`online-fra-relay-shell.js` ~line 110) — nothing sets it yet. The
   idempotency design (§5.3) rides this existing seam instead of inventing one.

6. **Unknown frame types are already ignored safely on both ends.** The
   machine's `onFrame()` dispatches only `t:'req'|'res'|'err'` and drops other
   parsed messages after `open()` has advanced the receive sequence; the
   vendored web client does the same ("the browser asks; it is not asked",
   `online-fra-web-client.mjs` ~line 233). So adding a `t:'evt'` push frame
   (§6.2) is deploy-order-safe in both directions.

7. **No account-server change is required.** `GET /v1/relay/pairs`,
   `POST /v1/relay/leases` (machine and `role:'web-client'` branches), and
   `GET /v1/relay/web-peer` (`server/src/http-service.js` ~1490–1660) already
   carry everything this design needs. The whole change lands in engine, app,
   and website.

8. **There is no enrolment surface in the app.** Device claim exists only in
   the engine (`src/lib/online-fra-device-claim.js`) and is driven by hand-run
   tools. Bob's scenario end-to-end needs an in-app "connect this computer"
   flow eventually; this design treats enrolment state as an input (§7) and
   names the gap in §11.

9. **Remote `start` cannot name a folder, and that is already right.**
   `parseAgentStart` refuses a renderer-sent `cwd` by name
   (`MC_AGENT_CWD_NOT_YOURS`, `shell/main.cjs` ~line 682): the only route to a
   working folder is a `profileId` — a folder the person picked in a native
   dialog **at the machine**. Remote start inherits exactly this consent
   boundary with zero new code.

---

## 1. Shape of the whole

```
  friend's computer                                 Bob's home machine
  ┌──────────────────────────┐                     ┌───────────────────────────────────┐
  │ browser tab, signed in   │                     │ Electron shell (main process)     │
  │  app bundle (unchanged)  │                     │  ├ IPC handlers  (window path)    │
  │  window.mcAgent ────────┐│                     │  ├ AGENT COMMAND SURFACE (shared) │
  │  window.mcOrg   ───────┐││                     │  ├ AGENT FACADE (loopback http,   │
  │  window.mcShell        │││                     │  │   ephemeral port, per-boot     │
  │   .getBridgeTransport  │││                     │  │   bearer, no discovery)        │
  │ host-bridge.js         │││                     │  └ RELAY SUPERVISOR (spawns ↓)    │
  │  agentCall() ──────────┘││                     │                                   │
  │  bridge transport ──────┘│                     │ relay child (engine payload,      │
  │  web client (vendored)   │                     │  ELECTRON_RUN_AS_NODE)            │
  └───────────┬──────────────┘                     │  online-fra-relay-shell           │
              │ wss (sealed frames)                │  COMPOSITE localBridge:           │
              ▼                                    │   /v1/agent/* /v1/org/* → facade  │
     relay edge (blind)                            │   everything else → mission bridge│
              ▲                                    │                                   │
              │ wss (sealed frames)                │ capability layer child            │
              └────────────────────────────────────│  mission-bridge server 4610-4619  │
   account server: /v1/relay/pairs, /v1/relay/     │  (existing ~30 action routes)     │
   leases, /v1/relay/web-peer  (unchanged)         └───────────────────────────────────┘
```

Three properties are held constant from the existing architecture:

- **The app above the seams does not change.** Views resolve
  `window.mcAgent` at call time and feature-detect every method
  (`src/views/computers.js:677, 1905, 5153, 6620` and 25 more sites) — the
  binding is host-supplied, exactly as `host-bridge.js` already supplies
  `window.mcAccount` and `window.mcShell`.
- **The relay stays blind and the session stays the authorization.** Nothing
  in this design adds a header, token, or route the relay edge can read.
- **No new authority is invented.** The facade serves the same commands the
  window may issue, bounded the same way, recorded the same way, to a
  principal that is Bob authenticated end-to-end.

---

## 2. Machine-side surface: the agent facade

### 2.1 Decision

**The shell hosts a loopback HTTP facade in the Electron main process, and the
relay child reaches it through a composite `localBridge`.** Specifically:

- `shell/agent-facade.cjs` (new): an `http.createServer` bound to
  `127.0.0.1`, **port 0 (ephemeral)**. No runtime file, no discovery, no
  port-range scan: the shell is the only party that needs the address and it
  hands the exact `origin` + a per-boot 32-byte bearer to the one legitimate
  caller at spawn time. (Contrast with the mission bridge, which *must* be
  discoverable by a renderer; the facade must not be discoverable at all.
  A squatter cannot race onto a port nobody looks for.)
- The facade dispatches to a new `shell/agent-command-surface.cjs` (new):
  the bodies of today's `mc-agent:*` / `mc-org:*` handlers, extracted so the
  IPC handlers and the facade call the **same functions** with a
  caller-principal parameter. One definition of every bound and refusal, or
  the two paths drift — the same reason `trustedFleetProfileSender` is reused
  rather than duplicated (`shell/main.cjs:601–609`).
- Engine: `createLocalBridge` gains a sibling
  `createCompositeLocalBridge({ facade: { origin, token } | null })` (or an
  option on the existing factory) that routes `path.startsWith('/v1/agent/')
  || path.startsWith('/v1/org/')` to the facade with
  `authorization: Bearer <facade token>`, and everything else to the existing
  mission-bridge path unchanged. **Fail closed**: with no facade configured,
  those prefixes answer `502 {ok:false,error:{code:'AGENT_FACADE_ABSENT'}}` —
  the tunnel then reports an honest refusal, never a hang and never a
  fall-through to the mission bridge.
- The relay child is the engine's supervised relay loop (§7) launched by the
  shell with `TOOLSENABLED_AGENT_FACADE_ORIGIN` / `_TOKEN` in an explicitly
  constructed child environment — the same discipline `childEnvironment()`
  already applies to `ELECTRON_RUN_AS_NODE` and `TOOLSENABLED_STATE_ROOT`
  (`shell/capability-layer.cjs:88–95`).

### 2.2 Alternatives weighed

**(a) Register agent routes into the mission-bridge server.** Refused. The
route table is frozen (`server.js` ~56) and, decisively, the machinery behind
the handlers — `agentHost`, `agentSessions`, `sessionProfiles`, the spawn and
usage recorders, `agentOrgRecord` — lives in the Electron main process. The
engine child could only serve those routes by proxying back to the shell,
which is this design with an extra hop, or by moving the host into the engine,
which forks the session-ownership model and the signed spawn/usage ledgers.

**(b) Run the relay shell in-process in Electron main, with an in-process
"localBridge" that calls the handlers directly.** Attractive — no listener,
no token, nothing another process can even connect to — but refused for
process-hygiene reasons the codebase has already paid for: the engine modules
resolve their state root from `TOOLSENABLED_STATE_ROOT` (engine
`src/lib/runtime-state-root.js`), which the shell sets **for the child and
deliberately not for itself**; vault reads spawn PowerShell per read (engine
`src/lib/runtime.js` ~325); and the reconnect/backoff loop plus sealing would
ride the GUI event loop. A supervised child is the established pattern
(`startCapabilityLayer`), crashes in isolation, and reuses
`tools/relay-shell.js` almost whole.

**(c) Facade token in an owner-ACL'd state file** (the mission-bridge
pattern). Not needed and slightly worse: a file invites a second reader. The
spawn-time handoff keeps the set of parties that ever hold the token at
exactly two processes, both ours. (What this does and does not buy is stated
honestly in §5.1.)

### 2.3 Facade server rules

- Binds `127.0.0.1` only; `listen(0)`; origin+token minted per shell boot and
  re-handed if the relay child is respawned.
- **Refuses any request carrying an `Origin` header** (403,
  `AGENT_FACADE_NO_BROWSERS`): no browser is ever a legitimate caller, so
  unlike the mission bridge there is no CORS surface at all. This is a
  stricter posture than `corsHeaders()` (`server.js` ~257) and is correct
  here precisely because the facade serves exactly one non-browser client.
- Requires `authorization: Bearer <token>` on every route, compared in
  constant time. No bootstrap route, no proof exchange, no unauthenticated
  discovery route.
- JSON only; request bodies bounded (64 KB — well under the tunnel's 128 KB
  `MAX_TUNNEL_BODY_BYTES`); responses bounded (§6.4).
- Error shape mirrors the mission bridge: HTTP status +
  `{ ok:false, error: { code, message } }`, with the same
  renderer-safe discipline as `rendererSafeAgentError()`
  (`shell/main.cjs:552–559`): **the code is the message; no path, no
  internal prose crosses**.

---

## 3. Route table — `window.mcAgent`

Every method of the preload's `mcAgent`
(`shell/fleet-profile-preload.cjs:36–139`), its facade route, and the shapes
**as the handler code actually returns them**. "Throws" means the IPC invoke
rejects with an `Error` whose message *is* the bounded code
(`rendererSafeAgentError`, `shell/main.cjs:552`); the facade maps a throw to
HTTP 4xx/5xx `{ok:false,error:{code}}` and the browser binding re-throws
`Object.assign(new Error(code), { code })`, which `refusalCode()`
(`src/agent-availability-copy.js:452`) reads identically. Handlers that
*return* `{ok:false,…}` (they do not throw) pass through as HTTP 200 with the
body verbatim — exactly the IPC semantics.

| # | Method | Route | Verb | Request | Success shape (source) | Remote decision |
|---|--------|-------|------|---------|------------------------|-----------------|
| 1 | `availability` | `/v1/agent/availability` | GET | — | `{ok:true,code:'AGENT_ENGINE_READY'}` or `{ok:false,code}` — spawn-record availability first, then engine (`main.cjs:1411–1433`; `agent-host.cjs:967–1035`; `spawn-record.cjs:531`) | serve |
| 2 | `confinement` | `/v1/agent/confinement` | GET | — | `{ok,tier,sandbox,approvalPolicy,isolated,recorded,failedClosed,code,toolsAllowed,toolsTotal}` (`agent-confinement-read.cjs:131–144`) | serve |
| 3 | `tools` | `/v1/agent/tools` | GET | — | `{ok,tier,total,tools:[name…]}` (`agent-confinement-read.cjs:190`) | serve |
| 4 | `startableTiers` | `/v1/agent/startable-tiers` | GET | — | `{ok:true,tiers:[id…]}` (`agent-host.cjs:2560–2568`) | serve |
| 5 | `localMessages` | `/v1/agent/local-messages?limit=` | GET | limit 1–200 | `ownerJournal()` result; degraded builds answer `{ok:false,reason}` (`main.cjs:1479–1495`) | serve |
| 6 | `history` | `/v1/agent/history?limit=` | GET | limit | `{ok,total,entries:[{sequence,at,action,…}],verified,outcomes}` (`spawn-record.cjs:940`) | serve; **paginate** (§6.4) |
| 7 | `usage` | `/v1/agent/usage?limit=` | GET | limit | `{ok,total,verified,entries:[…usage records…]}` (`usage-record.cjs:194–202`) | serve; paginate |
| 8 | `start` | `/v1/agent/start` | POST | `{sessionId?,tier?,effort?,profileId?,resumeThreadId?,surface?,requestKeys?}` — `cwd` refused by name, `MC_AGENT_CWD_NOT_YOURS` (`main.cjs:~668–690`) | `{sessionId,threadId,tier,effort,account,resumed?,record:{sequence,eventHash}}` (`main.cjs:1806–1812`; `agent-host.cjs:2217–2227`). Throws `MC_AGENT_SESSION_EXISTS`, `MC_AGENT_SESSION_LIMIT`, engine codes | serve — **irreversible**; §5.2/§5.3 |
| 9 | `send` | `/v1/agent/send` | POST | `{sessionId,text,model?}` — `images` omitted remotely: the allowlist is only ever fed by the machine's native dialog (`main.cjs:1833–1843`), so a remote image path would be refused `MC_AGENT_ATTACHMENT_UNKNOWN` anyway; the binding does not offer it | `{sessionId,threadId,turnId}` (`agent-host.cjs:2340–2346`). Throws `AGENT_TURN_ACTIVE` etc. | serve — irreversible (spends a turn); §5.3 |
| 10 | `request` | `/v1/agent/request` | POST | `{scope,key?,words}` (bounds: 16/128/16 KB, `main.cjs:1866–1880`) | `{ok:true,id,scope,key}` (`agent-host.cjs:2585`) | serve — durable write |
| 11 | `requests` | `/v1/agent/requests?scope=&key=` | GET | scope, key | `{ok,exists,entries:[{id,words}]}` (preload contract note, `fleet-profile-preload.cjs:76–80`; `standing-requests-read.cjs`) | serve |
| 12 | `pickAttachment` | — | — | — | `{ok,path\|null}` via native dialog (`main.cjs:1952–1969`) | **OMIT** (§4.3) |
| 13 | `pickMention` | — | — | — | `{ok,path\|null}` via native dialog (`main.cjs:1975–1990`) | **OMIT** |
| 14 | `profiles` | `/v1/agent/profiles` | GET | — | `{ok:true,profiles:[…]}` — ids and names, paths stay main-side (`main.cjs:1919–1922`) | serve |
| 15 | `profileCreate` | — | — | — | runs the OS folder dialog (`main.cjs:1924–1938`) | **OMIT** — the dialog **is** the consent boundary |
| 16 | `profileRemove` | `/v1/agent/profile-remove` | POST | `{profileId}` | `{ok:true,removed}` (`main.cjs:1941–1950`) | serve |
| 17 | `interrupt` | `/v1/agent/interrupt` | POST | `{sessionId}` | `{sessionId,turnId}` (`agent-host.cjs:2403–2413`) | serve |
| 18 | `rewind` | `/v1/agent/rewind` | POST | `{sessionId,turnId}` | `{sessionId,threadId,turnId}` (`agent-host.cjs:2422–2438`) | serve — destructive to the thread fork; idempotent by nature (same turnId) |
| 19 | `setEffort` | `/v1/agent/effort` | POST | `{sessionId,effort}` — closed set (`main.cjs:349, 2044–2056`) | `{sessionId,effort}` (`agent-host.cjs:2446–2458`) | serve |
| 20 | `models` | `/v1/agent/models?sessionId=` | GET | optional sessionId | engine's own `listModels()` catalog, passed through (`agent-host.cjs:2467–2475`) | serve |
| 21 | `answerApproval` | `/v1/agent/approval-answer` | POST | `{sessionId,approvalId,decision}` (`main.cjs:2007–2024`) | `{sessionId,approvalId,decision}` (`agent-host.cjs:2484–2490`) | serve — **irreversible** (approves real effect); §5.2/§5.3. Nothing fires approvals today (policy `'never'` at every tier) — the path lands first, by the codebase's own ordering doctrine |
| 22 | `close` | `/v1/agent/close` | POST | `{sessionId}` | `{sessionId,closed:true}` (`agent-host.cjs:2493–2504`) | serve |
| 23 | `onEvent` | `/v1/agent/events` (§6) | GET | `after`, `sessionId?`, `waitMs?` | `{ok,seq,events:[{seq,packet}],dropped}`; `packet` is the IPC packet verbatim: `{sessionId,event}` (`agent-host.cjs:1668`; forwarded on channel `mc-agent:event`, `main.cjs:341, 1369–1377`) | serve via buffer; push in Phase 2 |
| 24 | `sessionAccounts` | `/v1/agent/session-accounts` | GET | — | `{ok:true,sessions:[{sessionId,agentId,account,provider}],report,reportReason}` — the host's `sessionAccounts()` rows with `pinnedHome` dropped in the surface, joined to the engine's `handoverReport()` (`agent-host.cjs` `sessionAccountRows`; `capability/src/lib/multi-account/handover.js`) | serve — a read that starts nothing and moves nothing; the account NAME it carries already crosses on row 8, and the confined home directory never leaves the main process |

New facade-only routes:

| Route | Verb | Purpose |
|---|---|---|
| `/v1/agent/events` | GET | The event buffer read (§6.1). |
| `/v1/agent/remote-status` | GET | `{ok, facade:'ready', sessionsOpen, maxSessions}` — lets the web UI say "connected to <machine>, N of 8 sessions" without a start. |

## 4. Route table — `window.mcOrg`, and what is deliberately absent

### 4.1 mcOrg

All eight preload methods (`fleet-profile-preload.cjs:189–198`) map 1:1. The
org handlers never throw — refusals come back as
`{ok:false,code,reason}` via `withFleetProfileSender`/`fleetFailure`
(`main.cjs:2429–2436`) — so every route answers HTTP 200 with the record's own
verdict, and the binding passes it through untouched.

| Method | Route | Verb | Request | Success shape (source) |
|---|---|---|---|---|
| `read` | `/v1/org` | GET | — | `{ok,org,roles}` — **`overlayFile` dropped at the facade** (it is an absolute path; `agent-org-record.cjs:203–209`, §0.4) |
| `reparent` | `/v1/org/reparent` | POST | `{agentId,parentId,expectedRevision}` | `{ok,org}` (`agent-org-record.cjs:212–219`) |
| `assignRole` | `/v1/org/assign-role` | POST | `{agentId,role,expectedRevision}` | `{ok,org}` (`:222–226`) |
| `createRole` | `/v1/org/create-role` | POST | `{id,baseDefaultRole,rules}` | `{ok,roles}` (`:229–233`) |
| `editRole` | `/v1/org/edit-role` | POST | `{id,rules}` | `{ok,roles}` (`:~248–251`) |
| `resetRole` | `/v1/org/reset-role` | POST | `{id}` | `{ok,roles}` (`:~259–262`) |
| `reset` | `/v1/org/reset` | POST | — | `{ok,org}` (`:~270–273`) |
| `exportOrg` | `/v1/org/export` | GET | — | pass-through of `exportOrg()`; bounded and, like `read`, stripped of any path field |

The org's own concurrency control (`expectedRevision`, refused stale) already
gives these writes safe retry semantics over a flaky tunnel: a duplicate
arrives with a now-stale revision and is refused, not applied twice.

The tier is deliberately not consulted for org edits and that carries over
unchanged — the handlers' own comment records why (declared intent grants no
authority; `main.cjs:3242–3268`).

### 4.2 What the facade never serves

- **`mc-bridge-proof` / `mc-bridge-endpoint`** (`main.cjs:3846, 3889`). The
  bootstrap proof is the *local* renderer's key to the *local* bridge. Remote
  callers get bridge routes through the tunnel, where
  `online-fra-local-bridge.js` injects the machine's own bearer per call; the
  website's `host-bridge.js` already omits `getBridgeProof` deliberately and
  `configuredBaseUrl()` refuses loopback on a public origin
  (`BRIDGE_FORBIDDEN_ON_PUBLIC_ORIGIN`, `src/mission-bridge.js:229–234`).
  Nothing changes; stated here so nobody "completes" the surface.
- **`mcSetup` / `mcLocalData` / `mcSettings` / `mcPrefs` / `mcProviders`
  / `mcAccount`(app-local)** — out of scope. Machine setup, erasure, the
  enforcement settings, and provider sign-ins are acts a person performs *at*
  the machine; the browser has its own `mcAccount` already. Absent globals
  render the app's own honest absence states (e.g. `mcSetup` absent = "no
  machine here to configure", `fleet-profile-preload.cjs:262–266`). One
  candidate for a later iteration: a read-only `/v1/agent/settings` mirror so
  the web can *show* (not change) the unattended-work switches.

### 4.3 The pickers — honest remote semantics

`pickAttachment` and `pickMention` open native dialogs **on the machine**
(`main.cjs:1952–1990`). Remotely there is nobody in front of that screen; a
dialog would hang a turn forever and, worse, `pickAttachment`'s dialog is the
*entire* security design of the image allowlist — "the only way a file path
enters a session's image allowlist" — with `send` refusing any path not
issued by it (`main.cjs:1833–1843`).

Decision: **the browser binding omits both methods.** The views already
feature-detect them (`canPick`, `src/views/computers.js:5153`;
`:2133, :2144, :5417, :5501`) and render no picker controls when absent — the
same honest degradation a build without the capability shows. `@`-mentions
remain available as plain typed text, which the agent's own confined tools
resolve or refuse — the mention comment in `main.cjs:1972–1975` already
defines the path as *text*, so nothing is lost but the browse dialog.

A later, separate review may add a bounded workspace-browse route (list
directories under the session's own workspace root) to back a web-side
picker; it must arrive with its own consent story, because it converts
"a human clicked this file" into "the remote principal named this file". Not
in this design.

---

## 5. Auth and safety

### 5.1 The chain, end to end, with the exact checks

**Browser → account server.** Same-origin session cookie. A web lease is
minted only for `role:'web-client'` on a **signed-in session** whose account
owns the pair; the machine's Ed25519 key comes back **beside** the lease so
the browser never takes it from a relay frame
(`server/src/http-service.js`, `POST /v1/relay/leases` web branch ~1560–1576;
geo-refused with 451 like every connection ticket). The browser identity is
per-tab, non-extractable, dies with the page
(`online-fra-web-client.mjs:107–112`); the chosen `relayPairId` lives in
`sessionStorage` only (`host-bridge.js chosenMachine()`).

**Browser → relay edge.** The edge challenges with a nonce; the browser signs
with the identity key the lease's fingerprint commits to; admission is silent,
refusal is a close (`online-fra-web-client.mjs:150–210`).

**Machine → the browser's key.** On the first web-leg hello, the machine asks
the **account server** — over its device-token channel, never the relay —
which key to expect: `GET /v1/relay/web-peer?relayPairId=`
(`online-fra-relay-shell.js buildWebSession()`; server-side the answer is the
same 404 for unknown/foreign/expired/no-browser, a non-oracle,
`http-service.js:1490–1515`). Only then is the e2e session built: X25519
ephemerals, transcript-bound AES-GCM, strict per-direction sequence — an
out-of-order or replayed frame fails `open()`
(`online-fra-e2e-session.web.mjs:282–296`, mirrored in the engine session).

**Sealed frames only.** `serve()` is reachable **only** through
`legSession.open(frame)` succeeding; the sole unsealed message a leg accepts
is the tagged hello, and only before a session exists
(`online-fra-relay-shell.js onFrame()`). *An unsealed relay frame cannot
reach the facade — by construction, not by a check that could be skipped.*

**Relay child → facade.** Loopback + the per-boot bearer handed at spawn
(§2.1) + the no-`Origin` rule. What this does and does not claim, stated
plainly: within the product's recorded trust boundary
("single-user-loopback-origin-and-local-file-proof-bound",
`mission-bridge/server.js` bootstrap reply; restated in
`online-fra-local-bridge.js`'s header — "the files ARE the authorization
model: whoever can read them is the owner"), another process running **as the
owner** is the owner — it can already read the mission-bridge bearer file and
drive dispatch today. The facade's spawn-time token narrows the surface (no
file to find, no discovery port) but does not and cannot defeat a same-user
local attacker; no loopback scheme can. What the facade **does** guarantee:
no *browser* caller (Origin refused, no CORS), no *remote* caller except
through the sealed session, no *unsealed* frame, and no cross-account caller
(the lease chain above).

**Facade → sessions.** Remote sessions are owned by a **relay principal** —
a durable owner object the facade holds for the lifetime of the shell (not of
one relay connection), passed to the shared command surface where the IPC path
passes `event.sender`. `ownedAgentSession(principal, sessionId)` then gives
remote exactly the containment the window has: a remote caller cannot drive a
window-started session, a window cannot drive a remote-started one, and — the
part that makes Bob's scenario work — **a dropped tab or a lease expiry does
not close remote sessions**, because the principal survives reconnects. The
`bindAgentOwner`-style destroyed hook is deliberately *not* attached to relay
connections.

Two visibility grants cross the ownership line, both reads: the event buffer
(§6.1) carries all sessions' packets, and `history`/`usage` are machine-wide
records already. Both are Bob reading Bob's machine from Bob's account; write
paths stay owner-bound. Widening writes ("drive from the web a session I
started at the desk") is a real want, is one line to grant, and is **not
granted here** — it is listed as an owner decision (§11), because it converts
session ownership from a structural guarantee into a policy.

### 5.2 Irreversible commands arriving remotely

Irreversible on this surface: **`start`** (spawns a real CLI child that does
real work and spends real money), **`send`** (spends a turn),
**`answerApproval`** (approves an effect the approval exists to gate),
**`rewind`** (discards a fork), **`org.reset`/`resetRole`** (discards
records), **`profileRemove`**.

Design position: the sealed session *is* Bob, so no per-command second factor
is added — with one gate:

- **A machine-local standing consent to remote drive.** As built: a switch
  in the connect section of Settings (`src/connect-computer-settings.js`,
  labelled *"Let a signed-in browser drive this computer"*), stored in
  `shell/renderer-prefs.cjs` under `mc.relay.web-drive` and read per command
  by `webDriveMayWrite()` in `shell/relay-supervisor.cjs` — not a
  `product-settings.cjs` registry row, since the switch has no meaning until
  the computer is on an account and a registry row without a control is the
  half-setting that file forbids. The question is asked once, on the
  computer, at the moment the claim lands; "Not now" writes nothing. The
  facade refuses every **write** route (`start`, `send`,
  `approval-answer`, `rewind`, `effort`, `close`, `request`,
  `profile-remove`, all `/v1/org/*` writes) with
  `MC_AGENT_PRINCIPAL_READ_ONLY` while it is off; reads stay served so the
  web can honestly show state and say *why* commands are refused, and the
  refusal sentence names the switch. The default is off, as ruled (§11); the
  original framing of that ruling follows. The conservative default is off; the Bob-scenario default is
  set-at-enrolment. The mechanism is identical either way, so the decision
  does not block the build.
- `answerApproval` needs nothing extra *today* (`approvalPolicy` is `'never'`
  at every tier — `main.cjs:2003–2006`, `agent-host.cjs:2477–2483`). The day
  `'on-request'` is offered, remote answers ride the same audited path with
  the principal recorded; whether an approval raised locally may be answered
  remotely is part of *that* review, not this one.
- Every remote command is **recorded as remote**: the spawn/usage recorders
  already take a `principal` (`usage-record.cjs recordTurn({principal…})`);
  the facade passes its relay principal so the signed ledgers distinguish
  "started at the keyboard" from "started over the relay" forever.

### 5.3 Idempotency

The retry a person makes after a timeout is the attack this section defends
against — the codebase has already measured the double-dispatch failure
(`src/mission-bridge.js` `ACTION_TIMEOUT_MS` header note).

- The browser binding mints an `x-request-id` (UUID) **per logical user
  action** and reuses it on automatic retries. It already rides the tunnel:
  `FORWARDABLE_REQUEST_HEADERS` includes it on the machine side and
  `FORWARDABLE_RESPONSE_HEADERS` echoes it back
  (`online-fra-relay-shell.js:109–111`).
- The facade keeps a bounded LRU (e.g. 256 entries, 10-minute horizon) of
  `x-request-id → {status, body}` for the POST routes and **replays the
  recorded answer** on a duplicate. A replay is marked
  (`x-request-id-replayed: 1` response header → surfaced in the reply body as
  `replayed:true`) so the UI can say "already done" rather than pretend a
  second act happened.
- Beneath that, the structural guards already present do most of the work and
  are kept load-bearing: `start` with a client-chosen `sessionId` refuses a
  duplicate with `MC_AGENT_SESSION_EXISTS` (`main.cjs:1760–1762`) — the
  binding treats that code, on a retry it knows it made, as
  "the first attempt won"; `send` refuses a concurrent turn
  (`AGENT_TURN_ACTIVE`, `agent-host.cjs:2283–2285`); org writes carry
  `expectedRevision`.

---

## 6. Timeouts, events, and streaming

### 6.1 Events, Phase 1 — the buffer and the poll (no protocol change)

The facade subscribes once to `getAgentHost().onEvent` +
`onSessionExit` (exactly as `main.cjs:1369–1394` does for the window) and
keeps a ring buffer: a monotonically increasing `seq`, packets stored
verbatim (`{sessionId, event}`), bounded per machine (e.g. 2048 packets) and
per read (§6.4).

`GET /v1/agent/events?after=<seq>&sessionId=<optional>&waitMs=<0..20000>`
answers `{ok:true, seq:<newest>, events:[{seq,packet}…], dropped:<bool>}`.
`waitMs` long-polls bounded at 20s — safely under the web client's 60s
request default and the machine-side budget (§6.3); concurrent tunnel
requests interleave freely (each sealed response carries its own sequence;
ordering is per frame, not per request — `pending` map on both ends).
`dropped:true` means the ring wrapped past `after`: the binding then
resynchronizes state (re-reads `requests`, `history`, session status) and
tells the surface the transcript has a gap, rather than silently splicing.
Polling cadence browser-side: `waitMs=20000` continuous long-poll while an
agent surface is mounted; idle otherwise.

This phase needs **zero** changes to the vendored tunnel modules and works
the day the facade exists.

### 6.2 Events, Phase 2 — push over the tunnel

The tunnel supports machine-initiated frames today: the socket is duplex, the
machine already sends its hello *to* the web leg
(`online-fra-relay-shell.js buildWebSession()` tail), and both ends ignore
unknown `t` values after `open()` (§0.6) — so a new sealed frame
`{t:'evt', seq, packet}` is deploy-order-safe.

- Engine: the relay shell handle grows `push(leg, message)` (a thin wrapper
  over the existing `sealTo`), and the supervised entry (§7) bridges facade
  events → `push('web-client', {t:'evt',…})` while a web session is open.
- Engine web client: dispatch `t:'evt'` to an `onEvent(listener)` the client
  handle exposes; everything else unchanged.
- Website: re-vendor; `host-bridge` wires client `onEvent` into the
  `window.mcAgent.onEvent` listener set.

The poll route **remains** as the catch-up path (reconnects, `dropped`
recovery) — push is an optimization of latency, not the source of truth. The
binding's `onEvent` contract is the preload's: takes a listener, returns its
own unsubscribe (`fleet-profile-preload.cjs:130–138`).

### 6.3 Timeouts — threading the budget through both ends

Today (measured, §0.2): app per-action budgets up to 240s
(`mission-bridge.js:493–505`) → website transport **drops** `timeoutMs`
(`relay-bridge-transport.mjs` destructures `{method, body}` only) → web
client fixed 60s, raised to a blanket 300s ceiling by `host-bridge.js` → the
tunnel `req` frame carries no budget → machine `serve()` has none →
`createLocalBridge` aborts at a fixed 30s. Fix, one hop at a time:

1. APP `src/relay-bridge-transport.js`: pass `timeoutMs` through to
   `client.request(method, path, { headers, body, timeoutMs })`.
2. ENGINE `online-fra-web-client.mjs` (and the machine-side
   `request()` in the relay shell, same seam): accept per-request
   `timeoutMs`, clamp to `[1s, 300s]`, default unchanged; include
   `budgetMs` in the `t:'req'` frame.
3. ENGINE relay shell `serve()`: read `message.budgetMs` (absent → today's
   behaviour), clamp to the same ceiling, pass to
   `localBridge.fetch(path, { …, timeoutMs })`.
4. ENGINE `createLocalBridge`: accept per-call `timeoutMs` (bounded), keeping
   30s as the default.
5. WEBSITE: after re-vendoring, delete the 300s ceiling hack in
   `host-bridge.js` — its own comment already promises exactly this
   ("a CEILING, not the real fix… Recorded rather than quietly accepted").

Old machine + new browser: `budgetMs` is an unknown key inside the sealed
JSON, ignored; behaviour is today's. New machine + old browser: no `budgetMs`
sent; defaults hold. No flag day.

### 6.4 Size bounds

`MAX_TUNNEL_BODY_BYTES` is 128 KB each way and the sealed-frame plaintext
ceiling is 190 KB (`online-fra-relay-shell.js` `MAX_TUNNEL_BODY_BYTES` ~line 76,
`online-fra-e2e-session.js:25`) — hard limits, not suggestions
(`TUNNEL_RESPONSE_TOO_LARGE` is returned for oversize, not a truncation).
Facade rule: **every** list route takes `limit` (+ `after` where a cursor
exists) and self-caps its response at 96 KB serialized, returning
`{…, truncated:true, next:<cursor>}` when it clipped. `history`, `usage`,
`events`, `org` read/export are the routes that can plausibly hit it. A
response the facade cannot bound is a design bug, not a bigger frame.

---

## 7. Supervision — what keeps the machine reachable

### 7.1 Decision

**The shell supervises a relay child**, exactly parallel to the capability
layer: new `shell/relay-link.cjs` mirroring `startCapabilityLayer` /
`stopCapabilityLayer` (`shell/capability-layer.cjs:110–200, 218–229`).

- **Entry**: the engine's `tools/relay-shell.js` grows supervised-mode flags
  (or a sibling `tools/relay-shell-supervised.js` composed from the same
  pieces): `--facade` (route `/v1/agent/*`+`/v1/org/*` through the composite
  bridge, §2.1, credentials from `TOOLSENABLED_AGENT_FACADE_ORIGIN/_TOKEN`),
  and NDJSON status events on stdout (`{"kind":"admitted"|"session-open"|
  "web-session-open"|"closed"|"not-connected","code":…}`) instead of prose on
  stderr — the identifier-free event discipline it already keeps
  (`tools/relay-shell.js` eventSink). Its reconnect/backoff loop
  (2s→60s, lease refresh 30s before expiry) is kept verbatim.
- **Spawn conditions**, checked in `shell/main.cjs` where
  `startSupervisedCapabilityLayer()` already runs (the integration point —
  the block near `main.cjs:3915` that builds `workspaceRoot` and starts the
  layer): capability payload present **and** the engine vault holds a device
  credential (`connectionState(vault).connected` — surfaced cheaply by
  having the relay child exit with a distinct one-line
  `{"kind":"not-enrolled"}` rather than teaching the shell to read the
  vault). Not enrolled → supervisor idles and re-checks on a slow timer /
  on an explicit "connect" action, and the status surface says so.
- **Environment**: `childEnvironment(env, { stateRoot })` reused as-is —
  `ELECTRON_RUN_AS_NODE=1`, `TOOLSENABLED_STATE_ROOT=<userData>/capability` —
  plus the two facade variables. The relay child thus reads the same vault
  and the same `state/mission-bridge-runtime.json` as the capability child it
  sits beside, which is what makes its tunnelled bridge requests land on the
  layer this same shell supervises.
- **Lifetime**: started after the capability layer settles (its bridge is the
  tunnel's serving target); killed in `will-quit` beside
  `providerLoginService.stopAll()` (`main.cjs:1703–1706`); respawned with the
  child's own backoff on exit.

### 7.2 The state, told to the person

`mc-relay:status` (invoke) + `mc-relay:event` (push), preload-exposed as
`window.mcRelay` — the same pattern as `mcProviders.onLoginEvent`. The
answer is words from a closed set, no ids:
`{ok, state:'not-enrolled'|'connecting'|'reachable'|'backoff'|'off',
code?, sinceMs}` → the Settings/computers surface renders **"This computer is
reachable from the web: yes / no + why."** A machine that is off or unreachable
appears *on the website* as the existing honest refusal
(`WEB_CLIENT_HANDSHAKE_TIMEOUT` → "The machine did not answer. It may be
switched off." — `online-fra-web-client.mjs:296`).

### 7.3 Named dependency

The relay child dies with the app. Bob's home machine must be **running the
app** for Bob to reach it — today that means a window open (window-all-closed
quits). A tray/background-resident mode ("keep this computer reachable when
the window closes") is an owner decision (§11); the supervisor design above
does not change either way.

---

## 8. Browser-side binding

All in `website/public/host-bridge.js` — the seam the application already
offers its host; zero changes to the app bundle, zero to the 121 call sites.

- **`agentCall(path, {method, body, timeoutMs})`** (new, beside the existing
  `openRelay`): uses the same connected web client, but returns the raw
  `{status, body}` judgement — it does **not** reuse
  `createRelayBridgeTransport`, whose `ok:true`-envelope rule
  (`relay-bridge-transport.mjs:55–61`) is the mission-bridge contract, not
  this one (facade success bodies like `start`'s carry no `ok`). Mapping:
  2xx → return parsed body verbatim; non-2xx → **throw**
  `Object.assign(new Error(code), {code})` from `body.error.code`; transport
  failure → throw with `code:'BRIDGE_UNREACHABLE'|'BRIDGE_TIMEOUT'` (the
  vocabulary `refusalCode()` and the availability copy already speak).
  This reproduces IPC semantics exactly: resolve what the handler returned
  (including its `{ok:false}` refusals), reject what the handler threw.
- **`window.mcAgent`**: defined when the person is signed in, with exactly the
  §3 methods marked "serve" — `pickAttachment`, `pickMention`,
  `profileCreate` **absent**, so `canPick` and the profile-create affordance
  render their honest absent states. `onEvent(listener)` registers into a
  listener set fed by the §6 poll loop (Phase 1) or client push (Phase 2) and
  returns its own unsubscribe — the preload's exact contract.
- **`window.mcOrg`**: the eight §4.1 methods over `agentCall`.
- **Lifecycle**: defined at script load (views look the globals up at call
  time, so early definition with lazy connection is safe); every method
  begins with `openRelay()` — no session/no machine yields the thrown
  `BRIDGE_UNREACHABLE`-family refusal the views already render. `signOut()`
  already tears the relay down first (`closeRelay()` before the sample-data
  flip); the binding's methods start refusing the moment the socket dies.
  On a machine *choice* change (multi-pair accounts), the binding drops its
  event cursor and listener state with the transport.
- **Vendored modules**: `online-fra-web-client.mjs` and
  `online-fra-e2e-session.web.mjs` re-vendored from the engine's published
  commit; `relay-bridge-transport.mjs` from the app's; `vendored.json`
  regenerated (hashes + commits). The binding itself stays website-authored,
  like the rest of `host-bridge.js` — it is host glue, not sealing code.

---

## 9. Publication and deploy sequence

This sequence is historical design rationale, not live release authority. The
active rule is that `ToolsEnabled/engine` and `ToolsEnabled/app` remain private;
nothing in this section authorizes making either repository public. Exact
private commits may be consumed only through authenticated provenance. A
website gate that still requires anonymously readable public source is a stale
blocking gate to repair, not permission to publish source. **[OWNER YES]**
continues to mark the historical owner-decision points below.

1. **ENGINE source lands** in the current authoritative engine worktree:
   composite local bridge; relay-shell supervised mode + `push()` +
   `budgetMs`; web client per-request `timeoutMs` + `t:'evt'` dispatch;
   contract tests (§10). *Nothing deploys.*
2. **APP source lands** in the current authoritative app worktree: `agent-command-surface`
   extraction (IPC behaviour identical — proven by the parity test);
   `agent-facade.cjs`; `relay-link.cjs` + `mcRelay` status surface + the
   remote-drive settings row; `src/relay-bridge-transport.js` gains
   `timeoutMs` pass-through. *Nothing deploys.*
3. **[OWNER YES] Engine push to the private engine repo** (the repo
   `vendored.json` names as `ToolsEnabled/engine`), commit `E`.
4. **[OWNER YES] App push to the private app repo** (`ToolsEnabled/app`),
   commit `A`; **[OWNER YES]** app release build cut from it (the release is
   what puts the facade on Bob's machines — the capability payload re-packed
   so the relay child's engine modules are the new ones).
5. **WEBSITE lands, gated on 3+4**: re-vendor the three modules from `E`/`A`,
   regenerate `vendored.json`; add the `mcAgent`/`mcOrg` binding +
   `agentCall`; delete the 300s ceiling hack (only with the re-vendored
   client, per §6.3.5); extend `relay-options-contract.test.mjs`.
6. **[OWNER YES] Website deploy.** Order within the rollout: machines update
   first (step 4's release), site last — a new site against old machines
   degrades to honest refusals (`AGENT_FACADE_ABSENT` from the composite
   bridge is absent too on a fully old machine, where unknown `/v1/agent/*`
   paths hit the mission bridge and 404 as `BRIDGE_ROUTE_NOT_FOUND`,
   `server.js:508` — the binding maps both to "this computer's app needs an
   update", named, not mysterious).
7. Phase 2 push events repeat 1→6 as a second, smaller pass — the frame type
   is deploy-order-safe (§0.6), so it may also ride the first pass if the
   owner prefers one cut.

Nothing here touches `config/payload-boundary.json`; the facade and relay
supervisor are shell modules and engine payload modules within the existing
boundary. If packing rules disagree during implementation, that is a stop-and-
ask, not a workaround.

---

## 10. Test strategy

Doctrine applied: every gate mutation-tested; absence fails closed; contract
tests pin each seam so drift turns into a red test, not a silent downgrade
(the `relayOrigin:` incident recorded in `host-bridge.js` is the cautionary
example).

**Facade gate tests (app repo)**
- No bearer → 401; wrong bearer → 401; any `Origin` header → 403; each
  proven by *removing the check in a mutated copy and watching the test
  fail* (the mutation harness pattern).
- Remote-drive switch off → every write route refuses
  `MC_AGENT_PRINCIPAL_READ_ONLY`, reads still answer. Mutation: skip the
  switch → fail.
- Path fields never cross: a test walks every route's response against a
  recorded machine state whose org/profile/history records contain absolute
  paths and asserts no value matches a path shape (the BLOCKER-2 rule as a
  test); pins the `overlayFile` drop.

**Parity test (app repo)** — the anti-drift gate: reads the preload's
`mcAgent`/`mcOrg` method lists and asserts every method is either (a) mapped
to a facade route in the route table module, or (b) present in a frozen
`REMOTE_OMITTED` set with a stated reason (`pickAttachment`, `pickMention`,
`profileCreate`). A method added to the preload without a facade decision
fails the build. (Same species as the provider-cli-presence absence test.)

**Command-surface extraction test (app repo)**: the IPC handlers and facade
dispatch the same function per command — asserted structurally (both tables
reference the identical function objects), so the extraction cannot half-happen.

**Idempotency (app repo)**: two `POST /v1/agent/start` with one
`x-request-id` → one spawn-record entry, second answer flagged `replayed`.
Mutation: disable the LRU → two entries → fail. Same for `send` around a
completed turn.

**Ownership (app repo)**: web principal cannot `send` to a window-owned
session (`MC_AGENT_UNKNOWN_SESSION`); relay connection drop does **not** end
remote sessions (assert the destroyed-hook absence behaviourally: drop, then
`interrupt` still resolves).

**Event buffer (app repo)**: cursor monotonic; overflow sets `dropped:true`
for a stale `after`; every response under the 96 KB bound with adversarially
large events; long-poll returns on event arrival and on `waitMs` expiry.

**Tunnel contract (engine repo)**: two relay shells + fake edge on loopback +
fake bridges — the provable-end-to-end setup the relay shell's header
promises — extended with a fake facade: `t:'req'` with `budgetMs` honoured
and clamped; `t:'evt'` delivered browser-side in order; unknown `t` ignored
by an *old* client copy (compatibility pin); `x-request-id` forwarded both
ways (pin the two header allowlists — idempotency and replay marking depend
on them).

**Options/vendor contract (website repo)**: extend
`relay-options-contract.test.mjs` to pin `timeoutMs` acceptance against the
re-vendored client (a rename → red test, not a silent 60s); existing
`check-vendored-provenance`/`freshness` gates pin the §9 ordering — a website
build vendoring unpublished bytes fails.

**End-to-end proof (before [OWNER YES] on step 6)**: one real machine, one
real browser profile on another computer, through the staging relay: start,
watch events stream, interrupt, close; kill the machine's network mid-turn
and watch the browser tell the truth; retry a timed-out start and count
exactly one session.

---

## 11. Owner decision points (collected)

1. **Default for "this computer may be driven from the web"** — off until
   flipped at the machine, or granted as part of pairing consent (§5.2).
   Mechanism identical either way.
2. **Resident app** — may the app keep the relay (and agents) alive with the
   window closed (tray mode), and is that a setting or the default (§7.3)?
   Without it, "agents running at home" means "the window is open at home".
3. **Cross-principal drive** — may the web drive sessions started at the
   keyboard (and vice versa)? Recommended v1: no (structural ownership kept);
   the widening is one deliberate line later, with its own review (§5.1).
4. **Remote workspace browse** — whether a bounded workspace-scoped file
   picker over the tunnel should ever exist (§4.3). Recommended: not until a
   consent story exists.
5. **Enrolment surface** — the in-app "connect this computer" flow (§0.8) is
   prerequisite work for Bob's scenario without hand-run tools; it is its own
   design, not smuggled in here.

---

## 12. WHAT COULD GO WRONG

- **An unsealed caller reaches the facade.** Remote: impossible by
  construction — only `open()`-verified frames reach `serve()`, only the
  relay child holds the facade bearer. Local: a same-user process is inside
  the product's recorded trust boundary and always has been (it can read the
  mission-bridge bearer today); the facade adds no *new* local exposure and
  removes the discovery surface (§5.1). The residual risk is the OS user
  boundary itself — stated, not solved, because loopback cannot solve it.
- **Stale lease / mid-command reconnect.** Leases live 10 min (max 15,
  `relay-leases.js:30–31`); the child reconnects 30s before expiry, the
  browser reconnects on close. In-flight requests reject
  (`WEB_CLIENT_CLOSED` / `RELAY_SHELL_CLOSED` — both ends drain their
  pending maps) → binding surfaces "reconnecting to your machine", retries
  only idempotently (§5.3). The event cursor survives reconnects
  (facade-side buffer), so a clean reconnect loses nothing; only buffer
  overflow loses events, and then `dropped:true` forces an honest resync.
- **Machine offline mid-command.** A `start` may have spawned before the
  socket died — the answer is on the machine and the browser never saw it.
  The retry with the same `sessionId` resolves the ambiguity:
  `MC_AGENT_SESSION_EXISTS` (or the LRU replay) means the first press won;
  a fresh spawn means it did not. Either way exactly one session, and the
  spawn ledger holds exactly one `started` record. The residual: a machine
  that dies *before recording* answers nothing, and the browser must say
  "unknown — reconnect to see", never "failed".
- **Duplicate command on retry.** §5.3: `x-request-id` LRU + `SESSION_EXISTS`
  + `AGENT_TURN_ACTIVE` + `expectedRevision`. The known dispatch
  double-spawn failure mode is the one this closes; the test that counts
  spawn records is the gate.
- **The 30s machine-side abort masquerading as machine failure** (§0.2) —
  until §6.3 lands whole, long actions over the tunnel die at 30s with
  `TUNNEL_BRIDGE_UNAVAILABLE`-flavoured errors. The fix is sequenced; the
  interim truth belongs in the binding's error copy ("this action is longer
  than the current web connection allows"), not in a raised blind ceiling.
- **Frame-size overflow.** 128 KB tunnel cap; an unbounded `history` or org
  export would come back `TUNNEL_RESPONSE_TOO_LARGE` and read as a mystery
  refusal. §6.4's self-capping + cursors is the rule; the size-bound test is
  the gate.
- **Event gap = silently wrong transcript.** The failure that lies: a missed
  `turn_completed` leaves the web showing "working" forever. Mitigations:
  generous ring, `dropped` honesty, and the poll answering current `seq`
  even when empty (so silence is distinguishable from disconnection);
  `remote-status` gives an independent liveness read.
- **Relay child flaps.** Supervisor backoff (2s→60s) + status surface; a
  flap is visible as "reachable: no — reconnecting", never a busy loop
  (child owns backoff; shell only respawns on exit, with its own floor).
- **Web session record expiry.** `web-peer` answers only while the browser's
  lease-registered record is unexpired (`device-registry.js webSessionFor`);
  a long-idle tab reconnects with a fresh lease + fresh keys — by design a
  new e2e session. The binding must treat that as routine (silent
  re-handshake), not an error.
- **A second browser tab / second machine of the pair.** One web session
  record per pair (`recordWebSession` replaces): the newest tab wins and the
  older one's session dies at its next reconnect — surfaced as "another tab
  took over", which is the true statement. The peer machine's leg is
  untouched (separate sessions per leg by design).
- **Facade drift from IPC.** The parity + shared-surface tests (§10) exist
  precisely because 31 methods maintained twice is 31 chances for the web to
  quietly disagree with the desk.

---

## 13. Summary of net-new artifacts

| Where | New | Changed |
|---|---|---|
| ENGINE | composite local bridge; supervised relay entry; `t:'evt'`; `budgetMs` | `online-fra-relay-shell.js`, `online-fra-web-client.mjs`, `online-fra-local-bridge.js`, `tools/relay-shell.js` |
| APP | `shell/agent-facade.cjs`, `shell/agent-command-surface.cjs`, `shell/relay-link.cjs`, `mcRelay` preload surface, remote-drive settings row | `shell/main.cjs` (handler extraction + supervisor call), `src/relay-bridge-transport.js` (timeoutMs) |
| WEBSITE | `mcAgent`/`mcOrg` binding + `agentCall` in `host-bridge.js` | re-vendored `relay-web/*`, `vendored.json`, ceiling hack removed |
| ACCOUNT SERVER | — | — (verified sufficient as-is) |
