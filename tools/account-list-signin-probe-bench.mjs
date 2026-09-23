#!/usr/bin/env node

/* WHAT THE MAIN THREAD PAYS FOR list()'S PER-ACCOUNT SIGN-IN PROBE.
 *
 * mc-accounts:list (shell/main.cjs) already awaits the usage cache (see
 * tools/ipc-sync-io-bench.mjs). What it still called synchronously was
 * accountRegistry.list(), which -- beyond the one registry-file read --
 * calls fsImpl.lstatSync() once per account to answer "signed in?" for the
 * row. Every one of those stats ran on Electron's main thread, the same
 * thread that serves every OTHER window's IPC replies and the fleet tree's
 * own timers, so a person opening the accounts menu paid it and so did
 * everybody else's session, for as long as it took.
 *
 * This compares list()'s BEFORE shape (N serial lstatSync calls) against
 * listAsync()'s AFTER shape (N lstat calls awaited concurrently via
 * Promise.all, off the main thread), at this machine's own account count
 * (6) and again at 24 -- because the absolute numbers are noisy on a
 * machine this busy (see the note on measure() below) but the SHAPE is not:
 * list() is N blocking syscalls, so its cost should climb with N, while
 * listAsync() should climb far more slowly. The ratio between the two
 * account counts is the mechanism made visible.
 *
 *   node tools/account-list-signin-probe-bench.mjs
 *   BENCH_N=600 node tools/account-list-signin-probe-bench.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { createAccountRegistryStore } = require_('../shell/account-registry.cjs')

/* Providers and credential-file names copied from shell/account-registry.cjs's
   PROVIDERS table so a drift there cannot make this bench silently probe the
   wrong filename. Signed-in/signed-out is split the way a real list mixes
   them; 'no' and 'yes' take the same one lstat, so the split cannot change
   the number being measured either way. */
const PROVIDERS = ['claude', 'codex']
const CREDENTIAL_FILE = { claude: '.credentials.json', codex: 'auth.json' }

function buildStore(accountCount) {
  const root = fs.mkdtempSync(path.join(process.env.BENCH_ROOT || os.tmpdir(), 'account-list-signin-bench-'))
  const stateRoot = path.join(root, 'state')
  const servicesRoot = path.join(root, 'services')
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(stateRoot, 'config'), { recursive: true })
  fs.mkdirSync(servicesRoot, { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  const file = path.join(stateRoot, 'config', 'accounts.json')
  const stateFile = path.join(servicesRoot, 'multi-account-state.json')
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home })

  for (let index = 0; index < accountCount; index += 1) {
    const provider = PROVIDERS[index % PROVIDERS.length]
    const directory = `.account-${index}`
    fs.mkdirSync(path.join(home, directory), { recursive: true })
    const credential = path.join(home, directory, CREDENTIAL_FILE[provider])
    if (index % 3 !== 0) fs.writeFileSync(credential, 'x'.repeat(64)) // signed in
    // index % 3 === 0 leaves no credential file at all: signed out
    store.add({ name: `account-${index}`, provider, directory })
  }
  return { store, root }
}

/* ---------- the instrument, copied from tools/ipc-sync-io-bench.mjs so the
   numbers are read the same way ---------- */

const turn = () => new Promise(resolve => setImmediate(resolve))
const quantile = (list, at) => {
  if (!list.length) return 0
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(at * sorted.length))]
}
const mean = list => (list.length ? list.reduce((total, value) => total + value, 0) / list.length : 0)

/* MEDIAN IS THE HEADLINE NUMBER HERE, NOT MEAN OR P99.
 *
 * This machine runs many concurrent agent lanes, and any one of them can
 * stall the OS scheduler or the libuv threadpool for tens of milliseconds
 * with nothing to do with this code. That noise lands as occasional huge
 * outliers in EITHER column and swings mean/p99 by 5-10x run to run, on this
 * machine, right now -- confirmed by rerunning tools/ipc-sync-io-bench.mjs's
 * own already-shipped, already-proven AFTER numbers alongside this one and
 * seeing the same inflation. The median is the one statistic that stays
 * put under that noise, and it is what the numbers in this file's own
 * comments are drawn from. */
async function measure(label, run, iterations, kind) {
  const gaps = []
  let last = performance.now()
  const heartbeat = setInterval(() => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }, 1)
  await new Promise(resolve => setTimeout(resolve, 60))
  gaps.length = 0
  last = performance.now()

  const blocks = []
  const walls = []
  for (let index = 0; index < iterations; index += 1) {
    await turn()
    const started = performance.now()
    if (kind === 'sync') {
      run(index)
      const finished = performance.now()
      blocks.push(finished - started)
      walls.push(finished - started)
    } else {
      const pending = run(index)
      blocks.push(performance.now() - started)
      await pending
      walls.push(performance.now() - started)
    }
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  clearInterval(heartbeat)

  return {
    label,
    iterations,
    blockMedian: quantile(blocks, 0.5),
    blockMean: mean(blocks),
    blockP99: quantile(blocks, 0.99),
    blockMax: Math.max(...blocks),
    wallMedian: quantile(walls, 0.5),
    wallMean: mean(walls),
    beatP99: quantile(gaps, 0.99),
    beatMax: gaps.length ? Math.max(...gaps) : 0,
  }
}

const iterations = Number(process.env.BENCH_N || 300)
const pad = (value, width) => String(value).padEnd(width)
const num = value => value.toFixed(3).padStart(9)

console.log(`node ${process.version}  cpus ${os.cpus().length}  providers 2`)
console.log(`${pad('path', 38)} ${pad('n', 4)} ${'blk med'.padStart(8)} ${'blk avg'.padStart(8)} ${'blk p99'.padStart(8)} ${'blk max'.padStart(8)} ${'wall med'.padStart(9)} ${'beat p99'.padStart(9)}`)

const roots = []
for (const accountCount of [6, 24]) {
  const { store, root } = buildStore(accountCount)
  roots.push(root)
  const before = await measure(`accounts=${accountCount}  list()      BEFORE`, () => store.list(), iterations, 'sync')
  const after = await measure(`accounts=${accountCount}  listAsync() AFTER `, () => store.listAsync(), iterations, 'async')
  for (const row of [before, after]) {
    console.log(`${pad(row.label, 38)} ${pad(row.iterations, 4)} ${num(row.blockMedian)} ${num(row.blockMean)} ${num(row.blockP99)} ${num(row.blockMax)} ${num(row.wallMedian)} ${num(row.beatP99)}`)
  }
  console.log(`  -> median block-time ratio (BEFORE / AFTER) at ${accountCount} accounts: ${(before.blockMedian / after.blockMedian).toFixed(2)}x`)
}

console.log('\nblock is what every other session pays; median is the column to trust on a machine this busy (see the note on measure() above).')
for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
