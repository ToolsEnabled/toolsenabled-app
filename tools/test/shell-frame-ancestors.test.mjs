// Who may put this product in an iframe. The answer is: nobody, except the
// preview page inside its own origin — and the answer has to live in a
// RESPONSE HEADER, because Chrome ignores frame-ancestors delivered via
// <meta> (reports/lanes/preview-frame-ancestors-inert.md, found by the
// paid-product lane 2026-08-14 while embedding the preview in the website).
//
// The stakes are concrete: the shell serves the whole app over loopback HTTP,
// and a browser on the same machine will happily let any internet page iframe
// http://127.0.0.1:<port>/ — the Host check passes, because the request
// really is addressed to this origin. Without the header, a hostile page can
// frame the preview (or the app) and overlay the simulated fleet as its own
// live product, while the honesty banner inside the frame keeps telling a
// truth nobody can see.
//
// Three facts pinned, each the fact itself rather than a proxy:
//   1. serveDist sets the deny-all header BEFORE any branch writes — the 421
//      refusal, the 403, the SPA fallback and the file answer all carry it.
//   2. The preview path alone is upgraded to 'self' — its same-origin embed
//      is the one framing this product means to allow.
//   3. The preview's <meta> policy claims nothing about framing — an inert
//      directive that reads as protection is the audit that looks like it
//      ran, which is the defect class the preview itself exists to refuse.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(join(root, relative), 'utf8')

test('every answer the shell server gives says who may frame it', () => {
  const shell = read('shell/main.cjs')
  const serverAt = shell.indexOf('function serveDist()')
  assert.ok(serverAt >= 0, 'serveDist moved; re-measure this suite against the server that replaced it')
  const server = shell.slice(serverAt, serverAt + 4000)
  const headerAt = server.indexOf("res.setHeader('Content-Security-Policy', \"frame-ancestors 'none'\")")
  assert.ok(headerAt >= 0,
    'the deny-all frame-ancestors header is gone from serveDist. It must be sent on every response — '
    + 'a <meta> policy cannot carry this directive (Chrome ignores it there), so the header is the only enforcement.')
  const hostCheckAt = server.indexOf('req.headers.host !== expectedHost')
  assert.ok(hostCheckAt > headerAt,
    'the frame-ancestors header must be set BEFORE the first branch that writes a response, '
    + 'or refusals and fallbacks ship without it')
})

test("the preview page alone may be framed, and only by its own origin", () => {
  const shell = read('shell/main.cjs')
  const server = shell.slice(shell.indexOf('function serveDist()'), shell.indexOf('function serveDist()') + 4000)
  assert.ok(/url === '\/preview' \|\| url\.startsWith\('\/preview\/'\)/.test(server),
    "the preview path check moved; the same-origin embed the preview's design expects must stay allowed")
  assert.ok(server.includes("res.setHeader('Content-Security-Policy', \"frame-ancestors 'self'\")"),
    "the preview upgrade to 'self' is gone — the website embeds this page same-origin rather than "
    + 'reimplementing honesty.js, and a second copy of an honesty guard is worse than none')
})

test('the preview markup makes no framing claim it cannot enforce', () => {
  const preview = read('public/preview/index.html')
  const meta = preview.match(/<meta http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/)
  assert.ok(meta, "the preview's <meta> policy is gone entirely; its other directives DO work in <meta> and are wanted")
  assert.ok(!meta[1].includes('frame-ancestors'),
    'frame-ancestors is back in the <meta> policy, where Chrome ignores it. That line reads as protection '
    + 'and enforces nothing — the header sent by whatever serves this page is the real control.')
})
