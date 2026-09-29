import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'build/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['info', 'warn', 'error', 'debug'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  // main / preload / agent host / tooling run in Node
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'e2e/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  // scripts serialized into web pages (Function.toString) run in the browser and use loose typing on purpose
  {
    files: ['src/main/browser/page-runtime.ts', 'src/main/recorder/recorder-script.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
  // e2e scripts pass callbacks into page.evaluate, which run in the renderer
  { files: ['e2e/**/*.mjs', 'scripts/**/*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } }, rules: { 'no-console': 'off' } },
)
