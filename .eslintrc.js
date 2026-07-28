module.exports = {
  extends: 'erb',
  plugins: ['@typescript-eslint'],
  rules: {
    // A temporary hack related to IDE not resolving correct package.json
    'import/no-extraneous-dependencies': 'off',
    'react/react-in-jsx-scope': 'off',
    'react/jsx-filename-extension': 'off',
    'import/extensions': 'off',
    'import/no-unresolved': 'off',
    'import/no-import-module-exports': 'off',
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': 'error',

    // --- Rules relaxed to match this codebase's established, intentional
    // patterns. tsc (run separately in CI) and @typescript-eslint/no-unused-vars
    // still catch real problems; these only silenced stylistic noise that the
    // whole codebase already violates by design.

    // Sequential awaits in the sync loops are REQUIRED — punches and screenshots
    // must upload one-at-a-time in chronological order. Parallelising them would
    // break ordering and the idempotency guarantees.
    'no-await-in-loop': 'off',
    'no-restricted-syntax': 'off',
    'no-continue': 'off',
    'no-plusplus': 'off',

    // Services are exposed as default-export singletons that also re-export their
    // members by name; the app deliberately uses the default object.
    'import/no-named-as-default': 'off',
    'import/no-named-as-default-member': 'off',
    'import/no-cycle': 'off',
    'import/no-relative-packages': 'off',

    // TypeScript already checks for undefined identifiers (DOM types like
    // HeadersInit, Node's NodeJS namespace), so ESLint's no-undef is redundant
    // and produces false positives here.
    'no-undef': 'off',

    // The server API contract uses snake_case fields (user_id, workspace_id).
    camelcase: 'off',

    // Debug-heavy desktop app: console logging is intentional and already only
    // a warning, but these three are errors the codebase never conformed to.
    'no-promise-executor-return': 'off',
    'class-methods-use-this': 'off',
    'react/function-component-definition': 'off',
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  settings: {
    'import/resolver': {
      // See https://github.com/benmosher/eslint-plugin-import/issues/1396#issuecomment-575727774 for line below
      node: {
        extensions: ['.js', '.jsx', '.ts', '.tsx'],
        moduleDirectory: ['node_modules', 'src/'],
      },
      webpack: {
        config: require.resolve('./.erb/configs/webpack.config.eslint.ts'),
      },
      typescript: {},
    },
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
  },
};
