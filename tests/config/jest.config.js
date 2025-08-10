export default {
  rootDir: '../../',
  testEnvironment: 'jsdom',
  extensionsToTreatAsEsm: ['.jsx'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy'
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
