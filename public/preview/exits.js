/* THE TWO WAYS OUT OF THE PREVIEW, AND WHY NEITHER IS A PLAIN LINK.
 *
 * A preview that convinces someone has to lead somewhere: to the real download,
 * and to the page where they sign up. The lazy version of that is two <a> tags
 * pointing at paths somebody hopes exist. That version ships a 404 to the one
 * visitor who was ready to buy, and it ships it silently, because a dead link
 * looks exactly like a working one until it is clicked.
 *
 * So both exits are DECLARED and then VERIFIED before they are offered:
 *
 *   - The download exit needs a full build declaration (product, version, the
 *     40-hex commit it was built from, its 64-hex sha256, its byte size, and an
 *     IMMUTABLE location — never a build directory, because a build directory
 *     reuses one filename and a hash quoted against it expires on the next
 *     rebuild with no change to the name). This mirrors the contract in
 *     docs/WEBSITE-DOWNLOAD-WIRE-PLAN.md (R1260 lane t5a), whose rule is the
 *     one that matters here: NO DECLARATION => NO DOWNLOAD SURFACE.
 *
 *   - The subscription exit has an explicit enabled-plus-reason contract. It
 *     is disabled while subscriptions are delayed. Once the owner enables it,
 *     the existing same-origin probe must still resolve before it is offered.
 *
 * ABSENCE FAILS CLOSED AND IS NAMED. A missing declaration, an incomplete one,
 * an empty string in a required field, or a target that does not resolve, all
 * render a DISABLED control carrying the reason in words. None of them render
 * an enabled button, and none of them render nothing at all — a control that
 * silently disappears teaches the visitor that the product has no download.
 *
 * TODAY, DELIBERATELY: `DECLARED.download` is null. There is no declared
 * installer candidate on this machine (R1260 t5a measured that, and Machine A's
 * own candidate folder says so in writing). Shipping a download button anyway
 * would be the exact defect this file exists to prevent, so the preview shows
 * the refusal instead, with the reason.
 */

/** The site's own pages, as paths relative to the site root. */
export const DECLARED = Object.freeze({
  /* Fill this in when — and only when — a release candidate has been declared.
   * Shape (every field required, every field non-empty):
   *   { productName, version, buildRef(40 hex), sha256(64 hex), sizeBytes(int>0),
   *     immutableLocation(url or path that never changes contents) } */
  download: null,

  /* The future subscription page is a ROUTE INSIDE THE
   * APPLICATION SHELL (`#/subscribe`), not a separate static page — measured in
   * their worktree, not assumed.
   *
   * That distinction is the whole reason this entry has two fields. A hash route
   * cannot be probed: fetch() drops the fragment, so probing "/#/subscribe" would
   * request "/", which always answers 200 on any deployment at all. The control
   * would then light up whether or not the subscription page had ever shipped —
   * a check that cannot fail is not a check, and it is exactly the
   * absence-read-as-consent shape this codebase keeps finding.
   *
   *   href   where a buyer is sent
   *   probe  a STATIC artifact whose presence proves that surface is in THIS
   *          build. Defaults to href when the two are the same thing.
   *
   * The probe below is the subscription catalogue: the page cannot render
   * plans without it, so its absence is precisely the case where sending someone
   * there would waste their click. The explicit `enabled: false` is checked
   * before that probe because a published artifact is not permission to sell. */
  subscribe: Object.freeze({
    enabled: false,
    disabledHint: 'Subscriptions are not open yet. The product is free meanwhile and does not need a subscription to run.',
    href: '/#/subscribe',
    probe: '/data/subscription-catalog.json',
    label: 'Subscriptions coming soon',
  }),
})

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/

/** Validate a download declaration. Returns { ok, reason }. Absence first. */
export function checkDownloadDeclaration(declaration) {
  if (declaration == null) {
    return { ok: false, reason: 'No build has been declared for download yet, so there is nothing here to offer you.' }
  }
  if (typeof declaration !== 'object' || Array.isArray(declaration)) {
    return { ok: false, reason: 'The build declaration is not readable, so it is treated as absent.' }
  }
  const required = ['productName', 'version', 'buildRef', 'sha256', 'sizeBytes', 'immutableLocation']
  for (const field of required) {
    if (!Object.hasOwn(declaration, field)) {
      return { ok: false, reason: `The build declaration is missing "${field}", so it is not complete enough to offer.` }
    }
    const value = declaration[field]
    if (value === null || value === undefined) {
      return { ok: false, reason: `The build declaration has no value for "${field}".` }
    }
    if (typeof value === 'string' && value.trim() === '') {
      return { ok: false, reason: `The build declaration has an empty "${field}". An empty field is not a value.` }
    }
  }
  if (!HEX40.test(String(declaration.buildRef))) {
    return { ok: false, reason: 'The declared build reference is not a full 40-character commit id; an abbreviated one cannot identify a build.' }
  }
  if (!HEX64.test(String(declaration.sha256))) {
    return { ok: false, reason: 'The declared checksum is not a full sha256, so it cannot be checked against the file.' }
  }
  if (!Number.isSafeInteger(declaration.sizeBytes) || declaration.sizeBytes <= 0) {
    return { ok: false, reason: 'The declared size is not a positive whole number of bytes.' }
  }
  if (/(^|[\\/])(dist|release|build|out)([\\/]|$)/i.test(String(declaration.immutableLocation))) {
    return { ok: false, reason: 'The declared location is inside a build directory, whose contents change under the same name.' }
  }
  return { ok: true, reason: null }
}

/**
 * Probe a same-origin path. A path that does not resolve is treated as absent.
 * `fetchImpl` is injectable so the node tests can exercise both branches
 * without a server.
 */
export async function probeTarget(href, { fetchImpl } = {}) {
  const impl = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!impl) return { ok: false, reason: 'This browser cannot check whether that page exists, so the link is withheld.' }
  if (typeof href !== 'string' || href.trim() === '') {
    return { ok: false, reason: 'No path was declared for that page.' }
  }
  let response
  try {
    response = await impl(href, { method: 'GET', cache: 'no-store' })
  } catch (error) {
    return { ok: false, reason: `That page could not be reached from this one (${String(error && error.message || error)}).` }
  }
  if (!response || response.ok !== true) {
    const status = response && response.status ? ` (${response.status})` : ''
    return { ok: false, reason: `That page is not part of this build yet${status}.` }
  }
  return { ok: true, reason: null }
}

/**
 * Build one exit control. Always returns an element: enabled anchor when the
 * exit is verified, disabled button plus a named reason when it is not.
 */
export function exitControl({ label, href, ok, reason, kind }) {
  const wrap = document.createElement('div')
  wrap.className = 'exit'
  wrap.dataset.exit = kind
  wrap.dataset.exitState = ok ? 'offered' : 'withheld'

  if (ok) {
    const a = document.createElement('a')
    a.className = 'exit-btn'
    a.href = href
    a.textContent = label
    wrap.appendChild(a)
    return wrap
  }

  const button = document.createElement('button')
  button.className = 'exit-btn'
  button.type = 'button'
  button.disabled = true
  button.textContent = label
  const note = document.createElement('p')
  note.className = 'exit-why'
  note.textContent = reason
  wrap.append(button, note)
  return wrap
}

/** Resolve both exits. Never throws; every failure becomes a named refusal. */
export async function resolveExits(declared = DECLARED, options = {}) {
  const download = checkDownloadDeclaration(declared.download)
  const subscribeDeclared = declared.subscribe
  let subscribe
  if (!subscribeDeclared || typeof subscribeDeclared.href !== 'string' || subscribeDeclared.href.trim() === '') {
    subscribe = { ok: false, reason: 'Subscriptions are not open yet. The product is free meanwhile and does not need a subscription to run.', href: null, label: 'Subscriptions coming soon' }
  } else if (subscribeDeclared.enabled !== true) {
    subscribe = {
      ok: false,
      reason: subscribeDeclared.disabledHint || 'Subscriptions are not open yet. The product is free meanwhile and does not need a subscription to run.',
      href: subscribeDeclared.href,
      label: subscribeDeclared.label || 'Subscriptions coming soon',
    }
  } else {
    // Probe the static artifact when one is declared, never the hash route —
    // see the note on DECLARED.subscribe for why probing the route cannot fail.
    const probeTargetPath = typeof subscribeDeclared.probe === 'string' && subscribeDeclared.probe.trim() !== ''
      ? subscribeDeclared.probe
      : subscribeDeclared.href
    if (probeTargetPath.includes('#')) {
      subscribe = {
        ok: false,
        reason: 'The subscription page is declared only as a route, with nothing static to check, so it is withheld.',
        href: subscribeDeclared.href,
        label: subscribeDeclared.label || 'Subscriptions',
      }
    } else {
      const probe = await probeTarget(probeTargetPath, options)
      subscribe = { ...probe, href: subscribeDeclared.href, label: subscribeDeclared.label || 'Subscriptions' }
    }
  }

  return {
    download: {
      ok: download.ok,
      reason: download.reason,
      href: download.ok ? String(declared.download.immutableLocation) : null,
      label: download.ok
        ? `Download ${declared.download.productName} ${declared.download.version}`
        : 'Download the product',
    },
    subscribe,
  }
}
