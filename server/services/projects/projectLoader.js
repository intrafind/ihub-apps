// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One way to load a project by id for a user, whichever tier holds it: a
 * stored project (user or admin) comes from the repository, a smart collection
 * of the iFinder tier (`ifc_…`) from iFinder, with the user's own rights.
 *
 * Every reader of a project id the client chose (the access gate of
 * `/api/projects`, a chat's scope and attachments, a citation's source) loads
 * through here, so an `ifc_` id never reaches the repository and a stored id
 * never reaches iFinder.
 *
 * @module services/projects/projectLoader
 */
import { getProjectRepository } from './ProjectRepository.js';
import { isIFinderProjectId } from './projectConstants.js';
import { loadCollectionProject } from './ifinder/IFinderTier.js';

/**
 * @typedef {{status: 'ok', project: Object}|{status: 'not-found'}|{status: 'unavailable'}} LoadedProject
 *   `unavailable`: the iFinder tier could not be asked. A stored project is `ok` or `not-found`.
 */

/**
 * @param {Object} user - The requesting user (their rights decide what an iFinder collection answers).
 * @param {string} projectId
 * @param {{repository?: {get: (id: string) => Promise<Object|null>}, signal?: AbortSignal}} [options]
 * @returns {Promise<LoadedProject>}
 */
export async function loadProjectFor(user, projectId, { repository, signal } = {}) {
  if (isIFinderProjectId(projectId)) {
    const loaded = await loadCollectionProject(user, projectId, { signal });
    if (loaded.status === 'ok') return loaded;
    return { status: loaded.status === 'unavailable' ? 'unavailable' : 'not-found' };
  }
  const project = await (repository || getProjectRepository()).get(projectId);
  return project ? { status: 'ok', project } : { status: 'not-found' };
}

export default loadProjectFor;
