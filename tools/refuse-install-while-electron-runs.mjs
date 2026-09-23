// npm preinstall -- REFUSE A REIFY WHILE THIS CHECKOUT'S ELECTRON IS RUNNING.
//
// npm removes before it adds. It also clears node_modules/.bin and rewrites it.
// So an install that dies partway leaves a tree that is populated but incomplete,
// and the failures that follow never name the cause:
//
//   2026-08-27, three separate diagnosis rounds in one day --
//     * @rollup/rollup-win32-x64-msvc and echarts absent -> the build died at
//       vite with MODULE_NOT_FOUND, which reads as broken product code
//     * app-builder-lib, builder-util, builder-util-runtime, ajv absent -> the
//       test ratchet reported ELEVEN regressions blocking the ship path
//     * @carbon/colors, three fonts, culori, d3-array, d3-force absent -> the
//       license gate failed six dependencies it "cannot verify", which it fails
//       rather than warns on because an unmet notice obligation cannot be fixed
//       retroactively
//     * node_modules/.bin emptied entirely -> "'vite' is not recognized", which
//       reads as a missing dependency when the package was there all along
//
// WHY IT KEEPS HAPPENING HERE SPECIFICALLY: this checkout's electron is what the
// MCP servers run (node_modules/electron/dist/electron.exe). Windows will not let
// npm relocate a running binary, so the install fails EBUSY partway through --
// after the removals, before the adds.
//
// So the fix is not to repair the tree faster. It is to refuse the install while
// the thing that guarantees its failure is running.
//
// THIS REFUSES ONLY FOR THIS CHECKOUT. A process running electron from somewhere
// else is not our business, and CI -- where nothing is running -- proceeds
// normally. If the platform cannot be asked, this says so and ALLOWS the install:
// a preinstall hook that blocks on its own blindness would be worse than the
// defect it prevents.

// npm ci runs the root preinstall hook AFTER removing the old dependency tree.
// The hook alone cannot protect a direct npm ci. A caller replacing an existing
// tree must run this guard BEFORE starting npm (node-modules-reuse.mjs does so).
// Linux release cuts instead require a fresh worktree with private dependencies.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, win32, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const here = fileURLToPath(import.meta.url)
const REPO = dirname(dirname(here))
const ELECTRON_DIR = resolve(join(REPO, 'node_modules', 'electron'))

export function runningFromThisCheckout({ platform = process.platform, list = null, electronDirectory = ELECTRON_DIR } = {}) {
  if (!existsSync(electronDirectory)) return { asked: true, holders: [] }

  let rows = null, asked = true
  if (list) {
    rows = list()
  } else if (platform === 'win32') {
    try {
      rows = execFileSync(
        'powershell',
        ['-NoProfile', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object -ExpandProperty ExecutablePath"],
        { encoding: 'utf8', timeout: 20_000, windowsHide: true },
      ).split(/\r?\n/)
    } catch {
      // Could not look. Say so; do not turn it into "nothing is running".
      return { asked: false, holders: [] }
    }
  } else if (platform === 'linux' && process.platform === 'linux') {
    rows = []
    try {
      for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        try {
          const entry = join('/proc', pid)
          if (statSync(entry).uid !== process.getuid()) continue
          rows.push(readlinkSync(join(entry, 'exe')).replace(/ \(deleted\)$/, ''))
        } catch (error) {
          // A process may exit between enumeration and readlink. Other read
          // errors leave the inventory incomplete, never an empty success.
          if (!['ENOENT', 'ESRCH'].includes(error.code)) asked = false
        }
      }
    } catch { asked = false }
  } else {
    return { asked: false, holders: [] }
  }

  // WMI may report the resolved target of a linked dependency directory. A
  // same-prefix sibling (electron-shadow) is never part of electron itself.
  const canonical = value => { try { return realpathSync(value) } catch { return value } }
  const paths = platform === 'win32' ? win32 : posix
  const normalize = value => platform === 'win32' ? paths.normalize(value).toLowerCase() : paths.normalize(value)
  const wanted = [electronDirectory, canonical(electronDirectory)].map(normalize)
  const holders = rows
    .map((line) => String(line).trim())
    .filter(Boolean)
    .filter(file => wanted.some(directory => {
      const relative = paths.relative(directory, normalize(canonical(file)))
      return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep))
    }))
  return { asked, holders }
}

function main() {
  if (process.env.TE_ALLOW_INSTALL_WITH_ELECTRON_RUNNING === '1') {
    console.error('preinstall: proceeding because TE_ALLOW_INSTALL_WITH_ELECTRON_RUNNING=1 was set.')
    return 0
  }

  const answer = runningFromThisCheckout()
  if (!answer.asked && answer.holders.length === 0) {
    console.error('preinstall: could not ask which processes are running, so this is NOT a report that '
      + 'none are. Proceeding, because a hook that blocks on its own blindness is worse than the defect '
      + 'it prevents.')
    return 0
  }
  if (answer.holders.length === 0) return 0

  console.error('')
  console.error(`REFUSING THE INSTALL: ${answer.holders.length} process(es) are running Electron from this`)
  console.error('checkout\'s node_modules. npm removes before it adds and clears node_modules/.bin, and')
  console.error('A running application still needs those files; on Windows its executable also blocks relocation.')
  console.error('An interrupted replacement can leave a tree that is populated but incomplete. Later failures')
  console.error('names a missing module or an unrecognised command rather than the interrupted install.')
  console.error('')
  for (const path of answer.holders.slice(0, 6)) console.error(`  ${path}`)
  if (answer.holders.length > 6) console.error(`  ... and ${answer.holders.length - 6} more`)
  console.error('')
  console.error('Fix: end those processes first (they are usually MCP servers or a dev launch), then')
  console.error('install. To add one package without a reify, fetch it into a scratch prefix and copy')
  console.error('the directory in. To override deliberately, set')
  console.error('TE_ALLOW_INSTALL_WITH_ELECTRON_RUNNING=1.')
  console.error('')
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(here)) {
  process.exit(main())
}
