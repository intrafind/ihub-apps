#!/usr/bin/env node

/**
 * Quick Authentication Validation Script
 *
 * Performs basic validation of authentication middleware without full test suite
 */

import {
import logger from '../utils/logger.js';
  authRequired,
  appAccessRequired,
  modelAccessRequired
} from '../middleware/authRequired.js';

logger.info('🔒 Quick Authentication Validation\n');

// Mock request/response objects
function createMockReq(user = null, params = {}) {
  return {
    user,
    params,
    app: {
      get: key => {
        if (key === 'platform') {
          return {
            auth: {
              allowAnonymous: false,
              anonymousGroup: 'anonymous'
            }
          };
        }
        return null;
      }
    }
  };
}

function createMockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    statusCode: null,
    responseData: null
  };

  res.status.mockImplementation(code => {
    res.statusCode = code;
    return res;
  });

  res.json.mockImplementation(data => {
    res.responseData = data;
    return res;
  });

  return res;
}

function createMockNext() {
  return jest.fn();
}

// Test scenarios
const tests = [
  {
    name: 'authRequired - Anonymous user with allowAnonymous: false',
    middleware: authRequired,
    req: createMockReq(null),
    expectedStatus: 401,
    expectedError: 'Authentication required'
  },
  {
    name: 'authRequired - Authenticated user',
    middleware: authRequired,
    req: createMockReq({ id: 'user1', username: 'test' }),
    expectedStatus: null,
    shouldCallNext: true
  },
  {
    name: 'appAccessRequired - User with app permission',
    middleware: appAccessRequired,
    req: createMockReq(
      {
        id: 'user1',
        permissions: { apps: new Set(['test-app']) }
      },
      { appId: 'test-app' }
    ),
    expectedStatus: null,
    shouldCallNext: true
  },
  {
    name: 'appAccessRequired - User without app permission',
    middleware: appAccessRequired,
    req: createMockReq(
      {
        id: 'user1',
        permissions: { apps: new Set(['other-app']) }
      },
      { appId: 'test-app' }
    ),
    expectedStatus: 403,
    expectedError: 'Access denied'
  },
  {
    name: 'modelAccessRequired - User with model permission',
    middleware: modelAccessRequired,
    req: createMockReq(
      {
        id: 'user1',
        permissions: { models: new Set(['*']) }
      },
      { modelId: 'gpt-4' }
    ),
    expectedStatus: null,
    shouldCallNext: true
  }
];

logger.info('Running validation tests...\n');

let passed = 0;
let failed = 0;

// Mock Jest functions if not available
if (typeof jest === 'undefined') {
  global.jest = {
    fn: () => {
      const mockFn = function (...args) {
        mockFn.calls.push(args);
        return mockFn.returnValue;
      };
      mockFn.calls = [];
      mockFn.returnValue = undefined;
      mockFn.mockReturnThis = () => {
        mockFn.returnValue = mockFn;
        return mockFn;
      };
      mockFn.mockImplementation = impl => {
        return Object.assign(mockFn, impl);
      };
      return mockFn;
    }
  };
}

for (const test of tests) {
  try {
    const res = createMockRes();
    const next = createMockNext();

    // Run the middleware
    test.middleware(test.req, res, next);

    // Check results
    if (test.expectedStatus) {
      if (res.statusCode === test.expectedStatus) {
        logger.info(`✅ ${test.name}`);
        if (test.expectedError && res.responseData?.error) {
          logger.info(`   Expected error: "${test.expectedError}"`);
          logger.info(`   Actual error: "${res.responseData.error}"`);
        }
        passed++;
      } else {
        logger.info(`❌ ${test.name}`);
        logger.info(`   Expected status: ${test.expectedStatus}, Got: ${res.statusCode}`);
        failed++;
      }
    } else if (test.shouldCallNext) {
      if (next.calls && next.calls.length > 0) {
        logger.info(`✅ ${test.name}`);
        passed++;
      } else {
        logger.info(`❌ ${test.name}`);
        logger.info(`   Expected next() to be called, but it wasn't`);
        failed++;
      }
    }
  } catch (error) {
    logger.info(`❌ ${test.name}`);
    logger.info(`   Error: ${error.message}`);
    failed++;
  }
}

logger.info('\n' + '='.repeat(50));
logger.info(`📊 Quick Validation Results: ${passed}/${passed + failed} passed`);

if (failed === 0) {
  logger.info('🎉 All basic validations passed!');
  logger.info('✅ Authentication middleware is working correctly');
} else {
  logger.info('⚠️  Some validations failed');
  logger.info('🔧 Please check the middleware implementation');
}

logger.info('\n💡 Run full test suite with: npm run test:security');
logger.info('='.repeat(50));
