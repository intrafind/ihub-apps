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
import { simpleCompletion, resolveModelId } from '../../utils.js';

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
  // Drop one trailing blank line after the section so repeated
  // replace-section cycles don't accumulate blank-line gaps. We look at the
  // line just before the next heading (or end of body): if it's empty, swallow
  // it. The regex normalisation below is a belt-and-braces backstop for any
  // remaining multi-blank runs.
  if (endIdx > startIdx && lines[endIdx - 1] === '') endIdx -= 1;
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

/**
 * Default prompt used to shape a raw tool result into a compact, agent-friendly
 * memory section. Surfaced through the admin "build memory from tool" UI so
 * operators can tweak it per build. The placeholder `{TOOL_RESULT}` is
 * replaced with the JSON-serialised tool output before the call.
 */
const DEFAULT_SHAPER_PROMPT = `You are formatting a tool's raw output for inclusion in an AI agent's long-term memory. The agent will read this verbatim to learn what data is available and how to filter for it.

Produce a concise markdown section that includes — when present in the raw output:
- A 2-3 sentence headline describing what's notable (size, dominant content, scope).
- Totals (document count, last refresh date, etc.).
- Top facets / categories with counts. Cap each facet at the top 8 values.
- Filterable fields the agent can use to narrow queries.
- At most 5 representative sample titles or IDs.

Drop verbose payloads: nested raw objects, base64 blobs, full URLs, repeated hits with no distinguishing info, and anything an agent doesn't need to filter or pick documents.

Output ONLY the markdown body — no top-level heading (the caller adds it).

Tool result:
{TOOL_RESULT}`;

function fillToolResultPlaceholder(promptTemplate, toolResult) {
  let serialised;
  if (typeof toolResult === 'string') {
    serialised = toolResult;
  } else {
    try {
      serialised = JSON.stringify(toolResult, null, 2);
    } catch {
      serialised = String(toolResult);
    }
  }
  if (typeof promptTemplate === 'string' && promptTemplate.includes('{TOOL_RESULT}')) {
    return promptTemplate.replace('{TOOL_RESULT}', serialised);
  }
  return `${promptTemplate}\n\nTool result:\n${serialised}`;
}

async function shapeToolResultWithLLM(toolResult, { promptTemplate, modelId }) {
  const userPrompt = fillToolResultPlaceholder(
    promptTemplate || DEFAULT_SHAPER_PROMPT,
    toolResult
  );
  const resolvedModel = resolveModelId(modelId || null, 'memoryShaper');
  if (!resolvedModel) {
    throw new Error('No model available to shape tool result for memory.');
  }
  const { content } = await simpleCompletion(
    [{ role: 'user', content: userPrompt }],
    { modelId: resolvedModel, temperature: 0.2, maxTokens: 4096 }
  );
  return (content || '').trim();
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

  // ── Default LLM shaper prompt used by the memory builder UI ───────────────
  app.get(
    buildServerPath('/api/admin/agents/memory/shaper-prompt'),
    adminAuth,
    async (_req, res) => {
      res.json({ prompt: DEFAULT_SHAPER_PROMPT });
    }
  );

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
  // Runs any registered tool with admin context and stores its (markdown)
  // output as a named section in the profile's memory file. Used for
  // operator-driven knowledge ingestion — e.g. running `iFinder_discover`
  // to build a corpus map that agent runs will see via the existing
  // memory auto-include.
  app.post(
    buildServerPath('/api/admin/agents/profiles/:profileId/memory/from-tool'),
    adminAuth,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;
        const {
          toolId,
          params = {},
          section,
          mode = 'replace-section',
          shape = false,
          shapePrompt,
          shapeModel
        } = req.body || {};
        if (typeof toolId !== 'string' || !toolId) {
          return sendBadRequest(res, 'toolId is required');
        }
        if (typeof section !== 'string' || !section.trim()) {
          return sendBadRequest(res, 'section is required');
        }
        if (mode !== 'replace-section' && mode !== 'append') {
          return sendBadRequest(res, 'mode must be replace-section or append');
        }

        // Run the tool with admin context. `runTool` already deduplicates the
        // skill / source / MCP / function-tool dispatch paths.
        const toolResult = await runTool(toolId, {
          ...params,
          user: req.user,
          chatId: req.headers['x-request-id'] || `admin-memory-build-${profileId}`
        });

        let newSectionContent;
        let shaped = false;
        if (shape) {
          newSectionContent = await shapeToolResultWithLLM(toolResult, {
            promptTemplate: typeof shapePrompt === 'string' ? shapePrompt : null,
            modelId: typeof shapeModel === 'string' ? shapeModel : null
          });
          shaped = true;
        } else {
          newSectionContent = toolResultToMarkdown(toolResult);
        }

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

        // Optimistic concurrency: anchor the write to the version we read so
        // a concurrent edit (admin in another tab, agent run, etc.) surfaces
        // as VERSION_CONFLICT below instead of silently overwriting.
        const writeResult = await memoryFile.writeMemory(profileId, {
          mode: 'replace',
          content: nextBody,
          summary: `memory build via ${toolId}${shaped ? ' (LLM-shaped)' : ''}`,
          expectedVersion: current.version,
          updatedBy: req.user?.id || 'admin'
        });

        logger.info('Built agent memory section from tool', {
          component: 'AdminAgents',
          profileId,
          toolId,
          section: section.trim(),
          mode,
          shaped,
          version: writeResult.version
        });

        res.json({
          ok: true,
          version: writeResult.version,
          section: section.trim(),
          toolId,
          shaped
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
