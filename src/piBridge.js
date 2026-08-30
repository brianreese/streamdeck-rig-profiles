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
//
// Deliberately transport agnostic: the browser editor (editorServer.js) posts
// exactly these requests over HTTP, so a feature reaching one surface reaches
// both and neither can drift into its own validation rules.

import yaml from 'js-yaml';
import { getProvider, allProviders, reportsState, STATUS } from './providers/index.js';
import { saveAvatar, loadAvatarDataUri, deleteAvatar } from './avatars.js';
// buttonRenderer's half of the rename has landed.
// when that file lands its half of this rename. buttonRenderer.js is not mine to
// line that changes when the new name appears.
import { renderProfileKey, renderModeKey } from './buttonRenderer.js';
import { _resetForTesting as resetGoveeCatalog } from './providers/govee.js';

/**
 * Every stored Mode, whatever key it was written under.
 *
 * `settings.scenes` is what this was called before Scenes and Modes merged.
 * Nothing is shipped beyond this machine, so there is no migration to run and
 * none is written here — this is a tolerant read and nothing more. Anything
 * that writes goes back under `modes`, so a config heals itself the first time
 * it is saved.
 */
const storedModes = (globals) => globals?.modes ?? globals?.scenes ?? [];

/** Turn a stored profile list into the legacy-shaped YAML we can re-import. */
export function profilesToYaml(globals) {
  const profiles = (globals?.profiles ?? []).map((p) => {
    const out = { id: p.id, name: p.name, color: p.color };
    if (p.restricted) out.restricted = true;
    if (p.avatar) out.avatar = p.avatar;
    // Dump the providers map verbatim rather than translating known keys:
    // a provider added later must round-trip without touching this function.
    if (Object.keys(p.providers ?? {}).length) out.providers = p.providers;
    // The Modes this profile also activates, by id. Emitted after providers
    // because that is the order they apply in: the profile's own hardware
    // first, the referenced Modes filling in what it did not set.
    if (p.modes?.length) out.modes = p.modes;
    return out;
  });

  // Modes are exported so a committed YAML is a complete picture. A profile
  // referencing a Mode the file does not contain is a profile that does less
  // than it says, and leaving them out would make that the normal case.
  const modes = storedModes(globals).map((s) => {
    const out = { id: s.id, name: s.name, color: s.color };
    if (Object.keys(s.providers ?? {}).length) out.providers = s.providers;
    return out;
  });

  return yaml.dump({
    profiles,
    ...(modes.length ? { modes } : {}),
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
 * The rules a profile and a Mode share, which is everything structural.
 *
 * Both are `{ id, name, color, providers }`, so both need an id that can be a
 * config key, a name a human can find it by, a colour the renderer will not
 * choke on, and provider config each provider agrees to. The differences
 * between the two are semantic and live in the callers below.
 *
 * @param {object[]} records
 * @param {string} noun         what to call one of these in an error
 * @returns {string[]} errors, each prefixed `<name or id>: `
 */
function validateRecords(records, noun) {
  const errors = [];
  const seen = new Set();

  for (const [i, p] of records.entries()) {
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
      // Each provider owns its own rules; the core knows none of them, and a
      // Mode's provider config is judged by exactly the same rules as a
      // profile's — a Govee block with no scene selected is broken either way.
      for (const problem of provider.validate?.(cfg) ?? []) {
        errors.push(`${where}: ${problem}`);
      }
    }
  }
  return errors;
}

/**
 * Validate a profile list coming from the editor.
 * Returns { ok, errors } — the caller refuses to save when not ok, because a
 * malformed profile means a key that silently does nothing.
 *
 * @param {object[]} profiles
 * @param {object} [opts]
 * @param {string[]} [opts.modeIds]  ids that exist in the Mode list. When
 *   given, a profile naming a Mode outside it is an error. Omitted means "do
 *   not check", which keeps a caller that only has profiles to hand honest
 *   rather than making it invent an empty Mode list and reject every
 *   reference.
 */
export function validateProfiles(profiles, { modeIds } = {}) {
  if (!Array.isArray(profiles)) return { ok: false, errors: ['profiles must be a list'] };

  const errors = validateRecords(profiles, 'profile');

  // A dangling reference is not cosmetic: the profile claims to activate a Mode
  // and the runtime skips it with a log line nobody reads, so the lights
  // quietly do not come on. Refusing the save is what stops that shipping. The
  // editor detaches references when a Mode is deleted, so reaching this
  // normally means a hand-edited config.
  if (Array.isArray(modeIds)) {
    const known = new Set(modeIds);
    for (const [i, p] of profiles.entries()) {
      const where = p?.name || p?.id || `#${i + 1}`;
      for (const ref of p?.modes ?? []) {
        if (!known.has(ref)) errors.push(`${where}: references a mode that does not exist ("${ref}")`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a Mode list coming from the editor.
 *
 * Structurally identical to a profile, with one rule of its own: a Mode must
 * not carry `restricted`. The hold gate exists so a child cannot press a key
 * and be handed full force feedback; a Mode cannot hand them anything, because
 * it never writes the shared active-profile state that decides what they are
 * allowed to launch. That is true of every Mode, including one that reports
 * itself active: a Mode's on/off is a fact about the Mode, not a claim about
 * who is sitting at the rig. A `restricted` Mode would therefore be a gate in
 * front of nothing, and — worse — would read to the next person as though a
 * Mode carried the authority a profile does.
 */
export function validateModes(modes) {
  if (!Array.isArray(modes)) return { ok: false, errors: ['modes must be a list'] };

  const errors = validateRecords(modes, 'mode');

  for (const [i, s] of modes.entries()) {
    const where = s?.name || s?.id || `#${i + 1}`;
    if (s?.restricted) {
      errors.push(`${where}: a mode has nothing to gate, so it cannot be "hold to switch"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Handle one property-inspector request.
 *
 * @param {object} msg   { request, ...args }
 * @param {object} deps  { settings, logger, onChanged }
 * @returns {Promise<object>} reply payload
 */
export async function handlePiRequest(msg, { settings, logger = console, onChanged } = {}) {
  const { request } = msg ?? {};

  switch (request) {
    // The browser editor has no Stream Deck socket of its own, so this is the
    // only way it can see the profile list. The inspector gets the same data
    // from didReceiveGlobalSettings and never needs to ask.
    case 'getProfiles': {
      const current = await settings.getGlobalSettings();
      return {
        request,
        profiles: current?.profiles ?? [],
        // Sent alongside rather than behind a request of its own: the editor
        // cannot draw a profile's Mode references without the Mode list, so
        // fetching them separately would only add a state where the page has
        // half its draft.
        modes: storedModes(current),
        settings: {
          ...current?.settings,
          // Same rule as getSettings: the key is never echoed to a page.
          goveeApiKey: undefined,
          goveeApiKeySet: Boolean(current?.settings?.goveeApiKey),
        },
      };
    }

    case 'getProviders': {
      const settingsBlob = (await settings.getGlobalSettings())?.settings ?? {};
      // Schema plus live options in one round-trip: the editor cannot render a
      // provider's fields until it knows what they are, and asking per provider
      // would stall the panel opening.
      const providers = await Promise.all(
        allProviders().map(async (p) => {
          const fields = p.schema?.() ?? [];
          for (const f of fields) {
            if (f.type !== 'select') continue;
            // Whether this list can be trusted to be the whole domain.
            //
            // It decides what the editor says about a stored value it cannot
            // find: a value missing from a list we just read out of the
            // hardware is genuinely gone, and a value missing from a list that
            // never arrived proves nothing at all. A provider with no options()
            // is authoritative by declaration — its schema IS the domain.
            f.optionsLive = !p.options;
            if (!p.options) continue;
            try {
              const live = await p.options({ settings: settingsBlob });
              if (live?.length) {
                f.options = live;
                f.optionsLive = true;
              }
            } catch (err) {
              logger.warn?.(`[pi] options for ${p.id}.${f.key} failed: ${err.message}`);
            }
          }
          return {
            id: p.id,
            label: p.label,
            verifiable: p.verifiable,
            // Which lists this provider may be offered on. A wheelbase belongs
            // to a profile — a Mode must not be able to hand anyone force
            // feedback — while lights and scripts make sense on both. The
            // editor filters its add list on this, so a provider that never
            // declared it is offered on profiles only: profiles are the default
            // surface, and a Mode reaching hardware it was never meant to is
            // the failure worth defaulting away from.
            contexts: Array.isArray(p.contexts) && p.contexts.length ? [...p.contexts] : ['profile'],
            // Whether this provider can answer "am I currently in effect?".
            //
            // Asked of the registry rather than derived here, so the editor and
            // the runtime agree by construction about which providers count.
            // It is derived from the method either way — a boolean a provider
            // could set without implementing isActive() would be a promise
            // nothing keeps.
            //
            // This is the whole basis of a Mode's active/inactive state: the
            // Mode does not decide whether it is stateful, the providers inside
            // it do, and a Mode holding none of these behaves exactly as a
            // fire-and-forget one always has.
            //
            // Independent of `contexts`. A provider may be perfectly usable in
            // a Mode and still have no honest answer — Govee's API
            // acknowledges a request, it does not read the lamp — so declaring
            // 'mode' is not a promise to answer this question.
            reportsState: reportsState(p),
            fields,
          };
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

    // Profiles and Modes save together, in one request, deliberately.
    //
    // They are not independent: a profile references Modes by id, so writing
    // the two halves separately opens a window where a saved profile names a
    // Mode that has not been stored yet. One request means one validation of
    // the pair and one write, and a rejected save leaves BOTH lists exactly as
    // they were — which is what lets the editor autosave at all.
    //
    // `modes` is optional. A caller that only knows about profiles (the
    // property inspector, an older page held in a stale tab) omits it and the
    // stored Modes are carried through untouched rather than erased.
    case 'saveProfiles': {
      const current = await settings.getGlobalSettings();
      const modes = msg.modes ?? storedModes(current);

      if (msg.modes) {
        const modeCheck = validateModes(msg.modes);
        if (!modeCheck.ok) return { request, ok: false, errors: [], modeErrors: modeCheck.errors };
      }

      const { ok, errors } = validateProfiles(msg.profiles, { modeIds: modes.map((s) => s.id) });
      if (!ok) return { request, ok: false, errors, modeErrors: [] };

      await settings.setGlobalSettings({
        ...current,
        profiles: msg.profiles,
        modes,
        // The key these used to live under. Cleared rather than left beside the
        // new one, so a stored blob never carries two answers to the same
        // question — `storedModes` reads either, and everything writes `modes`.
        scenes: undefined,
        settings: { ...current?.settings, ...msg.settings },
        // Keep the import marker exactly as it was. It records which YAML we
        // last imported, so an untouched profiles.yaml still matches and these
        // edits survive the next start; genuinely editing the YAML changes the
        // hash and lets the file win again. Clearing it here made every
        // restart look like a new file and silently re-imported over the top.
        importedFrom: current?.importedFrom ?? null,
      });
      return { request, ok: true, count: msg.profiles.length, modeCount: modes.length };
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

    // Live key preview for the browser editor: the same renderer the deck uses,
    // so a name that overflows or a colour that swallows the label shows up
    // while editing rather than after saving.
    case 'previewKey': {
      const draft = msg.profile ?? {};
      const profile = {
        name: String(draft.name ?? '').slice(0, 40),
        // The page is untrusted input, and the renderer drops an unrecognised
        // colour straight into the SVG. Filter it here, at the boundary.
        color: /^#[0-9a-f]{6}$/i.test(draft.color ?? '') ? draft.color : '#2255CC',
        // Resolved from the stored filename rather than sent by the page: the
        // bytes are already on this side, and a preview per keystroke should
        // not carry an image across the wire.
        avatarDataUri: loadAvatarDataUri(draft.avatar) ?? undefined,
      };
      return {
        request,
        off: renderProfileKey({ profile, active: false }),
        // Mid-switch is a state of its own now: the name gives way to dots.
        // Worth previewing, because it is the one the kids see most.
        busy: renderProfileKey({ profile, active: false, switching: true, dotFrame: 1 }),
        on: renderProfileKey({ profile, active: true, status: STATUS.VERIFIED }),
      };
    }

    // A Mode has neither of the profile's states — it never claims anyone is at
    // the rig — so it gets its own preview rather than borrowing a look that
    // would say something untrue.
    //
    // Editor-only, and only ever called from the browser editor.
    case 'previewModeKey': {
      const draft = msg.mode ?? {};
      const mode = {
        name: String(draft.name ?? '').slice(0, 40),
        // The page is untrusted input and the renderer drops an unrecognised
        // colour straight into the SVG, so it is filtered here at the boundary.
        color: /^#[0-9a-f]{6}$/i.test(draft.color ?? '') ? draft.color : '#2255CC',
        avatarDataUri: loadAvatarDataUri(draft.avatar) ?? undefined,
      };
      return {
        request,
        idle: renderModeKey({ mode }),
        running: renderModeKey({ mode, running: true, dotFrame: 1 }),
      };
    }

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

    // Hand the editor over to a real browser window. Imported lazily so a
    // session that never opens it never binds a socket, and started on demand
    // rather than at boot for the same reason.
    case 'openEditor': {
      try {
        const { startEditor, openInBrowser } = await import('./editorServer.js');
        const { url, alreadyRunning } = await startEditor({ settings, logger, onChanged });
        openInBrowser(url, { logger });
        // The URL comes back either way: if the browser refuses to launch, it
        // is the one thing that lets the user finish the job by hand.
        return { request, ok: true, url, alreadyRunning };
      } catch (err) {
        logger.error?.(`[pi] openEditor failed: ${err.stack ?? err.message}`);
        return { request, ok: false, error: err.message };
      }
    }

    case 'exportYaml':
      return { request, yaml: profilesToYaml(await settings.getGlobalSettings()) };

    default:
      return { request, error: `unknown request "${request}"` };
  }
}
