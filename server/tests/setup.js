import logger from '../utils/logger.js';
/**
 * Jest setup file for authentication security tests
 */

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key';
process.env.HOST = 'localhost';
process.env.PORT = '3001';

// Global test utilities
global.testUtils = {
  // Helper to create mock users
  createMockUser: (overrides = {}) => ({
    id: 'test-user',
    username: 'testuser',
    email: 'test@example.com',
    groups: ['user'],
    active: true,
    ...overrides
  }),

  // Helper to create mock admin user
  createMockAdmin: (overrides = {}) => ({
    id: 'admin-user',
    username: 'admin',
    email: 'admin@example.com',
    groups: ['admin'],
    active: true,
    ...overrides
  }),

  // Helper to create mock anonymous user
  createMockAnonymous: () => ({
    id: 'anonymous',
    name: 'Anonymous',
    email: null,
    groups: ['anonymous']
  })
};

// Suppress logger.info during tests (optional)
if (process.env.SUPPRESS_LOGS === 'true') {
  global.console = {
    ...console,
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
}

// Set global timeout
jest.setTimeout(10000);
