import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', 'roms/**', 'firmware/**'] },
  {
    files: ['src/**/*.ts', 'eslint.config.js'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      curly: ['error', 'all'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/web/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['node:*'] }] },
  },
);
