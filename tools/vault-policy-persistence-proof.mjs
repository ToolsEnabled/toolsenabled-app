#!/usr/bin/env node
/* DO THE OWNER'S NICKNAMES AND ACCESS SWITCHES SURVIVE A RESTART AND A NEW
 * GENERATION?
 *
 * WHY THIS IS NOT A COMMENT IN A DESIGN NOTE. "It lives under the state root,
 * so it persists" is a claim about a path, and the thing the owner actually
 * loses if it is wrong is specific and bad: a nickname exists to HIDE a
 * credential's real name, so a nickname that vanished on upgrade would re-expose
 * exactly what it was created to hide, and an access switch that vanished would
 * silently re-open a credential the owner had closed. Neither failure announces
 * itself. So this measures it instead of asserting it.
 *
 * THREE LEGS, each answering a different question, none of them stubbed:
 *
 *   1. WRITE       the desktop app's real writer (shell/vault-access-policy.cjs)
 *                  sets a nickname and a deny.
 *   2. RESTART     a FRESH node process -- nothing shared with leg 1 but the
 *                  bytes on disk -- reads them back through the same writer's
 *                  reader. This is what an app restart is: new process, same
 *                  state root.
 *   3. GENERATION  the engine's reader (src/lib/vault-access-policy.js) is
 *                  COPIED into a different directory standing in for a newly
 *                  promoted generation, and run from there against the SAME
 *                  state root. A generation change replaces the program
 *                  directory and leaves the per-user state root alone, so code
 *                  loaded from a path that did not exist when the decisions
 *                  were written must still read them. Running the copy from
 *                  elsewhere is what makes that a measurement rather than a
 *                  restatement of the design.
 *
 * Leg 3 also checks the two halves AGREE: the app wrote the file, the engine
 * read it, and the engine's verdict for the denied role is a refusal. The two
 * repositories share no module -- only this path and these bytes -- so their
 * agreement is the only thing keeping the owner's switches connected to the
 * reads they govern.
 *
 *   node tools/vault-policy-persistence-proof.mjs [--engine <path>]
 *
 * Exit 0 only if all three legs held.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function enginePath() {
  const flag = process.argv.indexOf('--engine')
  if (flag !== -1 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1])
  /* The same binding the app's own payload gate uses, so this script and that
     gate cannot disagree about which engine tree is in play. */
  const configured = JSON.parse(readFileSync(path.join(APP_ROOT, 'private', 'capability-source.owner.json'), 'utf8'))
  return path.resolve(configured.path)
}

const ENGINE_ROOT = enginePath()
const RECORD = 'stripe_secret_key'
const NICKNAME = 'the card one'
const DENIED_ROLE = 'builder'

const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'vault-policy-persist-'))
const generationTwo = mkdtempSync(path.join(os.tmpdir(), 'generation-2-'))

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`)
}

try {
  console.log(`app      : ${APP_ROOT}`)
  console.log(`engine   : ${ENGINE_ROOT}`)
  console.log(`stateRoot: ${stateRoot}`)

  // -- LEG 1 ---------------------------------------------------------------
  console.log('\n=== LEG 1: the app writes a nickname and a deny ===')
  const writer = require_(path.join(APP_ROOT, 'shell', 'vault-access-policy.cjs'))
  const wroteNickname = writer.setNickname(stateRoot, RECORD, NICKNAME)
  const wroteAccess = writer.setAccess(stateRoot, RECORD, DENIED_ROLE, false)
  check('setNickname reported success', wroteNickname.ok, true)
  check('setAccess reported success', wroteAccess.ok, true)
  console.log(`  file: ${writer.policyFilePath(stateRoot)}`)

  // -- LEG 2 ---------------------------------------------------------------
  console.log('\n=== LEG 2: a restart -- a fresh process reads them back ===')
  const restartSource = `
    const writer = require(${JSON.stringify(path.join(APP_ROOT, 'shell', 'vault-access-policy.cjs'))});
    const read = writer.readPolicy(${JSON.stringify(stateRoot)});
    console.log(JSON.stringify({
      readable: read.readable,
      nickname: writer.displayName(read, ${JSON.stringify(RECORD)}),
      deniedRole: writer.mayRead(read, ${JSON.stringify(RECORD)}, ${JSON.stringify(DENIED_ROLE)}).allowed,
      otherRole: writer.mayRead(read, ${JSON.stringify(RECORD)}, 'reviewer').allowed
    }));`
  const restart = JSON.parse(execFileSync(process.execPath, ['-e', restartSource], { encoding: 'utf8' }).trim())
  check('the policy is readable after a restart', restart.readable, true)
  check('the nickname survived, and still replaces the real name', restart.nickname, NICKNAME)
  check(`${DENIED_ROLE} is still refused after a restart`, restart.deniedRole, false)
  check('a role the owner never closed is still allowed', restart.otherRole, true)

  // -- LEG 3 ---------------------------------------------------------------
  console.log('\n=== LEG 3: a generation change -- the engine reader, loaded from a NEW directory ===')
  mkdirSync(path.join(generationTwo, 'src', 'lib'), { recursive: true })
  const promoted = path.join(generationTwo, 'src', 'lib', 'vault-access-policy.js')
  copyFileSync(path.join(ENGINE_ROOT, 'src', 'lib', 'vault-access-policy.js'), promoted)
  console.log(`  promoted reader: ${promoted}`)
  const generationSource = `
    const reader = require(${JSON.stringify(promoted)});
    const read = reader.readPolicy(${JSON.stringify(stateRoot)});
    console.log(JSON.stringify({
      readable: read.readable,
      file: read.file,
      deniedRole: reader.mayRead(read, ${JSON.stringify(RECORD)}, [${JSON.stringify(DENIED_ROLE)}]),
      otherRole: reader.mayRead(read, ${JSON.stringify(RECORD)}, ['reviewer']).allowed
    }));`
  const promotedRead = JSON.parse(execFileSync(process.execPath, ['-e', generationSource], {
    encoding: 'utf8',
    /* Deliberately run from a directory unrelated to either tree: if the policy
       location depended on where the code sits rather than on the state root,
       this is where it would break. */
    cwd: os.tmpdir()
  }).trim())
  check('the promoted generation can read the previous one\'s decisions', promotedRead.readable, true)
  check('it resolved the same file the app wrote', promotedRead.file, writer.policyFilePath(stateRoot))
  check(`${DENIED_ROLE} is still refused by the new generation`, promotedRead.deniedRole.allowed, false)
  check('and the refusal still names itself', promotedRead.deniedRole.code, 'VAULT_ACCESS_DENIED')
  check('a role the owner never closed is still allowed', promotedRead.otherRole, true)

  console.log(`\nRESULT: ${failures === 0 ? 'nicknames and the access matrix survive a restart AND a generation change' : `${failures} check(s) FAILED`}`)
} finally {
  rmSync(stateRoot, { recursive: true, force: true })
  rmSync(generationTwo, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
