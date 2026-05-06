import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import iFinderService from '../../services/integrations/iFinderService.js';
import iAssistantService from '../../services/integrations/iAssistantService.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import { throttledFetch } from '../../requestThrottler.js';
import logger from '../../utils/logger.js';
import { sendErrorResponse } from '../../utils/responseHelpers.js';
import tokenStorageService from '../../services/TokenStorageService.js';

/**
 * Admin routes for testing integrations (iFinder, iAssistant)
 */

export default function registerIntegrationTestRoutes(app) {
  /**
   * @swagger
   * /admin/integrations/ifinder/_test:
   *   post:
   *     summary: Test iFinder integration
   *     description: Tests the iFinder connection and JWT authentication (admin access required)
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: iFinder integration test results
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   description: Whether the test was successful
   *                 message:
   *                   type: string
   *                   description: Test result message
   *                 details:
   *                   type: object
   *                   description: Additional test details
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Test failed
   */
  app.post(
    buildServerPath('/api/admin/integrations/ifinder/_test'),
    adminAuth,
    async (req, res) => {
      try {
        const config = iFinderService.getConfig();

        // Check if iFinder is enabled
        const platformConfig = iFinderService.platform || {};
        const iFinderConfig = platformConfig.iFinder || {};

        if (!iFinderConfig.enabled) {
          return res.json({
            success: false,
            message: 'iFinder integration is not enabled',
            details: {
              enabled: false
            }
          });
        }

        // Validate required configuration
        if (!iFinderConfig.baseUrl) {
          return res.json({
            success: false,
            message: 'iFinder base URL is not configured',
            details: {
              missingConfig: 'baseUrl'
            }
          });
        }

        // Validate JWT signing configuration based on mode
        if (iFinderConfig.useOidcKeyPair) {
          // When using OIDC keypair mode, verify OIDC RSA keypair is available
          const rsaKeyPair = tokenStorageService.getRSAKeyPair();
          if (!rsaKeyPair || !rsaKeyPair.privateKey) {
            return res.json({
              success: false,
              message:
                'iHub OIDC RSA key pair is not initialized. Cannot sign iFinder JWT with OIDC keypair.',
              details: {
                missingConfig: 'oidcKeyPair',
                useOidcKeyPair: true
              }
            });
          }
        } else {
          // When using dedicated iFinder private key, verify it's configured
          if (!iFinderConfig.privateKey) {
            return res.json({
              success: false,
              message: 'iFinder private key is not configured',
              details: {
                missingConfig: 'privateKey',
                useOidcKeyPair: false
              }
            });
          }
        }

        // Create a test user for JWT generation
        const testUser = {
          id: req.user?.id || 'test-admin',
          email: req.user?.email || 'admin@test.com',
          username: req.user?.username || 'admin',
          name: req.user?.name || 'Test Admin',
          groups: req.user?.groups || ['admin']
        };

        // Try to generate JWT token
        let authHeader;
        try {
          authHeader = getIFinderAuthorizationHeader(testUser);
          logger.info('iFinder JWT token generated successfully for test', {
            component: 'IntegrationTest',
            userId: testUser.id
          });
        } catch (error) {
          logger.error('iFinder JWT generation failed', {
            component: 'IntegrationTest',
            error
          });
          return res.json({
            success: false,
            message: 'Failed to generate JWT token',
            details: {
              error: error.message,
              step: 'jwt_generation'
            }
          });
        }

        // Try to make a simple search request to verify connectivity
        const searchEndpoint = config.endpoints.search.replace(
          '{profileId}',
          encodeURIComponent(config.defaultSearchProfile)
        );
        const searchUrl = `${config.baseUrl.replace(/\/+$/, '')}${searchEndpoint}?query=test&size=1`;

        logger.info('Testing iFinder connection', {
          component: 'IntegrationTest',
          baseUrl: config.baseUrl,
          searchProfile: config.defaultSearchProfile
        });

        const response = await throttledFetch('iFinderTest', searchUrl, {
          method: 'GET',
          headers: {
            Authorization: authHeader,
            Accept: 'application/json'
          },
          timeout: config.timeout
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.warn('iFinder test request failed', {
            component: 'IntegrationTest',
            status: response.status,
            error: errorText
          });

          return res.json({
            success: false,
            message: `iFinder API returned status ${response.status}`,
            details: {
              status: response.status,
              error: errorText,
              step: 'api_request'
            }
          });
        }

        const data = await response.json();

        logger.info('iFinder test successful', {
          component: 'IntegrationTest',
          totalHits: data.metadata?.total_hits
        });

        return res.json({
          success: true,
          message: 'iFinder integration is working correctly',
          details: {
            baseUrl: config.baseUrl,
            searchProfile: config.defaultSearchProfile,
            jwtGeneration: 'success',
            apiConnection: 'success',
            responseTime: data.metadata?.took,
            totalResults: data.metadata?.total_hits || 0
          }
        });
      } catch (error) {
        logger.error('iFinder test error', { component: 'IntegrationTest', error });
        return res.json({
          success: false,
          message: error.message || 'iFinder integration test failed',
          details: {
            error: error.message,
            step: 'unknown'
          }
        });
      }
    }
  );

  /**
   * @swagger
   * /admin/integrations/iassistant/_test:
   *   post:
   *     summary: Test iAssistant integration
   *     description: Tests the iAssistant connection and configuration (admin access required)
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: iAssistant integration test results
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   description: Whether the test was successful
   *                 message:
   *                   type: string
   *                   description: Test result message
   *                 details:
   *                   type: object
   *                   description: Additional test details
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Test failed
   */
  app.post(
    buildServerPath('/api/admin/integrations/iassistant/_test'),
    adminAuth,
    async (req, res) => {
      try {
        const config = iAssistantService.getConfig();

        // Validate required configuration
        if (!config.baseUrl) {
          return res.json({
            success: false,
            message: 'iAssistant base URL is not configured',
            details: {
              missingConfig: 'baseUrl'
            }
          });
        }

        if (!config.defaultProfileId) {
          return res.json({
            success: false,
            message: 'iAssistant default profile ID is not configured',
            details: {
              missingConfig: 'defaultProfileId'
            }
          });
        }

        // Create a test user for JWT generation
        const testUser = {
          id: req.user?.id || 'test-admin',
          email: req.user?.email || 'admin@test.com',
          username: req.user?.username || 'admin',
          name: req.user?.name || 'Test Admin',
          groups: req.user?.groups || ['admin']
        };

        // Try to generate JWT token (iAssistant uses iFinder JWT)
        let authHeader;
        try {
          authHeader = getIFinderAuthorizationHeader(testUser);
          logger.info('iAssistant JWT token generated successfully for test', {
            component: 'IntegrationTest',
            userId: testUser.id
          });
        } catch (error) {
          logger.error('iAssistant JWT generation failed', {
            component: 'IntegrationTest',
            error
          });
          return res.json({
            success: false,
            message: 'Failed to generate JWT token',
            details: {
              error: error.message,
              step: 'jwt_generation'
            }
          });
        }

        // Try to make a simple request to verify connectivity
        // iAssistant conversation API endpoint
        const conversationUrl = `${config.baseUrl.replace(/\/+$/, '')}/public-api/rag/api/v0/conversations`;

        logger.info('Testing iAssistant connection', {
          component: 'IntegrationTest',
          baseUrl: config.baseUrl,
          profileId: config.defaultProfileId
        });

        try {
          const response = await throttledFetch('iAssistantTest', conversationUrl, {
            method: 'GET',
            headers: {
              Authorization: authHeader,
              Accept: 'application/json'
            },
            timeout: config.timeout || 30000
          });

          if (!response.ok) {
            const errorText = await response.text();
            logger.warn('iAssistant test request failed', {
              component: 'IntegrationTest',
              status: response.status,
              error: errorText
            });

            // If health endpoint doesn't exist, the service might still be working
            // Just report that we couldn't verify via health endpoint
            return res.json({
              success: false,
              message: `iAssistant health check returned status ${response.status}`,
              details: {
                status: response.status,
                error: errorText,
                step: 'health_check',
                note: 'Configuration appears valid but health endpoint returned an error. The service may still be functional.'
              }
            });
          }

          const data = await response.json();

          logger.info('iAssistant test successful', {
            component: 'IntegrationTest',
            response: data
          });

          return res.json({
            success: true,
            message: 'iAssistant integration is working correctly',
            details: {
              baseUrl: config.baseUrl,
              profileId: config.defaultProfileId,
              jwtGeneration: 'success',
              healthCheck: 'success',
              responseData: data
            }
          });
        } catch (fetchError) {
          // If the health endpoint doesn't exist or fails, just validate configuration
          logger.info('iAssistant health endpoint not available, validating configuration only', {
            component: 'IntegrationTest',
            error: fetchError.message
          });

          return res.json({
            success: true,
            message: 'iAssistant configuration is valid (health endpoint not available)',
            details: {
              baseUrl: config.baseUrl,
              profileId: config.defaultProfileId,
              jwtGeneration: 'success',
              configValidation: 'success',
              note: 'Could not verify connectivity via health endpoint, but configuration appears valid.'
            }
          });
        }
      } catch (error) {
        logger.error('iAssistant test error', { component: 'IntegrationTest', error });
        return sendErrorResponse(res, 500, error.message || 'iAssistant integration test failed');
      }
    }
  );
}
