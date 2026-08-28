// providers/govee.js — room lighting per profile.
//
// Wraps the existing Govee client (src/govee.js): discovery, the merged
// dynamic + DIY scene catalog, and the on-disk cache all already exist. This
// file only adapts them to the provider contract.
//
// Scene names are matched exactly against the Govee app, which is the classic
// silent-failure surface — a typo just does nothing. So the editor offers the
// catalog as a dropdown rather than a text field.
//
// A scene is required. This file used to advertise a fall back to the profile's
// own colour when none was chosen, in the header, the field help and describe(),
// while validate() and apply() both refused an empty scene — so the editor
// offered the option and the save was then rejected. The fallback was never
// implemented; a profile that should leave the lights alone turns Govee off.

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
  // Govee confirms delivery, not illumination — see verify() for the bar it
  // holds itself to.
  verifiable: true,
  // Lighting belongs in both. It is the obvious thing to want as a scene, and
  // just as reasonable as part of a profile.
  contexts: ['profile', 'scene'],

  schema() {
    return [
      {
        key: 'scene',
        label: 'Scene',
        type: 'select',
        options: (sceneNames ?? []).map((n) => ({ value: n, label: n })),
        // No allowEmpty: apply() has nothing to do without a scene and says so.
        // The field previously offered an empty option and promised a fall back
        // to the profile colour, which is not implemented — the editor let it
        // be chosen and the save was then refused. Turn Govee off for a profile
        // that should not touch the lights.
        // Shown on profiles and on scenes alike, so it must not say either.
        help: 'Which Govee scene to activate.',
      },
    ];
  },

  validate(cfg) {
    return cfg?.scene ? [] : ['govee is enabled but no scene is selected'];
  },

  describe(cfg) {
    return cfg?.scene ? `scene "${cfg.scene}"` : 'no scene selected';
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

  /**
   * Success here means the scene reached the lights, not that they changed.
   *
   * Nothing can confirm the second one — the REST API acknowledges the call
   * and no lamp reports its state back — so holding out for it meant Govee
   * could never succeed, which put a permanent caveat on every profile switch
   * and made the warning meaningless. Delivery is the bar this provider can
   * actually hold itself to, so it is the bar it declares, and the detail says
   * plainly what was confirmed.
   *
   * apply() already fails when a scene reaches nothing at all, so by the time
   * this runs the command has demonstrably gone somewhere.
   */
  async verify(cfg) {
    const sent = lastOutcome?.sent;
    if (sent === undefined) {
      return {
        status: STATUS.APPLIED_UNVERIFIED,
        detail: `sent scene "${cfg?.scene}" — no delivery report came back`,
      };
    }

    const detail =
      `scene "${cfg?.scene}" delivered to ${sent} of ${lastOutcome.targets} device(s)` +
      (lastOutcome.skipped ? `, ${lastOutcome.skipped} lack that scene` : '') +
      (lastOutcome.failed.length ? `; errors: ${lastOutcome.failed.join('; ')}` : '');

    return { status: sent > 0 ? STATUS.VERIFIED : STATUS.MISMATCH, detail };
  },
};

export function _resetForTesting() {
  sceneNames = null;
  lastOutcome = null;
}
