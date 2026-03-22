// setup.js — first-run setup helper.
//
// Call ensureConfig() once at plugin startup (before configLoader.init()).
// If config/profiles.yaml doesn't exist yet, it is copied from the bundled
// template so the user has a ready-to-edit starting point.
//
// Also ensures the shared state directory used by both plugins exists.
//
// Usage (plugin startup):
//   import { ensureConfig } from './setup.js';
//   const firstRun = ensureConfig();
//
// Usage (tests): pass path overrides so tests never touch the real config dir.
//   ensureConfig({ profilesPath: tmpProfilesPath, sharedStateDir: tmpSharedDir });

import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const _CONFIG_DIR    = resolve(__dirname, '..', 'config');
const _TEMPLATE_PATH = resolve(_CONFIG_DIR, 'profiles.yaml.template');
const _PROFILES_PATH = resolve(_CONFIG_DIR, 'profiles.yaml');

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

// ---------------------------------------------------------------------------
// ensureConfig
// ---------------------------------------------------------------------------

/**
 * Run once at plugin startup.
 *
 * - Creates the config directory if it doesn't exist.
 * - Copies profiles.yaml.template → profiles.yaml on first run.
 * - Creates the cross-plugin shared state directory.
 *
 * Returns true if the template was copied (first run), false otherwise.
 *
 * @param {object} [options]           - Optional path overrides (primarily for testing).
 * @param {string} [options.configDir]      - Override the config/ directory path.
 * @param {string} [options.templatePath]   - Override the template file path.
 * @param {string} [options.profilesPath]   - Override the profiles.yaml output path.
 * @param {string} [options.sharedStateDir] - Override the shared state directory path.
 */
export function ensureConfig({
  configDir    = _CONFIG_DIR,
  templatePath = _TEMPLATE_PATH,
  profilesPath = _PROFILES_PATH,
  sharedStateDir = SHARED_STATE_DIR,
} = {}) {
  // 1. Ensure config directory exists (should already be there in the repo,
  //    but guard against unusual install layouts).
  mkdirSync(configDir, { recursive: true });

  // Also ensure the directory for profilesPath exists, since it may point
  // outside configDir when overridden (e.g. in tests).
  const profilesDir = dirname(profilesPath);
  mkdirSync(profilesDir, { recursive: true });
  // 2. Auto-copy template if profiles.yaml is absent.
  let firstRun = false;
  if (!existsSync(profilesPath)) {
    if (!existsSync(templatePath)) {
      console.error(
        '[setup] profiles.yaml.template not found — cannot create default config. ' +
        'Please restore the template from the repo or create config/profiles.yaml manually.'
      );
    } else {
      copyFileSync(templatePath, profilesPath);
      firstRun = true;
      console.log(
        '[setup] First run detected — created config/profiles.yaml from template. ' +
        'Open the file and set your Govee API key, FanaLab hotkeys, and ' +
        'Stream Deck profile names before switching profiles.'
      );
    }
  }

  // 3. Ensure shared state directory exists so both plugins can read/write it.
  try {
    mkdirSync(sharedStateDir, { recursive: true });
  } catch (err) {
    console.warn(`[setup] Could not create shared state directory "${sharedStateDir}": ${err.message}`);
  }

  return firstRun;
}

/**
 * Exported path constants so other modules (e.g. state.js) can import them
 * without duplicating the platform logic.
 */
export { SHARED_STATE_DIR };

