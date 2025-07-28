import globals from 'globals';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-bin/**',
      'build/**',
      'coverage/**',
      '*.min.js',
      'client/node_modules/**',
      'server/node_modules/**',
      'client/dist/**',
      'docs/**',
      'examples/**',
      'logs/**',
      '*.log',
      '.github/**',
      '.claude/**'
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
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin
    },
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
    settings: {
      react: {
        version: 'detect'
      }
    },
    rules: {
      // React 17+ JSX Transform - React import not needed
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',

      // Enable JSX-specific rules to detect usage
      'react/jsx-uses-vars': 'error',
      'react/jsx-no-undef': 'error',

      // React hooks rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Disable some overly strict React rules
      'react/prop-types': 'off',
      'react/display-name': 'off'
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
