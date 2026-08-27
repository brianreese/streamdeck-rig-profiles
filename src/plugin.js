// plugin.js — Stream Deck plugin entry point.
//
// Startup sequence:
//   1. ensureConfig()      — first-run setup; creates the shared state dir
//   2. migrateIfNeeded()   — import legacy profiles.yaml into global settings
//                            the first time, so existing configs survive
//   3. registerAction()    — wire actions before connecting
//   4. streamDeck.connect()
//
// Profiles live in Stream Deck global settings, not on disk. YAML remains
// available as an import/export format (see configLoader) but is no longer the
// runtime source of truth — the property inspector populates its dropdowns
// from live hardware, which removes the exact-string-match failure mode that
// made a typo silently skip a hardware step.

import streamDeck from '@elgato/streamdeck';
import { ensureConfig } from './setup.js';
import { ProfileKey } from './actions/profileKey.js';
import { migrateIfNeeded } from './migrate.js';

// An uncaught rejection here kills the plugin process and Stream Deck silently
// restarts it, which reads as "the button just did nothing". Log first.
process.on('unhandledRejection', (reason) => {
  streamDeck.logger.error(`[plugin] unhandled rejection: ${reason?.stack ?? reason}`);
});
process.on('uncaughtException', (err) => {
  streamDeck.logger.error(`[plugin] uncaught exception: ${err?.stack ?? err}`);
});

ensureConfig();

streamDeck.actions.registerAction(new ProfileKey());

streamDeck.connect();

// Runs after connect so global settings are reachable. A failed migration must
// not stop the plugin loading — an empty profile list is recoverable in the UI,
// a plugin that will not start is not.
migrateIfNeeded().catch((err) => {
  streamDeck.logger.warn(`[plugin] profile migration skipped: ${err.message}`);
});
