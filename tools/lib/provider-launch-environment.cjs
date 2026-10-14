'use strict'

// The QA process handles directory names and API environment variables only.
// The official provider CLI owns its existing sign-in home in place.
const path = require('node:path')
const os = require('node:os')

const PROVIDERS = Object.freeze({
  codex: { home: 'CODEX_HOME', flags: ['--codex-home', '--codex-profile-home'], keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
  claude: { home: 'CLAUDE_CONFIG_DIR', flags: ['--claude-config-dir'], keys: ['ANTHROPIC_API_KEY'] },
  gemini: { home: 'GEMINI_CLI_HOME', flags: ['--gemini-home'], keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
})

function refusal(reason) {
  const error = new Error(`QA_PROVIDER_LAUNCH_REFUSED:${reason}`)
  error.code = 'QA_PROVIDER_LAUNCH_REFUSED'
  error.reason = reason
  return error
}

function requestedHome(flags, argv) {
  let home
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const flag = flags.find(name => arg === name || arg.startsWith(name + '='))
    if (!flag) continue
    if (home !== undefined) throw refusal('duplicate_provider_home')
    home = arg === flag ? argv[++index] : arg.slice(flag.length + 1)
    if (typeof home !== 'string' || !home || home.startsWith('--')) throw refusal('provider_home_value_required')
  }
  return home
}

function providerLaunchEnvironment(provider, base, { argv = process.argv.slice(2),
  source = process.env, platform = process.platform, accountHome = os.homedir() } = {}) {
  const environment = { ...base }
  for (const config of Object.values(PROVIDERS)) for (const key of Object.keys(environment)) {
    if (config.keys.includes(key.toUpperCase())) delete environment[key]
  }
  for (const key of Object.keys(environment)) {
    if (['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key.toUpperCase())) delete environment[key]
  }
  for (const name of Array.isArray(provider) ? provider : [provider]) {
    const selected = PROVIDERS[name]
    if (!selected) throw refusal('unsupported_provider')
    const home = requestedHome(selected.flags, argv)
    const api = platform === 'win32' ? path.win32 : path.posix
    if (home !== undefined) {
      if (!api.isAbsolute(home) || home.includes('\0') || api.normalize(home) !== home) throw refusal('provider_home_must_be_absolute')
      if (platform === 'win32') {
        const owner = /^([a-z]:\\users\\[^\\]+)(?:\\|$)/i.exec(accountHome)?.[1]
        const profile = /^([a-z]:\\users\\[^\\]+)(?:\\|$)/i.exec(home)?.[1]
        if (!owner || !profile || owner.toLowerCase() !== profile.toLowerCase() || /^\\\\/.test(home)) throw refusal('provider_home_outside_owning_profile')
      }
    }
    const suppliedKeys = selected.keys.filter(name => typeof source[name] === 'string' && source[name].trim())
    if (home === undefined && suppliedKeys.length === 0) throw refusal('explicit_provider_home_or_api_key_required')
    if (home !== undefined) environment[selected.home] = home
    for (const key of suppliedKeys) environment[key] = source[key]
  }
  return environment
}

module.exports = { providerLaunchEnvironment }
