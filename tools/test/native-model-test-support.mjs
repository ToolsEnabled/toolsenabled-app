import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { parseAst } from 'rollup/parseAst'
import { canonicalRootForTests } from '../canonical-root.mjs'

export const ROOT = resolve(import.meta.dirname, '..', '..')
export const ENGINE_ROOT = canonicalRootForTests({ requireConfigured: true })
export const requireShell = createRequire(new URL('../../shell/main.cjs', import.meta.url))

// Execute production declarations without launching Electron or the app.
export function mainModelParsers() {
  const source = readFileSync(resolve(ROOT, 'shell/main.cjs'), 'utf8')
  const ast = parseAst(source)
  const functions = ['agentIpcError', 'agentPayload', 'boundedAgentString',
    'boundedAgentModel', 'parseAgentStart', 'parseAgentSend', 'parseAgentSessionCommand']
  const limits = ['MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH', 'MAX_CWD_LENGTH',
    'MAX_SURFACE_LENGTH', 'AGENT_EFFORT_VALUES']
  const declarations = functions.map(name => {
    const nodes = ast.body.filter(node => node.type === 'FunctionDeclaration' && node.id.name === name)
    assert.equal(nodes.length, 1, 'Production parser declaration must be unambiguous')
    return source.slice(nodes[0].start, nodes[0].end)
  })
  for (const name of limits) {
    const nodes = ast.body.filter(node => node.type === 'VariableDeclaration')
      .flatMap(node => node.declarations).filter(node => node.id.name === name)
    assert.equal(nodes.length, 1, 'Production parser bound must be unambiguous')
    declarations.push('const ' + source.slice(nodes[0].start, nodes[0].end) + ';')
  }
  return new Function('require', 'resolveCapabilityRoot', 'randomUUID', 'MAX_ACCOUNT_NAME_LENGTH',
    declarations.join('\n') + '\nreturn { parseAgentStart, parseAgentSend, parseAgentSessionCommand };'
  )(requireShell, () => ENGINE_ROOT, () => 'fixture-generated-session', requireShell('./account-registry.cjs').MAX_NAME_LENGTH)
}
