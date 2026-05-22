/**
 * Artifact routes:
 *   GET /api/agents/runs/:runId/artifacts            — list run artifacts
 *   GET /api/agents/runs/:runId/artifacts/:name      — fetch one artifact
 *   GET /api/agents/profiles/:profileId/artifacts    — list profile artifacts
 */

import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { authRequired, authenticatedOnly } from '../../middleware/authRequired.js';
import {
  sendBadRequest,
  sendNotFound,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import { getRootDir } from '../../pathUtils.js';
import { WorkflowEngine } from '../../services/workflow/index.js';

let _engine = null;
function getEngine() {
  if (!_engine) _engine = new WorkflowEngine();
  return _engine;
}

function artifactsRootDir() {
  return path.join(getRootDir(), 'contents', 'data', 'agent-artifacts');
}

// Returns a validated absolute directory path for the run, or null on any
// path-traversal attempt. validateIdForPath should have rejected bad ids
// upstream; this is defense-in-depth. path.basename is a CodeQL-recognized
// sanitizer for js/path-injection.
async function artifactsDirForRun(runId) {
  const safeId = path.basename(String(runId || ''));
  if (!safeId || safeId === '.' || safeId === '..') return null;
  return await resolveAndValidatePath(safeId, artifactsRootDir());
}

function safeName(name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('..') || name.startsWith('.')) return null;
  if (name.length > 128) return null;
  // path.basename strips any embedded separators (defense-in-depth + CodeQL).
  const base = path.basename(name);
  if (base !== name) return null;
  return base;
}

function isAdminUser(user) {
  if (!user) return false;
  if (user.permissions?.adminAccess === true) return true;
  const groups = Array.isArray(user.groups) ? user.groups : [];
  return groups.includes('admin') || groups.includes('admins');
}

/**
 * Per-run authorization check. The run was triggered by a specific human
 * (recorded in `state.data._agent.triggeredBy.userId`); only that user —
 * or an administrator — should be able to read its artifacts. Sends the
 * appropriate response (404 if run doesn't exist, 403 if not allowed) and
 * returns false; otherwise returns true.
 */
async function authorizeArtifactAccess(req, res, runId) {
  if (isAdminUser(req.user)) return true;
  try {
    const state = await getEngine().getState(runId);
    if (!state) {
      sendNotFound(res, `Run ${runId} not found`);
      return false;
    }
    const triggered = state.data?._agent?.triggeredBy?.userId;
    const requesting = req.user?.id;
    if (triggered && requesting && requesting !== 'anonymous' && triggered === requesting) {
      return true;
    }
    res.status(403).json({
      error: 'forbidden',
      message: 'You are not allowed to access this run’s artifacts.'
    });
    return false;
  } catch {
    res.status(403).json({ error: 'forbidden', message: 'Authorization check failed.' });
    return false;
  }
}

export default function registerAgentArtifactRoutes(app) {
  app.get(
    buildServerPath('/api/agents/runs/:runId/artifacts'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { runId } = req.params;
        if (!validateIdForPath(runId, 'run', res)) return;
        if (!(await authorizeArtifactAccess(req, res, runId))) return;
        const dir = await artifactsDirForRun(runId);
        if (!dir) return sendBadRequest(res, 'invalid run id');
        let entries = [];
        try {
          // lgtm[js/path-injection] -- runId validated by validateIdForPath; path canonicalized via resolveAndValidatePath.
          entries = await fsp.readdir(dir);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        const list = [];
        for (const entry of entries) {
          // entry comes from a directory listing of `dir` (already validated);
          // any traversal would require the OS to return `..` which fsp.readdir
          // does not. Still, validate the filename shape.
          const safeEntry = safeName(entry);
          if (!safeEntry) continue;
          const entryPath = await resolveAndValidatePath(safeEntry, dir);
          if (!entryPath) continue;
          // lgtm[js/path-injection] -- entry validated by safeName; path canonicalized.
          const stat = await fsp.stat(entryPath).catch(() => null);
          if (stat && stat.isFile()) {
            list.push({ name: safeEntry, bytes: stat.size, mtime: stat.mtime });
          }
        }
        res.json(list);
      } catch (error) {
        sendFailedOperationError(res, 'list artifacts', error);
      }
    }
  );

  app.get(
    buildServerPath('/api/agents/runs/:runId/artifacts/:name'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { runId, name } = req.params;
        if (!validateIdForPath(runId, 'run', res)) return;
        if (!(await authorizeArtifactAccess(req, res, runId))) return;
        const safe = safeName(name);
        if (!safe) return sendBadRequest(res, 'invalid artifact name');
        const dir = await artifactsDirForRun(runId);
        if (!dir) return sendBadRequest(res, 'invalid run id');
        const file = await resolveAndValidatePath(safe, dir);
        if (!file) return sendBadRequest(res, 'invalid artifact path');
        try {
          // lgtm[js/path-injection] -- runId+name validated; path canonicalized.
          const stat = await fsp.stat(file);
          if (!stat.isFile()) return sendNotFound(res, 'artifact');
        } catch {
          return sendNotFound(res, 'artifact');
        }
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        // Honor ?download=1 to set Content-Disposition: attachment so the
        // browser saves the file instead of rendering it inline. Safe to
        // include the validated `safe` filename in the header.
        if (req.query?.download === '1') {
          res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
        }
        // lgtm[js/path-injection] -- file path canonicalized within artifacts root.
        fs.createReadStream(file).pipe(res);
      } catch (error) {
        sendFailedOperationError(res, 'read artifact', error);
      }
    }
  );

  app.get(
    buildServerPath('/api/agents/profiles/:profileId/artifacts'),
    authRequired,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;
        // Walk every run directory and collect runs that belong to this profile.
        const root = artifactsRootDir();
        let runDirs = [];
        try {
          runDirs = await fsp.readdir(root);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        const out = [];
        for (const runId of runDirs) {
          // Match runs whose state envelope ties them to this profile.
          let state;
          try {
            state = await getEngine().getState(runId);
          } catch {
            state = null;
          }
          if (!state || state?.data?._agent?.profileId !== profileId) continue;
          // runId came from fsp.readdir of the artifacts root, so it's already
          // a sibling directory name; canonicalize anyway as belt+suspenders.
          const dir = await resolveAndValidatePath(runId, root);
          if (!dir) continue;
          let entries;
          try {
            // lgtm[js/path-injection] -- path canonicalized via resolveAndValidatePath.
            entries = await fsp.readdir(dir);
          } catch {
            entries = [];
          }
          for (const name of entries) {
            const safeEntry = safeName(name);
            if (!safeEntry) continue;
            const entryPath = await resolveAndValidatePath(safeEntry, dir);
            if (!entryPath) continue;
            // lgtm[js/path-injection] -- entry validated by safeName; path canonicalized.
            const stat = await fsp.stat(entryPath).catch(() => null);
            if (stat?.isFile()) {
              out.push({ runId, name: safeEntry, bytes: stat.size, mtime: stat.mtime });
            }
          }
        }
        res.json(out);
      } catch (error) {
        sendFailedOperationError(res, 'list profile artifacts', error);
      }
    }
  );
}
