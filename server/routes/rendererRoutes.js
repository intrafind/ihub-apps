import express from 'express';
import { loadAllRenderers, getRendererById } from '../renderersLoader.js';
import { buildServerPath } from '../utils/basePath.js';

/**
 * Register renderer routes
 * @param {Express} app - Express app instance
 * @param {string} basePath - Base path for the application
 */
export default function registerRendererRoutes(app, basePath = '') {
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
      console.error('Error loading renderers:', error);
      res.status(500).json({ 
        error: 'Failed to load renderers',
        message: error.message 
      });
    }
  });

  /**
   * GET /api/renderers/:id
   * Get a specific renderer by ID (includes code)
   */
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const renderer = await getRendererById(id, false);
      
      if (!renderer) {
        return res.status(404).json({ 
          error: 'Renderer not found',
          id 
        });
      }
      
      if (!renderer.enabled) {
        return res.status(403).json({ 
          error: 'Renderer is disabled',
          id 
        });
      }
      
      // Return full renderer including code
      res.json(renderer);
    } catch (error) {
      console.error('Error loading renderer:', error);
      res.status(500).json({ 
        error: 'Failed to load renderer',
        message: error.message 
      });
    }
  });

  // Mount router
  app.use(buildServerPath(basePath, '/api/renderers'), router);
}

