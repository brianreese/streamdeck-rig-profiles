// vitest.config.js — Vitest configuration for streamdeck-rig-profiles
//
// Standalone Node integration scripts (*.integration.test.js) use node:assert
// with no Vitest describe/it blocks. Vitest's default glob matches them because
// the filename still ends in .test.js, so they are excluded explicitly here.
// Run them directly:  node src/state.integration.test.js

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs once per worker, before any test file loads. It exists solely to
    // stop parallel workers racing on the Stream Deck SDK's log rotation —
    // see vitest.setup.js for the full explanation.
    setupFiles: ['./vitest.setup.js'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.*',
    ],
  },
});
