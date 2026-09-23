#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { main } from './dev-environment.mjs'
import { ordinaryPath } from './lib/development-session.mjs'

// The normal developer entry point creates a new workspace for every window.
// Reuse is explicit, so pressing DEV twice cannot retarget a running window.
export async function startDevelopment(argv = process.argv.slice(2)) {
  const options = {}, booleans = new Set(['watch', 'inspect', 'refresh', 'help'])
  const values = new Set(['session', 'directory', 'app', 'engine', 'npm-cli', 'privacy-profile'])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (!argv[i].startsWith('--') || Object.hasOwn(options, key)) throw Error('Unknown or duplicate DEV option: ' + argv[i])
    if (booleans.has(key)) options[key] = true
    else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i]
    else throw Error('Unknown or incomplete DEV option: ' + argv[i])
  }
  if (options.help) {
    console.log('Usage: npm run app -- [--watch] [--engine SOURCE] [--directory NEW_SESSION]\n'
      + '       npm run app -- --session EXISTING_SESSION [--refresh] [--watch]\n'
      + 'Each new launch prepares independent committed app/engine sources, dependencies and state.\n'
      + 'Edit the displayed session app directory. Reopen it with --session; close it before --refresh.\n'
      + 'npm run dev opens the same session workflow with a renderer watcher.\n'
      + 'Use npm run dev:session -- help for frozen CUT preparation and qualification requirements.')
    return
  }
  if (options.session && ['directory', 'app', 'engine', 'privacy-profile'].some(key => options[key])) {
    throw Error('Choose an existing DEV session or new source inputs')
  }
  const app = path.resolve(options.app || fileURLToPath(new URL('..', import.meta.url)))
  const nativeNpmCandidates = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ]
  const npm = options['npm-cli'] || nativeNpmCandidates.find(file => fs.existsSync(file))
  if ((!options.session || options.refresh) && !npm) throw Error('Use --npm-cli with the selected native Node installation\'s npm-cli.js')
  const args = ['start']
  if (options.session) args.push('--session', options.session)
  else {
    let engine = options.engine
    if (!engine) {
      const binding = ordinaryPath(path.join(app, 'private/capability-source.owner.json'), { directory: false })
      engine = JSON.parse(fs.readFileSync(binding, 'utf8')).path
    }
    ordinaryPath(engine)
    let directory = options.directory
    if (!directory) {
      const parent = path.join(os.userInfo().homedir, '.toolsenabled-development', 'sessions')
      ordinaryPath(parent, { missing: true })
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
      directory = path.join(parent, 'dev-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8))
    }
    args.push('--directory', directory, '--app', app, '--engine', engine)
    const privacy = options['privacy-profile'] || path.join(app, 'private/owner-data-patterns.owner.json')
    if (options['privacy-profile'] || fs.existsSync(privacy)) args.push('--privacy-profile', privacy)
  }
  if (npm) args.push('--npm-cli', npm)
  if (options.watch) args.push('--watch')
  if (options.inspect) args.push('--inspect')
  if (options.refresh) args.push('--refresh')
  await main(args)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDevelopment().catch(error => { console.error(error.message); process.exitCode = 1 })
}
