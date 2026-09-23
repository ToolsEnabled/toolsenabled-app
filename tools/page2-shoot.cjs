/* Page-2 visual shooter. Serves dist/ exactly like the desktop shell does and
   captures the computers view at real window sizes, in the real read mode the
   owner gets on launch (LIVE by default) — the gap the test harnesses hid.

   node shell/launch.cjs is the human shell; this keeps its own window.
   Usage: electron tools/page2-shoot.cjs --out <dir> [--themes tan,white,black]
          [--sizes 1920x1080,1440x900] [--modes live,simulated] [--route computers] */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const http = require('http')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const delay = ms => new Promise(r => setTimeout(r, ms))

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

function serveDist() {
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.woff2': 'font/woff2', '.woff': 'font/woff',
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      const requested = path.resolve(DIST, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!requested.startsWith(DIST)) { response.writeHead(403); response.end(); return }
      fs.readFile(requested, (error, data) => {
        if (error) {
          // SPA fallback, same as the shell
          fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
            if (e2) { response.writeHead(404); response.end(); return }
            response.writeHead(200, { 'content-type': 'text/html' })
            response.end(html)
          })
          return
        }
        response.writeHead(200, { 'content-type': mime[path.extname(requested)] || 'application/octet-stream' })
        response.end(data)
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const PROBE = `(() => {
  const out = { }
  const graph = document.querySelector('.graph, .tree-graph, [data-layout]')
  const nodes = [...document.querySelectorAll(".node[data-agent-id]")]
  out.nodeCount = nodes.length
  out.nodes = nodes.map(n => {
    const r = n.getBoundingClientRect()
    return { id: n.dataset.agentId, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) }
  })
  // pairwise circle overlap
  let overlaps = 0
  for (let i = 0; i < out.nodes.length; i++) for (let j = i + 1; j < out.nodes.length; j++) {
    const a = out.nodes[i], b = out.nodes[j]
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++
  }
  out.nodeOverlaps = overlaps
  const chips = [...document.querySelectorAll('.chip, .mon-chip, .screen-chip, .ctx-chip, [data-chip], .tg-chip')]
  out.chipCount = chips.length
  out.chipsPlaced = chips.filter(c => c.classList.contains('screen-chip-visible')).length
  out.chips = chips.slice(0, 12).map(c => {
    const r = c.getBoundingClientRect()
    return { cls: c.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) }
  })
  out.labels = [...document.querySelectorAll('.node-name, .tg-name, .n-name')].slice(0, 20).map(l => (l.innerText || '').trim())
  out.unavailable = [...document.querySelectorAll('.projection-unavailable, .unavailable, [data-unavailable]')].map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120))
  out.railText = (document.querySelector('.rail, aside.rail')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400)
  out.title = document.title
  out.hash = location.hash
  out.theme = document.documentElement.dataset.theme
  out.graphRect = graph ? (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(graph.getBoundingClientRect()) : null
  out.viewport = { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }
  out.bodyBg = getComputedStyle(document.body).backgroundColor
  out.rootAttr = document.documentElement.getAttribute('data-theme')
  out.bgVar = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  out.stageBg = (el => el ? getComputedStyle(el).backgroundColor : null)(document.getElementById('stage'))
  try { out.storedTheme = localStorage.getItem('mc.theme'); out.storedExample = localStorage.getItem('mc.example') } catch {}
  return out
})()`

async function run() {
  const outDir = path.resolve(arg('out', path.join(ROOT, 'artifacts', 'page2-shots')))
  fs.mkdirSync(outDir, { recursive: true })
  const themes = arg('themes', 'tan').split(',').filter(Boolean)
  const sizes = arg('sizes', '1920x1080,1440x900').split(',').filter(Boolean)
  const modes = arg('modes', 'live').split(',').filter(Boolean)
  const route = arg('route', 'computers')
  const label = arg('label', '')
  const settle = Number(arg('settle', '2600'))
  const script = arg('script', '')

  app.setPath('userData', path.join(outDir, '.profile'))
  app.commandLine.appendSwitch('disable-gpu')
  const server = await serveDist()
  const origin = `http://127.0.0.1:${server.address().port}`
  const report = []

  for (const size of sizes) {
    const [w, h] = size.split('x').map(Number)
    for (const theme of themes) {
      for (const mode of modes) {
        const win = new BrowserWindow({
          width: w, height: h, show: false, useContentSize: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, zoomFactor: 1 },
        })
        win.setContentSize(w, h)
        /* A hidden window never composites, so anything that fades in stays at
           opacity 0 and the capture comes back blank — the exact way a harness
           can "pass" on a page the owner sees differently. Show it (inactive,
           so it does not steal focus) and capture what actually paints. */
        win.showInactive()
        const errors = []
        win.webContents.on('console-message', (_e, level, message) => {
          if (level >= 2) errors.push(message.slice(0, 200))
        })
        const load = async url => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try { await win.loadURL(url); return } catch (e) { await delay(250) }
          }
          throw new Error(`could not load ${url}`)
        }
        /* Seed on a DIFFERENT pathname first: re-loading the same URL with only
           a fragment is a same-document navigation, so the app never re-boots
           and the page keeps the previous window's theme — the harness bug that
           made every sweep render one theme behind. */
        await load(`${origin}/__seed`)
        await win.webContents.executeJavaScript(`(() => {
          try { localStorage.setItem('mc.theme', ${JSON.stringify(theme)}) } catch {}
          /* mode names the shot; the app's one source switch is mc.example --
             absent for your own data, 'on' for the example fleet. */
          try { localStorage.${mode === 'live' ? "removeItem('mc.example')" : "setItem('mc.example', 'on')"} } catch {}
          return true
        })()`)
        await load(`${origin}/#/${route}`)
        await delay(settle)
        await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`)
        await delay(500)
        if (script) {
          try { console.log(JSON.stringify(await win.webContents.executeJavaScript(fs.readFileSync(path.resolve(ROOT, script), "utf8")), null, 1)) } catch (e) { console.log("script error", e.message) }
          await delay(900)
        }
        const probe = await win.webContents.executeJavaScript(PROBE).catch(e => ({ error: String(e) }))
        const name = [label, route, mode, theme, size].filter(Boolean).join('-')
        let image = null
        for (let attempt = 0; attempt < 4 && !image; attempt += 1) {
          try { image = await win.webContents.capturePage() } catch (e) { await delay(700) }
        }
        if (!image) {
          win.destroy()
          throw new Error(`capture failed for ${size} ${theme} ${mode}`)
        }
        fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG())
        try {
          const size = image.getSize()
          const bmp = image.getBitmap() // BGRA
          const at = (x, y) => { const i = (y * size.width + x) * 4; return `#${[bmp[i + 2], bmp[i + 1], bmp[i]].map(v => v.toString(16).padStart(2, '0')).join('')}` }
          probe.pixel = { size, topLeft: at(4, 4), midLeft: at(4, Math.floor(size.height / 2)) }
        } catch {}
        probe.consoleErrors = errors
        report.push({ name, probe })
        console.log(`[shot] ${name}  vp=${probe.viewport?.w}x${probe.viewport?.h}@${probe.viewport?.dpr} bg=${probe.bodyBg} theme=${probe.theme}/${probe.storedTheme} example=${probe.storedExample} nodes=${probe.nodeCount} overlaps=${probe.nodeOverlaps} chips=${probe.chipsPlaced}/${probe.chipCount}`)
        win.destroy()
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(report, null, 1))
  console.log(`\nWrote ${report.length} shots to ${outDir}`)
  server.close()
  app.quit()
}

// Without this, destroying each capture window quits the app mid-sweep and
// the harness silently reports only its first shot.
app.on('window-all-closed', () => {})

app.whenReady().then(() => run().catch(err => { console.error(err); app.exit(1) }))
