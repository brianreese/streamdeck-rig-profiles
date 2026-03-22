// govee.test.js — unit tests for govee.js
//
// All tests are network-free.  The injectable { _fetch } param replaces every
// real HTTP call.  The overridable { cachePath } param redirects disk I/O to a
// temp directory that is cleaned up after each test.
//
// Tests in this file:
//   keyHint          — pure function (last-4-chars)
//   loadCache/saveCache  — JSON round-trip via real temp files
//   _resetForTesting — clears the module-level deviceCache Map
//   init             — network discovery path, cache-hit path, no-key path
//   activateScene    — empty cache warn, device not found, scene not found,
//                      successful fire, allowlist filtering, allSettled behaviour
//   getDiscoveredDevices — correct shape from populated cache
//   clearCache       — deletes file + clears cache

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  keyHint,
  init,
  activateScene,
  getDiscoveredDevices,
  clearCache,
  _resetForTesting,
} from './govee.js';

// ---------------------------------------------------------------------------
// Shared temp-directory helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  const dir = join(tmpdir(), `govee-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let tmpDir;
let cacheFile;

beforeEach(() => {
  tmpDir    = makeTempDir();
  cacheFile = join(tmpDir, 'govee-cache.json');
  _resetForTesting();          // ensure a clean in-memory Map each test
  vi.restoreAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// keyHint
// ---------------------------------------------------------------------------

describe('keyHint', () => {
  it('returns the last 4 characters of the key', () => {
    expect(keyHint('ABCDEFGH')).toBe('EFGH');
  });

  it('returns the whole string when length ≤ 4', () => {
    expect(keyHint('XY')).toBe('XY');
  });

  it('works with exactly 4 characters', () => {
    expect(keyHint('ABCD')).toBe('ABCD');
  });
});

// ---------------------------------------------------------------------------
// loadCache / saveCache round-trip (via init with mocked fetch)
// ---------------------------------------------------------------------------

describe('cache round-trip', () => {
  /** Build a minimal _fetch stub that returns one device with one scene. */
  function makeFetch() {
    return vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/user/devices')) {
        return jsonOk({ data: [{ device: 'dev-001', sku: 'H6159', deviceName: 'Lamp' }] });
      }
      if (url.includes('diy-scenes')) {
        return jsonOk({ payload: { capabilities: [] } });
      }
      // device/scenes
      return jsonOk({
        payload: {
          capabilities: [{
            type: 'devices.capabilities.dynamic_scene',
            instance: 'lightScene',
            parameters: { options: [{ name: 'Sunrise', value: 42 }] },
          }],
        },
      });
    });
  }

  it('saves cache to disk after init', async () => {
    const _fetch = makeFetch();
    await init('test-key-1234', { _fetch, cachePath: cacheFile });

    expect(existsSync(cacheFile)).toBe(true);
    const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(data.apiKeyHint).toBe('1234');
    expect(data.devices).toHaveLength(1);
    expect(data.devices[0].id).toBe('dev-001');
    expect(data.devices[0].sceneMap['Sunrise']).toBeDefined();
  });

  it('loads from cache without hitting the network', async () => {
    const _fetch = makeFetch();
    // First call populates the cache.
    await init('test-key-ABCD', { _fetch, cachePath: cacheFile });
    const callCount = _fetch.mock.calls.length;

    // Second call should serve from cache — no extra fetch calls.
    _resetForTesting();
    await init('test-key-ABCD', { _fetch, cachePath: cacheFile });
    expect(_fetch.mock.calls.length).toBe(callCount);       // no new network calls
    expect(getDiscoveredDevices()).toHaveLength(1);
  });

  it('refreshes when the API key hint changes', async () => {
    const _fetch = makeFetch();
    await init('old-key-ZZZZ', { _fetch, cachePath: cacheFile });
    const firstCount = _fetch.mock.calls.length;

    _resetForTesting();
    await init('new-key-XXXX', { _fetch, cachePath: cacheFile });
    // Must have made new network calls
    expect(_fetch.mock.calls.length).toBeGreaterThan(firstCount);
  });

  it('forceRefresh bypasses cache and re-fetches', async () => {
    const _fetch = makeFetch();
    await init('test-key-1234', { _fetch, cachePath: cacheFile });
    const firstCount = _fetch.mock.calls.length;

    await init('test-key-1234', { forceRefresh: true, _fetch, cachePath: cacheFile });
    expect(_fetch.mock.calls.length).toBeGreaterThan(firstCount);
  });
});

// ---------------------------------------------------------------------------
// _resetForTesting
// ---------------------------------------------------------------------------

describe('_resetForTesting', () => {
  it('clears the in-memory device cache', async () => {
    const _fetch = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/user/devices')) {
        return jsonOk({ data: [{ device: 'dev-001', sku: 'H6159', deviceName: 'Lamp' }] });
      }
      return jsonOk({ payload: { capabilities: [] } });
    });

    await init('key-DCBA', { _fetch, cachePath: cacheFile });
    expect(getDiscoveredDevices()).toHaveLength(1);

    _resetForTesting();
    expect(getDiscoveredDevices()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// init — no API key
// ---------------------------------------------------------------------------

describe('init — no API key', () => {
  it('does nothing and logs when apiKey is falsy', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await init('');
    expect(getDiscoveredDevices()).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('No API key'));
  });
});

// ---------------------------------------------------------------------------
// activateScene
// ---------------------------------------------------------------------------

describe('activateScene — empty cache', () => {
  it('warns and returns when device cache is empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const _fetch = vi.fn();
    await activateScene('key', 'Sunrise', null, { _fetch });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('device cache is empty'));
    expect(_fetch).not.toHaveBeenCalled();
  });
});

describe('activateScene — populated cache', () => {
  const API_KEY = 'unit-test-KEY1';

  /** Seed the cache with two devices, each with one scene entry. */
  async function seedCache() {
    const _fetch = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/user/devices')) {
        return jsonOk({
          data: [
            { device: 'dev-A', sku: 'H6159', deviceName: 'Lamp A' },
            { device: 'dev-B', sku: 'H6159', deviceName: 'Lamp B' },
          ],
        });
      }
      if (url.includes('diy-scenes')) return jsonOk({ payload: { capabilities: [] } });
      return jsonOk({
        payload: {
          capabilities: [{
            type: 'devices.capabilities.dynamic_scene',
            instance: 'lightScene',
            parameters: { options: [{ name: 'Sunrise', value: 10 }] },
          }],
        },
      });
    });
    await init(API_KEY, { _fetch, cachePath: cacheFile });
  }

  beforeEach(async () => { await seedCache(); });

  it('fires device/control for each device that has the scene', async () => {
    const _fetch = vi.fn().mockResolvedValue(jsonOk({}));
    await activateScene(API_KEY, 'Sunrise', null, { _fetch });
    const controlCalls = _fetch.mock.calls.filter(([u]) => u.includes('device/control'));
    expect(controlCalls).toHaveLength(2);
  });

  it('warns and skips a device when scene not found on that device', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const _fetch = vi.fn().mockResolvedValue(jsonOk({}));
    await activateScene(API_KEY, 'NonExistentScene', null, { _fetch });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"NonExistentScene" not found'));
    expect(_fetch).not.toHaveBeenCalled();
  });

  it('only targets allowlisted device names', async () => {
    const _fetch = vi.fn().mockResolvedValue(jsonOk({}));
    await activateScene(API_KEY, 'Sunrise', ['Lamp A'], { _fetch });
    const controlCalls = _fetch.mock.calls.filter(([u]) => u.includes('device/control'));
    expect(controlCalls).toHaveLength(1);
    const body = JSON.parse(controlCalls[0][1].body);
    expect(body.payload.device).toBe('dev-A');
  });

  it('warns about device names not found in cache', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const _fetch = vi.fn().mockResolvedValue(jsonOk({}));
    await activateScene(API_KEY, 'Sunrise', ['Lamp A', 'Missing Light'], { _fetch });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Missing Light" not found'));
  });

  it('passes the correct capability payload to device/control', async () => {
    const _fetch = vi.fn().mockResolvedValue(jsonOk({}));
    await activateScene(API_KEY, 'Sunrise', ['Lamp A'], { _fetch });
    const body = JSON.parse(_fetch.mock.calls[0][1].body);
    expect(body.payload.capability).toMatchObject({
      type: 'devices.capabilities.dynamic_scene',
      instance: 'lightScene',
      value: 10,
    });
  });

  it('continues with remaining devices when one control call fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let callCount = 0;
    const _fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First device/control call fails
        return { ok: false, status: 429, statusText: 'Too Many Requests' };
      }
      return jsonOk({});
    });
    await activateScene(API_KEY, 'Sunrise', null, { _fetch });
    expect(_fetch).toHaveBeenCalledTimes(2);         // both devices attempted
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Device control error'));
  });
});

// ---------------------------------------------------------------------------
// getDiscoveredDevices
// ---------------------------------------------------------------------------

describe('getDiscoveredDevices', () => {
  it('returns { id, name } pairs for each cached device', async () => {
    const _fetch = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/user/devices')) {
        return jsonOk({
          data: [
            { device: 'id-1', sku: 'H6001', deviceName: 'Strip 1' },
            { device: 'id-2', sku: 'H6001', deviceName: 'Strip 2' },
          ],
        });
      }
      return jsonOk({ payload: { capabilities: [] } });
    });
    await init('key-WXYZ', { _fetch, cachePath: cacheFile });
    const devices = getDiscoveredDevices();
    expect(devices).toEqual([
      { id: 'id-1', name: 'Strip 1' },
      { id: 'id-2', name: 'Strip 2' },
    ]);
  });

  it('returns an empty array when cache is empty', () => {
    expect(getDiscoveredDevices()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clearCache
// ---------------------------------------------------------------------------

describe('clearCache', () => {
  it('deletes the on-disk cache file', async () => {
    const _fetch = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/user/devices')) return jsonOk({ data: [] });
      return jsonOk({ payload: { capabilities: [] } });
    });
    await init('key-CLR1', { _fetch, cachePath: cacheFile });
    expect(existsSync(cacheFile)).toBe(true);

    clearCache({ cachePath: cacheFile });
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('clears the in-memory device cache', async () => {
    const _fetch = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/user/devices')) {
        return jsonOk({ data: [{ device: 'dev-X', sku: 'H6001', deviceName: 'Dev X' }] });
      }
      return jsonOk({ payload: { capabilities: [] } });
    });
    await init('key-CLR2', { _fetch, cachePath: cacheFile });
    expect(getDiscoveredDevices()).toHaveLength(1);

    clearCache({ cachePath: cacheFile });
    expect(getDiscoveredDevices()).toHaveLength(0);
  });

  it('is safe to call when no cache file exists', () => {
    expect(() => clearCache({ cachePath: cacheFile })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a plain object in a minimal Response-like for use with _fetch stubs. */
function jsonOk(body) {
  const json = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => JSON.parse(json),
  };
}
