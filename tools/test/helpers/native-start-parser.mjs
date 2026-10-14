import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseAst } from 'rollup/parseAst'

// Mount the actual Electron start parser without importing Electron or opening
// any native profile. The engine root is the paired test source checkout.
const mainUrl = new URL('../../../shell/main.cjs', import.meta.url)
const main = readFileSync(mainUrl, 'utf8')
const ast = parseAst(main)
const names = ['agentPayload', 'boundedAgentString', 'boundedAgentModel', 'parseResearchStart', 'parseAgentStart']
const declarations = names.map(name => {
  const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name)
  if (!node) throw new Error('The native start parser is unavailable: ' + name)
  return main.slice(node.start, node.end)
}).join('\n')
const constantNames = ['MAX_SESSION_ID_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH', 'AGENT_EFFORT_VALUES']
const constants = constantNames.map(name => {
  const declaration = ast.body.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations).find(node => node.id.name === name)
  if (!declaration) throw new Error('The native start parser constant is unavailable: ' + name)
  return 'const ' + main.slice(declaration.start, declaration.end) + ';'
}).join('\n')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
export const parseNativeStart = new Function('require', 'randomUUID', 'path', 'resolveCapabilityRoot', 'agentIpcError',
  constants + '\nconst { MAX_NAME_LENGTH: MAX_ACCOUNT_NAME_LENGTH } = require("./account-registry.cjs");\n' +
  declarations + '\nreturn parseAgentStart')(
  createRequire(mainUrl), randomUUID, path,
  () => process.env.TOOLSENABLED_SOURCE || fileURLToPath(new URL('../../../../engine', import.meta.url)), fail)
