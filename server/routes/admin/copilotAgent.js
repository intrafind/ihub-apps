import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ZipArchive } from 'archiver';
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { getRootDir } from '../../pathUtils.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { resolveMcpPublicBase } from '../../services/mcp/mcpOAuthPublicUrl.js';
import { oauthClientsFile } from '../../utils/contentsPath.js';
import {
  createOAuthClient,
  findClientById,
  loadOAuthClients,
  rotateClientSecret,
  updateOAuthClient
} from '../../utils/oauthClientManager.js';
import { logAudit } from '../../services/AuditLogService.js';
import logger from '../../utils/logger.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendInternalError
} from '../../utils/responseHelpers.js';
import {
  COPILOT_OAUTH_SCOPES,
  DEFAULT_COPILOT_AGENT_CONFIG,
  DEFAULT_INSTRUCTIONS,
  LIMITS,
  PACKAGE_FILES,
  TEAMS_OAUTH_REDIRECT_URI,
  buildCopilotAgentManifests,
  copilotPackageVersion,
  describeCopilotOAuthRegistration,
  isGuid,
  validateCopilotAgentConfig
} from '../../utils/copilotAgentPackage.js';

/**
 * Admin routes for the Microsoft 365 Copilot agent (see
 * `utils/copilotAgentPackage.js` for what the package is):
 *
 *   GET  /api/admin/copilot-agent/status
 *   POST /api/admin/copilot-agent/enable         → the OAuth client secret, once
 *   POST /api/admin/copilot-agent/disable
 *   PUT  /api/admin/copilot-agent/config
 *   POST /api/admin/copilot-agent/rotate-secret  → a new secret, once
 *   GET  /api/admin/copilot-agent/package.zip
 *
 * Enabling sets up everything iHub needs: a confidential OAuth client for
 * Copilot's sign-in (redirect URI of Microsoft's OAuth service, the `mcp:*`
 * scopes), the OAuth authorization server, and the MCP gateway the agent
 * talks to. Disabling deactivates the client, so Copilot's tokens stop
 * working right away — the gateway stays as it is, other clients may use it.
 */

const COMPONENT = 'AdminCopilotAgent';
const PLATFORM_FILE = 'config/platform.json';

/**
 * Change platform.json as stored — not as cached. The cache holds the
 * resolved configuration (`${VAR}` placeholders filled in, environment
 * overrides applied, secrets decrypted); writing that back would store
 * secrets in plain text and freeze the overrides into the file.
 *
 * @param {(stored: Object) => void} mutate - Changes the stored config in place.
 * @returns {Promise<void>}
 */
async function updateStoredPlatform(mutate) {
  const stored = (await configStore.readJsonStrict(PLATFORM_FILE)) || {};
  mutate(stored);
  await configStore.writeJson(PLATFORM_FILE, stored);
  await configCache.refreshCacheEntry(PLATFORM_FILE);
}

function readSettings(platform) {
  return { ...DEFAULT_COPILOT_AGENT_CONFIG, ...(platform?.copilotAgent || {}) };
}

function trimTrailingSlashes(url) {
  let out = String(url || '');
  while (out.length > 0 && out.charCodeAt(out.length - 1) === 47) out = out.slice(0, -1);
  return out;
}

/**
 * The one public address everything in the package and the registration is
 * built from — the gateway, the OAuth endpoints, the developer links: the
 * gateway's configured Public URL when there is one (as its own discovery
 * documents use), else this request's. One base, so they never name two hosts.
 *
 * The request's address is Express's `req.protocol` and `req.host`, which
 * honour `X-Forwarded-Proto` / `X-Forwarded-Host` only from a proxy that
 * `trustProxy` trusts — a forged header cannot move the package elsewhere.
 */
function resolvePublicBase(req, platform) {
  const configured = platform?.mcpServer?.publicUrl;
  if (typeof configured === 'string' && /^https?:\/\//.test(configured.trim())) {
    return trimTrailingSlashes(configured.trim());
  }
  return trimTrailingSlashes(resolveMcpPublicBase(req) || '');
}

/**
 * The Copilot OAuth client, or null when there is none (never enabled, or
 * deleted by hand). Throws when the client store cannot be read: that is not
 * the same as a missing client — Enable would create a second one, and
 * Disable would report success while the client stayed active.
 */
function findCopilotClient(platform) {
  const clientId = platform?.copilotAgent?.oauthClientId;
  if (!clientId) return null;
  const clientsFile = oauthClientsFile(platform?.oauth || {});
  const clients = loadOAuthClients(clientsFile);
  if (clients?.metadata?.error) {
    throw new Error(`The OAuth client store could not be read: ${clients.metadata.error}`);
  }
  const client = findClientById(clients, clientId);
  return client ? { clientId, client, clientsFile } : null;
}

/**
 * The icons that go into the package — the iHub logo, and its silhouette in
 * white for Copilot's monochrome surfaces. Served from the client's public
 * folder: the source tree in development, the built output in production.
 */
async function readPackageIcons() {
  const rootDir = getRootDir();
  const isDevMode = process.env.NODE_ENV !== 'production' && process.pkg === undefined;
  const iconsDir = isDevMode
    ? path.join(rootDir, 'client', 'public', 'icons')
    : path.join(rootDir, 'public', 'icons');
  const [color, outline] = await Promise.all([
    fs.readFile(path.join(iconsDir, 'icon-192.png')),
    fs.readFile(path.join(iconsDir, 'icon-outline-32.png'))
  ]);
  return { color, outline };
}

async function buildPackageZip({ manifests, icons }) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks = [];
  archive.on('data', chunk => chunks.push(chunk));
  // Flat, at the root: Microsoft 365 rejects a package whose files sit in a folder.
  archive.append(JSON.stringify(manifests.manifest, null, 2), { name: PACKAGE_FILES.manifest });
  archive.append(JSON.stringify(manifests.declarativeAgent, null, 2), {
    name: PACKAGE_FILES.agent
  });
  archive.append(JSON.stringify(manifests.plugin, null, 2), { name: PACKAGE_FILES.plugin });
  archive.append(icons.color, { name: PACKAGE_FILES.color });
  archive.append(icons.outline, { name: PACKAGE_FILES.outline });
  await archive.finalize();
  return Buffer.concat(chunks);
}

export default function registerAdminCopilotAgentRoutes(app) {
  /**
   * @swagger
   * /api/admin/copilot-agent/status:
   *   get:
   *     summary: Get the Microsoft 365 Copilot agent status
   *     description: Settings, prerequisites (MCP gateway, OAuth server), and what to enter in the Teams Developer Portal's OAuth client registration.
   *     tags:
   *       - Admin - Copilot Agent
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Copilot agent status
   */
  app.get(buildServerPath('/api/admin/copilot-agent/status'), adminAuth, (req, res) => {
    let found;
    try {
      found = findCopilotClient(configCache.getPlatform() || {});
    } catch (error) {
      return sendInternalError(res, error, 'read the Copilot agent status');
    }
    const platform = configCache.getPlatform() || {};
    const settings = readSettings(platform);
    const baseUrl = resolvePublicBase(req, platform);
    const mcpUrl = `${baseUrl}/mcp`;
    const prerequisites = {
      mcpGateway: platform.mcpServer?.enabled === true,
      oauthServer: platform.oauth?.enabled?.authz === true,
      appsExposed: platform.mcpServer?.expose?.apps !== false,
      oauthClient: !!found && found.client.active !== false,
      // Copilot calls only HTTPS addresses. Behind a proxy that does not send
      // X-Forwarded-Proto the derived address is http://; the Public URL fixes it.
      publicHttps: baseUrl.startsWith('https://')
    };

    res.json({
      enabled: settings.enabled === true,
      appId: settings.appId,
      oauthClientId: settings.oauthClientId,
      oauthReferenceId: settings.oauthReferenceId,
      name: settings.name,
      description: settings.description,
      instructions: settings.instructions,
      defaultInstructions: DEFAULT_INSTRUCTIONS,
      conversationStarters: settings.conversationStarters,
      mcpUrl,
      registration: describeCopilotOAuthRegistration({
        baseUrl,
        mcpUrl,
        clientId: settings.oauthClientId
      }),
      prerequisites,
      packageReady:
        settings.enabled === true &&
        isGuid(settings.appId) &&
        !!settings.oauthReferenceId &&
        prerequisites.oauthClient &&
        prerequisites.publicHttps,
      limits: LIMITS
    });
  });

  /**
   * @swagger
   * /api/admin/copilot-agent/enable:
   *   post:
   *     summary: Enable the Microsoft 365 Copilot agent
   *     description: Creates (or reactivates) the confidential OAuth client Copilot signs users in with, and turns on the OAuth authorization server and the MCP gateway. The response carries the client secret when a client was created — it is shown only this once.
   *     tags:
   *       - Admin - Copilot Agent
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Copilot agent enabled
   */
  app.post(buildServerPath('/api/admin/copilot-agent/enable'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const settings = readSettings(platform);
      const clientsFile = oauthClientsFile(platform.oauth || {});

      let oauthClientId = settings.oauthClientId;
      let clientSecret = null;
      const found = findCopilotClient(platform);
      if (found) {
        if (found.client.active === false) {
          await updateOAuthClient(oauthClientId, { active: true }, clientsFile, req.user?.id);
        }
      } else {
        const created = await createOAuthClient(
          {
            name: 'Microsoft 365 Copilot',
            description:
              'Auto-generated client for the Microsoft 365 Copilot agent: Copilot signs users in to the MCP gateway with it.',
            clientType: 'confidential',
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: [TEAMS_OAUTH_REDIRECT_URI],
            scopes: [...COPILOT_OAUTH_SCOPES],
            trusted: true,
            consentRequired: false
          },
          clientsFile,
          req.user?.id || 'admin'
        );
        oauthClientId = created.clientId;
        clientSecret = created.clientSecret;
        logAudit({
          req,
          action: 'create',
          resource: 'oauthClient',
          resourceId: oauthClientId,
          summary: 'Created the OAuth client of the Microsoft 365 Copilot agent'
        });
      }

      const appId = isGuid(settings.appId) ? settings.appId : randomUUID();

      await updateStoredPlatform(stored => {
        stored.oauth = {
          ...(stored.oauth || {}),
          enabled: { ...(stored.oauth?.enabled || {}), authz: true, clients: true },
          authorizationCodeEnabled: true,
          refreshTokenEnabled: true
        };
        stored.mcpServer = { ...(stored.mcpServer || {}), enabled: true };
        stored.copilotAgent = {
          ...readSettings(stored),
          enabled: true,
          appId,
          oauthClientId,
          // A Teams registration names the client it was made for: a new
          // client needs a new registration.
          ...(clientSecret ? { oauthReferenceId: '' } : {})
        };
      });

      logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'copilotAgent',
        summary: 'Enabled the Microsoft 365 Copilot agent (and the MCP gateway it uses)'
      });
      logger.info('Copilot agent enabled', { component: COMPONENT, oauthClientId });

      res.json({
        message: 'Copilot agent enabled',
        oauthClientId,
        ...(clientSecret ? { clientSecret } : {})
      });
    } catch (error) {
      return sendInternalError(res, error, 'enable the Copilot agent');
    }
  });

  /**
   * @swagger
   * /api/admin/copilot-agent/disable:
   *   post:
   *     summary: Disable the Microsoft 365 Copilot agent
   *     description: Deactivates the agent's OAuth client, so Copilot's tokens stop working. The MCP gateway is left as it is.
   *     tags:
   *       - Admin - Copilot Agent
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Copilot agent disabled
   */
  app.post(buildServerPath('/api/admin/copilot-agent/disable'), adminAuth, async (req, res) => {
    try {
      const found = findCopilotClient(configCache.getPlatform() || {});
      if (found && found.client.active !== false) {
        await updateOAuthClient(found.clientId, { active: false }, found.clientsFile, req.user?.id);
      }
      await updateStoredPlatform(stored => {
        stored.copilotAgent = { ...readSettings(stored), enabled: false };
      });
      logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'copilotAgent',
        summary: 'Disabled the Microsoft 365 Copilot agent'
      });
      res.json({ message: 'Copilot agent disabled' });
    } catch (error) {
      return sendInternalError(res, error, 'disable the Copilot agent');
    }
  });

  /**
   * @swagger
   * /api/admin/copilot-agent/config:
   *   put:
   *     summary: Update the Microsoft 365 Copilot agent settings
   *     tags:
   *       - Admin - Copilot Agent
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               oauthReferenceId:
   *                 type: string
   *                 description: The OAuth client registration ID from the Teams Developer Portal.
   *               name:
   *                 type: string
   *                 maxLength: 30
   *               description:
   *                 type: string
   *                 maxLength: 1000
   *               instructions:
   *                 type: string
   *                 maxLength: 8000
   *                 description: What the agent is told. Empty uses iHub's default instructions.
   *               conversationStarters:
   *                 type: array
   *                 maxItems: 12
   *                 items:
   *                   type: object
   *                   properties:
   *                     title:
   *                       type: string
   *                     text:
   *                       type: string
   *     responses:
   *       200:
   *         description: Settings saved
   *       400:
   *         description: A field failed validation
   */
  app.put(buildServerPath('/api/admin/copilot-agent/config'), adminAuth, async (req, res) => {
    try {
      const result = validateCopilotAgentConfig(req.body);
      if (result.error) return sendBadRequest(res, result.error);
      await updateStoredPlatform(stored => {
        stored.copilotAgent = { ...readSettings(stored), ...result.value };
      });
      logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'copilotAgent',
        summary: `Updated the Microsoft 365 Copilot agent settings (${Object.keys(result.value).join(', ')})`
      });
      res.json({ message: 'Settings saved' });
    } catch (error) {
      return sendInternalError(res, error, 'save the Copilot agent settings');
    }
  });

  /**
   * @swagger
   * /api/admin/copilot-agent/rotate-secret:
   *   post:
   *     summary: Issue a new secret for the Copilot agent's OAuth client
   *     description: The old secret stops working at once; enter the new one in the Teams Developer Portal's OAuth client registration.
   *     tags:
   *       - Admin - Copilot Agent
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: The new secret, shown only this once
   *       404:
   *         description: The agent has no OAuth client
   */
  app.post(
    buildServerPath('/api/admin/copilot-agent/rotate-secret'),
    adminAuth,
    async (req, res) => {
      try {
        const found = findCopilotClient(configCache.getPlatform() || {});
        if (!found) {
          return sendErrorResponse(
            res,
            404,
            'The Copilot agent has no OAuth client. Enable it first.'
          );
        }
        const rotated = await rotateClientSecret(found.clientId, found.clientsFile, req.user?.id);
        logAudit({
          req,
          action: 'update',
          resource: 'oauthClient',
          resourceId: found.clientId,
          summary: 'Rotated the secret of the Microsoft 365 Copilot agent client'
        });
        res.json({ oauthClientId: found.clientId, clientSecret: rotated.clientSecret });
      } catch (error) {
        return sendInternalError(res, error, 'rotate the Copilot agent secret');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/copilot-agent/package.zip:
   *   get:
   *     summary: Download the Microsoft 365 Copilot agent package
   *     description: The app package to upload in the Microsoft 365 admin center (Copilot → Agents → Upload custom agent). Built on demand with a fresh version, as Microsoft 365 requires a higher version on every re-upload.
   *     tags:
   *       - Admin - Copilot Agent
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: The package
   *         content:
   *           application/zip: {}
   *       409:
   *         description: The agent is not enabled, the OAuth client registration ID is missing, or the public address is not HTTPS
   */
  app.get(buildServerPath('/api/admin/copilot-agent/package.zip'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const settings = readSettings(platform);
      if (!settings.enabled || !isGuid(settings.appId) || !findCopilotClient(platform)) {
        return sendErrorResponse(res, 409, 'Enable the Copilot agent first', {
          details: { code: 'COPILOT_AGENT_DISABLED' }
        });
      }
      if (!settings.oauthReferenceId) {
        return sendErrorResponse(
          res,
          409,
          'Enter the OAuth client registration ID from the Teams Developer Portal first',
          { details: { code: 'COPILOT_REFERENCE_ID_MISSING' } }
        );
      }

      // Copilot calls only HTTPS addresses; a package naming http:// would
      // install and then fail on every call.
      const baseUrl = resolvePublicBase(req, platform);
      if (!baseUrl.startsWith('https://')) {
        return sendErrorResponse(
          res,
          409,
          'Copilot needs an HTTPS address. Set the MCP gateway Public URL to the HTTPS address of iHub first.',
          { details: { code: 'COPILOT_PUBLIC_HTTPS_REQUIRED' } }
        );
      }

      const manifests = buildCopilotAgentManifests({
        config: settings,
        baseUrl,
        mcpUrl: `${baseUrl}/mcp`,
        version: copilotPackageVersion()
      });
      const zip = await buildPackageZip({ manifests, icons: await readPackageIcons() });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="ihub-copilot-agent.zip"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(zip);
      logger.info('Copilot agent package downloaded', {
        component: COMPONENT,
        version: manifests.manifest.version,
        userId: req.user?.id || 'admin'
      });
    } catch (error) {
      return sendInternalError(res, error, 'build the Copilot agent package');
    }
  });
}
