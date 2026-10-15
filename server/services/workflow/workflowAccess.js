/**
 * Who may run which workflow.
 *
 * One rule for every way a workflow is started: the workflow pages
 * (`routes/workflow/workflowRoutes.js`), an `@mention` in a chat
 * (`routes/chat/sessionRoutes.js`) and a tool call of an app's model
 * (`toolLoader.js`, `tools/workflowRunner.js`). The chat composer only offers
 * workflows the viewer may run and the app lists; the server has to hold the
 * same line, because the mention is just text a caller can type or post, and a
 * model's tool call is only as trustworthy as the person it acts for.
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
  // The anonymous principal is never an admin, whatever groups it carries.
  if (!user || user.id === 'anonymous') return false;
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
 * conditions the composer's picker filters by. The same two conditions decide
 * whether the app's model is offered the workflow as a tool and may call it.
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

/**
 * Whether `user` may start `workflow` through the workflow runner
 * (`tools/workflowRunner.js`), the one place every start converges: a tool call
 * of an app's model, of a workflow's agent step, the tool endpoint, the MCP and
 * A2A gateways and an `@mention`. Those last three check on their own first and
 * pass the same user, so the two checks agree.
 *
 * Inside an app (`app` given) it is the mention rule: the app lists the
 * workflow and the user's groups grant it. Without an app, such as a direct
 * call of the tool endpoint, the user's groups alone decide.
 *
 * A call that carries no user, which is every call that did not come from a
 * person, has no permissions and is refused.
 *
 * @param {Object} params
 * @param {Object|null|undefined} params.user - Who the run acts for
 * @param {Object|null|undefined} params.app - The chat's app configuration, when the call is made on behalf of one
 * @param {Object} params.workflow - The workflow definition
 * @returns {boolean}
 */
export function runnerAccess({ user, app, workflow }) {
  if (app) return mentionAccess({ user, app, workflow }).allowed;
  return Boolean(workflow?.id) && filterByPermissions([workflow], user).length > 0;
}
