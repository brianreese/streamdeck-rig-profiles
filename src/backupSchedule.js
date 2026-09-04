// backupSchedule.js — when a generation is worth keeping.
//
// The mirror and the generations want opposite cadences, and used to share one.
//
// The mirror is written on every settings write, because it is the
// crash-recovery copy and being current is its entire job. Generations are not:
// the editor autosaves, so one evening of work produced dozens of near
// identical versions and burned the whole depth in a sitting. The depth exists
// to survive TIME, and per-write churn spent it in minutes — leaving the
// history at its thinnest exactly when a week-old mistake needed finding.
//
// So a generation is taken at one of two kinds of moment:
//
//   settled   the config has stopped changing for SETTLE_MS. One editing
//             session yields one generation, written when you stop typing.
//   risky     something is about to modify or replace the configuration —
//             plugin start, a YAML import, a restore. These cost nothing,
//             because they are moments rather than streams, and they are
//             precisely the points a person later wants to step back to.

import { writeBackup } from './settingsBackup.js';

/**
 * How long the config must sit still before a generation is written.
 *
 * Long enough that a burst of autosaves collapses into one version, short
 * enough that closing the laptop shortly after an edit still captures it.
 */
export const SETTLE_MS = 90_000;

let pending = null; // { timer, blob }

/**
 * Note that settings changed, and arrange a generation once they stop changing.
 *
 * Each call replaces the previous one, so the timer only fires after a genuine
 * pause. The blob is captured rather than re-read at fire time: the generation
 * should record what was written, not whatever happens to be current 90 seconds
 * later.
 */
export function noteWrite(blob, { write = writeBackup, delay = SETTLE_MS, log = () => {} } = {}) {
  cancel();
  const timer = setTimeout(() => {
    pending = null;
    try {
      const result = write(blob, { checkpoint: true, reason: 'settled' });
      if (result?.generation) log('[backup] checkpoint written (settled)');
    } catch (err) {
      log(`[backup] checkpoint failed: ${err.message}`);
    }
  }, delay);
  // Never hold the process open for a backup.
  timer.unref?.();
  pending = { timer, blob };
  return pending;
}

/**
 * Write a generation now, because something risky is about to happen.
 *
 * Also cancels any settle timer: the checkpoint just taken is at least as good
 * as the one that was waiting, and letting both fire would spend two slots on
 * one edit.
 */
export function checkpointNow(blob, reason, { write = writeBackup, log = () => {} } = {}) {
  cancel();
  try {
    const result = write(blob, { checkpoint: true, reason });
    if (result?.generation) log(`[backup] checkpoint written (${reason})`);
    // A refusal is the guard doing its job, and saying nothing about it is how
    // a protected loss looks identical to an ordinary start.
    else if (result && !result.written) log(`[backup] checkpoint (${reason}) NOT written: ${result.reason}`);
    return result;
  } catch (err) {
    log(`[backup] checkpoint failed: ${err.message}`);
    return null;
  }
}

/** Drop any pending settle timer. */
export function cancel() {
  if (!pending) return false;
  clearTimeout(pending.timer);
  pending = null;
  return true;
}

/** Whether a generation is currently waiting on a pause. Test and status use. */
export function isPending() {
  return Boolean(pending);
}

/**
 * Write the pending generation immediately, if there is one.
 *
 * For shutdown, where waiting out the settle window is not an option and losing
 * the last edit of a session would be the obvious wrong answer.
 */
export function flush(opts) {
  if (!pending) return null;
  const { blob } = pending;
  return checkpointNow(blob, 'flushed', opts);
}
