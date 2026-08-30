import { describe, it, expect, beforeEach } from 'vitest';
import { applyProfile, readModeState, unapplyMode, summarise } from './profileSwitch.js';
import { register, _resetForTesting, STATUS, worstOf } from './providers/index.js';

/** Build a stub provider with scripted behaviour. */
function stub(id, { verifiable = true, apply, verify, contexts = ['profile', 'mode'] } = {}) {
  return {
    id,
    label: id,
    verifiable,
    contexts,
    describe: () => id,
    apply: apply ?? (async () => {}),
    verify: verify ?? (async () => ({ status: STATUS.VERIFIED, detail: 'ok' })),
  };
}

beforeEach(() => {
  _resetForTesting();
});

describe('worstOf', () => {
  it('returns skipped for no results', () => {
    expect(worstOf([])).toBe(STATUS.SKIPPED);
  });

  it('lets the worst status win over a verified one', () => {
    expect(
      worstOf([{ status: STATUS.VERIFIED }, { status: STATUS.UNREACHABLE }]),
    ).toBe(STATUS.UNREACHABLE);
  });

  it('ranks mismatch worse than applied-unverified', () => {
    expect(
      worstOf([{ status: STATUS.APPLIED_UNVERIFIED }, { status: STATUS.MISMATCH }]),
    ).toBe(STATUS.MISMATCH);
  });
});

describe('applyProfile', () => {
  it('is skipped when the profile configures nothing', async () => {
    const out = await applyProfile({ providers: {} });
    expect(out.status).toBe(STATUS.SKIPPED);
    expect(out.results).toEqual([]);
  });

  it('reports verified when every provider confirms', async () => {
    register(stub('a'));
    register(stub('b'));
    const out = await applyProfile({ providers: { a: {}, b: {} } });
    expect(out.status).toBe(STATUS.VERIFIED);
    expect(out.results).toHaveLength(2);
  });

  it('never lets one provider failing stop the others', async () => {
    const applied = [];
    register(stub('boom', { apply: async () => { throw new Error('bridge offline'); } }));
    register(stub('fine', { apply: async () => { applied.push('fine'); } }));

    const out = await applyProfile({ providers: { boom: {}, fine: {} } });

    expect(applied).toContain('fine');
    expect(out.results.find((r) => r.providerId === 'fine').status).toBe(STATUS.VERIFIED);
    expect(out.results.find((r) => r.providerId === 'boom').status).toBe(STATUS.FAILED);
    expect(out.status).toBe(STATUS.FAILED);
  });

  it('takes the provider at its word instead of overriding it', async () => {
    // The parent used to stamp applied-unverified whenever a provider declared
    // verifiable:false, without calling verify() at all — so a provider could
    // not define what success meant for it. Govee cannot read a lamp but does
    // know the command reached the device, and that is its bar to set.
    register(
      stub('blind', {
        verifiable: false,
        verify: async () => ({ status: STATUS.VERIFIED, detail: 'delivered' }),
      }),
    );
    const out = await applyProfile({ providers: { blind: {} } });
    expect(out.status).toBe(STATUS.VERIFIED);
    expect(out.results[0].detail).toBe('delivered');
  });

  it('falls back to applied-unverified only when there is nothing to ask', async () => {
    const mute = { id: 'mute', label: 'mute', describe: () => 'mute', apply: async () => {} };
    register(mute);
    const out = await applyProfile({ providers: { mute: {} } });
    expect(out.status).toBe(STATUS.APPLIED_UNVERIFIED);
    expect(out.results[0].detail).toMatch(/does not report an outcome/);
  });

  it('treats a mismatch as a failure, not a success', async () => {
    register(
      stub('wheel', {
        verify: async () => ({ status: STATUS.MISMATCH, detail: 'asked S2, got S1' }),
      }),
    );
    const out = await applyProfile({ providers: { wheel: {} } });
    expect(out.status).toBe(STATUS.MISMATCH);
    expect(summarise(out)).toContain('asked S2, got S1');
  });

  it('treats a throwing verify as unreachable rather than crashing', async () => {
    register(stub('flaky', { verify: async () => { throw new Error('timeout'); } }));
    const out = await applyProfile({ providers: { flaky: {} } });
    expect(out.status).toBe(STATUS.UNREACHABLE);
  });

  it('skips unknown provider ids without throwing, so config outlives code', async () => {
    register(stub('known'));
    const out = await applyProfile({ providers: { known: {}, 'not-built-yet': {} } });
    expect(out.status).toBe(STATUS.VERIFIED);
    expect(out.results.find((r) => r.providerId === 'not-built-yet').status).toBe(STATUS.SKIPPED);
  });

  it('runs the streamdeck provider last so it cannot race the renders', async () => {
    const order = [];
    register(stub('streamdeck', { apply: async () => { order.push('streamdeck'); } }));
    register(stub('slow', {
      apply: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('slow');
      },
    }));

    await applyProfile({ providers: { streamdeck: {}, slow: {} } });
    expect(order).toEqual(['slow', 'streamdeck']);
  });
});

describe('provider context', () => {
  it('passes global settings through, so credentials reach providers', async () => {
    // This was documented but never wired: any provider needing an API key
    // failed with "no key set" no matter how it was configured.
    let seen = null;
    register(stub('needs-key', { apply: async (_cfg, ctx) => { seen = ctx.settings; } }));
    await applyProfile(
      { id: 'p', providers: { 'needs-key': {} } },
      { settings: { goveeApiKey: 'abc123' } },
    );
    expect(seen).toEqual({ goveeApiKey: 'abc123' });
  });

  it('gives providers the profile id so per-profile state can be keyed', async () => {
    let seen = null;
    register(stub('keyed', { apply: async (_cfg, ctx) => { seen = ctx.profileId; } }));
    await applyProfile({ id: 'kai', providers: { keyed: {} } }, {});
    expect(seen).toBe('kai');
  });

  it('defaults settings to an empty object rather than undefined', async () => {
    let seen = 'unset';
    register(stub('nosettings', { apply: async (_cfg, ctx) => { seen = ctx.settings; } }));
    await applyProfile({ id: 'p', providers: { nosettings: {} } }, {});
    expect(seen).toEqual({});
  });
});

describe('mode references', () => {
  const mode = (id, providers) => ({ id, name: id, providers });

  it('runs a referenced mode alongside the profile', async () => {
    register(stub('wheel'));
    register(stub('lights'));
    const out = await applyProfile(
      { id: 'brian', providers: { wheel: {} }, modes: ['ambient'] },
      { modes: [mode('ambient', { lights: {} })] },
    );
    expect(out.results.map((r) => r.providerId).sort()).toEqual(['lights', 'wheel']);
  });



  it('survives a reference to a mode that no longer exists', async () => {
    const logs = [];
    register(stub('wheel'));
    const out = await applyProfile(
      { id: 'brian', providers: { wheel: {} }, modes: ['deleted'] },
      { modes: [], log: (m) => logs.push(m) },
    );
    expect(out.status).toBe(STATUS.VERIFIED);
    expect(logs.join(' ')).toMatch(/references missing mode "deleted"/);
  });

  it('applies a mode on its own, since it is the same shape', async () => {
    register(stub('lights'));
    const out = await applyProfile({ id: 'ambient', providers: { lights: {} } });
    expect(out.status).toBe(STATUS.VERIFIED);
  });
});

describe('profile first, mode second', () => {
  const mode = (id, providers) => ({ id, name: id, providers });

  it('runs the profile then the mode, so the mode wins a conflict', async () => {
    // The ordering IS the conflict rule. Where both set the lights, the scene
    // runs last and therefore wins — no special-casing needed.
    const seen = [];
    register(stub('lights', { apply: async (cfg) => { seen.push(cfg); } }));
    await applyProfile(
      { id: 'brian', providers: { lights: { scene: 'from-profile' } }, modes: ['other'] },
      { modes: [mode('other', { lights: { scene: 'from-scene' } })] },
    );
    expect(seen).toEqual([{ scene: 'from-profile' }, { scene: 'from-scene' }]);
  });

  it('runs both when they are additive rather than conflicting', async () => {
    // A profile's script preparing SimHub and a scene's script starting a
    // playlist are both wanted. Deduplicating silently dropped one of them.
    const ran = [];
    register(stub('apps', { apply: async (cfg) => { ran.push(cfg.cmd); } }));
    await applyProfile(
      { id: 'brian', providers: { apps: { cmd: 'simhub' } }, modes: ['music'] },
      { modes: [mode('music', { apps: { cmd: 'spotify' } })] },
    );
    expect(ran).toEqual(['simhub', 'spotify']);
  });

  it('names the mode on its results, so two runs of one provider are legible', async () => {
    register(stub('apps'));
    const out = await applyProfile(
      { id: 'brian', providers: { apps: {} }, modes: ['music'] },
      { modes: [mode('music', { apps: {} })] },
    );
    expect(out.results.map((r) => r.label)).toEqual(['apps', 'apps (mode "music")']);
  });
});

describe('providers declare where they may be used', () => {
  const mode = (id, providers) => ({ id, name: id, providers });

  it('drops a profile-only provider a mode tries to configure', async () => {
    const logs = [];
    register(stub('wheel', { contexts: ['profile'] }));
    const out = await applyProfile(
      { id: 'brian', providers: {}, modes: ['bad'] },
      { modes: [mode('bad', { wheel: {} })], log: (m) => logs.push(m) },
    );
    expect(out.results).toHaveLength(0);
    expect(logs.join(' ')).toMatch(/not available to a mode/);
  });

  it('drops it just as firmly when the mode is run directly', async () => {
    // sceneKey applies a scene through this same function, so the guard has to
    // hold on that path too — a hand-edited config must not reach the pedal.
    const logs = [];
    register(stub('wheel', { contexts: ['profile'] }));
    const out = await applyProfile(
      { id: 'ambient', providers: { wheel: {} } },
      { context: 'mode', log: (m) => logs.push(m) },
    );
    expect(out.status).toBe(STATUS.SKIPPED);
    expect(logs.join(' ')).toMatch(/not available to a mode/);
  });

  it('still lets a profile use a profile-only provider', async () => {
    register(stub('wheel', { contexts: ['profile'] }));
    const out = await applyProfile({ id: 'brian', providers: { wheel: {} } });
    expect(out.status).toBe(STATUS.VERIFIED);
  });

  it('treats an undeclared provider as profile-only, the safe default', async () => {
    const legacy = { id: 'old', label: 'old', describe: () => 'old', apply: async () => {},
                     verify: async () => ({ status: STATUS.VERIFIED, detail: 'ok' }) };
    register(legacy);
    const out = await applyProfile({ id: 'x', providers: { old: {} } }, { context: 'mode' });
    expect(out.status).toBe(STATUS.SKIPPED);
  });
});

describe('a Mode reports what its providers can answer', () => {
  const reporting = (id, active) => ({
    id, label: id, contexts: ['profile', 'mode'], describe: () => id,
    apply: async () => {},
    unapply: async () => {},
    isActive: async () => active,
    verify: async () => ({ status: STATUS.VERIFIED, detail: 'ok' }),
  });

  it('claims nothing when nothing in it can tell', async () => {
    // Lighting and scripts cannot honestly answer "are you currently on", so a
    // Mode of only those has no state — and must not pretend to.
    register(stub('lights'));
    expect(await readModeState({ id: 'm', providers: { lights: {} } })).toBeNull();
  });

  it('is on only when every reporting provider agrees', async () => {
    register(reporting('flagA', true));
    register(reporting('flagB', true));
    expect(await readModeState({ id: 'm', providers: { flagA: {}, flagB: {} } })).toBe(true);
  });

  it('is off if any one of them says so', async () => {
    register(reporting('flagA', true));
    register(reporting('flagB', false));
    expect(await readModeState({ id: 'm', providers: { flagA: {}, flagB: {} } })).toBe(false);
  });

  it('ignores providers that cannot answer, rather than counting them as agreement', async () => {
    // The whole point of the aggregation rule: a script riding along in a VR
    // Mode must not be able to make it read as on.
    register(reporting('flag', true));
    register(stub('lights'));
    register(stub('apps'));
    expect(await readModeState({ id: 'm', providers: { flag: {}, lights: {}, apps: {} } })).toBe(true);
  });

  it('counts a provider that throws as off, never as on', async () => {
    // Unreadable state is not active state. Pressing the key re-applies and recovers.
    const logs = [];
    register({ ...reporting('flag', true), isActive: async () => { throw new Error('file gone'); } });
    expect(await readModeState({ id: 'm', providers: { flag: {} } }, { log: (m) => logs.push(m) })).toBe(false);
    expect(logs.join(' ')).toMatch(/could not report state/);
  });
});

describe('switching a Mode off', () => {
  it('reverses only the providers that can be reversed', async () => {
    // Turning VR off must not try to undo a throwaway script.
    const undone = [];
    register({
      id: 'flag', label: 'flag', contexts: ['profile', 'mode'], describe: () => 'flag',
      apply: async () => {}, unapply: async () => { undone.push('flag'); },
      isActive: async () => false, verify: async () => ({ status: STATUS.VERIFIED, detail: 'ok' }),
    });
    register(stub('apps'));
    const out = await unapplyMode({ id: 'm', providers: { flag: {}, apps: {} } });
    expect(undone).toEqual(['flag']);
    expect(out.results.map((r) => r.providerId)).toEqual(['flag']);
  });

  it('is skipped entirely when nothing can be reversed', async () => {
    register(stub('apps'));
    expect((await unapplyMode({ id: 'm', providers: { apps: {} } })).status).toBe(STATUS.SKIPPED);
  });

  it('reports a failure to reverse rather than throwing', async () => {
    register({
      id: 'flag', label: 'flag', contexts: ['profile', 'mode'], describe: () => 'flag',
      apply: async () => {}, unapply: async () => { throw new Error('read-only'); },
      isActive: async () => true, verify: async () => ({ status: STATUS.VERIFIED, detail: 'ok' }),
    });
    const out = await unapplyMode({ id: 'm', providers: { flag: {} } });
    expect(out.status).toBe(STATUS.FAILED);
    expect(out.results[0].detail).toMatch(/read-only/);
  });
});
