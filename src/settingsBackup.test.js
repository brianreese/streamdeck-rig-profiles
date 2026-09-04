import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  writeBackup, readBackup, hasBeenConfigured, historyFiles, isWorthKeeping,
  HISTORY_LIMIT, RETENTION, planRetention, generationDate, configuredState,
} from './settingsBackup.js';

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
  // A generation is written only when a caller says the moment is worth
  // keeping. An ordinary write refreshes the mirror and nothing else — the
  // editor autosaves, and per-write generations spent the whole depth in an
  // evening. See backupSchedule.js.
  it('does not write one for an ordinary write', () => {
    writeBackup(real, opts);
    writeBackup({ ...real, profiles: [] , modes: [{ id: 'vr' }] }, opts);
    expect(historyFiles(opts)).toHaveLength(0);
    expect(readBackup(opts)).not.toBeNull(); // the mirror still tracked both
  });

  it('keeps one per checkpoint that changed something, and none for a no-op', () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 2, 0, 0, n++));
    const cp = { ...opts, now, checkpoint: true };
    writeBackup(real, cp);
    writeBackup(real, cp);
    expect(historyFiles(opts)).toHaveLength(1);

    writeBackup({ ...real, profiles: [...real.profiles, { id: 'kai' }] }, cp);
    expect(historyFiles(opts)).toHaveLength(2);
  });

  it('records why it was taken', () => {
    writeBackup(real, { ...opts, checkpoint: true, reason: 'startup' });
    const gen = JSON.parse(readFileSync(historyFiles(opts)[0], 'utf8'));
    expect(gen.reason).toBe('startup');
  });

  it('caps the depth', () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 2, 0, 0, n++));
    for (let i = 0; i < HISTORY_LIMIT + 8; i++) {
      writeBackup({ profiles: [{ id: `p${i}` }] }, { ...opts, now, checkpoint: true });
    }
    expect(historyFiles(opts).length).toBeLessThanOrEqual(HISTORY_LIMIT);
  });

  it('falls back to an older generation when the newest is truncated', () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 2, 0, 0, n++));
    writeBackup(real, { ...opts, now, checkpoint: true });
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
    writeBackup(real, { ...opts, checkpoint: true });
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

describe('retention tiers', () => {
  const NOW = new Date('2026-09-03T12:00:00.000Z');
  const gen = (iso) => `settings-${new Date(iso).toISOString().replace(/[:.]/g, '-')}.json`;
  const plan = (files) => planRetention(files, { now: () => NOW });

  it('reads the date back out of a filename', () => {
    expect(generationDate(gen('2026-09-03T00:09:35.762Z')).toISOString())
      .toBe('2026-09-03T00:09:35.762Z');
    expect(generationDate('not-ours.json')).toBeNull();
    expect(generationDate('settings-garbage.json')).toBeNull();
  });

  it('keeps an evening of edits without spending the whole depth', () => {
    // 40 generations one minute apart, the shape an autosaving editor makes.
    // The old flat cap kept the newest 20 and lost everything older; the recent
    // tier caps them at 10 and leaves the daily and weekly slots free.
    const evening = Array.from({ length: 40 }, (_, i) =>
      gen(new Date(NOW.getTime() - i * 60_000).toISOString()));
    expect(plan(evening).length).toBeLessThanOrEqual(RETENTION.recent + 1);
  });

  it('reaches back weeks, which a flat cap could not', () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => gen(new Date(NOW.getTime() - i * 60_000).toISOString())),
      gen('2026-09-02T10:00:00Z'), // yesterday
      gen('2026-08-30T10:00:00Z'), // a few days back
      gen('2026-08-20T10:00:00Z'), // a couple of weeks back
      gen('2026-08-12T10:00:00Z'), // further still
    ];
    const kept = plan(files);
    expect(kept).toContain(gen('2026-09-02T10:00:00Z'));
    expect(kept).toContain(gen('2026-08-30T10:00:00Z'));
    expect(kept).toContain(gen('2026-08-20T10:00:00Z'));
    // and it did not have to keep everything to do it
    expect(kept.length).toBeLessThan(files.length);
  });

  it('keeps the newest within a day, not the oldest', () => {
    const older = gen('2026-09-01T08:00:00Z');
    const newer = gen('2026-09-01T20:00:00Z');
    const kept = plan([older, newer]);
    expect(kept).toContain(newer);
    expect(kept).not.toContain(older);
  });

  it('returns newest first and never exceeds the bound', () => {
    const files = Array.from({ length: 60 }, (_, i) =>
      gen(new Date(NOW.getTime() - i * 3_600_000).toISOString()));
    const kept = plan(files);
    expect(kept.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(generationDate(kept[0]) > generationDate(kept[kept.length - 1])).toBe(true);
  });

  it('ignores anything that is not a generation', () => {
    expect(plan(['README.md', 'settings-nope.json'])).toEqual([]);
  });

  it('deletes exactly what the plan drops', () => {
    let n = 0;
    const now = () => new Date(Date.UTC(2026, 8, 3, 0, 0, n++));
    for (let i = 0; i < 30; i++) writeBackup({ profiles: [{ id: `p${i}` }] }, { ...opts, now, checkpoint: true });
    const left = historyFiles(opts);
    expect(left.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(left.length).toBeGreaterThan(0);
  });
});

describe('could-not-tell is not the same as never-configured', () => {
  // The 2026-09-04 loss. The plugin started a minute after a PC restart, said
  // "first run", and re-imported profiles.yaml over four recovered profiles —
  // with the mirror on disk the whole time and readable minutes later.
  //
  // existsSync returns false for EPERM and EBUSY exactly as it does for ENOENT,
  // and historyFiles swallowed every error and returned []. So "the disk did not
  // answer" and "nothing was ever configured" were one value, and that value
  // authorised a destructive re-seed. Boot is when a transient read failure is
  // most likely, and boot is when this runs.
  const throwing = (code) => () => {
    const err = new Error(code);
    err.code = code;
    throw err;
  };

  it('says no only when both are definitely absent', () => {
    expect(configuredState({ stat: throwing('ENOENT'), list: throwing('ENOENT') })).toBe('no');
  });

  it('says unknown when the mirror cannot be read', () => {
    expect(configuredState({ stat: throwing('EPERM'), list: throwing('ENOENT') })).toBe('unknown');
    expect(configuredState({ stat: throwing('EBUSY'), list: throwing('ENOENT') })).toBe('unknown');
  });

  it('says unknown when the history directory cannot be read', () => {
    expect(configuredState({ stat: throwing('ENOENT'), list: throwing('EACCES') })).toBe('unknown');
  });

  it('treats unknown as configured, so a bad read can never authorise a re-seed', () => {
    // Wrong in this direction costs one restart. Wrong the other way destroys
    // the configuration.
    expect(hasBeenConfigured({ stat: throwing('EPERM'), list: throwing('EPERM') })).toBe(true);
    expect(hasBeenConfigured({ stat: throwing('ENOENT'), list: throwing('ENOENT') })).toBe(false);
  });

  it('still answers yes from a real mirror', () => {
    writeBackup(real, opts);
    expect(configuredState(opts)).toBe('yes');
  });
});

describe('the mirror refuses to be downgraded', () => {
  const four = { profiles: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], modes: [{ id: 'vr' }] };
  const two = { profiles: [{ id: 'a' }, { id: 'b' }] };

  it('will not replace a richer mirror with a poorer one', () => {
    // isWorthKeeping only ever asked "is there anything at all", so four
    // profiles collapsing to two sailed through and overwrote the good copy —
    // the same partial-loss blind spot the restore offer had, and worse here,
    // because this destroys the copy that would have undone the loss.
    writeBackup(four, opts);
    const r = writeBackup(two, opts);
    expect(r.written).toBe(false);
    expect(r.reason).toMatch(/refusing to shrink/i);
    expect(readBackup(opts).settings.profiles).toHaveLength(4);
  });

  it('counts Modes as well as profiles', () => {
    writeBackup(four, opts);
    const r = writeBackup({ profiles: four.profiles, modes: [] }, opts);
    expect(r.written).toBe(false);
  });

  it('allows a shrink when a person asked for one', () => {
    // Deleting a profile is legitimate. Only the startup snapshot, which cannot
    // tell loss from intent, is suspicious.
    writeBackup(four, opts);
    expect(writeBackup(two, { ...opts, shrink: true }).written).toBe(true);
    expect(readBackup(opts).settings.profiles).toHaveLength(2);
  });

  it('allows growth and equality without being asked', () => {
    writeBackup(two, opts);
    expect(writeBackup(four, opts).written).toBe(true);
    expect(writeBackup(four, opts).written).toBe(true);
  });
});
