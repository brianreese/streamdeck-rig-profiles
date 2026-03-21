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
let templatePath;
let profilesPath;
let sharedStateDir;

beforeEach(() => {
  tmpDir       = makeTempDir();
  configDir    = join(tmpDir, 'config');
  templatePath = join(configDir, 'profiles.yaml.template');
  profilesPath = join(configDir, 'profiles.yaml');
  sharedStateDir = join(tmpDir, 'shared');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// First-run behaviour (profiles.yaml absent)
// ---------------------------------------------------------------------------

describe('first run — profiles.yaml absent', () => {
  it('creates config dir and copies template when profiles.yaml is missing', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(templatePath, '# template content\n');

    const result = ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir });

    expect(result).toBe(true);
    expect(existsSync(profilesPath)).toBe(true);
    expect(readFileSync(profilesPath, 'utf8')).toBe('# template content\n');
  });

  it('returns true on first run', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(templatePath, '# template\n');

    expect(ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir })).toBe(true);
  });

  it('creates configDir itself if it does not exist yet', () => {
    // configDir has not been created — ensureConfig should create it
    mkdirSync(configDir, { recursive: true });
    writeFileSync(templatePath, '# t\n');
    rmSync(configDir, { recursive: true });

    ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir });

    expect(existsSync(configDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subsequent run (profiles.yaml already exists)
// ---------------------------------------------------------------------------

describe('subsequent run — profiles.yaml already exists', () => {
  it('does not overwrite an existing profiles.yaml', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(templatePath, '# template\n');
    writeFileSync(profilesPath, '# user customisations\n');

    ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir });

    expect(readFileSync(profilesPath, 'utf8')).toBe('# user customisations\n');
  });

  it('returns false when profiles.yaml already exists', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(profilesPath, '# existing\n');

    expect(ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing template
// ---------------------------------------------------------------------------

describe('missing template', () => {
  it('does not throw when template is missing', () => {
    mkdirSync(configDir, { recursive: true });
    // templatePath does not exist, profilesPath does not exist

    expect(() =>
      ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir })
    ).not.toThrow();
  });

  it('returns false when template is missing (cannot copy)', () => {
    mkdirSync(configDir, { recursive: true });

    const result = ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir });

    expect(result).toBe(false);
  });

  it('does not create profiles.yaml when template is missing', () => {
    mkdirSync(configDir, { recursive: true });

    ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir });

    expect(existsSync(profilesPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared state directory
// ---------------------------------------------------------------------------

describe('shared state directory', () => {
  it('creates the shared state directory', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(templatePath, '# t\n');

    ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir });

    expect(existsSync(sharedStateDir)).toBe(true);
  });

  it('is safe to call when shared state dir already exists', () => {
    mkdirSync(configDir, { recursive: true });
    mkdirSync(sharedStateDir, { recursive: true });
    writeFileSync(templatePath, '# t\n');

    expect(() =>
      ensureConfig({ configDir, templatePath, profilesPath, sharedStateDir })
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
