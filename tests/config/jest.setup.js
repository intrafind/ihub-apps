import dotenv from 'dotenv';
import path from 'path';
import '@testing-library/jest-dom';

// Load test environment variables
dotenv.config({ path: path.resolve('.env.test') });
dotenv.config({ path: path.resolve('.env') });

// Set test-specific environment variables
process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';

// Mock external dependencies in test environment
global.console = {
  ...console,
  // Suppress logs in tests unless needed
  log: process.env.VERBOSE_TESTS ? console.log : jest.fn(),
  debug: process.env.VERBOSE_TESTS ? console.debug : jest.fn(),
  info: process.env.VERBOSE_TESTS ? console.info : jest.fn(),
  warn: console.warn,
  error: console.error
};

// Global test utilities
global.wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Setup test database or mock services here if needed
beforeAll(async () => {
  // Global setup
});

afterAll(async () => {
  // Global cleanup
});
