// providers/fanatecBase.js — Fanatec wheelbase tuning setup slot.
//
// Selects between the setups already stored on the wheelbase (S1-S5). It
// deliberately does NOT write individual FFB values:
//
//   - The base holds the setups in its own flash, so they survive the plugin,
//     the Stream Deck app, and the PC misbehaving.
//   - One atomic message instead of a fifteen-field object means there is no
//     half-applied state to land in.
//   - The wheel rim's own tuning menu remains a manual fallback that reaches
//     the same setups, without this plugin in the loop.
//
// Verified end to end on a ClubSport DD+.

import { getBus, ACTIONS } from '../mqtt/fanatecBus.js';
import { STATUS } from './status.js';

export const SLOT_MIN = 1;
export const SLOT_MAX = 5;

/**
 * Pull the active tuning block out of a HW_UI_TuningsSettings_GET payload.
 * The base reports either a Standard or Advanced set depending on its mode.
 */
export function activeBlock(state) {
  if (!state) return null;
  const preferred = state.SimplifiedMode ? state.StandardTuningSettings : state.AdvancedTuningSettings;
  if (Array.isArray(preferred) && preferred.length) return preferred[0];
  for (const key of ['AdvancedTuningSettings', 'StandardTuningSettings']) {
    if (Array.isArray(state[key]) && state[key].length) return state[key][0];
  }
  return null;
}

/** Currently selected setup slot, or undefined if unreadable. */
export function currentSlot(state) {
  return activeBlock(state)?.UserIndex;
}

/** Short human summary of a slot's feel, for the PI dropdown. */
function slotLabel(slot, block) {
  if (!block) return `S${slot}`;
  const bits = [];
  if (block.FFB !== undefined) bits.push(`FFB ${block.FFB}`);
  if (block.FUL !== undefined) bits.push(`FUL ${block.FUL}`);
  if (block.FEI !== undefined) bits.push(`FEI ${block.FEI}`);
  return bits.length ? `S${slot} — ${bits.join(', ')}` : `S${slot}`;
}

function normaliseSlot(cfg) {
  const slot = Number(cfg?.setup);
  if (!Number.isInteger(slot) || slot < SLOT_MIN || slot > SLOT_MAX) return null;
  return slot;
}

export default {
  id: 'fanatec-base',
  label: 'Fanatec Wheelbase',
  verifiable: true,

  /**
   * Fields the property inspector should render for this provider.
   *
   * Declared here rather than hardcoded in the editor so that a profile which
   * has nothing to say about a wheelbase simply does not enable this provider,
   * and so adding hardware later needs no editor changes.
   */
  schema() {
    return [
      {
        key: 'setup',
        label: 'Setup slot',
        type: 'select',
        // Filled from the hardware via options(); these are the fallback.
        options: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: `S${v}` })),
        help: 'Dial the slots in via the Fanatec app first — this only selects between them.',
      },
    ];
  },

  validate(cfg) {
    return normaliseSlot(cfg) === null ? [`wheelbase setup must be ${SLOT_MIN}-${SLOT_MAX}`] : [];
  },

  describe(cfg) {
    const slot = normaliseSlot(cfg);
    return slot ? `wheelbase setup S${slot}` : 'wheelbase (not configured)';
  },

  /**
   * Enumerate the five slots for the property inspector.
   *
   * Only the currently-selected slot can be labelled with its real values —
   * the base reports one block at a time — so the others are listed plainly.
   * That is still enough to stop someone selecting a slot they have never set
   * up, because the current one shows what a configured slot looks like.
   */
  async options({ bus = getBus() } = {}) {
    const state = await bus.readState({ timeoutMs: 4000 }).catch(() => null);
    const active = currentSlot(state);
    const block = activeBlock(state);
    const opts = [];
    for (let slot = SLOT_MIN; slot <= SLOT_MAX; slot++) {
      opts.push({
        value: slot,
        label: slot === active ? `${slotLabel(slot, block)} (current)` : `S${slot}`,
      });
    }
    return opts;
  },

  async apply(cfg, { bus = getBus() } = {}) {
    const slot = normaliseSlot(cfg);
    if (slot === null) throw new Error(`setup must be ${SLOT_MIN}-${SLOT_MAX}, got ${cfg?.setup}`);
    // Payload shape confirmed against the hardware; the Fanatec UI's own model
    // is `TuningSetting{UserSetupIndex: ...}`.
    await bus.post(ACTIONS.TUNING_INDEX_CHANGED, { UserSetupIndex: slot });
  },

  async verify(cfg, { bus = getBus() } = {}) {
    const slot = normaliseSlot(cfg);
    if (slot === null) return { status: STATUS.FAILED, detail: 'invalid setup slot' };

    // Wait for a state that actually shows the requested slot. The service can
    // emit a snapshot taken before the change landed, so accepting the first
    // reply would report a mismatch for a switch that in fact succeeded.
    const matched = await bus
      .awaitState((s) => currentSlot(s) === slot, { timeoutMs: 6000 })
      .catch(() => null);

    if (matched) {
      return { status: STATUS.VERIFIED, detail: `wheelbase confirmed S${slot}` };
    }

    // No match within the window. Distinguish "said something else" from
    // "said nothing at all" — they need different fixes from the user.
    const seen = currentSlot(bus.lastState);
    if (seen === undefined) {
      return {
        status: STATUS.UNREACHABLE,
        detail: 'no reply from wheelbase — powered off, or FanatecService not running',
      };
    }
    return {
      status: STATUS.MISMATCH,
      detail: `asked for S${slot}, wheelbase reports S${seen}`,
    };
  },
};
