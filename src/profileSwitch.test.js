import { describe, it, expect, beforeEach } from 'vitest';
import { applyProfile, summarise } from './profileSwitch.js';
import { register, _resetForTesting, STATUS, worstOf } from './providers/index.js';

/** Build a stub provider with scripted behaviour. */
function stub(id, { verifiable = true, apply, verify } = {}) {
  return {
    id,
    label: id,
    verifiable,
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

  it('does NOT report verified when a provider cannot read back', async () => {
    register(stub('blind', { verifiable: false }));
    const out = await applyProfile({ providers: { blind: {} } });
    expect(out.status).toBe(STATUS.APPLIED_UNVERIFIED);
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
