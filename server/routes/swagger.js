import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { authRequired } from '../middleware/authRequired.js';
import { loadJson } from '../configLoader.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates the base Swagger configuration
 * @param {string} title - API documentation title
 * @param {string} description - API documentation description
 * @param {string} version - API version
 * @param {Array} paths - Array of file paths to scan for documentation
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
          name: 'AI Hub Apps',
          url: 'https://github.com/intrafind/ai-hub-apps'
        }
      },
      servers: [
        {
          url: '/api',
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
 */
export default async function registerSwaggerRoutes(app) {
  // Check if Swagger is enabled in platform configuration
  let platformConfig = {};
  try {
    platformConfig = (await loadJson('config/platform.json')) || {};
  } catch (error) {
    console.warn('Could not load platform configuration for Swagger setup:', error.message);
  }

  const swaggerConfig = platformConfig.swagger || {};
  const isEnabled = swaggerConfig.enabled !== false; // Default to enabled if not specified
  const requireAuth = swaggerConfig.requireAuth !== false; // Default to requiring auth

  if (!isEnabled) {
    console.log('📚 Swagger documentation is disabled in platform configuration');
    return;
  }

  console.log('📚 Setting up Swagger documentation routes...');

  // Apply authentication middleware if required
  const middleware = requireAuth ? [authRequired] : [];

  // Normal/Chat APIs Documentation
  const normalApiConfig = createSwaggerConfig(
    'AI Hub Apps - Chat & General APIs',
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
    ]
  );

  // Admin APIs Documentation
  const adminApiConfig = createSwaggerConfig(
    'AI Hub Apps - Admin APIs',
    'Administrative APIs for managing configurations, users, groups, and system settings',
    '1.0.0',
    [path.join(__dirname, 'adminRoutes.js'), path.join(__dirname, 'admin/**/*.js')]
  );

  // OpenAI Compatible APIs Documentation
  const openaiApiConfig = createSwaggerConfig(
    'AI Hub Apps - OpenAI Compatible APIs',
    'OpenAI-compatible inference APIs for chat completions and model listings',
    '1.0.0',
    [path.join(__dirname, 'openaiProxy.js')]
  );

  // Generate Swagger specs
  const normalApiSpec = swaggerJSDoc(normalApiConfig);
  const adminApiSpec = swaggerJSDoc(adminApiConfig);
  const openaiApiSpec = swaggerJSDoc(openaiApiConfig);

  // Debug logging
  console.log('📚 Generated API specs:');
  console.log(`   💬 Normal API paths: ${Object.keys(normalApiSpec.paths || {}).length}`);
  console.log(`   🔧 Admin API paths: ${Object.keys(adminApiSpec.paths || {}).length}`);
  console.log(`   🤖 OpenAI API paths: ${Object.keys(openaiApiSpec.paths || {}).length}`);

  if (Object.keys(normalApiSpec.paths || {}).length > 0) {
    console.log(`   💬 Normal API paths: ${Object.keys(normalApiSpec.paths || {}).join(', ')}`);
  }
  if (Object.keys(adminApiSpec.paths || {}).length > 0) {
    console.log(`   🔧 Admin API paths: ${Object.keys(adminApiSpec.paths || {}).join(', ')}`);
  }
  if (Object.keys(openaiApiSpec.paths || {}).length > 0) {
    console.log(`   🤖 OpenAI API paths: ${Object.keys(openaiApiSpec.paths || {}).join(', ')}`);
  }

  // Swagger UI options
  const swaggerOptions = {
    explorer: true,
    swaggerOptions: {
      urls: [
        {
          url: '/api/docs/normal/swagger.json',
          name: 'Chat & General APIs'
        },
        {
          url: '/api/docs/admin/swagger.json',
          name: 'Admin APIs'
        },
        {
          url: '/api/docs/openai/swagger.json',
          name: 'OpenAI Compatible APIs'
        }
      ]
    }
  };

  // Main Swagger UI route - shows all API categories
  app.use('/api/docs', ...middleware, swaggerUi.serve);
  app.get('/api/docs', ...middleware, swaggerUi.setup(null, swaggerOptions));

  // Individual API documentation routes (JSON only)
  app.get('/api/docs/normal/swagger.json', ...middleware, (req, res) => {
    res.json(normalApiSpec);
  });

  app.get('/api/docs/admin/swagger.json', ...middleware, (req, res) => {
    res.json(adminApiSpec);
  });

  app.get('/api/docs/openai/swagger.json', ...middleware, (req, res) => {
    res.json(openaiApiSpec);
  });

  // Create specific UI for each API set using query parameters
  app.get('/api/docs/normal', ...middleware, (req, res) => {
    const customOptions = {
      explorer: false,
      customSiteTitle: 'AI Hub Apps - Chat & General APIs',
      swaggerOptions: {
        url: '/api/docs/normal/swagger.json'
      }
    };
    res.send(swaggerUi.generateHTML(normalApiSpec, customOptions));
  });

  app.get('/api/docs/admin', ...middleware, (req, res) => {
    const customOptions = {
      explorer: false,
      customSiteTitle: 'AI Hub Apps - Admin APIs',
      swaggerOptions: {
        url: '/api/docs/admin/swagger.json'
      }
    };
    res.send(swaggerUi.generateHTML(adminApiSpec, customOptions));
  });

  app.get('/api/docs/openai', ...middleware, (req, res) => {
    const customOptions = {
      explorer: false,
      customSiteTitle: 'AI Hub Apps - OpenAI Compatible APIs',
      swaggerOptions: {
        url: '/api/docs/openai/swagger.json'
      }
    };
    res.send(swaggerUi.generateHTML(openaiApiSpec, customOptions));
  });

  console.log('📚 Swagger documentation available at:');
  console.log('   📖 All APIs: /api/docs');
  console.log('   💬 Chat & General: /api/docs/normal');
  console.log('   🔧 Admin: /api/docs/admin');
  console.log('   🤖 OpenAI Compatible: /api/docs/openai');

  if (requireAuth) {
    console.log('🔐 Authentication required for Swagger access');
  } else {
    console.log('🌐 Swagger accessible without authentication');
  }
}
