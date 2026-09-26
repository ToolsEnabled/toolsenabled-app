// Optional read-only local folder connection for the Research browser workspace.
// No dependency on any particular dataset. No writes, shell execution, or remote reads.
import http from 'node:http'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { lstat, realpath, readdir, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relativeDataPath } from '../src/research-data-package.mjs'

export async function createResearchDataServer({ root, origin, packages = [], port = 0 }) {
  const allowedOrigin = new URL(origin)
  if (!['127.0.0.1', 'localhost'].includes(allowedOrigin.hostname) || allowedOrigin.origin !== origin) throw new Error('Use an exact local UI origin.')
  const folder = await realpath(root)
  if (!(await lstat(folder)).isDirectory()) throw new Error('The research root must be a directory.')
  const locate = async relative => {
    if (!relative) return folder
    const parts = relativeDataPath(relative).split('/'); let target = folder
    for (const part of parts) {
      if (part.startsWith('.')) throw new Error('Hidden files are not exposed by the folder connection.')
      target = path.join(target, part)
      if ((await lstat(target)).isSymbolicLink()) throw new Error('Linked paths are not exposed by the folder connection.')
    }
    const resolved = await realpath(target), rel = path.relative(folder, resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('File is outside the selected folder.')
    return resolved
  }
  packages.forEach(relativeDataPath)
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)) }
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Vary', 'Origin')
    const actualPort = server.address()?.port
    if (request.headers.host !== `127.0.0.1:${actualPort}`) return send(403, { error: 'Host refused.' })
    if (request.headers.origin && request.headers.origin !== origin) return send(403, { error: 'Origin refused.' })
    response.setHeader('Access-Control-Allow-Origin', origin)
    if (request.method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Methods', 'GET'); response.writeHead(204); response.end(); return }
    if (request.method !== 'GET') return send(405, { error: 'This folder connection is read-only.' })
    try {
      const url = new URL(request.url, `http://127.0.0.1:${actualPort}`)
      if (url.pathname === '/workspace') return send(200, { name: path.basename(folder), packages })
      const relative = url.searchParams.get('path') || '', target = await locate(relative)
      if (url.pathname === '/entries') {
        const entries = (await readdir(target, { withFileTypes: true })).filter(item => !item.name.startsWith('.') && !item.isSymbolicLink())
        if (entries.length > 20000) throw new Error('This folder exceeds 20,000 entries. Open a smaller research folder.')
        return send(200, { entries: entries.map(item => ({ name: item.name, path: relative ? relative + '/' + item.name : item.name, kind: item.isDirectory() ? 'directory' : 'file' })) })
      }
      if (!relative || !(await lstat(target)).isFile()) return send(400, { error: 'Select a regular file.' })
      if (url.pathname === '/preview') {
        const limit = Number(url.searchParams.get('limit') || 1024 * 1024)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024) throw new Error('Preview limit must be between 1 byte and 8 MiB.')
        const file = await open(target, 'r')
        try { const stat = await file.stat(), bytes = Buffer.alloc(Math.min(stat.size, limit)); await file.read(bytes, 0, bytes.length, 0); return send(200, { text: bytes.toString('utf8'), size: stat.size, truncated: stat.size > bytes.length }) }
        finally { await file.close() }
      }
      if (url.pathname === '/file') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        const stream = createReadStream(target); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response); return
      }
      return send(404, { error: 'Unknown folder operation.' })
    } catch (error) { if (!response.headersSent) send(400, { error: error.code === 'ENOENT' ? 'File is not available in this folder.' : error.message }); else response.destroy() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1]
  if (!args.includes('--root') || !args.includes('--origin')) throw new Error('Use --root <research folder> --origin <local UI origin> [--port 4624] [--package relative/datapackage.json].')
  const packages = args.flatMap((arg, i) => arg === '--package' ? [args[i + 1]] : [])
  const server = await createResearchDataServer({ root: value('--root'), origin: value('--origin'), packages, port: args.includes('--port') ? Number(value('--port')) : 0 })
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, root: path.resolve(value('--root')), packages }))
}
