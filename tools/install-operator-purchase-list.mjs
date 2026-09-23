#!/usr/bin/env node

/* Put YOUR purchase list where YOUR copy of the product will read it.
 *
 * The checkout screen shows a shopping list: what to buy to launch this, what breaks
 * without each line, and why you wanted it. That list is a document about you, so it is
 * not part of the product. It used to be, and the consequence was measured: every
 * installer carried the author's own list -- internal paths, internal request ids, his
 * own second-person notes, and a written admission that the installer is unsigned --
 * and #/checkout put it one click back from home on a stranger's fresh install.
 *
 * So the list now lives in two places and neither is the payload:
 *
 *   private/purchase-catalog.owner.json      the copy you edit; /private/ keeps git out
 *   <userData>/purchase-catalog.json         the copy the running app reads
 *
 * This copies the first to the second. The app offers the checkout when that file is
 * there and offers nothing at all when it is not, so this is also how you turn the
 * screen on -- and deleting that file is how you turn it off.
 *
 * The file is validated before it is copied. An unreadable list installed anyway would
 * turn into an error on screen at the moment you opened the shop, which is the worst
 * moment to discover it.
 *
 * Usage: node tools/install-operator-purchase-list.mjs [--userData <dir>] [--remove]
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateAgainstSchema } from './gen-projection-lib.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(REPO_ROOT, 'private', 'purchase-catalog.owner.json')
const SCHEMA = path.join(REPO_ROOT, 'public', 'data', 'schema', 'purchase-catalog.schema.json')
const INSTALLED_NAME = 'purchase-catalog.json'
const PRODUCT_DIRECTORY = 'ToolsEnabled'

/* Where Electron keeps app.getPath('userData') for this product on this platform. A
   copy launched with --user-data-dir keeps it somewhere else, which is why that is an
   argument rather than an assumption. */
function defaultUserData() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, PRODUCT_DIRECTORY)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', PRODUCT_DIRECTORY)
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), PRODUCT_DIRECTORY)
}

function parseArguments(argv) {
  const options = { userData: defaultUserData(), remove: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--remove') { options.remove = true; continue }
    if (argv[index] === '--userData') {
      const value = argv[index + 1]
      if (!value) throw new Error('--userData needs a directory after it')
      options.userData = path.resolve(value)
      index += 1
      continue
    }
    throw new Error(`unrecognized argument ${JSON.stringify(argv[index])}`)
  }
  return options
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const destination = path.join(options.userData, INSTALLED_NAME)

  if (options.remove) {
    if (!existsSync(destination)) {
      console.log(`Nothing to remove: ${destination} is not there, so this copy already has no checkout.`)
      return
    }
    rmSync(destination)
    console.log(`Removed ${destination}. This copy no longer offers a checkout.`)
    return
  }

  if (!existsSync(SOURCE)) {
    throw new Error(
      `no purchase list at ${path.relative(REPO_ROOT, SOURCE)}. That file is yours and is deliberately not in ` +
        'git, so a fresh checkout does not have one. Write it against ' +
        `${path.relative(REPO_ROOT, SCHEMA)} first.`,
    )
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(SOURCE, 'utf8'))
  } catch (error) {
    throw new Error(`${path.relative(REPO_ROOT, SOURCE)} is not valid JSON (${error.message}); nothing was installed.`)
  }
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'))
  const errors = validateAgainstSchema(parsed, schema, schema, '$')
  if (errors.length > 0) {
    throw new Error(
      `${path.relative(REPO_ROOT, SOURCE)} does not match the catalogue schema, so the screen would refuse it ` +
        `after you opened it:\n  - ${errors.slice(0, 8).join('\n  - ')}`,
    )
  }

  mkdirSync(options.userData, { recursive: true })
  copyFileSync(SOURCE, destination)
  console.log(`Installed ${parsed.items?.length ?? 0} item(s) to ${destination}.`)
  console.log('Restart ToolsEnabled; the checkout is one step back from home on the ring.')
}

try {
  main()
} catch (error) {
  console.error(`install-operator-purchase-list: ${error.message}`)
  process.exitCode = 1
}
