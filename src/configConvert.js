// configConvert.js — turning a profiles.yaml document into stored shape.
//
// Split out of migrate.js because it is pure: text in, objects out, no Stream
// Deck connection and no filesystem. migrate.js imports the Stream Deck SDK for
// its default logger, and that SDK opens a rotating log file the moment it is
// imported — which made every module that wanted convertConfig drag a log
// rotation in behind it, and racing test workers then fought over renaming the
// same file. Restore needs this function and nothing else from migrate.

import { allSettingsFields } from './providers/index.js';

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
