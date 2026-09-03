// plugin.js — Stream Deck plugin entry point.
//
// Startup sequence:
//   1. ensureConfig()      — first-run setup; creates the shared state dir
//   2. assessStore()       — notice, and report, if Stream Deck lost them
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
import { assessStore } from './settingsStore.js';
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
// The assessment runs FIRST and is awaited, because the importer's decision
// depends on it: it harvests secrets and takes the startup checkpoint, and its
// verdict is what the log will be read against if anything looks wrong.
assessStore({ settings: streamDeck.settings, log: (m) => streamDeck.logger.warn(m) })
  .then((result) => {
    // Nothing is restored automatically. The toast exists because the deck's
    // own broken keys are the other half of the prompt, and a person seeing
    // them should know where to go rather than guessing.
    if (result?.degraded) {
      notify(
        'Rig Profiles',
        result.count
          ? `Settings look lost. A backup from ${new Date(result.savedAt).toLocaleString()} `
            + `has ${result.count} profile(s) — open the editor to restore it.`
          : 'Settings look lost and no usable backup was found. Open the editor.',
      );
    }
  })
  .catch((err) => {
    streamDeck.logger.error(`[plugin] settings assessment failed: ${err.stack ?? err.message}`);
  })
  .then(() =>
    migrateIfNeeded().catch((err) => {
      streamDeck.logger.warn(`[plugin] profile migration skipped: ${err.message}`);
    }),
  );
