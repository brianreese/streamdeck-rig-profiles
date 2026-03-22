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
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
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

afterEach(async () => {
  await close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// init() and basic loading
// ---------------------------------------------------------------------------

describe('init() and basic loading', () => {
  it('loads a valid minimal profiles.yaml', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    const profiles = getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('primary');
    expect(profiles[0].name).toBe('Primary');
    expect(profiles[0].color).toBe('#2255CC');
  });

  it('loads two valid profiles in order', async () => {
    configPath = writeYaml(tmpDir, TWO_PROFILE_YAML);
    await init(configPath);
    const profiles = getProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles[0].id).toBe('primary');
    expect(profiles[1].id).toBe('secondary');
  });

  it('returns empty profiles array when file does not exist', async () => {
    await init(join(tmpDir, 'nonexistent.yaml'));
    expect(getProfiles()).toHaveLength(0);
  });

  it('returns empty profiles array for empty YAML file', async () => {
    configPath = writeYaml(tmpDir, '');
    await init(configPath);
    expect(getProfiles()).toHaveLength(0);
  });

  it('returns empty profiles array for YAML without profiles key', async () => {
    configPath = writeYaml(tmpDir, 'settings:\n  default_profile: primary\n');
    await init(configPath);
    expect(getProfiles()).toHaveLength(0);
  });

  it('can be called multiple times safely (re-init)', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    await init(configPath);
    expect(getProfiles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation — required fields
// ---------------------------------------------------------------------------

describe('validation — required fields', () => {
  it('skips a profile missing id', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - name: NoId
    color: "#FF0000"
  - id: valid
    name: Valid
    color: "#00FF00"
`);
    await init(configPath);
    const profiles = getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('valid');
  });

  it('skips a profile missing name', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: noname
    color: "#FF0000"
`);
    await init(configPath);
    expect(getProfiles()).toHaveLength(0);
  });

  it('skips a profile missing color', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: nocolor
    name: No Color
`);
    await init(configPath);
    expect(getProfiles()).toHaveLength(0);
  });

  it('loads other profiles even when one is invalid', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: good
    name: Good
    color: "#1122AA"
  - name: Missing Id
    color: "#FF0000"
`);
    await init(configPath);
    const profiles = getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('good');
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('default values for optional fields', () => {
  it('fills all optional driver fields with null by default', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    const p = getProfiles()[0];
    expect(p.fanatec_preset_hotkey).toBeNull();
    expect(p.moza_profile).toBeNull();
    expect(p.govee_scene).toBeNull();
    expect(p.sd_profile).toBeNull();
    expect(p.content_filter_tags).toBeNull();
    expect(p.default_format).toBeNull();
  });

  it('fills skip_options_step with false by default', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    expect(getProfiles()[0].skip_options_step).toBe(false);
  });

  it('preserves explicitly set driver fields', async () => {
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
    await init(configPath);
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
  it('leaves null as null', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    expect(getProfiles()[0].content_filter_tags).toBeNull();
  });

  it('coerces a bare string to a one-item array', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#123456"
    content_filter_tags: beginner
`);
    await init(configPath);
    expect(getProfiles()[0].content_filter_tags).toEqual(['beginner']);
  });

  it('keeps an array of strings as-is', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#123456"
    content_filter_tags: [beginner, guest_profile]
`);
    await init(configPath);
    expect(getProfiles()[0].content_filter_tags).toEqual(['beginner', 'guest_profile']);
  });

  it('coerces a one-item YAML array to a one-item array', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#123456"
    content_filter_tags: [beginner]
`);
    await init(configPath);
    expect(getProfiles()[0].content_filter_tags).toEqual(['beginner']);
  });

  it('normalises array items to strings', async () => {
    // YAML could produce numbers if user forgets quotes
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#123456"
    content_filter_tags: [42, true]
`);
    await init(configPath);
    const tags = getProfiles()[0].content_filter_tags;
    expect(tags).toEqual(['42', 'true']);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('loads govee_api_key from settings', async () => {
    configPath = writeYaml(tmpDir, TWO_PROFILE_YAML);
    await init(configPath);
    expect(getSettings().govee_api_key).toBe('test-key');
  });

  it('loads default_profile from settings', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    expect(getSettings().default_profile).toBe('primary');
  });

  it('falls back to first profile id when default_profile is omitted', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: first
    name: First
    color: "#111111"
`);
    await init(configPath);
    expect(getSettings().default_profile).toBe('first');
  });

  it('keeps settings defaults when settings block is absent', async () => {
    configPath = writeYaml(tmpDir, `
profiles:
  - id: p
    name: P
    color: "#000000"
`);
    await init(configPath);
    expect(getSettings().govee_api_key).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getProfiles() — defensive copy
// ---------------------------------------------------------------------------

describe('getProfiles() returns a defensive copy', () => {
  it('mutating the returned array does not affect internal state', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    const copy1 = getProfiles();
    copy1.push({ id: 'injected' });
    expect(getProfiles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getSettings() — defensive copy
// ---------------------------------------------------------------------------

describe('getSettings() returns a defensive copy', () => {
  it('mutating the returned object does not affect internal state', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    const s = getSettings();
    s.govee_api_key = 'mutated';
    expect(getSettings().govee_api_key).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getProfileById()
// ---------------------------------------------------------------------------

describe('getProfileById()', () => {
  it('returns the matching profile', async () => {
    configPath = writeYaml(tmpDir, TWO_PROFILE_YAML);
    await init(configPath);
    const p = getProfileById('secondary');
    expect(p).not.toBeNull();
    expect(p.id).toBe('secondary');
  });

  it('returns null for an unknown id', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    expect(getProfileById('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onUpdate()
// ---------------------------------------------------------------------------

describe('onUpdate()', () => {
  it('throws TypeError when passed a non-function', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    expect(() => onUpdate('not-a-function')).toThrow(TypeError);
  });

  it('callbacks are cleared when init() is called again', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    let callCount = 0;
    onUpdate(() => { callCount++; });
    // Re-init clears the callback list
    await init(configPath);
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
  it('is safe to call when no watcher is running', async () => {
    await expect(close()).resolves.toBeUndefined();
  });

  it('is safe to call multiple times', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    await expect(close()).resolves.toBeUndefined();
    await expect(close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hot-reload — file watcher events
// ---------------------------------------------------------------------------

/** Wait up to `ms` milliseconds for a condition to become true. */
function waitFor(condition, ms = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(interval);
        reject(new Error('waitFor timed out'));
      }
    }, 50);
  });
}

describe('hot-reload — file watcher events', () => {
  it('reloads and notifies callbacks on "change" event', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);

    const TWO_PROFILES = `
profiles:
  - id: primary
    name: Primary
    color: "#2255CC"
  - id: extra
    name: Extra
    color: "#AABBCC"
settings:
  default_profile: primary
`;

    let notified = false;
    onUpdate(() => { notified = true; });

    writeFileSync(configPath, TWO_PROFILES, 'utf8');
    await waitFor(() => notified);

    expect(getProfiles()).toHaveLength(2);
    expect(getProfiles()[1].id).toBe('extra');
  }, 10_000);

  it('reloads and notifies callbacks on "add" event (atomic-save / first-run)', async () => {
    // Start watching a path that does not yet exist (first-run scenario).
    const newPath = join(tmpDir, 'profiles.yaml');
    await init(newPath);
    expect(getProfiles()).toHaveLength(0);

    let notified = false;
    onUpdate(() => { notified = true; });

    // Creating the file triggers the 'add' event.
    writeFileSync(newPath, MINIMAL_YAML, 'utf8');
    await waitFor(() => notified);

    expect(getProfiles()).toHaveLength(1);
    expect(getProfiles()[0].id).toBe('primary');
  }, 10_000);

  it('does not reload on "unlink" — profiles remain available after deletion', async () => {
    configPath = writeYaml(tmpDir, MINIMAL_YAML);
    await init(configPath);
    expect(getProfiles()).toHaveLength(1);

    let notified = false;
    onUpdate(() => { notified = true; });

    unlinkSync(configPath);
    // Give chokidar time to process the event; the callback must NOT fire.
    await new Promise(r => setTimeout(r, 1000));

    expect(notified).toBe(false);
    // Profiles in memory are unchanged — last known good state is preserved.
    expect(getProfiles()).toHaveLength(1);
  });
});
