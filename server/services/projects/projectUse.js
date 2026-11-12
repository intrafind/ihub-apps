// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "This project is being used": a chat, a search, a workflow, an app or an
 * MCP client reads its knowledge (`services/knowledge/registry.js` →
 * `providerFor`). Opening the project page is not a use. The listener records
 * the use (`ProjectService.noteUse`, which keeps a project in refresh mode
 * `auto` refreshed in the background) and refreshes what is outdated
 * (`ProjectIngestService.refreshOnUse`, #3622), which is how a project
 * refreshed on demand, or one nobody used lately, gets current again.
 *
 * A module of its own so the knowledge layer can report a use without
 * importing the ingest pipeline. The listener runs in the background: a use
 * never waits for it, and its failure never fails the use.
 *
 * @module services/projects/projectUse
 */
import logger from '../../utils/logger.js';

let listener = null;

/**
 * Register what a use triggers (the bootstrap does, with the ingest pipeline).
 *
 * @param {((project: Object) => Promise<unknown>)|null} fn
 */
export function setProjectUseListener(fn) {
  listener = typeof fn === 'function' ? fn : null;
}

/**
 * Report that a project of the local tier is being used. Returns at once.
 *
 * @param {Object|null|undefined} project - As loaded, with its items.
 */
export function noteProjectUse(project) {
  if (!listener || !project?.id || !Array.isArray(project.items)) return;
  if ((project.tier || 'ihub') !== 'ihub') return;
  const notify = listener;
  Promise.resolve()
    .then(() => notify(project))
    .catch(error =>
      logger.warn('Could not refresh a project on use', {
        component: 'projectUse',
        projectId: project.id,
        error: error?.message
      })
    );
}
