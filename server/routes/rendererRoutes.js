// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import express from 'express';
import { loadAllRenderers, getRendererById } from '../renderersLoader.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import { assertValidId } from '../utils/pathSecurity.js';

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
  });

  /**
   * GET /api/renderers/:id
   * Get a specific renderer by ID (includes code)
   */
  router.get('/:id', async (req, res) => {
    const { id } = req.params;

    // Validate renderer ID to prevent path traversal
    assertValidId(id, 'renderer');

    const renderer = await getRendererById(id, false);

    if (!renderer) {
      throw new ServiceError('NOT_FOUND', 'Renderer not found');
    }

    if (!renderer.enabled) {
      throw new ServiceError('FORBIDDEN', 'Renderer is disabled');
    }

    // Return full renderer including code
    res.json(renderer);
  });

  // Mount router
  app.use(buildServerPath('/api/renderers'), router);
}
