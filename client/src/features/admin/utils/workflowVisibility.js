// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who can run a workflow, as the Workflows list shows it (AX-B10).
 *
 * The server decides access to a workflow only by the groups'
 * `permissions.workflows` (`server/services/workflow/workflowAccess.js`): a
 * group grants a workflow when the list holds `*` or the workflow id (ids
 * compare without regard to case). Admins can run every workflow. A
 * workflow's own `allowedGroups` is not read for access, so the list does not
 * show it.
 *
 * @module features/admin/utils/workflowVisibility
 */

/**
 * The groups whose own grants (`permissions.workflows`) include a workflow.
 * Groups that only inherit the grant are not listed; their members get it
 * through the listed group.
 *
 * @param {string} workflowId - The workflow's id.
 * @param {Object<string, Object>|null|undefined} groups - `GET /api/admin/groups` → `groups`.
 * @returns {string[]} Group ids, sorted.
 *
 * @example
 * groupsGrantingWorkflow('summarize', { users: { permissions: { workflows: ['Summarize'] } } });
 * // → ['users']
 */
export function groupsGrantingWorkflow(workflowId, groups) {
  if (!workflowId || !groups || typeof groups !== 'object') return [];
  const id = String(workflowId).toLowerCase();
  return Object.entries(groups)
    .filter(([, group]) => {
      const granted = group?.permissions?.workflows;
      if (!Array.isArray(granted)) return false;
      return granted.some(entry => entry === '*' || String(entry).toLowerCase() === id);
    })
    .map(([groupId]) => groupId)
    .sort((a, b) => a.localeCompare(b));
}
