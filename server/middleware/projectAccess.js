// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `projectAccessRequired(level)` — the per-resource gate of `/api/projects`
 * (spec 1 §7.1), modelled on `modelAccessRequired` for the shape and on the
 * prompt library's `loadUserPrompt` for the rules.
 *
 * It loads the project named by `req.params.projectId`, works out what the
 * caller may do with it and answers **404** when they may not even view it
 * (an id nobody shared with the caller confirms nothing), **403** with
 * `PERMISSION_DENIED` when they may view it but the route needs more. On
 * success `req.project`, `req.projectPermissions` and `req.projectContext`
 * carry the result into the handler, and `req.projectContext.authorize(level)`
 * builds the callback the repository re-runs under its lock.
 *
 * @module middleware/projectAccess
 */
import configCache from '../configCache.js';
import {
  enhanceUserWithPermissions,
  isAnonymousAccessAllowed,
  loadGroupsConfiguration
} from '../utils/authorization.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { sendErrorResponse, sendNotFound } from '../utils/responseHelpers.js';
import { loadUsers } from '../utils/userManager.js';
import { localUsersFile } from '../utils/contentsPath.js';
import { getProjectRepository } from '../services/projects/ProjectRepository.js';
import { isCollectionStub, isIFinderProjectId } from '../services/projects/projectConstants.js';
import { loadProjectFor } from '../services/projects/projectLoader.js';
import {
  ACCESS_LEVELS,
  effectiveGroups,
  isProjectAdmin,
  isProjectContentAdmin,
  projectPermissions,
  satisfiesLevel
} from '../services/projects/projectAccess.js';
import { linkedProjectIds } from '../services/projects/projectLinks.js';
import { collectionWriteSupport } from '../services/projects/ifinder/collectionLock.js';
import { isUserProjectsConfigured, projectSettings } from '../services/projects/projectSettings.js';

/**
 * Give the request a principal with resolved permissions, as the data routes
 * do: the signed-in user, or the anonymous principal when anonymous access
 * is on.
 *
 * @param {Object} req
 */
export function ensurePrincipal(req) {
  const platformConfig = configCache.getPlatform() || {};
  const authConfig = platformConfig.auth || {};
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
  }
  if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
    req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
  }
}

function groupsConfig() {
  try {
    return loadGroupsConfiguration();
  } catch {
    return { groups: {} };
  }
}

/** The local users database, for owner activity checks and share targets. */
export function usersDb() {
  const platform = configCache.getPlatform() || {};
  return loadUsers(localUsersFile(platform.localAuth)).users || {};
}

/** Whether a user id names a known, active local user. */
export function isActiveUser(users, id) {
  const user = Object.hasOwn(users, id) ? users[id] : null;
  return Boolean(user) && user.active !== false;
}

/**
 * The caller's standing towards projects: effective groups, admin flags and
 * the admin projects they reach through apps, workflows and agents.
 *
 * @param {Object} user - `req.user` with resolved permissions.
 * @returns {{config: Object, groups: string[], isAdmin: boolean, isContentAdmin: boolean,
 *   linked: Set<string>, users: Object, catalog: boolean, ifinderWritable: boolean}}
 */
export function callerContext(user) {
  const config = groupsConfig();
  return {
    config,
    groups: effectiveGroups(user, config),
    isAdmin: isProjectAdmin(user, config),
    isContentAdmin: isProjectContentAdmin(user, config),
    linked: linkedProjectIds(user),
    users: usersDb(),
    catalog: projectSettings(configCache.getPlatform() || {}).sharing.allowCatalog,
    ifinderWritable: collectionWriteSupport().writable
  };
}

/**
 * The permissions of `user` on `project`, given a context from
 * {@link callerContext}.
 *
 * @param {Object|null} project
 * @param {Object} user
 * @param {ReturnType<typeof callerContext>} context
 * @returns {ReturnType<typeof projectPermissions>}
 */
export function permissionsFor(project, user, context) {
  if (!project) return projectPermissions(null, user, {});
  return projectPermissions(project, user, {
    groups: context.groups,
    isAdmin: context.isAdmin,
    isContentAdmin: context.isContentAdmin,
    ownerActive:
      project.ownership === 'user' && project.owner?.id
        ? isActiveUser(context.users, project.owner.id)
        : true,
    linked: project.ownership === 'admin' && context.linked.has(project.id),
    catalog: context.catalog === true,
    ifinderWritable: context.ifinderWritable === true
  });
}

/** The methods that only read. */
const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * The writes a smart collection of the iFinder tier (`ifc_…`) takes, and nothing
 * else: rename, add documents, remove one. Each is named twice, because it is
 * checked twice: by the path below `/api/projects/:projectId` (the guard in front
 * of every route, before anything is looked up) and by the route it is
 * registered on (the gate of the route, `projectAccessRequired`). Every other
 * non-read request for an `ifc_` id is refused, including routes added later.
 * Each listed route still needs `permissions.canEdit`, which is the owner's.
 *
 * Creating a collection is `POST /api/projects`, which has no project id.
 */
export const IFINDER_WRITE_ROUTES = Object.freeze([
  { method: 'PATCH', route: '/:projectId', path: /^\/?$/ },
  { method: 'POST', route: '/:projectId/items', path: /^\/items\/?$/ },
  { method: 'DELETE', route: '/:projectId/items/:itemId', path: /^\/items\/[^/]+\/?$/ }
]);

function refuseReadOnly(res) {
  sendErrorResponse(
    res,
    403,
    'A project from iFinder can only be renamed, and have documents added or removed. Everything else is done in iFinder',
    { details: { code: 'PROJECT_READ_ONLY' } }
  );
  return true;
}

/**
 * Refuse a write to a project of the iFinder tier (a smart collection, `ifc_…`)
 * that is not on {@link IFINDER_WRITE_ROUTES}, before anything is looked up: the
 * answer is the same for an id that exists and one that does not. Used as the
 * guard of `/api/projects/:projectId`, where `req.path` is the part below it.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} projectId
 * @returns {boolean} True when the request was refused.
 */
export function refuseIFinderWrite(req, res, projectId) {
  if (!isIFinderProjectId(projectId) || READ_METHODS.has(req.method)) return false;
  const allowed = IFINDER_WRITE_ROUTES.some(
    entry =>
      entry.method === req.method && typeof req.path === 'string' && entry.path.test(req.path)
  );
  return allowed ? false : refuseReadOnly(res);
}

/**
 * The same refusal by the route the request matched (`req.route.path`, set by
 * express), for the gate of each route: a second line behind the path guard.
 * A request that matched no route template is refused.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} projectId
 * @returns {boolean} True when the request was refused.
 */
export function refuseIFinderWriteRoute(req, res, projectId) {
  if (!isIFinderProjectId(projectId) || READ_METHODS.has(req.method)) return false;
  const template = String(req.route?.path || '');
  const allowed = IFINDER_WRITE_ROUTES.some(
    entry => entry.method === req.method && template.endsWith(entry.route)
  );
  return allowed ? false : refuseReadOnly(res);
}

/**
 * The writes the stub of a smart collection (`isCollectionStub`) takes: those of
 * a collection (rename, which also sets the default app and the instructions,
 * add documents, remove one) plus deleting the stub. Members, the catalog,
 * transfers, pins, refreshes and every other kind of item are refused: the
 * documents live in the collection. Checked by the route the request matched,
 * once the project is loaded (a stub has a stored id, so the path guard
 * cannot tell it apart).
 */
export const COLLECTION_STUB_WRITE_ROUTES = Object.freeze([
  ...IFINDER_WRITE_ROUTES,
  { method: 'DELETE', route: '/:projectId', path: /^\/?$/ }
]);

/**
 * Refuse a write to a collection stub that is not on
 * {@link COLLECTION_STUB_WRITE_ROUTES}.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Object} project - The loaded project.
 * @returns {boolean} True when the request was refused.
 */
export function refuseCollectionStubWrite(req, res, project) {
  if (!isCollectionStub(project) || READ_METHODS.has(req.method)) return false;
  const template = String(req.route?.path || '');
  const allowed = COLLECTION_STUB_WRITE_ROUTES.some(
    entry => entry.method === req.method && template.endsWith(entry.route)
  );
  if (allowed) return false;
  sendErrorResponse(
    res,
    403,
    'A smart collection from iFinder can be renamed, configured, deleted, and have documents added or removed. Everything else is done in iFinder',
    { details: { code: 'PROJECT_READ_ONLY' } }
  );
  return true;
}

/**
 * The gate.
 *
 * @param {'use'|'edit'|'share'|'own'} level
 * @returns {import('express').RequestHandler}
 */
export function projectAccessRequired(level) {
  if (!ACCESS_LEVELS.includes(level)) {
    throw new TypeError(`Unknown project access level: ${level}`);
  }
  return async function projectAccess(req, res, next) {
    try {
      const { projectId } = req.params;
      if (!validateIdForPath(projectId, 'project', res)) return;
      if (refuseIFinderWriteRoute(req, res, projectId)) return;
      ensurePrincipal(req);
      const loaded = await loadProjectFor(req.user, projectId, {
        repository: getProjectRepository()
      });
      if (loaded.status === 'unavailable') {
        sendErrorResponse(res, 503, 'iFinder could not be reached', {
          details: { code: 'IFINDER_UNAVAILABLE' }
        });
        return;
      }
      const project = loaded.project || null;
      const context = callerContext(req.user);
      const permissions = permissionsFor(project, req.user, context);
      if (!project || !permissions.canView) {
        sendNotFound(res, 'Project');
        return;
      }
      // User projects sit behind the `userProjects` flag (spec 1 §7.3): while
      // it is off they stay dark, reads and writes alike, for everyone but a
      // full admin, who still reaches them for compliance.
      // An iFinder collection stays dark for an admin too: it is the caller's
      // own, not a project to read for compliance.
      if (
        project.ownership === 'user' &&
        (!context.isAdmin || isIFinderProjectId(project.id)) &&
        !isUserProjectsConfigured(configCache.getFeatures())
      ) {
        sendErrorResponse(res, 403, 'User projects are switched off', {
          details: { code: 'USER_PROJECTS_DISABLED' }
        });
        return;
      }
      // Where no lock reaches every iHub instance a collection cannot be changed
      // safely: say that, not a bare "no access" to its owner.
      if (
        isIFinderProjectId(project.id) &&
        level !== 'use' &&
        permissions.isOwner &&
        context.ifinderWritable !== true
      ) {
        sendErrorResponse(res, 403, 'Changing smart collections from iHub is switched off here', {
          details: {
            code: 'IFINDER_WRITES_DISABLED',
            reason: collectionWriteSupport().reason
          }
        });
        return;
      }
      if (refuseCollectionStubWrite(req, res, project)) return;
      if (!satisfiesLevel(permissions, level)) {
        sendErrorResponse(res, 403, 'You do not have the required access to this project', {
          details: { code: 'PERMISSION_DENIED', required: level }
        });
        return;
      }
      req.project = project;
      req.projectPermissions = permissions;
      req.projectContext = {
        ...context,
        /**
         * The same check again, for the repository to run on the project it
         * loads under its lock.
         *
         * @param {'use'|'edit'|'share'|'own'} required
         * @returns {(project: Object) => boolean}
         */
        authorize: required => loaded =>
          satisfiesLevel(permissionsFor(loaded, req.user, context), required)
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export default projectAccessRequired;
