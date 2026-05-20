import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import { agentProfileSchema } from '../../validators/agentProfileSchema.js';
import { serializeProfile } from '../../agents/profile/profileWorkflowSerializer.js';
import memoryFile from '../../agents/memory/memoryFile.js';

const PROFILES_DIR = 'contents/agents/profiles';

function profilesDirPath() {
  return join(getRootDir(), PROFILES_DIR);
}

async function profileFilePath(profileId) {
  // validateIdForPath should have run upstream; this is a defense-in-depth
  // canonicalization that prevents any path traversal even if a route forgets.
  const safe = await resolveAndValidatePath(`${profileId}.json`, profilesDirPath());
  if (!safe) {
    throw new Error(`Invalid profile path for: ${profileId}`);
  }
  return safe;
}

async function ensureProfilesDir() {
  await fs.mkdir(profilesDirPath(), { recursive: true });
}

export default function registerAdminAgentsRoutes(app) {
  // ── Profiles list ─────────────────────────────────────────────────────────
  app.get(buildServerPath('/api/admin/agents/profiles'), adminAuth, async (req, res) => {
    try {
      const { data: profiles = [], etag } = configCache.getAgentProfiles(true);
      if (etag) res.setHeader('ETag', etag);
      res.json(profiles);
    } catch (error) {
      sendFailedOperationError(res, 'list agent profiles', error);
    }
  });

  // ── Single profile ────────────────────────────────────────────────────────
  app.get(buildServerPath('/api/admin/agents/profiles/:profileId'), adminAuth, async (req, res) => {
    try {
      const { profileId } = req.params;
      if (!validateIdForPath(profileId, 'profile', res)) return;
      const { data: profiles = [] } = configCache.getAgentProfiles(true);
      const profile = profiles.find(p => p.id === profileId);
      if (!profile) return sendNotFound(res, `Profile ${profileId} not found`);
      res.json(profile);
    } catch (error) {
      sendFailedOperationError(res, 'load agent profile', error);
    }
  });

  // ── Create ────────────────────────────────────────────────────────────────
  app.post(buildServerPath('/api/admin/agents/profiles'), adminAuth, async (req, res) => {
    try {
      const payload = req.body;
      if (!payload?.id) return sendBadRequest(res, 'Profile id is required');
      if (!validateIdForPath(payload.id, 'profile', res)) return;

      const parseResult = agentProfileSchema.safeParse(payload);
      if (!parseResult.success) {
        return sendBadRequest(res, 'Profile validation failed', parseResult.error.format());
      }
      const profile = serializeProfile(parseResult.data);

      await ensureProfilesDir();
      const target = await profileFilePath(profile.id);
      try {
        // lgtm[js/path-injection] -- profile.id validated by AGENT_PROFILE_ID_PATTERN; path canonicalized.
        await fs.access(target);
        return sendBadRequest(res, `Profile ${profile.id} already exists`);
      } catch {
        // not found — good
      }

      // lgtm[js/path-injection] -- profile.id validated; path canonicalized by resolveAndValidatePath.
      await atomicWriteJSON(target, profile);
      await configCache.refreshAgentProfilesCache();
      logger.info('Created agent profile', {
        component: 'AdminAgents',
        profileId: profile.id,
        actor: req.user?.id
      });
      res.status(201).json({ ok: true, profile });
    } catch (error) {
      sendFailedOperationError(res, 'create agent profile', error);
    }
  });

  // ── Update ────────────────────────────────────────────────────────────────
  app.put(buildServerPath('/api/admin/agents/profiles/:profileId'), adminAuth, async (req, res) => {
    try {
      const { profileId } = req.params;
      if (!validateIdForPath(profileId, 'profile', res)) return;
      const payload = req.body;
      if (!payload?.id) return sendBadRequest(res, 'Profile id is required');
      if (payload.id !== profileId) {
        return sendBadRequest(res, 'Profile id in URL must match payload id');
      }

      const parseResult = agentProfileSchema.safeParse(payload);
      if (!parseResult.success) {
        return sendBadRequest(res, 'Profile validation failed', parseResult.error.format());
      }
      const profile = serializeProfile(parseResult.data);

      await ensureProfilesDir();
      const updatePath = await profileFilePath(profileId);
      // lgtm[js/path-injection] -- profileId validated by validateIdForPath; path canonicalized.
      await atomicWriteJSON(updatePath, profile);
      await configCache.refreshAgentProfilesCache();
      logger.info('Updated agent profile', {
        component: 'AdminAgents',
        profileId,
        actor: req.user?.id
      });
      res.json({ ok: true, profile });
    } catch (error) {
      sendFailedOperationError(res, 'update agent profile', error);
    }
  });

  // ── Toggle enabled ────────────────────────────────────────────────────────
  app.post(
    buildServerPath('/api/admin/agents/profiles/:profileId/toggle'),
    adminAuth,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;
        const { data: profiles = [] } = configCache.getAgentProfiles(true);
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return sendNotFound(res, `Profile ${profileId} not found`);

        const updated = { ...profile, enabled: !profile.enabled };
        const togglePath = await profileFilePath(profileId);
        // lgtm[js/path-injection] -- profileId validated by validateIdForPath; path canonicalized.
        await atomicWriteJSON(togglePath, updated);
        await configCache.refreshAgentProfilesCache();
        res.json({ ok: true, enabled: updated.enabled });
      } catch (error) {
        sendFailedOperationError(res, 'toggle agent profile', error);
      }
    }
  );

  // ── Delete ────────────────────────────────────────────────────────────────
  app.delete(
    buildServerPath('/api/admin/agents/profiles/:profileId'),
    adminAuth,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;
        try {
          const deletePath = await profileFilePath(profileId);
          // lgtm[js/path-injection] -- profileId validated by validateIdForPath; path canonicalized by resolveAndValidatePath.
          await fs.unlink(deletePath);
        } catch (err) {
          if (err.code === 'ENOENT') {
            return sendNotFound(res, `Profile ${profileId} not found`);
          }
          throw err;
        }
        await configCache.refreshAgentProfilesCache();
        logger.info('Deleted agent profile', {
          component: 'AdminAgents',
          profileId,
          actor: req.user?.id
        });
        res.json({ ok: true });
      } catch (error) {
        sendFailedOperationError(res, 'delete agent profile', error);
      }
    }
  );

  // ── Memory ────────────────────────────────────────────────────────────────
  app.get(
    buildServerPath('/api/admin/agents/profiles/:profileId/memory'),
    adminAuth,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;
        const mem = await memoryFile.readMemory(profileId);
        res.json(mem);
      } catch (error) {
        sendFailedOperationError(res, 'read agent memory', error);
      }
    }
  );

  app.put(
    buildServerPath('/api/admin/agents/profiles/:profileId/memory'),
    adminAuth,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;
        const { content, expectedVersion, summary } = req.body || {};
        if (typeof content !== 'string') {
          return sendBadRequest(res, 'content is required');
        }
        const result = await memoryFile.writeMemory(profileId, {
          mode: 'replace',
          content,
          summary,
          expectedVersion,
          updatedBy: req.user?.id || 'admin'
        });
        res.json({ ok: true, version: result.version });
      } catch (error) {
        if (error.code === 'VERSION_CONFLICT') {
          return res.status(409).json({
            error: 'VERSION_CONFLICT',
            message: error.message,
            currentVersion: error.currentVersion
          });
        }
        sendFailedOperationError(res, 'write agent memory', error);
      }
    }
  );
}
