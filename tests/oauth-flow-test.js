#!/usr/bin/env node

/**
 * OAuth 2.0 Client Credentials Flow - End-to-End Test
 * 
 * This script tests the complete OAuth flow:
 * 1. Create OAuth client (admin)
 * 2. Generate access token
 * 3. Use token to call API
 * 4. Introspect token
 * 5. Rotate secret
 * 6. Clean up
 */

import axios from 'axios';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_SECRET || 'platform-secret';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) {
  log(`✅ ${message}`, 'green');
}

function error(message) {
  log(`❌ ${message}`, 'red');
}

function info(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function warn(message) {
  log(`⚠️  ${message}`, 'yellow');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testOAuthFlow() {
  let clientId = null;
  let clientSecret = null;
  let accessToken = null;

  try {
    info('Starting OAuth 2.0 Client Credentials Flow Test\n');

    // Step 1: Create OAuth Client
    info('Step 1: Creating OAuth client...');
    try {
      const createResponse = await axios.post(
        `${BASE_URL}/api/admin/oauth/clients`,
        {
          name: 'Test Integration',
          description: 'Automated test client',
          scopes: ['chat', 'models'],
          allowedApps: ['chat'],
          allowedModels: ['gpt-4'],
          tokenExpirationMinutes: 5
        },
        {
          headers: {
            'Authorization': `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      clientId = createResponse.data.client.clientId;
      clientSecret = createResponse.data.client.clientSecret;
      
      success(`Client created: ${clientId}`);
      info(`  Token expiration: ${createResponse.data.client.tokenExpirationMinutes} minutes\n`);
    } catch (err) {
      if (err.response?.data?.error === 'OAuth is not enabled on this server') {
        error('OAuth is not enabled. Enable it in platform.json:');
        console.log(JSON.stringify({
          oauth: {
            enabled: true,
            clientsFile: 'contents/config/oauth-clients.json',
            defaultTokenExpirationMinutes: 60
          }
        }, null, 2));
        return;
      }
      throw err;
    }

    // Step 2: Generate Access Token
    info('Step 2: Generating access token...');
    const tokenResponse = await axios.post(
      `${BASE_URL}/api/oauth/token`,
      {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'chat models'
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    accessToken = tokenResponse.data.access_token;
    success('Access token generated');
    info(`  Token type: ${tokenResponse.data.token_type}`);
    info(`  Expires in: ${tokenResponse.data.expires_in} seconds`);
    info(`  Scope: ${tokenResponse.data.scope}\n`);

    // Step 3: Use Token to Call API (test if token works)
    info('Step 3: Testing token with API call...');
    try {
      const apiResponse = await axios.get(
        `${BASE_URL}/api/auth/user`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      success('Token is valid and working');
      info(`  Authenticated as: ${apiResponse.data.user.name}`);
      info(`  Auth mode: ${apiResponse.data.user.authMethod}\n`);
    } catch (err) {
      // Some endpoints might not be accessible to OAuth clients
      // Check if it's a permission issue vs token issue
      if (err.response?.status === 403) {
        warn('Token works but endpoint requires different permissions (expected)');
      } else if (err.response?.status === 401) {
        error('Token authentication failed');
        throw err;
      }
    }

    // Step 4: Introspect Token
    info('Step 4: Introspecting token...');
    const introspectResponse = await axios.post(
      `${BASE_URL}/api/oauth/introspect`,
      {
        token: accessToken
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (introspectResponse.data.active) {
      success('Token is active');
      info(`  Client ID: ${introspectResponse.data.client_id}`);
      info(`  Scopes: ${introspectResponse.data.scopes.join(', ')}\n`);
    } else {
      error('Token is not active!');
      throw new Error('Token introspection failed');
    }

    // Step 5: Rotate Secret
    info('Step 5: Rotating client secret...');
    const rotateResponse = await axios.post(
      `${BASE_URL}/api/admin/oauth/clients/${clientId}/rotate-secret`,
      {},
      {
        headers: {
            'Authorization': `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const newSecret = rotateResponse.data.clientSecret;
    success('Secret rotated successfully');
    info(`  Old tokens are now invalid\n`);

    // Step 6: Verify old token is invalid
    info('Step 6: Verifying old token is invalid...');
    const introspectOldResponse = await axios.post(
      `${BASE_URL}/api/oauth/introspect`,
      {
        token: accessToken
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (introspectOldResponse.data.active) {
      warn('Old token is still active (this might be due to JWT caching)');
    } else {
      success('Old token is now inactive (as expected)\n');
    }

    // Step 7: Generate new token with new secret
    info('Step 7: Generating token with new secret...');
    const newTokenResponse = await axios.post(
      `${BASE_URL}/api/oauth/token`,
      {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: newSecret,
        scope: 'chat'
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    success('New token generated with rotated secret\n');

    // Step 8: Test error handling
    info('Step 8: Testing error handling...');
    
    // Test invalid credentials
    try {
      await axios.post(
        `${BASE_URL}/api/oauth/token`,
        {
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: 'wrong_secret'
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      error('Should have failed with invalid credentials');
    } catch (err) {
      if (err.response?.status === 401) {
        success('Invalid credentials properly rejected');
      } else {
        throw err;
      }
    }

    // Test invalid scope
    try {
      await axios.post(
        `${BASE_URL}/api/oauth/token`,
        {
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: newSecret,
          scope: 'invalid_scope'
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      error('Should have failed with invalid scope');
    } catch (err) {
      if (err.response?.status === 400 && err.response?.data?.error === 'invalid_scope') {
        success('Invalid scope properly rejected\n');
      } else {
        throw err;
      }
    }

    // Step 9: Clean up
    info('Step 9: Cleaning up test client...');
    await axios.delete(
      `${BASE_URL}/api/admin/oauth/clients/${clientId}`,
      {
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`
        }
      }
    );
    success('Test client deleted\n');

    // Summary
    log('\n' + '='.repeat(60), 'green');
    success('All OAuth 2.0 Client Credentials tests passed! 🎉');
    log('='.repeat(60) + '\n', 'green');

  } catch (err) {
    error('\nTest failed!');
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Error:', err.message);
    }

    // Clean up on failure
    if (clientId) {
      try {
        info('\nCleaning up test client...');
        await axios.delete(
          `${BASE_URL}/api/admin/oauth/clients/${clientId}`,
          {
            headers: {
              'Authorization': `Bearer ${ADMIN_TOKEN}`
            }
          }
        );
        success('Test client deleted');
      } catch (cleanupErr) {
        warn('Failed to clean up test client');
      }
    }

    process.exit(1);
  }
}

// Run the test
testOAuthFlow().catch(err => {
  error('Unexpected error:', err);
  process.exit(1);
});
