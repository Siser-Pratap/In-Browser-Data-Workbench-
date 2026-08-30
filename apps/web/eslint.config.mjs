import js from '@eslint/js';
import next from 'eslint-config-next';
import tseslint from 'typescript-eslint';

// `eslint-config-next` exports a flat-config *array*, not a factory.
export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'public/duckdb/**',
      'next-env.d.ts',
      // Playwright's artifacts. Generated, git-ignored, and full of bundled
      // JS — but flat config doesn't read .gitignore, so `pnpm lint` after a
      // local e2e run would otherwise report hundreds of errors in a trace.
      'test-results/**',
      'playwright-report/**',
      // Written by `pnpm gen:api` from the server's OpenAPI document. Linting
      // generated code just means the next regeneration reintroduces the same
      // complaints.
      'src/lib/api/schema.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,
  {
    // Type-aware rules need a program, which is only worth building for our own
    // source — not for config files at the repo root.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
