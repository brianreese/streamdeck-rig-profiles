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
    // shrink: true — this write came from a person. Deleting a profile is a
    // legitimate reason for the mirror to get smaller, and only the startup
    // snapshot has to be suspicious of that.
    const result = backup(next, { shrink: true });
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
 * Work out, at startup, whether the store is healthy — and say so.
 *
 * Runs once before anything else looks at global settings. Three cases:
 *
 *   store has content          -> harvest secrets, checkpoint; the normal path
 *   store empty, backup exists -> report it. Restoring is the editor's offer
 *                                 to make and the user's to accept.
 *   store empty, no backup     -> genuinely a fresh install, or the disk did
 *                                 not answer. Either way, leave it alone.
 *
 * This function never writes configuration. Not when the store is degraded, and
 * not when it is empty — see the note further down for why the empty case is
 * not an exception.
 *
 * @returns {Promise<{ restored: boolean, degraded?: boolean, reason: string, count?: number }>}
 */
export async function assessStore({
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
    return {
      restored: false,
      reason: 'store healthy',
      harvested,
      counts: {
        profiles: blob?.profiles?.length ?? 0,
        modes: (blob?.modes ?? blob?.scenes ?? []).length,
      },
    };
  }

  if (!configured()) return { restored: false, reason: 'first run' };

  const found = read();
  if (!found) {
    // We know it has run before, so this is loss — but there is nothing to put
    // back. Say so loudly: the alternative is a silent empty deck.
    log('[backup] global settings are empty and no usable backup was found — NOT re-seeding');
    return { restored: false, degraded: true, reason: 'no usable backup' };
  }

  // A restore is OFFERED, never taken. No exceptions, including this one.
  //
  // An earlier version restored automatically when the store came back EMPTY,
  // on the argument that filling a vacuum overwrites nothing and that a child
  // at the rig cannot open a browser. That was overruled: the rule is always
  // confirm a write, never write without consent, and "there was nothing there
  // anyway" is the plugin deciding on the user's behalf what counts as data.
  //
  // The cost is accepted deliberately. After a loss the deck stays broken until
  // someone opens the editor and says yes, and the toast is what points them
  // there. A broken deck is visible and recoverable; an unasked-for write is
  // neither.
  const count = found.settings?.profiles?.length ?? 0;
  log(
    `[backup] global settings are empty but a backup from ${found.savedAt} holds ` +
      `${count} profile(s) — open the editor to restore it`,
  );
  return {
    restored: false,
    degraded: true,
    reason: 'restore available',
    count,
    savedAt: found.savedAt,
    source: found.source,
  };
}
