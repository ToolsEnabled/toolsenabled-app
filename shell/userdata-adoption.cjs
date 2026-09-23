'use strict'

/* WHAT HAPPENS TO A PERSON'S DATA WHEN THE PRODUCT IS RENAMED.
 *
 * Electron derives userData from productName: <appData>/<productName>. The
 * product was called "Mission Control" and is now called "ToolsEnabled", so
 * every existing installation's data sits in %APPDATA%\Mission Control and
 * every new build reads %APPDATA%\ToolsEnabled, which is empty. Nothing errors.
 * The app opens on defaults, and the only available conclusion is that the
 * software threw the person's settings away.
 *
 * THIS IS THE SAME DEFECT AS THE PORT ONE, ONE LEVEL UP. shell/renderer-prefs.cjs
 * exists because settings were keyed to http://127.0.0.1:<port> and a changed
 * port read as a new user. This file exists because settings are keyed to a
 * directory named after the product and a changed name reads as a new user.
 * Both are the house's recurring defect: an ABSENCE -- an empty storage
 * partition, a missing directory -- taken as a statement that there is nothing
 * to keep, when it is really a statement that we are looking in the wrong
 * place. The fix in both cases is the same shape: before concluding "new user",
 * look where the data would be if this were an upgrade.
 *
 * IT RUNS BEFORE ANYTHING READS userData. shell/main.cjs resolves
 * FLEET_PROFILE_FILE, CRASH_DUMP_DIR, WORKSPACE_ROOT and the renderer-prefs
 * store at module scope, so the adoption has to happen above all of them or it
 * would be adopting into a directory the app has already begun writing.
 *
 * IT DECIDES EXACTLY ONCE, AND A DAMAGED RECORD MEANS "DECIDED".
 * The record file below is written before the copy starts, not after. If it is
 * present and unreadable we do NOT adopt: an unparseable record still proves a
 * previous run reached a decision, and re-running the copy could resurrect data
 * the person deliberately deleted. Treating a damaged record as "no record" is
 * exactly the absence-as-consent mistake this file exists to correct, so it is
 * refused here too.
 *
 * WITH ONE EXCEPTION, AND IT IS THE SAME DEFECT ONE LEVEL UP AGAIN.
 * "I adopted" and "somebody is already using this install" are both POSITIVE
 * findings, and recording either once and forever is right. "There was no prior
 * install" is a NEGATIVE one: it says we looked and saw nothing. Writing that
 * down as a permanent decision converts an absence into consent, and it is not
 * hypothetical -- MEASURED on the build machine, 2026-08-11:
 *
 *     %APPDATA%\ToolsEnabled\.userdata-adoption.json
 *       { "status": "complete", "adopted": false, "reason": "NO_PRIOR_INSTALL" }
 *     %APPDATA%\Mission Control\shell-state.json          73 bytes
 *     %APPDATA%\Mission Control\agent-spawn-key.enc      150 bytes
 *     %APPDATA%\Mission Control\agent-spawn-records.jsonl 2584 bytes
 *
 * Run against those exact directories the current module answers ADOPTED, so
 * the verdict on disk disagrees with the code that wrote it -- and because the
 * verdict is honoured, no future version can ever correct it. A person in that
 * state has their previous install sitting beside the new one, permanently
 * unreachable, and nothing tells them.
 *
 * THE RECORD THEREFORE CARRIES ITS EVIDENCE. A negative verdict now names every
 * directory it examined and what it saw there. A later launch honours it only
 * while that evidence still holds; a candidate that has since gained product
 * state, one the record never examined, or a record that states no evidence at
 * all -- every build before this one -- reopens the question exactly once and
 * then writes an evidenced verdict of its own. Absence of evidence is not
 * evidence of absence, which is the whole of the house defect in one line.
 *
 * REOPENING SKIPS THE "ALREADY IN USE" SHORTCUT, DELIBERATELY. A person whose
 * data was stranded by a wrong verdict has since been USING the new install, so
 * that shortcut is exactly what would keep them stranded. The copy below never
 * overwrites, so their current data still wins file by file; what they can get
 * back is only what the new install does not already have.
 *
 * IT NEVER OVERWRITES. Only entries missing from the new userData are copied,
 * which is what makes a resumed adoption safe after a crash mid-copy, and what
 * guarantees a directory that already holds real state is left alone.
 *
 * IT IS NOT A SECURITY BOUNDARY CHANGE. Everything copied is the same user's
 * own data, moving between two directories that user already owns, on one
 * machine. No wider read access is created: a process that can read the
 * destination could already read the source.
 *
 * THE SENTENCE THAT USED TO STAND HERE WAS FALSE, AND IT COST A CUSTOMER THE
 * PRODUCT. It read: "agent-spawn-key.enc travels with the records it decrypts
 * because safeStorage is scoped to the Windows USER rather than to a PATH". That
 * is true of raw DPAPI. It is NOT true of what Electron actually uses on
 * Windows. MEASURED on the build machine against the two real directories:
 *
 *   %APPDATA%\Mission Control\agent-spawn-key.enc  first bytes: "v10"
 *   %APPDATA%\ToolsEnabled\agent-spawn-key.enc     first bytes: "v10"
 *
 * "v10" is Chromium OSCrypt: AES-256-GCM under a key that is NOT the OS user's,
 * but a per-profile random key kept in <userData>\Local State (os_crypt.
 * encrypted_key, itself DPAPI-wrapped). Those two Local State files hold
 * DIFFERENT keys, and the cross-decrypt matrix is total:
 *
 *   blob=Mission Control  key=Mission Control -> OK (119-byte PKCS8 PEM)
 *   blob=Mission Control  key=ToolsEnabled    -> FAIL (unable to authenticate data)
 *   blob=ToolsEnabled     key=Mission Control -> FAIL (unable to authenticate data)
 *   blob=ToolsEnabled     key=ToolsEnabled    -> OK (119-byte PKCS8 PEM)
 *
 * So this module copied the CIPHERTEXT into a directory whose key cannot open
 * it, and Local State is (correctly) excluded above as a Chromium file. The
 * result was not a degraded feature. shell/spawn-record.cjs loadOrCreateKey()
 * finds a key file, fails to decrypt it, and raises SPAWN_RECORD_KEY_UNREADABLE
 * -- and it deliberately REFUSES to regenerate, because replacing a key would
 * orphan the signatures of records that already exist. That refusal is right for
 * a key that belongs to this install. Applied to a key this install could never
 * open, it disabled Start PERMANENTLY, on every launch, at every tier, with the
 * only explanation being "the key that signs the record of what runs here cannot
 * be opened". A clean A/B confirmed it: with the legacy directory absent, a fresh
 * key is created and a session runs.
 *
 * SO NOTHING SEALED BY THE KEYSTORE IS ADOPTED UNTIL IT IS PROVEN TO OPEN.
 * The caller injects canDecrypt(); this module asks it before copying, and the
 * ABSENCE of an answer is refusal, not permission -- an unchecked blob is
 * exactly the "absence read as consent" this file exists to correct, and it is
 * the shape that produced the defect above. A refused key takes its ledger with
 * it: records signed by a key nothing can load would be re-signed by the fresh
 * key and then fail their own verification, so the product would greet its owner
 * by accusing itself of tampering. Neither file is deleted or moved -- the source
 * directory is untouched -- and the refusal is written into the record below with
 * the path, so the history is findable rather than silently dropped.
 */

const RECORD_FILE = '.userdata-adoption.json'
/* 2 records the evidence behind a negative verdict; 1 stated the verdict alone.
   The number is not read as a gate -- a version-1 record simply has no evidence
   to check, which is the case the reopen rule below already covers. */
const RECORD_VERSION = 2

const STATE_ROOT_ENV = 'TOOLSENABLED_STATE_ROOT'

/* THE RENAME AS A DECLARED PREDECESSOR/SUCCESSOR PAIR.

   The predecessor name is history owned by ONE successor. It is not a default
   path for every build containing this module. A lifecycle build can package
   these same bytes under another productName; unless the running identity is
   the declared successor below, it claims no predecessor and performs no file
   operation. This is the application half of the identical fence in
   build/installer.nsh. */
const LEGACY_SUCCESSOR_NAME = 'ToolsEnabled'
const LEGACY_USER_DATA_NAMES = Object.freeze(['Mission Control'])

/* Resolve the running identity from the state root the Electron shell publishes
   from app.getPath('userData'). This does not parse an executable or read a
   package name: it consumes Electron's answer. Unknown identity and a known
   non-successor are deliberately distinct. The former means we could not look;
   the latter means we looked and this build owns no declared predecessor. */
function resolveLegacyUserDataNames({ env = process.env, path = require('node:path') } = {}) {
  const rawStateRoot = env && typeof env[STATE_ROOT_ENV] === 'string'
    ? env[STATE_ROOT_ENV].trim()
    : ''
  if (!rawStateRoot) {
    return {
      status: 'unknown',
      productName: null,
      legacyNames: [],
      reason: 'PRODUCT_IDENTITY_UNAVAILABLE',
      detail: `The running product identity is unavailable because ${STATE_ROOT_ENV} is not set.`,
    }
  }
  if (!path.isAbsolute(rawStateRoot)) {
    return {
      status: 'unknown',
      productName: null,
      legacyNames: [],
      reason: 'PRODUCT_IDENTITY_UNAVAILABLE',
      detail: `The running product identity is unavailable because ${STATE_ROOT_ENV} is not an absolute path.`,
    }
  }

  const userDataPath = path.dirname(path.resolve(rawStateRoot))
  const productName = path.basename(userDataPath)
  if (!productName || userDataPath === path.parse(userDataPath).root) {
    return {
      status: 'unknown',
      productName: null,
      legacyNames: [],
      reason: 'PRODUCT_IDENTITY_UNAVAILABLE',
      detail: `The running product identity cannot be derived from ${STATE_ROOT_ENV}.`,
    }
  }
  if (productName !== LEGACY_SUCCESSOR_NAME) {
    return {
      status: 'known',
      productName,
      legacyNames: [],
      reason: 'NO_DECLARED_LEGACY_SUCCESSION',
      detail: `The running product "${productName}" is not the declared successor "${LEGACY_SUCCESSOR_NAME}".`,
    }
  }
  return {
    status: 'known',
    productName,
    legacyNames: LEGACY_USER_DATA_NAMES,
    reason: 'DECLARED_LEGACY_SUCCESSION',
    detail: `The running product "${productName}" owns its declared predecessor userData names.`,
  }
}

/* The product's own state. These are the files whose absence means "this
   person has never run this build", and whose presence in a prior install is
   the thing worth carrying over. Chromium's own files (Cache, Preferences,
   Local State, Network, GPUCache...) are deliberately NOT here: they are
   regenerated on launch, they are the reason a fresh userData is never truly
   empty, and copying a browser's internal state across installations is how
   migrations corrupt profiles. */
const PRODUCT_STATE_ENTRIES = Object.freeze([
  'renderer-prefs.json',
  'research-workspace.json',
  'image-retention',
  // T369: the fleet documents live beside the settings record in their own file.
  'renderer-fleet-documents.json',
  'shell-state.json',
  'fleet-profile.json',
  'agent-spawn-key.enc',
  'agent-spawn-records.jsonl',
  // Owner-confirmed accessibility actions are history, not regenerated cache.
  'accessibility-actions.jsonl',
  'screen-control-actions.jsonl',
  /* What each turn cost, in its own chain beside the run record and signed with
     the SAME key -- which is why it is in the bound list below as well as this
     one. It is separate from the runs because history() reads a bounded window
     and per-turn records would crowd the runs out of it; it is carried for the
     same reason the runs are, and for one sharper one: this is the only place a
     person's own token history exists, and every panel on the metrics page that
     says anything about tokens is reading it. */
  'agent-turn-usage-records.jsonl',
  /* The bounded provider-usage snapshot shown beside the account switcher.
     It is derived, but losing it on a rename makes every allowance read as
     unknown until each provider can be queried again, so it travels with the
     rest of the product-owned userData state. */
  'accounts-usage-cache.json',
  // Locally pasted files belong to saved conversations, not to a cache.
  'paste-attachments',
  // Keep the bounded diagnostic history when the product identity changes.
  'main-heap.log',
  'workspace',
  /* The operator's own purchase list. It is the newest resident of userData and
     it is exactly the kind of file this defect strands: a document the PERSON
     put there, which the product only shows when it is present, so losing it
     removes a surface rather than resetting a setting. Derived by sweeping every
     getPath('userData') in shell/ rather than by listing the ones already known
     -- the point of this file is that a missed name is invisible until a
     customer loses it. Inert until that lane lands the file; the copy skips
     entries that do not exist. */
  'purchase-catalog.json',
  /* The person's own session profiles -- names and folders they picked through
     the OS dialog (iteration 5, W6). Losing this on an upgrade silently sends
     every "different work stays apart" tree back to the shared workspace,
     which is the exact pain profiles exist to end. */
  'session-profiles.json',
  /* The capability layer's own state root, <userData>/capability: state/ (the
     signed audit ledger and the mission bridge's per-boot records), logs/,
     vault/ (the person's credentials), captures/, profiles/, reports/. It moved
     here from the INSTALL directory, where an update would have deleted it --
     see shell/main.cjs CAPABILITY_STATE_ROOT. Listed for the same reason every
     other name here is: the next rename must carry it, and a missed name is
     invisible until a customer loses the thing it named. */
  'capability',
  /* The person's answer to "what happens to my data when I uninstall", written
     by shell/uninstall-retention.cjs as the one token build/installer.nsh can
     read. It carries across a rename for the same reason everything else here
     does, and for one sharper one: this file is the only place that answer
     exists in a form the uninstaller sees, and the resolution treats its
     absence as "never asked". Dropping it in a migration would therefore not
     lose a setting quietly -- it would silently convert a recorded
     "remove everything" back into an unanswered question, so a person who had
     already decided would be asked again, or on a silent uninstall would have
     their data kept after asking for it to be removed. */
  'uninstall-data-policy.txt',
])

/* Chromium's localStorage partition. It is best-effort rather than required,
   and it is here for one specific population: an install predating
   shell/renderer-prefs.cjs kept EVERY setting the person chose in this
   LevelDB, so skipping it would migrate almost nothing for exactly the users
   who have the most to lose. It is best-effort because it is the one entry
   another process may hold open, and a failed copy of a browser cache must not
   cost the person their workspace. */
const BEST_EFFORT_ENTRIES = Object.freeze(['Local Storage'])

/* THE ENTRY THAT IS CIPHERTEXT, AND THE ENTRIES THAT ARE WORTHLESS WITHOUT IT.
   Sealed by the OS keystore, so whether it survives the move is a question only
   the keystore can answer -- see the header. The bound list is not "related
   files": it is every file whose meaning DEPENDS on that key, and adopting one
   of those without the key is strictly worse than adopting neither, because the
   fresh key would sign new records onto a chain whose existing signatures can no
   longer be checked. */
const KEYSTORE_SEALED_ENTRY = 'agent-spawn-key.enc'
const ENTRIES_BOUND_TO_SEALED_KEY = Object.freeze(['agent-spawn-records.jsonl', 'agent-turn-usage-records.jsonl'])

/* Stable codes, so the record is machine-readable and a support answer is not
   prose archaeology. NOT_CHECKABLE is deliberately distinct from REFUSED: "the
   keystore said no" and "nobody asked the keystore" are different facts about
   the person's data, and collapsing them would hide a wiring mistake behind a
   sentence about encryption. */
const SEALED_KEY_NOT_ADOPTED = 'SEALED_KEY_NOT_ADOPTED'
const SEALED_KEY_VERDICTS = Object.freeze({
  DECRYPTABLE: 'DECRYPTABLE',
  NOT_PRESENT: 'NOT_PRESENT',
  UNREADABLE: 'UNREADABLE',
  NOT_CHECKABLE: 'NOT_CHECKABLE',
  REFUSED: 'REFUSED',
})

/* CAN THIS INSTALL ACTUALLY OPEN THE PRIOR INSTALL'S SIGNING KEY?
 *
 * Asked of the BYTES, by the only component that can answer -- the keystore, via
 * the injected canDecrypt. Every non-answer is a refusal:
 *
 *   - no validator injected      -> NOT_CHECKABLE. A caller that forgot to wire
 *                                   the keystore must not thereby be granted the
 *                                   adoption that the wiring exists to gate.
 *   - the validator threw        -> REFUSED. safeStorage raises rather than
 *                                   returning false when a blob does not
 *                                   authenticate, which is the ACTUAL production
 *                                   path for this defect.
 *   - anything but boolean true  -> REFUSED. Strict, because `undefined` from a
 *                                   validator that forgot to return is the same
 *                                   silence this module refuses everywhere else.
 */
function sealedKeyVerdict({ source, fs, path, canDecrypt }) {
  let bytes
  try {
    bytes = fs.readFileSync(path.join(source, KEYSTORE_SEALED_ENTRY))
  } catch (error) {
    return error && error.code === 'ENOENT'
      ? SEALED_KEY_VERDICTS.NOT_PRESENT
      : SEALED_KEY_VERDICTS.UNREADABLE
  }
  if (typeof canDecrypt !== 'function') return SEALED_KEY_VERDICTS.NOT_CHECKABLE
  try {
    return canDecrypt(bytes) === true ? SEALED_KEY_VERDICTS.DECRYPTABLE : SEALED_KEY_VERDICTS.REFUSED
  } catch {
    return SEALED_KEY_VERDICTS.REFUSED
  }
}

function samePath(a, b, path) {
  const normalize = (value) => {
    const normalized = path.resolve(String(value))
    /* Windows paths are case-insensitive; adopting a directory into itself
       would otherwise be reachable by casing alone. POSIX paths are
       case-sensitive, so folding their case would incorrectly merge two real
       sibling directories and strand the predecessor's data. */
    return path.sep === '\\' ? normalized.toLowerCase() : normalized
  }
  return normalize(a) === normalize(b)
}

function holdsProductState({ directory, fs, path }) {
  return PRODUCT_STATE_ENTRIES.some((entry) => {
    const target = path.join(directory, entry)
    try {
      const stat = fs.statSync(target)
      /* An empty workspace/ is what a first launch creates, so it is not
         evidence that anybody has used this install. */
      if (stat.isDirectory()) return fs.readdirSync(target).length > 0
      return stat.size > 0
    } catch {
      return false
    }
  })
}

/* WHAT WE SAW, WRITTEN DOWN BESIDE WHAT WE CONCLUDED. Directory names and one
   boolean each -- no contents, and nothing that is not already a path this
   process just resolved. */
function describeSearch({ candidates, fs, path }) {
  return candidates.map((directory) => ({
    directory,
    holdsProductState: holdsProductState({ directory, fs, path }),
  }))
}

/* IS A RECORDED "THERE WAS NOTHING TO ADOPT" STILL TRUE?
 *
 * Only asked of a completed NEGATIVE verdict. An adoption that happened, a
 * target that was already in use, and a damaged record are all left alone --
 * they are decisions about something that was observed to exist.
 *
 * Reopens on three shapes, and each of them is an absence that must not read as
 * a finding: a record that states no evidence (every build before this one, and
 * the one on the build machine that disagrees with its own code); a candidate
 * the record never examined (a legacy name added by a later rename); and a
 * candidate the record examined and found empty which now holds product state.
 * A record whose evidence still matches the disk is honoured, so the ordinary
 * fresh install pays one stat per legacy name per launch and nothing else. */
function negativeVerdictIsStale({ record, candidates, fs, path }) {
  if (!record || record.status !== 'complete') return false
  if (record.adopted !== false || record.reason !== 'NO_PRIOR_INSTALL') return false

  const searched = Array.isArray(record.searched) ? record.searched : null
  /* No evidence, or an evidence list that names nothing, is not a negative
     finding about anything. */
  if (!searched || searched.length === 0) return true

  return candidates.some((directory) => {
    const seen = searched.find((entry) => (
      entry
      && typeof entry === 'object'
      && typeof entry.directory === 'string'
      && samePath(entry.directory, directory, path)
    ))
    if (!seen) return true
    /* Strictly `!== false`: a missing or non-boolean field states nothing, and
       stating nothing must not count as "examined and empty". */
    if (seen.holdsProductState !== false) return true
    return holdsProductState({ directory, fs, path })
  })
}

function readRecord({ recordPath, fs }) {
  let raw
  try {
    raw = fs.readFileSync(recordPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { present: false, record: null }
    /* Present but unreadable. See the header: this is a decision, not an
       absence. */
    return { present: true, record: null }
  }
  try {
    const parsed = JSON.parse(raw)
    return { present: true, record: parsed && typeof parsed === 'object' ? parsed : null }
  } catch {
    return { present: true, record: null }
  }
}

function writeRecord({ recordPath, fs, payload }) {
  fs.writeFileSync(recordPath, `${JSON.stringify(payload, null, 2)}\n`)
}

function copyEntry({ from, to, fs }) {
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
}

/* Adopt a prior installation's userData into this one.
 *
 * Every path is injected so this is testable against real directories rather
 * than against a description of directories. Returns a plain record of what it
 * decided; it never throws for an ordinary miss, because a failed carry-over
 * must not stop the application from starting. */
function adoptLegacyUserData({
  userDataPath,
  /* The directory a previous installation's userData would be a sibling in.
     In production this IS appData -- Electron defines userData as
     <appData>/<productName>, so the caller passes dirname(userData) and gets
     exactly appData. It is expressed as "where userData lives" rather than
     "the OS roaming folder" for two reasons: it stays correct for someone who
     relocated their profile with --user-data-dir, where the fixed OS folder
     would be the wrong place to look; and it is what allows the packaged proof
     to exercise this against a temporary root instead of against the real
     %APPDATA%, so the test never has to read a person's actual data. */
  searchRoot,
  fs,
  path,
  /* THE KEYSTORE'S OWN ANSWER, INJECTED. (bytes) => boolean: true only if THIS
     install can actually open that ciphertext. Deliberately has NO default --
     see sealedKeyVerdict(): a missing validator refuses the sealed key rather
     than waving it through, so forgetting to wire this costs a person their old
     signed history and never costs them the Start control. */
  canDecrypt,
  /* Tests for copy semantics can state their candidate list directly. The
     production default is resolved from the Electron-published identity and
     never from the predecessor literal alone. */
  legacyNames,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  if (!userDataPath || !searchRoot) {
    return { adopted: false, reason: 'PATHS_NOT_RESOLVED', entries: [], failures: [] }
  }

  const legacyResolution = legacyNames === undefined
    ? resolveLegacyUserDataNames({ env, path })
    : {
        status: 'injected',
        productName: null,
        legacyNames,
        reason: 'LEGACY_NAMES_INJECTED',
        detail: 'The predecessor candidates were explicitly supplied by the caller.',
      }
  if (!Array.isArray(legacyResolution.legacyNames)) {
    return { adopted: false, reason: 'LEGACY_NAMES_INVALID', entries: [], failures: [], identity: legacyResolution }
  }
  /* FAIL CLOSED BEFORE THE FIRST FILESYSTEM CALL. A renamed build and a build
     whose identity could not be established both get an empty candidate list,
     but their named reasons remain different: known-no-claim is not unknown. */
  if (legacyResolution.legacyNames.length === 0) {
    return {
      adopted: false,
      reason: legacyResolution.reason,
      entries: [],
      failures: [],
      identity: legacyResolution,
    }
  }

  const recordPath = path.join(userDataPath, RECORD_FILE)
  const { present, record } = readRecord({ recordPath, fs })
  const legacyCandidates = legacyResolution.legacyNames.map((name) => path.join(searchRoot, name))

  let resumingFrom = null
  /* A negative verdict whose evidence no longer holds. See the header: this is
     the one decision this module is allowed to take a second look at. */
  let reopening = false
  if (present) {
    if (record && record.status === 'in-progress' && typeof record.from === 'string') {
      /* A previous attempt died mid-copy. Resume the SAME source only -- picking
         a different one now would mix two installations together. */
      resumingFrom = record.from
    } else if (negativeVerdictIsStale({ record, candidates: legacyCandidates, fs, path })) {
      reopening = true
    } else {
      /* Complete, or damaged. Either way a decision exists. */
      return { adopted: false, reason: 'ALREADY_DECIDED', entries: [], failures: [] }
    }
  }

  if (!resumingFrom && !reopening && holdsProductState({ directory: userDataPath, fs, path })) {
    /* Somebody has already used this install. Their data wins; record the
       decision so we never look again. */
    try {
      fs.mkdirSync(userDataPath, { recursive: true })
      writeRecord({
        recordPath,
        fs,
        payload: { version: RECORD_VERSION, status: 'complete', adopted: false, reason: 'TARGET_ALREADY_IN_USE', at: now() },
      })
    } catch { /* a record we could not write is not worth failing a launch for */ }
    return { adopted: false, reason: 'TARGET_ALREADY_IN_USE', entries: [], failures: [] }
  }

  const candidates = resumingFrom ? [resumingFrom] : legacyCandidates
  const source = candidates.find((candidate) => (
    !samePath(candidate, userDataPath, path) && holdsProductState({ directory: candidate, fs, path })
  ))

  if (!source) {
    try {
      fs.mkdirSync(userDataPath, { recursive: true })
      writeRecord({
        recordPath,
        fs,
        payload: {
          version: RECORD_VERSION,
          status: 'complete',
          adopted: false,
          reason: 'NO_PRIOR_INSTALL',
          /* The evidence, so the next version can tell this verdict from one
             that was simply never checked. */
          searched: describeSearch({ candidates, fs, path }),
          at: now(),
        },
      })
    } catch { /* see above */ }
    return { adopted: false, reason: 'NO_PRIOR_INSTALL', entries: [], failures: [] }
  }

  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    /* The record goes down BEFORE the first byte is copied, so a crash halfway
       through is resumable rather than invisible. */
    writeRecord({
      recordPath,
      fs,
      payload: { version: RECORD_VERSION, status: 'in-progress', from: source, at: now() },
    })
  } catch (error) {
    return { adopted: false, reason: 'RECORD_NOT_WRITABLE', entries: [], failures: [{ entry: RECORD_FILE, message: String(error && error.message || error) }] }
  }

  const entries = []
  const failures = []
  const notes = []

  /* WHAT THE KEYSTORE SAYS ABOUT THE PRIOR INSTALL'S SIGNING KEY, decided ONCE,
     before the first byte moves. Anything short of DECRYPTABLE takes the key and
     everything bound to it out of this adoption. */
  const sealedVerdict = sealedKeyVerdict({ source, fs, path, canDecrypt })
  const refusedEntries = new Set()
  if (sealedVerdict !== SEALED_KEY_VERDICTS.DECRYPTABLE) {
    for (const entry of [KEYSTORE_SEALED_ENTRY, ...ENTRIES_BOUND_TO_SEALED_KEY]) {
      /* Only what the source actually has. Naming a file that was never there
         would be a note about nothing, and this record is read by people. */
      if (fs.existsSync(path.join(source, entry))) refusedEntries.add(entry)
    }
    if (refusedEntries.size > 0) {
      notes.push({
        code: SEALED_KEY_NOT_ADOPTED,
        verdict: sealedVerdict,
        entries: [...refusedEntries],
        /* The path, because the data is still THERE and the only unhelpful
           version of this note is one that does not say where. Nothing was
           deleted or moved. */
        from: source,
      })
    }
  }

  for (const entry of PRODUCT_STATE_ENTRIES) {
    if (refusedEntries.has(entry)) continue
    const from = path.join(source, entry)
    const to = path.join(userDataPath, entry)
    if (!fs.existsSync(from) || fs.existsSync(to)) continue
    try {
      copyEntry({ from, to, fs })
      entries.push(entry)
    } catch (error) {
      failures.push({ entry, message: String(error && error.message || error) })
    }
  }

  for (const entry of BEST_EFFORT_ENTRIES) {
    const from = path.join(source, entry)
    const to = path.join(userDataPath, entry)
    if (!fs.existsSync(from) || fs.existsSync(to)) continue
    try {
      copyEntry({ from, to, fs })
      entries.push(entry)
    } catch (error) {
      failures.push({ entry, message: String(error && error.message || error), bestEffort: true })
    }
  }

  const requiredFailed = failures.some((failure) => !failure.bestEffort)
  if (requiredFailed) {
    /* Leave the record at in-progress. The next launch resumes the same source
       and copies whatever is still missing. */
    return { adopted: entries.length > 0, reason: 'INCOMPLETE', from: source, entries, failures, notes }
  }

  try {
    writeRecord({
      recordPath,
      fs,
      payload: { version: RECORD_VERSION, status: 'complete', adopted: true, from: source, entries, failures, notes, at: now() },
    })
  } catch { /* the copy succeeded; a missing record only costs us a re-check */ }

  return { adopted: true, reason: 'ADOPTED', from: source, entries, failures, notes }
}

module.exports = {
  RECORD_FILE,
  RECORD_VERSION,
  STATE_ROOT_ENV,
  LEGACY_SUCCESSOR_NAME,
  LEGACY_USER_DATA_NAMES,
  PRODUCT_STATE_ENTRIES,
  BEST_EFFORT_ENTRIES,
  KEYSTORE_SEALED_ENTRY,
  ENTRIES_BOUND_TO_SEALED_KEY,
  SEALED_KEY_NOT_ADOPTED,
  SEALED_KEY_VERDICTS,
  resolveLegacyUserDataNames,
  adoptLegacyUserData,
}
