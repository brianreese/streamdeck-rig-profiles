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
    const out = await migrateIfNeeded({ configPath: writeLegacy(), settings, log: () => {} });

    expect(out.migrated).toBe(true);
    expect(out.count).toBe(2);
    expect(settings.written().profiles[0].providers.govee).toEqual({ scene: 'Racing' });
  });

  it('never clobbers profiles that already exist', async () => {
    const existing = { profiles: [{ id: 'mine', name: 'Mine' }] };
    const settings = fakeSettings(existing);
    const out = await migrateIfNeeded({ configPath: writeLegacy(), settings, log: () => {} });

    expect(out.migrated).toBe(false);
    expect(settings.written()).toBe(existing);
  });

  it('is a no-op when there is no legacy config', async () => {
    const settings = fakeSettings({});
    const out = await migrateIfNeeded({
      configPath: join(tmpdir(), 'definitely-not-here.yaml'),
      settings,
      log: () => {},
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
    });
    expect(out.migrated).toBe(false);
    expect(settings.written()).toEqual({});
  });
});
