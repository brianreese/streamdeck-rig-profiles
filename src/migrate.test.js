import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { convertProfile, convertConfig, migrateIfNeeded } from './migrate.js';

const LEGACY_YAML = `
profiles:
  - id: primary
    name: Primary
    color: "#2255CC"
    fanatec_preset_hotkey: "ctrl+alt+f1"
    govee_scene: Racing
    sd_profile: "Main Profile"
  - id: secondary
    name: Secondary
    color: "#22AA44"
    moza_profile: beginner
settings:
  default_profile: primary
  govee_api_key: "abc123"
`;

function fakeSettings(initial = {}) {
  let store = initial;
  return {
    written: () => store,
    async getGlobalSettings() {
      return store;
    },
    async setGlobalSettings(next) {
      store = next;
    },
  };
}

function writeLegacy(contents = LEGACY_YAML) {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
  const path = join(dir, 'profiles.yaml');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('convertProfile', () => {
  it('maps a fanatec_setup slot onto the wheelbase provider', () => {
    const out = convertProfile({ id: 'kai', fanatec_setup: 2 });
    expect(out.providers['fanatec-base']).toEqual({ setup: 2 });
    expect(out.needsWheelbaseSetup).toBe(false);
  });

  it('ignores an out-of-range fanatec_setup rather than sending a bad slot', () => {
    const out = convertProfile({ id: 'x', fanatec_setup: 9 });
    expect(out.providers['fanatec-base']).toBeUndefined();
  });

  it('nests flat hardware keys under providers', () => {
    const out = convertProfile({
      id: 'kai',
      name: 'Kai',
      color: '#22AA44',
      govee_scene: 'Kid Mode',
      sd_profile: 'Kid Desktop',
      moza_profile: 'soft',
    });
    expect(out.providers).toEqual({
      govee: { scene: 'Kid Mode' },
      streamdeck: { profile: 'Kid Desktop' },
      'moza-pedals': { profile: 'soft' },
    });
  });

  it('omits providers the old profile did not configure', () => {
    const out = convertProfile({ id: 'bare', name: 'Bare' });
    expect(out.providers).toEqual({});
  });

  it('does not invent a wheelbase slot from a FanaLab hotkey', () => {
    const out = convertProfile({ id: 'x', fanatec_preset_hotkey: 'ctrl+alt+f2' });
    expect(out.providers['fanatec-base']).toBeUndefined();
    expect(out.needsWheelbaseSetup).toBe(true);
  });

  it('defaults a missing name and colour rather than producing an unusable profile', () => {
    const out = convertProfile({ id: 'x' });
    expect(out.name).toBe('x');
    expect(out.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('convertConfig', () => {
  it('carries settings across and drops profiles with no id', () => {
    const out = convertConfig({
      profiles: [{ id: 'a' }, { name: 'no id' }],
      settings: { default_profile: 'a', govee_api_key: 'k' },
    });
    expect(out.profiles).toHaveLength(1);
    expect(out.settings.defaultProfile).toBe('a');
    expect(out.settings.goveeApiKey).toBe('k');
  });
});

describe('migrateIfNeeded', () => {
  it('imports legacy profiles when global settings are empty', async () => {
    const settings = fakeSettings({});
    const out = await migrateIfNeeded({ configPath: writeLegacy(), settings, log: () => {}, configured: () => false });

    expect(out.migrated).toBe(true);
    expect(out.count).toBe(2);
    expect(settings.written().profiles[0].providers.govee).toEqual({ scene: 'Racing' });
  });

  it('does not re-import when the yaml is unchanged since last import', async () => {
    const path = writeLegacy();
    const settings = fakeSettings({});

    await migrateIfNeeded({ configPath: path, settings, log: () => {}, configured: () => false });
    const afterFirst = settings.written();

    // Second run over the identical file must be a no-op.
    const out = await migrateIfNeeded({ configPath: path, settings, log: () => {}, configured: () => false });
    expect(out.migrated).toBe(false);
    expect(out.reason).toBe('already configured');
    expect(settings.written()).toBe(afterFirst);
  });

  it('leaves property-inspector edits alone while the yaml is untouched', async () => {
    const path = writeLegacy();
    const settings = fakeSettings({});
    await migrateIfNeeded({ configPath: path, settings, log: () => {}, configured: () => false });

    // Simulate the user renaming a profile in the PI.
    const edited = { ...settings.written() };
    edited.profiles = [{ ...edited.profiles[0], name: 'Renamed In PI' }];
    await settings.setGlobalSettings(edited);

    await migrateIfNeeded({ configPath: path, settings, log: () => {}, configured: () => false });
    expect(settings.written().profiles[0].name).toBe('Renamed In PI');
  });

  it('re-imports when the yaml has actually changed', async () => {
    const path = writeLegacy();
    const settings = fakeSettings({});
    await migrateIfNeeded({ configPath: path, settings, log: () => {}, configured: () => false });

    writeFileSync(path, LEGACY_YAML.replace('name: Primary', 'name: Renamed In Yaml'), 'utf8');
    const out = await migrateIfNeeded({ configPath: path, settings, log: () => {}, configured: () => false });

    expect(out.migrated).toBe(true);
    expect(settings.written().profiles[0].name).toBe('Renamed In Yaml');
  });

  it('is a no-op when there is no legacy config', async () => {
    const settings = fakeSettings({});
    const out = await migrateIfNeeded({
      configPath: join(tmpdir(), 'definitely-not-here.yaml'),
      settings,
      log: () => {},
      configured: () => false,
    });
    expect(out.migrated).toBe(false);
    expect(out.reason).toBe('no legacy config');
  });

  it('does not write anything when the legacy config has no profiles', async () => {
    const settings = fakeSettings({});
    const out = await migrateIfNeeded({
      configPath: writeLegacy('settings:\n  default_profile: null\n'),
      settings,
      log: () => {},
      configured: () => false,
    });
    expect(out.migrated).toBe(false);
    expect(settings.written()).toEqual({});
  });
});

describe('an import must not factory-reset the plugin', () => {
  // Editing profiles.yaml re-imports profiles. It used to replace the whole of
  // global settings, destroying everything the YAML did not describe. The
  // profiles reverting to their YAML originals after a reboot was the visible
  // half; the invisible half was the Govee API key going with them.
  const withYaml = (yaml) => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
    const path = join(dir, 'profiles.yaml');
    writeFileSync(path, yaml);
    return path;
  };

  it('keeps the Govee API key when the YAML does not mention one', async () => {
    const settings = fakeSettings({
      settings: { goveeApiKey: 'typed-into-the-editor', mozaClosePitHouse: false },
    });
    await migrateIfNeeded({ configPath: withYaml(LEGACY_YAML.replace(/\s+govee_api_key.*/, '')), settings, configured: () => false });

    const stored = await settings.getGlobalSettings();
    expect(stored.settings.goveeApiKey).toBe('typed-into-the-editor');
    // And the hardware toggles beside it.
    expect(stored.settings.mozaClosePitHouse).toBe(false);
  });

  it('lets the YAML win when it does specify a key', async () => {
    const settings = fakeSettings({ settings: { goveeApiKey: 'old' } });
    await migrateIfNeeded({ configPath: withYaml(LEGACY_YAML), settings, configured: () => false });
    expect((await settings.getGlobalSettings()).settings.goveeApiKey).toBe('abc123');
  });

  it('keeps scenes, which the YAML knows nothing about', async () => {
    const settings = fakeSettings({ scenes: [{ id: 'ambient', name: 'Ambient', providers: {} }] });
    await migrateIfNeeded({ configPath: withYaml(LEGACY_YAML), settings, configured: () => false });
    expect((await settings.getGlobalSettings()).scenes).toEqual([
      { id: 'ambient', name: 'Ambient', providers: {} },
    ]);
  });

  it('carries a profile\'s scene references through the conversion', () => {
    const converted = convertConfig({
      profiles: [{ id: 'brian', name: 'Brian', color: '#2255CC', scenes: ['ambient'] }],
    });
    expect(converted.profiles[0].scenes).toEqual(['ambient']);
  });

  it('imports scenes when the YAML does carry them', () => {
    const converted = convertConfig({
      profiles: [{ id: 'brian', name: 'Brian', color: '#2255CC' }],
      scenes: [{ id: 'ambient', name: 'Ambient', providers: {} }],
    });
    expect(converted.scenes).toHaveLength(1);
  });

  it('still replaces the profiles, which is the point of importing', async () => {
    const settings = fakeSettings({ profiles: [{ id: 'stale', name: 'Stale' }] });
    await migrateIfNeeded({ configPath: withYaml(LEGACY_YAML), settings, configured: () => false });
    const stored = await settings.getGlobalSettings();
    expect(stored.profiles.map((p) => p.id)).toEqual(['primary', 'secondary']);
  });
});

describe('an empty store is not proof of a first run', () => {
  // 2026-09-02. StreamDeck.exe was force-killed so it would rescan its plugins
  // folder. It holds global settings in memory and flushes on a clean exit, so
  // nothing was written. `getGlobalSettings()` came back empty; six seconds
  // later this function read that as a fresh install and imported the two
  // example profiles over `brian`, `ethan`, `carter` and `guest`. The deck keys
  // survived, still pointing at ids that no longer existed.
  //
  // The old guard was `existing?.profiles?.length && existing.importedFrom ===
  // hash` — false when there are no profiles, and therefore an instruction to
  // import. Every branch of it was correct about what it tested; none of it
  // asked whether the emptiness was legitimate.

  it('refuses to import over a wipe', async () => {
    const settings = fakeSettings({});
    const out = await migrateIfNeeded({
      configPath: writeLegacy(),
      settings,
      log: () => {},
      configured: () => true,
    });

    expect(out.migrated).toBe(false);
    expect(out.reason).toBe('empty store, previously configured');
    expect(settings.written()).toEqual({});
  });

  it('says why, so the log explains an empty deck', async () => {
    const lines = [];
    await migrateIfNeeded({
      configPath: writeLegacy(),
      settings: fakeSettings({}),
      log: (m) => lines.push(m),
      configured: () => true,
    });
    expect(lines.join('\n')).toMatch(/REFUSING to import/);
  });

  it('still imports on a machine that has genuinely never run it', async () => {
    const settings = fakeSettings({});
    const out = await migrateIfNeeded({
      configPath: writeLegacy(),
      settings,
      log: () => {},
      configured: () => false,
    });
    expect(out.migrated).toBe(true);
    expect(settings.written().profiles).toHaveLength(2);
  });

  it('still honours a genuinely edited YAML once profiles exist', async () => {
    // The guard keys on emptiness, not on having run before, so the normal
    // reimport path is untouched.
    const settings = fakeSettings({ profiles: [{ id: 'stale' }], importedFrom: 'other' });
    const out = await migrateIfNeeded({
      configPath: writeLegacy(),
      settings,
      log: () => {},
      configured: () => true,
    });
    expect(out.migrated).toBe(true);
    expect(settings.written().profiles.map((p) => p.id)).toEqual(['primary', 'secondary']);
  });
});
