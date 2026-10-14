// Observation-only seam: expose the mounted view's real coordinator to tests
// whose old trigger was the removed automatic account-recovery event.
// No coordinator, store, custody or delivery method is replaced.
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (!url.endsWith('/src/views/computers.js')) return loaded
  return { ...loaded, source: String(loaded.source)
    + '\nexport { recoveryCoordinator as mountedContinuationCoordinatorForTest };\n' }
}
