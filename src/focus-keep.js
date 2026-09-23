/* KEEPING KEYBOARD FOCUS WHERE THE PERSON PUT IT, across a redraw or a busy
 * moment (T1386, T1559).
 *
 * A browser drops focus to the page when the focused node is removed (a
 * section repainted with outerHTML) or disabled (a button that disables itself
 * while it works). Nothing put it back, so after every press the focus ring
 * vanished, a screen reader heard nothing, and the next Tab started again at
 * the top of the section or the page: changing five agent switches meant
 * tabbing through the section five times.
 *
 * A keeper remembers WHICH control had focus, by the attributes that name it
 * (its id, name, data-* attributes, and the value of a radio or checkbox),
 * before the redraw, and focuses the control that carries the same names once
 * one is drawn and usable again. It waits across several redraws (a Refresh
 * that repaints once busy and once done), and gives up the moment the person
 * has put focus somewhere else themselves.
 */

const VOLATILE = /^data-(state|busy|pending|loading|saving)$/

function attributeNames(node) {
  if (typeof node?.getAttributeNames === 'function') return node.getAttributeNames()
  if (node?.attributes instanceof Map) return [...node.attributes.keys()]
  return []
}

function identity(node) {
  const type = String(node.getAttribute?.('type') || '').toLowerCase()
  return attributeNames(node)
    .filter(name => name === 'id' || name === 'name' || (name.startsWith('data-') && !VOLATILE.test(name))
      || (name === 'value' && (type === 'radio' || type === 'checkbox')))
    .map(name => [name, node.getAttribute(name)])
}

export function focusKeeper() {
  let held = null
  return {
    /* Call before a redraw or before disabling: remembers the focused control
       if it is inside `container` (or is it). */
    hold(container, doc = container?.ownerDocument || globalThis.document) {
      const active = doc?.activeElement
      if (!container || !active || !(active === container || container.contains?.(active))) return false
      const tag = String(active.tagName || '').toLowerCase()
      const keys = identity(active)
      if (!tag || !keys.length) return false
      held = { doc, tag, keys, node: active }
      return true
    },
    /* Call after the redraw (or once usable again), with the node that now
       holds the controls. True when focus was put back. */
    restore(scope) {
      if (!held) return false
      const { doc, tag, keys, node } = held
      const now = doc?.activeElement
      const lost = !now || now === doc.body || now === doc.documentElement || now === node || now.isConnected === false
      if (!lost) { held = null; return false }
      const pool = [...(scope?.querySelectorAll?.(tag) || [])]
      if (scope?.matches?.(tag)) pool.unshift(scope)
      const match = pool.find(candidate => keys.every(([name, value]) => candidate.getAttribute(name) === value))
      if (!match || match.disabled || match.hidden || match.closest?.('[hidden]')) return false
      held = null
      match.focus?.({ preventScroll: true })
      return true
    },
    forget() { held = null },
  }
}
