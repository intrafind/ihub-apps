import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '*.min.js',
      'client/node_modules/**',
      'server/node_modules/**',
      'client/dist/**',
      'docs/**',
      'examples/**',
      'logs/**',
      '*.log'
    ]
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2024
      }
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-console': 'off'
      // Removed all formatting rules that conflict with Prettier
      // Prettier handles: indent, quotes, semi, no-multiple-empty-lines, eol-last,
      // comma-dangle, object-curly-spacing, array-bracket-spacing, space-before-function-paren,
      // keyword-spacing, space-infix-ops, no-trailing-spaces
    }
  },
  {
    files: ['client/**/*.jsx', 'client/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        ...globals.browser,
        ...globals.es2024
      }
    },
    rules: {
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off'
    }
  },
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024
      }
    }
  }
];
