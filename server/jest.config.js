export default {
  // Use Node.js environment for testing
  testEnvironment: 'node',

  // The package is "type": "module" and source files use native ESM features
  // such as `import.meta.url`, so tests run as real ES modules under Jest's
  // experimental VM modules (the `test` script sets --experimental-vm-modules).
  // .js is treated as ESM automatically because package.json is type:module, and
  // an empty transform lets Node execute the ESM directly — a CommonJS
  // down-level transpile would break `import.meta`.
  transform: {},

  // Test file patterns
  testMatch: ['**/tests/**/*.test.js', '**/__tests__/**/*.js'],

  // Setup files
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],

  // Coverage configuration
  collectCoverageFrom: [
    'routes/**/*.js',
    'middleware/**/*.js',
    'utils/**/*.js',
    '!**/*.test.js',
    '!**/node_modules/**'
  ],

  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    }
  },

  // Strip explicit .js extensions from relative imports so they resolve under
  // Jest's transpiled-CommonJS module system.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },

  // Clear mocks between tests
  clearMocks: true,

  // Verbose output
  verbose: true,

  // Timeout for tests
  testTimeout: 10000
};
