import globals from 'globals';
import eslintReact from '@eslint-react/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y';

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
      'concepts/**',
      'logs/**',
      '*.log',
      '.github/**',
      '.claude/**',
      '.worktrees/**'
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
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      'no-console': 'off'
      // Removed all formatting rules that conflict with Prettier
      // Prettier handles: indent, quotes, semi, no-multiple-empty-lines, eol-last,
      // comma-dangle, object-curly-spacing, array-bracket-spacing, space-before-function-paren,
      // keyword-spacing, space-infix-ops, no-trailing-spaces
    }
  },
  {
    files: ['client/**/*.jsx', 'client/**/*.js'],
    ...eslintReact.configs.recommended,
    plugins: {
      ...eslintReact.configs.recommended.plugins,
      ...jsxA11y.flatConfigs.recommended.plugins
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
    rules: {
      ...eslintReact.configs.recommended.rules,
      // Disable RSC rules — not a React Server Components project
      '@eslint-react/rsc/function-definition': 'off',

      // jsx-a11y recommended rules — set to warn to avoid blocking existing PRs.
      // These will be promoted to error incrementally as violations are fixed.
      'jsx-a11y/alt-text': 'warn',
      'jsx-a11y/anchor-has-content': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/aria-activedescendant-has-tabindex': 'warn',
      'jsx-a11y/aria-props': 'warn',
      'jsx-a11y/aria-proptypes': 'warn',
      'jsx-a11y/aria-role': 'warn',
      'jsx-a11y/aria-unsupported-elements': 'warn',
      'jsx-a11y/autocomplete-valid': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/heading-has-content': 'warn',
      'jsx-a11y/html-has-lang': 'warn',
      'jsx-a11y/iframe-has-title': 'warn',
      'jsx-a11y/img-redundant-alt': 'warn',
      'jsx-a11y/interactive-supports-focus': 'warn',
      'jsx-a11y/label-has-associated-control': 'warn',
      'jsx-a11y/media-has-caption': 'warn',
      'jsx-a11y/mouse-events-have-key-events': 'warn',
      'jsx-a11y/no-access-key': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
      'jsx-a11y/no-distracting-elements': 'warn',
      'jsx-a11y/no-interactive-element-to-noninteractive-role': 'warn',
      'jsx-a11y/no-noninteractive-element-interactions': 'warn',
      'jsx-a11y/no-noninteractive-element-to-interactive-role': 'warn',
      'jsx-a11y/no-noninteractive-tabindex': 'warn',
      'jsx-a11y/no-redundant-roles': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/no-aria-hidden-on-focusable': 'warn',
      'jsx-a11y/prefer-tag-over-role': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'warn',
      'jsx-a11y/role-supports-aria-props': 'warn',
      'jsx-a11y/scope': 'warn',
      'jsx-a11y/tabindex-no-positive': 'warn'
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
