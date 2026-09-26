// Native picker popups require a trusted browser activation, which a tracked
// pinch is not. Offer a small DOM choice list that the same pointer can press.
export function createHandPress(doc = document) {
  let panel = null
  const close = () => { panel?.remove(); panel = null }
  function press(element) {
    if (!element?.isConnected || element.matches(':disabled')) { close(); return }
    if (element.tagName !== 'SELECT') {
      if (element.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) element.focus()
      else element.click()
      return
    }
    close()
    const select = element, options = [...select.options]
    let page = Math.max(0, Math.floor(select.selectedIndex / 7))
    panel = doc.createElement('aside')
    panel.className = 'hand-control-choices'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Choose an option')
    doc.body.append(panel)
    const button = (label, action, disabled = false) => {
      const item = doc.createElement('button')
      item.type = 'button'; item.textContent = label; item.disabled = disabled
      item.addEventListener('click', action)
      panel.append(item)
    }
    const render = () => {
      if (!select.isConnected || select.matches(':disabled')) { close(); return }
      panel.replaceChildren()
      for (const option of options.slice(page * 7, page * 7 + 7)) {
        const label = option.label, value = option.value
        button((option.selected ? 'Selected: ' : '') + label, () => {
          if (!select.isConnected || select.matches(':disabled')
              || ![...select.options].includes(option) || option.label !== label
              || option.value !== value || option.disabled || option.closest('optgroup')?.disabled) { close(); return }
          if (select.multiple) option.selected = !option.selected
          else select.selectedIndex = option.index
          select.dispatchEvent(new Event('input', { bubbles: true }))
          select.dispatchEvent(new Event('change', { bubbles: true }))
          close()
        }, option.disabled || option.closest('optgroup')?.disabled)
      }
      button('Previous choices', () => { page--; render() }, page === 0)
      button('Next choices', () => { page++; render() }, (page + 1) * 7 >= options.length)
      button('Cancel', close)
    }
    render()
  }
  return { press, close }
}
