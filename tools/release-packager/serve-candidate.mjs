#!/usr/bin/env node
/* Serve a single, already-declared candidate over a configured direct link so
 * an independent verifier can pull it, with an auth token that never touches disk.
 *
 * WHY THIS SHAPE, not the alternatives:
 *
 *   - The 8787 tunnel and 8788 bridge (already up, already authenticated --
 *     see `node tools/bridge-status.js` in the ToolsEnabled product tree)
 *     cannot carry this: the tunnel is JSON-only, capped at 128 KB per
 *     request / 64 KB per message (sidecars/link-bus/server.js,
 *     sidecars/link-bus/store.js), and the bridge's remote file-write tools
 *     are string-only, overwrite-only, and capped at 2 MB with no append
 *     primitive reachable from this bounded profile. A 100 MB installer does
 *     not fit either channel. Modifying that shared infrastructure to add a
 *     file route was out of scope for a release-packager task touching
 *     everyone's messaging/bridge layer.
 *   - Persisting a plaintext download token would violate the release secret
 *     boundary. This script keeps the token in process memory, prints it once
 *     to the operator's terminal, and never writes or relays it. Losing the
 *     process means minting a new token and re-running this script -- an
 *     acceptable cost for a token whose only job is to gate one file, once.
 *   - Binds ONLY to a configured direct-link address, matching the existing
 *     security posture of the tunnel and bridge, which do the same for the
 *     same reason: that interface exists for the configured direct link and nothing else.
 *     The addresses themselves are configuration, not constants -- see
 *     DIRECT_LINK_ENV_VAR below -- and with nothing configured this script
 *     refuses to bind rather than guessing.
 *   - Serves EXACTLY the one path given at startup -- there is no directory
 *     listing, no path parameter accepted from the client, so there is no
 *     traversal surface to reason about.
 *
 * The verifier's matching half is verify-candidate.ps1 -- plain PowerShell,
 * no Node, no git, because independent verification must not need this repo's
 * toolchain installed to receive and verify a file.
 *
 * RUN THIS WITH --detach, NOT bare in a foreground/background shell job.
 * Found the hard way during the 1.0.2 transfer: three of four instances
 * launched through an agent session's own Bash-tool background-task
 * mechanism (`nohup ... &` and equivalents) died when that mechanism's own
 * process tree went away -- the token was live, the file was staged, and B
 * still could not fetch it, because the listener was gone. Only an instance
 * launched as a genuinely OS-detached process survived. `--detach` below
 * makes the correct launch the only one this script hands you: it spawns a
 * real detached child (Node's `detached: true` + `unref()`, the same
 * mechanism a manual PowerShell `Start-Process -WindowStyle Hidden` was
 * being used to approximate by hand) and exits the launcher immediately, so
 * the server's survival no longer depends on which shell, tool, or agent
 * session started it. The token is still printed exactly once, by the
 * launcher, to the real invoking terminal -- the detached child receives it
 * over an environment variable, not a file, and never re-prints it into its
 * own redirected log, so "never touches disk" still holds for the secret
 * itself even though the child's operational log now does.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* THE DIRECT-LINK ADDRESSES ARE CONFIGURATION, NOT CONSTANTS.
 *
 * They used to be two literals in this line. That was one builder's private
 * LAN baked into a tool that is published: it identifies whoever wrote it, and
 * it is simply wrong for everyone whose cable uses different numbers -- they
 * would hit the refusal below on their own correct address.
 *
 *   TOOLSENABLED_DIRECT_LINK_ADDRESSES=<local>[,<peer>[,...]]
 *
 * Comma-separated. The FIRST entry is this machine's own direct-link address
 * and is what --bind defaults to; any entry in the list may be bound
 * explicitly. Everything else is refused, exactly as before.
 *
 * THERE IS DELIBERATELY NO BUILT-IN DEFAULT, and that is a real choice, not an
 * omission. Any default here is some specific machine's real address, so a
 * default would either re-bake the previous builder's subnet or invent a
 * plausible one -- and a release server that silently starts listening on a
 * guessed interface is strictly worse than one that refuses and names the
 * variable to set. Unset therefore means "refuse, by name", never "guess".
 * The refusal-unless-direct-link property this file was built around is
 * preserved and, with nothing configured, is now total.
 */
const DIRECT_LINK_ENV_VAR = 'TOOLSENABLED_DIRECT_LINK_ADDRESSES'
const TOKEN_ENV_VAR = 'SERVE_CANDIDATE_TOKEN'
const THIS_SCRIPT = fileURLToPath(import.meta.url)

function configuredDirectLinkAddresses() {
  return (process.env[DIRECT_LINK_ENV_VAR] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function parseArgs(argv) {
  // bind starts unset: the default comes from the configured direct-link
  // addresses, and if there are none there is no default to fall back to.
  const args = { port: 4787, bind: null, once: false, detach: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') args.port = Number(argv[++i])
    else if (arg === '--bind') args.bind = argv[++i]
    else if (arg === '--once') args.once = true
    else if (arg === '--force-bind-any') args.forceBindAny = true
    else if (arg === '--detach') args.detach = true
    else if (arg === '--log-file') args.logFile = argv[++i]
    else if (!args.filePath) args.filePath = arg
    else throw new Error(`unrecognised argument: ${arg}`)
  }
  return args
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function printReadySummary({ filePath, args, filename, token }) {
  console.log('='.repeat(72))
  console.log(`[serve-candidate] serving ${filePath}`)
  console.log(`[serve-candidate] listening on http://${args.bind}:${args.port}/candidate (direct-link interface only)`)
  console.log('[serve-candidate] token (share with the verifier out-of-band; never write it to a file):')
  console.log(`  ${token}`)
  console.log('')
  console.log('[serve-candidate] give the verifier this exact command (fill in the two blanks it does not already know):')
  console.log(
    `  powershell -File tools\\release-packager\\verify-candidate.ps1 -Uri "http://${args.bind}:${args.port}/candidate" ` +
      `-Token "${token}" -OutFile "${filename}" -ExpectedBytes <from declaration> -ExpectedSha256 "<from declaration>"`,
  )
  console.log('='.repeat(72))
}

/** Re-spawn this script as a genuinely OS-detached child, print the ready
 * summary from the LAUNCHER (the real invoking terminal, never redirected
 * to a file), and exit -- leaving the child running independent of
 * whatever shell/tool/session started it. */
function launchDetached(args, filePath, filename) {
  const token = randomBytes(32).toString('hex')
  const logPath = path.resolve(args.logFile ?? path.join(os.tmpdir(), `serve-candidate-${args.port}.log`))
  const logFd = openSync(logPath, 'a')

  const childArgs = [
    THIS_SCRIPT,
    filePath,
    '--port', String(args.port),
    '--bind', args.bind,
    ...(args.once ? ['--once'] : []),
    ...(args.forceBindAny ? ['--force-bind-any'] : []),
  ]

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...process.env, [TOKEN_ENV_VAR]: token },
  })
  closeSync(logFd)
  child.unref()

  printReadySummary({ filePath, args, filename, token })
  console.log(`[serve-candidate] detached: PID ${child.pid}, operational log (no token in it): ${logPath}`)
  console.log('[serve-candidate] this launcher is exiting now; the server keeps running independent of this shell/session.')
}

function runServer(args, filePath, filename) {
  const token = process.env[TOKEN_ENV_VAR] || randomBytes(32).toString('hex')
  const tokenPreSet = Boolean(process.env[TOKEN_ENV_VAR])
  // Pin the candidate before advertising its size. Opening the pathname for
  // every request could pair metadata from the original candidate with bytes
  // from a replacement installed at the same path while the server is alive.
  const candidateFd = openSync(filePath, 'r')
  const stats = fstatSync(candidateFd)
  let servedOnce = false

  const server = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress
    const timestamp = new Date().toISOString()

    if (req.method !== 'GET' || req.url !== '/candidate') {
      console.log(`[serve-candidate] ${timestamp} ${remote} ${req.method} ${req.url} -> 404`)
      res.writeHead(404).end('not found')
      return
    }

    const auth = req.headers.authorization ?? ''
    const expected = `Bearer ${token}`
    if (!timingSafeStringEqual(auth, expected)) {
      console.log(`[serve-candidate] ${timestamp} ${remote} GET /candidate -> 401 (bad or missing token)`)
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('unauthorized')
      return
    }

    console.log(`[serve-candidate] ${timestamp} ${remote} GET /candidate -> 200 (${stats.size} bytes)`)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="${filename}"`,
    })
    if (stats.size === 0) {
      res.end()
      return
    }
    const stream = createReadStream(filePath, {
      fd: candidateFd,
      autoClose: false,
      start: 0,
      end: stats.size - 1,
    })
    stream.pipe(res)
    stream.on('error', (error) => {
      console.error(`[serve-candidate] read error: ${error.message}`)
      res.destroy()
    })
    res.on('finish', () => {
      servedOnce = true
      if (args.once) {
        console.log('[serve-candidate] --once: served successfully, shutting down.')
        server.close()
      }
    })
  })

  server.once('close', () => closeSync(candidateFd))

  server.listen(args.port, args.bind, () => {
    if (tokenPreSet) {
      // Running as the detached child: the launcher already printed the
      // token and verify command to the real terminal. Re-printing it here
      // would write it into this process's redirected log file, which is
      // exactly what launchDetached()'s doc comment promises never happens.
      console.log(`[serve-candidate] (detached child) listening on http://${args.bind}:${args.port}/candidate, serving ${filePath}`)
    } else {
      printReadySummary({ filePath, args, filename, token })
    }
  })

  process.on('SIGINT', () => {
    console.log(`\n[serve-candidate] shutting down (served: ${servedOnce}).`)
    server.close(() => process.exit(0))
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.filePath) {
    console.error(
      'usage: node tools/release-packager/serve-candidate.mjs <path-to-exe> [--port 4787] ' +
        '[--bind <direct-link address>] [--once] [--detach] [--log-file <path>]',
    )
    console.error(
      `  set ${DIRECT_LINK_ENV_VAR} to your direct-link addresses (comma-separated, this ` +
        "machine's own address first). --bind defaults to the first of them; there is no " +
        'built-in default address.',
    )
    process.exitCode = 2
    return
  }
  const filePath = path.resolve(args.filePath)
  if (!existsSync(filePath)) throw new Error(`file does not exist: ${filePath}`)
  const filename = path.basename(filePath)

  const directLinkAddresses = configuredDirectLinkAddresses()
  if (args.bind === null) args.bind = directLinkAddresses[0] ?? null

  if (args.bind === null) {
    throw new Error(
      `no address to bind: ${DIRECT_LINK_ENV_VAR} is unset and no --bind was given. Set it to your ` +
        "direct-link addresses (comma-separated, this machine's own address first), e.g. " +
        `${DIRECT_LINK_ENV_VAR}="<local>,<peer>". There is no built-in default on purpose: a guessed ` +
        "address is somebody else's interface, and this server must never listen on one.",
    )
  }

  if (!directLinkAddresses.includes(args.bind) && !args.forceBindAny) {
    throw new Error(
      `refusing to bind to ${args.bind}: not one of the direct-link addresses declared in ` +
        `${DIRECT_LINK_ENV_VAR} (${directLinkAddresses.length ? directLinkAddresses.join(', ') : 'unset'}). ` +
        'Declare it there, or pass --force-bind-any to override -- but that widens this beyond the ' +
        'configured direct link on purpose, so think first.',
    )
  }

  if (args.detach) {
    launchDetached(args, filePath, filename)
    return
  }

  runServer(args, filePath, filename)
}

main().catch((error) => {
  console.error(`[serve-candidate] ${error.message}`)
  process.exitCode = 1
})
