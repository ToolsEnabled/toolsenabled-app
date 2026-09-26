'use strict'

const ACKNOWLEDGEMENT_TIMEOUT_MS = 10000
const MAX_DIAGNOSTIC_BYTES = 65536

/* GNOME's client can exit zero after handle_create_instance_error,
   handle_create_receiver_proxy_error or handle_exec_error reports failure.
   These diagnostic prefixes in terminal.cc are not translated. Other client
   warnings (including a failed preferred server followed by a successful
   fallback) do not establish failure. This stream belongs to the launcher;
   the sign-in program's output stays in the terminal server's PTY.
   https://gitlab.gnome.org/GNOME/gnome-terminal/-/blob/gnome-44/src/terminal.cc */
const REJECTED_REQUEST = /^(?:# )?(?:Error creating terminal:|Failed to create proxy for terminal:|Error:)(?:[ \t]|$)/m

function acknowledgeGnomeTerminal(child, { timeoutMs = ACKNOWLEDGEMENT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    let diagnostics = Buffer.alloc(0)
    let overflow = false
    const finish = ok => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      diagnostics = Buffer.alloc(0)
      if (ok) resolve()
      else reject(new Error('PROVIDER_LOGIN_TERMINAL_UNCONFIRMED'))
    }
    // Continue draining after a deadline, without retaining or exposing text.
    child.stderr.on('data', chunk => {
      if (settled || overflow) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (diagnostics.length + bytes.length > MAX_DIAGNOSTIC_BYTES) {
        diagnostics = Buffer.alloc(0)
        overflow = true
      } else diagnostics = Buffer.concat([diagnostics, bytes])
    })
    child.stderr.on('error', () => finish(false))
    child.once('error', () => finish(false))
    // `exit` may precede the final diagnostic bytes; `close` follows them.
    child.once('close', (code, signal) => finish(code === 0 && signal === null
      && !overflow && !REJECTED_REQUEST.test(diagnostics.toString('utf8'))))
    timer = setTimeout(() => finish(false), timeoutMs)
    // A deadline is uncertainty. Never kill or retry a window the user owns.
  })
}

module.exports = { acknowledgeGnomeTerminal, MAX_DIAGNOSTIC_BYTES }
