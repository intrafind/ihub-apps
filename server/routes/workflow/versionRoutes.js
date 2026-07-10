/**
 * Workflow Version Control Routes
 *
 * Endpoints for listing published version snapshots of a workflow,
 * publishing a new snapshot, and activating (restoring) a prior version.
 *
 * @module routes/workflow/versionRoutes
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { authRequired } from '../../middleware/authRequired.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { getRootDir } from '../../pathUtils.js';
import {
  isValidWorkflowVersion,
  validateIdForPath,
  resolveAndValidatePath,
  resolveAndValidateRealPath
} from '../../utils/pathSecurity.js';
import { sendNotFound } from '../../utils/responseHelpers.js';
import logger from '../../utils/logger.js';
import { checkWorkflowsFeature, findWorkflowFile } from './workflowRouteHelpers.js';

/**
 * Registers workflow version history/publish/activate endpoints.
 *
 * @param {Express} app - Express application instance
 */
export default function registerVersionRoutes(app) {
  /**
   * @swagger
   * /api/workflows/{id}/versions:
   *   get:
   *     summary: List version history for a workflow
   *     description: |
   *       Returns all published version snapshots for a workflow,
   *       sorted by publish date descending (most recent first).
   *     tags:
   *       - Workflows
   *       - Versions
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Version list returned successfully
   *       400:
   *         description: Invalid workflow ID
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/workflows/:id/versions'),
    authRequired,
    checkWorkflowsFeature,
    async (req, res) => {
      const { id } = req.params;
      if (!validateIdForPath(id, 'workflow', res)) {
        return;
      }

      try {
        const rootDir = getRootDir();
        const workflowsDir = join(rootDir, 'contents', 'workflows');
        const historyRoot = join(workflowsDir, '.history');
        // Defense-in-depth: resolve the per-workflow history dir and
        // assert it stays inside .history. validateIdForPath already
        // rejects path-traversal characters; this catches symlink/
        // alternate-encoding bypasses that CodeQL flags.
        const historyDir = await resolveAndValidatePath(id, historyRoot);
        if (!historyDir) {
          return res.status(400).json({ error: 'Invalid workflow ID' });
        }

        let versions = [];
        try {
          // `historyDir` is the result of resolveAndValidatePath(id, historyRoot)
          // above (path.resolve + startsWith boundary check); `id` was already
          // vetted by validateIdForPath() which rejects `..`, `/`, `\` and
          // anything outside [A-Za-z0-9._-].
          const files = await fs.readdir(historyDir); // lgtm[js/path-injection]
          for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
              const filePath = await resolveAndValidatePath(file, historyDir);
              if (!filePath) continue;
              // `filePath` is the result of resolveAndValidatePath(file, historyDir)
              // which enforces a path.resolve + startsWith boundary against historyDir.
              const content = await fs.readFile(filePath, 'utf8'); // lgtm[js/path-injection]
              const data = JSON.parse(content);
              versions.push({
                version: data.version,
                publishedAt: data._publishedAt,
                publishedBy: data._publishedBy,
                fileName: file
              });
            } catch {
              // Skip malformed version files
            }
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          // No history directory yet - return empty
        }

        // Sort by publish date descending
        versions.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

        res.json({ versions });
      } catch (error) {
        logger.error({
          component: 'workflowRoutes',
          message: `Failed to list versions: ${error.message}`
        });
        res.status(500).json({ error: 'Failed to list versions' });
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/{id}/publish:
   *   post:
   *     summary: Publish a workflow version (admin only)
   *     description: |
   *       Creates a published snapshot of the current workflow state.
   *       The snapshot is saved to the version history directory and the
   *       workflow status is set to 'published'.
   *     tags:
   *       - Workflows
   *       - Versions
   *       - Admin
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Workflow published successfully
   *       400:
   *         description: Invalid workflow ID
   *       404:
   *         description: Workflow not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/workflows/:id/publish'),
    adminAuth,
    checkWorkflowsFeature,
    async (req, res) => {
      const { id } = req.params;
      if (!validateIdForPath(id, 'workflow', res)) {
        return;
      }

      try {
        const rootDir = getRootDir();
        const workflowsDir = join(rootDir, 'contents', 'workflows');

        // Load current workflow
        const filename = await findWorkflowFile(id, workflowsDir);
        if (!filename) {
          return sendNotFound(res, 'Workflow');
        }

        const workflowPath = join(workflowsDir, filename);
        const content = await fs.readFile(workflowPath, 'utf8');
        const workflow = JSON.parse(content);

        // Create snapshot
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const version = workflow.version || '1.0.0';
        const snapshot = {
          ...workflow,
          status: 'published',
          _publishedAt: new Date().toISOString(),
          _publishedBy: req.user?.name || req.user?.id || 'unknown'
        };

        // Save to history (defense-in-depth path resolution)
        const historyRoot = join(workflowsDir, '.history');
        const historyDir = await resolveAndValidatePath(id, historyRoot);
        if (!historyDir) {
          return res.status(400).json({ error: 'Invalid workflow ID' });
        }
        // `historyDir` is resolveAndValidatePath's bounded result for an
        // already validateIdForPath-checked id.
        await fs.mkdir(historyDir, { recursive: true }); // lgtm[js/path-injection]

        // version comes from workflow.version which is schema-validated as
        // semver, so it's a safe filename component. timestamp is also safe.
        const snapshotFile = join(historyDir, `${version}-${timestamp}.json`);
        await atomicWriteJSON(snapshotFile, snapshot);

        // Update workflow status
        workflow.status = 'published';
        await atomicWriteJSON(workflowPath, workflow);

        logger.info({
          component: 'workflowRoutes',
          message: `Published workflow '${id}' version ${version}`,
          workflowId: id,
          version
        });

        res.json({ success: true, version, publishedAt: snapshot._publishedAt });
      } catch (error) {
        logger.error({
          component: 'workflowRoutes',
          message: `Failed to publish: ${error.message}`
        });
        res.status(500).json({ error: 'Failed to publish workflow' });
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/{id}/activate/{version}:
   *   put:
   *     summary: Activate a specific workflow version (admin only)
   *     description: |
   *       Restores a previously published version snapshot as the current
   *       workflow definition. The snapshot metadata (_publishedAt, _publishedBy)
   *       is stripped before writing.
   *     tags:
   *       - Workflows
   *       - Versions
   *       - Admin
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: version
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Version activated successfully
   *       400:
   *         description: Invalid workflow ID or version format
   *       404:
   *         description: Workflow or version not found
   *       500:
   *         description: Internal server error
   */
  app.put(
    buildServerPath('/api/workflows/:id/activate/:version'),
    adminAuth,
    checkWorkflowsFeature,
    async (req, res) => {
      const { id } = req.params;
      if (!validateIdForPath(id, 'workflow', res)) {
        return;
      }

      const versionParam = req.params.version;
      // Strict version validation: safe ID chars only, no `..`, and no leading/trailing punctuation.
      if (!isValidWorkflowVersion(versionParam)) {
        return res.status(400).json({ error: 'Invalid version format' });
      }

      try {
        const rootDir = getRootDir();
        const workflowsDir = join(rootDir, 'contents', 'workflows');
        const historyRoot = join(workflowsDir, '.history');
        const historyDir = await resolveAndValidatePath(id, historyRoot);
        if (!historyDir) {
          return res.status(400).json({ error: 'Invalid workflow ID' });
        }

        // Find snapshot file by version prefix
        let snapshotFileName = null;
        try {
          // `historyDir` is resolveAndValidatePath's bounded result for a
          // validateIdForPath-checked id.
          const files = await fs.readdir(historyDir); // lgtm[js/path-injection]
          snapshotFileName = files.find(
            f => f.startsWith(`${versionParam}-`) && f.endsWith('.json')
          );
        } catch {
          return res.status(404).json({ error: 'No version history found' });
        }

        if (!snapshotFileName) {
          return res.status(404).json({ error: `Version ${versionParam} not found` });
        }

        // Read snapshot (resolve+validate with realpath to prevent symlink traversal)
        const snapshotPath = await resolveAndValidateRealPath(snapshotFileName, historyDir);
        if (!snapshotPath) {
          return res.status(400).json({ error: 'Invalid snapshot path' });
        }
        // snapshotPath is a realpath-bounded result constrained to historyDir.
        const content = await fs.readFile(snapshotPath, 'utf8');
        const snapshot = JSON.parse(content);

        // Strip metadata
        delete snapshot._publishedAt;
        delete snapshot._publishedBy;

        // Write as current workflow
        const filename = await findWorkflowFile(id, workflowsDir);
        if (!filename) {
          return sendNotFound(res, 'Workflow');
        }

        const workflowPath = join(workflowsDir, filename);
        await atomicWriteJSON(workflowPath, snapshot);

        logger.info({
          component: 'workflowRoutes',
          message: `Activated version ${versionParam} for workflow '${id}'`,
          workflowId: id,
          version: versionParam
        });

        res.json({ success: true, version: versionParam });
      } catch (error) {
        logger.error({
          component: 'workflowRoutes',
          message: `Failed to activate version: ${error.message}`
        });
        res.status(500).json({ error: 'Failed to activate version' });
      }
    }
  );
}
