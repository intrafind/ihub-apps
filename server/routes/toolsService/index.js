import express from 'express';
import { requireFeature } from '../../featureRegistry.js';
import { registerJobRoutes } from './jobRoutes.js';
import { registerOcrRoutes } from './ocrRoutes.js';

export default function registerToolsServiceRoutes(app) {
  const router = express.Router();

  // Gate all tools-service routes behind the feature flag
  router.use(requireFeature('toolsService'));

  // Shared job infrastructure (SSE progress + download)
  registerJobRoutes(router);

  // OCR tool
  registerOcrRoutes(router);

  // Future tools register here, e.g.:
  // registerWebsearchRoutes(router);

  app.use('/api/tools-service', router);
}
