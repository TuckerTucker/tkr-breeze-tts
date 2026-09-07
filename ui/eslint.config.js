/**
 * The lint gate for the browser surface.
 *
 * The repository had no lint configuration anywhere, so nothing but the
 * compiler was reading this code, and the compiler is deliberately narrow:
 * `noUnusedLocals` only ever sees a binding inside the file that declares it.
 * That blind spot is how a whole retired component surface accumulated
 * unnoticed — every dead module kept looking alive by its own test.
 *
 * This file covers the rules ESLint can decide from one file at a time. The
 * cross-file half — an export nothing imports — is `npm run lint:exports`,
 * which runs beside it and reads the whole TypeScript program.
 *
 * @module
 */

import js from '@eslint/js';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'public/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    files: ['**/*.{ts,tsx,js}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: './tsconfig.json' }),
      ],
    },
    rules: {
      // Hook order and effect dependencies — the two failures that produce a
      // stale render rather than a crash. The plugin's compiler-era rules
      // (`refs`, `set-state-in-effect`, `preserve-manual-memoization`) stay off:
      // they report established patterns in files no current slice touches, and
      // a gate nobody can make green is not a gate.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // A `_` prefix is already this project's "declared, deliberately unused"
      // convention, honoured by tsconfig's noUnusedParameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use a named export — a default export does not survive a rename.',
        },
      ],
    },
  },
  {
    // Tests run in jsdom under Node and build browser fixtures the application
    // never constructs itself.
    files: ['test/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Build and lint configuration: Node, and the default export Vite requires.
    files: ['*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // False positives against plugins that also export their default's name.
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',
    },
  },
);
