// Shared vector artwork for the composer, action menu, and Loop setup.
export function commonCommandIcon(name, minutes = 20) {
  if (name === 'goal') return `<span class="common-command-icon common-command-icon--goal" aria-hidden="true">
    <svg viewBox="0 0 40 40" fill="none" focusable="false">
      <circle cx="20" cy="20" r="17" fill="currentColor" opacity=".08"/>
      <circle cx="20" cy="20" r="12.75" stroke="currentColor" stroke-width="2" opacity=".65"/>
      <circle cx="20" cy="20" r="7.25" stroke="currentColor" stroke-width="2"/>
      <circle cx="20" cy="20" r="3" fill="currentColor"/>
    </svg>
  </span>`
  if (name !== 'loop') return ''
  const value = Number(minutes)
  const label = Number.isInteger(value) && value >= 1 && value <= 240 ? value : 20
  return `<span class="common-command-icon common-command-icon--loop" aria-hidden="true">
    <svg viewBox="0 0 40 40" fill="none" focusable="false">
      <circle cx="20" cy="20" r="17" fill="currentColor" opacity=".07"/>
      <circle cx="20" cy="20" r="14" stroke="currentColor" stroke-width="2" opacity=".12"/>
      <path d="M34 20a14 14 0 1 1-4.1-9.9M29.9 4.6v5.5h-5.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="common-command-minutes${label >= 100 ? ' is-wide' : ''}">${label}</span>
  </span>`
}
