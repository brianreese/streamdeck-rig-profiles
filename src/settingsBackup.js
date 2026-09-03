// settingsBackup.js — an on-disk mirror of Stream Deck's global settings.
//
// Global settings are where every profile, Mode and API key lives, and Stream
// Deck holds them IN MEMORY. It flushes on a clean shutdown; it does not flush
// when the process is killed. On 2026-09-02 `StreamDeck.exe` was force-killed
// to make it rescan its plugins folder, and everything configured since the
// last clean exit was simply gone — `getGlobalSettings()` came back empty six
// seconds later, and nothing on this machine held another copy. Not %APPDATA%,
// not %PROGRAMDATA%, not the deck's own BackupV3 (layouts only), not git.
//
// So this file exists to make that survivable. It is a mirror, not a store:
// Stream Deck stays the source of truth, and nothing here is read during normal
// operation. It is read exactly once, at startup, when the store comes back
// empty and should not have — see settingsStore.js for that decision.
//
// Two rules keep the mirror trustworthy:
//
//   * NEVER write a blob that has lost content. A backup that faithfully
//     mirrors the moment of a wipe is worse than no backup at all, because it
//     destroys the copy that could have undone it.
//   * Keep generations. A single file means one bad write is terminal, and the
//     failure being defended against here is precisely a write that looked
//     routine at the time.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { PLUGIN_DATA_DIR } from './setup.js';

export const BACKUP_PATH = resolve(PLUGIN_DATA_DIR, 'settings.backup.json');
export const HISTORY_DIR = resolve(PLUGIN_DATA_DIR, 'settings-history');

/** How many past versions to keep. Small files; the depth costs nothing. */
export const HISTORY_LIMIT = 20;

/**
 * Is this blob worth preserving?
 *
 * The guard against mirroring a wipe. An empty store is a legitimate state for
 * about a minute after installation and at no other time, so anything carrying
 * real configuration is worth keeping and anything else is refused.
 */
export function isWorthKeeping(blob) {
  if (!blob || typeof blob !== 'object') return false;
  return Boolean(
    blob.profiles?.length ||
      blob.modes?.length ||
      blob.scenes?.length ||
      blob.settings?.goveeApiKey,
  );
}

function writeAtomic(path, body) {
  const tmp = `${path}.tmp`;
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(tmp, body, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/** Every history file, newest first. Names sort chronologically by construction. */
export function historyFiles({ dir = HISTORY_DIR } = {}) {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith('settings-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => resolve(dir, f));
  } catch {
    return [];
  }
}

/**
 * Has this plugin ever been configured on this machine?
 *
 * The question `getGlobalSettings()` cannot answer, and the whole reason the
 * data loss happened: an empty store looks identical to a fresh install, so the
 * importer treated a wipe as a first run and seeded over the top. This marker
 * lives outside the thing that gets lost, which is the only property that
 * matters about it.
 */
export function hasBeenConfigured({ path = BACKUP_PATH, dir = HISTORY_DIR } = {}) {
  return existsSync(path) || historyFiles({ dir }).length > 0;
}

/** The most recent usable backup, or null. Never throws. */
export function readBackup({ path = BACKUP_PATH, dir = HISTORY_DIR } = {}) {
  const candidates = [path, ...historyFiles({ dir })];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      // Fall through to an older generation rather than returning a blob that
      // cannot restore anything — a truncated newest file must not mask a good
      // one behind it.
      if (isWorthKeeping(parsed?.settings)) return { ...parsed, source: file };
    } catch {
      /* try the next generation */
    }
  }
  return null;
}

/**
 * Mirror a settings blob to disk.
 *
 * Returns what it did, so callers can log it rather than guess. Refusing is a
 * normal outcome, not an error: it is this function working.
 *
 * @returns {{ written: boolean, reason?: string }}
 */
export function writeBackup(blob, { path = BACKUP_PATH, dir = HISTORY_DIR, now = () => new Date() } = {}) {
  // Never touch the real backup from a test run. Tests inject a temp path and
  // exercise every line below; what they must never do is write example data
  // into the one file a real restore reads back. The suite is full of blobs
  // named 'primary' and 'stale', and a restore offering those would be its own
  // small version of this bug.
  if (process.env.VITEST && path === BACKUP_PATH) return { written: false, reason: 'test run' };

  if (!isWorthKeeping(blob)) return { written: false, reason: 'nothing worth keeping' };

  const body = JSON.stringify(
    { version: 1, savedAt: now().toISOString(), settings: blob },
    null,
    2,
  );

  // Unchanged content still means a healthy write happened; it just does not
  // deserve a history slot, or one restart per hour would age the depth out.
  let changed = true;
  try {
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    changed = JSON.stringify(previous?.settings) !== JSON.stringify(blob);
  } catch {
    changed = true; // missing, or unreadable and therefore not a copy of this
  }

  if (changed) {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    writeAtomic(resolve(dir, `settings-${stamp}.json`), body);
    for (const stale of historyFiles({ dir }).slice(HISTORY_LIMIT)) {
      try {
        unlinkSync(stale);
      } catch {
        /* best effort */
      }
    }
  }

  writeAtomic(path, body);
  return { written: true, changed };
}
