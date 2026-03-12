import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { authRequired } from '../middleware/authRequired.js';
import { loadJson } from '../configLoader.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates the base Swagger configuration
 * @param {string} title - API documentation title
 * @param {string} description - API documentation description
 * @param {string} version - API version
 * @param {Array} paths - Array of file paths to scan for documentation
 * @param {string} basePath - Base path for the API server
 * @returns {Object} Swagger configuration object
 */
function createSwaggerConfig(title, description, version, paths) {
  return {
    definition: {
      openapi: '3.0.0',
      info: {
        title,
        description,
        version,
        contact: {
          name: 'iHub Apps',
          url: 'https://github.com/intrafind/ihub-apps'
        }
      },
      servers: [
        {
          url: buildServerPath('/api'),
          description: 'API Server'
        }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          },
          sessionAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'connect.sid'
          }
        }
      },
      security: [
        {
          bearerAuth: []
        },
        {
          sessionAuth: []
        }
      ]
    },
    apis: paths
  };
}

/**
 * Registers Swagger documentation routes
 * @param {Object} app - Express application instance
 * @param {string} basePath - Base path for route registration
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

  logger.info('📚 Setting up Swagger documentation routes...', { component: 'Swagger' });

  // Apply authentication middleware if required
  const middleware = requireAuth ? [authRequired] : [];
  const basePath = buildServerPath('/'); // Get base path without leading slash for config

  // Normal/Chat APIs Documentation
  const normalApiConfig = createSwaggerConfig(
    'iHub Apps - Chat & General APIs',
    'APIs for chat functionality, models, tools, sessions, and general application features',
    '1.0.0',
    [
      path.join(__dirname, 'generalRoutes.js'),
      path.join(__dirname, 'modelRoutes.js'),
      path.join(__dirname, 'toolRoutes.js'),
      path.join(__dirname, 'sessionRoutes.js'),
      path.join(__dirname, 'pageRoutes.js'),
      path.join(__dirname, 'magicPromptRoutes.js'),
      path.join(__dirname, 'shortLinkRoutes.js'),
      path.join(__dirname, 'auth.js'),
      path.join(__dirname, 'chat/**/*.js')
    ],
    basePath
  );

  // Admin APIs Documentation
  const adminApiConfig = createSwaggerConfig(
    'iHub Apps - Admin APIs',
    'Administrative APIs for managing configurations, users, groups, and system settings',
    '1.0.0',
    [path.join(__dirname, 'adminRoutes.js'), path.join(__dirname, 'admin/**/*.js')],
    basePath
  );

  // OpenAI Compatible APIs Documentation
  const openaiApiConfig = createSwaggerConfig(
    'iHub Apps - OpenAI Compatible APIs',
    'OpenAI-compatible inference APIs for chat completions and model listings',
    '1.0.0',
    [path.join(__dirname, 'openaiProxy.js')],
    basePath
  );

  // Generate Swagger specs
  const normalApiSpec = swaggerJSDoc(normalApiConfig);
  const adminApiSpec = swaggerJSDoc(adminApiConfig);
  const openaiApiSpec = swaggerJSDoc(openaiApiConfig);

  // Debug logging
  logger.info('📚 Generated API specs:', { component: 'Swagger' });
  logger.info('Normal API paths count', {
    component: 'Swagger',
    count: Object.keys(normalApiSpec.paths || {}).length
  });
  logger.info('Admin API paths count', {
    component: 'Swagger',
    count: Object.keys(adminApiSpec.paths || {}).length
  });
  logger.info('OpenAI API paths count', {
    component: 'Swagger',
    count: Object.keys(openaiApiSpec.paths || {}).length
  });

  if (Object.keys(normalApiSpec.paths || {}).length > 0) {
    logger.info('Normal API paths', {
      component: 'Swagger',
      paths: Object.keys(normalApiSpec.paths || {}).join(', ')
    });
  }
  if (Object.keys(adminApiSpec.paths || {}).length > 0) {
    logger.info('Admin API paths', {
      component: 'Swagger',
      paths: Object.keys(adminApiSpec.paths || {}).join(', ')
    });
  }
  if (Object.keys(openaiApiSpec.paths || {}).length > 0) {
    logger.info('OpenAI API paths', {
      component: 'Swagger',
      paths: Object.keys(openaiApiSpec.paths || {}).join(', ')
    });
  }

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

  // Individual API documentation routes (JSON only)
  app.get(buildServerPath('/api/docs/normal/swagger.json'), ...middleware, (req, res) => {
    res.json(normalApiSpec);
  });

  app.get(buildServerPath('/api/docs/admin/swagger.json'), ...middleware, (req, res) => {
    res.json(adminApiSpec);
  });

  app.get(buildServerPath('/api/docs/openai/swagger.json'), ...middleware, (req, res) => {
    res.json(openaiApiSpec);
  });

  // Create specific UI for each API set using query parameters
  app.get(buildServerPath('/api/docs/normal'), ...middleware, (req, res) => {
    const customOptions = {
      explorer: false,
      customSiteTitle: 'iHub Apps - Chat & General APIs',
      swaggerOptions: {
        url: buildServerPath('/api/docs/normal/swagger.json', basePath)
      }
    };
    res.send(swaggerUi.generateHTML(normalApiSpec, customOptions));
  });

  app.get(buildServerPath('/api/docs/admin'), ...middleware, (req, res) => {
    const customOptions = {
      explorer: false,
      customSiteTitle: 'iHub Apps - Admin APIs',
      swaggerOptions: {
        url: buildServerPath('/api/docs/admin/swagger.json', basePath)
      }
    };
    res.send(swaggerUi.generateHTML(adminApiSpec, customOptions));
  });

  app.get(buildServerPath('/api/docs/openai'), ...middleware, (req, res) => {
    const customOptions = {
      explorer: false,
      customSiteTitle: 'iHub Apps - OpenAI Compatible APIs',
      swaggerOptions: {
        url: buildServerPath('/api/docs/openai/swagger.json', basePath)
      }
    };
    res.send(swaggerUi.generateHTML(openaiApiSpec, customOptions));
  });

  logger.info('📚 Swagger documentation available at:', { component: 'Swagger' });
  logger.info('Swagger docs - All APIs', {
    component: 'Swagger',
    url: buildServerPath('/api/docs')
  });
  logger.info('Swagger docs - Chat & General', {
    component: 'Swagger',
    url: buildServerPath('/api/docs/normal', basePath)
  });
  logger.info('Swagger docs - Admin', {
    component: 'Swagger',
    url: buildServerPath('/api/docs/admin', basePath)
  });
  logger.info('Swagger docs - OpenAI Compatible', {
    component: 'Swagger',
    url: buildServerPath('/api/docs/openai', basePath)
  });

  if (requireAuth) {
    logger.info('🔐 Authentication required for Swagger access', { component: 'Swagger' });
  } else {
    logger.info('🌐 Swagger accessible without authentication', { component: 'Swagger' });
  }
}
