import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      '**/coverage/**',
      '**/playwright-report/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // 中控台本身不得呼叫 LLM（派工單 §1.3-2、§10）。
      'no-restricted-imports': ['error', { patterns: ['@anthropic-ai/*', 'openai', 'openai/*'] }],
    },
  },
);
