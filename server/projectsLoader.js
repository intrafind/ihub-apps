// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createResourceLoader, createValidator } from './utils/resourceLoader.js';

/**
 * Admin projects loader.
 *
 * Loads admin projects from individual files in `contents/projects/`,
 * mirroring `toolsLoader.js`. Admin projects are the successor of
 * `config/sources.json` (#1036): configuration an admin links to apps,
 * workflows and agents. User projects are runtime data and never pass
 * through here.
 */
const projectsLoader = createResourceLoader({
  resourceName: 'Projects',
  // createResourceLoader requires a legacyPath, but loadAllProjects() below
  // only ever calls loadFromFiles() — this path is never read.
  legacyPath: 'config/projects.json',
  individualPath: 'projects',
  validateItem: createValidator(['id', 'name'])
});

function nameOf(project) {
  if (project.name && typeof project.name === 'object') {
    return project.name.en || project.name[Object.keys(project.name)[0]] || '';
  }
  return project.name || project.id || '';
}

/**
 * Load every admin project.
 *
 * @param {boolean} [includeDisabled=false]
 * @param {boolean} [verbose=true]
 * @returns {Promise<Object[]>} Projects sorted by name.
 */
export async function loadAllProjects(includeDisabled = false, verbose = true) {
  const projects = await projectsLoader.loadFromFiles(verbose);
  const filtered = includeDisabled ? projects : projects.filter(p => p.enabled !== false);
  return filtered.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

export default projectsLoader;
