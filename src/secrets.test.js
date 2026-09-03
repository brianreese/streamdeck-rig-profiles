import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  readSecret, readSecrets, writeSecret, secretsSet, withSecrets, harvestSecrets, SECRETS_PATH,
} from './secrets.js';

let dir;
let opts;
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'rig-secrets-'));
  opts = { path: resolve(dir, 'secrets.json') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the store', () => {
  it('round-trips a value', () => {
    writeSecret('goveeApiKey', 'abc123', opts);
    expect(readSecret('goveeApiKey', opts)).toBe('abc123');
  });

  it('treats missing and corrupt alike as no secrets', () => {
    expect(readSecrets(opts)).toEqual({});
    writeSecret('k', 'v', opts);
    writeFileSync(opts.path, '{"secrets": {"k', 'utf8');
    expect(readSecrets(opts)).toEqual({});
    expect(readSecret('k', opts)).toBeNull();
  });

  it('removes on null or empty, rather than storing a blank', () => {
    writeSecret('k', 'v', opts);
    writeSecret('k', null, opts);
    expect(readSecrets(opts)).toEqual({});
    writeSecret('k', 'v', opts);
    writeSecret('k', '', opts);
    expect(readSecrets(opts)).toEqual({});
  });

  it('leaves other secrets alone when one changes', () => {
    writeSecret('a', '1', opts);
    writeSecret('b', '2', opts);
    writeSecret('a', null, opts);
    expect(readSecret('b', opts)).toBe('2');
  });

  it('reports which are set without revealing them', () => {
    writeSecret('a', '1', opts);
    writeSecret('b', '', opts);
    expect(secretsSet(opts)).toEqual(['a']);
  });

  it('writes atomically and leaves no temp file', () => {
    writeSecret('k', 'v', opts);
    expect(existsSync(`${opts.path}.tmp`)).toBe(false);
  });
});

describe('the test-path redirect', () => {
  it('never points at the real store while the suite runs', () => {
    // This exists because the suite once wrote a fixture value into the real
    // %APPDATA% secrets file. A plugin reading "k" as its Govee key fails in a
    // way that looks exactly like the credential being revoked.
    expect(process.env.VITEST).toBeTruthy();
    expect(SECRETS_PATH).not.toMatch(/com\.rig\.profiles[\/]secrets\.json$/);
  });
});

describe('provider context', () => {
  it('overlays secrets under the name providers already read', () => {
    // govee reads ctx.settings.goveeApiKey and should not have to learn that
    // the value moved house.
    writeSecret('goveeApiKey', 'abc123', opts);
    expect(withSecrets({ goveeDevices: ['Strip'] }, opts)).toEqual({
      goveeDevices: ['Strip'],
      goveeApiKey: 'abc123',
    });
  });

  it('survives no settings and no secrets', () => {
    expect(withSecrets(undefined, opts)).toEqual({});
  });
});

describe('harvesting — the guarantee', () => {
  const blob = () => ({
    profiles: [{ id: 'brian' }],
    settings: { goveeApiKey: 'leaky', mozaClosePitHouse: true },
  });

  it('moves a declared secret out of the blob and into the store', () => {
    const { blob: cleaned, harvested } = harvestSecrets(blob(), ['goveeApiKey'], opts);
    expect(harvested).toEqual(['goveeApiKey']);
    expect(cleaned.settings.goveeApiKey).toBeUndefined();
    expect(readSecret('goveeApiKey', opts)).toBe('leaky');
  });

  it('leaves everything else untouched', () => {
    const { blob: cleaned } = harvestSecrets(blob(), ['goveeApiKey'], opts);
    expect(cleaned.settings.mozaClosePitHouse).toBe(true);
    expect(cleaned.profiles).toEqual([{ id: 'brian' }]);
  });

  it('means a serialised blob cannot contain the credential', () => {
    // The assertion the whole backup promise rests on.
    const { blob: cleaned } = harvestSecrets(blob(), ['goveeApiKey'], opts);
    expect(JSON.stringify(cleaned)).not.toContain('leaky');
  });

  it('strips an empty secret without storing one', () => {
    const { blob: cleaned, harvested } = harvestSecrets(
      { settings: { goveeApiKey: '' } }, ['goveeApiKey'], opts,
    );
    expect(harvested).toEqual([]);
    expect('goveeApiKey' in cleaned.settings).toBe(false);
    expect(readSecrets(opts)).toEqual({});
  });

  it('is a no-op when there is nothing to harvest', () => {
    const original = { settings: { mozaClosePitHouse: true } };
    const { blob: cleaned, harvested } = harvestSecrets(original, ['goveeApiKey'], opts);
    expect(harvested).toEqual([]);
    expect(cleaned).toBe(original);
    expect(existsSync(opts.path)).toBe(false);
  });

  it('tolerates a blob with no settings at all', () => {
    const original = { profiles: [] };
    expect(harvestSecrets(original, ['goveeApiKey'], opts).blob).toBe(original);
  });
});
