// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';
import { logAudit } from '../../services/AuditLogService.js';
import { artifactSettings } from '../../services/artifacts/artifactPolicy.js';
import { artifactLibraryList } from '../../services/artifacts/artifactLibraryKit.js';
import { bareScriptHost, normalizeScriptHosts } from '../../../shared/artifactPreview.js';

/**
 * Admin → Artifacts: `platform.artifacts`, the store of what runs produce and
 * the HTML artifact preview (CDN hosts, library kit, #3822).
 *
 *   GET /api/admin/artifacts/config   the settings in force, and the kit's contents
 *   PUT /api/admin/artifacts/config   replace the settings (every field optional)
 *
 * The settings are read fresh on every artifact write and every preview, so a
 * change takes effect without a restart.
 */

const LIMIT = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);

const FIELDS = {
  enabled: z.boolean(),
  maxBytes: LIMIT,
  maxPerBatch: LIMIT,
  maxZipFiles: LIMIT,
  maxZipBytes: LIMIT,
  scriptHosts: z.array(z.string().max(300)).max(50),
  libraryKit: z.object({ enabled: z.boolean() }).strict()
};

const artifactsBodySchema = z
  .object({
    ...FIELDS,
    // The values the form loaded for the fields it changes. A field whose
    // stored value no longer matches was changed by someone else meanwhile:
    // the save is refused instead of silently undoing that change. Fields
    // the request does not change are not compared.
    expected: z.object(FIELDS).partial().strict()
  })
  .partial()
  .strict();

/** Whether two settings values are the same (arrays and objects by content). */
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The settings as the admin page shows them, with the kit's contents. */
function configResponse(platform) {
  const settings = artifactSettings(platform);
  return { ...settings, libraries: artifactLibraryList() };
}

/** Answer the settings in force. */
function sendConfig(res, platform) {
  res.setHeader('Cache-Control', 'no-store');
  res.json(configResponse(platform));
}

export default function registerAdminArtifactRoutes(app) {
  /**
   * @swagger
   * /api/admin/artifacts/config:
   *   get:
   *     summary: Get the artifact settings
   *     description: |
   *       The settings of `platform.artifacts` in force (defaults filled in):
   *       the master switch, the size limits, the CDN hosts an HTML artifact's
   *       preview may load scripts from, and whether the library kit is on,
   *       plus the libraries the kit contains.
   *     tags: [Admin - Artifacts]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: The artifact settings
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 enabled: { type: boolean }
   *                 maxBytes: { type: integer }
   *                 maxPerBatch: { type: integer }
   *                 maxZipFiles: { type: integer }
   *                 maxZipBytes: { type: integer }
   *                 scriptHosts: { type: array, items: { type: string } }
   *                 libraryKit:
   *                   type: object
   *                   properties:
   *                     enabled: { type: boolean }
   *                 libraries:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                       version: { type: string }
   *                       license: { type: string }
   *                       bytes: { type: integer }
   *                       available: { type: boolean }
   */
  app.get(buildServerPath('/api/admin/artifacts/config'), adminAuth, async (req, res) => {
    sendConfig(res, configCache.getPlatform() || {});
  });

  /**
   * @swagger
   * /api/admin/artifacts/config:
   *   put:
   *     summary: Update the artifact settings
   *     description: |
   *       Sets the given fields of `platform.artifacts`; fields left out keep
   *       their value. Limits of zero or less remove the cap. `scriptHosts`
   *       takes bare host names (`cdn.example.com`); a wildcard, path, port or
   *       `http:` entry is refused. `[]` keeps the preview offline.
   *     tags: [Admin - Artifacts]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               enabled: { type: boolean }
   *               maxBytes: { type: integer }
   *               maxPerBatch: { type: integer }
   *               maxZipFiles: { type: integer }
   *               maxZipBytes: { type: integer }
   *               scriptHosts: { type: array, items: { type: string } }
   *               libraryKit:
   *                 type: object
   *                 properties:
   *                   enabled: { type: boolean }
   *               expected:
   *                 type: object
   *                 description: >-
   *                   The values the form loaded for the fields it changes (same keys). A
   *                   field whose stored value differs answers 412; others are not compared.
   *     responses:
   *       200:
   *         description: The settings now in force (same shape as the GET)
   *       400:
   *         description: Invalid settings (`VALIDATION_FAILED`, `BAD_REQUEST`)
   *       412:
   *         description: PRECONDITION_FAILED, a changed field no longer has the expected value (`details.fields`)
   */
  app.put(buildServerPath('/api/admin/artifacts/config'), adminAuth, async (req, res) => {
    const parsed = artifactsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ServiceError(
        'VALIDATION_FAILED',
        parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        { details: parsed.error.issues }
      );
    }
    const { expected = {}, ...changes } = parsed.data;
    if (changes.scriptHosts) {
      // Every entry must survive normalization: a silently dropped host would
      // leave the admin believing a CDN is allowed when it is not.
      const hosts = normalizeScriptHosts(changes.scriptHosts);
      const rejected = changes.scriptHosts.filter(entry => !hosts.includes(bareScriptHost(entry)));
      if (rejected.length) {
        const names = rejected.map(entry => JSON.stringify(entry)).join(', ');
        throw new ServiceError(
          'BAD_REQUEST',
          `Not a plain host name: ${names}. Use a host such as cdn.example.com, without wildcard, path, port or http:.`
        );
      }
      changes.scriptHosts = hosts;
    }

    await updatePlatform(platform => {
      // The form loaded the settings in force (the cache, with `${VAR}`
      // placeholders and IHUB_* overrides resolved); the update sees the file.
      // A field counts as changed by someone else only when it differs from
      // the loaded value in both, so an overridden field can still be saved.
      const stored = artifactSettings(platform);
      const inForce = artifactSettings(configCache.getPlatform() || {});
      const stale = Object.keys(changes).filter(
        key =>
          key in expected &&
          !sameValue(stored[key], expected[key]) &&
          !sameValue(inForce[key], expected[key])
      );
      if (stale.length) {
        throw new ServiceError(
          'PRECONDITION_FAILED',
          `Changed by someone else since they were loaded: ${stale.join(', ')}. Reload the settings and make your change again.`,
          { details: { fields: stale } }
        );
      }
      const current = platform.artifacts || {};
      platform.artifacts = {
        ...current,
        ...changes,
        ...(changes.libraryKit
          ? { libraryKit: { ...current.libraryKit, ...changes.libraryKit } }
          : {})
      };
    });
    await configCache.refreshCacheEntry('config/platform.json');

    logger.info('Artifact settings updated', {
      component: 'AdminArtifacts',
      fields: Object.keys(changes)
    });
    logAudit({
      req,
      action: 'update',
      resource: 'platform',
      resourceId: 'artifacts',
      summary: `Artifact settings changed: ${Object.keys(changes).join(', ') || 'nothing'}`,
      details: changes
    });

    sendConfig(res, configCache.getPlatform() || {});
  });
}
