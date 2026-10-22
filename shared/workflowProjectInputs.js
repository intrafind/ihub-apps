// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Names a start input of type `project` may not take (#1036). `input` is the
 * argument a chat run passes the user's message under (`workflowRunner`), so
 * a project input of that name would receive the sentence as its project id.
 * The workflow schema refuses such a declaration and the editor flags it.
 *
 * @module shared/workflowProjectInputs
 */

/** Input names reserved for the runner. */
export const RESERVED_PROJECT_INPUT_NAMES = Object.freeze(['input']);

/**
 * The names of a start node's project inputs that use a reserved name.
 *
 * @param {Array<{name?: string, type?: string}>|undefined} inputVariables
 * @returns {string[]}
 */
export function reservedProjectInputNames(inputVariables) {
  return (Array.isArray(inputVariables) ? inputVariables : [])
    .filter(
      variable =>
        variable?.type === 'project' &&
        typeof variable.name === 'string' &&
        RESERVED_PROJECT_INPUT_NAMES.includes(variable.name.trim())
    )
    .map(variable => variable.name.trim());
}
