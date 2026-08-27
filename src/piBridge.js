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
import { _resetForTesting as resetGoveeCatalog } from './providers/govee.js';

/** Turn a stored profile list into the legacy-shaped YAML we can re-import. */
export function profilesToYaml(globals) {
  const profiles = (globals?.profiles ?? []).map((p) => {
    const out = { id: p.id, name: p.name, color: p.color };
    if (p.restricted) out.restricted = true;
    if (p.avatar) out.avatar = p.avatar;
    // Dump the providers map verbatim rather than translating known keys:
    // a provider added later must round-trip without touching this function.
    if (Object.keys(p.providers ?? {}).length) out.providers = p.providers;
    return out;
  });

  return yaml.dump({
    profiles,
    settings: {
      default_profile: globals?.settings?.defaultProfile ?? profiles[0]?.id ?? null,
      // The Govee API key is deliberately NOT exported. Export exists so this
      // can be committed to version control, and a credential in a repo is a
      // credential leaked. Enter it in the inspector on each machine instead.
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
      const provider = getProvider(providerId);
      if (!provider) continue; // unknown ids are tolerated: config outlives code
      // Each provider owns its own rules; the core knows none of them.
      for (const problem of provider.validate?.(cfg) ?? []) {
        errors.push(`${where}: ${problem}`);
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
    case 'getProviders': {
      const settingsBlob = (await settings.getGlobalSettings())?.settings ?? {};
      // Schema plus live options in one round-trip: the editor cannot render a
      // provider's fields until it knows what they are, and asking per provider
      // would stall the panel opening.
      const providers = await Promise.all(
        allProviders().map(async (p) => {
          const fields = p.schema?.() ?? [];
          for (const f of fields) {
            if (f.type !== 'select' || !p.options) continue;
            try {
              const live = await p.options({ settings: settingsBlob });
              if (live?.length) f.options = live;
            } catch (err) {
              logger.warn?.(`[pi] options for ${p.id}.${f.key} failed: ${err.message}`);
            }
          }
          return { id: p.id, label: p.label, verifiable: p.verifiable, fields };
        }),
      );
      return { request, providers };
    }

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
        // Keep the import marker exactly as it was. It records which YAML we
        // last imported, so an untouched profiles.yaml still matches and these
        // edits survive the next start; genuinely editing the YAML changes the
        // hash and lets the file win again. Clearing it here made every
        // restart look like a new file and silently re-imported over the top.
        importedFrom: current?.importedFrom ?? null,
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

    // Global settings (API keys and the like) live alongside profiles but are
    // saved separately, so entering a key does not require touching profiles.
    case 'getSettings': {
      const current = (await settings.getGlobalSettings())?.settings ?? {};
      return {
        request,
        settings: {
          ...current,
          // Never echo the key back to the page. The inspector only needs to
          // know whether one is set, not what it is.
          goveeApiKey: undefined,
          goveeApiKeySet: Boolean(current.goveeApiKey),
        },
      };
    }

    case 'saveSettings': {
      const current = await settings.getGlobalSettings();
      const next = { ...current?.settings, ...msg.settings };
      // An empty key field means "leave it alone", not "clear it" — otherwise
      // saving any other setting would wipe a key the page never displayed.
      if (!msg.settings?.goveeApiKey) next.goveeApiKey = current?.settings?.goveeApiKey ?? '';
      if (msg.clearGoveeKey) next.goveeApiKey = '';

      await settings.setGlobalSettings({ ...current, settings: next });
      return { request, ok: true, goveeApiKeySet: Boolean(next.goveeApiKey) };
    }

    case 'goveeDiscover': {
      const apiKey = (await settings.getGlobalSettings())?.settings?.goveeApiKey;
      if (!apiKey) return { request, ok: false, error: 'enter a Govee API key first' };
      try {
        const { init, getDiscoveredDevices, getSceneNames } = await import('./govee.js');
        await init(apiKey, { forceRefresh: true });
        resetGoveeCatalog();
        return {
          request,
          ok: true,
          devices: getDiscoveredDevices(),
          scenes: getSceneNames(),
        };
      } catch (err) {
        return { request, ok: false, error: err.message };
      }
    }

    case 'exportYaml':
      return { request, yaml: profilesToYaml(await settings.getGlobalSettings()) };

    default:
      return { request, error: `unknown request "${request}"` };
  }
}
