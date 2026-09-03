// migrate.js — one-time import of the legacy profiles.yaml into global settings.
//
// The old schema was flat, with one key per piece of hardware. The new schema
// nests hardware under a `providers` map so that adding hardware later touches
// exactly one provider file and no shared code.
//
//   old                      new
//   ------------------------ ------------------------------------
//   govee_scene              providers.govee.scene
//   sd_profile               providers.streamdeck.profile
//   moza_profile             providers['moza-pedals'].profile
//   fanatec_preset_hotkey    (no equivalent — see below)
//
// `fanatec_preset_hotkey` is deliberately NOT migrated. It was a FanaLab
// keyboard shortcut, and the wheelbase is now driven by setup slot number over
// MQTT. There is no way to derive "slot 2" from "ctrl+alt+f2" — the mapping
// lived inside FanaLab, which is not even installed on this rig any more. The
// migration flags these profiles so the property inspector can prompt for the
// slot rather than silently leaving the wheelbase unconfigured.

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import streamDeck from '@elgato/streamdeck';
import { saveGlobalSettings } from './settingsStore.js';
import { hasBeenConfigured } from './settingsBackup.js';
import { allSettingsFields } from './providers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_CONFIG = resolve(__dirname, '..', 'config', 'profiles.yaml');

/** Convert one legacy profile record into the provider-based shape. */
export function convertProfile(old) {
  // Preferred form: a providers map written verbatim, so a provider added
  // later round-trips through YAML without this function knowing about it.
  const providers = { ...(old.providers ?? {}) };

  // The current shorthand for a wheelbase: a setup slot number.
  const setup = Number(old.fanatec_setup);
  if (Number.isInteger(setup) && setup >= 1 && setup <= 5) {
    providers['fanatec-base'] = { setup };
  }

  if (old.govee_scene) providers.govee = { scene: old.govee_scene };
  if (old.sd_profile) providers.streamdeck = { profile: old.sd_profile };
  if (old.moza_profile) providers['moza-pedals'] = { profile: old.moza_profile };

  return {
    id: old.id,
    name: old.name ?? old.id,
    color: old.color ?? '#2255CC',
    avatar: old.avatar ?? null,
    restricted: Boolean(old.restricted),
    providers,
    // Surfaced in the PI so the user knows a wheelbase slot still needs picking:
    // a legacy FanaLab hotkey with no replacement slot leaves the wheel unset.
    needsWheelbaseSetup: Boolean(old.fanatec_preset_hotkey) && !providers['fanatec-base'],
    // Scene references survive a round trip through YAML; without this a
    // re-import silently unhooks every scene a profile ran.
    ...(Array.isArray(old.scenes) ? { scenes: old.scenes } : {}),
  };
}

export function convertConfig(parsed) {
  const profiles = (parsed?.profiles ?? []).filter((p) => p?.id).map(convertProfile);

  // Only keys the YAML actually specifies. A file with no govee_api_key must
  // not be read as "set the key to empty" — see mergeSettings below.
  const settings = {};
  if (parsed?.settings?.default_profile ?? profiles[0]?.id) {
    settings.defaultProfile = parsed?.settings?.default_profile ?? profiles[0]?.id;
  }
  if (parsed?.settings?.govee_api_key) settings.goveeApiKey = parsed.settings.govee_api_key;
  // Legacy spelling, still honoured so an old file keeps importing.
  if (parsed?.settings?.govee_devices) settings.goveeDevices = parsed.settings.govee_devices;

  // Declared installation-wide settings, read back under the key they were
  // exported with. Generic so that a provider added later round-trips through
  // YAML without this function learning its name — the same reason the
  // providers map is copied verbatim rather than translated.
  for (const field of allSettingsFields()) {
    if (field.type === 'secret') continue; // never imported from a document
    const value = parsed?.settings?.[field.key];
    if (value !== undefined && value !== null) settings[field.key] = value;
  }

  return {
    profiles,
    settings,
    ...(Array.isArray(parsed?.scenes) ? { scenes: parsed.scenes } : {}),
  };
}

/**
 * Import profiles.yaml into global settings.
 *
 * Imports on first run, and again whenever the YAML's contents change — the
 * stored hash of the last import is the trigger. Editing the file is an
 * explicit act, so honouring it is not surprising; leaving it alone means the
 * property inspector stays the source of truth and is never clobbered.
 *
 * @param {object} [deps] injected for tests
 * @returns {Promise<{ migrated: boolean, count: number, reason?: string }>}
 */
export async function migrateIfNeeded({
  configPath = LEGACY_CONFIG,
  settings = streamDeck.settings,
  log = (m) => streamDeck.logger.info(m),
  configured = hasBeenConfigured,
} = {}) {
  const existing = await settings.getGlobalSettings();

  if (!existsSync(configPath)) {
    return { migrated: false, count: 0, reason: 'no legacy config' };
  }

  // An empty store is NOT proof of a first run.
  //
  // This is what caused the 2026-09-02 data loss. Stream Deck was force-killed,
  // never flushed its in-memory global settings, and came back with nothing.
  // Six seconds later this function read that emptiness as a fresh install and
  // imported the two example profiles over the top of four real ones. A crash, a
  // forced restart and a botched upgrade all look exactly like a new install
  // from in here, and the response to all three was destructive.
  //
  // The marker deliberately lives on disk, outside the thing that gets lost.
  if (!existing?.profiles?.length && configured()) {
    log('[migrate] REFUSING to import: global settings are empty, but this plugin has been configured before on this machine. This is data loss, not a first run. See settingsBackup.js.');
    return { migrated: false, count: 0, reason: 'empty store, previously configured' };
  }

  const source = readFileSync(configPath, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);

  if (existing?.profiles?.length && existing.importedFrom === hash) {
    return { migrated: false, count: existing.profiles.length, reason: 'already configured' };
  }

  const parsed = yaml.load(source);
  const converted = convertConfig(parsed);
  if (!converted.profiles.length) {
    return { migrated: false, count: 0, reason: 'legacy config had no profiles' };
  }

  // Import the profiles; keep everything else that lives in global settings.
  //
  // This used to write `{ ...converted, importedFrom }`, replacing the whole
  // object. Anything the YAML does not describe was destroyed by an import:
  // every scene, every profile's scene references, and — because convertConfig
  // filled in `goveeApiKey: ''` when the file had none — the Govee API key and
  // the hardware toggles alongside it. Editing profiles.yaml is meant to
  // reimport profiles, not to factory-reset the plugin.
  await saveGlobalSettings(settings, {
    ...existing,
    ...converted,
    settings: { ...(existing?.settings ?? {}), ...converted.settings },
    // A YAML without a scenes list leaves the stored ones alone.
    scenes: converted.scenes ?? existing?.scenes ?? [],
    importedFrom: hash,
  }, { log });

  const needSetup = converted.profiles.filter((p) => p.needsWheelbaseSetup).map((p) => p.name);
  log(`[migrate] imported ${converted.profiles.length} profile(s) from profiles.yaml`);
  if (needSetup.length) {
    log(`[migrate] pick a wheelbase setup slot for: ${needSetup.join(', ')}`);
  }

  return { migrated: true, count: converted.profiles.length };
}
