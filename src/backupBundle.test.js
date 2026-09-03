import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import yaml from 'js-yaml';
import {
  buildBundle, bundleFilename, inspectRestore, restoreAvatars, settingsFromRestore, BUNDLE_KIND,
} from './backupBundle.js';
import { writeSecret, _resetForTesting as resetSecrets } from './secrets.js';

const globals = {
  profiles: [{ id: 'brian', name: 'Brian' }, { id: 'kai', name: 'Kai' }],
  modes: [{ id: 'vr', name: 'VR' }],
  settings: { defaultProfile: 'brian', mozaClosePitHouse: false },
  importedFrom: 'abc123',
};

let dir;
beforeEach(() => {
  resetSecrets();
  dir = mkdtempSync(resolve(tmpdir(), 'rig-bundle-'));
});
afterEach(() => {
  resetSecrets();
  rmSync(dir, { recursive: true, force: true });
});

const build = (g = globals) => buildBundle(g, { avatarDir: resolve(dir, 'none') });

describe('what a bundle contains', () => {
  it('carries profiles, Modes and settings', () => {
    const b = build();
    expect(b.kind).toBe(BUNDLE_KIND);
    expect(b.settings.profiles).toHaveLength(2);
    expect(b.settings.modes).toHaveLength(1);
    expect(b.settings.settings.mozaClosePitHouse).toBe(false);
  });

  it('carries importedFrom, so a restore does not undo itself', () => {
    // Without it the next start sees profiles present but the YAML hash not
    // matching, and re-imports profiles.yaml straight over the restore.
    expect(build().settings.importedFrom).toBe('abc123');
  });

  it('never carries a credential, and says which to re-enter', () => {
    writeSecret('goveeApiKey', 'REAL-KEY');
    const b = build();
    expect(JSON.stringify(b)).not.toContain('REAL-KEY');
    expect(b.secretsOmitted).toEqual([
      { key: 'goveeApiKey', label: 'Govee API key', wasSet: true },
    ]);
  });

  it('marks a secret that was never set, so the restore stays quiet about it', () => {
    expect(build().secretsOmitted.find((s) => s.key === 'goveeApiKey').wasSet).toBe(false);
  });

  it('inlines avatars as data URIs', () => {
    const avatarDir = resolve(dir, 'avatars');
    mkdirSync(avatarDir, { recursive: true });
    // A one-pixel PNG is enough to prove the encoding path.
    writeFileSync(resolve(avatarDir, 'brian.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));
    const b = buildBundle(globals, { avatarDir });
    expect(b.avatars['brian.png']).toMatch(/^data:image\/png;base64,/);
  });

  it('survives an avatar directory that is not there', () => {
    expect(build().avatars).toEqual({});
  });

  it('names the file by date', () => {
    expect(bundleFilename(() => new Date('2026-09-03T12:00:00Z'))).toBe('rig-backup-2026-09-03.json');
  });
});

describe('inspecting what was dropped in', () => {
  const text = () => JSON.stringify(build());

  it('accepts its own output and summarises it', () => {
    const r = inspectRestore(text());
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('bundle');
    expect(r.summary).toMatchObject({ profiles: 2, modes: 1 });
  });

  it('rejects an empty file, malformed JSON and a foreign JSON file', () => {
    expect(inspectRestore('').error).toMatch(/empty/i);
    expect(inspectRestore('{oh no').error).toMatch(/malformed/i);
    expect(inspectRestore('{"kind":"something-else"}').error).toMatch(/not a rig-profiles backup/i);
  });

  it('refuses a bundle from a newer plugin rather than guessing', () => {
    const r = inspectRestore(JSON.stringify({ ...build(), version: 99 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/newer version/i);
  });

  it('refuses a bundle with nothing in it', () => {
    const r = inspectRestore(JSON.stringify({ ...build(), settings: { profiles: [] } }));
    expect(r.error).toMatch(/no profiles or Modes/i);
  });

  it('recognises a YAML export and flags it as partial', () => {
    const doc = yaml.dump({ profiles: [{ id: 'brian', name: 'Brian', color: '#2255CC' }] });
    const r = inspectRestore(doc);
    expect(r.kind).toBe('yaml');
    expect(r.summary.partial).toBe(true);
    expect(r.summary.avatars).toBe(0);
  });

  it('rejects YAML with no profiles', () => {
    expect(inspectRestore('settings:\n  default_profile: brian\n').error).toMatch(/no profiles/i);
  });
});

describe('what a restore would store', () => {
  it('takes a bundle wholesale', () => {
    const next = settingsFromRestore(inspectRestore(JSON.stringify(build())), {});
    expect(next.profiles).toHaveLength(2);
    expect(next.importedFrom).toBe('abc123');
  });

  it('merges a YAML rather than clearing what it cannot describe', () => {
    // A partial document that treats silence as deletion is how an import once
    // wiped the Govee key and every Mode.
    const doc = yaml.dump({ profiles: [{ id: 'brian', name: 'Brian', color: '#2255CC' }] });
    const current = { modes: [{ id: 'vr' }], settings: { mozaClosePitHouse: false } };
    const next = settingsFromRestore(inspectRestore(doc), current);
    expect(next.profiles).toHaveLength(1);
    expect(next.modes).toEqual([{ id: 'vr' }]);
    expect(next.settings.mozaClosePitHouse).toBe(false);
  });

  it('never introduces a credential, even from a hand-edited YAML', () => {
    const doc = yaml.dump({
      profiles: [{ id: 'brian', name: 'Brian', color: '#2255CC' }],
      settings: { govee_api_key: 'PLANTED' },
    });
    const next = settingsFromRestore(inspectRestore(doc), {});
    expect(JSON.stringify(next)).not.toContain('PLANTED');
  });
});

describe('restoring avatars', () => {
  it('writes each image and reports what landed', () => {
    const save = vi.fn();
    const out = restoreAvatars(
      { 'brian.png': 'data:image/png;base64,AAAA', 'mode-vr.png': 'data:image/png;base64,BBBB' },
      { dir, save },
    );
    expect(out.written).toEqual(['brian.png', 'mode-vr.png']);
    expect(save).toHaveBeenCalledTimes(2);
    // Mode avatars are namespaced, and must come back under the same name.
    expect(save.mock.calls[1][0]).toBe('vr');
    expect(save.mock.calls[1][3]).toMatchObject({ kind: 'mode' });
  });

  it('collects failures instead of losing the whole restore to one bad image', () => {
    const out = restoreAvatars(
      { 'good.png': 'data:image/png;base64,AAAA', 'bad.png': 'not-a-data-uri' },
      { dir, save: vi.fn() },
    );
    expect(out.written).toEqual(['good.png']);
    expect(out.failed).toEqual(['bad.png']);
  });

  it('does nothing with no avatars', () => {
    expect(restoreAvatars(undefined, { dir, save: vi.fn() })).toEqual({ written: [], failed: [] });
  });
});
