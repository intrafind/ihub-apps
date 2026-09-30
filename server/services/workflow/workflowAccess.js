/**
 * Who may run which workflow.
 *
 * One rule for every way a workflow is started by a person: the workflow
 * pages (`routes/workflow/workflowRoutes.js`) and an `@mention` in a chat
 * (`routes/chat/sessionRoutes.js`). The chat composer only offers workflows
 * the viewer may run and the app lists; the server has to hold the same line,
 * because the mention is just text a caller can type or post.
 *
 * @module services/workflow/workflowAccess
 */
import { filterResourcesByPermissions } from '../../utils/authorization.js';
import { hasIdCaseInsensitive } from '../../utils/resourceLookup.js';

/**
 * Checks if a user has admin privileges.
 *
 * @param {Object} user - User object from request
 * @returns {boolean} True if user has admin access
 */
export function isAdmin(user) {
  if (!user) return false;
  return user.groups?.includes('admin') || user.permissions?.adminAccess === true;
}

/**
 * Filters workflows based on user permissions from groups.json.
 * Uses the standard group-based permission system (permissions.workflows)
 * consistent with how apps, models, and prompts are handled.
 *
 * @param {Object[]} workflows - Array of workflow definitions
 * @param {Object} user - User object with groups and permissions
 * @returns {Object[]} Filtered array of accessible workflows
 */
export function filterByPermissions(workflows, user) {
  if (!Array.isArray(workflows)) {
    return [];
  }

  // Admin users can see all workflows
  if (isAdmin(user)) {
    return workflows;
  }

  // Use the standard permission system via user.permissions.workflows
  const workflowPermissions = user?.permissions?.workflows;
  if (!workflowPermissions) {
    return [];
  }

  return filterResourcesByPermissions(workflows, workflowPermissions);
}

/**
 * Whether `@<workflow>` in a chat of `app` may start the workflow for `user`:
 * the app lists it (`app.workflows`) and the user's groups grant it — the two
 * conditions the composer's picker filters by.
 *
 * @param {Object} params
 * @param {Object} params.user - `req.user`
 * @param {Object|null|undefined} params.app - The chat's app configuration
 * @param {Object} params.workflow - The mentioned workflow definition
 * @returns {{allowed: true}|{allowed: false, reason: 'not_in_app'|'not_permitted'}}
 */
export function mentionAccess({ user, app, workflow }) {
  // Permission first: the "not in this app" refusal names the workflow, so
  // answering it for a workflow the caller may not run would confirm that the
  // workflow exists.
  if (!workflow?.id || filterByPermissions([workflow], user).length === 0) {
    return { allowed: false, reason: 'not_permitted' };
  }
  const listed = Array.isArray(app?.workflows) ? new Set(app.workflows) : new Set();
  if (!hasIdCaseInsensitive(listed, workflow.id)) {
    return { allowed: false, reason: 'not_in_app' };
  }
  return { allowed: true };
}
