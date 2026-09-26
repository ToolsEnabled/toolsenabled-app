import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateAgainstSchema } from './gen-projection-lib.mjs'

const defaultDataDirectory = fileURLToPath(new URL('../public/data/', import.meta.url))

/* THE OPERATOR'S OWN CATALOGUE IS CHECKED HERE TOO, BECAUSE NOTHING ELSE CAN.
 *
 * public/data/purchase-catalog.json used to be validated by the walk below, for
 * free, because it sat in the shipped data directory -- which is exactly the
 * problem: it was the operator's private shopping list and it shipped to
 * strangers inside app.asar. Moving it to private/ took it out of the payload
 * and out of this walk in the same motion, and a validation that disappears
 * along with the file is how a move becomes a regression nobody sees.
 *
 * So it is validated by name, against the schema that is still a product asset.
 * Absent is a legitimate state -- most machines have no operator catalogue and
 * should not -- but it is PRINTED rather than passed over, because a gate that
 * is silent about the case where it did nothing teaches its reader that it ran. */
const operatorCatalogPath = fileURLToPath(new URL('../private/purchase-catalog.owner.json', import.meta.url))
const operatorCatalogSchemaPath = fileURLToPath(new URL('../public/data/schema/purchase-catalog.schema.json', import.meta.url))
const operatorCatalogLabel = 'private/purchase-catalog.owner.json'

async function checkOperatorCatalog() {
  let source
  try {
    source = await readFile(operatorCatalogPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      process.stdout.write(`No operator purchase list at ${operatorCatalogLabel}; nothing to validate for it.\n`)
      return null
    }
    return `${operatorCatalogLabel} is present but unreadable: ${error.message}`
  }
  let data
  try {
    data = JSON.parse(source)
  } catch (error) {
    return `${operatorCatalogLabel} is not valid JSON: ${error.message}`
  }
  const schema = await readJson(operatorCatalogSchemaPath, 'schema for the operator purchase list')
  const errors = validateAgainstSchema(data, schema, schema, '$')
  if (errors.length > 0) {
    return `${operatorCatalogLabel}: schema validation failed:\n${errors.slice(0, 12).map(error => `  - ${error}`).join('\n')}`
  }
  process.stdout.write(`Validated the operator purchase list at ${operatorCatalogLabel}.\n`)
  return null
}

async function readJson(path, label) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${error.message}`)
  }

  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
}

async function main() {
  const dataDirectory = resolve(process.argv[2] ?? defaultDataDirectory)
  let entries
  try {
    entries = await readdir(dataDirectory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`data directory is missing or unreadable at ${dataDirectory}: ${error.message}`)
  }

  const dataFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort()

  if (dataFiles.length === 0) {
    process.stdout.write('Discovered 0 JSON data files; validated 0.\n')
    throw new Error(`discovered zero JSON data files in ${dataDirectory}; refusing to pass`)
  }

  const failures = []
  let validated = 0
  for (const fileName of dataFiles) {
    const stem = fileName.slice(0, -'.json'.length)
    const dataPath = join(dataDirectory, fileName)
    const schemaPath = join(dataDirectory, 'schema', `${stem}.schema.json`)
    try {
      const [data, schema] = await Promise.all([
        readJson(dataPath, `data file ${fileName}`),
        readJson(schemaPath, `schema for ${fileName}`),
      ])
      const errors = validateAgainstSchema(data, schema, schema, '$')
      if (errors.length > 0) {
        failures.push(`${fileName}: schema validation failed:\n${errors.slice(0, 12).map(error => `  - ${error}`).join('\n')}`)
        continue
      }
      validated += 1
    } catch (error) {
      failures.push(`${fileName}: ${error.message}`)
    }
  }

  process.stdout.write(`Discovered ${dataFiles.length} JSON data files; validated ${validated}.\n`)

  // Only when the default (authored) directory is the one under inspection: a
  // caller pointing this at a built or packaged copy is asking about that copy,
  // and the operator's file is deliberately in neither.
  if (dataDirectory === resolve(defaultDataDirectory)) {
    const operatorFailure = await checkOperatorCatalog()
    if (operatorFailure) failures.push(operatorFailure)
  }

  if (failures.length > 0) {
    process.stderr.write(`Data schema check failed:\n${failures.map(failure => `- ${failure}`).join('\n')}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`Data schema check passed for ${dataDirectory}.\n`)
}

main().catch(error => {
  process.stderr.write(`Data schema check failed: ${error.message}\n`)
  process.exitCode = 1
})
