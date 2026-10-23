// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Linked items: a project item that stands for an item of another project
 * (kind `project-item`). Nothing is copied: the link holds the source
 * project and item id, and every read goes to the source item as it is now.
 *
 *  - **Adding** a link takes real access to the source: the caller owns it
 *    or is a member (user project), or reaches it through an app, workflow
 *    or agent, or manages it (admin project). A full admin's compliance read
 *    of someone else's project is not enough. A link to a link is stored as
 *    a link to the original, so a chain never forms.
 *  - **Reading** a link checks the *reading* user against the source, like
 *    an iFinder item: a member of the linking project who may not use the
 *    source gets `SOURCE_FORBIDDEN` for that item, never its text. A link is
 *    no way round the source project's members.
 *
 * @module services/projects/projectItemLinks
 */
import configCache from '../../configCache.js';
import { callerContext, permissionsFor } from '../../middleware/projectAccess.js';
import { KnowledgeError } from '../knowledge/types.js';
import { ProjectError } from './projectErrors.js';
import { getProjectRepository, isUserProjectId } from './ProjectRepository.js';
import { isProjectsConfigured, isUserProjectsConfigured } from './projectSettings.js';

/** The kind id of a linked item. */
export const PROJECT_ITEM_KIND = 'project-item';

function nameOf(project) {
  const name = project?.name;
  if (typeof name === 'string') return name;
  return name?.en || Object.values(name || {})[0] || project?.id || '';
}

/** Where a link points, for the item's provenance: the source project's page. */
export function linkSource(project) {
  return {
    site: nameOf(project),
    ...(isUserProjectId(project?.id) ? { url: `/projects/${project.id}` } : {})
  };
}

/** Whether the projects a link may point into are switched on. */
function sourceFeatureOn(project) {
  const features = configCache.getFeatures();
  if (!isProjectsConfigured(features)) return false;
  return project.ownership !== 'user' || isUserProjectsConfigured(features);
}

/**
 * Check a new link and resolve it to the original item.
 *
 * @param {{projectId: string, itemId: string}} ref - As the caller sent it.
 * @param {{user: Object, projectId: string}} options - The caller and the project the
 *   link goes into.
 * @returns {Promise<{ref: {projectId: string, itemId: string}, name: string,
 *   source: {site: string, url?: string}}>}
 * @throws {ProjectError} `INVALID_REF` (the same project), `PROJECT_NOT_FOUND`,
 *   `ITEM_NOT_FOUND`, `PERMISSION_DENIED`.
 */
export async function resolveProjectItemLink(ref, { user, projectId }) {
  const repository = getProjectRepository();
  let sourceProjectId = ref.projectId;
  let sourceItemId = ref.itemId;
  // One hop at most: links are stored as links to the original.
  for (let hop = 0; hop < 2; hop += 1) {
    if (sourceProjectId === projectId) {
      throw new ProjectError('INVALID_REF', 'A project cannot link its own documents');
    }
    const project = await repository.get(sourceProjectId);
    const permissions = project ? permissionsFor(project, user, callerContext(user)) : null;
    // A compliance read is not a membership: an admin links what they use.
    if (
      !project ||
      !sourceFeatureOn(project) ||
      !permissions.canUse ||
      (project.ownership === 'user' && permissions.role === 'admin')
    ) {
      throw new ProjectError('PROJECT_NOT_FOUND', 'The source project was not found');
    }
    const item = (project.items || []).find(entry => entry.id === sourceItemId);
    if (!item) throw new ProjectError('ITEM_NOT_FOUND', 'The source document was not found');
    if (item.kind !== PROJECT_ITEM_KIND) {
      return {
        ref: { projectId: project.id, itemId: item.id },
        name: item.name,
        source: linkSource(project)
      };
    }
    sourceProjectId = item.ref?.projectId;
    sourceItemId = item.ref?.itemId;
  }
  throw new ProjectError('INVALID_REF', 'The source document is a link to another link');
}

const contexts = new WeakMap();

/** The reader's project context, once per reader object. */
function readerContext(user) {
  if (!contexts.has(user)) contexts.set(user, callerContext(user));
  return contexts.get(user);
}

/**
 * The source project and item a link reads, for the reading user.
 *
 * @param {Object} project - The project holding the link.
 * @param {Object} item - The link item.
 * @param {Object|null|undefined} user - The reader.
 * @returns {Promise<{project: Object, item: Object}>}
 * @throws {KnowledgeError} `SOURCE_FORBIDDEN` when the reader may not use the
 *   source, `SOURCE_GONE` when the source project or item is gone, `INVALID_REF`
 *   for a link to a link.
 */
export async function loadLinkedItem(project, item, user) {
  const where = { projectId: project?.id, itemId: item?.id };
  const { projectId, itemId } = item?.ref || {};
  if (!user) {
    throw new KnowledgeError(
      'SOURCE_FORBIDDEN',
      'A linked document needs a signed-in reader',
      where
    );
  }
  const source = projectId ? await getProjectRepository().get(projectId) : null;
  if (!source || !sourceFeatureOn(source)) {
    throw new KnowledgeError('SOURCE_GONE', 'The project of this linked document is gone', where);
  }
  if (!permissionsFor(source, user, readerContext(user)).canUse) {
    throw new KnowledgeError(
      'SOURCE_FORBIDDEN',
      'This document is linked from a project the reader may not use',
      where
    );
  }
  const linked = (source.items || []).find(entry => entry.id === itemId);
  if (!linked) {
    throw new KnowledgeError('SOURCE_GONE', 'The linked document was removed', where);
  }
  if (linked.kind === PROJECT_ITEM_KIND) {
    throw new KnowledgeError('INVALID_REF', 'A link to a link is not read', where);
  }
  return { project: source, item: linked };
}

/**
 * How each link of a project reads for one viewer, for the project page:
 * `ok`, `forbidden` (the viewer may not use the source project) or `gone`
 * (the source project or document was removed). Other items are left out.
 *
 * @param {Object} project - Stored project.
 * @param {Object} user - The viewer.
 * @returns {Promise<Map<string, {state: 'ok'|'forbidden'|'gone', projectName?: string,
 *   status?: string}>>} `status` is the original's item status.
 */
export async function linkStatesFor(project, user) {
  const states = new Map();
  const links = (project?.items || []).filter(item => item.kind === PROJECT_ITEM_KIND);
  await Promise.all(
    links.map(async item => {
      try {
        const linked = await loadLinkedItem(project, item, user);
        states.set(item.id, {
          state: 'ok',
          projectName: nameOf(linked.project),
          // The original may still be extracting, or have failed.
          status: linked.item.status
        });
      } catch (error) {
        states.set(item.id, {
          state:
            error instanceof KnowledgeError && error.code === 'SOURCE_FORBIDDEN'
              ? 'forbidden'
              : 'gone'
        });
      }
    })
  );
  return states;
}
