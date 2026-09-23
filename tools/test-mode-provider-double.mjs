#!/usr/bin/env node

/* A LOCAL STAND-IN FOR THE PAYMENT PROVIDER'S TEST MODE.
 *
 * WHAT THIS IS, STATED PLAINLY SO NOBODY QUOTES IT AS SOMETHING IT IS NOT.
 * This is NOT Stripe. It is a loopback server that speaks the Checkout Sessions
 * create endpoint's wire contract -- form-encoded request, JSON reply, `cs_test_`
 * session ids, the `idempotency-key` header, and the card_error shape for a
 * decline. It exists so the signup path can be driven end to end, including its
 * failure branches, on a machine with no merchant credentials.
 *
 * WHY NOT DRIVE STRIPE'S REAL TEST MODE. That needs an `sk_test_` secret from a
 * Stripe account. The only Stripe credential on this machine is the vault's
 * live-mode key, which this lane may not read and must never charge. Pointing
 * the service at Stripe's real test mode is a CONFIGURATION change --
 * TOOLSENABLED_BILLING_API_BASE=https://api.stripe.com/v1 and an sk_test_ secret
 * -- against the same adapter, with no code change. The adapter's construction
 * checks and its `cs_test_` reply check are what make that swap safe.
 *
 * The decline and outage branches are reachable on demand, because a signup page
 * whose unhappy paths have never run is a page whose unhappy paths are guesses:
 *   card_declined@...   the provider answers 402 with a card_error
 *   outage@...          the provider answers 500
 * Those are the double's own behaviour, not a rule of the real provider.
 */

import { createServer } from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DECLINE_LOCAL_PART = 'card_declined'
const OUTAGE_LOCAL_PART = 'outage'

export function createProviderDouble() {
  const sessions = new Map()
  const byIdempotencyKey = new Map()

  const handler = async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    const reply = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    if (request.method === 'GET' && request.url.startsWith('/hosted/')) {
      // The "hosted checkout page" a customer would be sent to. Deliberately
      // plain: the drive harness only needs to prove the hand-off is real.
      const id = request.url.slice('/hosted/'.length)
      const known = sessions.has(id)
      response.writeHead(known ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><meta charset="utf-8"><title>Test-mode checkout</title>`
        + `<h1 id="hosted-checkout">Test-mode checkout</h1>`
        + `<p id="session-id">${known ? id : 'unknown session'}</p>`)
      return
    }

    if (request.method !== 'POST' || !request.url.startsWith('/checkout/sessions')) {
      reply(404, { error: { message: 'no such endpoint' } })
      return
    }
    const authorization = request.headers.authorization || ''
    const secret = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8').replace(/:$/, '')
    if (!/^(sk|rk)_test_/.test(secret)) {
      reply(401, { error: { message: 'this double only accepts a test-mode key' } })
      return
    }

    const form = new URLSearchParams(body)
    const email = form.get('customer_email') || ''
    const local = email.split('@')[0]
    if (local === OUTAGE_LOCAL_PART) { reply(500, { error: { message: 'simulated provider outage' } }); return }
    if (local === DECLINE_LOCAL_PART) {
      reply(402, { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } })
      return
    }
    if (!form.get('line_items[0][price]')) { reply(400, { error: { message: 'no price' } }); return }

    const idempotencyKey = request.headers['idempotency-key']
    if (idempotencyKey && byIdempotencyKey.has(idempotencyKey)) {
      reply(200, sessions.get(byIdempotencyKey.get(idempotencyKey)))
      return
    }
    const id = `cs_test_${crypto.randomUUID().replace(/-/g, '')}`
    const session = {
      id,
      object: 'checkout.session',
      livemode: false,
      mode: form.get('mode'),
      customer_email: email,
      url: `${externalOrigin}/hosted/${id}`,
      metadata: Object.fromEntries([...form.entries()]
        .filter(([key]) => key.startsWith('metadata['))
        .map(([key, value]) => [key.slice('metadata['.length, -1), value]))
    }
    sessions.set(id, session)
    if (idempotencyKey) byIdempotencyKey.set(idempotencyKey, id)
    reply(200, session)
  }

  let externalOrigin = 'http://127.0.0.1:0'
  const server = createServer(handler)
  return {
    server,
    sessions,
    async listen(port = 0) {
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
      externalOrigin = `http://127.0.0.1:${server.address().port}`
      return externalOrigin
    },
    async close() { await new Promise(resolve => server.close(resolve)) }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const double = createProviderDouble()
  const index = process.argv.indexOf('--port')
  const origin = await double.listen(index >= 0 ? Number(process.argv[index + 1]) : 4621)
  console.log(`test-mode provider double listening on ${origin}`)
}
