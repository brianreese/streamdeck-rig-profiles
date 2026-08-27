import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { handlePiRequest, validateProfiles, profilesToYaml } from './piBridge.js';
import { saveAvatar, loadAvatarDataUri, deleteAvatar, MAX_BYTES } from './avatars.js';
import { _resetForTesting } from './providers/index.js';

const silent = { warn: () => {}, info: () => {} };

function fakeSettings(initial = {}) {
  let store = initial;
  return {
    written: () => store,
    async getGlobalSettings() { return store; },
    async setGlobalSettings(next) { store = next; },
  };
}

const validProfile = (over = {}) => ({
  id: 'kai', name: 'Kai', color: '#22AA44',
  providers: { 'fanatec-base': { setup: 2 } }, ...over,
});

beforeEach(() => _resetForTesting());

describe('validateProfiles', () => {
  it('accepts a well-formed profile', () => {
    expect(validateProfiles([validProfile()]).ok).toBe(true);
  });

  it('rejects a missing name', () => {
    const { ok, errors } = validateProfiles([validProfile({ name: '  ' })]);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/needs a name/);
  });

  it('rejects a malformed colour', () => {
    expect(validateProfiles([validProfile({ color: 'green' })]).ok).toBe(false);
  });

  it('rejects duplicate ids, which would make one key unreachable', () => {
    const { ok, errors } = validateProfiles([validProfile(), validProfile({ name: 'Kai 2' })]);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/duplicate/);
  });

  it('rejects an out-of-range wheelbase slot', () => {
    const bad = validProfile({ providers: { 'fanatec-base': { setup: 9 } } });
    expect(validateProfiles([bad]).ok).toBe(false);
  });

  it('tolerates provider ids this build does not know', () => {
    const future = validProfile({ providers: { 'some-future-thing': { x: 1 } } });
    expect(validateProfiles([future]).ok).toBe(true);
  });
});

describe('saveProfiles', () => {
  it('refuses to save an invalid list', async () => {
    const settings = fakeSettings({ profiles: [validProfile()] });
    const reply = await handlePiRequest(
      { request: 'saveProfiles', profiles: [validProfile({ color: 'nope' })] },
      { settings, logger: silent },
    );
    expect(reply.ok).toBe(false);
    expect(settings.written().profiles[0].color).toBe('#22AA44');
  });

});

describe('provider options', () => {
  it('returns an empty list rather than throwing when hardware is absent', async () => {
    const reply = await handlePiRequest(
      { request: 'getProviderOptions', providerId: 'nope' },
      { settings: fakeSettings(), logger: silent },
    );
    expect(reply.options).toEqual([]);
  });
});

describe('profilesToYaml', () => {
  it('emits the providers map verbatim', () => {
    const out = yaml.load(
      profilesToYaml({ profiles: [validProfile({ restricted: true })], settings: {} }),
    );
    expect(out.profiles[0]).toMatchObject({
      id: 'kai', name: 'Kai', restricted: true,
      providers: { 'fanatec-base': { setup: 2 } },
    });
  });

  it('round-trips a provider this build has never heard of', () => {
    // The point of dumping the map verbatim: exporting and re-importing must
    // not quietly drop hardware added by a future version.
    const exotic = validProfile({
      providers: { 'warp-drive': { coils: 3, mode: 'cruise' } },
    });
    const out = yaml.load(profilesToYaml({ profiles: [exotic], settings: {} }));
    expect(out.profiles[0].providers['warp-drive']).toEqual({ coils: 3, mode: 'cruise' });
  });

  it('omits the providers key entirely when a profile configures nothing', () => {
    const out = yaml.load(
      profilesToYaml({ profiles: [validProfile({ providers: {} })], settings: {} }),
    );
    expect(out.profiles[0].providers).toBeUndefined();
  });
});

describe('provider-driven validation', () => {
  it('lets each provider reject its own bad config', () => {
    const bad = validProfile({ providers: { 'fanatec-base': { setup: 99 } } });
    const { ok, errors } = validateProfiles([bad]);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/wheelbase setup must be 1-5/);
  });

  it('rejects an enabled apps provider with nothing to run', () => {
    const bad = validProfile({ providers: { apps: { commands: '   \n# just a comment' } } });
    const { ok, errors } = validateProfiles([bad]);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/no commands/);
  });

  it('accepts a profile that configures no hardware at all', () => {
    // A space-sim profile may have nothing to say about a wheelbase.
    expect(validateProfiles([validProfile({ providers: {} })]).ok).toBe(true);
  });
});

describe('avatars', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const dir = () => mkdtempSync(join(tmpdir(), 'avatars-'));

  it('stores and reads back an image as a data uri', () => {
    const d = dir();
    const { filename } = saveAvatar('kai', png.toString('base64'), 'photo.png', { dir: d });
    expect(existsSync(join(d, filename))).toBe(true);
    expect(loadAvatarDataUri(filename, { dir: d })).toMatch(/^data:image\/png;base64,/);
  });

  it('rejects an unsupported file type', () => {
    expect(() => saveAvatar('kai', png.toString('base64'), 'evil.exe', { dir: dir() }))
      .toThrow(/unsupported/);
  });

  it('rejects an oversized image', () => {
    const big = Buffer.alloc(MAX_BYTES + 1).toString('base64');
    expect(() => saveAvatar('kai', big, 'huge.png', { dir: dir() })).toThrow(/limit is 2MB/);
  });

  it('sanitises the profile id so it cannot escape the avatar directory', () => {
    const d = dir();
    const { filename } = saveAvatar('../../etc/passwd', png.toString('base64'), 'x.png', { dir: d });
    expect(filename).not.toContain('..');
    expect(filename).not.toContain('/');
  });

  it('refuses to read a path outside the avatar directory', () => {
    expect(loadAvatarDataUri('../../../secrets.png', { dir: dir() })).toBeNull();
  });

  it('returns null for a missing file so the key falls back to an initial', () => {
    expect(loadAvatarDataUri('gone.png', { dir: dir() })).toBeNull();
  });

  it('replaces a previous avatar rather than accumulating files', () => {
    const d = dir();
    saveAvatar('kai', png.toString('base64'), 'a.png', { dir: d });
    const { filename } = saveAvatar('kai', png.toString('base64'), 'b.jpg', { dir: d });
    expect(existsSync(join(d, 'kai.png'))).toBe(false);
    expect(filename).toBe('kai.jpg');
  });

  it('deletes only within the avatar directory', () => {
    const d = dir();
    const { filename } = saveAvatar('kai', png.toString('base64'), 'a.png', { dir: d });
    expect(deleteAvatar('../outside.png', { dir: d })).toBe(false);
    expect(deleteAvatar(filename, { dir: d })).toBe(true);
  });
});

describe('import marker', () => {
  it('preserves importedFrom so a saved edit survives the next start', async () => {
    // Clearing it made every restart look like a fresh yaml and silently
    // re-imported over the top of the user's edits.
    const settings = fakeSettings({ profiles: [], importedFrom: 'abc123' });
    await handlePiRequest(
      { request: 'saveProfiles', profiles: [validProfile()], settings: {} },
      { settings, logger: silent },
    );
    expect(settings.written().importedFrom).toBe('abc123');
  });
});
