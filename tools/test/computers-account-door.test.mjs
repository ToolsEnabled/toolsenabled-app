import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* THE ACCOUNT DOOR ON THE COMPUTERS PAGE SPEAKS TO THREE DIFFERENT READERS, and
 * it has been caught twice speaking to the wrong one. This pins all three.
 *
 *   1. Over the relay: the computer on screen IS on their account -- that is how
 *      the bytes arrived -- so offering "Connect this computer" is offering to
 *      do the thing they already did (measured live 2026-08-22).
 *   2. A browser with no host but a REASON from the host bridge: the bridge
 *      knows why it could not point at a computer ("none of them is chosen"),
 *      and that reason beats a guess. Measured live 2026-08-23 at 390x844: an
 *      account with two connected computers, opened on a phone, was told to go
 *      and install the application.
 *   3. A browser with no host and no reason: somebody who reached the page cold.
 *      The install sentence is the right guess for them and only for them.
 *
 * A source pin, because the view is a DOM module the size of a small program and
 * the rule under test is which sentence is chosen, not how it is painted. */
const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const DOOR = VIEW.slice(VIEW.indexOf('function accountDoorMarkup'), VIEW.indexOf('\n  }\n', VIEW.indexOf('function accountDoorMarkup')))

test('the account door prefers the host bridge\'s own reason over the install guess', () => {
  assert.ok(DOOR.length > 0, 'accountDoorMarkup is gone from src/views/computers.js')
  const fallback = DOOR.indexOf('hostFallbackSentence()')
  const install = DOOR.indexOf('Putting a computer on your account is done from the installed application')
  assert.ok(fallback > 0, 'the door no longer asks the host bridge why it could not point at a computer')
  assert.ok(install > 0, 'the cold-reader sentence is gone')
  assert.ok(fallback < install,
    'the install guess must come AFTER the bridge\'s reason, or a signed-in person with computers connected is told to go and install the application')
})

test('the reason branch offers a way back, and it is the account page', () => {
  const at = DOOR.indexOf('hostFallbackSentence()')
  const branch = DOOR.slice(at, DOOR.indexOf('Putting a computer on your account', at))
  assert.match(branch, /ACCOUNT_PAGE_HREF/, 'the reason branch names no destination, which is the dead end this repair exists to close')
  assert.match(branch, /account page/i, 'the link does not say where it goes')
  assert.doesNotMatch(branch, /install/i, 'the reason branch must not tell a signed-in person to install anything')
})

test('the account-page door is relative, so every serve keeps its own environment', () => {
  /* This link renders only in a browser preview, and a preview is served from
     an origin that also serves /account/ — production, the release-candidate
     serve, a dev serve. The absolute form this replaces
     (`https://${ACCOUNT_PAGE_HOST}/account/`) silently sent every
     non-production serve to production: measured on the desktop press-through
     (2026-08-27), a press on the local 127.0.0.1 serve left it for
     toolsenabled.ai and a 401. On production the relative door resolves to
     exactly the address the absolute one spelled. */
  assert.match(VIEW, /const ACCOUNT_PAGE_HREF = '\/account\/'/,
    'the account door stopped being the one relative constant; a hand-spelled or absolute address sends a local serve to production')
  assert.doesNotMatch(VIEW, /https:\/\/\$\{ACCOUNT_PAGE_HOST\}\/account\//,
    'the absolute production address is back; a local or preview serve will silently leave its environment')
  assert.match(VIEW, /import \{ CONNECT_HREF \} from '\.\.\/device-claim-flow\.js'/,
    'the connect-screen address is no longer read from device-claim-flow.js')
})

test('the relay reader is still told the computer is already on the account', () => {
  assert.match(DOOR, /currentDataSource\(\) === 'relay'/, 'the relay branch is gone')
  assert.match(DOOR, /already on your account/, 'the relay sentence no longer says the computer is on the account')
  /* The OFFER, not the word: the relay branch's own comment quotes the phrase
     "Connect this computer" while explaining why it must not be offered here,
     so a plain indexOf finds the comment first and proves nothing. */
  const relayAt = DOOR.indexOf("currentDataSource() === 'relay'")
  const offerAt = DOOR.indexOf('>Connect this computer</a>')
  assert.ok(offerAt > 0, 'the cold-reader connect offer is gone')
  assert.ok(relayAt < offerAt, 'the relay branch must be reached before the connect offer, or a browser driving a machine is offered a code to type')
})
