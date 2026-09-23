import { createServer } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { previewFiles } from './chat-changes-fixture.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workspace = path.resolve(process.argv[2] || path.join(repo, '../preview-workspace'))
const { createDiffFiles } = createRequire(import.meta.url)('../../shell/diff-file.cjs')
fs.mkdirSync(workspace, { recursive: true })
for (const file of previewFiles) {
  const target = path.join(workspace, file.path)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (!fs.existsSync(target)) fs.writeFileSync(target, file.after)
}
const files = createDiffFiles({ fs, path, randomUUID, workspaceRoots: () => [workspace] })
const previewMiddleware = async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') { res.statusCode = 405; res.end('{}'); return }
  if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:4693' && req.headers.origin !== 'http://localhost:4693') { res.statusCode = 403; res.end('{}'); return }
  let body = ''
  try {
    for await (const chunk of req) { body += chunk; if (body.length > 1200000) throw new Error('Request too large') }
    const request = JSON.parse(body)
    const target = typeof request.path === 'string' ? request.path : ''
    const result = req.url === '/read' ? files.readChange(path.resolve(workspace, target))
      : req.url === '/stamp' ? files.stamp(target)
        : req.url === '/save' ? files.write(target, request.text) : { ok: false }
    res.end(JSON.stringify(result))
  } catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false })) }
}
const server = await createServer({ root: repo, cacheDir: path.join(workspace, '.vite'), server: { host: '127.0.0.1', port: 4693, strictPort: true, fs: { allow: [repo, fs.realpathSync(path.join(repo, 'node_modules'))] } }, plugins: [{
  name: 'chat-changes-preview', configureServer(server) { server.middlewares.use('/__change-preview', previewMiddleware) },
}] })
await server.listen()
console.log('Preview: http://127.0.0.1:4693/tools/previews/chat-changes.html')
