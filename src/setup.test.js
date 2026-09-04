// tests/setup.test.js
//
// Unit tests for src/setup.js.
//
// All tests use temporary directories so they never touch the real
// config/ directory or the cross-plugin shared state directory.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { ensureConfig, SHARED_STATE_DIR } from '../src/setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  const dir = join(tmpdir(), `rig-setup-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir;
let configDir;
let sharedStateDir;
let pluginDataDir;

beforeEach(() => {
  tmpDir         = makeTempDir();
  configDir      = join(tmpDir, 'config');
  sharedStateDir = join(tmpDir, 'shared');
  pluginDataDir  = join(tmpDir, 'plugin-data');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// First-run behaviour (profiles.yaml absent)
// ---------------------------------------------------------------------------

describe('creating directories, and nothing else', () => {
  // Seeding is gone. A profile names this rig's specific hardware, so a canned
  // one cannot be right for anybody — and the importer that kept the seed alive
  // is what overwrote real configuration in all three losses (BACKLOG §8).
  it('creates every directory it is responsible for', () => {
    ensureConfig({ configDir, sharedStateDir, pluginDataDir });
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(sharedStateDir)).toBe(true);
    expect(existsSync(pluginDataDir)).toBe(true);
  });

  it('creates no profiles.yaml, and no profiles', () => {
    ensureConfig({ configDir, sharedStateDir, pluginDataDir });
    expect(existsSync(join(configDir, 'profiles.yaml'))).toBe(false);
  });

  it('returns nothing, because there is no first run to report', () => {
    expect(ensureConfig({ configDir, sharedStateDir, pluginDataDir })).toBeUndefined();
  });

  it('is safe to call twice', () => {
    ensureConfig({ configDir, sharedStateDir, pluginDataDir });
    expect(() => ensureConfig({ configDir, sharedStateDir, pluginDataDir })).not.toThrow();
  });
});

describe('an existing profiles.yaml is none of its business', () => {
  it('leaves any file in the config directory alone', () => {
    // Nothing reads config/profiles.yaml at startup any more. A file left there
    // by an older install is inert; it is neither imported nor deleted.
    mkdirSync(configDir, { recursive: true });
    const leftover = join(configDir, 'profiles.yaml');
    writeFileSync(leftover, '# left over from before\n');

    ensureConfig({ configDir, sharedStateDir, pluginDataDir });

    expect(readFileSync(leftover, 'utf8')).toBe('# left over from before\n');
  });
});

describe('shared state directory', () => {
  it('creates the shared state directory', () => {
    mkdirSync(configDir, { recursive: true });

    ensureConfig({ configDir, sharedStateDir, pluginDataDir });

    expect(existsSync(sharedStateDir)).toBe(true);
  });

  it('is safe to call when shared state dir already exists', () => {
    mkdirSync(configDir, { recursive: true });
    mkdirSync(sharedStateDir, { recursive: true });

    expect(() =>
      ensureConfig({ configDir, sharedStateDir, pluginDataDir })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin data directory
// ---------------------------------------------------------------------------

describe('plugin data directory', () => {
  it('creates the plugin data directory', () => {
    mkdirSync(configDir, { recursive: true });

    ensureConfig({ configDir, sharedStateDir, pluginDataDir });

    expect(existsSync(pluginDataDir)).toBe(true);
  });

  it('is safe to call when plugin data dir already exists', () => {
    mkdirSync(configDir, { recursive: true });
    mkdirSync(pluginDataDir, { recursive: true });

    expect(() =>
      ensureConfig({ configDir, sharedStateDir, pluginDataDir })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SHARED_STATE_DIR export
// ---------------------------------------------------------------------------

describe('SHARED_STATE_DIR', () => {
  it('is a non-empty string', () => {
    expect(typeof SHARED_STATE_DIR).toBe('string');
    expect(SHARED_STATE_DIR.length).toBeGreaterThan(0);
  });

  it('ends with streamdeck-rig-shared', () => {
    expect(SHARED_STATE_DIR).toMatch(/streamdeck-rig-shared$/);
  });
});
