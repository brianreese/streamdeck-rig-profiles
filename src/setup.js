// setup.js — directory setup at plugin startup.
//
// Call ensureConfig() once at startup. It creates directories, and nothing
// else. It does NOT create any profiles.
//
// It used to seed config/profiles.yaml from a bundled template, which an
// importer then read into global settings on every start. Both are gone. A
// profile names this rig's specific hardware — a Pit House preset by uuid, a
// wheelbase setup slot, a Govee scene by name — so a canned one cannot be
// right for anybody, and it was never possible to know what hardware a person
// has. What the seed did reliably was overwrite real configuration: all three
// losses recorded in docs/BACKLOG.md §8 ran through that importer.
//
// A fresh install now starts empty, and the editor asks for the first profile.
//
// Also ensures the shared state directory used by both plugins exists.
//
// Usage (plugin startup):
//   import { ensureConfig } from './setup.js';
//   ensureConfig();
//
// Usage (tests): pass path overrides so tests never touch the real config dir.
//   ensureConfig({ sharedStateDir: tmpSharedDir, pluginDataDir: tmpDataDir });

import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const _CONFIG_DIR = resolve(__dirname, '..', 'config');

// Shared state directory written by this plugin and read by streamdeck-ac-launcher.
// On macOS the conventional equivalent of %APPDATA% is ~/Library/Application Support.
const WINDOWS_APPDATA_BASE = process.platform === 'win32'
  ? (process.env.APPDATA && process.env.APPDATA.trim() !== ''
      ? process.env.APPDATA
      : resolve(os.homedir(), 'AppData', 'Roaming'))
  : null;

const SHARED_STATE_DIR = process.platform === 'win32'
  ? resolve(WINDOWS_APPDATA_BASE, 'streamdeck-rig-shared')
  : resolve(os.homedir(), 'Library', 'Application Support', 'streamdeck-rig-shared');

// Plugin-private data directory for caches and runtime state that should
// persist across deploys but not be committed to the repo.
// Uses the plugin bundle ID (com.rig.profiles) as the directory name.
//   macOS:   ~/Library/Application Support/com.rig.profiles/
//   Windows: %APPDATA%\com.rig.profiles\
const PLUGIN_DATA_DIR = process.platform === 'win32'
  ? resolve(WINDOWS_APPDATA_BASE, 'com.rig.profiles')
  : resolve(os.homedir(), 'Library', 'Application Support', 'com.rig.profiles');

// ---------------------------------------------------------------------------
// ensureConfig
// ---------------------------------------------------------------------------

/**
 * Run once at plugin startup. Creates directories, and creates no data.
 *
 * - Creates the config directory if it doesn't exist.
 * - Creates the cross-plugin shared state directory.
 * - Creates the plugin-private data directory (for caches, state.json, etc.).
 *
 * There is no first run to detect any more, and nothing to report, so this
 * returns nothing. It used to copy a template into config/profiles.yaml and
 * return whether it had — see the note at the top of this file for why seeding
 * is gone.
 *
 * @param {object} [options]           - Optional path overrides (primarily for testing).
 * @param {string} [options.configDir]      - Override the config/ directory path.
 * @param {string} [options.sharedStateDir] - Override the shared state directory path.
 * @param {string} [options.pluginDataDir]  - Override the plugin-private data directory path.
 */
export function ensureConfig({
  configDir    = _CONFIG_DIR,
  sharedStateDir = SHARED_STATE_DIR,
  pluginDataDir  = PLUGIN_DATA_DIR,
} = {}) {
  // 1. Ensure config directory exists (should already be there in the repo,
  //    but guard against unusual install layouts).
  mkdirSync(configDir, { recursive: true });

  // 2. Ensure shared state directory exists so both plugins can read/write it.
  try {
    mkdirSync(sharedStateDir, { recursive: true });
  } catch (err) {
    console.warn(`[setup] Could not create shared state directory "${sharedStateDir}": ${err.message}`);
  }

  // 3. Ensure plugin-private data directory exists (govee cache, state.json, etc.).
  try {
    mkdirSync(pluginDataDir, { recursive: true });
  } catch (err) {
    console.warn(`[setup] Could not create plugin data directory "${pluginDataDir}": ${err.message}`);
  }

}

/**
 * Exported path constants so other modules (e.g. state.js) can import them
 * without duplicating the platform logic.
 */
export { SHARED_STATE_DIR, PLUGIN_DATA_DIR };

