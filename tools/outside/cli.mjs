#!/usr/bin/env node
/* THE COMMAND LINE OVER app.mjs.
 *
 *   node tools/outside/cli.mjs [--port 9223] pages
 *   node tools/outside/cli.mjs [--port 9223] press '<selector>'
 *   node tools/outside/cli.mjs [--port 9223] text '<selector>'
 *   node tools/outside/cli.mjs [--port 9223] eval '<expression>'
 *   node tools/outside/cli.mjs [--port 9223] shot <file.png>
 *   node tools/outside/cli.mjs [--port 9223] errors [seconds]
 *
 * Prints JSON on stdout so an agent can read the answer, and a plain sentence on
 * stderr when it cannot reach the app. Exit 0 when the command ran, 1 when the
 * app refused or could not be reached, 2 for a usage mistake. */
import { openApp, listPages, DEFAULT_PORT } from './app.mjs'

function usage() {
  process.stderr.write('usage: node tools/outside/cli.mjs [--port N] pages | press <selector> | text <selector> | eval <expression> | shot <file> | errors [seconds]\n')
  process.exit(2)
}

const argv = process.argv.slice(2)
let port = DEFAULT_PORT
if (argv[0] === '--port') {
  port = Number.parseInt(argv[1], 10)
  if (!Number.isInteger(port)) usage()
  argv.splice(0, 2)
}
const [command, ...rest] = argv
if (!command) usage()

const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

try {
  if (command === 'pages') {
    print(await listPages({ port }))
    process.exit(0)
  }
  const app = await openApp({ port })
  try {
    if (command === 'press') {
      if (!rest[0]) usage()
      print({ pressed: rest[0], at: await app.press(rest[0]), errors: app.errors() })
    } else if (command === 'text') {
      if (!rest[0]) usage()
      print({ selector: rest[0], text: await app.text(rest[0]) })
    } else if (command === 'eval') {
      if (!rest[0]) usage()
      print({ value: await app.evaluate(rest[0]) })
    } else if (command === 'shot') {
      if (!rest[0]) usage()
      await app.screenshot(rest[0])
      print({ wrote: rest[0] })
    } else if (command === 'errors') {
      const seconds = rest[0] ? Number.parseFloat(rest[0]) : 2
      await new Promise(resolve => setTimeout(resolve, Math.max(0, seconds) * 1000))
      print({ page: app.page ? app.page.title : null, errors: app.errors() })
    } else {
      usage()
    }
  } finally {
    app.close()
  }
  process.exit(0)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
