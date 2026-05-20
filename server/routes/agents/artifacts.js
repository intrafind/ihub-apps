/**
 * Artifact routes:
 *   GET /api/agents/runs/:runId/artifacts            — list run artifacts
 *   GET /api/agents/runs/:runId/artifacts/:name      — fetch one artifact
 *   GET /api/agents/profiles/:profileId/artifacts    — list profile artifacts
 */

import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { authRequired } from '../../middleware/authRequired.js';
import {
  sendBadRequest,
  sendNotFound,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { getRootDir } from '../../pathUtils.js';
import { WorkflowEngine } from '../../services/workflow/index.js';

let _engine = null;
function getEngine() {
  if (!_engine) _engine = new WorkflowEngine();
  return _engine;
}

function artifactsDirForRun(runId) {
  return path.join(getRootDir(), 'contents', 'data', 'agent-artifacts', runId);
}

function safeName(name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('..') || name.startsWith('.')) return null;
  if (name.length > 128) return null;
  return name;
}

export default function registerAgentArtifactRoutes(app) {
  app.get(buildServerPath('/api/agents/runs/:runId/artifacts'), authRequired, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!validateIdForPath(runId, 'run', res)) return;
      const dir = artifactsDirForRun(runId);
      let entries = [];
      try {
        entries = await fsp.readdir(dir);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const list = [];
      for (const entry of entries) {
        const stat = await fsp.stat(path.join(dir, entry)).catch(() => null);
        if (stat && stat.isFile()) {
          list.push({ name: entry, bytes: stat.size, mtime: stat.mtime });
        }
      }
      res.json(list);
    } catch (error) {
      sendFailedOperationError(res, 'list artifacts', error);
    }
  });

  app.get(
    buildServerPath('/api/agents/runs/:runId/artifacts/:name'),
    authRequired,
    async (req, res) => {
      try {
        const { runId, name } = req.params;
        if (!validateIdForPath(runId, 'run', res)) return;
        const safe = safeName(name);
        if (!safe) return sendBadRequest(res, 'invalid artifact name');
        const file = path.join(artifactsDirForRun(runId), safe);
        try {
          const stat = await fsp.stat(file);
          if (!stat.isFile()) return sendNotFound(res, 'artifact');
        } catch {
          return sendNotFound(res, 'artifact');
        }
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        fs.createReadStream(file).pipe(res);
      } catch (error) {
        sendFailedOperationError(res, 'read artifact', error);
      }
    }
  );

  app.get(
    buildServerPath('/api/agents/profiles/:profileId/artifacts'),
    authRequired,
    async (req, res) => {
      try {
        const { profileId } = req.params;
        if (!validateIdForPath(profileId, 'profile', res)) return;
        // Walk every run directory and collect runs that belong to this profile.
        const root = path.join(getRootDir(), 'contents', 'data', 'agent-artifacts');
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
          const dir = path.join(root, runId);
          let entries;
          try {
            entries = await fsp.readdir(dir);
          } catch {
            entries = [];
          }
          for (const name of entries) {
            const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
            if (stat?.isFile()) {
              out.push({ runId, name, bytes: stat.size, mtime: stat.mtime });
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
