// state.js — Manages persistent active-profile state across two locations:
//
//   1. Plugin-local:  <repo-root>/data/state.json
//      Canonical source; restores button appearance after Stream Deck restarts.
//
//   2. Shared:        %APPDATA%/streamdeck-rig-shared/active-profile.json  (Windows)
//                     ~/Library/Application Support/streamdeck-rig-shared/active-profile.json  (macOS)
//      Mirror; read by the companion streamdeck-ac-launcher plugin to apply
//      content filtering based on the active rig profile.
//
// Both files share the same JSON shape:
//   { "activeProfile": "profile-id", "lastSwitched": "ISO-8601 timestamp" }
//
// Public API:
//   readState({ localPath? } = {})
//     → { activeProfile: string|null, lastSwitched?: string }
//     Returns { activeProfile: null } if the file is missing or malformed — never throws.
//
//   writeState(profileId, { localPath?, sharedPath? } = {})
//     → void
//     Atomically writes both files (write to .tmp then rename).
//
// Note: The optional `_paths` parameter on both functions is intended for
// testing only — production code should call readState() and writeState(id)
// without arguments (matching the same path-override convention used in setup.js).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SHARED_STATE_DIR } from './setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

/** Plugin-local data directory and state file. */
const LOCAL_STATE_DIR  = resolve(__dirname, '..', 'data');
const LOCAL_STATE_PATH = resolve(LOCAL_STATE_DIR, 'state.json');

/** Shared state written by this plugin and read by streamdeck-ac-launcher. */
const SHARED_STATE_PATH = resolve(SHARED_STATE_DIR, 'active-profile.json');

// ---------------------------------------------------------------------------
// Directory bootstrap (runs once on module import)
// ---------------------------------------------------------------------------

// Ensure the plugin-local data/ directory exists.  This is safe to call
// repeatedly; mkdirSync with recursive:true is a no-op when the dir exists.
mkdirSync(LOCAL_STATE_DIR, { recursive: true });

// Ensure the shared directory exists so writeState() never fails on a missing
// parent.  setup.js / ensureConfig() also creates this directory, but state.js
// may be used without having called ensureConfig() first (e.g. in tests).
try {
  mkdirSync(SHARED_STATE_DIR, { recursive: true });
} catch (err) {
  // Non-fatal: warn and continue.  Writes to the shared file will fail later
  // with a clear ENOENT error if the directory truly can't be created.
  console.warn(
    `[state] Could not create shared state directory "${SHARED_STATE_DIR}": ${err.message}`
  );
}

// ---------------------------------------------------------------------------
// readState
// ---------------------------------------------------------------------------

/**
 * Returns the current active-profile state from the plugin-local state file.
 *
 * Gracefully returns `{ activeProfile: null }` if the file is absent, empty,
 * or contains malformed JSON.  Never throws.
 *
 * @param {object} [_paths]              - Path overrides for testing.
 * @param {string} [_paths.localPath]    - Override the local state file path.
 * @returns {{ activeProfile: string|null, lastSwitched?: string }}
 */
export function readState({ localPath = LOCAL_STATE_PATH } = {}) {
  try {
    const raw    = readFileSync(localPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && 'activeProfile' in parsed) {
      return parsed;
    }
    // Valid JSON but unexpected shape — treat as empty state.
    return { activeProfile: null };
  } catch {
    // File absent (ENOENT) or JSON.parse failure — treat as empty state.
    return { activeProfile: null };
  }
}

// ---------------------------------------------------------------------------
// writeState
// ---------------------------------------------------------------------------

/**
 * Atomically writes the active-profile state to both the plugin-local file and
 * the shared file.
 *
 * Each write is performed in two steps:
 *   1. Write the full payload to `<targetPath>.tmp`
 *   2. `renameSync` the .tmp file over the target
 *
 * `renameSync` is atomic on POSIX filesystems and best-effort atomic on
 * Windows (it will overwrite an existing target in a single operation).
 * This ensures a reader never sees a half-written file.
 *
 * @param {string} profileId             - ID of the profile that just became active.
 * @param {object} [_paths]              - Path overrides for testing.
 * @param {string} [_paths.localPath]    - Override the local state file path.
 * @param {string} [_paths.sharedPath]   - Override the shared state file path.
 */
export function writeState(profileId, { localPath = LOCAL_STATE_PATH, sharedPath = SHARED_STATE_PATH } = {}) {
  const state = {
    activeProfile: profileId,
    lastSwitched:  new Date().toISOString(),
  };
  const payload = JSON.stringify(state, null, 2);

  writeAtomic(localPath,  payload);
  writeAtomic(sharedPath, payload);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Writes `content` to `targetPath` atomically via a .tmp rename.
 *
 * @param {string} targetPath
 * @param {string} content
 */
function writeAtomic(targetPath, content) {
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, targetPath);
}
