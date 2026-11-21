import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'release/**',
      'dist/**',
      'coverage/**',
      '.evals/**',
      'native/**',
      'resources/**',
      'docs/**',
      'playbooks/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // TypeScript already resolves identifiers; core no-undef only produces noise on types.
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
)
