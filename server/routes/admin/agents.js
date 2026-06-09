import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON, atomicCreateJSON } from '../../utils/atomicWrite.js';
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
import { runTool } from '../../toolLoader.js';

const PROFILES_DIR = 'contents/agents/profiles';

const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/m;

/**
 * Splice a `## <heading>` section out of a memory body and return the body
 * with the section removed. The section extends from its heading to (but not
 * including) the next `## ` heading, or to end-of-body if it is the last
 * section.
 */
function removeMemorySection(body, heading) {
  if (!body || !heading) return body || '';
  const lines = body.split('\n');
  const target = `## ${heading.trim()}`;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === target) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return body;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (SECTION_HEADING_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  // Drop the section plus one trailing blank if present so the body doesn't
  // collect blank-line gaps on repeated replace cycles.
  if (lines[endIdx - 1] === '') endIdx -= 0;
  const next = [...lines.slice(0, startIdx), ...lines.slice(endIdx)].join('\n');
  return next.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

/**
 * Convert a tool-result into markdown suitable for storing in memory.
 * Convention: strings are used verbatim, objects with a `markdown` field use
 * that field, anything else is JSON-stringified inside a fenced block.
 */
function toolResultToMarkdown(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof result.markdown === 'string') {
    return result.markdown;
  }
  try {
    return '```json\n' + JSON.stringify(result, null, 2) + '\n```';
  } catch {
    return String(result);
  }
}

function profilesDirPath() {
  return join(getRootDir(), PROFILES_DIR);
}

async function profileFilePath(profileId) {
  // validateIdForPath should have run upstream; this is a defense-in-depth
  // canonicalization that prevents any path traversal even if a route forgets.
  // path.basename is a CodeQL-recognized sanitizer for js/path-injection.
  const safeFilename = basename(`${profileId}.json`);
  const safe = await resolveAndValidatePath(safeFilename, profilesDirPath());
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
        // lgtm[js/path-injection] -- profile.id validated; path canonicalized.
        await atomicCreateJSON(target, profile);
      } catch (err) {
        if (err.code === 'EEXIST') {
          return res
            .status(409)
            .json({ error: 'CONFLICT', message: `Profile ${profile.id} already exists` });
        }
        throw err;
      }
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

  // ─── Build memory section from a tool ─────────────────────────────────
  // Runs any platform-allow-listed tool and stores its (markdown) output as
  // a named section in the profile's memory file. Used for operator-driven
  // knowledge ingestion — e.g. running `iFinder_discover` to build a
  // corpus map that agent runs will see via the existing memory
  // auto-include.
  app.post(
    buildServerPath('/api/admin/agents/profiles/:profileId/memory/from-tool'),
    adminAuth,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;
        const { toolId, params = {}, section, mode = 'replace-section' } = req.body || {};
        if (typeof toolId !== 'string' || !toolId) {
          return sendBadRequest(res, 'toolId is required');
        }
        if (typeof section !== 'string' || !section.trim()) {
          return sendBadRequest(res, 'section is required');
        }
        if (mode !== 'replace-section' && mode !== 'append') {
          return sendBadRequest(res, 'mode must be replace-section or append');
        }

        const platform = configCache.getPlatform() || {};
        const allowed = platform?.agents?.adminMemoryBuilderTools;
        if (!Array.isArray(allowed) || !allowed.includes(toolId)) {
          return res.status(403).json({
            error: 'TOOL_NOT_ALLOWED',
            message: `Tool ${toolId} is not in platform.agents.adminMemoryBuilderTools`
          });
        }

        // Run the tool with admin context. `runTool` already deduplicates the
        // skill / source / MCP / function-tool dispatch paths.
        const toolResult = await runTool(toolId, {
          ...params,
          user: req.user,
          chatId: req.headers['x-request-id'] || `admin-memory-build-${profileId}`
        });

        const newSectionContent = toolResultToMarkdown(toolResult);

        const current = await memoryFile.readMemory(profileId);
        let nextBody = current.body || '';
        if (mode === 'replace-section') {
          nextBody = removeMemorySection(nextBody, section.trim());
        }
        const heading = `## ${section.trim()}`;
        const append = `${heading}\n\n${newSectionContent}\n`;
        nextBody =
          nextBody.endsWith('\n') || nextBody.length === 0
            ? `${nextBody}${nextBody.length === 0 ? '' : '\n'}${append}`
            : `${nextBody}\n\n${append}`;

        const writeResult = await memoryFile.writeMemory(profileId, {
          mode: 'replace',
          content: nextBody,
          summary: `memory build via ${toolId}`,
          updatedBy: req.user?.id || 'admin'
        });

        logger.info('Built agent memory section from tool', {
          component: 'AdminAgents',
          profileId,
          toolId,
          section: section.trim(),
          mode,
          version: writeResult.version
        });

        res.json({
          ok: true,
          version: writeResult.version,
          section: section.trim(),
          toolId
        });
      } catch (error) {
        if (error.code === 'VERSION_CONFLICT') {
          return res.status(409).json({
            error: 'VERSION_CONFLICT',
            message: error.message,
            currentVersion: error.currentVersion
          });
        }
        logger.error('Failed to build memory from tool', {
          component: 'AdminAgents',
          error
        });
        sendFailedOperationError(res, 'build memory from tool', error);
      }
    }
  );
}
