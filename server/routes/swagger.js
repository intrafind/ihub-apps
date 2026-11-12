// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import swaggerUi from 'swagger-ui-express';
import { authRequired } from '../middleware/authRequired.js';
import { loadJson } from '../configLoader.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';
import {
  API_DOC_SETS,
  buildApiDocSpecs,
  readApiDocSpecs,
  withServerUrl
} from '../utils/apiDocSpecs.js';

/** The documents of this process, once loaded or built. */
let specsPromise = null;

/**
 * The three API documents, loaded on first use and kept for the life of the
 * process.
 *
 * Read from the files the production build writes; built from the route files
 * when those are missing (development). Never at boot: the routes cannot
 * change while the server runs, so there is nothing to gain from building
 * them before somebody opens the docs, and the build costs every worker ~70 MB
 * of heap and a quarter of a second (#3624).
 *
 * @returns {Promise<{normal: Object, admin: Object, openai: Object}>}
 */
export function loadApiDocSpecs() {
  if (!specsPromise) {
    specsPromise = (async () => {
      const prebuilt = await readApiDocSpecs();
      if (prebuilt) {
        logger.info('Loaded the prebuilt API documents', { component: 'Swagger' });
        return prebuilt;
      }
      const started = Date.now();
      const built = await buildApiDocSpecs();
      logger.info('Built the API documents from the route files', {
        component: 'Swagger',
        durationMs: Date.now() - started,
        ...Object.fromEntries(
          Object.entries(built).map(([name, spec]) => [
            `${name}Paths`,
            Object.keys(spec.paths || {}).length
          ])
        )
      });
      return built;
    })().catch(error => {
      // A failed load is retried on the next request rather than cached.
      specsPromise = null;
      throw error;
    });
  }
  return specsPromise;
}

/** Forget the loaded documents (tests). */
export function resetApiDocSpecsForTests() {
  specsPromise = null;
}

/**
 * One document as served: the installation's base path in `servers`.
 *
 * @param {'normal'|'admin'|'openai'} name - Document
 * @returns {Promise<Object>}
 */
async function servedSpec(name) {
  const specs = await loadApiDocSpecs();
  return withServerUrl(specs[name], buildServerPath('/api'));
}

/**
 * Registers Swagger documentation routes
 * @param {Object} app - Express application instance
 */
export default async function registerSwaggerRoutes(app) {
  // Check if Swagger is enabled in platform configuration
  let platformConfig = {};
  try {
    platformConfig = (await loadJson('config/platform.json')) || {};
  } catch (error) {
    logger.warn('Could not load platform configuration for Swagger setup:', {
      component: 'Swagger',
      error: error.message
    });
  }

  const swaggerConfig = platformConfig.swagger || {};
  const isEnabled = swaggerConfig.enabled !== false; // Default to enabled if not specified
  const requireAuth = swaggerConfig.requireAuth !== false; // Default to requiring auth

  if (!isEnabled) {
    logger.info('📚 Swagger documentation is disabled in platform configuration', {
      component: 'Swagger'
    });
    return;
  }

  // Apply authentication middleware if required
  const middleware = requireAuth ? [authRequired] : [];
  const basePath = buildServerPath('/'); // Get base path without leading slash for config

  // Swagger UI options
  const swaggerOptions = {
    explorer: true,
    swaggerOptions: {
      urls: [
        {
          url: buildServerPath('/api/docs/normal/swagger.json'),
          name: 'Chat & General APIs'
        },
        {
          url: buildServerPath('/api/docs/admin/swagger.json'),
          name: 'Admin APIs'
        },
        {
          url: buildServerPath('/api/docs/openai/swagger.json'),
          name: 'OpenAI Compatible APIs'
        }
      ]
    }
  };

  // Main Swagger UI route - shows all API categories
  app.use(buildServerPath('/api/docs'), ...middleware, swaggerUi.serve);
  app.get(buildServerPath('/api/docs'), ...middleware, swaggerUi.setup(null, swaggerOptions));

  for (const name of Object.keys(API_DOC_SETS)) {
    // Individual API documentation routes (JSON only)
    app.get(buildServerPath(`/api/docs/${name}/swagger.json`), ...middleware, async (req, res) => {
      res.json(await servedSpec(name));
    });

    // Specific UI for each API set
    app.get(buildServerPath(`/api/docs/${name}`), ...middleware, async (req, res) => {
      const customOptions = {
        explorer: false,
        customSiteTitle: API_DOC_SETS[name].title,
        swaggerOptions: {
          url: buildServerPath(`/api/docs/${name}/swagger.json`, basePath)
        }
      };
      res.send(swaggerUi.generateHTML(await servedSpec(name), customOptions));
    });
  }

  logger.info('📚 Swagger documentation available', {
    component: 'Swagger',
    url: buildServerPath('/api/docs'),
    authentication: requireAuth ? 'required' : 'not required'
  });
}
