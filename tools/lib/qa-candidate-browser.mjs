import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import rendererSubject from './qa-renderer-dist.cjs'

const require = createRequire(import.meta.url)
const { releaseArgument, selectRendererDist, rendererRequestPath } = rendererSubject
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }

// A browser renderer proof, not a native shell or account-service substitute.
// Only packed dist files are served. There are no synthetic API responses,
// source overlays, extracted files, proxy requests or authenticated sessions.
export async function serveCandidateRenderer({ argv = process.argv, environment = process.env, repoRoot } = {}) {
  if (releaseArgument(argv) === null) return null
  if (environment.APP_ORIGIN || (environment.APP_PATH && environment.APP_PATH !== '/')) {
    throw new Error('--release cannot be combined with APP_ORIGIN or a non-root APP_PATH')
  }
  const subject = selectRendererDist({ argv, repoRoot })
  const asar = require('@electron/asar')
  const packed = asar.statFile(subject.provenance.archive, 'dist', false)
  const files = new Set()
  const walk = (entry, prefix = '') => {
    for (const [name, value] of Object.entries(entry.files)) {
      const relative = prefix + name
      if (value.files) walk(value, relative + '/')
      else files.add(relative)
    }
  }
  walk(packed)
  const assetFor = requestUrl => {
    const selected = rendererRequestPath(subject.dist, requestUrl)
    if (!selected) return null
    const relative = path.relative(subject.dist, selected).split(path.sep).join('/')
    return files.has(relative) ? relative : null
  }
  let origin, failure
  const stats = { served: 0, refused: 0, bytes: 0 }
  const server = http.createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)) {
      stats.refused++
      response.writeHead(405).end()
      return
    }
    const relative = assetFor(request.url)
    if (!relative) { stats.refused++; response.writeHead(404).end(); return }
    try {
      const archivePath = path.join('dist', ...relative.split('/'))
      const info = asar.statFile(subject.provenance.archive, archivePath, false)
      if (!Number.isSafeInteger(info.size) || info.size > 32 * 1024 * 1024) throw new Error('candidate browser asset exceeds 32 MiB')
      const bytes = asar.extractFile(subject.provenance.archive, archivePath)
      if (bytes.length !== info.size) throw new Error('candidate browser asset length changed')
      stats.served++
      stats.bytes += request.method === 'HEAD' ? 0 : bytes.length
      response.writeHead(200, {
        'content-type': TYPES[path.extname(relative).toLowerCase()] || 'application/octet-stream',
        'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "connect-src 'self'; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'",
      })
      response.end(request.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      failure ||= error
      response.writeHead(500).end()
    }
  })
  server.on('upgrade', (_request, socket) => { stats.refused++; socket.destroy() })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  let closure
  return Object.freeze({ origin, stats,
    provenance: Object.freeze({ ...subject.provenance, proofScope: 'candidate-renderer-in-emulated-browser' }),
    staticPath: requestUrl => assetFor(requestUrl) !== null,
    assertUnchanged: subject.assertUnchanged,
    close() {
      if (!closure) closure = new Promise((resolve, reject) => {
        server.close(error => {
          try {
            subject.assertUnchanged()
            if (error || failure) throw error || failure
            resolve()
          } catch (cause) { reject(cause) }
        })
        server.closeAllConnections()
      })
      return closure
    },
  })
}

export function geometryRequestAllowed({ origin, url, method, staticPath } = {}) {
  try {
    const request = new URL(url)
    if (!['GET', 'HEAD'].includes(method) || request.origin !== origin || request.username || request.password) return false
    if (staticPath) return staticPath(request.pathname)
    // Development/explicit web mode still does not authorize account or agent
    // APIs. Vite's own script modules are static development assets, not RPC.
    if (/\/(?:v1|api|rpc)(?:\/|$)/i.test(request.pathname)) return false
    return /\.(?:html|css|js|mjs|json|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|wasm)$/i.test(request.pathname)
      || request.pathname.endsWith('/') || /^\/@(?:vite|id)\//.test(request.pathname)
  } catch { return false }
}

export async function fenceGeometryContext(context, { origin, staticPath } = {}) {
  if (typeof context.routeWebSocket !== 'function') {
    throw new Error('geometry QA requires browser-context WebSocket blocking support before any page opens')
  }
  const blocked = { http: 0, websocket: 0 }
  await context.routeWebSocket('**/*', socket => { blocked.websocket++; socket.close() })
  await context.route('**/*', route => {
    const request = route.request()
    if (geometryRequestAllowed({ origin, staticPath, url: request.url(), method: request.method() })) return route.continue()
    blocked.http++
    return route.abort('blockedbyclient')
  })
  return blocked
}

// Passed to page.evaluate; this function deliberately captures no Node state.
export function visibleGeometryPressPoint(selector) {
  for (const node of document.querySelectorAll(selector)) {
    if (node.disabled || node.closest('[hidden], [inert], [aria-hidden="true"]')) continue
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (!box.width || !box.height || style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) continue
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
    const hit = document.elementFromPoint(x, y)
    if (hit !== node && !node.contains(hit)) continue
    return { x, y, name: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 80) }
  }
  return null
}
