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
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteFile } from '../../utils/atomicWrite.js';
import { isValidId, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import { createSseEmitter } from '../../utils/sseEmitter.js';

const emit = createSseEmitter('ArtifactStore');

// Conservative allowlist: alphanumerics, dash, underscore, and dot only.
// Rejects control chars (CR/LF/quote) that could escape Content-Disposition
// headers when the artifact is downloaded, plus any path traversal vector.
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Per-run quota. write_artifact is LLM-callable; without these caps a buggy
// or adversarial agent can fill the disk under contents/data/agent-artifacts.
const MAX_ARTIFACTS_PER_RUN = 50;
const MAX_TOTAL_BYTES_PER_RUN = 100 * 1024 * 1024; // 100 MB

function safeArtifactName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('artifact name is required');
  }
  if (!SAFE_ARTIFACT_NAME.test(name) || name.includes('..')) {
    throw new Error(
      'artifact name must be a simple filename (letters, digits, dot, dash, underscore; ≤128 chars; no control chars)'
    );
  }
  const base = path.basename(name);
  if (base !== name) {
    throw new Error('artifact name must be a simple filename');
  }
  return base;
}

function checkArtifactQuota(state, incomingBytes) {
  if (!state?.data) return null;
  const existing = Array.isArray(state.data._agent?.artifacts) ? state.data._agent.artifacts : [];
  if (existing.length >= MAX_ARTIFACTS_PER_RUN) {
    return `artifact quota exceeded: this run has already written ${existing.length} artifact(s) (limit ${MAX_ARTIFACTS_PER_RUN})`;
  }
  const usedBytes = existing.reduce((sum, a) => sum + (Number(a.bytes) || 0), 0);
  if (usedBytes + incomingBytes > MAX_TOTAL_BYTES_PER_RUN) {
    return `artifact byte quota exceeded: this run has written ${usedBytes} bytes and the new artifact would add ${incomingBytes} (limit ${MAX_TOTAL_BYTES_PER_RUN})`;
  }
  return null;
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
  const bytes = Buffer.byteLength(content);

  const quotaError = checkArtifactQuota(state, bytes);
  if (quotaError) {
    const err = new Error(quotaError);
    err.code = 'ARTIFACT_QUOTA_EXCEEDED';
    throw err;
  }

  const { dir, safeRunId } = await resolveRunDir(runId);
  const file = await resolveAndValidatePath(safeName, dir);
  if (!file) {
    throw new Error(`writeArtifactDirect: invalid artifact path: ${safeName}`);
  }
  await atomicWriteFile(file, content);

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
