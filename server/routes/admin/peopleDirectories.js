// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { installedIntegrationRefs } from '../../services/integrations/installedRefs.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import {
  sendBadRequest,
  sendFailedOperationError,
  sendNotFound
} from '../../utils/responseHelpers.js';
import {
  PEOPLE_DIRECTORY_DEFAULTS,
  PEOPLE_DIRECTORY_LIMITS,
  peopleDirectoriesFileSchema
} from '../../validators/peopleDirectorySchema.js';
import { MAPPED_PERSON_FIELDS, SEARCH_PRESETS } from '../../services/peopleDirectory/presets.js';
import {
  findDirectory,
  findDirectoryIdConflict,
  getConfiguredDirectories,
  summarizeDirectory
} from '../../services/peopleDirectory/PeopleDirectoryService.js';
import { testDirectory } from '../../services/peopleDirectory/peopleDirectoryRunner.js';
import { clearUnitsCache } from '../../services/peopleDirectory/LdapDirectory.js';

/**
 * Admin API for people directories (`contents/config/peopleDirectories.json`).
 *
 *   GET    /api/admin/people-directories                       the file, with per-directory summaries
 *   PUT    /api/admin/people-directories                       replace the file (Zod-validated)
 *   GET    /api/admin/people-directories/presets               presets and their mappings
 *   POST   /api/admin/people-directories/test                  test a saved or an unsaved entry
 *
 * Every route is behind `adminAuth`, which refuses delegated and machine
 * principals (personal API keys, OAuth clients, agents) before a body is read
 * or a connection opened. Testing an inline entry grants no extra reach: an
 * admin can already save the same entry.
 */

const FILE = 'config/peopleDirectories.json';
const PEOPLE_SEARCH_APP_ID = 'people-directory';
const MAX_TEST_QUERY_LENGTH = 200;
/** Stands in for the id of an unsaved directory under test. */
const INLINE_TEST_ID = 'unsaved';

/**
 * The sign-in providers a directory can reuse, without their secrets.
 * @param {Object} platform
 * @returns {Object[]}
 */
function ldapProviderSummaries(platform) {
  return (platform.ldapAuth?.providers || [])
    .filter(provider => provider?.name)
    .map(provider => {
      let host = null;
      try {
        host = new URL(String(provider.url || '').trim()).hostname || null;
      } catch {
        host = null;
      }
      return {
        name: provider.name,
        displayName: provider.displayName || provider.name,
        url: provider.url || null,
        host,
        baseDn: provider.baseDn || null,
        userSearchBase: provider.userSearchBase || null,
        preset: provider.preset || null,
        starttls: provider.starttls === true,
        hasBindAccount: Boolean(provider.adminDn)
      };
    });
}

/**
 * Whether the shipped "People search" app exists and is enabled, so the page
 * can offer to switch it on with the first directory.
 */
function peopleSearchAppStatus() {
  const { data: apps = [] } = configCache.getApps(true) || {};
  const app = apps.find(entry => entry?.id === PEOPLE_SEARCH_APP_ID);
  return {
    id: PEOPLE_SEARCH_APP_ID,
    exists: Boolean(app),
    enabled: Boolean(app && app.enabled !== false)
  };
}

/**
 * Persist the whole (validated) file, then drop cached unit lists.
 * @param {Object} file
 * @returns {Promise<Object>} The persisted file
 */
async function writeDirectories(file) {
  await configStore.writeJson(FILE, file);
  // Tools are rebuilt from the cache on every listing, so refreshing it is all
  // a change needs; other workers follow the storage change event.
  await configCache.refreshCacheEntry?.(FILE);
  clearUnitsCache();
  return file;
}

/**
 * The first directory id that clashes with a tool, MCP server or A2A agent.
 * @param {Object[]} directories
 * @returns {{directoryId: string, kind: string, id: string}|null}
 */
function findIdConflict(directories) {
  const others = {
    tools: configCache.getTools?.(true)?.data || [],
    mcpServers: installedIntegrationRefs(),
    a2aAgents: []
  };
  for (const directory of directories) {
    const conflict = findDirectoryIdConflict(directory.id, others);
    if (conflict) return { directoryId: directory.id, ...conflict };
  }
  return null;
}

export default function registerAdminPeopleDirectoriesRoutes(app) {
  /**
   * @swagger
   * /api/admin/people-directories:
   *   get:
   *     summary: List people directories
   *     description: The configured people directories, a summary of each (source, preset, transport, problems), the LDAP sign-in providers a directory can reuse, and whether the shipped People search app is enabled.
   *     tags: [Admin]
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: The directories
   */
  app.get(buildServerPath('/api/admin/people-directories'), adminAuth, (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const directories = getConfiguredDirectories();
      const effective = {};
      for (const directory of directories) {
        if (directory?.id) effective[directory.id] = summarizeDirectory(directory, platform);
      }
      res.json({
        directories,
        effective,
        ldapProviders: ldapProviderSummaries(platform),
        peopleSearchApp: peopleSearchAppStatus()
      });
    } catch (error) {
      return sendFailedOperationError(res, 'list people directories', error);
    }
  });

  /**
   * @swagger
   * /api/admin/people-directories:
   *   put:
   *     summary: Replace the people directories
   *     description: Validates the whole file against the schema and refuses directory ids that a tool, MCP server or A2A agent already uses.
   *     tags: [Admin]
   *     security:
   *       - adminAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [directories]
   *             properties:
   *               directories:
   *                 type: array
   *                 items:
   *                   type: object
   *     responses:
   *       200:
   *         description: Saved
   *       400:
   *         description: Invalid configuration
   *       409:
   *         description: A directory id is already used by another tool reference
   */
  app.put(buildServerPath('/api/admin/people-directories'), adminAuth, async (req, res) => {
    try {
      // The schema defaults a missing list to []; a body without one (or with
      // a misspelled key) must not delete every directory.
      if (!Array.isArray(req.body?.directories)) {
        return sendBadRequest(res, '"directories" must be the list of directories');
      }
      const parsed = peopleDirectoriesFileSchema.safeParse({
        directories: req.body?.directories
      });
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid people directory configuration',
          details: parsed.error.issues
        });
      }
      const conflict = findIdConflict(parsed.data.directories);
      if (conflict) {
        const what =
          {
            mcpServer: 'installed integration',
            a2aAgent: 'A2A agent',
            reserved: 'reserved reference'
          }[conflict.kind] || 'tool';
        return res.status(409).json({
          success: false,
          error: `Directory id "${conflict.directoryId}" is already used by the ${what} "${conflict.id}". Apps and groups select directories, tools and MCP servers by id, so the directory needs an id of its own.`,
          conflict
        });
      }
      const saved = await writeDirectories(parsed.data);
      logger.info('People directories saved', {
        component: 'AdminPeopleDirectories',
        userId: req.user?.id,
        directories: saved.directories.map(directory => ({
          id: directory.id,
          enabled: directory.enabled
        }))
      });
      res.json({ success: true, directories: saved.directories });
    } catch (error) {
      return sendFailedOperationError(res, 'save people directories', error);
    }
  });

  /**
   * @swagger
   * /api/admin/people-directories/presets:
   *   get:
   *     summary: People directory presets
   *     description: Each preset's person filter, search attributes and attribute mapping, so the editor can show the effective value of every field left empty.
   *     tags: [Admin]
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: The presets
   */
  app.get(buildServerPath('/api/admin/people-directories/presets'), adminAuth, (req, res) => {
    res.json({
      presets: Object.values(SEARCH_PRESETS).map(preset => ({
        id: preset.id,
        label: preset.label,
        personFilter: preset.personFilter,
        searchAttributes: preset.searchAttributes,
        attributeMapping: Object.fromEntries(
          MAPPED_PERSON_FIELDS.map(field => [field, preset.attributeMapping[field] || []])
        )
      })),
      fields: MAPPED_PERSON_FIELDS,
      defaults: { ...PEOPLE_DIRECTORY_DEFAULTS },
      limits: { ...PEOPLE_DIRECTORY_LIMITS }
    });
  });

  /**
   * @swagger
   * /api/admin/people-directories/test:
   *   post:
   *     summary: Test a people directory
   *     description: |
   *       Resolves a saved directory (`id`) or an unsaved one (`directory`), checks
   *       the address, connects, negotiates TLS, binds and, with `query`, runs a
   *       sample search, reporting every step. Nothing is saved.
   *     tags: [Admin]
   *     security:
   *       - adminAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               id:
   *                 type: string
   *               directory:
   *                 type: object
   *               query:
   *                 type: string
   *     responses:
   *       200:
   *         description: The test ran; `success` reports the outcome
   *       400:
   *         description: Neither a saved id nor an inline entry
   */
  app.post(buildServerPath('/api/admin/people-directories/test'), adminAuth, async (req, res) => {
    const body = req.body || {};
    let directory;
    if (body.directory && typeof body.directory === 'object' && !Array.isArray(body.directory)) {
      // A new, unsaved form may not have an id yet; the test does not need one.
      directory = { ...body.directory, id: body.directory.id || INLINE_TEST_ID };
    } else if (typeof body.id === 'string' && body.id) {
      directory = findDirectory(body.id);
      if (!directory) return sendNotFound(res, 'People directory');
    } else {
      return sendBadRequest(res, 'Either "directory" (an unsaved entry) or "id" is required');
    }
    if (body.query !== undefined && typeof body.query !== 'string') {
      return sendBadRequest(res, '"query" must be text');
    }
    if (typeof body.query === 'string' && body.query.length > MAX_TEST_QUERY_LENGTH) {
      return sendBadRequest(res, '"query" is too long');
    }
    try {
      const result = await testDirectory(directory, {
        query: body.query,
        unsaved: directory.id === INLINE_TEST_ID
      });
      logger.info('People directory tested', {
        component: 'AdminPeopleDirectories',
        userId: req.user?.id,
        directoryId: directory.id || null,
        success: result.success
      });
      res.json(result);
    } catch (error) {
      return sendFailedOperationError(res, 'test people directory', error);
    }
  });
}
