// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the `state.create` of a navigation asks the target page to open, set
 * by the sidebar's "Create" menu: the library (`/prompts`) opens its prompt or
 * skill editor, the projects page its create dialog. Navigation state, not a
 * URL parameter: a bookmark or a reload never opens a dialog.
 */
export const CREATE_INTENT = Object.freeze({
  prompt: 'prompt',
  skill: 'skill',
  project: 'project'
});
