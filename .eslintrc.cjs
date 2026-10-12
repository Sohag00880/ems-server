/* eslint-env node */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  extends: ['eslint:recommended', 'prettier'],
  ignorePatterns: ['node_modules', '.eslintrc.cjs'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  overrides: [
    {
      files: ['**/*.test.js', 'tests/**/*.js'],
      env: { node: true },
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  ],
  rules: {},
};