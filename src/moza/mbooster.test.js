import { describe, it, expect } from 'vitest';
import {
  findPort,
  identify,
  scaleCurve,
  curveKg,
  curveRaw,
  CURVE_POINTS,
  CURVE_MIN_PEAK_KG,
} from './mbooster.js';

const port = (path, productId = '0008') => ({ path, vendorId: '346E', productId });

/** A pedal that answers curve reads from a table, and nothing else. */
const fakeSession = (values) => ({
  async readCurvePoint(index) {
    return index in values ? values[index] : null;
  },
});

/** The axis as the real device reports it — float storage, truncated on read. */
const REAL_AXIS = { 0: 0, 1: 9362, 2: 18724, 3: 28085, 4: 37449, 5: 46811, 6: 56172 };

describe('findPort', () => {
  it('finds the mBooster by vendor and product id, not by COM number', async () => {
    const list = async () => [port('COM5', '1000'), port('COM6'), port('COM12', '1100')];
    expect(await findPort({ list })).toBe('COM6');
  });

  it('ignores other MOZA devices on the same machine', async () => {
    const list = async () => [port('COM5', '1000'), port('COM12', '1100')];
    expect(await findPort({ list })).toBeNull();
  });

  it('returns null when nothing is connected', async () => {
    expect(await findPort({ list: async () => [] })).toBeNull();
  });

  it('refuses to guess between two mBoosters rather than writing to one', async () => {
    // Windows reports a port-derived instance id here, not a device serial, so
    // there is genuinely nothing to tell them apart. Picking the first would
    // mean writing a brake curve to whichever enumerated first.
    const list = async () => [port('COM6'), port('COM7')];
    await expect(findPort({ list })).rejects.toThrow(/Refusing to guess/);
  });
});

describe('identify', () => {
  it('accepts the axis the real device reports', async () => {
    expect(await identify(fakeSession(REAL_AXIS))).toEqual({ ok: true });
  });

  it('accepts the axis after a preset shifts it', async () => {
    // The values are not constants. Loading Brian Brake Hybrid moved point 1
    // from 9362 to 9409, which an exact-match guard rejected outright.
    const shifted = { 0: 0, 1: 9409, 2: 18818, 3: 28226, 4: 37636, 5: 46635, 6: 56043 };
    expect((await identify(fakeSession(shifted))).ok).toBe(true);
  });

  it('rejects a device that does not answer', async () => {
    // What another MOZA device on the same machine actually does.
    const result = await identify(fakeSession({}));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer/);
  });

  it('rejects a table that does not rise', async () => {
    const flat = { 0: 0, 1: 4242, 2: 4242, 3: 4242, 4: 4242, 5: 4242, 6: 4242 };
    const result = await identify(fakeSession(flat));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not rising/);
  });

  it('rejects an axis that rises but stops far short of full scale', async () => {
    const stunted = { 0: 0, 1: 10, 2: 20, 3: 30, 4: 40, 5: 50, 6: 60 };
    expect((await identify(fakeSession(stunted))).reason).toMatch(/tops out/);
  });

  it('is not fooled by a device that answers zero to everything', async () => {
    const zeros = Object.fromEntries([0,1,2,3,4,5,6].map((i) => [i, 0]));
    expect((await identify(fakeSession(zeros))).ok).toBe(false);
  });
});

describe('scaleCurve', () => {
  const brian = [22.415, 31.609, 37.1, 41.532, 44.443, 47.421, 50.001];

  it('moves every point so the shape is preserved', () => {
    const scaled = scaleCurve(brian, 24);
    expect(scaled.at(-1)).toBeCloseTo(24, 6);
    scaled.forEach((kg, i) => {
      expect(kg / scaled.at(-1)).toBeCloseTo(brian[i] / brian.at(-1), 9);
    });
  });

  it('stays monotonic, so the pedal never gets lighter part way down', () => {
    const scaled = scaleCurve(brian, CURVE_MIN_PEAK_KG);
    for (let i = 1; i < scaled.length; i++) expect(scaled[i]).toBeGreaterThan(scaled[i - 1]);
  });

  it('lands close to MOZA\'s own 24kg preset', () => {
    // Different curves — Carter's was authored separately — but close enough
    // that linear scaling is not inventing a shape of its own.
    const carter = [8.603, 13.735, 16.8, 19.274, 20.898, 22.56, 24];
    scaleCurve(brian, 24).forEach((kg, i) => {
      expect(Math.abs(kg - carter[i])).toBeLessThan(2.5);
    });
  });

  it('refuses a curve with no peak to scale from', () => {
    expect(() => scaleCurve([0, 0, 0, 0, 0, 0, 0], 24)).toThrow(/no positive peak/);
  });
});

describe('curve value scaling', () => {
  it('reads the captured 30kg peak as exactly 30kg', () => {
    // 0x2666 from the Pit House capture, taken while the slider read 30.
    expect(curveKg(0x2666)).toBeCloseTo(30, 2);
  });

  it('round-trips a force through the wire encoding', () => {
    for (const kg of [24, 43, 50, 79, 200]) {
      expect(curveKg(curveRaw(kg))).toBeCloseTo(kg, 2);
    }
  });

  it('clamps rather than wrapping past the top of the range', () => {
    expect(curveRaw(1000)).toBe(65535);
    expect(curveRaw(-5)).toBe(0);
  });

  it('describes a seven point curve', () => {
    expect(CURVE_POINTS).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });
});
