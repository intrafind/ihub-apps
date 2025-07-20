export default {
  // Use Node.js environment for testing
  testEnvironment: 'node',

  // Support ES modules
  preset: '@babel/preset-env',
  extensionsToTreatAsEsm: ['.js'],

  // Transform files with Babel
  transform: {
    '^.+\\.js$': [
      'babel-jest',
      {
        presets: [['@babel/preset-env', { targets: { node: 'current' } }]]
      }
    ]
  },

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

  // Module name mapping for mocks
  moduleNameMapping: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },

  // Clear mocks between tests
  clearMocks: true,

  // Verbose output
  verbose: true,

  // Timeout for tests
  testTimeout: 10000
};
