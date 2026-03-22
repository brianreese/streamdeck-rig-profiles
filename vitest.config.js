// vitest.config.js — Vitest configuration for streamdeck-rig-profiles
//
// Standalone Node integration scripts (*.integration.test.js) use node:assert
// with no Vitest describe/it blocks. Vitest's default glob matches them because
// the filename still ends in .test.js, so they are excluded explicitly here.
// Run them directly:  node src/state.integration.test.js

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.*',
    ],
  },
});
