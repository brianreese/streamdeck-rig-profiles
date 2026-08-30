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
  it('needs both a name and a value', () => {
    expect(stateFlag.validate({}).length).toBe(2);
    expect(stateFlag.validate({ flag: 'display' }).join()).toMatch(/needs a value/);
    expect(stateFlag.validate({ value: 'vr' }).join()).toMatch(/needs a name/);
  });

  it('refuses names other software would struggle with', () => {
    // These strings end up as JSON keys read by unrelated programs.
    expect(stateFlag.validate({ flag: 'dis play', value: 'vr' }).join()).toMatch(/flag name/);
    expect(stateFlag.validate({ flag: 'display', value: 'v r' }).join()).toMatch(/flag value/);
  });

  it('accepts a well formed pair', () => {
    expect(stateFlag.validate({ flag: 'display', value: 'vr' })).toEqual([]);
  });
});

describe('apply, isActive and unapply', () => {
  const vr = { flag: 'display', value: 'vr' };
  const flat = { flag: 'display', value: 'flatscreen' };

  it('is inactive before anything has been applied', async () => {
    // isActive must answer cold — a Mode key paints itself at startup, with no
    // preceding apply.
    expect(await stateFlag.isActive(vr)).toBe(false);
  });

  it('becomes active once applied', async () => {
    await stateFlag.apply(vr);
    expect(await stateFlag.isActive(vr)).toBe(true);
  });

  it('is idempotent', async () => {
    await stateFlag.apply(vr);
    await stateFlag.apply(vr);
    expect(await stateFlag.isActive(vr)).toBe(true);
  });

  it('makes two Modes on one flag mutually exclusive without any rule saying so', async () => {
    // The state can only hold one value, so exclusivity falls out of it rather
    // than needing enforcement in the plugin.
    await stateFlag.apply(vr);
    expect(await stateFlag.isActive(flat)).toBe(false);

    await stateFlag.apply(flat);
    expect(await stateFlag.isActive(vr)).toBe(false);
    expect(await stateFlag.isActive(flat)).toBe(true);
  });

  it('clears the flag on unapply, rather than picking some other value', async () => {
    await stateFlag.apply(vr);
    await stateFlag.unapply(vr);
    expect(await stateFlag.isActive(vr)).toBe(false);
    // And no other Mode on that flag becomes active by accident.
    expect(await stateFlag.isActive(flat)).toBe(false);
  });

  it('refuses to apply a config it would not validate', async () => {
    await expect(stateFlag.apply({ flag: 'display' })).rejects.toThrow(/needs a value/);
  });
});

describe('verify', () => {
  it('confirms the flag it just set', async () => {
    await stateFlag.apply({ flag: 'display', value: 'vr' });
    const out = await stateFlag.verify({ flag: 'display', value: 'vr' });
    expect(out.status).toBe(STATUS.VERIFIED);
    expect(out.detail).toBe('display = vr');
  });

  it('says what it found when the flag says something else', async () => {
    await stateFlag.apply({ flag: 'display', value: 'flatscreen' });
    const out = await stateFlag.verify({ flag: 'display', value: 'vr' });
    expect(out.status).toBe(STATUS.MISMATCH);
    expect(out.detail).toMatch(/reads flatscreen, wanted vr/);
  });

  it('says "nothing" rather than null when the flag is absent', async () => {
    expect((await stateFlag.verify({ flag: 'display', value: 'vr' })).detail).toMatch(/reads nothing/);
  });
});
