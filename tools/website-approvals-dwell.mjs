/* Long-dwell probe for the approvals surface (R1260 T5.1).
 * The 2.5s stranger drive caught "Checking the queue…". Claiming that state is
 * PERMANENT requires waiting long enough to be wrong, so this dwells 20s and
 * samples the text repeatedly. If the text ever changes, the claim is retracted.
 * Config via env (a bare URL argv makes Electron exit -1 before main runs). */
import { app, BrowserWindow } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.STRANGER_BASE_URL || 'http://localhost:4699'
const OUT = process.env.STRANGER_OUT_DIR || join(process.cwd(), 'artifacts', 'website-stranger')
const LOG = []
const say = l => { LOG.push(l); console.log(l) }

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true })
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    await win.loadURL(`${BASE}/#/approvals`)
    const samples = []
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const txt = await win.webContents.executeJavaScript(
        `((document.querySelector('main')||document.body).innerText||'').trim().slice(0,300)`)
      samples.push({ atMs: (i + 1) * 2000, text: txt })
    }
    const first = samples[0].text
    const changed = samples.some(s => s.text !== first)
    for (const s of samples) say(`t+${s.atMs}ms :: ${JSON.stringify(s.text.slice(0, 120))}`)
    const finalStillLoading = /checking the queue/i.test(samples[samples.length - 1].text)
    say(`TEXT_CHANGED_OVER_20S=${changed}`)
    say(`FINAL_STILL_LOADING=${finalStillLoading}`)
    writeFileSync(join(OUT, 'approvals-dwell.json'), JSON.stringify({ samples, changed }, null, 2))
    writeFileSync(join(OUT, 'approvals-dwell.log'), LOG.join('\n') + '\n')
    win.destroy()
    app.exit(finalStillLoading ? 1 : 0)
  } catch (err) {
    say(`DWELL_FAILED: ${err && err.stack || err}`)
    writeFileSync(join(OUT, 'approvals-dwell.log'), LOG.join('\n') + '\n')
    app.exit(1)
  }
})
