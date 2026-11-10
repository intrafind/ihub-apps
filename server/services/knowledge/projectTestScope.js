// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The test scope of an admin project (#3309): the scratch chat of the project
 * editor runs a real chat of an app, but with exactly one project in scope —
 * the one being tested — so a wrong answer can only come from that project's
 * config, never from other knowledge the app happens to link.
 *
 * The request names the project (`testProjectId` on the chat POST). The route
 * authorizes it here, once, and hands the id to the request builder, which
 * narrows the app with {@link applyProjectTestScope}. Like the container and
 * attached projects, the id then travels on the app object, so the prompt
 * builder and the knowledge tools see one scope.
 *
 * The turn runs as the signed-in admin: how other users reach the project
 * (app links, publishing, groups) is not exercised, which the editor says.
 *
 * @module services/knowledge/projectTestScope
 */
import configCache from '../../configCache.js';
import { isContentAdmin } from '../../utils/authorization.js';
import { getProjectRepository, isAdminProjectId } from '../projects/ProjectRepository.js';
import { isProjectsConfigured } from '../projects/projectSettings.js';

/**
 * A refusal: the status and code the API answers with, and the key of its
 * message in `serverErrors` (`shared/i18n`), which the route localizes.
 *
 * @typedef {{ok: false, status: number, code: string, messageKey: string}} ProjectTestRefusal
 */

/**
 * @typedef {{ok: true, projectId: string}|ProjectTestRefusal} ProjectTestScope
 */

/** @returns {ProjectTestRefusal} */
function refusal(status, code, messageKey) {
  return { ok: false, status, code, messageKey };
}

/** `origin.createdVia` of a chat that a project test started. */
export const PROJECT_TEST_ORIGIN = 'project-test';

/**
 * The origin a project test stamps on its chat: what makes it a test chat
 * for good, so it cannot be kept (`PATCH /api/chats/:id`) and a test of
 * another project cannot continue it.
 *
 * @param {string} projectId
 * @returns {{createdVia: string, projectId: string}}
 */
export function projectTestOrigin(projectId) {
  return { createdVia: PROJECT_TEST_ORIGIN, projectId };
}

/**
 * Whether a stored chat is one a project test started.
 *
 * @param {Object|null|undefined} chat
 * @returns {boolean}
 */
export function isProjectTestChat(chat) {
  return chat?.origin?.createdVia === PROJECT_TEST_ORIGIN;
}

/**
 * Whether a test of `projectId` may run its turn in an existing chat.
 *
 * Only a temporary chat that this test started, so a scratch chat is never
 * kept and a test never reads another conversation: a chat with messages that
 * no test started (the admin's own incognito chat) is refused. One nothing has
 * been said in yet may become a test chat: a file uploaded before the first
 * message creates the chat, and that is how a test chat can begin.
 *
 * @param {Object|null|undefined} chat - The stored chat; none for a new one.
 * @param {string} projectId - The project under test.
 * @returns {ProjectTestRefusal|null} Why not, or null when the turn may run.
 */
export function checkProjectTestChat(chat, projectId) {
  if (!chat) return null;
  if (chat.temporary !== true) {
    return refusal(409, 'PROJECT_TEST_CHAT_KEPT', 'projectTestChatKept');
  }
  if (isProjectTestChat(chat)) {
    return chat.origin.projectId === projectId
      ? null
      : refusal(409, 'PROJECT_TEST_CHAT_MISMATCH', 'projectTestChatMismatch');
  }
  return Number(chat.messageCount) > 0
    ? refusal(409, 'PROJECT_TEST_CHAT_MISMATCH', 'projectTestChatMismatch')
    : null;
}

/**
 * Check that the caller may test the project, and that it can be tested.
 *
 * Only a content admin tests a project, and only an admin project: the
 * editor edits those, and a user project is somebody's own. A disabled or
 * unpublished project can be tested, which is the point of testing it before
 * it is switched on.
 *
 * @param {Object} options
 * @param {Object|undefined} options.user - `req.user` with resolved permissions.
 * @param {unknown} options.testProjectId - `req.body.testProjectId`.
 * @param {{get: (id: string) => Promise<Object|null>}} [options.repository]
 * @returns {Promise<ProjectTestScope>}
 */
export async function resolveProjectTestScope({ user, testProjectId, repository }) {
  if (!user || user.id === 'anonymous' || !isContentAdmin(user)) {
    return refusal(403, 'PROJECT_TEST_FORBIDDEN', 'projectTestForbidden');
  }
  const notFound = refusal(404, 'PROJECT_NOT_FOUND', 'projectTestNotFound');
  if (!isProjectsConfigured(configCache.getFeatures())) return notFound;
  if (typeof testProjectId !== 'string' || !isAdminProjectId(testProjectId)) return notFound;
  const project = await (repository || getProjectRepository()).get(testProjectId);
  if (project?.ownership !== 'admin') return notFound;
  return { ok: true, projectId: project.id };
}

/**
 * What a project test takes off the app: the projects it reaches by other
 * means than its own links (the chat's container, the attached ones, a
 * workflow's) and everything it can hand a question on to — other apps and
 * workflows called as tools. Those run with their own configuration, which
 * would bring other knowledge into a test of one project.
 */
const OMITTED_FIELDS = [
  '_projectId',
  '_attachedProjectIds',
  '_knowledgeMode',
  '_workflowProjects',
  'apps',
  'workflows'
];

/**
 * The app as a project test runs it: this project is the only one in scope
 * and the app hands nothing on. The app's own links, the chat's container and
 * anything attached are left out, so are the other apps and workflows it can
 * call (`OMITTED_FIELDS`), and the app's switch for projects is overridden —
 * the test is about the project, not about whether this app is set up to use
 * projects.
 *
 * @param {Object} app - The configured app.
 * @param {string} projectId - An id {@link resolveProjectTestScope} accepted.
 * @returns {Object} A copy of the app; the configured one is never touched.
 */
export function applyProjectTestScope(app, projectId) {
  const scoped = { ...app };
  for (const field of OMITTED_FIELDS) delete scoped[field];
  return {
    ...scoped,
    // No mode of its own: the project is tested in the mode its own default sets.
    projects: [{ id: projectId }],
    features: { ...app.features, projects: true }
  };
}
