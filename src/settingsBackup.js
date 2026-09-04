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

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { PLUGIN_DATA_DIR } from './setup.js';

/**
 * Where the mirror lives — except under test, where it emphatically does not.
 *
 * The suite drives saves end to end, and the blobs it uses are named 'primary'
 * and 'stale'. A restore offering those would be this file's own bug, so the
 * whole tree moves to a per-process temp directory when VITEST is set. Same
 * reasoning, and the same shape, as SECRETS_PATH in secrets.js.
 *
 * Redirecting rather than refusing: the round trip is worth exercising, and the
 * handlers that read these paths can then be tested for real.
 */
const ROOT = process.env.VITEST
  ? resolve(tmpdir(), `rig-backup-test-${process.pid}`)
  : PLUGIN_DATA_DIR;

export const BACKUP_PATH = resolve(ROOT, 'settings.backup.json');
export const HISTORY_DIR = resolve(ROOT, 'settings-history');

/**
 * How far back the generations reach, in tiers.
 *
 * A flat "newest 20" spends its whole depth in an afternoon: the editor
 * autosaves, so one evening of work produces twenty near-identical versions and
 * ages out everything older. The depth exists to survive TIME, and the history
 * is then at its thinnest exactly when a week-old mistake needs finding.
 *
 * Tiers keep roughly the same number of files spanning weeks instead of hours.
 */
export const RETENTION = { recent: 10, daily: 7, weekly: 4 };

/** Kept for callers that only want an upper bound on the file count. */
export const HISTORY_LIMIT = RETENTION.recent + RETENTION.daily + RETENTION.weekly;

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

/** How much configuration a blob holds, for comparing two of them. */
function countsOf(blob) {
  const profiles = blob?.profiles?.length ?? 0;
  const modes = (blob?.modes ?? blob?.scenes ?? []).length;
  return { profiles, modes, total: profiles + modes };
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

/** The instant a generation filename encodes, or null if it is not one of ours. */
export function generationDate(file) {
  const name = String(file).split(/[\\/]/).pop() ?? '';
  const m = /^settings-(.+)\.json$/.exec(name);
  if (!m) return null;
  // The stamp is an ISO string with ':' and '.' swapped for '-' so it is a
  // legal filename. Put them back rather than storing the date twice.
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
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
 * Which generations to keep, newest first.
 *
 * Pure, so the policy can be tested without a filesystem. A generation that
 * qualifies under more than one tier is kept once.
 */
export function planRetention(files, { now = () => new Date(), retention = RETENTION } = {}) {
  const dated = files
    .map((file) => ({ file, at: generationDate(file) }))
    .filter((e) => e.at)
    .sort((a, b) => b.at - a.at);

  const nowMs = now().getTime();
  const DAY = 86_400_000;
  const keep = new Set();

  // Recent: everything from the last 24 hours, capped. This is the tier that
  // covers "I broke it five minutes ago".
  dated.filter((e) => nowMs - e.at <= DAY).slice(0, retention.recent).forEach((e) => keep.add(e.file));

  // One per calendar day, then one per week. Newest wins within a bucket, which
  // is what makes an evening of editing cost one slot instead of twenty.
  const firstPerBucket = (bucketOf, limit) => {
    const seen = new Map();
    for (const e of dated) {
      const b = bucketOf(e.at);
      if (!seen.has(b)) seen.set(b, e.file);
    }
    [...seen.values()].slice(0, limit).forEach((f) => keep.add(f));
  };
  firstPerBucket((d) => d.toISOString().slice(0, 10), retention.daily);
  firstPerBucket((d) => Math.floor((nowMs - d.getTime()) / (7 * DAY)), retention.weekly);

  return dated.filter((e) => keep.has(e.file)).map((e) => e.file);
}

/**
 * Three answers, not two: yes, no, and COULD NOT TELL.
 *
 * The distinction is the whole point. `existsSync` returns false for EPERM and
 * EBUSY exactly as it does for ENOENT, and `historyFiles` swallows every error
 * and returns an empty list. So "the disk did not answer" and "nothing was ever
 * configured here" arrived as the same value — and the caller treated that value
 * as permission to seed example profiles over the top.
 *
 * That is the original data-loss bug (docs/BACKLOG.md §8) one level down:
 * absence of evidence read as evidence of absence. It cost a restored config on
 * 2026-09-04, when the plugin started a minute after a reboot, reported
 * "first run", and re-imported profiles.yaml over four recovered profiles —
 * with the mirror sitting on disk the whole time, readable a few minutes later.
 *
 * Boot is precisely when a transient read failure is most likely, and precisely
 * when this runs.
 *
 * @returns {'yes'|'no'|'unknown'}
 */
export function configuredState({
  path = BACKUP_PATH,
  dir = HISTORY_DIR,
  stat = statSync,
  list = readdirSync,
} = {}) {
  const probe = (target) => {
    try {
      stat(target);
      return 'yes';
    } catch (err) {
      // Only "it is definitely not there" counts as a no. Anything else means
      // the question went unanswered.
      return err?.code === 'ENOENT' ? 'no' : 'unknown';
    }
  };

  const mirror = probe(path);
  if (mirror === 'yes') return 'yes';

  let generations = 'no';
  try {
    const found = list(dir).some((f) => f.startsWith('settings-') && f.endsWith('.json'));
    generations = found ? 'yes' : 'no';
  } catch (err) {
    generations = err?.code === 'ENOENT' ? 'no' : 'unknown';
  }
  if (generations === 'yes') return 'yes';

  return mirror === 'unknown' || generations === 'unknown' ? 'unknown' : 'no';
}

/**
 * Has this plugin ever been configured on this machine?
 *
 * "Could not tell" answers YES. Being wrong in that direction means declining to
 * seed a genuinely fresh install until the next start, which costs a person one
 * restart. Being wrong in the other direction destroys their configuration.
 */
export function hasBeenConfigured(opts) {
  return configuredState(opts) !== 'no';
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
export function writeBackup(
  blob,
  {
    path = BACKUP_PATH, dir = HISTORY_DIR, now = () => new Date(),
    checkpoint = false, reason = null, shrink = false,
  } = {},
) {
  if (!isWorthKeeping(blob)) return { written: false, reason: 'nothing worth keeping' };

  const at = now();
  const body = JSON.stringify(
    { version: 1, savedAt: at.toISOString(), reason, settings: blob },
    null,
    2,
  );

  // Has anything actually changed since the last mirror? An unchanged write is
  // still a healthy write, it just does not deserve a generation.
  let changed = true;
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'));
    changed = JSON.stringify(previous?.settings) !== JSON.stringify(blob);
  } catch {
    changed = true; // missing, or unreadable and therefore not a copy of this
  }

  // The mirror must not be DOWNGRADED without someone saying so.
  //
  // "Never mirror a wipe" was only ever enforced for a total wipe: isWorthKeeping
  // asks whether there is anything at all, so four profiles collapsing to two
  // sailed straight through and overwrote the good copy. That is the same
  // partial-loss blind spot the restore offer had, and it is far more dangerous
  // here — the offer merely stays quiet, whereas this destroys the copy that
  // would have undone the loss.
  //
  // A restore or an explicit save passes `shrink: true`, because deliberately
  // deleting a profile is a legitimate reason for the mirror to get smaller.
  const previousBlob = previous?.settings;
  const lost = countsOf(previousBlob).total - countsOf(blob).total;
  if (!shrink && previousBlob && lost > 0) {
    return { written: false, reason: `refusing to shrink the mirror by ${lost} record(s)`, lost };
  }

  writeAtomic(path, body);

  // A generation is a different thing with a different cadence, and only
  // happens when a caller says this moment is worth keeping: the config has
  // settled, or something risky is about to happen. See backupSchedule.js.
  let generation = null;
  if (checkpoint && changed) {
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    generation = resolve(dir, `settings-${stamp}.json`);
    writeAtomic(generation, body);
    thinGenerations({ dir, now });
  }

  return { written: true, changed, generation };
}

/** Delete every generation the retention policy does not keep. */
export function thinGenerations({ dir = HISTORY_DIR, now = () => new Date() } = {}) {
  const all = historyFiles({ dir });
  const keep = new Set(planRetention(all, { now }));
  const removed = [];
  for (const file of all) {
    if (keep.has(file)) continue;
    try {
      unlinkSync(file);
      removed.push(file);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

/** Drop the mirror and every generation. Test-only; the redirect makes it safe. */
export function _resetForTesting({ path = BACKUP_PATH, dir = HISTORY_DIR } = {}) {
  for (const file of [path, ...historyFiles({ dir })]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
}
