import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist-electron/**', 'dist-renderer/**', 'dist-app/**', 'node_modules/**', 'mockups/**', 'skill/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  }
);
