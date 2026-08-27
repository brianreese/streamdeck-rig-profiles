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

const { withDevice, closePitHouse, isPitHouseRunning } = await import('../moza/mbooster.js');

/** A fake pedal that remembers what was written. */
function fakePedal({ acknowledge = true, readings = {} } = {}) {
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
    expect(moza.validate({})).toContain('MOZA is enabled but no pedal setting is filled in');
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
    expect(moza.validate({ maxForceKg: 'soft' }).join()).toMatch(/no pedal setting/);
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

  it('leaves Pit House alone unless asked', async () => {
    fakePedal();
    await moza.apply({ maxForceKg: 35 }, { settings: {} });
    expect(closePitHouse).not.toHaveBeenCalled();
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
      .toContain('MOZA is enabled but no pedal setting is filled in');
  });

  it('still accepts a legitimate zero', async () => {
    const written = fakePedal();
    await moza.apply({ travelStartMm: 0 }, {});
    expect(written).toEqual({ travelStartMm: 0 });
  });
});
