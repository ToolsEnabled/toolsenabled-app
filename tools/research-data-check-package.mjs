import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { connectedSource, tableStream } from '../src/research-data-sources.mjs'
import { inspectPackage, inspectSchema, validateTable, relativeDataPath } from '../src/research-data-package.mjs'

const args = process.argv.slice(2)
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const url = option('--source')
if (!url) throw new Error('Use --source <folder connection URL> [--package datapackage.json] [--all-files] [--report report.json].')
const manifestPath = relativeDataPath(option('--package', 'datapackage.json'))
const base = manifestPath.split('/').slice(0, -1).join('/')
const resolve = path => relativeDataPath(base ? base + '/' + path : path)
const source = await connectedSource(url)
const manifest = await source.text(manifestPath, 8 * 1024 * 1024)
if (manifest.truncated) throw new Error('Descriptor exceeds 8 MiB.')
const resources = inspectPackage(JSON.parse(manifest.text)), files = []
for (const resource of resources) {
  if (typeof resource.schema === 'string') resource.schema = inspectSchema(JSON.parse((await source.text(resolve(resource.schema), 8 * 1024 * 1024)).text))
  const selected = args.includes('--all-files') ? resource.paths : resource.paths.slice(0, 1)
  for (const path of selected) {
    const result = await validateTable(await tableStream(source, resolve(path)), resource)
    files.push({ resource: resource.name, path, ...result })
  }
}
const report = { ok: files.every(file => file.errorCount === 0), folder: source.name, descriptor: manifestPath, descriptor_sha256: createHash('sha256').update(manifest.text).digest('hex'), scope: args.includes('--all-files') ? 'Every referenced file, each checked separately.' : 'First file in each resource, checked to EOF; other partitions are not checked by this run.', files }
if (option('--report')) await writeFile(option('--report'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1
