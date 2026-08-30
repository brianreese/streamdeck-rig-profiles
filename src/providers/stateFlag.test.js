import { describe, it, expect, vi, beforeEach } from 'vitest';
import stateFlag, { parseFlags } from './stateFlag.js';
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
  it('needs at least one flag', () => {
    expect(stateFlag.validate({}).join()).toMatch(/at least one flag/);
    expect(stateFlag.validate({ flags: '  \n ' }).join()).toMatch(/at least one flag/);
  });

  it('refuses names other software would struggle with', () => {
    // These end up as JSON keys read by unrelated programs.
    expect(stateFlag.validate({ flags: 'head set' }).join()).toMatch(/flag name/);
  });

  it('accepts one flag, or several', () => {
    expect(stateFlag.validate({ flags: 'vr' })).toEqual([]);
    expect(stateFlag.validate({ flags: 'vr\nheadset' })).toEqual([]);
  });
});

describe('parsing the list', () => {
  it('takes one per line, ignoring blanks and repeats', () => {
    expect(parseFlags('vr\n\n headset \nvr')).toEqual(['vr', 'headset']);
  });

  it('accepts commas too, since people type them', () => {
    expect(parseFlags('vr, headset')).toEqual(['vr', 'headset']);
  });
});

describe('switching on and off', () => {
  const vr = { flags: 'vr' };

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

  it('sets every flag it lists, because one switch can change several facts', async () => {
    await stateFlag.apply({ flags: 'vr\nheadset' });
    expect(_store).toEqual({ vr: true, headset: true });
  });

  it('is active only when all of its flags are', async () => {
    await stateFlag.apply({ flags: 'vr\nheadset' });
    _store.headset = false;
    expect(await stateFlag.isActive({ flags: 'vr\nheadset' })).toBe(false);
  });

  it('refuses to apply a config it would not validate', async () => {
    await expect(stateFlag.apply({ flags: '' })).rejects.toThrow(/at least one flag/);
  });
});

describe('inverted, for a Flatscreen key beside a VR one', () => {
  const flat = { flags: 'vr', whenOff: true };

  it('counts an absent flag as off, because nothing has turned it on', async () => {
    // Worth being explicit, because it looks like it contradicts the positive
    // case and does not. Both ask the same question — "is this flag on?" — and
    // read the answer through their own polarity. A missing flag means VR was
    // never switched on, so a Mode asserting "VR is off" is satisfied, while a
    // Mode asserting "VR is on" is not.
    expect(await stateFlag.isActive(flat)).toBe(true);
    expect(await stateFlag.isActive({ flags: 'vr' })).toBe(false);
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
    const vr = { flags: 'vr' };
    await stateFlag.apply(vr);
    expect(await stateFlag.isActive(vr)).toBe(true);
    expect(await stateFlag.isActive(flat)).toBe(false);

    await stateFlag.apply(flat);
    expect(await stateFlag.isActive(vr)).toBe(false);
    expect(await stateFlag.isActive(flat)).toBe(true);
  });

  it('says what it does in plain words', () => {
    expect(stateFlag.describe({ flags: 'vr' })).toBe('sets vr');
    expect(stateFlag.describe(flat)).toBe('clears vr');
  });
});

describe('verify', () => {
  it('confirms the flags it just set', async () => {
    await stateFlag.apply({ flags: 'vr' });
    const out = await stateFlag.verify({ flags: 'vr' });
    expect(out.status).toBe(STATUS.VERIFIED);
    expect(out.detail).toBe('vr on');
  });

  it('names the flags that did not move', async () => {
    const out = await stateFlag.verify({ flags: 'vr\nheadset' });
    expect(out.status).toBe(STATUS.MISMATCH);
    expect(out.detail).toMatch(/vr, headset did not go on/);
  });
});
