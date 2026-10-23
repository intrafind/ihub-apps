// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an app does with projects, read the same way on the server and in the
 * browser. Two switches on the app, both on unless set to `false`
 * (Admin → Apps → Edit → Projects):
 *
 * - `features.projects`: the app uses projects at all — its linked admin
 *   projects, chats started inside a project, projects attached in the chat.
 * - `features.userProjects`: it takes personal (user) projects; only while it
 *   uses projects at all.
 *
 * The installation's `projects` / `userProjects` feature flags still have to
 * be on; these only narrow them. Pure and tolerant of a missing app.
 *
 * @module shared/appProjects
 */

/**
 * Whether an app uses projects at all.
 *
 * @param {Object|null|undefined} app - The app configuration.
 * @returns {boolean}
 */
export function appUsesProjects(app) {
  return app?.features?.projects !== false;
}

/**
 * Whether an app takes personal (user) projects.
 *
 * @param {Object|null|undefined} app - The app configuration.
 * @returns {boolean}
 */
export function appAllowsUserProjects(app) {
  return appUsesProjects(app) && app?.features?.userProjects !== false;
}
