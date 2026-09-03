// settingsStore.js — the only way this plugin writes global settings.
//
// Every write goes through saveGlobalSettings so that a mirror lands on disk in
// the same breath. Call `streamDeck.settings.setGlobalSettings` directly and the
// mirror silently stops tracking, which is the one way this protection fails —
// so there is exactly one door, and settingsBackup.js is behind it.
//
// Reads deliberately do NOT go through here. Stream Deck remains the source of
// truth during normal operation and the backup is never consulted, because a
// mirror that answers reads is a second source of truth and will eventually
// disagree with the first.

import { readBackup, writeBackup, hasBeenConfigured } from './settingsBackup.js';

/**
 * Write global settings and mirror them to disk.
 *
 * The mirror is best effort: a plugin that refuses to save because a backup
 * failed has turned a safety net into an outage. It is logged, not thrown.
 */
export async function saveGlobalSettings(settings, next, { log = () => {}, backup = writeBackup } = {}) {
  await settings.setGlobalSettings(next);
  try {
    const result = backup(next);
    if (!result.written) log(`[backup] not mirrored: ${result.reason}`);
  } catch (err) {
    log(`[backup] mirror failed: ${err.message}`);
  }
  return next;
}

/**
 * Restore from the mirror when the store came back empty and should not have.
 *
 * Runs once at startup, before anything else looks at global settings. Three
 * cases, and only the middle one does anything:
 *
 *   store has content  -> refresh the mirror; this is the normal path
 *   store empty, mirror exists -> Stream Deck lost it. Put it back.
 *   store empty, no mirror     -> genuinely a fresh install. Leave it alone.
 *
 * The distinction between the last two is the entire fix. They were previously
 * indistinguishable, so a wipe was read as a first run and the example profiles
 * were written over the top of what had just been lost.
 *
 * @returns {Promise<{ restored: boolean, reason: string, count?: number }>}
 */
export async function recoverIfEmpty({
  settings,
  log = () => {},
  read = readBackup,
  backup = writeBackup,
  configured = hasBeenConfigured,
} = {}) {
  const current = await settings.getGlobalSettings();

  if (current?.profiles?.length || current?.modes?.length) {
    try {
      backup(current);
    } catch (err) {
      log(`[backup] mirror failed: ${err.message}`);
    }
    return { restored: false, reason: 'store healthy' };
  }

  if (!configured()) return { restored: false, reason: 'first run' };

  const found = read();
  if (!found) {
    // We know it has run before, so this is loss — but there is nothing to put
    // back. Say so loudly: the alternative is a silent empty deck.
    log('[backup] global settings are empty and no usable backup was found — NOT re-seeding');
    return { restored: false, reason: 'no usable backup' };
  }

  // Anything Stream Deck did manage to keep wins over the mirror, which may be
  // a few writes old — but only where it actually kept something. A surviving
  // `profiles: []` is the shape of the loss, not a value, and spreading it over
  // the restored list would quietly undo the restore.
  const kept = Object.fromEntries(
    Object.entries(current ?? {}).filter(([, v]) => !(v == null || (Array.isArray(v) && !v.length))),
  );
  const merged = {
    ...found.settings,
    ...kept,
    settings: { ...found.settings?.settings, ...current?.settings },
  };

  await settings.setGlobalSettings(merged);
  const count = merged.profiles?.length ?? 0;
  log(`[backup] restored ${count} profile(s) from ${found.source} (saved ${found.savedAt})`);
  return { restored: true, reason: 'restored from backup', count, savedAt: found.savedAt };
}
