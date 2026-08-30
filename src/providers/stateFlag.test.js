import { describe, it, expect, vi, beforeEach } from 'vitest';
import stateFlag from './stateFlag.js';
import { STATUS } from './status.js';

// The real store writes to a shared directory other software reads, so the
// tests keep their own in memory rather than touching it.
vi.mock('../rigState.js', () => {
  const store = {};
  return {
    readFlags: () => ({ ...store }),
    readFlag: (name) => (name in store ? store[name] : null),
    writeFlag: (name, value) => {
      if (value === null || value === undefined) delete store[name];
      else store[name] = value;
      return { ...store };
    },
    _store: store,
  };
});

const { _store } = await import('../rigState.js');

beforeEach(() => {
  for (const k of Object.keys(_store)) delete _store[k];
});

describe('contract', () => {
  it('reports state and can be reversed, which is what makes a Mode stateful', () => {
    expect(typeof stateFlag.isActive).toBe('function');
    expect(typeof stateFlag.unapply).toBe('function');
  });

  it('is available to profiles and modes', () => {
    expect(stateFlag.contexts).toEqual(['profile', 'mode']);
  });
});

describe('validate', () => {
  it('needs a name', () => {
    expect(stateFlag.validate({}).join()).toMatch(/needs a name/);
    expect(stateFlag.validate({ flags: '  \n ' }).join()).toMatch(/needs a name/);
  });

  it('refuses names other software would struggle with', () => {
    // These end up as JSON keys read by unrelated programs.
    expect(stateFlag.validate({ flag: 'head set' }).join()).toMatch(/flag name/);
  });

  it('declares itself repeatable, because one Mode asserts several facts', () => {
    // And they may point different ways, which is why a list on one instance
    // was not enough: the invert applies to the instance, not to each name.
    expect(stateFlag.repeatable).toBe(true);
  });

});

describe('switching on and off', () => {
  const vr = { flag: 'vr' };

  it('is inactive before anything has been applied', async () => {
    // isActive must answer cold — a Mode key paints itself at startup, with no
    // preceding apply.
    expect(await stateFlag.isActive(vr)).toBe(false);
  });

  it('goes on, and back off again', async () => {
    // The whole reason the value is boolean: "off" has an unambiguous answer.
    // A configurable value had none — switch display=vr off and it becomes what?
    await stateFlag.apply(vr);
    expect(await stateFlag.isActive(vr)).toBe(true);
    await stateFlag.unapply(vr);
    expect(await stateFlag.isActive(vr)).toBe(false);
    expect(_store.vr).toBe(false);
  });

  it('is idempotent', async () => {
    await stateFlag.apply(vr);
    await stateFlag.apply(vr);
    expect(await stateFlag.isActive(vr)).toBe(true);
  });

  it('refuses to apply a config it would not validate', async () => {
    await expect(stateFlag.apply({ flag: '' })).rejects.toThrow(/needs a name/);
  });
});

describe('inverted, for a Flatscreen key beside a VR one', () => {
  const flat = { flag: 'vr', whenOff: true };

  it('counts an absent flag as off, because nothing has turned it on', async () => {
    // Worth being explicit, because it looks like it contradicts the positive
    // case and does not. Both ask the same question — "is this flag on?" — and
    // read the answer through their own polarity. A missing flag means VR was
    // never switched on, so a Mode asserting "VR is off" is satisfied, while a
    // Mode asserting "VR is on" is not.
    expect(await stateFlag.isActive(flat)).toBe(true);
    expect(await stateFlag.isActive({ flag: 'vr' })).toBe(false);
  });

  it('writes the flag off when applied, rather than relying on absence', async () => {
    // Absence and an explicit false read the same here, but other software may
    // distinguish them, so switching Flatscreen on states it rather than
    // leaving the flag missing.
    await stateFlag.apply(flat);
    expect(_store.vr).toBe(false);
    expect(await stateFlag.isActive(flat)).toBe(true);
  });

  it('is the mirror of the plain one, so the two are never both active', async () => {
    const vr = { flag: 'vr' };
    await stateFlag.apply(vr);
    expect(await stateFlag.isActive(vr)).toBe(true);
    expect(await stateFlag.isActive(flat)).toBe(false);

    await stateFlag.apply(flat);
    expect(await stateFlag.isActive(vr)).toBe(false);
    expect(await stateFlag.isActive(flat)).toBe(true);
  });

  it('says what it does in plain words', () => {
    expect(stateFlag.describe({ flag: 'vr' })).toBe('sets vr');
    expect(stateFlag.describe(flat)).toBe('clears vr');
  });
});

describe('verify', () => {
  it('confirms the flags it just set', async () => {
    await stateFlag.apply({ flag: 'vr' });
    const out = await stateFlag.verify({ flag: 'vr' });
    expect(out.status).toBe(STATUS.VERIFIED);
    expect(out.detail).toBe('vr on');
  });

});
