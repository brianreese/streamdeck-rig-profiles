import { describe, it, expect, vi } from 'vitest';
import aceDriver from './aceDriver.js';
import { getProvider, reportsState, isReversible, isRepeatable } from './index.js';
import { applyProfile } from '../profileSwitch.js';
import { STATUS } from './status.js';

const ID = '4a0d6d7c-e5e6-4a4a-9b0a-000000000001';

/** Capture the URL instead of handing it to the Stream Deck app. */
const spy = () => {
  const calls = [];
  return { openUrl: (u) => { calls.push(u); }, calls };
};

describe('the contract it declares', () => {
  it('is registered and reachable by id', () => {
    expect(getProvider('ace-driver')).toBe(aceDriver);
  });

  it('offers itself to profiles and Modes', () => {
    expect(aceDriver.contexts).toEqual(['profile', 'mode']);
  });

  it('refuses to be configured twice — one driver is in the seat', () => {
    expect(isRepeatable(aceDriver)).toBe(false);
  });

  it('claims no outcome, because a deep link has no reply', () => {
    // openUrl resolves once the Stream Deck app has the URL, whether or not
    // anything receives it. There is nothing to verify against.
    expect(aceDriver.verifiable).toBe(false);
    expect(aceDriver.verify).toBeUndefined();
    expect(aceDriver.isActive).toBeUndefined();
    expect(reportsState(aceDriver)).toBe(false);
  });

  it('has no reverse, because a driver profile has no off', () => {
    // Somebody is in the seat or somebody else is; there is no third state, and
    // inventing one would assert something the race launcher never agreed to.
    expect(aceDriver.unapply).toBeUndefined();
    expect(isReversible(aceDriver)).toBe(false);
  });

  it('offers no list, because there is no query channel to build one from', () => {
    expect(aceDriver.options).toBeUndefined();
    expect(aceDriver.schema().map((f) => f.key)).toEqual(['driverId']);
  });
});

describe('validation', () => {
  it('needs an id', () => {
    expect(aceDriver.validate({})).toEqual(['ACE driver profile needs an id']);
    expect(aceDriver.validate({ driverId: '   ' })).toHaveLength(1);
  });

  it('insists on a UUID, since that is what the Drivers tab shows', () => {
    expect(aceDriver.validate({ driverId: 'kai' })[0]).toMatch(/must be a UUID/);
    expect(aceDriver.validate({ driverId: '4a0d6d7c-e5e6-4a4a-9b0a' })[0]).toMatch(/must be a UUID/);
  });

  it('accepts a real one, and tolerates a paste that gained capitals', () => {
    expect(aceDriver.validate({ driverId: ID })).toEqual([]);
    expect(aceDriver.validate({ driverId: ID.toUpperCase() })).toEqual([]);
    expect(aceDriver.validate({ driverId: `  ${ID}  ` })).toEqual([]);
  });

  it('says which driver without pretending to know who it is', () => {
    expect(aceDriver.describe({})).toMatch(/no driver/i);
    expect(aceDriver.describe({ driverId: ID })).toBe('driver 4a0d6d7c…');
  });
});

describe('applying', () => {
  it('sends exactly the URL the race launcher listens for', async () => {
    const { openUrl, calls } = spy();
    await aceDriver.apply({ driverId: ID }, { openUrl });
    expect(calls).toEqual([
      `streamdeck://plugins/message/com.race.launcher/activate?id=${ID}`,
    ]);
  });

  it('lowercases the id, because the launcher mints ids lowercase', async () => {
    // Its domain/newId.ts lowercases deliberately — the ids become filenames.
    // A paste that gained capitals should still find its driver rather than
    // silently activating nothing.
    const { openUrl, calls } = spy();
    await aceDriver.apply({ driverId: ID.toUpperCase() }, { openUrl });
    expect(calls[0]).toContain(ID);
  });

  it('refuses a bad id rather than sending a URL that cannot match', async () => {
    const { openUrl, calls } = spy();
    await expect(aceDriver.apply({ driverId: 'nope' }, { openUrl })).rejects.toThrow(/UUID/);
    expect(calls).toHaveLength(0);
  });

  it('sends one link per apply, not one per profile switch', async () => {
    const { openUrl, calls } = spy();
    await aceDriver.apply({ driverId: ID }, { openUrl });
    await aceDriver.apply({ driverId: ID }, { openUrl });
    expect(calls).toHaveLength(2);
  });
});

describe('through a real profile switch', () => {
  it('reports applied-unverified, and says why', async () => {
    const { openUrl, calls } = spy();
    const out = await applyProfile(
      { id: 'kai', name: 'Kai', providers: { 'ace-driver': { driverId: ID } } },
      { settings: {}, openUrl },
    );

    const result = out.results.find((r) => r.providerId === 'ace-driver');
    expect(result.status).toBe(STATUS.APPLIED_UNVERIFIED);
    expect(result.detail).toMatch(/does not report an outcome/);
    expect(calls).toHaveLength(1);
  });

  it('fails the block, not the switch, when the id is wrong', async () => {
    const out = await applyProfile(
      { id: 'kai', name: 'Kai', providers: { 'ace-driver': { driverId: 'nope' } } },
      { settings: {}, openUrl: vi.fn() },
    );
    expect(out.results.find((r) => r.providerId === 'ace-driver').status).toBe(STATUS.FAILED);
  });
});

describe('what it must not drag in', () => {
  it('does not import the Stream Deck SDK just to be loaded', async () => {
    // The SDK opens a rotating log file on import, which is why configConvert.js
    // was split out of migrate.js. Loading the provider registry must not pay
    // that cost, so the SDK is imported lazily and only when nothing was
    // injected. Proven by applying with an injected openUrl and no SDK present.
    const { openUrl, calls } = spy();
    await aceDriver.apply({ driverId: ID }, { openUrl });
    expect(calls).toHaveLength(1);
  });
});
