import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let cachedCapability

export function symlinkCapability() {
  if (cachedCapability) return cachedCapability

  const directory = mkdtempSync(path.join(tmpdir(), 'tools-test-symlink-capability-'))
  const target = path.join(directory, 'target.txt')
  const link = path.join(directory, 'link.txt')

  try {
    writeFileSync(target, 'symlink capability probe\n')
    symlinkSync(target, link, 'file')
    if (!lstatSync(link).isSymbolicLink()) {
      throw new Error('the filesystem did not create a symbolic link')
    }
    cachedCapability = Object.freeze({
      available: true,
      reason: 'symlink creation succeeded',
    })
  } catch (error) {
    const detail = error?.message ?? String(error)
    const code = error?.code && !detail.startsWith(`${error.code}:`) ? `${error.code}: ` : ''
    cachedCapability = Object.freeze({
      available: false,
      reason: `symlink creation was denied (${code}${detail})`,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  return cachedCapability
}
