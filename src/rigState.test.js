import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFlags, readFlag, writeFlag, FLAGS_VERSION } from './rigState.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'rigflags-')), 'rig-flags.json');

describe('rig flags', () => {
  it('reads nothing from a file that is not there', () => {
    expect(readFlags({ path: fresh() })).toEqual({});
    expect(readFlag('display', { path: fresh() })).toBeNull();
  });

  it('round-trips a flag', () => {
    const path = fresh();
    writeFlag('display', 'vr', { path });
    expect(readFlag('display', { path })).toBe('vr');
  });

  it('leaves other flags alone when one changes', () => {
    const path = fresh();
    writeFlag('display', 'vr', { path });
    writeFlag('assists', 'off', { path });
    writeFlag('display', 'flatscreen', { path });
    expect(readFlags({ path })).toEqual({ display: 'flatscreen', assists: 'off' });
  });

  it('removes a flag rather than storing null', () => {
    // A consumer checking flags.display should see absence, not a value that
    // happens to be empty.
    const path = fresh();
    writeFlag('display', 'vr', { path });
    writeFlag('display', null, { path });
    expect('display' in readFlags({ path })).toBe(false);
  });

  it('treats a corrupt file as no flags rather than throwing', () => {
    // Unreadable state is not active state, and the next write recovers it.
    const path = fresh();
    writeFileSync(path, '{ not json', 'utf8');
    expect(readFlags({ path })).toEqual({});
    writeFlag('display', 'vr', { path });
    expect(readFlag('display', { path })).toBe('vr');
  });

  it('writes a version, so a reader can tell what it is looking at', () => {
    const path = fresh();
    writeFlag('display', 'vr', { path });
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.version).toBe(FLAGS_VERSION);
    expect(parsed.updated).toMatch(/^\d{4}-/);
  });

  it('leaves no temporary file behind', () => {
    // Readers must never catch a half-written document, hence write-then-rename.
    const path = fresh();
    writeFlag('display', 'vr', { path });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
