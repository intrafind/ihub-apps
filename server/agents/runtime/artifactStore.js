/**
 * Artifact Store
 *
 * Persists agent run artifacts to `contents/data/agent-artifacts/<runId>/<name>`.
 *
 * Both the `write_artifact` LLM tool and the runtime (synthesizer output
 * persistence, per-task result persistence) call into here so the on-disk
 * format and SSE event emission are consistent regardless of who initiated
 * the write.
 */

import fs from 'fs/promises';
import path from 'path';
import { actionTracker } from '../../actionTracker.js';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteFile } from '../../utils/atomicWrite.js';
import { isValidId, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';

function safeArtifactName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('artifact name is required');
  }
  if (name.includes('/') || name.includes('..') || name.startsWith('.')) {
    throw new Error('artifact name must be a simple filename');
  }
  if (name.length > 128) {
    throw new Error('artifact name too long');
  }
  const base = path.basename(name);
  if (base !== name) {
    throw new Error('artifact name must be a simple filename');
  }
  return base;
}

function emit(event, payload, chatId) {
  try {
    actionTracker.emit('fire-sse', { event, chatId, ...payload });
  } catch (err) {
    logger.warn('Artifact store event emit failed', {
      component: 'ArtifactStore',
      event,
      error: err.message
    });
  }
}

/**
 * Resolve the artifacts directory for a given run id, creating it if needed.
 *
 * @param {string} rawRunId
 * @returns {Promise<{ dir: string, safeRunId: string }>}
 */
async function resolveRunDir(rawRunId) {
  if (!rawRunId || !isValidId(rawRunId)) {
    throw new Error('writeArtifact requires a valid runId/executionId');
  }
  const safeRunId = path.basename(String(rawRunId));
  if (safeRunId !== rawRunId) {
    throw new Error(`writeArtifact: invalid runId: ${rawRunId}`);
  }
  const artifactsRoot = path.join(getRootDir(), 'contents', 'data', 'agent-artifacts');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const dir = await resolveAndValidatePath(safeRunId, artifactsRoot);
  if (!dir) {
    throw new Error(`writeArtifact: invalid runId path: ${safeRunId}`);
  }
  await fs.mkdir(dir, { recursive: true });
  return { dir, safeRunId };
}

/**
 * Write an artifact file for the given run.
 *
 * Records the artifact in `state.data._agent.artifacts` and emits an
 * `agent.artifact.written` SSE event.
 *
 * @param {object} args
 * @param {string} args.runId       - The workflow execution id (file dir).
 * @param {string} args.name        - Simple filename (no slashes); validated.
 * @param {string} args.content     - File contents (string).
 * @param {string} [args.contentType='text/markdown']
 * @param {string} [args.profileId] - Profile id for the SSE payload.
 * @param {string} [args.chatId]    - SSE channel id (typically == runId).
 * @param {object} [args.state]     - Workflow state object; if provided,
 *                                    appends to state.data._agent.artifacts.
 * @returns {Promise<{ ok: true, name: string, bytes: number, path: string }>}
 */
export async function writeArtifactDirect(args) {
  const {
    runId,
    name,
    content,
    contentType = 'text/markdown',
    profileId,
    chatId,
    state
  } = args || {};
  if (typeof content !== 'string') {
    throw new Error('writeArtifactDirect: content must be a string');
  }
  const safeName = safeArtifactName(name);
  const { dir, safeRunId } = await resolveRunDir(runId);
  const file = await resolveAndValidatePath(safeName, dir);
  if (!file) {
    throw new Error(`writeArtifactDirect: invalid artifact path: ${safeName}`);
  }
  await atomicWriteFile(file, content);
  const bytes = Buffer.byteLength(content);

  if (state && state.data) {
    state.data._agent = state.data._agent || {};
    state.data._agent.artifacts = state.data._agent.artifacts || [];
    state.data._agent.artifacts.push({
      name: safeName,
      writtenAt: new Date().toISOString(),
      bytes,
      contentType
    });
  }

  emit(
    'agent.artifact.written',
    { profileId, runId: safeRunId, name: safeName, bytes, contentType },
    chatId || safeRunId
  );

  return { ok: true, name: safeName, bytes, path: file };
}

export { safeArtifactName };

export default { writeArtifactDirect, safeArtifactName };
