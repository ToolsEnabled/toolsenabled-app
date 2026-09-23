import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dependencies from './lib/native-driver-dependencies.cjs'

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--verify')) throw new Error('Only --verify is supported')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const receipt = args[0] === '--verify'
  ? await dependencies.verifyNativeTestDependencies(root)
  : await dependencies.prepareNativeTestDependencies(root)
console.log(JSON.stringify(receipt))
