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

import { init as initGovee, activateScene, getSceneNames } from '../govee.js';
import { STATUS } from './status.js';

/** Scene catalog, cached per process. Discovery is slow (2-5s per device). */
let sceneNames = null;

/** Result of the last activateScene, so verify() can report what was sent. */
let lastOutcome = null;

async function ensureCatalog(apiKey) {
  if (sceneNames?.length || !apiKey) return sceneNames;
  // init() loads from the on-disk cache when present, so this is usually cheap.
  await initGovee(apiKey);
  sceneNames = getSceneNames();
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

    const outcome = await activateScene(apiKey, scene, ctx.settings?.goveeDevices ?? null);
    lastOutcome = outcome ?? null;

    // A scene that reached no device is a failure, even though every individual
    // call "succeeded" by not throwing. Without this the lights simply do not
    // change and the key still goes amber as though something happened.
    if (outcome && outcome.sent === 0) {
      const why = outcome.failed.length
        ? outcome.failed.join('; ')
        : `no device in the allowlist has a scene named "${scene}"`;
      throw new Error(`scene "${scene}" reached no device — ${why}`);
    }
  },

  async verify(cfg) {
    // The Govee REST API confirms it accepted the request, not that the lamps
    // changed. Claiming VERIFIED here would be exactly the lie the status
    // vocabulary exists to prevent, so this reports what was actually sent.
    const sent = lastOutcome?.sent;
    const detail =
      sent === undefined
        ? `sent scene "${cfg?.scene}" — Govee does not report lamp state back`
        : `scene "${cfg?.scene}" accepted by ${sent} of ${lastOutcome.targets} device(s)` +
          (lastOutcome.skipped ? `, ${lastOutcome.skipped} lack that scene` : '') +
          (lastOutcome.failed.length ? `; errors: ${lastOutcome.failed.join('; ')}` : '');

    return { status: STATUS.APPLIED_UNVERIFIED, detail };
  },
};

export function _resetForTesting() {
  sceneNames = null;
  lastOutcome = null;
}
