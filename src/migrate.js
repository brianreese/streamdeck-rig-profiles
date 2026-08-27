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
  };
}

export function convertConfig(parsed) {
  const profiles = (parsed?.profiles ?? []).filter((p) => p?.id).map(convertProfile);
  return {
    profiles,
    settings: {
      defaultProfile: parsed?.settings?.default_profile ?? profiles[0]?.id ?? null,
      goveeApiKey: parsed?.settings?.govee_api_key ?? '',
      goveeDevices: parsed?.settings?.govee_devices ?? null,
    },
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
} = {}) {
  const existing = await settings.getGlobalSettings();

  if (!existsSync(configPath)) {
    return { migrated: false, count: 0, reason: 'no legacy config' };
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

  await settings.setGlobalSettings({ ...converted, importedFrom: hash });

  const needSetup = converted.profiles.filter((p) => p.needsWheelbaseSetup).map((p) => p.name);
  log(`[migrate] imported ${converted.profiles.length} profile(s) from profiles.yaml`);
  if (needSetup.length) {
    log(`[migrate] pick a wheelbase setup slot for: ${needSetup.join(', ')}`);
  }

  return { migrated: true, count: converted.profiles.length };
}
