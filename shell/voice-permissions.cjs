'use strict'
function sameDocument(left, right) {
  try { const a = new URL(left), b = new URL(right); a.hash = ''; b.hash = ''; return a.href === b.href } catch { return false }
}
function sameOrigin(address, origin) {
  try { return typeof origin === 'string' && origin !== '' && new URL(address).origin === new URL(origin).origin } catch { return false }
}
/* 1.0.50 M3: THIS SESSION'S GRANTS BELONG TO THE APPLICATION'S OWN PAGE.
   Non-media permissions used to answer true for any page in the session,
   whatever its origin, so a linked page that opened in an in-app window could
   read the clipboard silently or launch any OS protocol handler. A permission
   is now granted only to the owned main frame showing its own document and,
   when `origin` is given (the shell passes its own), only on that origin. A
   check Electron makes with no webContents (notifications, for one) is
   answered by the requesting origin alone. Two are never granted, because no
   page of this application uses them and they are the dangerous ones:
   reading the clipboard, and handing an address to an OS protocol handler. */
const NEVER_GRANTED = new Set(['clipboard-read', 'openExternal'])
function installVoicePermissions(session, { owns, allows, allowsCamera = () => false, allowsDisplayCapture = () => false, origin }) {
  const ownOrigin = () => { try { return origin() } catch { return null } }
  const fromOwnOrigin = url => typeof origin !== 'function' || sameOrigin(url, ownOrigin())
  const admitted = (contents, details) => Boolean(contents && owns(contents)
    && details?.isMainFrame === true
    && sameDocument(details.requestingUrl, contents.getURL())
    && fromOwnOrigin(details.requestingUrl))
  const grantsOther = (contents, permission, details, requestingOrigin) => {
    if (NEVER_GRANTED.has(permission)) return false
    if (contents) return admitted(contents, details)
    return typeof origin === 'function' && sameOrigin(requestingOrigin, ownOrigin())
  }
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (permission !== 'media') return grantsOther(contents, permission, details, requestingOrigin)
    return admitted(contents, details) && (details.mediaType === 'audio' ? allows(contents)
      : details.mediaType === 'video' && allowsCamera(contents))
  })
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(Boolean(contents && grantsOther(contents, permission, details))); return }
    /* getDisplayMedia (1.0.49 video box) asks as 'media' with EMPTY mediaTypes,
       before the display handler runs (Electron 43 spike). It is allowed only
       while shell/video-box-host.cjs holds a pick for this owner. */
    if (Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 0) {
      callback(Boolean(admitted(contents, details) && allowsDisplayCapture(contents)))
      return
    }
    callback(Boolean(admitted(contents, details) && details.mediaTypes?.length && details.mediaTypes.length <= 2
      && new Set(details.mediaTypes).size === details.mediaTypes.length
      && details.mediaTypes.every(type => type === 'audio' ? allows(contents) : type === 'video' && allowsCamera(contents))))
  })
}
module.exports = { installVoicePermissions, sameDocument, sameOrigin, NEVER_GRANTED }
