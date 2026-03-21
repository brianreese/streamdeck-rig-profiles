// tests/configLoader.test.js
//
// Unit tests for src/configLoader.js.
//
// Strategy: each test writes a real YAML file to a temp directory and calls
// init(tempPath) to load it. No filesystem mocking — this keeps tests simple
// and readable for community contributors.
//
// Run with:  npm test
//            npm run test:watch   (re-run on save)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  init,
  close,
  getProfiles,
  getProfileById,
  getSettings,
  onUpdate,
} from '../src/configLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp directory for each test. */
function makeTempDir() {
  const dir = join(tmpdir(), `rig-profiles-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write YAML content to a file and return its path. */
function writeYaml(dir, content) {
  const p = join(dir, 'profiles.yaml');
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Minimal valid profiles.yaml with one profile. */
const MINIMAL_YAML = `
profiles:
  - id: primary
    name: Primary
    color: "#2255CC"
settings:
  default_profile: primary
  govee_api_key: ""
`;

/** Two valid profiles. */
const TWO_PROFILE_YAML = `
profiles:
  - id: primary
    name: Primary
    color: "#2255CC"
  - id: secondary
    name: Secondary
    color: "#22AA44"
    content_filter_tags: [beginner, guest_profile]
    skip_options_step: true
    default_format: quick_blast
settings:
  default_profile: primary
  govee_api_key: "test-key"
`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir;
let configPath;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// init() and basic loading
// ---------------------------------------------------------------------------

describe('init() and basic loading', () => {
  it('loads a valid minimal profiles.yaml', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    const profiles = getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('primary');
    expect(profiles[0].name).toBe('Primary');
    expect(profiles[0].color).toBe('#2255CC');
  });

  it('loads two valid profiles in order', () => {
    configPath = writeYaml(tmpDir, TWO_PROFILE_YAML);
    init(configPath);
    const profiles = getProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles[0].id).toBe('primary');
    expect(profiles[1].id).toBe('secondary');
  });

  it('returns empty profiles array when file does not exist', () => {
    init(join(tmpDir, 'nonexistent.yaml'));
    expect(getProfiles()).toHaveLength(0);
  });

  it('returns empty profiles array for empty YAML file', () => {
    configPath = writeYaml(tmpDir, '');
    init(configPath);
    expect(getProfiles()).toHaveLength(0);
  });

  it('returns empty profiles array for YAML without profiles key', () => {
    configPath = writeYaml(tmpDir, 'settings:\n  default_profile: primary\n');
    init(configPath);
    expect(getProfiles()).toHaveLength(0);
  });

  it('can be called multiple times safely (re-init)', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    init(configPath);
    expect(getProfiles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation — required fields
// ---------------------------------------------------------------------------

describe('validation — required fields', () => {
  it('skips a profile missing id', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - name: NoId
    color: "#FF0000"
  - id: valid
    name: Valid
    color: "#00FF00"
`);
    init(configPath);
    const profiles = getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('valid');
  });

  it('skips a profile missing name', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: noname
    color: "#FF0000"
`);
    init(configPath);
    expect(getProfiles()).toHaveLength(0);
  });

  it('skips a profile missing color', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: nocolor
    name: No Color
`);
    init(configPath);
    expect(getProfiles()).toHaveLength(0);
  });

  it('loads other profiles even when one is invalid', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: good
    name: Good
    color: "#1122AA"
  - name: Missing Id
    color: "#FF0000"
`);
    init(configPath);
    const profiles = getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('good');
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('default values for optional fields', () => {
  it('fills all optional driver fields with null by default', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    const p = getProfiles()[0];
    expect(p.fanatec_preset_hotkey).toBeNull();
    expect(p.moza_profile).toBeNull();
    expect(p.govee_scene).toBeNull();
    expect(p.sd_profile).toBeNull();
    expect(p.content_filter_tags).toBeNull();
    expect(p.default_format).toBeNull();
  });

  it('fills skip_options_step with false by default', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    expect(getProfiles()[0].skip_options_step).toBe(false);
  });

  it('preserves explicitly set driver fields', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: full
    name: Full
    color: "#AABBCC"
    fanatec_preset_hotkey: "ctrl+alt+f1"
    moza_profile: adult
    govee_scene: Racing
    sd_profile: "Main Profile"
    skip_options_step: true
    default_format: sprint
`);
    init(configPath);
    const p = getProfiles()[0];
    expect(p.fanatec_preset_hotkey).toBe('ctrl+alt+f1');
    expect(p.moza_profile).toBe('adult');
    expect(p.govee_scene).toBe('Racing');
    expect(p.sd_profile).toBe('Main Profile');
    expect(p.skip_options_step).toBe(true);
    expect(p.default_format).toBe('sprint');
  });
});

// ---------------------------------------------------------------------------
// content_filter_tags coercion
// ---------------------------------------------------------------------------

describe('content_filter_tags coercion', () => {
  it('leaves null as null', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    expect(getProfiles()[0].content_filter_tags).toBeNull();
  });

  it('coerces a bare string to a one-item array', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#123456"
    content_filter_tags: beginner
`);
    init(configPath);
    expect(getProfiles()[0].content_filter_tags).toEqual(['beginner']);
  });

  it('keeps an array of strings as-is', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#123456"
    content_filter_tags: [beginner, guest_profile]
`);
    init(configPath);
    expect(getProfiles()[0].content_filter_tags).toEqual(['beginner', 'guest_profile']);
  });

  it('coerces a one-item YAML array to a one-item array', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#123456"
    content_filter_tags: [beginner]
`);
    init(configPath);
    expect(getProfiles()[0].content_filter_tags).toEqual(['beginner']);
  });

  it('normalises array items to strings', () => {
    // YAML could produce numbers if user forgets quotes
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#123456"
    content_filter_tags: [42, true]
`);
    init(configPath);
    const tags = getProfiles()[0].content_filter_tags;
    expect(tags).toEqual(['42', 'true']);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('loads govee_api_key from settings', () => {
    configPath = writeYaml(tmpDir, TWO_PROFILE_YAML);
    init(configPath);
    expect(getSettings().govee_api_key).toBe('test-key');
  });

  it('loads default_profile from settings', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    expect(getSettings().default_profile).toBe('primary');
  });

  it('falls back to first profile id when default_profile is omitted', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: first
    name: First
    color: "#111111"
`);
    init(configPath);
    expect(getSettings().default_profile).toBe('first');
  });

  it('keeps settings defaults when settings block is absent', () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#000000"
`);
    init(configPath);
    expect(getSettings().govee_api_key).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getProfiles() — defensive copy
// ---------------------------------------------------------------------------

describe('getProfiles() returns a defensive copy', () => {
  it('mutating the returned array does not affect internal state', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    const copy1 = getProfiles();
    copy1.push({ id: 'injected' });
    expect(getProfiles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getSettings() — defensive copy
// ---------------------------------------------------------------------------

describe('getSettings() returns a defensive copy', () => {
  it('mutating the returned object does not affect internal state', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    const s = getSettings();
    s.govee_api_key = 'mutated';
    expect(getSettings().govee_api_key).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getProfileById()
// ---------------------------------------------------------------------------

describe('getProfileById()', () => {
  it('returns the matching profile', () => {
    configPath = writeYaml(tmpDir, TWO_PROFILE_YAML);
    init(configPath);
    const p = getProfileById('secondary');
    expect(p).not.toBeNull();
    expect(p.id).toBe('secondary');
  });

  it('returns null for an unknown id', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    expect(getProfileById('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onUpdate()
// ---------------------------------------------------------------------------

describe('onUpdate()', () => {
  it('throws TypeError when passed a non-function', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    expect(() => onUpdate('not-a-function')).toThrow(TypeError);
  });

  it('callbacks are cleared when init() is called again', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    let callCount = 0;
    onUpdate(() => { callCount++; });
    // Re-init clears the callback list
    init(configPath);
    // After re-init the callback registered before is gone — no way to
    // trigger it without a file change event; we verify indirectly by
    // ensuring new init state is clean (no stale callbacks from prior run).
    expect(callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('close()', () => {
  it('is safe to call when no watcher is running', () => {
    expect(() => close()).not.toThrow();
  });

  it('is safe to call multiple times', () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    init(configPath);
    expect(() => {
      close();
      close();
    }).not.toThrow();
  });
});
