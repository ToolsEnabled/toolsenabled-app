/* A release commit must describe one package graph, not one in package.json and
 * another in package-lock.json. npm ci normally catches dependency drift, but
 * the candidate cutter may reuse an already-provisioned node_modules tree, so
 * release correctness cannot depend on npm happening to rewrite the lock. */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function mapProblems(label, declared, locked) {
  const left = asObject(declared)
  const right = asObject(locked)
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return names.flatMap((name) => {
    if (!(name in left)) return [`package-lock root has undeclared ${label} ${name}@${right[name]}`]
    if (!(name in right)) return [`package-lock root is missing ${label} ${name}@${left[name]}`]
    if (left[name] !== right[name]) {
      return [`${label} ${name} differs: package.json=${left[name]} package-lock.json=${right[name]}`]
    }
    return []
  })
}

export function packageLockParityProblems(packageJson, packageLock) {
  const problems = []
  const root = asObject(packageLock?.packages?.[''])
  if (packageLock?.name !== packageJson?.name) problems.push(`top-level lock name ${packageLock?.name} != ${packageJson?.name}`)
  if (root.name !== packageJson?.name) problems.push(`root lock name ${root.name} != ${packageJson?.name}`)
  if (packageLock?.version !== packageJson?.version) problems.push(`top-level lock version ${packageLock?.version} != ${packageJson?.version}`)
  if (root.version !== packageJson?.version) problems.push(`root lock version ${root.version} != ${packageJson?.version}`)
  problems.push(...mapProblems('dependency', packageJson?.dependencies, root.dependencies))
  problems.push(...mapProblems('devDependency', packageJson?.devDependencies, root.devDependencies))
  return problems
}

export function assertPackageLockParity(packageJson, packageLock) {
  const problems = packageLockParityProblems(packageJson, packageLock)
  if (problems.length > 0) {
    throw new Error(`package/package-lock parity failed:\n  - ${problems.join('\n  - ')}`)
  }
}
