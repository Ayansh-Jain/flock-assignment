import js from '@eslint/js';
import nodePlugin from 'eslint-plugin-n';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  nodePlugin.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': 'error',
      eqeqeq: 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      // process.loadEnvFile is flagged experimental below Node 22.21 but works on all >=22.
      'n/no-unsupported-features/node-builtins': ['error', { allowExperimental: true }],
    },
  },
  {
    files: ['src/**/*.js'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['scripts/**/*.js'],
    rules: { 'no-console': 'off', 'n/no-process-exit': 'off' },
  },
];
