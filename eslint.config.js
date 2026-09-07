import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['lib/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A command class is the unit oclif loads, so a default export is the contract.
      'import/no-default-export': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // node:test takes callbacks it runs itself, so a returned promise is not floating.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  prettier
);
