// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ProjectScope — which projects a request reaches, in which mode (spec 2
 * §4.2). Built once per request from the app's `projects` links (admin
 * pinning), the chat's container project, the projects attached from the
 * chat-input picker and, for workflows, the node's or workflow's links; each
 * resolved and filtered by what the user may use. A tool call never widens
 * the scope: the model cannot name a project the request did not bring.
 *
 * The request hands the ids over on the app object, the way skills travel
 * (`_activeSkills`): `_projectId` (container), `_attachedProjectIds`
 * (picker), `_workflowProjects` (executor), beside the configured
 * `projects`.
 *
 * @module services/knowledge/ProjectScope
 */
import configCache from '../../configCache.js';
import { callerContext, permissionsFor } from '../../middleware/projectAccess.js';
import { getProjectRepository } from '../projects/ProjectRepository.js';
import { loadProjectFor } from '../projects/projectLoader.js';
import logger from '../../utils/logger.js';
import {
  appAllowsUserProjects,
  appUsesProjects,
  isProjectsConfigured,
  isUserProjectsConfigured
} from '../projects/projectSettings.js';
import { normalizeProjectLink } from '../../validators/projectSchema.js';
import { projectDescription, projectName } from '../projects/projectView.js';

/**
 * @typedef {Object} ScopeEntry
 * @property {Object} project - The stored project.
 * @property {'auto'|'context'|'tools'} mode
 * @property {boolean} write
 * @property {'container'|'app'|'attached'|'workflow'} origin
 * @property {boolean} instructions - Whether its instructions apply to the prompt.
 */

/**
 * The scope of a request.
 *
 * @param {Object} options
 * @param {Object} options.appConfig - The app (or node config) with its link fields.
 * @param {Object} options.user - The requesting user with resolved permissions.
 * @returns {Promise<ScopeEntry[]>} In order: container, app links, attachments, workflow links.
 */
export async function resolveProjectScope({ appConfig, user }) {
  if (!appConfig || !user) return [];
  // The master switch darkens every project, admin ones included: a chat
  // must not inject or search knowledge the Projects API itself refuses.
  const features = configCache.getFeatures();
  if (!isProjectsConfigured(features)) return [];
  const wanted = [];
  const seen = new Set();
  const add = (id, mode, write, origin, instructions) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    wanted.push({ id, mode, write, origin, instructions });
  };
  // An app the admin switched projects off for (`features.projects: false`)
  // reaches none of its own: no container, no linked or attached project.
  // A workflow's links are the workflow's, not the app's.
  if (appUsesProjects(appConfig)) {
    if (typeof appConfig._projectId === 'string')
      add(appConfig._projectId, 'auto', false, 'container', true);
    for (const link of Array.isArray(appConfig.projects) ? appConfig.projects : []) {
      const { id, mode, write } = normalizeProjectLink(link);
      add(id, mode, write, 'app', true);
    }
    for (const id of Array.isArray(appConfig._attachedProjectIds)
      ? appConfig._attachedProjectIds
      : []) {
      if (typeof id === 'string') add(id, 'auto', false, 'attached', false);
    }
  }
  for (const link of Array.isArray(appConfig._workflowProjects)
    ? appConfig._workflowProjects
    : []) {
    const { id, mode, write } = normalizeProjectLink(link);
    add(id, mode, write, 'workflow', true);
  }
  if (!wanted.length) return [];

  const repository = getProjectRepository();
  const context = callerContext(user);
  // User projects are reached only while their feature is on, here and for
  // this app: a saved container or attachment stays on the chat, dark until
  // the feature returns. Admin projects linked to apps keep working as long
  // as the master switch is on.
  const userProjectsOn = isUserProjectsConfigured(features) && appAllowsUserProjects(appConfig);
  // Every project is loaded at once: a smart collection of the iFinder tier is a
  // round trip to iFinder (with the user's own rights), a stored project a read
  // of the repository. The scope keeps the order of `wanted`.
  const loads = await Promise.all(
    wanted.map(entry => loadProjectFor(user, entry.id, { repository }))
  );
  const scope = [];
  for (const [index, entry] of wanted.entries()) {
    const loaded = loads[index];
    if (loaded.status === 'unavailable') {
      logger.warn(
        'A project of the iFinder tier was left out of the scope: iFinder is unavailable',
        {
          component: 'ProjectScope',
          projectId: entry.id
        }
      );
      continue;
    }
    const project = loaded.project;
    if (!project) continue;
    if (project.ownership === 'user' && !userProjectsOn) continue;
    const permissions = permissionsFor(project, user, context);
    if (!permissions.canUse) continue;
    scope.push({
      project,
      mode: entry.mode,
      write: entry.write && (permissions.canEdit || project.ownership === 'admin'),
      origin: entry.origin,
      instructions: entry.instructions
    });
  }
  return scope;
}

/**
 * One line per project for the model: id, name, size and how it is reached.
 *
 * @param {Array<{project: Object, effective?: 'loaded'|'searched', mode: string}>} scope
 * @param {string} [language]
 * @returns {string}
 */
export function describeScope(scope, language = 'en') {
  return scope
    .map(entry => {
      const ready = (entry.project.items || []).filter(
        item => item.status === 'ready' || item.status === 'stale'
      ).length;
      const how = entry.effective === 'loaded' ? 'loaded in full' : 'search it';
      // The tool descriptions are a higher-trust channel than the prompt's
      // project block: only what an admin wrote goes there, not the text of a
      // user project that an editor may change.
      const holds =
        entry.project.ownership === 'admin' ? projectDescription(entry.project, language, 200) : '';
      return `${entry.project.id} ("${projectName(entry.project, language)}", ${ready} documents, ${how}${holds ? `; ${holds}` : ''})`;
    })
    .join('; ');
}
