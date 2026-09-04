// End-to-end tests for the backup and restore requests.
//
// These drive real files: BACKUP_PATH and HISTORY_DIR redirect to a per-process
// temp tree under VITEST, so the round trip is genuinely exercised without ever
// touching the user's own backups. See settingsBackup.js for that redirect.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import yaml from 'js-yaml';
import { handlePiRequest } from './piBridge.js';
import { writeBackup, _resetForTesting as resetBackups } from './settingsBackup.js';
import { writeSecret, readSecret, _resetForTesting as resetSecrets } from './secrets.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function fakeSettings(initial = {}) {
  let store = initial;
  return {
    written: () => store,
    async getGlobalSettings() { return store; },
    async setGlobalSettings(next) { store = next; },
  };
}

const profile = (id) => ({ id, name: id[0].toUpperCase() + id.slice(1), color: '#2255CC', providers: {} });
const full = () => ({
  profiles: [profile('brian'), profile('ethan'), profile('carter'), profile('guest')],
  modes: [{ id: 'vr', name: 'VR', color: '#2255CC', providers: {} }],
  settings: { defaultProfile: 'brian', mozaClosePitHouse: false },
  importedFrom: 'abc123',
});

const send = (msg, settings) => handlePiRequest(msg, { settings, logger: silent });

beforeEach(() => { resetBackups(); resetSecrets(); });
afterEach(() => { resetBackups(); resetSecrets(); });

describe('exporting a backup', () => {
  it('produces a named bundle of the current state', async () => {
    const r = await send({ request: 'exportBackup' }, fakeSettings(full()));
    expect(r.ok).toBe(true);
    expect(r.filename).toMatch(/^rig-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(r.bundle.settings.profiles).toHaveLength(4);
    expect(r.bundle.settings.importedFrom).toBe('abc123');
  });

  it('leaves the credential out and names it instead', async () => {
    writeSecret('goveeApiKey', 'REAL-KEY');
    const r = await send({ request: 'exportBackup' }, fakeSettings(full()));
    expect(JSON.stringify(r.bundle)).not.toContain('REAL-KEY');
    expect(r.bundle.secretsOmitted).toContainEqual({
      key: 'goveeApiKey', label: 'Govee API key', wasSet: true,
    });
  });
});

describe('the offer', () => {
  it('stays quiet when the store is healthy', async () => {
    writeBackup(full(), { checkpoint: true });
    const r = await send({ request: 'getBackupOffer' }, fakeSettings(full()));
    expect(r.degraded).toBe(false);
  });

  it('fires when the store is empty and a backup is not', async () => {
    // The 2026-09-02 shape exactly: four profiles in the backup, none in the
    // store because Stream Deck was force-killed before it flushed.
    writeBackup(full(), { checkpoint: true });
    const r = await send({ request: 'getBackupOffer' }, fakeSettings({}));
    expect(r.degraded).toBe(true);
    expect(r.have).toBe(0);
    expect(r.newest.profiles).toBe(4);
    expect(r.newest.savedAt).toBeTruthy();
  });

  it('fires on partial loss, not only total loss', async () => {
    // "Do you have none?" would sail straight past losing three of four.
    writeBackup(full(), { checkpoint: true });
    const r = await send({ request: 'getBackupOffer' }, fakeSettings({ profiles: [profile('brian')] }));
    expect(r.degraded).toBe(true);
    expect(r.have).toBe(1);
  });

  it('says nothing on a machine with no backups at all', async () => {
    const r = await send({ request: 'getBackupOffer' }, fakeSettings({}));
    expect(r.degraded).toBe(false);
    expect(r.newest).toBeNull();
  });
});

describe('status and history', () => {
  it('reports where backups live and how many there are', async () => {
    writeBackup(full(), { checkpoint: true, reason: 'startup' });
    const r = await send({ request: 'getBackupStatus' }, fakeSettings(full()));
    expect(r.ok).toBe(true);
    expect(r.generationCount).toBe(1);
    expect(r.lastSavedAt).toBeTruthy();
    expect(r.dir).toBeTruthy();
  });

  it('lists each version with enough to choose between them', async () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 3, 12, 0, n++));
    writeBackup(full(), { checkpoint: true, reason: 'startup', now });
    writeBackup({ ...full(), profiles: [profile('brian')] }, { checkpoint: true, reason: 'settled', now, shrink: true });

    const r = await send({ request: 'listBackups' }, fakeSettings(full()));
    expect(r.backups).toHaveLength(2);
    expect(r.backups[0]).toMatchObject({ profiles: 1, modes: 1, reason: 'settled' });
    expect(r.backups[1]).toMatchObject({ profiles: 4, reason: 'startup' });
  });
});

describe('previewing before committing to anything', () => {
  it('describes a bundle without writing', async () => {
    const settings = fakeSettings({ profiles: [] });
    const bundle = (await send({ request: 'exportBackup' }, fakeSettings(full()))).bundle;
    const r = await send({ request: 'previewRestore', content: JSON.stringify(bundle) }, settings);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ profiles: 4, modes: 1 });
    expect(settings.written().profiles).toEqual([]);
  });

  it('explains a file it cannot use rather than throwing', async () => {
    const s = fakeSettings({});
    expect((await send({ request: 'previewRestore', content: 'nonsense' }, s)).error).toBeTruthy();
    expect((await send({ request: 'previewRestore', content: '{bad json' }, s)).error).toMatch(/malformed/i);
    expect((await send({ request: 'previewRestore', content: '' }, s)).error).toMatch(/empty/i);
  });

  it('flags a YAML as partial', async () => {
    const doc = yaml.dump({ profiles: [{ id: 'brian', name: 'Brian', color: '#2255CC' }] });
    const r = await send({ request: 'previewRestore', content: doc }, fakeSettings({}));
    expect(r.kind).toBe('yaml');
    expect(r.summary.partial).toBe(true);
  });
});

describe('restoring', () => {
  it('puts an uploaded bundle back', async () => {
    const bundle = (await send({ request: 'exportBackup' }, fakeSettings(full()))).bundle;
    const settings = fakeSettings({ profiles: [] });
    const r = await send(
      { request: 'restoreBackup', source: 'upload', content: JSON.stringify(bundle) }, settings,
    );
    expect(r.ok).toBe(true);
    expect(r.profiles).toBe(4);
    expect(settings.written().profiles.map((p) => p.id)).toEqual(['brian', 'ethan', 'carter', 'guest']);
    expect(settings.written().importedFrom).toBe('abc123');
  });

  it('restores the latest mirror', async () => {
    writeBackup(full(), { checkpoint: true });
    const settings = fakeSettings({ profiles: [] });
    const r = await send({ request: 'restoreBackup', source: 'mirror' }, settings);
    expect(r.ok).toBe(true);
    expect(settings.written().profiles).toHaveLength(4);
  });

  it('restores one chosen version from the history', async () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 3, 12, 0, n++));
    writeBackup(full(), { checkpoint: true, now });
    writeBackup({ ...full(), profiles: [profile('brian')] }, { checkpoint: true, now, shrink: true });

    const list = await send({ request: 'listBackups' }, fakeSettings({}));
    const older = list.backups.find((b) => b.profiles === 4);
    const settings = fakeSettings({ profiles: [] });
    const r = await send({ request: 'restoreBackup', source: 'generation', id: older.id }, settings);
    expect(r.ok).toBe(true);
    expect(settings.written().profiles).toHaveLength(4);
  });

  it('takes a checkpoint of what it replaces, so it can be undone', async () => {
    const bundle = (await send({ request: 'exportBackup' }, fakeSettings(full()))).bundle;
    const before = { profiles: [profile('only-me')], settings: {} };
    await send({ request: 'restoreBackup', source: 'upload', content: JSON.stringify(bundle) },
      fakeSettings(before));

    const list = await send({ request: 'listBackups' }, fakeSettings({}));
    const pre = list.backups.find((b) => b.reason === 'before-restore');
    expect(pre).toBeTruthy();
    expect(pre.profiles).toBe(1);
  });

  it('refuses a version that is no longer on disk', async () => {
    const r = await send({ request: 'restoreBackup', source: 'generation', id: 'settings-nope.json' },
      fakeSettings({}));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no longer on disk/i);
  });

  it('refuses a file it could not read, and writes nothing', async () => {
    const settings = fakeSettings({ profiles: [profile('brian')] });
    const r = await send({ request: 'restoreBackup', source: 'upload', content: '{bad' }, settings);
    expect(r.ok).toBe(false);
    expect(settings.written().profiles).toHaveLength(1);
  });

  it('never touches the secret store', async () => {
    // A restore must not write, clear, or carry a credential — including one
    // planted in a hand-edited YAML.
    writeSecret('goveeApiKey', 'MINE');
    const doc = yaml.dump({
      profiles: [{ id: 'brian', name: 'Brian', color: '#2255CC' }],
      settings: { govee_api_key: 'PLANTED' },
    });
    const settings = fakeSettings({ profiles: [] });
    await send({ request: 'restoreBackup', source: 'upload', content: doc }, settings);

    expect(readSecret('goveeApiKey')).toBe('MINE');
    expect(JSON.stringify(settings.written())).not.toContain('PLANTED');
  });

  it('tells the caller which credentials to re-enter', async () => {
    writeSecret('goveeApiKey', 'REAL-KEY');
    const bundle = (await send({ request: 'exportBackup' }, fakeSettings(full()))).bundle;
    resetSecrets(); // a different machine, with no key of its own

    const r = await send({ request: 'restoreBackup', source: 'upload', content: JSON.stringify(bundle) },
      fakeSettings({ profiles: [] }));
    expect(r.secretsToReenter).toEqual(['Govee API key']);
  });
});

describe('what a restore asks you to re-enter', () => {
  it('names only the credentials this machine is actually missing', async () => {
    // A bundle records what existed when it was written, which is right for
    // moving machines. Telling someone to re-enter a key that is still sitting
    // there is noise, and noise in a restore message is where a real warning
    // goes unread.
    writeSecret('goveeApiKey', 'STILL-HERE');
    const bundle = (await send({ request: 'exportBackup' }, fakeSettings(full()))).bundle;
    expect(bundle.secretsOmitted.find((s) => s.key === 'goveeApiKey').wasSet).toBe(true);

    const r = await send({ request: 'restoreBackup', source: 'upload', content: JSON.stringify(bundle) },
      fakeSettings({ profiles: [] }));
    expect(r.secretsToReenter).toEqual([]);
    expect(readSecret('goveeApiKey')).toBe('STILL-HERE');
  });
});

describe('the preview agrees with the result', () => {
  it('does not warn about a key that is still on this machine', async () => {
    writeSecret('goveeApiKey', 'STILL-HERE');
    const bundle = (await send({ request: 'exportBackup' }, fakeSettings(full()))).bundle;
    const r = await send({ request: 'previewRestore', content: JSON.stringify(bundle) }, fakeSettings({}));
    expect(r.summary.secretsToReenter).toEqual([]);
  });

  it('does warn when the key is genuinely absent, as on a new machine', async () => {
    writeSecret('goveeApiKey', 'REAL-KEY');
    const bundle = (await send({ request: 'exportBackup' }, fakeSettings(full()))).bundle;
    resetSecrets();
    const r = await send({ request: 'previewRestore', content: JSON.stringify(bundle) }, fakeSettings({}));
    expect(r.summary.secretsToReenter).toEqual(['Govee API key']);
  });
});
