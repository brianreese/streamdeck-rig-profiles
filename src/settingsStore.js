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
import { harvestSecrets } from './secrets.js';
import { noteWrite, checkpointNow } from './backupSchedule.js';
import { secretSettingKeys } from './providers/index.js';

/**
 * Write global settings and mirror them to disk.
 *
 * The mirror is best effort: a plugin that refuses to save because a backup
 * failed has turned a safety net into an outage. It is logged, not thrown.
 */
export async function saveGlobalSettings(
  settings,
  next,
  {
    log = () => {},
    backup = writeBackup,
    secretKeys = secretSettingKeys,
    harvest = harvestSecrets,
    schedule = noteWrite,
  } = {},
) {
  // Strip credentials before anything stores or mirrors them.
  //
  // This is the whole reason the guarantee holds. Backups promise to contain no
  // secrets, and the way to keep that promise is not to filter them out on the
  // way to a backup — it is for them never to be in the object a backup copies.
  // One door in, one strip, and every artifact downstream is clean without
  // knowing anything about secrets.
  //
  // It doubles as the migration: the first write after this ships lifts the
  // Govee key out of global settings, with no separate migration step to run
  // once and then carry forever.
  const { blob, harvested } = harvest(next, secretKeys());
  if (harvested.length) log(`[secrets] moved out of global settings: ${harvested.join(', ')}`);
  next = blob;

  await settings.setGlobalSettings(next);
  try {
    const result = backup(next);
    if (!result.written) log(`[backup] not mirrored: ${result.reason}`);
    // The mirror is current as of this instant. A generation is a separate
    // decision and waits for the config to stop moving — see backupSchedule.js
    // for why every-write generations spent the whole depth in an evening.
    else schedule(next, { log });
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
  secretKeys = secretSettingKeys,
  harvest = harvestSecrets,
  checkpoint = checkpointNow,
} = {}) {
  const current = await settings.getGlobalSettings();

  if (current?.profiles?.length || current?.modes?.length) {
    // Harvest before mirroring, not after.
    //
    // This path writes the mirror directly rather than through
    // saveGlobalSettings, so without this it would faithfully copy a key that
    // has not been lifted out of the blob yet — and on a machine upgrading to
    // the secret store, the very first mirror would be the one containing the
    // credential. It is also what performs the migration on a machine that
    // starts up and is never edited.
    const { blob, harvested } = harvest(current, secretKeys());
    if (harvested.length) {
      log(`[secrets] moved out of global settings: ${harvested.join(', ')}`);
      await settings.setGlobalSettings(blob);
    }
    try {
      // A checkpoint before anything else runs. Free — this happens once per
      // start, not per keystroke — and it is the version to step back to when
      // a session goes wrong.
      checkpoint(blob, 'startup', { log });
    } catch (err) {
      log(`[backup] mirror failed: ${err.message}`);
    }
    return { restored: false, reason: 'store healthy', harvested };
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
