// providers/govee.js — room lighting per profile.
//
// Wraps the existing Govee client (src/govee.js): discovery, the merged
// dynamic + DIY scene catalog, and the on-disk cache all already exist. This
// file only adapts them to the provider contract.
//
// Scene names are matched exactly against the Govee app, which is the classic
// silent-failure surface — a typo just does nothing. So the property inspector
// offers the catalog as a dropdown, and a profile can fall back to its own
// colour when no scene is chosen. Colour always works and cannot be mistyped.

import { init as initGovee, activateScene, getDiscoveredDevices } from '../govee.js';
import { STATUS } from './status.js';

/** Scene catalog, cached per process. Discovery is slow (2-5s per device). */
let sceneNames = null;

async function ensureCatalog(apiKey) {
  if (sceneNames || !apiKey) return sceneNames;
  await initGovee(apiKey);
  const devices = getDiscoveredDevices() ?? [];
  const names = new Set();
  for (const d of devices) for (const s of d.scenes ?? []) names.add(s);
  sceneNames = [...names].sort();
  return sceneNames;
}

export default {
  id: 'govee',
  label: 'Govee Lighting',
  verifiable: false, // the REST API acknowledges the call, not the light state

  schema() {
    return [
      {
        key: 'scene',
        label: 'Scene',
        type: 'select',
        options: (sceneNames ?? []).map((n) => ({ value: n, label: n })),
        allowEmpty: true,
        help: 'Leave empty to use the profile colour instead.',
      },
    ];
  },

  validate(cfg) {
    return cfg?.scene ? [] : ['govee is enabled but no scene is selected'];
  },

  describe(cfg) {
    return cfg?.scene ? `scene "${cfg.scene}"` : 'profile colour';
  },

  async options({ settings } = {}) {
    const apiKey = settings?.goveeApiKey;
    if (!apiKey) return [];
    try {
      const names = await ensureCatalog(apiKey);
      return (names ?? []).map((n) => ({ value: n, label: n }));
    } catch {
      return [];
    }
  },

  async apply(cfg, ctx = {}) {
    const apiKey = ctx.settings?.goveeApiKey;
    if (!apiKey) throw new Error('no Govee API key set');

    await initGovee(apiKey);
    const scene = cfg?.scene;
    if (!scene) {
      // No scene chosen: nothing to activate. The profile colour fallback is a
      // separate capability and is deliberately not faked here.
      throw new Error('no scene selected');
    }
    await activateScene(apiKey, scene, ctx.settings?.goveeDevices ?? null);
  },

  async verify(cfg) {
    // The Govee REST API confirms it accepted the request, not that the lamps
    // changed. Claiming VERIFIED here would be exactly the lie the status
    // vocabulary exists to prevent, so this provider declares verifiable:false
    // and reports the honest outcome instead.
    return {
      status: STATUS.APPLIED_UNVERIFIED,
      detail: `sent scene "${cfg?.scene}" — Govee does not report lamp state back`,
    };
  },
};

export function _resetForTesting() {
  sceneNames = null;
}
