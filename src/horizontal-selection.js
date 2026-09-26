// Reveal a selected control inside its horizontal strip without moving the
// surrounding page or changing the selection that the route already made.
export function revealHorizontalSelection(container, selected) {
  if (!selected || container.scrollWidth <= container.clientWidth) return
  const frame = container.getBoundingClientRect(), item = selected.getBoundingClientRect()
  if (item.left < frame.left) container.scrollLeft += item.left - frame.left
  else if (item.right > frame.right) container.scrollLeft += item.right - frame.right
}
