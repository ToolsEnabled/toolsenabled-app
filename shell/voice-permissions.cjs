'use strict'
function sameDocument(left, right) {
  try { const a = new URL(left), b = new URL(right); a.hash = ''; b.hash = ''; return a.href === b.href } catch { return false }
}
function installVoicePermissions(session, { owns, allows, allowsCamera = () => false }) {
  const admitted = (contents, details) => Boolean(contents && owns(contents)
    && details?.isMainFrame === true
    && sameDocument(details.requestingUrl, contents.getURL()))
  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission !== 'media') return true // Preserve Electron's existing non-media policy.
    return admitted(contents, details) && (details.mediaType === 'audio' ? allows(contents)
      : details.mediaType === 'video' && allowsCamera(contents))
  })
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(true); return }
    callback(Boolean(admitted(contents, details) && details.mediaTypes?.length && details.mediaTypes.length <= 2
      && new Set(details.mediaTypes).size === details.mediaTypes.length
      && details.mediaTypes.every(type => type === 'audio' ? allows(contents) : type === 'video' && allowsCamera(contents))))
  })
}
module.exports = { installVoicePermissions, sameDocument }
