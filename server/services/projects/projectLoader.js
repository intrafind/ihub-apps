// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One way to load a project by id for a user, whichever tier holds it: a
 * stored project (user or admin) comes from the repository, a smart collection
 * of the iFinder tier (`ifc_…`) from iFinder, with the user's own rights.
 *
 * A stored **collection stub** (`isCollectionStub`: a user project that stands
 * for one of the owner's smart collections, with its default app, instructions
 * and chats) comes from the repository and gets the collection's documents
 * from iFinder, read with the owner's rights, every time it is loaded. Nobody
 * else reads the collection: iFinder answers 404 for a collection that is not
 * the caller's, and a stub is never shared.
 *
 * Every reader of a project id the client chose (the access gate of
 * `/api/projects`, a chat's scope and attachments, a citation's source) loads
 * through here, so an `ifc_` id never reaches the repository and a stored id
 * never reaches iFinder.
 *
 * @module services/projects/projectLoader
 */
import { getProjectRepository } from './ProjectRepository.js';
import { ifinderProjectIdOf, isCollectionStub, isIFinderProjectId } from './projectConstants.js';
import { loadCollectionProject } from './ifinder/IFinderTier.js';

/**
 * @typedef {{status: 'ok', project: Object}|{status: 'not-found'}|{status: 'unavailable', name: string}} LoadedProject
 *   `unavailable`: the iFinder tier could not be asked; `name` is what the user last saw the
 *   collection called, or ''. A stored project is `ok` or `not-found`.
 */

/**
 * What a stub's collection looks like right now, as `project.collection`:
 *  - `ok`: the collection answered; its documents are the stub's items.
 *  - `deleted`: iFinder has no such collection (any more) for the owner.
 *  - `unavailable`: iFinder could not be asked, or the tier is not offered to
 *    the owner right now; the stub keeps working without documents.
 *  - `unknown`: someone other than the owner (a full admin's compliance read)
 *    loaded the stub; their rights cannot read the owner's collection.
 *
 * @typedef {{id: string, state: 'ok'|'deleted'|'unavailable'|'unknown', name?: string}} CollectionState
 */

/**
 * A stub with its collection's documents, for the user who loads it.
 *
 * @param {Object} user
 * @param {Object} stub - The stored stub.
 * @param {{signal?: AbortSignal, titles?: boolean}} [options]
 * @returns {Promise<Object>} The stub, with `items`, `usage` and `collection`.
 */
export async function withCollection(user, stub, { signal, titles = true } = {}) {
  const collectionId = stub.source.collectionId;
  const none = state => ({
    ...stub,
    items: [],
    usage: { items: 0, bytes: 0 },
    collection: { id: collectionId, state }
  });
  if (String(stub.owner?.id ?? '') !== String(user?.id ?? '')) return none('unknown');
  const loaded = await loadCollectionProject(user, ifinderProjectIdOf(collectionId), {
    signal,
    titles
  });
  if (loaded.status === 'not-found') return none('deleted');
  if (loaded.status !== 'ok') return none('unavailable');
  const collection = loaded.project;
  return {
    ...stub,
    items: collection.items,
    usage: { items: collection.items.length, bytes: 0 },
    collection: {
      id: collectionId,
      state: 'ok',
      name: collection.name,
      description: collection.description || ''
    }
  };
}

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
    if (loaded.status === 'unavailable') return { status: 'unavailable', name: loaded.name || '' };
    return { status: 'not-found' };
  }
  const project = await (repository || getProjectRepository()).get(projectId);
  if (!project) return { status: 'not-found' };
  if (isCollectionStub(project)) {
    return { status: 'ok', project: await withCollection(user, project, { signal }) };
  }
  return { status: 'ok', project };
}

export default loadProjectFor;
