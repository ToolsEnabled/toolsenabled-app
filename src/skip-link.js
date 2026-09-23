/* SKIP TO MAIN CONTENT, WITHOUT LEAVING THE PAGE (T1421).
   The link's href="#stage" is also an address, and this app routes on
   location.hash: followed natively it set the address to #stage, which the
   router does not know and resolves to Home. So the one keyboard bypass on
   every page threw the reader off the page they were on.
   The href stays (it names the target for assistive technology and still
   works with no script at all); a press is taken over here and only moves
   focus to the target, which is tabindex=-1 for exactly this. The address,
   the page and the history stay as they were. */
export function keepSkipLinkOnPage(doc = globalThis.document) {
  const link = doc?.querySelector?.('.skip-link')
  if (!link) return () => {}
  const onPress = event => {
    const id = String(link.getAttribute('href') || '').replace(/^#/, '')
    const target = id && doc.getElementById?.(id)
    if (!target) return
    event.preventDefault()
    target.focus()
  }
  link.addEventListener('click', onPress)
  return () => link.removeEventListener('click', onPress)
}
