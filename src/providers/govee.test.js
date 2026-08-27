import { describe, it, expect, beforeEach, vi } from 'vitest';
import govee, { _resetForTesting } from './govee.js';
import { STATUS } from './status.js';

vi.mock('../govee.js', () => ({
  init: vi.fn(async () => {}),
  getSceneNames: vi.fn(() => ['Racing', 'Kid Mode']),
  activateScene: vi.fn(),
}));

const { activateScene } = await import('../govee.js');
const ctx = { settings: { goveeApiKey: 'key', goveeDevices: null } };

beforeEach(() => {
  _resetForTesting();
  activateScene.mockReset();
});

describe('apply', () => {
  it('fails when a scene reached no device, rather than looking successful', async () => {
    // Every per-device call can "succeed" by not throwing while the scene still
    // matched nothing. That used to leave the lights unchanged and the key amber.
    activateScene.mockResolvedValue({ sent: 0, skipped: 3, failed: [], targets: 3 });
    await expect(govee.apply({ scene: 'Nope' }, ctx)).rejects.toThrow(/reached no device/);
  });

  it('surfaces the API error when one is reported', async () => {
    activateScene.mockResolvedValue({
      sent: 0, skipped: 0, targets: 1,
      failed: ['Rig Corner: Govee code 401 invalid key'],
    });
    await expect(govee.apply({ scene: 'Racing' }, ctx)).rejects.toThrow(/401 invalid key/);
  });

  it('succeeds when at least one device accepted it', async () => {
    activateScene.mockResolvedValue({ sent: 2, skipped: 1, failed: [], targets: 3 });
    await expect(govee.apply({ scene: 'Racing' }, ctx)).resolves.toBeUndefined();
  });

  it('refuses without an API key', async () => {
    await expect(govee.apply({ scene: 'Racing' }, { settings: {} })).rejects.toThrow(/API key/);
  });

  it('refuses without a scene', async () => {
    await expect(govee.apply({}, ctx)).rejects.toThrow(/no scene/);
  });
});

describe('verify', () => {
  it('reports how many devices accepted the scene', async () => {
    activateScene.mockResolvedValue({ sent: 2, skipped: 1, failed: [], targets: 3 });
    await govee.apply({ scene: 'Racing' }, ctx);
    const out = await govee.verify({ scene: 'Racing' });
    expect(out.status).toBe(STATUS.APPLIED_UNVERIFIED);
    expect(out.detail).toMatch(/accepted by 2 of 3/);
    expect(out.detail).toMatch(/1 lack that scene/);
  });

  it('never claims verified, because Govee does not report lamp state', async () => {
    activateScene.mockResolvedValue({ sent: 3, skipped: 0, failed: [], targets: 3 });
    await govee.apply({ scene: 'Racing' }, ctx);
    expect((await govee.verify({ scene: 'Racing' })).status).not.toBe(STATUS.VERIFIED);
  });
});

describe('contract', () => {
  it('declares itself unverifiable', () => {
    expect(govee.verifiable).toBe(false);
  });

  it('requires a scene to be selected', () => {
    expect(govee.validate({})).toHaveLength(1);
    expect(govee.validate({ scene: 'Racing' })).toEqual([]);
  });
});
