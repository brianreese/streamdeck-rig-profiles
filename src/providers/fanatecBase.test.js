import { describe, it, expect } from 'vitest';
import fanatecBase, { activeBlock, currentSlot } from './fanatecBase.js';
import { STATUS } from './index.js';
import { ACTIONS } from '../mqtt/fanatecBus.js';

/** A real payload captured from a ClubSport DD+, trimmed to what we read. */
const stateOnSlot = (slot) => ({
  SimplifiedMode: false,
  BaseTypeID: 'FS_WHEEL_BASETYPE_CSDDPLUS',
  StandardTuningSettings: [],
  AdvancedTuningSettings: [{ UserIndex: slot, FFB: 77, FUL: 30, FEI: 100 }],
});

function fakeBus(state) {
  return {
    posts: [],
    async post(action, message) {
      this.posts.push({ action, message });
    },
    lastState: state,
    async readState() {
      return state;
    },
    async awaitState(match = () => true) {
      return match(state) ? state : null;
    },
  };
}

describe('payload parsing', () => {
  it('reads the advanced block in advanced mode', () => {
    expect(currentSlot(stateOnSlot(3))).toBe(3);
  });

  it('prefers the standard block in simplified mode', () => {
    const state = {
      SimplifiedMode: true,
      StandardTuningSettings: [{ UserIndex: 4 }],
      AdvancedTuningSettings: [{ UserIndex: 1 }],
    };
    expect(currentSlot(state)).toBe(4);
  });

  it('falls back to whichever block has content', () => {
    const state = { SimplifiedMode: true, StandardTuningSettings: [], AdvancedTuningSettings: [{ UserIndex: 2 }] };
    expect(currentSlot(state)).toBe(2);
  });

  it('returns undefined rather than throwing on an empty payload', () => {
    expect(activeBlock(null)).toBeNull();
    expect(currentSlot(undefined)).toBeUndefined();
  });
});

describe('apply', () => {
  it('publishes TuningIndexChanged with the confirmed payload shape', async () => {
    const bus = fakeBus(stateOnSlot(1));
    await fanatecBase.apply({ setup: 2 }, { bus });
    expect(bus.posts).toEqual([
      { action: ACTIONS.TUNING_INDEX_CHANGED, message: { UserSetupIndex: 2 } },
    ]);
  });

  it('rejects out-of-range slots before touching the hardware', async () => {
    const bus = fakeBus(stateOnSlot(1));
    await expect(fanatecBase.apply({ setup: 9 }, { bus })).rejects.toThrow(/1-5/);
    await expect(fanatecBase.apply({ setup: 0 }, { bus })).rejects.toThrow(/1-5/);
    expect(bus.posts).toEqual([]);
  });

  it('never writes individual FFB values', async () => {
    const bus = fakeBus(stateOnSlot(1));
    await fanatecBase.apply({ setup: 3 }, { bus });
    const actions = bus.posts.map((p) => p.action);
    expect(actions).not.toContain(ACTIONS.TUNING_SETTINGS);
  });
});

describe('verify', () => {
  it('confirms when the base reports the requested slot', async () => {
    const out = await fanatecBase.verify({ setup: 2 }, { bus: fakeBus(stateOnSlot(2)) });
    expect(out.status).toBe(STATUS.VERIFIED);
  });

  it('reports mismatch when the base is on a different slot', async () => {
    const out = await fanatecBase.verify({ setup: 2 }, { bus: fakeBus(stateOnSlot(1)) });
    expect(out.status).toBe(STATUS.MISMATCH);
    expect(out.detail).toContain('S2');
    expect(out.detail).toContain('S1');
  });

  it('reports unreachable when the base does not answer', async () => {
    const out = await fanatecBase.verify({ setup: 2 }, { bus: fakeBus(null) });
    expect(out.status).toBe(STATUS.UNREACHABLE);
    // The message no longer mentions FanatecService: apply() starts it, so if
    // there is still no reply the wheelbase itself is the remaining suspect.
    expect(out.detail).toMatch(/powered on/);
  });

  it('does not confirm on an unreadable payload', async () => {
    const out = await fanatecBase.verify({ setup: 2 }, { bus: fakeBus({ SimplifiedMode: false }) });
    expect(out.status).not.toBe(STATUS.VERIFIED);
  });
});

describe('options', () => {
  it('labels the current slot with its real values', async () => {
    const opts = await fanatecBase.options({ bus: fakeBus(stateOnSlot(2)) });
    expect(opts).toHaveLength(5);
    const current = opts.find((o) => o.value === 2);
    expect(current.label).toContain('FFB 77');
    expect(current.label).toContain('(current)');
  });

  it('still lists all five slots when the base is unreachable', async () => {
    const opts = await fanatecBase.options({ bus: fakeBus(null) });
    expect(opts.map((o) => o.value)).toEqual([1, 2, 3, 4, 5]);
  });
});
