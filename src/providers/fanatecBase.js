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
import { ensureServiceRunning } from '../mqtt/fanatecService.js';
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
        options: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: `Setup ${v}` })),
        help: 'Dial the slots in via the Fanatec app first — this only selects between them.',
      },
    ];
  },

  validate(cfg) {
    return normaliseSlot(cfg) === null ? [`wheelbase setup must be ${SLOT_MIN}-${SLOT_MAX}`] : [];
  },

  describe(cfg) {
    const slot = normaliseSlot(cfg);
    return slot ? `wheelbase Setup ${slot}` : 'wheelbase (not configured)';
  },

  /**
   * Enumerate the five slots for the editor.
   *
   * Named "Setup N" because that is what the Fanatec app calls them, and a
   * setting is easier to trust when both places agree. The labels used to
   * append the FFB/FUL/FEI values read back from the base, which only worked
   * for the active slot — the base reports one block at a time — so the list
   * was inconsistent by construction, and the numbers were noise next to the
   * one thing being chosen. The live reading is still worth having for
   * "(current)", which says which slot you are on right now.
   */
  async options({ bus = getBus() } = {}) {
    const state = await bus.readState({ timeoutMs: 4000 }).catch(() => null);
    const active = currentSlot(state);
    const opts = [];
    for (let slot = SLOT_MIN; slot <= SLOT_MAX; slot++) {
      opts.push({
        value: slot,
        label: slot === active ? `Setup ${slot} (current)` : `Setup ${slot}`,
      });
    }
    return opts;
  },

  async apply(cfg, ctx = {}) {
    const { bus = getBus() } = ctx;
    const slot = normaliseSlot(cfg);
    if (slot === null) throw new Error(`setup must be ${SLOT_MIN}-${SLOT_MAX}, got ${cfg?.setup}`);

    // Without FanatecService running, this publish succeeds into a void — the
    // broker accepts it and nothing applies it. Start the service first; it
    // runs headless, so this costs nothing when it is already up.
    let coldStart = false;
    if (ctx.settings?.fanatecAutoStart !== false) {
      const svc = await ensureServiceRunning(ctx);
      if (!svc.ok) throw new Error(svc.reason);
      coldStart = svc.started;
      if (svc.started) {
        // The service takes several seconds to attach to the wheelbase after
        // launching, and a command sent before then is accepted and ignored.
        // Wait for it to actually answer rather than guessing a delay — a
        // fixed 2s was not enough and produced a false "unreachable".
        await bus.readState({ timeoutMs: ctx.serviceSettleMs ?? 15000 }).catch(() => null);
      }
    }

    // Payload shape confirmed against the hardware; the Fanatec UI's own model
    // is `TuningSetting{UserSetupIndex: ...}`.
    //
    // A freshly started service begins publishing state before it will accept a
    // tuning change, so the first command after a cold start is silently
    // dropped. Retry only in that case — a warm switch stays a single publish
    // and completes in about a tenth of a second.
    const attempts = coldStart ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await bus.post(ACTIONS.TUNING_INDEX_CHANGED, { UserSetupIndex: slot });
      if (attempt === attempts) break;
      const landed = await bus
        .awaitState((s) => currentSlot(s) === slot, { timeoutMs: 2500 })
        .catch(() => null);
      if (landed) break;
    }
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
      return { status: STATUS.VERIFIED, detail: `wheelbase confirmed Setup ${slot}` };
    }

    // No match within the window. Distinguish "said something else" from
    // "said nothing at all" — they need different fixes from the user.
    const seen = currentSlot(bus.lastState);
    if (seen === undefined) {
      return {
        status: STATUS.UNREACHABLE,
        detail: 'no reply from wheelbase — is it powered on?',
      };
    }
    return {
      status: STATUS.MISMATCH,
      detail: `asked for Setup ${slot}, wheelbase reports Setup ${seen}`,
    };
  },
};
