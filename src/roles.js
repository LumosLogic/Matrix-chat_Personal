const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN:       'admin',
  AGENT:       'agent',
  USER:        'user',
};

// Ordered low → high privilege
const ROLE_HIERARCHY = ['user', 'agent', 'admin', 'super_admin'];

/**
 * Returns true if actorRole is at the same level or above requiredRole.
 */
function hasRoleOrAbove(actorRole, requiredRole) {
  return ROLE_HIERARCHY.indexOf(actorRole) >= ROLE_HIERARCHY.indexOf(requiredRole);
}

module.exports = { ROLES, ROLE_HIERARCHY, hasRoleOrAbove };
