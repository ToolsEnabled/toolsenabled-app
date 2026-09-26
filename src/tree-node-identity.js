/* A canvas role is optional; a session identity is not.
 *
 * The role picker records what the person chose to show on the tree. Leaving it
 * blank must continue to mean "no particular role" to the person, but an
 * anonymous session cannot be recorded as the parent of a child agent. The
 * worker role is the shipped, non-single-seat role for a general task, so it is
 * the bounded identity role for a blank canvas choice. The launcher still
 * confirms that this role exists in the authoritative Role library before it
 * starts anything. The separate saved role selection stays empty and adds no
 * Worker directions to the session.
 */

export const DEFAULT_TREE_IDENTITY_ROLE = 'worker'

export function identityRoleForTreeNode(role) {
  const selected = typeof role === 'string' ? role.trim() : ''
  return selected || DEFAULT_TREE_IDENTITY_ROLE
}
