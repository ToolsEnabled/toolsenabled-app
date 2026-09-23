// Fixture access only: retain the actual mounted store, without changing its methods.
// Cases drive production store methods and ownership maps instead of editing a
// backing storage cell that the mounted store intentionally does not re-import.
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (!url.endsWith('/src/views/computers.js')) return loaded
  const source = String(loaded.source)
  const seam = '  return view\n}\n\n/* Kept across view navigation'
  if (source.split(seam).length !== 2) throw new Error('T542 mounted runtime fixture seam unavailable')
  return { ...loaded, source: source.replace(seam,
    "  ;(globalThis[Symbol.for('toolsenabled.test.t542.runtime-stores')] ||= new Map()).set(computerId, { store: view, ownedSessions })\n" + seam) }
}
