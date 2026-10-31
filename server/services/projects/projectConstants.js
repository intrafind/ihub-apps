// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Constants of the project model shared by the validators and the access
 * policy. Dependency-free on purpose: the validators are imported by the app
 * schema, which the config cache loads, which the authorization layer reads
 * — a constant that lived beside the policy would close that cycle.
 *
 * @module services/projects/projectConstants
 */

/**
 * The most characters one item keeps (about 10 MB of text, 2.5 million tokens).
 * The BM25 search indexes a text this long in about two seconds, once, and
 * answers from the index in milliseconds. Longer text is cut, and the item is
 * marked `truncated`.
 */
export const MAX_ITEM_TEXT_CHARS = 10_000_000;

/** Most projects a chat may have attached besides its own container. */
export const MAX_ATTACHED_PROJECTS = 10;

/** Member target types. */
export const MEMBER_TARGET_TYPES = Object.freeze(['user', 'group', 'everyone']);

/** The roles a member can hold; the owner is not a member. */
export const MEMBER_ROLES = Object.freeze(['editor', 'user']);

/** Access levels a route can require. */
export const ACCESS_LEVELS = Object.freeze(['use', 'edit', 'share', 'own']);

/**
 * The tier policies the setting accepts. `ihub` offers local projects only;
 * `both` and `ifinder` also offer the user's iFinder smart collections as
 * projects (the iFinder tier, #3024): readable, and changeable by their owner.
 */
export const TIER_POLICIES = Object.freeze(['ihub', 'both', 'ifinder']);

/** The storage tiers a project can live in. `ifinder` projects are smart collections: their owner renames them and adds or removes documents. */
export const PROJECT_TIERS = Object.freeze(['ihub', 'ifinder']);

/**
 * Prefix of the id an iFinder smart collection gets as a project (`ifc_` plus
 * the collection's UUID). Like `prj_` it is reserved: no admin project may
 * carry it, so the two namespaces never collide.
 */
export const IFINDER_PROJECT_ID_PREFIX = 'ifc_';

const COLLECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a string is the project id of an iFinder smart collection. Strict on
 * purpose: the collection id goes into an iFinder URL, so only a UUID passes.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isIFinderProjectId(id) {
  return (
    typeof id === 'string' &&
    id.startsWith(IFINDER_PROJECT_ID_PREFIX) &&
    COLLECTION_ID.test(id.slice(IFINDER_PROJECT_ID_PREFIX.length))
  );
}

/**
 * The project id of a smart collection, or null when `collectionId` is no UUID.
 *
 * @param {unknown} collectionId
 * @returns {string|null}
 */
export function ifinderProjectIdOf(collectionId) {
  const id = typeof collectionId === 'string' ? collectionId.toLowerCase() : '';
  return COLLECTION_ID.test(id) ? `${IFINDER_PROJECT_ID_PREFIX}${id}` : null;
}

/**
 * The smart collection id behind an iFinder project id, or null.
 *
 * @param {unknown} projectId
 * @returns {string|null}
 */
export function collectionIdOf(projectId) {
  return isIFinderProjectId(projectId) ? projectId.slice(IFINDER_PROJECT_ID_PREFIX.length) : null;
}

/** The `source.type` of a project that stands for an iFinder smart collection. */
export const SMART_COLLECTION_SOURCE = 'smart-collection';

/**
 * Whether a stored project is the stub of an iFinder smart collection: a user
 * project the owner added from the catalog (or created as a collection) that
 * keeps the default app, the instructions and the chats, while the documents
 * stay in the collection. It stores no items of its own.
 *
 * @param {Object|null|undefined} project
 * @returns {boolean}
 */
export function isCollectionStub(project) {
  return (
    Boolean(project) &&
    !isIFinderProjectId(project.id) &&
    project.source?.type === SMART_COLLECTION_SOURCE &&
    typeof project.source.collectionId === 'string' &&
    COLLECTION_ID.test(project.source.collectionId)
  );
}

/**
 * The smart collection behind a project: the id of a collection project
 * (`ifc_…`) or the collection a stub stands for. Null for any other project.
 *
 * @param {Object|null|undefined} project
 * @returns {string|null}
 */
export function smartCollectionIdOf(project) {
  if (!project) return null;
  if (isCollectionStub(project)) return project.source.collectionId;
  return collectionIdOf(project.id);
}

/** Most items one project may hold, whatever an admin configures. */
export const MAX_FILES_CEILING = 50;

/** Most members one project may carry. */
export const MAX_MEMBERS = 100;

/** The access modes a link on an app, workflow or profile may declare. */
export const LINK_MODES = Object.freeze(['auto', 'context', 'tools']);
