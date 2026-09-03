// plugin.js — Stream Deck plugin entry point.
//
// Startup sequence:
//   1. ensureConfig()      — first-run setup; creates the shared state dir
//   2. recoverIfEmpty()    — put settings back if Stream Deck lost them
//   3. migrateIfNeeded()   — import legacy profiles.yaml into global settings
//                            the first time, so existing configs survive
//   4. registerAction()    — wire actions before connecting
//   5. streamDeck.connect()
//
// Profiles live in Stream Deck global settings, not on disk. YAML remains
// available as an import/export format (see configLoader) but is no longer the
// runtime source of truth — the property inspector populates its dropdowns
// from live hardware, which removes the exact-string-match failure mode that
// made a typo silently skip a hardware step.

import streamDeck from '@elgato/streamdeck';
import { ensureConfig } from './setup.js';
import { ProfileKey } from './actions/profileKey.js';
import { ModeKey } from './actions/modeKey.js';
import { migrateIfNeeded } from './migrate.js';
import { recoverIfEmpty } from './settingsStore.js';
import { notify } from './notify.js';

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
streamDeck.actions.registerAction(new ModeKey());

streamDeck.connect();

// Runs after connect so global settings are reachable. A failed migration must
// not stop the plugin loading — an empty profile list is recoverable in the UI,
// a plugin that will not start is not.
// Recovery runs FIRST and is awaited, because the importer's decision depends
// on it: a restored store is no longer empty, so nothing looks like a first
// run. Running these concurrently would race a re-seed against the restore.
recoverIfEmpty({ settings: streamDeck.settings, log: (m) => streamDeck.logger.warn(m) })
  .then((result) => {
    // A silent restore is indistinguishable from nothing having gone wrong, and
    // the user needs to know their deck was a restart away from being empty.
    if (result?.restored) {
      notify(
        'Rig Profiles',
        `Stream Deck lost its settings. Restored ${result.count} profile(s) from backup.`,
      );
    }
  })
  .catch((err) => {
    streamDeck.logger.error(`[plugin] settings recovery failed: ${err.stack ?? err.message}`);
  })
  .then(() =>
    migrateIfNeeded().catch((err) => {
      streamDeck.logger.warn(`[plugin] profile migration skipped: ${err.message}`);
    }),
  );
