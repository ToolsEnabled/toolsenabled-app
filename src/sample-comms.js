/* THE EXAMPLE FLEET'S OWN MESSAGE BOARD, IN THE LIVE ENVELOPE'S SHAPE.
 *
 * The comms page is losing its separate simulated render: the live projection
 * becomes the only code path that draws the page, and when there is no real
 * host a mock source feeds it instead. That only works if the mock data is in
 * EXACTLY the shape the live reader consumes -- a demonstration envelope that
 * drifts from the real one is a render bug that appears only on machines with
 * no host attached, which is every fresh install, which is the worst possible
 * place for it. So this module produces the ops data record and nothing else;
 * it owns no rendering and no fallback logic.
 *
 * WHICH LAYER THIS IS. applyLiveProjection(result) receives
 * `{ ok, data: <carrier> }` where the carrier is the whole ops projection
 * document (schemaVersion, domain, generatedAt, ok, reason, sources, data) and
 * `carrier.data` is the part the page actually walks:
 * `{ declaredServices, channels, mcp, messages }`. This module returns THAT
 * layer -- the same one withLiveMessages synthesizes as its base envelope
 * (src/views/comms.js ~1589) and the one public/data/schema/ops.schema.json
 * names `$defs/data`. A caller wraps it in a carrier of its own; the wrapping
 * is one honest sentence about where the data came from and does not belong to
 * the data.
 *
 * COPIED LITERALS, NOT AN IMPORT. The channel ids, names and every line of
 * prose below are lifted verbatim from src/fleet-profile.js (SAMPLE_CHANNELS,
 * SAMPLE_BOARD, SAMPLE_CONVERSATIONS) so the two demonstrations tell one
 * story. They are copied rather than imported because fleet-profile.js
 * resolves the whole fleet profile at module evaluation -- storage reads, a
 * preload bootstrap, a validator -- and none of that machinery belongs in a
 * module whose one job is a deterministic literal. The individual sample
 * tables are not exported anyway; only the assembled profile is.
 *
 * SUBSTITUTION, NOT SUPPRESSION -- same rule as sample-activity.js. Nothing
 * here is anybody's data: every channel is a `sample/…` key, every sender is a
 * placeholder from the shipped sample fleet, and the pinned first message says
 * in words that the board is a demonstration.
 *
 * DETERMINISTIC ON PURPOSE. No Math.random and no persisted state: the same
 * nowMs produces the same envelope, byte for byte. A demonstration that
 * reshuffles itself on every 4-second live poll reads as broken, and it makes
 * one screenshot impossible to compare against the next.
 */

const H = 3_600_000
const iso = (ms) => new Date(ms).toISOString()

/* Channels seen running, reusing the sample board's ids and names so the rail
 * on this page and the board page agree about what the example fleet is. The
 * `state` values are the schema's own enum (ops.schema.json $defs/channel:
 * healthy | stale | conflict | unknown | unavailable), and the mix is
 * deliberate: mostly healthy because that is the ordinary case, one stale and
 * one unknown because those are states the real reader produces and the page
 * must keep rendering them distinguishably. `agoMin` is minutes back from
 * nowMs for the channel's own observation stamp; null means never observed,
 * which is what `unknown` honestly is. */
const SAMPLE_CHANNELS = Object.freeze([
  { id: 'notices', name: 'notices', state: 'healthy', agoMin: 4,
    detail: 'sample board — demonstration traffic, not a live fleet' },
  { id: 'assignments', name: 'assignments', state: 'healthy', agoMin: 6,
    detail: 'sample assignments — newest revision wins' },
  { id: 'status', name: 'status', state: 'healthy', agoMin: 3,
    detail: 'sample status packets — claims, phases, checkpoints, heartbeats' },
  { id: 'blockers', name: 'blockers', state: 'stale', agoMin: 26.2 * 60,
    detail: 'sample stop-the-line notices' },
  /* Left message-less on purpose: the page has a real sentence for a channel
     with nothing seen on it, and the demonstration should exercise it. */
  { id: 'questions', name: 'questions', state: 'unknown', agoMin: null,
    detail: 'sample questions — not observed in this demonstration' },
])

/* Services on record. There is no sample equivalent of these today, so they
 * are authored here, small and unmistakably the example fleet's: the two
 * transports the sample profile itself declares (relay and the tool lane),
 * wearing `sample-` ids. The schema requires a concrete port where the sample
 * profile deliberately configures none, so the ports come from the ephemeral
 * range (49152-65535) -- numbers that read as nobody's standing
 * infrastructure, the same reasoning that keeps the sample hosts on RFC 5737
 * addresses. */
const SAMPLE_SERVICES = Object.freeze([
  { id: 'sample-relay', displayName: 'sample relay', transport: 'relay', port: 61411, resolution: 'loopback' },
  { id: 'sample-tool-lane', displayName: 'sample tool lane', transport: 'tools', port: 61412, resolution: 'self' },
])

/* Tool links. The page renders only the two counts, but the names still keep
 * to the demonstration's own world (board, sweeps, probes) in case a later
 * surface lists them: a couple live because that is the ordinary case, one
 * dead because an all-green demonstration teaches the reader that the dead
 * count is decoration. */
const SAMPLE_MCP = Object.freeze({
  live: Object.freeze(['sample-board', 'sample-gate-sweep']),
  dead: Object.freeze(['sample-relay-probe']),
})

/* The board's traffic, verbatim from the sample profile's prose -- the pinned
 * honesty notice, the assignment round, the cross-host sync exchange between
 * controller and codexb (SAMPLE_CONVERSATIONS' fleet-sync lines), and one
 * blocker with its clearance. `agoH` is hours back from nowMs, all distinct,
 * listed OLDEST FIRST because that is the order the envelope must carry:
 * applyLiveProjection's messageRows keeps envelope order (no sort on the live
 * path -- the only .sort in comms.js seeds the non-live board), renderLog
 * appends in that order and pins the scroll to the bottom
 * (`logEl.scrollTop = logEl.scrollHeight`), so the newest message must be LAST
 * or the pinned view shows the oldest line as the latest word. */
const SAMPLE_MESSAGES = Object.freeze([
  { channel: 'notices', agoH: 30, s: 'assistant',
    t: 'This board is sample data shipped with the app. Nothing here was sent by anyone. Connect a fleet host, or load a saved profile, to see real traffic in its place.' },
  { channel: 'assignments', agoH: 28.7, s: 'controller',
    t: 'sample assignment: the checks lane is the priority this round. Cosmetic work waits until the gates read green.' },
  { channel: 'assignments', agoH: 28.5, s: 'codexb',
    t: 'ack on the second host; two seats claimed.' },
  { channel: 'blockers', agoH: 26.5, s: 'luna',
    t: 'Blocker: a stale lease is holding the queue lock — the heartbeat is 40 minutes old. Sweeping it before the claim.' },
  { channel: 'blockers', agoH: 26.2, s: 'luna',
    t: 'cleared — lease swept, lock released, eight minutes lost.' },
  { channel: 'status', agoH: 26.0, s: 'controller',
    t: 'assignments are mirrored to both hosts; fan your lanes out after the ack.' },
  { channel: 'status', agoH: 25.7, s: 'codexb',
    t: 'ack — the revision matches here. Four seats claimed, territories named.' },
  { channel: 'status', agoH: 15.8, s: 'luna',
    t: 'lease heartbeat fresh; phase 3 of 4 underway.' },
  { channel: 'status', agoH: 7.9, s: 'controller',
    t: 'the gate sweep is clean here: 9 of 9 re-verified, no disputes.' },
  { channel: 'status', agoH: 7.6, s: 'codexb',
    t: 'checks came back clean: no colliding sessions, no stale claims.' },
  { channel: 'assignments', agoH: 3.1, s: 'controller',
    t: 'sample assignment: fix rounds address the rejected item only. A wider diff reopens the whole review.' },
  { channel: 'notices', agoH: 2.4, s: 'controller',
    t: 'sample notice: everything on this page can be replaced by loading your own profile. The sample stays available as the demonstration.' },
])

/**
 * The example fleet's comms record, in exactly the shape
 * `applyLiveProjection` walks as `carrier.data` -- the `$defs/data` layer of
 * public/data/schema/ops.schema.json. Same nowMs, same envelope.
 */
export function sampleOpsEnvelope(nowMs = Date.now()) {
  const messageIndexByChannel = {}
  const messages = SAMPLE_MESSAGES.map((entry) => {
    const n = (messageIndexByChannel[entry.channel] = (messageIndexByChannel[entry.channel] || 0) + 1)
    return {
      /* Stable per-channel ids in the sample namespace, so a message can be
         named in a bug report and found again on the next render. */
      id: `sample/${entry.channel}/${String(n).padStart(2, '0')}`,
      channelId: entry.channel,
      sender: entry.s,
      at: iso(nowMs - entry.agoH * H),
      text: entry.t,
      /* The schema pins these two on every message, and they are the point:
         board text is somebody's words, never an instruction to the app, and
         a demonstration must model that exactly as strictly as the live
         reader does. */
      contentTrust: 'untrusted',
      grantsAuthority: false,
    }
  })

  return {
    declaredServices: SAMPLE_SERVICES.map((service) => ({ ...service })),
    channels: {
      ok: true,
      reason: null,
      /* Observation stamps trail nowMs slightly, the way a real reader's
         stamps trail the render moment. All of them derive from nowMs and
         nothing else, so the whole envelope is a pure function of its one
         argument. */
      observedAt: iso(nowMs - 45_000),
      value: SAMPLE_CHANNELS.map(({ agoMin, ...channel }) => ({
        ...channel,
        observedAt: agoMin == null ? null : iso(nowMs - agoMin * 60_000),
      })),
    },
    mcp: {
      ok: true,
      reason: null,
      observedAt: iso(nowMs - 90_000),
      value: { live: [...SAMPLE_MCP.live], dead: [...SAMPLE_MCP.dead] },
    },
    messages: {
      ok: true,
      reason: null,
      observedAt: iso(nowMs - 30_000),
      value: messages,
    },
  }
}

// The channels workspace demonstrates the same routed records as the live
// journal, including replies and an explicitly unconfirmed inbox write.
export function sampleCommsJournal(nowMs = Date.now()) {
  const actors = { Controller: 'sample-controller', Manager: 'sample-manager', Builder: 'sample-builder', Reviewer: 'sample-reviewer' }
  const lines = [
    ['Controller', 'Manager', 49, 'ask', 'Please coordinate the export update. The acceptance criteria are readable tables, correct totals, and a clean PDF.', null],
    ['Manager', 'Builder', 46, 'ask', 'Update the export layout and check how long account names wrap. Send the result here when it is ready for review.', null],
    ['Builder', 'Manager', 40, 'notice', 'The table layout is updated. I found one edge case: the last row can move onto a new page when a note is long.', null],
    ['Manager', 'Reviewer', 36, 'ask', 'Please review the export changes, including long notes and empty sections. Builder is checking the page break.', null],
    ['Reviewer', 'Manager', 28, 'notice', 'The totals and labels match the source records. I am checking the remaining layout cases now.', null],
    ['Builder', 'Manager', 22, 'answer', 'The page break is fixed. Long account names now wrap without covering the amount column. The export is ready for review.', 1],
    ['Reviewer', 'Manager', 17, 'answer', 'Review complete. The PDF preserves all rows, the totals match, and the empty sections read clearly. No further changes needed.', 3],
    ['Manager', 'Controller', 12, 'answer', 'The export update is complete and reviewed.\n\n- Long names wrap within their column.\n- Notes stay with the correct row.\n- Totals match the source data.\n- Empty sections have a clear explanation.\n\nThe updated PDF is ready for your review.', 0],
    ['Controller', 'Manager', 7, 'notice', 'Thanks. Keep the reviewed export available and move on to the next open task.', null],
    ['Manager', 'Builder', 3, 'notice', 'Next, check the compact layout at a smaller window size. Keep the same typography and colors.', null],
  ]
  return {
    channels: { ok: true, value: [] },
    messages: { ok: true, value: lines.map(([sender, recipient, minutes, kind, text, parent], index) => ({
      id: `sample/exchange/${index}`, sender, recipient, senderId: actors[sender], recipientId: actors[recipient],
      at: iso(nowMs - minutes * 60000), sequence: index + 1, kind, text,
      causalParent: parent === null ? null : `sample/exchange/${parent}`,
      deliveryState: index === 9 ? 'unconfirmed' : 'available', contentTrust: 'untrusted', grantsAuthority: false,
    })) },
  }
}
