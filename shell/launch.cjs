// Defensive launcher: some host terminals (VSCode extension hosts, agent
// harnesses) export ELECTRON_RUN_AS_NODE=1, which turns the Electron binary
// into plain Node and makes require('electron') return a path string. Strip
// the poison before handing off, so `npm run app` works from anywhere.
const { spawn } = require('child_process')
const path = require('path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE

const exe = require('electron') // plain-Node context: this IS the binary path
const child = spawn(exe, [path.join(__dirname, 'main.cjs')], {
  env, stdio: 'inherit', detached: false,
})
child.on('error', (error) => {
  console.error(`Could not launch Electron: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 0))
