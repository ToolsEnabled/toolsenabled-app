#!/usr/bin/env node
/* A CREDENTIAL REQUEST IS WAITING. CAN THE PERSON TELL?
 *
 * WHY THIS EXISTS. The first external user reported that agents "weren't able
 * to use credential manager or vault". Part of that is a deliberate tier gate
 * (system.credential_request is withheld at Guided, present at Standard and
 * above -- measured, and correct). This file is about the part that is NOT
 * deliberate: when an agent at Standard DOES ask, the only thing that happens
 * on screen is a native Windows dialog and one system sound. The app window
 * itself says nothing, anywhere, ever.
 *
 * MEASURED BEFORE THIS TEST WAS WRITTEN: the string "owner_prompts" appears
 * ZERO times in this repository's src/ and shell/. There is no bridge call, no
 * IPC handler and no indicator. The engine has published the safe answer since
 * owner_prompts.status shipped -- effect local-read, returning waitingForOwner,
 * counts, and per-request {requestId, kind, status, timestamps} through
 * safeItem(), which carries no label, no vault key and no entered value -- and
 * nothing in the app has ever asked it. So a person who misses the sound has no
 * way to learn that their assistant is blocked waiting on them.
 *
 * WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts only that
 * SOMETHING in the app window tells a person a credential request is waiting.
 * It does not dictate the wording, the component or the route -- those are the
 * copy and design lanes' business. It also asserts the negative that matters:
 * whatever is shown must never carry the vault key, the label, or any value.
 *
 * NOTHING REAL IS TOUCHED. The whole run lives under a scratch profile; the
 * harness redirects APPDATA, so the engine's per-user state root -- and its
 * vault -- resolve inside that profile. The planted request names a canary key
 * and no value is ever supplied, because a queued request has none yet: the
 * value only exists after a person types it into the native dialog.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  assertIsolated, closeWindow, delay, gotoHome, openWindow,
  route, scratchDirectory, screenText, seedMachineRecord, stage, userDataFor, writeEvidence
} from './test-account-harness.mjs';

const CANARY_KEY = 'canary_not_a_secret_7412';
const CANARY_LABEL = 'Example service token';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `  ${detail}`}`);
};

const scratch = scratchDirectory('credential-waiting-visible');
const profile = path.join(scratch, 'one-windows-user');
const staged = await stage(scratch);
/* Standard: the level at which an agent is actually allowed to ask. Proving
   this at Guided would prove nothing, because there the tool is withheld. */
seedMachineRecord(profile, staged.appRoot, 'standard');

/* The engine's own queue module, taken from the payload this app ships, so the
   planted request is byte-shaped exactly like a real one rather than a fixture
   this test invented. The state root is set BEFORE the first require -- the
   trap where a module decides its paths at load time and silently writes to
   real user state. */
/* shell/main.cjs binds the capability layer to Electron's exact userData
   identity, including when --user-data-dir relocates it. Plant the request in
   that same directory; APPDATA is deliberately irrelevant to this identity. */
const stateRoot = path.join(userDataFor(profile), 'capability');
fs.mkdirSync(path.join(stateRoot, 'state'), { recursive: true });
process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
process.env.TOOLSENABLED_VAULT_PATH = path.join(stateRoot, 'vault', 'secrets.json');

const require_ = createRequire(import.meta.url);
const queueModule = path.join(staged.appRoot, 'resources', 'capability', 'src', 'lib', 'providers', 'owner-prompt-queue.js');
check('the engine queue module ships in the payload', fs.existsSync(queueModule), queueModule);
const queue = require_(queueModule);

const queueFile = path.join(stateRoot, 'state', 'owner-prompt-queue.json');
/* enqueue() launches the persistent waiting dialog. Its spawn is injectable for
   exactly this reason, so the queue is written without putting a window on the
   owner's desktop. The fake child reports a plausible live pid; nothing else
   about the launcher is under test here. */
const fakeSpawn = () => ({ pid: process.pid, unref() {}, once() {} });
let planted = null;
try {
  planted = queue.enqueue(
    { kind: 'credential', vaultKey: CANARY_KEY, label: CANARY_LABEL,
      requestContext: { purpose: 'Read one repository', scope: 'One repository', lifetime: 'Until revoked' },
      requester: 'claude' },
    { queueFile, spawn: fakeSpawn, livenessMs: 1 }
  );
} catch (error) {
  check('a credential request can be queued', false, String(error && (error.code || error.message)));
}
check('a credential request is queued and waiting', Boolean(planted), JSON.stringify(planted || {}));

const status = queue.status({}, { queueFile });
check('the engine reports someone is waiting for the owner', status.waitingForOwner === true,
  `waitingForOwner=${status.waitingForOwner} counts=${JSON.stringify(status.counts)}`);
check('the engine names the request kind without any secret',
  status.requests.some(r => r.kind === 'credential')
  && !JSON.stringify(status.requests).includes(CANARY_KEY)
  && !JSON.stringify(status.requests).includes(CANARY_LABEL),
  JSON.stringify(status.requests));

/* ---- and now the only question this file exists to ask ---- */
const window = await openWindow(staged.executable, profile);
let seen = '';
try {
  assertIsolated(profile);
  await gotoHome(window);
  await delay(2500);
  seen = await screenText(window);
  /* Give a poll-driven indicator a fair chance to arrive before concluding
     absence -- an absence measured too early is not an absence. */
  for (let attempt = 0; attempt < 4 && !/waiting|needs you|credential/i.test(seen); attempt += 1) {
    await delay(2500);
    seen = await screenText(window);
  }
} finally {
  await closeWindow(window);
}

/* THE ASSERTION THIS FILE GOT WRONG THE FIRST TIME, AND WHY IT IS WRITTEN LIKE
   THIS NOW. A loose /is waiting/ matched the app's own reassurance -- "Nothing
   is waiting for your approval" -- and the suite went green while measuring the
   exact opposite of its claim. So the negative sentence is removed from the
   haystack FIRST, and only then is an affirmative signal looked for. */
const NOTHING_WAITING = /Nothing is waiting[^.\n]*/gi;
const deniesAnythingWaits = NOTHING_WAITING.test(seen);
const remainder = seen.replace(NOTHING_WAITING, '');
const tellsThem = /(waiting for you|needs you|asked you for|credential request|wants a credential)/i.test(remainder);

/* Stated as its own check because it is a stronger and uglier fact than silence:
   with a credential request genuinely queued, the home screen does not merely
   fail to mention it -- it affirmatively tells the person nothing is waiting. */
check('the app does not tell the person nothing is waiting while one is',
  !(deniesAnythingWaits && status.counts.queued > 0),
  deniesAnythingWaits ? `screen says "Nothing is waiting for your approval" with counts.queued=${status.counts.queued}` : '');

check('the app window tells the person a credential request is waiting', tellsThem,
  tellsThem ? '' : 'nothing on screen mentions a waiting request');
const foldedScreenText = seen.toLowerCase();
check('nothing on screen carries the vault key, the label, or a value',
  !foldedScreenText.includes(CANARY_KEY.toLowerCase())
  && !foldedScreenText.includes(CANARY_LABEL.toLowerCase()));

writeEvidence(scratch, 'credential-waiting-visible.json',
  JSON.stringify({ checks, status, homeText: seen, route: 'home' }, null, 2));

const passed = checks.filter(c => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed (credential-waiting-visible)`);
if (passed !== checks.length) {
  console.log('FAILING CHECKS:');
  for (const c of checks.filter(x => !x.ok)) console.log(`  - ${c.name}  ${c.detail}`);
  process.exitCode = 1;
}
console.log('evidence:', scratch);
