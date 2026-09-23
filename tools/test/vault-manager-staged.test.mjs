/* BOTH VAULT PROGRAMS SHIP, NOT JUST THE ONE.
 *
 * WHAT WAS MEASURED, AND WHERE. In the staged capability payload beside app
 * c8deb5e4: `tools/secrets.ps1` present, `tools/secrets-manager.ps1` ABSENT --
 * while the engine source tree carries both (`git ls-files` in the engine
 * repository lists `tools/secrets-manager.ps1`). `tools/capability-manifest.json`
 * declared the first in `helperPrograms` and not the second.
 *
 * WHY THAT IS NOT A MISSING DIAGNOSTIC. The manager script is the whole secret
 * LIFECYCLE half of the vault. `src/lib/secret-store/powershell.js` resolves it
 * as `programOrStatePath(ROOT, ['tools', 'secrets-manager.ps1'])` and its `run`
 * fails closed with `SECRET_MANAGER_NOT_INSTALLED` when it is not there, so
 * `inventory()`, `history()` and `mutate()` all throw. `mutate('remove', ...)`
 * is what `system.credential_remove` is built on, and that tool is the
 * product's ONE generic way for an owner to delete a stored credential --
 * `src/lib/runtime.js` deliberately exports no generic `deleteSecret(key)` (see
 * the comment above `clearDeviceCredential`, which says why). So on an
 * installed build a key the owner had revoked at his provider stayed on his
 * disk with no route in the product to take it off.
 *
 * WHY A MANIFEST CHECK AND NOT A WALK. The manifest's own
 * `$comment_helperPrograms` states the rule this defect broke: the require()
 * walk sees JavaScript and cannot see a PowerShell program reached through a
 * path computed in a spawn argument, so such a program must be DECLARED or it
 * ships in no installer at all. That comment was written about `secrets.ps1`.
 * The same sentence was true of `secrets-manager.ps1` the whole time and
 * nothing asked. This file asks.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'tools', 'capability-manifest.json'), 'utf8'))
const declared = new Set(manifest.helperPrograms || [])

test('both of the vault\'s PowerShell programs are declared for staging', () => {
  /* NAMED, because "some vault script is declared" is what let this through.
     tools/secrets.ps1 is the STORE (read, write, presence, list) and
     tools/secrets-manager.ps1 is the LIFECYCLE (inventory, history, add,
     replace, rotate, remove). They are two programs and a payload carrying one
     of them is a vault that can be read but not managed. */
  for (const program of ['tools/secrets.ps1', 'tools/secrets-manager.ps1']) {
    assert.ok(declared.has(program),
      `${program} is not in tools/capability-manifest.json helperPrograms, so it ships in no installer. `
      + 'A PowerShell program reached through a computed spawn path is invisible to the require() walk; '
      + 'the manifest is the only thing that can carry it.')
  }
})

test('every declared vault program is a program this repository can stage', () => {
  /* The other half of the ratchet. A declaration naming a file that is not
     there is the packer's problem, not this test's -- but a declaration naming
     a file with the wrong EXTENSION is refused by the packer's own
     assertHelperProgramsAreExecutable, and a test that declared a .json here
     would turn a green run into a failed pack. Checked in the same terms. */
  const executable = new Set(['.ps1', '.cmd', '.py', '.bat', '.sh', '.exe'])
  for (const program of [...declared].filter(entry => entry.includes('secret'))) {
    assert.ok(executable.has(path.extname(program).toLowerCase()),
      `${program} is declared as a helper program but is not an executable helper`)
  }
})

/* ------------------------------------------------------------------------
 * THE SAME QUESTION, ASKED OF THE REAL PAYLOAD RATHER THAN OF THE MANIFEST.
 *
 * The manifest is the INPUT to staging; this is the output. It runs only when a
 * payload is named, and it SKIPS BY NAME otherwise -- `capability/` is
 * gitignored in this repository (`.gitignore` names `/capability/`), so there
 * is no path this file may resolve on its own, and "I could not look" is a
 * different answer from "it is fine".
 */
test('the staged payload carries the program its own lifecycle module resolves', t => {
  const payload = process.env.MC_TEST_CAPABILITY_PAYLOAD
  if (!payload) {
    t.skip('MC_TEST_CAPABILITY_PAYLOAD is not set, so no staged payload was inspected. The manifest checks above still ran; this one did not, and that is "could not look", not "the payload is complete".')
    return
  }
  const lifecycle = path.join(payload, 'src', 'lib', 'secret-store', 'powershell.js')
  if (!existsSync(lifecycle)) {
    t.skip(`MC_TEST_CAPABILITY_PAYLOAD names ${payload}, which carries no src/lib/secret-store/powershell.js, so the manager program it resolves could not be derived.`)
    return
  }
  /* DERIVED FROM THE MODULE, NOT TYPED HERE, so renaming the script in the
     engine fails this test instead of silently shipping nothing. */
  const source = readFileSync(lifecycle, 'utf8')
  const resolved = /programOrStatePath\(ROOT,\s*\[\s*'tools',\s*'([^']+)'\s*\]\)/.exec(source)
  assert.ok(resolved, 'the vault lifecycle module no longer resolves its program through programOrStatePath(ROOT, [\'tools\', ...])')
  const leaf = resolved[1]
  assert.ok(declared.has(`tools/${leaf}`),
    `the vault lifecycle module runs tools/${leaf}, which tools/capability-manifest.json does not declare`)
  assert.ok(existsSync(path.join(payload, 'tools', leaf)),
    `the staged payload at MC_TEST_CAPABILITY_PAYLOAD has no tools/${leaf}, so every secret lifecycle verb in it `
    + 'throws SECRET_MANAGER_NOT_INSTALLED and system.credential_remove cannot work. Re-stage the payload.')
})
