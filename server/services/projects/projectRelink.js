// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Re-pointing links when admin projects are merged: the `projects` lists of
 * apps, workflows (the workflow, its project nodes, planner task templates)
 * and agent profiles that name a merged project name the target instead.
 *
 * The stored documents are rewritten, never the cached ones (the cache holds
 * inheritance already merged in), through `ConfigStore.updateJson` so a
 * concurrent save of the same file is not overwritten.
 *
 * @module services/projects/projectRelink
 */
import configCache from '../../configCache.js';
import configStore from '../config/ConfigStore.js';
import { normalizeProjectLink } from '../../validators/projectSchema.js';
import { workflowLinkOwners } from './projectLinks.js';

const KINDS = Object.freeze([
  {
    type: 'app',
    namespace: 'apps',
    owners: doc => [doc],
    refresh: () => configCache.refreshAppsCache()
  },
  {
    type: 'workflow',
    namespace: 'workflows',
    owners: workflowLinkOwners,
    refresh: () => configCache.refreshWorkflowsCache?.()
  },
  {
    type: 'agent',
    namespace: 'agents',
    owners: doc => [doc],
    refresh: () => configCache.refreshAgentProfilesCache()
  }
]);

/**
 * The `projects` list after the links to `fromIds` became one link to
 * `toId`, or null when the list names none of them.
 *
 * The merged link takes the place of the first link to a source or to the
 * target. Its access mode is the mode they share, `auto` when they differ
 * (the project is loaded in full while it fits and searched otherwise, which
 * serves either), and it may write when any of them could.
 *
 * @param {unknown} list
 * @param {Set<string>} fromIds
 * @param {string} toId
 * @returns {Array<string|Object>|null}
 */
export function relinkList(list, fromIds, toId) {
  if (!Array.isArray(list)) return null;
  const merges = link => {
    const { id } = normalizeProjectLink(link);
    return fromIds.has(id) || id === toId;
  };
  if (!list.some(link => fromIds.has(normalizeProjectLink(link).id))) return null;
  const merging = list.filter(merges).map(normalizeProjectLink);
  const mode = merging.every(link => link.mode === merging[0].mode) ? merging[0].mode : 'auto';
  const write = merging.some(link => link.write);
  const merged = mode === 'auto' && !write ? toId : { id: toId, mode, write };
  const first = list.findIndex(merges);
  const result = [];
  list.forEach((link, index) => {
    if (!merges(link)) result.push(link);
    else if (index === first) result.push(merged);
  });
  return result;
}

function nameOf(doc, fallback) {
  const { name } = doc || {};
  if (name && typeof name === 'object') return name.en || Object.values(name)[0] || fallback;
  return name || fallback;
}

/**
 * Re-point every link to one of `fromIds` at `toId` on apps, workflows and
 * agent profiles.
 *
 * @param {string[]} fromIds - The merged (source) projects.
 * @param {string} toId - The project that remains.
 * @returns {Promise<Array<{type: 'app'|'workflow'|'agent', id: string, name: string}>>}
 *   The documents that changed.
 */
export async function relinkProjects(fromIds, toId) {
  const from = new Set(fromIds);
  const changed = [];
  const touches = (kind, doc) =>
    kind.owners(doc).some(owner => relinkList(owner?.projects, from, toId));
  for (const kind of KINDS) {
    // Strict: a document the store cannot read would keep its old links and
    // dangle once the source is deleted, so the merge stops instead.
    const documents = await configStore.listDocuments(kind.namespace, { strict: true });
    let any = false;
    for (const { key, path, data } of documents) {
      if (!data || typeof data !== 'object' || !touches(kind, data)) continue;
      let rewritten = false;
      await configStore.updateJson(path, current => {
        // May run again on a conflicting write: derive everything from `current`.
        rewritten = false;
        if (!current || typeof current !== 'object') return undefined;
        for (const owner of kind.owners(current)) {
          const next = relinkList(owner?.projects, from, toId);
          if (next) {
            owner.projects = next;
            rewritten = true;
          }
        }
        return rewritten ? current : undefined;
      });
      if (rewritten) {
        any = true;
        changed.push({ type: kind.type, id: data.id || key, name: nameOf(data, data.id || key) });
      }
    }
    if (any) await kind.refresh();
  }
  return changed;
}

export default relinkProjects;
