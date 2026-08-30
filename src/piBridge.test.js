import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { handlePiRequest, validateProfiles, validateModes, profilesToYaml } from './piBridge.js';
import { saveAvatar, loadAvatarDataUri, deleteAvatar, MAX_BYTES } from './avatars.js';
import { _resetForTesting, register, allProviders, reportsState } from './providers/index.js';

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

describe('validateModes', () => {
  const validMode = (over = {}) => ({
    id: 'sunset', name: 'Sunset', color: '#7C5CFF',
    providers: { govee: { scene: 'Sunset' } }, ...over,
  });

  it('accepts a well-formed mode', () => {
    expect(validateModes([validMode()]).ok).toBe(true);
  });

  it('holds a mode to the same structural rules as a profile', () => {
    expect(validateModes([validMode({ color: 'violet' })]).ok).toBe(false);
    expect(validateModes([validMode({ name: '  ' })]).ok).toBe(false);
    expect(validateModes([validMode(), validMode({ name: 'Sunset 2' })]).ok).toBe(false);
  });

  it('applies each provider validate() to mode config exactly as to a profile', () => {
    const bad = validMode({ providers: { 'fanatec-base': { setup: 99 } } });
    const { ok, errors } = validateModes([bad]);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/wheelbase setup must be 1-5/);
  });

  it('refuses a restricted mode — a hold gate in front of nothing', () => {
    // A mode never writes the shared active-profile state, so it cannot hand
    // a child full force feedback and has nothing to gate. Storing the flag
    // would also suggest modes carry the authority profiles do.
    const { ok, errors } = validateModes([validMode({ restricted: true })]);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/nothing to gate/);
  });

  it('rejects a mode list that is not a list', () => {
    expect(validateModes(undefined).ok).toBe(false);
  });
});

describe('mode references on a profile', () => {
  it('accepts a profile referencing a mode that exists', () => {
    const p = validProfile({ modes: ['sunset'] });
    expect(validateProfiles([p], { modeIds: ['sunset'] }).ok).toBe(true);
  });

  it('refuses a profile referencing a mode that does not', () => {
    // Not cosmetic: the runtime skips the missing mode with a log line nobody
    // reads, so the lights quietly do not come on.
    const p = validProfile({ modes: ['gone'] });
    const { ok, errors } = validateProfiles([p], { modeIds: ['sunset'] });
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/references a mode that does not exist \("gone"\)/);
  });

  it('does not check references at all when no mode list is given', () => {
    // A caller that only has profiles to hand must not be made to invent an
    // empty mode list, which would reject every reference.
    expect(validateProfiles([validProfile({ modes: ['sunset'] })]).ok).toBe(true);
  });
});

describe('saveProfiles with modes', () => {
  const aMode = { id: 'sunset', name: 'Sunset', color: '#7C5CFF', providers: {} };

  it('stores modes as a sibling of profiles', async () => {
    const settings = fakeSettings({ profiles: [] });
    const reply = await handlePiRequest(
      { request: 'saveProfiles', profiles: [validProfile()], modes: [aMode] },
      { settings, logger: silent },
    );
    expect(reply.ok).toBe(true);
    expect(settings.written().modes).toEqual([aMode]);
    expect(settings.written().profiles).toHaveLength(1);
  });

  it('carries stored modes through a save that does not mention them', async () => {
    // The property inspector knows nothing about modes. Its save must not be
    // able to erase them.
    const settings = fakeSettings({ profiles: [], modes: [aMode] });
    await handlePiRequest(
      { request: 'saveProfiles', profiles: [validProfile()] },
      { settings, logger: silent },
    );
    expect(settings.written().modes).toEqual([aMode]);
  });

  it('refuses the whole save when a mode is malformed, leaving both lists alone', async () => {
    const settings = fakeSettings({ profiles: [validProfile()], modes: [aMode] });
    const reply = await handlePiRequest(
      {
        request: 'saveProfiles',
        profiles: [validProfile({ name: 'Renamed' })],
        modes: [{ ...aMode, color: 'violet' }],
      },
      { settings, logger: silent },
    );
    expect(reply.ok).toBe(false);
    expect(reply.modeErrors.join()).toMatch(/colour/);
    expect(settings.written().profiles[0].name).toBe('Kai');
    expect(settings.written().modes).toEqual([aMode]);
  });

  it('validates a profile reference against the modes in the same request', async () => {
    // One request, so the pair is judged together — there is no window where a
    // stored profile names a mode that has not been written yet.
    const settings = fakeSettings({ profiles: [] });
    const reply = await handlePiRequest(
      {
        request: 'saveProfiles',
        profiles: [validProfile({ modes: ['sunset'] })],
        modes: [aMode],
      },
      { settings, logger: silent },
    );
    expect(reply.ok).toBe(true);
    expect(settings.written().profiles[0].modes).toEqual(['sunset']);
  });

  it('reports profile and mode problems separately, so the editor can place them', async () => {
    const settings = fakeSettings({ profiles: [] });
    const reply = await handlePiRequest(
      {
        request: 'saveProfiles',
        profiles: [validProfile({ modes: ['nope'] })],
        modes: [aMode],
      },
      { settings, logger: silent },
    );
    expect(reply.ok).toBe(false);
    expect(reply.errors.join()).toMatch(/references a mode/);
    expect(reply.modeErrors).toEqual([]);
  });

  it('lists modes back to the editor', async () => {
    const reply = await handlePiRequest(
      { request: 'getProfiles' },
      { settings: fakeSettings({ profiles: [], modes: [aMode] }), logger: silent },
    );
    expect(reply.modes).toEqual([aMode]);
  });

  it('returns an empty mode list rather than undefined on a config that predates modes', async () => {
    const reply = await handlePiRequest(
      { request: 'getProfiles' },
      { settings: fakeSettings({ profiles: [validProfile()] }), logger: silent },
    );
    expect(reply.modes).toEqual([]);
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

describe('getProviders', () => {
  // Stubs registered over every built-in id, so the registry holds these and
  // nothing else: the real providers enumerate live hardware from options(),
  // and a unit test must not go looking for a wheelbase.
  const stub = (id, over = {}) => ({ id, label: id, verifiable: true, schema: () => [], ...over });

  beforeEach(() => {
    register(stub('fanatec-base', { contexts: ['profile'] }));
    register(stub('moza', { contexts: ['profile'] }));
    register(stub('govee', { contexts: ['profile', 'mode'] }));
    register(stub('apps', { contexts: ['profile', 'mode'] }));
    // Same contexts as Govee, and unlike Govee it can answer for itself. The
    // pair is the point: the two capabilities are independent.
    register(stub('state-flag', { contexts: ['profile', 'mode'], isActive: async () => true }));
  });

  const contextsOf = async () => {
    const reply = await handlePiRequest(
      { request: 'getProviders' }, { settings: fakeSettings(), logger: silent });
    return Object.fromEntries(reply.providers.map((p) => [p.id, p.contexts]));
  };

  const reportsStateOf = async () => {
    const reply = await handlePiRequest(
      { request: 'getProviders' }, { settings: fakeSettings(), logger: silent });
    return Object.fromEntries(reply.providers.map((p) => [p.id, p.reportsState]));
  };

  // The editor cannot know which providers belong on a Mode; the provider is
  // the only thing that does. This is how it gets told.
  it("passes each provider's declared contexts through to the editor", async () => {
    expect(await contextsOf()).toEqual({
      'fanatec-base': ['profile'],
      moza: ['profile'],
      govee: ['profile', 'mode'],
      apps: ['profile', 'mode'],
      'state-flag': ['profile', 'mode'],
    });
  });

  // A Mode's active/inactive state is derived from this and nothing else, so
  // the editor cannot say which Modes will have one without being told.
  it('tells the editor which providers can report whether they are in effect', async () => {
    expect(await reportsStateOf()).toEqual({
      'fanatec-base': false,
      moza: false,
      govee: false,
      apps: false,
      'state-flag': true,
    });
  });

  // The rule that makes the user's own VR Mode possible: a flag that reports
  // itself, lighting that cannot, and scripts that cannot, all in one Mode.
  // If declaring 'mode' implied isActive, Govee could not be in a Mode at all.
  it('does not infer one capability from the other, in either direction', async () => {
    const contexts = await contextsOf();
    const reports = await reportsStateOf();
    // Allowed in a Mode, cannot report itself.
    expect(contexts.govee).toContain('mode');
    expect(reports.govee).toBe(false);
    // Reports itself, and says so without being asked to declare it twice.
    expect(contexts['state-flag']).toContain('mode');
    expect(reports['state-flag']).toBe(true);
  });

  // Derived from the method, never from a flag a provider sets. A provider that
  // claimed to report state without implementing it would give the editor a
  // promise nothing keeps, and a key with an on/off that never moves.
  it('ignores a reportsState claim that no isActive backs up', async () => {
    register(stub('liar', { contexts: ['profile', 'mode'], reportsState: true }));
    expect((await reportsStateOf()).liar).toBe(false);
  });

  // Profile-only, because the failure worth defaulting away from is a mode
  // quietly reaching hardware nobody meant it to touch. A provider missing from
  // the editor's add list is the cheaper mistake, and the visible one.
  it('treats a provider that declares nothing as profile-only', async () => {
    register(stub('mystery'));
    expect((await contextsOf()).mystery).toEqual(['profile']);
  });

  it("copies the array rather than handing out the provider's own", async () => {
    const declared = ['profile', 'mode'];
    register(stub('shared', { contexts: declared }));
    const reply = await handlePiRequest(
      { request: 'getProviders' }, { settings: fakeSettings(), logger: silent });
    reply.providers.find((p) => p.id === 'shared').contexts.push('nonsense');
    expect(declared).toEqual(['profile', 'mode']);
  });
});

describe('getProviders: whether an options list can be trusted', () => {
  // The editor has to tell "this list was read and your value is not in it"
  // from "no list came back". The first means the thing the profile points at
  // is gone; the second means nothing at all, and saying "missing" for it would
  // grey out a block every time Pit House happened to be shut.
  const select = () => [{ key: 'preset', label: 'Preset', type: 'select', options: [] }];
  const stub = (id, over = {}) => ({ id, label: id, verifiable: true, schema: select, ...over });

  const fieldOf = async (id) => {
    const reply = await handlePiRequest(
      { request: 'getProviders' }, { settings: fakeSettings(), logger: silent });
    return reply.providers.find((p) => p.id === id).fields[0];
  };

  it('marks a list read back from the hardware as authoritative', async () => {
    register(stub('moza', { options: async () => [{ value: 'aaa', label: 'Kai soft' }] }));
    const field = await fieldOf('moza');
    expect(field.optionsLive).toBe(true);
    expect(field.options).toEqual([{ value: 'aaa', label: 'Kai soft' }]);
  });

  // Pit House closed, wheelbase asleep, no Govee key. The schema's own list
  // stands, and the editor is told not to draw conclusions from it.
  it('does not claim authority when enumeration comes back empty', async () => {
    register(stub('moza', { options: async () => [] }));
    expect((await fieldOf('moza')).optionsLive).toBe(false);
  });

  it('does not claim authority when enumeration throws', async () => {
    register(stub('moza', { options: async () => { throw new Error('pit house is closed'); } }));
    const field = await fieldOf('moza');
    expect(field.optionsLive).toBe(false);
    expect(field.options).toEqual([]);
  });

  // Nothing to ask: the schema is the whole domain, so it is authoritative
  // even when it is short.
  it('trusts the schema of a provider that enumerates nothing', async () => {
    register(stub('moza', { schema: () => [{ key: 'setup', type: 'select',
      options: [{ value: 1, label: 'Setup 1' }] }] }));
    expect((await fieldOf('moza')).optionsLive).toBe(true);
  });

  it('leaves fields that are not selects alone', async () => {
    register(stub('moza', {
      schema: () => [{ key: 'peakForceKg', type: 'range', min: 1, max: 9 }],
      options: async () => [{ value: 'aaa', label: 'Kai soft' }],
    }));
    expect((await fieldOf('moza')).optionsLive).toBeUndefined();
  });
});

describe('the provider contract the editor depends on', () => {
  // Not which contexts each one picked — that is the provider's business — but
  // that every one of them answers the question at all. The editor's Mode list
  // is built from these, and a provider that declares nothing silently
  // disappears from Modes rather than failing loudly.
  it('has every built-in provider declare which contexts it belongs in', () => {
    for (const provider of allProviders()) {
      expect(Array.isArray(provider.contexts), `${provider.id} declares no contexts`).toBe(true);
      expect(provider.contexts.length).toBeGreaterThan(0);
      expect(provider.contexts.every((c) => c === 'profile' || c === 'mode')).toBe(true);
    }
  });

  // Deliberately NOT asserting that a 'mode' provider implements isActive.
  // Requiring that would put Govee and Apps out of Modes entirely and take the
  // user's own VR Mode — a flag, some lighting, a throwaway script, one key —
  // with them. What must hold is the other direction: anything claiming to
  // report state has to have the method that does it.
  it('backs every reported state with an isActive that can answer', () => {
    for (const provider of allProviders()) {
      const reply = reportsState(provider);
      expect(typeof reply).toBe('boolean');
      if (reply) expect(typeof provider.isActive).toBe('function');
    }
  });

  it('has at least one built-in that can report state, and at least one that cannot', () => {
    // Otherwise the editor's two derived messages could not both be reached,
    // and one of them would be dead text nobody ever sees.
    const flags = allProviders().map(reportsState);
    expect(flags).toContain(true);
    expect(flags).toContain(false);
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

  it('exports modes and the profile references that name them', () => {
    // A committed YAML that has the references but not the modes is a file
    // describing profiles that do less than they say.
    const out = yaml.load(profilesToYaml({
      profiles: [validProfile({ modes: ['sunset'] })],
      modes: [{ id: 'sunset', name: 'Sunset', color: '#7C5CFF', providers: { govee: { scene: 'Sunset' } } }],
      settings: {},
    }));
    expect(out.profiles[0].modes).toEqual(['sunset']);
    expect(out.modes[0]).toMatchObject({
      id: 'sunset', name: 'Sunset', providers: { govee: { scene: 'Sunset' } },
    });
  });

  it('omits the modes key entirely when there are none', () => {
    const out = yaml.load(profilesToYaml({ profiles: [validProfile()], settings: {} }));
    expect(out.modes).toBeUndefined();
    expect(out.profiles[0].modes).toBeUndefined();
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

  // The editor stopped SENDING these — a provider that has just been added and
  // not yet filled in is left out of the save, so the user is not told off for
  // a state they have had no chance to leave. The rules here did not move an
  // inch, and must not: this is the check that a page which sends an empty
  // block anyway — an old tab, a hand-edited config, a bug — is still refused.
  it('still refuses an enabled provider with nothing configured on it', () => {
    const empty = validProfile({ providers: { moza: {} } });
    const { ok, errors } = validateProfiles([empty]);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/no preset or pedal setting is chosen/);
  });

  it('refuses a blank block on a mode by exactly the same rule', () => {
    const { ok, errors } = validateModes([
      { id: 'sunset', name: 'Sunset', color: '#7c5cff', providers: { govee: {} } },
    ]);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/no scene is selected/);
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
    expect(existsSync(join(d, 'profile-kai.png'))).toBe(false);
    expect(filename).toBe('profile-kai.jpg');
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

describe('global settings', () => {
  it('never echoes the api key back to the inspector', async () => {
    const settings = fakeSettings({ settings: { goveeApiKey: 'secret-key' } });
    const reply = await handlePiRequest({ request: 'getSettings' }, { settings, logger: silent });
    expect(reply.settings.goveeApiKey).toBeUndefined();
    expect(reply.settings.goveeApiKeySet).toBe(true);
  });

  it('reports when no key is set', async () => {
    const reply = await handlePiRequest(
      { request: 'getSettings' },
      { settings: fakeSettings({}), logger: silent },
    );
    expect(reply.settings.goveeApiKeySet).toBe(false);
  });

  it('keeps the existing key when the field is left blank', async () => {
    // The page cannot show the key, so a blank field means "unchanged" —
    // treating it as "clear" would wipe the key on any unrelated save.
    const settings = fakeSettings({ settings: { goveeApiKey: 'secret-key' } });
    await handlePiRequest(
      { request: 'saveSettings', settings: { goveeApiKey: '', goveeDevices: ['Strip'] } },
      { settings, logger: silent },
    );
    expect(settings.written().settings.goveeApiKey).toBe('secret-key');
    expect(settings.written().settings.goveeDevices).toEqual(['Strip']);
  });

  it('replaces the key when a new one is typed', async () => {
    const settings = fakeSettings({ settings: { goveeApiKey: 'old' } });
    await handlePiRequest(
      { request: 'saveSettings', settings: { goveeApiKey: 'new' } },
      { settings, logger: silent },
    );
    expect(settings.written().settings.goveeApiKey).toBe('new');
  });

  it('clears the key only on an explicit request', async () => {
    const settings = fakeSettings({ settings: { goveeApiKey: 'old' } });
    await handlePiRequest(
      { request: 'saveSettings', settings: {}, clearGoveeKey: true },
      { settings, logger: silent },
    );
    expect(settings.written().settings.goveeApiKey).toBe('');
  });

  it('does not touch profiles when saving settings', async () => {
    const settings = fakeSettings({ profiles: [validProfile()], settings: {} });
    await handlePiRequest(
      { request: 'saveSettings', settings: { goveeApiKey: 'k' } },
      { settings, logger: silent },
    );
    expect(settings.written().profiles).toHaveLength(1);
  });

  it('refuses discovery without a key rather than failing obscurely', async () => {
    const reply = await handlePiRequest(
      { request: 'goveeDiscover' },
      { settings: fakeSettings({}), logger: silent },
    );
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/API key/i);
  });
});

describe('yaml export secrecy', () => {
  it('never writes the api key into an export', () => {
    // Export exists to be committed to version control.
    const out = profilesToYaml({
      profiles: [validProfile()],
      settings: { goveeApiKey: 'super-secret', goveeDevices: ['Strip'] },
    });
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('govee_api_key');
    expect(out).toContain('Strip');
  });
});

describe('openEditor', () => {
  it('starts the browser editor and hands back its address', async () => {
    // The editor server is mocked out: this is about the wiring, and the real
    // thing would bind a socket and open a window on whoever runs the tests.
    vi.resetModules();
    const startEditor = vi.fn(async () => ({ url: 'http://127.0.0.1:1234/?t=abc', alreadyRunning: false }));
    const openInBrowser = vi.fn();
    vi.doMock('./editorServer.js', () => ({ startEditor, openInBrowser }));

    const repaint = () => {};
    const { handlePiRequest: handle } = await import('./piBridge.js');
    const reply = await handle(
      { request: 'openEditor' },
      { settings: fakeSettings({}), logger: silent, onChanged: repaint },
    );

    expect(reply).toMatchObject({ ok: true, url: 'http://127.0.0.1:1234/?t=abc' });
    expect(openInBrowser).toHaveBeenCalledWith('http://127.0.0.1:1234/?t=abc', expect.anything());
    // The editor saves without the inspector in the loop, so the repaint hook
    // has to reach it or the keys keep the old names.
    expect(startEditor.mock.calls[0][0].onChanged).toBe(repaint);
    vi.doUnmock('./editorServer.js');
  });

  it('reports a server that will not start instead of throwing at the inspector', async () => {
    vi.resetModules();
    vi.doMock('./editorServer.js', () => ({
      startEditor: async () => { throw new Error('EADDRINUSE'); },
      openInBrowser: () => {},
    }));
    const { handlePiRequest: handle } = await import('./piBridge.js');
    const reply = await handle(
      { request: 'openEditor' },
      { settings: fakeSettings({}), logger: { ...silent, error: () => {} } },
    );
    expect(reply).toMatchObject({ ok: false, error: 'EADDRINUSE' });
    vi.doUnmock('./editorServer.js');
  });
});
