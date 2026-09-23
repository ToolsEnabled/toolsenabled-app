import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/* THE WINDOW-CATEGORY EXCLUSION HAD NO TEST.
 *
 * $blockedNames in shell/accessibility-desktop.ps1 is the only thing keeping
 * the accessibility agent away from whole classes of window: terminals, the
 * file manager, regedit, taskmgr -- and the UAC consent dialog, the Windows
 * credential broker and the logon UI. A search of the whole app tree for that
 * symbol returns one file, the helper itself. Nothing turned red if it
 * regressed, and the failure mode is an agent driving a credential prompt.
 *
 * WHAT THIS TEST DOES NOT COVER, stated so nobody reads it as more than it is.
 * Get-Snapshot, which applies the pattern, cannot be called from here: it needs
 * a real visible window handle, a foreign process id, an owner-SID-matched
 * image path and the interactive session id. This drives the smallest piece
 * reachable without owning a window -- the name test itself -- and it does not
 * prove that Get-Snapshot still calls it, that the caller passes the image name
 * rather than the caption, or that the surrounding session and owner checks
 * hold. Those need a real UIA session, which accessibility-desktop.test.mjs
 * already exercises separately.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(HERE, '..', '..', 'shell', 'accessibility-desktop.ps1')

/* The pattern is READ FROM THE SHIPPED HELPER, never copied into this file. A
 * copy would keep passing after the helper stopped refusing anything, which is
 * exactly the regression this test exists to catch. */
function shippedBlockedNames() {
  const source = readFileSync(HELPER, 'utf8')
  const declared = /^\s*\$blockedNames\s*=\s*'([^']+)'\s*$/m.exec(source)
  assert.ok(declared, 'accessibility-desktop.ps1 no longer declares $blockedNames as one single-quoted pattern')
  return declared[1]
}

/* Evaluated by a real PowerShell with the same -match operator the helper uses,
 * rather than reimplemented in JavaScript, so the anchors and the operator's
 * own case-insensitivity are the ones that actually ship. */
function verdicts(names) {
  const pattern = shippedBlockedNames().replace(/'/g, "''")
  const list = names.map(name => `'${name.replace(/'/g, "''")}'`).join(',')
  const script = `$blockedNames = '${pattern}'\n`
    + `foreach ($name in @(${list})) { if ($name -match $blockedNames) { "REFUSED $name" } else { "ADMITTED $name" } }`
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true })
  const seen = new Map()
  for (const line of output.split(/\r?\n/)) {
    const row = /^(REFUSED|ADMITTED) (.+)$/.exec(line.trim())
    if (row) seen.set(row[2], row[1])
  }
  return seen
}

const REFUSED = [
  'electron', 'toolsenabled', 'toolsenabled-live', 'cmd', 'powershell', 'pwsh',
  'wt', 'windowsterminal', 'conhost', 'explorer', 'totalcmd', 'totalcmd64',
  'consent', 'credentialuibroker', 'logonui', 'regedit', 'mmc', 'taskmgr',
]
const ADMITTED = ['notepad', 'chrome', 'msedge', 'winword', 'somebodyselse']

test('every excluded window class is refused by name, and an ordinary window is still admitted',
  { skip: process.platform === 'win32' ? false : 'the helper and its -match semantics are Windows-only' }, () => {
    const seen = verdicts([...REFUSED, ...ADMITTED])

    for (const name of REFUSED) {
      assert.equal(seen.get(name), 'REFUSED',
        `${name} reached the accessibility surface: $blockedNames in shell/accessibility-desktop.ps1 no longer excludes it`)
    }
    for (const name of ADMITTED) {
      assert.equal(seen.get(name), 'ADMITTED',
        `${name} was refused: $blockedNames has widened and ordinary windows are now unreachable`)
    }
  })
