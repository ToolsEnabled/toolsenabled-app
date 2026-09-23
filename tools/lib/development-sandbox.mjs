import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ordinaryPath } from './development-session.mjs'

export function developmentSandboxProfile(session) {
  if (process.platform !== 'linux') throw Error('AppArmor profiles apply only to native Linux sessions')
  if (!/^[a-f0-9-]{36}$/.test(session.id)) throw Error('Invalid session identity for sandbox policy')
  const executable = ordinaryPath(path.join(session.paths.app, 'node_modules/electron/dist/electron'), { directory: false })
  // AppArmor path patterns have their own grammar. An exact attachment must
  // never become a wildcard grant or inject another policy statement.
  if (/[\x00-\x1f\x7f"\\*?\[\]{}^]/.test(executable)) throw Error('This session path cannot be represented as an exact AppArmor attachment')
  return `abi <abi/4.0>,\ninclude <tunables/global>\nprofile toolsenabled-session-${session.id} "${executable}" flags=(unconfined) {\n  userns,\n}\n`
}

export function configureDevelopmentSandbox(session) {
  if (process.platform !== 'linux') return { required: false, reason: 'native Windows sandbox' }
  const restriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
  if (!fs.existsSync(restriction) || fs.readFileSync(restriction, 'utf8').trim() !== '1') {
    return { required: false, reason: 'kernel does not require an AppArmor user-namespace grant' }
  }
  const policy = developmentSandboxProfile(session)
  const file = ordinaryPath(path.join(session.paths.evidence, 'electron.apparmor'), { missing: true, directory: false })
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== policy) throw Error('Session sandbox policy changed')
  } else fs.writeFileSync(file, policy, { flag: 'wx', mode: 0o600 })
  // One exact executable attachment; no service restart, global restriction
  // change, wildcard, persisted system file, or Chromium sandbox bypass.
  const result = spawnSync('sudo', ['-n', '/usr/sbin/apparmor_parser', '--replace', '--skip-cache', '--jobs=1', file], {
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  })
  if (result.error || result.status !== 0) throw Object.assign(Error('The exact session sandbox policy could not be loaded: '
    + (result.error?.message || result.stderr.trim()) + '. Policy retained at ' + file), {
    cleanupConfirmed: !result.error && result.status !== null,
  })
  return { required: true, loaded: true, file, profile: 'toolsenabled-session-' + session.id }
}
