/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs', 'node_modules'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['react-refresh'],
  rules: {
    // React Refresh — warn on non-component exports (Vite HMR)
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

    // Relax rules that create noise in this codebase:
    // Many services use _ prefix for private fields (TS convention)
    '@typescript-eslint/no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    }],
    // Dynamic imports are used heavily for circular dep avoidance
    '@typescript-eslint/no-var-requires': 'off',
    // Empty catch blocks are intentional (fire-and-forget patterns)
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Allow explicit any in API response parsing where types are unknown
    '@typescript-eslint/no-explicit-any': 'warn',
  },
}
