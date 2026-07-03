export default {
  rootDir: '../../',
  testEnvironment: 'jsdom',
  extensionsToTreatAsEsm: ['.jsx'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    // Force a single React copy. Files under client/ resolve
    // client/node_modules/react while the test renderer (@testing-library/react
    // + react-dom from the root) would use the root copy — two React instances
    // make every real client hook fail with "Invalid hook call". Pin to the
    // CLIENT copy so tests exercise the same React major the shipped bundle
    // is built with.
    '^react$': '<rootDir>/client/node_modules/react',
    '^react/(.*)$': '<rootDir>/client/node_modules/react/$1',
    '^react-dom$': '<rootDir>/client/node_modules/react-dom',
    '^react-dom/(.*)$': '<rootDir>/client/node_modules/react-dom/$1'
  },
  modulePaths: [
    '<rootDir>/node_modules',
    '<rootDir>/client/node_modules',
    '<rootDir>/server/node_modules'
  ],
  transform: {
    '^.+\\.(js|jsx)$': [
      'babel-jest',
      {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          ['@babel/preset-react', { runtime: 'automatic' }]
        ]
      }
    ]
  },
  testMatch: [
    '**/tests/integration/**/*.test.js',
    '**/tests/unit/server/**/*.test.js',
    '**/tests/unit/client/**/*.test.jsx'
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/config/jest.setup.js'],
  collectCoverageFrom: [
    'server/**/*.js',
    'client/src/**/*.{js,jsx}',
    '!server/tests/**',
    '!server/node_modules/**',
    '!client/node_modules/**',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'tests/coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000,
  maxWorkers: 4
};
