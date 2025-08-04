import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { authRequired } from '../middleware/authRequired.js';
import { loadJson } from '../configLoader.js';

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
    platformConfig = await loadJson('config/platform.json') || {};
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
      './routes/generalRoutes.js',
      './routes/modelRoutes.js',
      './routes/toolRoutes.js',
      './routes/sessionRoutes.js',
      './routes/pageRoutes.js',
      './routes/magicPromptRoutes.js',
      './routes/shortLinkRoutes.js',
      './routes/auth.js',
      './routes/chat/*.js'
    ]
  );

  // Admin APIs Documentation
  const adminApiConfig = createSwaggerConfig(
    'AI Hub Apps - Admin APIs',
    'Administrative APIs for managing configurations, users, groups, and system settings',
    '1.0.0',
    [
      './routes/adminRoutes.js',
      './routes/admin/*.js'
    ]
  );

  // OpenAI Compatible APIs Documentation
  const openaiApiConfig = createSwaggerConfig(
    'AI Hub Apps - OpenAI Compatible APIs',
    'OpenAI-compatible inference APIs for chat completions and model listings',
    '1.0.0',
    ['./routes/openaiProxy.js']
  );

  // Generate Swagger specs
  const normalApiSpec = swaggerJSDoc(normalApiConfig);
  const adminApiSpec = swaggerJSDoc(adminApiConfig);
  const openaiApiSpec = swaggerJSDoc(openaiApiConfig);

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

  // Individual API documentation routes
  app.get('/api/docs/normal/swagger.json', ...middleware, (req, res) => {
    res.json(normalApiSpec);
  });

  app.get('/api/docs/admin/swagger.json', ...middleware, (req, res) => {
    res.json(adminApiSpec);
  });

  app.get('/api/docs/openai/swagger.json', ...middleware, (req, res) => {
    res.json(openaiApiSpec);
  });

  // Individual Swagger UI routes for each API category
  app.get('/api/docs/normal', ...middleware, swaggerUi.setup(normalApiSpec, {
    explorer: false,
    customSiteTitle: 'AI Hub Apps - Chat & General APIs'
  }));

  app.get('/api/docs/admin', ...middleware, swaggerUi.setup(adminApiSpec, {
    explorer: false,
    customSiteTitle: 'AI Hub Apps - Admin APIs'
  }));

  app.get('/api/docs/openai', ...middleware, swaggerUi.setup(openaiApiSpec, {
    explorer: false,
    customSiteTitle: 'AI Hub Apps - OpenAI Compatible APIs'
  }));

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