import express from 'express';
import { loadAllRenderers, getRendererById } from '../renderersLoader.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { sendInternalError, sendNotFound, sendErrorResponse } from '../utils/responseHelpers.js';

/**
 * Register renderer routes
 * @param {Express} app - Express app instance
 * @param {string} basePath - Base path for the application
 */
export default function registerRendererRoutes(app) {
  const router = express.Router();

  /**
   * GET /api/renderers
   * Get list of all available custom response renderers
   */
  router.get('/', async (req, res) => {
    try {
      const renderers = await loadAllRenderers(false);

      // Return metadata only (without the actual code for list view)
      const rendererList = renderers
        .filter(r => r.enabled)
        .map(r => ({
          id: r.id,
          filename: r.filename,
          source: r.source
        }));

      res.json(rendererList);
    } catch (error) {
      return sendInternalError(res, error, 'load renderers');
    }
  });

  /**
   * GET /api/renderers/:id
   * Get a specific renderer by ID (includes code)
   */
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;

      // Validate renderer ID to prevent path traversal
      if (!validateIdForPath(id, 'renderer', res)) return;

      const renderer = await getRendererById(id, false);

      if (!renderer) {
        return sendNotFound(res, 'Renderer');
      }

      if (!renderer.enabled) {
        return sendErrorResponse(res, 403, 'Renderer is disabled');
      }

      // Return full renderer including code
      res.json(renderer);
    } catch (error) {
      return sendInternalError(res, error, 'load renderer');
    }
  });

  // Mount router
  app.use(buildServerPath('/api/renderers'), router);
}
