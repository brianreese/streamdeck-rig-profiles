import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { writeBackup, readBackup, hasBeenConfigured, historyFiles, isWorthKeeping, HISTORY_LIMIT } from './settingsBackup.js';

let dir;
let opts;
const real = { profiles: [{ id: 'brian' }, { id: 'ethan' }], settings: { goveeApiKey: 'k' } };

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'rig-backup-'));
  opts = { path: resolve(dir, 'settings.backup.json'), dir: resolve(dir, 'history') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('what is worth mirroring', () => {
  it('keeps anything carrying real configuration', () => {
    expect(isWorthKeeping({ profiles: [{ id: 'a' }] })).toBe(true);
    expect(isWorthKeeping({ modes: [{ id: 'vr' }] })).toBe(true);
    expect(isWorthKeeping({ settings: { goveeApiKey: 'k' } })).toBe(true);
  });

  it('refuses an empty blob, so a wipe cannot overwrite the copy that undoes it', () => {
    expect(isWorthKeeping({})).toBe(false);
    expect(isWorthKeeping({ profiles: [], modes: [] })).toBe(false);
    expect(isWorthKeeping(null)).toBe(false);
    expect(writeBackup({ profiles: [] }, opts).written).toBe(false);
  });

  it('leaves a good backup untouched when asked to mirror emptiness', () => {
    writeBackup(real, opts);
    writeBackup({ profiles: [] }, opts);
    expect(readBackup(opts).settings.profiles).toHaveLength(2);
  });
});

describe('generations', () => {
  it('keeps a history entry per change and none for a no-op write', () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 2, 0, 0, n++));
    writeBackup(real, { ...opts, now });
    writeBackup(real, { ...opts, now });
    expect(historyFiles(opts)).toHaveLength(1);

    writeBackup({ ...real, profiles: [...real.profiles, { id: 'kai' }] }, { ...opts, now });
    expect(historyFiles(opts)).toHaveLength(2);
  });

  it('caps the depth', () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 2, 0, 0, n++));
    for (let i = 0; i < HISTORY_LIMIT + 8; i++) {
      writeBackup({ profiles: [{ id: `p${i}` }] }, { ...opts, now });
    }
    expect(historyFiles(opts).length).toBeLessThanOrEqual(HISTORY_LIMIT);
  });

  it('falls back to an older generation when the newest is truncated', () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 2, 0, 0, n++));
    writeBackup(real, { ...opts, now });
    writeFileSync(opts.path, '{"version":1,"settings":{"prof', 'utf8');
    expect(readBackup(opts).settings.profiles).toHaveLength(2);
  });

  it('returns null when there is genuinely nothing', () => {
    expect(readBackup(opts)).toBeNull();
  });
});

describe('the first-run marker', () => {
  it('is false on a machine that has never run the plugin', () => {
    expect(hasBeenConfigured(opts)).toBe(false);
  });

  it('is true once anything has been mirrored', () => {
    writeBackup(real, opts);
    expect(hasBeenConfigured(opts)).toBe(true);
  });

  it('survives the current backup being deleted, because history still answers', () => {
    writeBackup(real, opts);
    rmSync(opts.path);
    expect(hasBeenConfigured(opts)).toBe(true);
  });
});

describe('durability', () => {
  it('leaves no temp file behind', () => {
    writeBackup(real, opts);
    expect(existsSync(`${opts.path}.tmp`)).toBe(false);
  });

  it('records when it was taken', () => {
    writeBackup(real, opts);
    expect(JSON.parse(readFileSync(opts.path, 'utf8')).savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates its directories', () => {
    const nested = { path: resolve(dir, 'a', 'b', 'settings.backup.json'), dir: resolve(dir, 'a', 'b', 'history') };
    expect(writeBackup(real, nested).written).toBe(true);
    expect(existsSync(nested.path)).toBe(true);
  });
});
