// providers/mozaPedals.js — MOZA pedal preset switching (mBooster).
//
// Presets are authored in Pit House and read straight off disk, so the property
// inspector offers them by their real names ("Carter Brake", "Brian Brake
// Hybrid") exactly as the Fanatec provider offers setup slots.
//
// Applying a preset is not a single command the way a Fanatec setup slot is.
// MOZA stores presets on the PC as ~90 loose device parameters, so applying one
// means replaying all of them through MOZA's SDK. That step lives behind
// moza/applier.js and is not finished yet; everything up to it is.
//
// Verification is best-effort by design. Pit House records the loaded preset in
// Presets\config.ini under [LastUsedPreset], which gives a real signal when it
// updates — but a pedal that is too stiff is not the hazard an unexpectedly
// strong wheel is, so falling back to applied-unverified is acceptable here in
// a way it would not be for the wheelbase.

import { listPresets, readPreset, readSelection, resolvePitHouseDir } from '../moza/presetStore.js';
import { applyParams, backendStatus, PARAM_DELAY_MS } from '../moza/applier.js';
import { STATUS } from './status.js';

/** The pedal this provider targets. MOZA also spells it "MBoost". */
export const DEVICE = 'mBooster';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function presetOptions(deps = {}) {
  return listPresets({ deviceType: 'Pedals', device: DEVICE, ...deps }).map((p) => ({
    value: p.id,
    // Mark your own presets so they are not lost among ~25 factory ones.
    label: p.isOfficial ? p.name : `${p.name} ★`,
  }));
}

export default {
  id: 'moza-pedals',
  label: 'MOZA Pedals',
  // Attempts verification via config.ini, but reports applied-unverified rather
  // than claiming success when Pit House gives us nothing to read back.
  verifiable: true,

  schema() {
    return [
      {
        key: 'presetId',
        label: 'Preset',
        type: 'select',
        options: presetOptions(),
        help: 'Presets are authored in MOZA Pit House. ★ marks your own.',
      },
    ];
  },

  validate(cfg) {
    return cfg?.presetId ? [] : ['MOZA pedals is enabled but no preset is selected'];
  },

  describe(cfg) {
    if (!cfg?.presetId) return 'pedals (not configured)';
    const preset = readPreset(cfg.presetId);
    return preset?.name ? `pedal preset "${preset.name}"` : `pedal preset ${cfg.presetId}`;
  },

  async options(deps = {}) {
    return presetOptions(deps);
  },

  async apply(cfg, ctx = {}) {
    if (!cfg?.presetId) throw new Error('no preset selected');

    const preset = readPreset(cfg.presetId, ctx);
    if (!preset) {
      throw new Error(
        `preset ${cfg.presetId} is no longer in the Pit House library — it may have been renamed or deleted`,
      );
    }

    const params = preset.deviceParams ?? {};
    const entries = Object.entries(params);
    if (!entries.length) throw new Error(`preset "${preset.name}" has no device parameters`);

    // Fails loudly while the SDK bindings are outstanding, rather than
    // reporting success for a preset that was never sent.
    await applyParams(params, ctx);

    // Pacing matches the community plugin's, which found back-to-back writes
    // unreliable.
    for (let i = 1; i < entries.length; i++) await sleep(PARAM_DELAY_MS);
  },

  async verify(cfg, ctx = {}) {
    const preset = readPreset(cfg?.presetId, ctx);
    const name = preset?.name ?? cfg?.presetId;

    const { lastUsed } = readSelection(ctx);
    if (Object.values(lastUsed).includes(cfg?.presetId)) {
      return { status: STATUS.VERIFIED, detail: `Pit House reports "${name}" loaded` };
    }

    return {
      status: STATUS.APPLIED_UNVERIFIED,
      detail: `sent "${name}"; Pit House has not recorded it as loaded`,
    };
  },

  /** Surfaced by the inspector so the setup gap is visible, not mysterious. */
  health() {
    const dir = resolvePitHouseDir();
    if (!dir) {
      return { ok: false, reason: 'MOZA Pit House preset library not found' };
    }
    const backend = backendStatus();
    return backend.available
      ? { ok: true, reason: `ready (${listPresets({ deviceType: 'Pedals', device: DEVICE }).length} presets)` }
      : { ok: false, reason: backend.reason };
  },
};
