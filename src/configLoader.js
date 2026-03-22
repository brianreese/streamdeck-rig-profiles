// configLoader.js — loads and validates profiles.yaml, watches for live changes.
//
// Usage (plugin startup):
//   import { init, close, getProfiles, getSettings, onUpdate } from './configLoader.js';
//   await init();                    // load once; starts file watcher
//   onUpdate((profiles, settings) => { /* re-render buttons */ });
//   // ...
//   await close();                   // stop watcher on plugin teardown (returns a Promise)
//
// Public API:
//   init(configPath?)    → Promise<void>  — load config + start watcher; must be called before getters
//   close()              → Promise<void>  — stop file watcher (call on plugin teardown or in test cleanup)
//   getProfiles()        → Profile[]      — shallow copy; all valid, fully-defaulted profiles
//   getProfileById(id)   → Profile | null — look up a single profile by id
//   getSettings()        → Settings       — shallow copy of the top-level settings block
//   onUpdate(callback)   → void           — called (with fresh profiles + settings) after every hot-reload

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import chokidar from 'chokidar';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default config path — used when init() is called without an argument. */
const DEFAULT_CONFIG_PATH = resolve(__dirname, '..', 'config', 'profiles.yaml');

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

/**
 * Defaults merged into every profile for optional fields.
 * Adding a new driver field here automatically:
 *  1. Gives every profile a safe null/false default
 *  2. Adds the key to KNOWN_PROFILE_KEYS (unknown-key warnings)
 */
const PROFILE_DEFAULTS = {
  fanatec_preset_hotkey: null,
  moza_profile:          null,
  govee_scene:           null,
  sd_profile:            null,
  // Race Launcher content filtering.
  // null = no filter (profile sees all content).
  // Array of strings → content tagged with ANY listed tag is shown (OR logic).
  // A bare string in YAML is coerced to a one-item array.
  content_filter_tags:   null,
  skip_options_step:     false,
  default_format:        null,
};

const SETTINGS_DEFAULTS = {
  default_profile: null,
  govee_api_key:   '',
};

/** All valid top-level keys for a profile entry. Anything else triggers a warning. */
const KNOWN_PROFILE_KEYS = new Set([
  'id', 'name', 'color',
  ...Object.keys(PROFILE_DEFAULTS),
]);

// ---------------------------------------------------------------------------
// Module-level state (singleton — one config per plugin instance)
// ---------------------------------------------------------------------------

/** Config path resolved when init() is called. */
let resolvedConfigPath = DEFAULT_CONFIG_PATH;
let profiles = [];
let settings = { ...SETTINGS_DEFAULTS };
let watcher = null;

/** Callbacks registered via onUpdate(). Cleared on each init() call. */
const updateCallbacks = [];

// ---------------------------------------------------------------------------
// Internal: validation
// ---------------------------------------------------------------------------

/**
 * Validate the required fields of a raw profile object.
 * Returns an array of error strings (empty = valid).
 * Color format warnings are logged directly (non-fatal).
 */
function validateProfile(raw, index) {
  const errors = [];
  if (!raw.id)    errors.push(`profile[${index}] missing required field: id`);
  if (!raw.name)  errors.push(`profile[${index}] missing required field: name`);
  if (!raw.color) errors.push(`profile[${index}] missing required field: color`);

  // Warn on non-standard color format but allow it through so the plugin
  // still loads — invalid colors just render as transparent.
  if (raw.color && !/^#[0-9A-Fa-f]{6}$/.test(raw.color)) {
    console.warn(
      `[configLoader] profile "${raw.id ?? index}" color "${raw.color}" ` +
      `is not a valid 6-digit hex (e.g. #2255CC). It may not render correctly.`
    );
  }
  return errors;
}

/**
 * Coerce the content_filter_tags field to null or string[].
 * Accepts: null/undefined → null, string → [string], string[] → string[].
 * Anything else → warns and returns null.
 */
function coerceFilterTags(value, profileId) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map(String);
  console.warn(
    `[configLoader] profile "${profileId}" field "content_filter_tags" ` +
    `has an unexpected type (${typeof value}) — setting to null.`
  );
  return null;
}

// ---------------------------------------------------------------------------
// Internal: load
// ---------------------------------------------------------------------------

/** Parse, validate, and hydrate profiles.yaml. Updates module-level state in place. */
function load() {
  let raw;
  try {
    raw = yaml.load(readFileSync(resolvedConfigPath, 'utf8'));
  } catch (err) {
    console.error(`[configLoader] Could not read ${resolvedConfigPath}: ${err.message}`);
    return;
  }

  if (!raw || typeof raw !== 'object') {
    console.error('[configLoader] profiles.yaml is empty or not a YAML object.');
    return;
  }

  if (!Array.isArray(raw.profiles)) {
    console.error('[configLoader] profiles.yaml must contain a top-level "profiles" array.');
    return;
  }

  // --- Validate and hydrate each profile ---
  const loaded = [];
  for (let i = 0; i < raw.profiles.length; i++) {
    const p = raw.profiles[i];

    if (!p || typeof p !== 'object') {
      console.error(`[configLoader] profile[${i}] is not an object — skipping.`);
      continue;
    }

    const errors = validateProfile(p, i);
    if (errors.length) {
      errors.forEach(e => console.error(`[configLoader] ${e}`));
      continue; // skip profiles that fail required-field checks
    }

    // Start with defaults; then overlay only known keys from the user profile.
    const hydrated = { ...PROFILE_DEFAULTS };

    // Warn on unrecognised keys so typos surface early, and ignore them in the hydrated profile.
    for (const key of Object.keys(p)) {
      if (!KNOWN_PROFILE_KEYS.has(key)) {
        console.warn(`[configLoader] profile "${p.id}" has unknown field "${key}" — ignored.`);
        continue;
      }
      // Explicit null in YAML still wins over a default.
      hydrated[key] = p[key];
    }
    hydrated.content_filter_tags = coerceFilterTags(hydrated.content_filter_tags, hydrated.id);

    loaded.push(hydrated);
  }

  // --- Hydrate settings ---
  const rawSettings = (raw.settings && typeof raw.settings === 'object') ? raw.settings : {};
  const mergedSettings = { ...SETTINGS_DEFAULTS, ...rawSettings };

  // Fall back to the first profile id if default_profile is omitted.
  if (!mergedSettings.default_profile && loaded.length > 0) {
    mergedSettings.default_profile = loaded[0].id;
    console.warn(
      `[configLoader] settings.default_profile not set — defaulting to "${mergedSettings.default_profile}".`
    );
  }

  // Warn if the referenced default profile id doesn't exist in the list.
  if (mergedSettings.default_profile && !loaded.find(p => p.id === mergedSettings.default_profile)) {
    console.warn(
      `[configLoader] settings.default_profile "${mergedSettings.default_profile}" ` +
      `does not match any profile id.`
    );
  }

  profiles = loaded;
  settings = mergedSettings;

  console.log(
    `[configLoader] Loaded ${profiles.length} profile(s): ` +
    `[${profiles.map(p => p.id).join(', ')}] — default: "${settings.default_profile}"`
  );
}

// ---------------------------------------------------------------------------
// Internal: file watcher
// ---------------------------------------------------------------------------

async function startWatcher() {
  const createNewWatcher = () => {
    watcher = chokidar.watch(resolvedConfigPath, { ignoreInitial: true });
    watcher.on('change', () => {
      console.log('[configLoader] profiles.yaml changed — reloading...');
      load();
      // Notify all registered listeners with the fresh snapshot.
      for (const cb of updateCallbacks) {
        try {
          cb(getProfiles(), getSettings());
        } catch (err) {
          console.error('[configLoader] onUpdate callback threw:', err);
        }
      }
    });
    watcher.on('error', err => console.error('[configLoader] File watcher error:', err));
  };

  // Close any existing watcher first (handles re-init with a different path).
  if (watcher) {
    const oldWatcher = watcher;
    watcher = null;
    // Ensure the new watcher is started only after the old one has fully closed.
    await Promise
      .resolve(oldWatcher.close())
      .then(() => {
        createNewWatcher();
      })
      .catch(err => {
        console.error('[configLoader] Error closing previous file watcher:', err);
        // Attempt to start a fresh watcher even if close failed.
        createNewWatcher();
      });
  } else {
    createNewWatcher();
  }

  // Shared reload-and-notify handler used for both 'change' and 'add' events.
  // Subscribing to 'add' is necessary for two scenarios:
  //   1. First-run creation: profiles.yaml is created after the plugin starts.
  //   2. Atomic saves: some editors (e.g. vim, many IDEs) write a temp file and
  //      rename it into place, which chokidar reports as 'unlink' + 'add' rather
  //      than 'change'.
  function reloadAndNotify(event) {
    console.log(`[configLoader] profiles.yaml ${event} — reloading...`);
    load();
    // Notify all registered listeners with the fresh snapshot.
    for (const cb of updateCallbacks) {
      try {
        cb(getProfiles(), getSettings());
      } catch (err) {
        console.error('[configLoader] onUpdate callback threw:', err);
      }
    }
  }

  // Watch the parent directory so that chokidar can detect 'add' when the file
  // is created for the first time (or re-created after an atomic rename), then
  // filter events down to just the config file by comparing the resolved path.
  const configDir = dirname(resolvedConfigPath);
  watcher = chokidar.watch(configDir, { ignoreInitial: true });
  watcher.on('add',    p => { if (p === resolvedConfigPath) reloadAndNotify('added'); });
  watcher.on('change', p => { if (p === resolvedConfigPath) reloadAndNotify('changed'); });
  watcher.on('unlink', p => {
    if (p === resolvedConfigPath) {
      console.log('[configLoader] profiles.yaml removed — watching for recreation.');
    }
  });
  watcher.on('error',  err => console.error('[configLoader] File watcher error:', err));

  // Wait until chokidar has finished its initial scan so that callers (and
  // tests) can be sure the watcher is active before making any filesystem changes.
  await new Promise(resolve => watcher.once('ready', resolve));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the config loader. Must be called once before using any getter.
 * Safe to call again (e.g. in tests) — resets all state and restarts the watcher.
 *
 * @param {string} [configPath] - Path to profiles.yaml. Defaults to config/profiles.yaml
 *   relative to this file. Pass a custom path in tests to avoid touching the real config.
 * @returns {Promise<void>}
 */
export async function init(configPath = DEFAULT_CONFIG_PATH) {
  resolvedConfigPath = configPath;
  profiles = [];
  settings = { ...SETTINGS_DEFAULTS };
  // Clear callbacks so re-init in tests starts clean.
  // In production code, register callbacks after calling init().
  updateCallbacks.length = 0;
  load();
  await startWatcher();
}

/**
 * Stop the file watcher. Call on plugin teardown or at the end of each test.
 * Safe to call when no watcher is active.
 *
 * @returns {Promise<void>}
 */
export async function close() {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}

/**
 * Returns a shallow copy of all valid, fully-defaulted profiles in config order.
 * Returns an empty array if init() has not been called or config failed to load.
 */
export function getProfiles() {
  return [...profiles];
}

/**
 * Returns the profile with the given id, or null if not found.
 * @param {string} id
 */
export function getProfileById(id) {
  return profiles.find(p => p.id === id) ?? null;
}

/**
 * Returns a shallow copy of the top-level settings block.
 * Always returns an object — never null.
 */
export function getSettings() {
  return { ...settings };
}

/**
 * Register a callback to be invoked whenever profiles.yaml is saved.
 * The callback receives (profiles: Profile[], settings: Settings).
 * Note: callbacks are cleared on init() — register after calling init().
 *
 * @param {(profiles: object[], settings: object) => void} callback
 */
export function onUpdate(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('[configLoader] onUpdate expects a function');
  }
  updateCallbacks.push(callback);
}
