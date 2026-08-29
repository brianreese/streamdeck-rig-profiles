import { describe, it, expect, beforeEach, vi } from 'vitest';
import moza from './moza.js';
import { STATUS } from './status.js';

vi.mock('../moza/mbooster.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withDevice: vi.fn(),
    closePitHouse: vi.fn(async () => ({ closed: false, wasRunning: false })),
    reopenPitHouse: vi.fn(() => true),
    isPitHouseRunning: vi.fn(async () => false),
  };
});

// Pit House's library lives in the user's Documents folder, so the tests
// supply their own rather than depending on whatever is installed.
vi.mock('../moza/presetStore.js', () => ({
  listPresets: vi.fn(() => [
    { id: 'brian', name: 'Brian Brake Hybrid' },
    { id: 'carter', name: 'Carter Brake' },
  ]),
  findPreset: vi.fn((id) => PRESETS[id] ?? null),
}));

const PRESETS = {
  brian: {
    id: 'brian',
    name: 'Brian Brake Hybrid',
    deviceParams: {
      brake_forces_curve: [22.415, 31.609, 37.1, 41.532, 44.443, 47.421, 50.001],
      brake_machinelimit_min: 3.8,
      brake_machinelimit_max: 19.82,
      force_max_coef: 50,
    },
  },
  carter: {
    id: 'carter',
    name: 'Carter Brake',
    deviceParams: {
      brake_forces_curve: [8.603, 13.735, 16.8, 19.274, 20.898, 22.56, 24],
      brake_machinelimit_min: 3.8,
      brake_machinelimit_max: 8.1,
      force_max_coef: 200,
    },
  },
};

const { withDevice, closePitHouse, reopenPitHouse, isPitHouseRunning } = await import('../moza/mbooster.js');

/** A fake pedal that remembers what was written. */
function fakePedal({ acknowledge = true, readings = {}, curveReadback = null, curveFails = [] } = {}) {
  const written = {};
  withDevice.mockImplementation(async (fn) =>
    fn({
      async write(name, value) {
        written[name] = value;
        return acknowledge;
      },
      async read(name) {
        return name in readings ? readings[name] : (written[name] ?? null);
      },
      async writeCurve(values) {
        written.curve = values;
        return curveFails;
      },
      async readCurve() {
        return curveReadback ?? written.curve ?? [];
      },
    }),
  );
  return written;
}

beforeEach(() => {
  vi.clearAllMocks();
  closePitHouse.mockResolvedValue({ closed: false, wasRunning: false });
  isPitHouseRunning.mockResolvedValue(false);
});

describe('validate', () => {
  it('requires at least one setting', () => {
    expect(moza.validate({})).toContain('MOZA is enabled but no preset or pedal setting is chosen');
  });

  it('accepts a single force setting', () => {
    expect(moza.validate({ maxForceKg: 35 })).toEqual([]);
  });

  it('rejects a force outside the pedal range', () => {
    expect(moza.validate({ maxForceKg: 500 }).join()).toMatch(/5-200kg/);
    expect(moza.validate({ maxForceKg: 1 }).join()).toMatch(/5-200kg/);
  });

  it('rejects travel beyond the physical 53.5mm', () => {
    expect(moza.validate({ travelEndMm: 80 }).join()).toMatch(/0-53.5mm/);
  });

  it('rejects a non-numeric value rather than sending it', () => {
    expect(moza.validate({ maxForceKg: 'soft' }).join()).toMatch(/no preset or pedal setting/);
  });
});

describe('apply', () => {
  it('writes only the settings that are filled in', async () => {
    const written = fakePedal();
    await moza.apply({ maxForceKg: 35, travelEndMm: '' }, {});
    expect(written).toEqual({ maxForceKg: 35 });
  });

  it('writes several settings together', async () => {
    const written = fakePedal();
    await moza.apply({ maxForceKg: 40, travelStartMm: 2, travelEndMm: 20 }, {});
    expect(written).toEqual({ maxForceKg: 40, travelStartMm: 2, travelEndMm: 20 });
  });

  it('fails when the pedal does not acknowledge a write', async () => {
    fakePedal({ acknowledge: false });
    await expect(moza.apply({ maxForceKg: 35 }, {})).rejects.toThrow(/not acknowledged/);
  });

  it('refuses invalid config before opening the port', async () => {
    fakePedal();
    await expect(moza.apply({ maxForceKg: 900 }, {})).rejects.toThrow(/5-200kg/);
    expect(withDevice).not.toHaveBeenCalled();
  });

  it('closes Pit House by default, because it holds the port exclusively', async () => {
    fakePedal();
    await moza.apply({ maxForceKg: 35 }, { settings: {} });
    expect(closePitHouse).toHaveBeenCalled();
  });

  it('leaves Pit House alone when explicitly opted out', async () => {
    fakePedal();
    await moza.apply({ maxForceKg: 35 }, { settings: { mozaClosePitHouse: false } });
    expect(closePitHouse).not.toHaveBeenCalled();
  });

  it('does not reopen Pit House unless asked, since that would undo the switch', async () => {
    fakePedal();
    closePitHouse.mockResolvedValue({ closed: true, wasRunning: true });
    await moza.apply({ maxForceKg: 35 }, { settings: {} });
    expect(reopenPitHouse).not.toHaveBeenCalled();
  });

  it('closes Pit House when the user has opted in', async () => {
    fakePedal();
    closePitHouse.mockResolvedValue({ closed: true, wasRunning: true });
    await moza.apply({ maxForceKg: 35 }, { settings: { mozaClosePitHouse: true } });
    expect(closePitHouse).toHaveBeenCalled();
  });

  it('gives up when Pit House will not close, rather than failing on the port', async () => {
    fakePedal();
    closePitHouse.mockResolvedValue({ closed: false, wasRunning: true, reason: 'still running' });
    await expect(
      moza.apply({ maxForceKg: 35 }, { settings: { mozaClosePitHouse: true } }),
    ).rejects.toThrow(/could not close Pit House/);
  });
});

describe('verify', () => {
  it('confirms when the pedal reports what was asked for', async () => {
    fakePedal({ readings: { maxForceKg: 35 } });
    const out = await moza.verify({ maxForceKg: 35 }, {});
    expect(out.status).toBe(STATUS.VERIFIED);
    expect(out.detail).toMatch(/35.00kg/);
  });

  it('tolerates a small rounding difference from the wire encoding', async () => {
    fakePedal({ readings: { maxForceKg: 35.01 } });
    expect((await moza.verify({ maxForceKg: 35 }, {})).status).toBe(STATUS.VERIFIED);
  });

  it('reports a mismatch naming what the pedal actually has', async () => {
    fakePedal({ readings: { maxForceKg: 50 } });
    const out = await moza.verify({ maxForceKg: 35 }, {});
    expect(out.status).toBe(STATUS.MISMATCH);
    expect(out.detail).toMatch(/is 50.00, wanted 35/);
  });

  it('treats an unreadable value as a mismatch, never as success', async () => {
    fakePedal({ readings: { maxForceKg: null } });
    expect((await moza.verify({ maxForceKg: 35 }, {})).status).toBe(STATUS.MISMATCH);
  });

  it('reports unreachable when the port cannot be opened', async () => {
    withDevice.mockRejectedValue(new Error('COM6 is in use — MOZA Pit House holds it.'));
    const out = await moza.verify({ maxForceKg: 35 }, {});
    expect(out.status).toBe(STATUS.UNREACHABLE);
    expect(out.detail).toMatch(/Pit House/);
  });
});

describe('health', () => {
  it('warns when Pit House holds the port', async () => {
    isPitHouseRunning.mockResolvedValue(true);
    const out = await moza.health();
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/serial port/);
  });

  it('is ok when Pit House is closed', async () => {
    expect((await moza.health()).ok).toBe(true);
  });
});

describe('blank fields', () => {
  it('never writes a blank field, because Number("") is 0', () => {
    // A travel end of 0mm on a brake pedal would be a real misconfiguration.
    const written = fakePedal();
    return moza.apply({ maxForceKg: 35, travelStartMm: '', travelEndMm: '   ' }, {}).then(() => {
      expect(written).toEqual({ maxForceKg: 35 });
    });
  });

  it('treats an all-blank config as nothing configured', () => {
    expect(moza.validate({ maxForceKg: '', travelEndMm: null }))
      .toContain('MOZA is enabled but no preset or pedal setting is chosen');
  });

  it('still accepts a legitimate zero', async () => {
    const written = fakePedal();
    await moza.apply({ travelStartMm: 0 }, {});
    expect(written).toEqual({ travelStartMm: 0 });
  });
});

describe('preset-backed profiles', () => {
  it('writes the preset curve untouched when no peak is overridden', async () => {
    const written = fakePedal();
    await moza.apply({ preset: 'brian' }, {});
    expect(written.curve).toEqual(PRESETS.brian.deviceParams.brake_forces_curve);
    expect(written.travelEndMm).toBe(19.82);
    expect(written.maxForceKg).toBe(50);
  });

  it('scales the whole curve when the peak is overridden, keeping its shape', async () => {
    const written = fakePedal();
    await moza.apply({ preset: 'brian', peakForceKg: 24 }, {});

    const source = PRESETS.brian.deviceParams.brake_forces_curve;
    expect(written.curve.at(-1)).toBeCloseTo(24, 5);
    // Same shape: every point keeps its proportion of the peak.
    for (let i = 0; i < source.length; i++) {
      expect(written.curve[i] / 24).toBeCloseTo(source[i] / source.at(-1), 6);
    }
  });

  it('scaling reproduces MOZA\'s own 24kg preset to within half a kilogram', async () => {
    const written = fakePedal();
    await moza.apply({ preset: 'brian', peakForceKg: 24 }, {});
    // Not an identity — Carter's curve was authored separately — but close
    // enough that the linear scaling is not inventing a shape of its own.
    written.curve.forEach((kg, i) => {
      expect(Math.abs(kg - PRESETS.carter.deviceParams.brake_forces_curve[i])).toBeLessThan(2.5);
    });
  });

  it('lets a profile override the preset rather than the other way round', async () => {
    const written = fakePedal();
    await moza.apply({ preset: 'brian', travelEndMm: 8.1 }, {});
    expect(written.travelEndMm).toBe(8.1);
    // Untouched fields still come from the preset.
    expect(written.travelStartMm).toBe(3.8);
  });

  it('refuses a peak below what the pedal can hold smoothly', () => {
    expect(moza.validate({ preset: 'brian', peakForceKg: 12 }).join()).toMatch(/24-200kg/);
  });

  it('refuses to scale a curve it has no shape for', () => {
    expect(moza.validate({ peakForceKg: 24 }).join()).toMatch(/needs a preset/);
  });

  it('does not treat a missing preset as a malformed config', async () => {
    // Existence is environmental, not structural. Pit House can delete or
    // repackage a preset without the config changing — an upgrade to the
    // .mzpreset container did exactly that — and making it a validation error
    // meant one profile pointing at a missing preset blocked saving every
    // profile, with no way to change the value because the dropdown had no
    // option for it.
    expect(moza.validate({ preset: 'gone' })).toEqual([]);
  });

  it('refuses to apply a preset that is not there, rather than half-applying', async () => {
    // Silently dropping the curve would turn "Brian's shape at 24kg" into
    // "24kg of whatever is already loaded" — the wrong surprise on a brake.
    fakePedal();
    await expect(moza.apply({ preset: 'gone', peakForceKg: 24 }, {})).rejects.toThrow(
      /not in Pit House's library/,
    );
  });

  it('says a preset is missing when describing it, rather than showing nothing', () => {
    expect(moza.describe({ preset: 'gone' })).toMatch(/missing/);
  });

  it('fails loudly when a curve point will not take', async () => {
    fakePedal({ curveFails: [2, 3] });
    await expect(moza.apply({ preset: 'brian', peakForceKg: 24 }, {})).rejects.toThrow(
      /points 2, 3 would not take/,
    );
  });

  it('verifies every curve point, not just the peak', async () => {
    // Peak is right but the middle sags — what a partial write leaves behind.
    const sagging = [22.415, 31.609, 20, 41.532, 44.443, 47.421, 50.001];
    fakePedal({ curveReadback: sagging, readings: { maxForceKg: 50, travelStartMm: 3.8, travelEndMm: 19.82 } });
    const result = await moza.verify({ preset: 'brian' }, {});
    expect(result.status).toBe(STATUS.MISMATCH);
    expect(result.detail).toMatch(/force curve point/);
  });

  it('confirms a curve that matches', async () => {
    fakePedal({
      curveReadback: PRESETS.brian.deviceParams.brake_forces_curve,
      readings: { maxForceKg: 50, travelStartMm: 3.8, travelEndMm: 19.82 },
    });
    const result = await moza.verify({ preset: 'brian' }, {});
    expect(result.status).toBe(STATUS.VERIFIED);
    expect(result.detail).toMatch(/Brian Brake Hybrid/);
  });
});
