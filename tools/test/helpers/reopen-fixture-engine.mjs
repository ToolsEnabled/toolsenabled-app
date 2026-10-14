import { cpSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)

// A private payload clone keeps ACP discovery from changing other suites'
// fixture capabilities. Every provider launcher is mocked; none runs a CLI.
export function reopenFixtureEngine(directory, provider) {
  const root = fileURLToPath(new URL('../fixtures/confined-engine', import.meta.url))
  const selected = provider === 'gemini' ? path.join(directory, 'fixture-engine') : root
  if (selected !== root) {
    cpSync(root, selected, { recursive: true })
    writeFileSync(path.join(selected, 'src/lib/agent-engine/acp-process.js'),
      "'use strict';\nmodule.exports = { ROOT_ADMISSION_CONTRACT_VERSION: 1, MODEL_SELECTION_CONTRACT_VERSION: 1, startAcpSession() { throw new Error('fixture not staged') }, resumeAcpSession() { throw new Error('fixture not staged') } };\n")
  }
  const enginePath = path.join(selected, 'src/lib/agent-engine/codex-process.js')
  const moduleName = provider === 'claude' ? 'claude-cli-process.js' : provider === 'gemini' ? 'acp-process.js' : 'codex-process.js'
  return { enginePath, engine: require(path.join(selected, 'src/lib/agent-engine', moduleName)),
    start: provider === 'claude' ? 'startClaudeSession' : provider === 'gemini' ? 'startAcpSession' : 'startCodexSession',
    resume: provider === 'claude' ? 'resumeClaudeSession' : provider === 'gemini' ? 'resumeAcpSession' : 'resumeCodexSession' }
}
