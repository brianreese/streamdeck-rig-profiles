import { describe, it, expect, vi } from 'vitest';
import { saveGlobalSettings, assessStore } from './settingsStore.js';

const store = (initial = {}) => {
  let blob = initial;
  return {
    getGlobalSettings: async () => blob,
    setGlobalSettings: async (next) => {
      blob = next;
    },
    read: () => blob,
  };
};

describe('every write is mirrored', () => {
  it('backs up whatever it just stored', async () => {
    const backup = vi.fn(() => ({ written: true }));
    const s = store();
    await saveGlobalSettings(s, { profiles: [{ id: 'brian' }] }, { backup });
    // shrink: true — an explicit save is intentional, so the mirror must accept
    // a smaller blob. Only the startup snapshot refuses one.
    expect(backup).toHaveBeenCalledWith({ profiles: [{ id: 'brian' }] }, { shrink: true });
    expect(s.read().profiles).toHaveLength(1);
  });

  it('still saves when the mirror throws', async () => {
    // A failed backup must never become an outage; it is a net, not a gate.
    const log = vi.fn();
    const s = store();
    await saveGlobalSettings(s, { profiles: [{ id: 'a' }] }, {
      backup: () => { throw new Error('disk full'); },
      log,
    });
    expect(s.read().profiles).toHaveLength(1);
    expect(log.mock.calls[0][0]).toMatch(/disk full/);
  });
});

describe('recovery at startup', () => {
  it('does nothing on a genuinely fresh install', async () => {
    const s = store({});
    const result = await assessStore({ settings: s, configured: () => false, read: () => null, backup: vi.fn() });
    expect(result).toEqual({ restored: false, reason: 'first run' });
    expect(s.read()).toEqual({});
  });

  it('fills an EMPTY store from the backup, because that overwrites nothing', async () => {
    // A PC restart on 2026-09-04 brought Stream Deck back with nothing. Leaving
    // it empty meant the deck stayed broken until an adult opened a browser,
    // which is not a thing a child at the rig can do.
    //
    // This does not break "never overwrite without asking": an empty store has
    // no configuration to overwrite. PARTIAL loss still only ever offers.
    const s = store({});
    const result = await assessStore({
      settings: s,
      configured: () => true,
      read: () => ({
        savedAt: '2026-09-04T02:19:01.540Z',
        source: 'settings.backup.json',
        settings: {
          profiles: [{ id: 'brian' }, { id: 'ethan' }, { id: 'carter' }, { id: 'guest' }],
          modes: [{ id: 'vr' }],
        },
      }),
      backup: vi.fn(),
    });
    expect(result.restored).toBe(true);
    expect(result.count).toBe(4);
    expect(s.read().profiles.map((p) => p.id)).toEqual(['brian', 'ethan', 'carter', 'guest']);
    expect(s.read().modes).toHaveLength(1);
  });

  it('says what it did, since it did it without being asked', async () => {
    const log = vi.fn();
    await assessStore({
      settings: store({}),
      configured: () => true,
      read: () => ({ savedAt: '2026-09-04T02:19:01.540Z', settings: { profiles: [{ id: 'a' }] } }),
      backup: vi.fn(),
      log,
    });
    expect(log.mock.calls.join(' ')).toMatch(/store was empty — restored/i);
  });

  it('says so loudly when it knows data was lost and cannot get it back', async () => {
    const log = vi.fn();
    const s = store({});
    const result = await assessStore({ settings: s, configured: () => true, read: () => null, backup: vi.fn(), log });
    expect(result.reason).toBe('no usable backup');
    expect(log.mock.calls[0][0]).toMatch(/NOT re-seeding/);
    expect(s.read()).toEqual({});
  });

  it('leaves a healthy store alone and checkpoints it', async () => {
    // Startup is a risky moment — whatever happens next, this is the version to
    // step back to — so it takes a generation rather than only a mirror.
    const checkpoint = vi.fn();
    const s = store({ profiles: [{ id: 'brian' }] });
    const result = await assessStore({
      settings: s, configured: () => true, read: () => null, backup: vi.fn(), checkpoint,
    });
    expect(result.restored).toBe(false);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(checkpoint.mock.calls[0][1]).toBe('startup');
  });

});



describe('secrets never reach the store or the mirror', () => {
  const withKey = () => ({
    profiles: [{ id: 'brian' }],
    settings: { goveeApiKey: 'leaky', mozaClosePitHouse: true },
  });

  it('strips a declared secret on the way in', async () => {
    const s = store();
    const harvested = [];
    await saveGlobalSettings(s, withKey(), {
      backup: vi.fn(),
      secretKeys: () => ['goveeApiKey'],
      harvest: (blob, keys) => {
        harvested.push(...keys);
        const { goveeApiKey, ...rest } = blob.settings;
        return { blob: { ...blob, settings: rest }, harvested: ['goveeApiKey'] };
      },
    });
    expect(harvested).toEqual(['goveeApiKey']);
    expect(s.read().settings.goveeApiKey).toBeUndefined();
    expect(s.read().settings.mozaClosePitHouse).toBe(true);
  });

  it('mirrors the stripped blob, not the original', async () => {
    // The load-bearing one. A mirror taken before the strip is a backup file
    // on disk containing the credential, which is the thing being prevented.
    const backup = vi.fn();
    await saveGlobalSettings(store(), withKey(), {
      backup,
      secretKeys: () => ['goveeApiKey'],
      harvest: (blob) => {
        const { goveeApiKey, ...rest } = blob.settings;
        return { blob: { ...blob, settings: rest }, harvested: ['goveeApiKey'] };
      },
    });
    expect(JSON.stringify(backup.mock.calls[0][0])).not.toContain('leaky');
  });

  it('harvests at startup too, so an unedited machine still migrates', async () => {
    // assessStore mirrors directly rather than through saveGlobalSettings.
    // Without its own harvest, the first mirror on an upgrading machine would
    // be the one carrying the key.
    const checkpoint = vi.fn();
    const s = store(withKey());
    const result = await assessStore({
      settings: s,
      configured: () => true,
      read: () => null,
      checkpoint,
      secretKeys: () => ['goveeApiKey'],
      harvest: (blob) => {
        const { goveeApiKey, ...rest } = blob.settings;
        return { blob: { ...blob, settings: rest }, harvested: ['goveeApiKey'] };
      },
    });
    expect(result.harvested).toEqual(['goveeApiKey']);
    expect(s.read().settings.goveeApiKey).toBeUndefined();
    expect(JSON.stringify(checkpoint.mock.calls[0][0])).not.toContain('leaky');
  });
});
