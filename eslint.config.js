'use strict';

const globals = require('globals');

/**
 * The linter exists here for one rule above all: `no-undef`.
 *
 * A function used but never imported is a `ReferenceError` that Node raises
 * only when that line runs. Requiring the module proves nothing — the file
 * loads fine and fails later, on a path a test may not reach. That is exactly
 * how a missing `emitToAdmin` import shipped past a green suite.
 *
 * Everything else here is deliberately quiet. This is a lint for correctness,
 * not a style argument.
 */
module.exports = [
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'prisma/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'require-atomic-updates': 'off',
    },
  },
];
