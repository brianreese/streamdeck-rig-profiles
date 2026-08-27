// piBridge.js — request/response handlers for messages from the property
// inspector.
//
// The property inspector is a sandboxed web page: it cannot touch the MQTT
// bus, the filesystem, or the hardware. Anything it needs to show — the live
// wheelbase slots, a saved avatar, the YAML export — it has to ask the plugin
// for. This module is that surface, kept separate from the action so it can be
// tested without a Stream Deck connection.
//
// Every handler returns a plain object; the caller sends it back to the PI
// under the same `request` name, so the page can await a matching reply.

import yaml from 'js-yaml';
import { getProvider, allProviders } from './providers/index.js';
import { saveAvatar, loadAvatarDataUri, deleteAvatar } from './avatars.js';

/** Turn a stored profile list into the legacy-shaped YAML we can re-import. */
export function profilesToYaml(globals) {
  const profiles = (globals?.profiles ?? []).map((p) => {
    const out = { id: p.id, name: p.name, color: p.color };
    if (p.restricted) out.restricted = true;
    const setup = p.providers?.['fanatec-base']?.setup;
    if (setup) out.fanatec_setup = setup;
    if (p.providers?.govee?.scene) out.govee_scene = p.providers.govee.scene;
    if (p.providers?.streamdeck?.profile) out.sd_profile = p.providers.streamdeck.profile;
    if (p.providers?.['moza-pedals']?.profile) out.moza_profile = p.providers['moza-pedals'].profile;
    return out;
  });

  return yaml.dump({
    profiles,
    settings: {
      default_profile: globals?.settings?.defaultProfile ?? profiles[0]?.id ?? null,
      govee_api_key: globals?.settings?.goveeApiKey ?? '',
      govee_devices: globals?.settings?.goveeDevices ?? null,
    },
  });
}

/**
 * Validate a profile list coming from the editor.
 * Returns { ok, errors } — the caller refuses to save when not ok, because a
 * malformed profile means a key that silently does nothing.
 */
export function validateProfiles(profiles) {
  const errors = [];
  if (!Array.isArray(profiles)) return { ok: false, errors: ['profiles must be a list'] };

  const seen = new Set();
  for (const [i, p] of profiles.entries()) {
    const where = p?.name || p?.id || `#${i + 1}`;
    if (!p?.id || !/^[a-z0-9_-]+$/i.test(p.id)) {
      errors.push(`${where}: id must be letters, numbers, dashes or underscores`);
    } else if (seen.has(p.id)) {
      errors.push(`${where}: duplicate id "${p.id}"`);
    } else {
      seen.add(p.id);
    }
    if (!p?.name?.trim()) errors.push(`${where}: needs a name`);
    if (!/^#[0-9a-f]{6}$/i.test(p?.color ?? '')) errors.push(`${where}: colour must be #rrggbb`);

    for (const [providerId, cfg] of Object.entries(p?.providers ?? {})) {
      if (!getProvider(providerId)) continue; // unknown ids are tolerated
      if (providerId === 'fanatec-base') {
        const slot = Number(cfg?.setup);
        if (!Number.isInteger(slot) || slot < 1 || slot > 5) {
          errors.push(`${where}: wheelbase setup must be 1-5`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Handle one property-inspector request.
 *
 * @param {object} msg   { request, ...args }
 * @param {object} deps  { settings, logger }
 * @returns {Promise<object>} reply payload
 */
export async function handlePiRequest(msg, { settings, logger = console } = {}) {
  const { request } = msg ?? {};

  switch (request) {
    case 'getProviders':
      return {
        request,
        providers: allProviders().map((p) => ({
          id: p.id,
          label: p.label,
          verifiable: p.verifiable,
        })),
      };

    // Live hardware enumeration — this is the whole reason the editor beats
    // hand-written YAML: you pick a wheelbase slot from what the base reports,
    // instead of typing a number and hoping.
    case 'getProviderOptions': {
      const provider = getProvider(msg.providerId);
      if (!provider?.options) return { request, providerId: msg.providerId, options: [] };
      try {
        return { request, providerId: msg.providerId, options: await provider.options({}) };
      } catch (err) {
        logger.warn?.(`[pi] options for ${msg.providerId} failed: ${err.message}`);
        return { request, providerId: msg.providerId, options: [], error: err.message };
      }
    }

    case 'saveProfiles': {
      const { ok, errors } = validateProfiles(msg.profiles);
      if (!ok) return { request, ok: false, errors };
      const current = await settings.getGlobalSettings();
      await settings.setGlobalSettings({
        ...current,
        profiles: msg.profiles,
        settings: { ...current?.settings, ...msg.settings },
        // Drop the import marker: once edited here, the editor owns the data
        // and an unchanged profiles.yaml must not overwrite it on next start.
        importedFrom: null,
      });
      return { request, ok: true, count: msg.profiles.length };
    }

    case 'uploadAvatar': {
      try {
        const { filename } = saveAvatar(msg.profileId, msg.base64, msg.filename);
        return { request, ok: true, profileId: msg.profileId, filename };
      } catch (err) {
        return { request, ok: false, profileId: msg.profileId, error: err.message };
      }
    }

    case 'getAvatar':
      return { request, profileId: msg.profileId, dataUri: loadAvatarDataUri(msg.filename) };

    case 'deleteAvatar':
      return { request, ok: deleteAvatar(msg.filename), profileId: msg.profileId };

    case 'exportYaml':
      return { request, yaml: profilesToYaml(await settings.getGlobalSettings()) };

    default:
      return { request, error: `unknown request "${request}"` };
  }
}
