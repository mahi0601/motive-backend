const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules', 'coverage', 'public/uploads'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // The whole point of this config — see PLAN "centralized logger"
      // section. Overridden below for the two places raw console is
      // actually correct.
      'no-console': 'error',
    },
  },
  {
    // The logger itself has to talk to the real console somewhere.
    files: ['src/config/logger.js'],
    rules: { 'no-console': 'off' },
  },
  {
    // config/env.js's two pre-config fatal validation errors run before the
    // logger can be assumed constructible — see its own comment. Deliberate,
    // not an oversight.
    files: ['src/config/env.js'],
    rules: { 'no-console': 'off' },
  },
  {
    // One-off CLI scripts — console output here is the correct UX (progress
    // messages for someone running `node scripts/foo.js` by hand), not
    // something that should go through the request/error-scoped logger.
    files: ['scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
];
