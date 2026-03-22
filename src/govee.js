// govee.js — Govee scene activation via the Govee Developer REST API.
//
// Design: auto-discovery.  Only the API key is required — no device IDs are
// configured anywhere.  Call init(apiKey) once at plugin startup to discover
// all devices linked to the account and build a per-device scene catalog cache.
// On each profile switch, call activateScene(apiKey, sceneName) to fire the
// scene on every discovered device (or a subset via the optional allowlist).
//
// API base:  https://openapi.api.govee.com/router/api/v1
// Auth:      Govee-API-Key header
//
// ---------------------------------------------------------------------------
// Scene types (Govee OpenAPI)
// ---------------------------------------------------------------------------
//
//   Dynamic scenes  — POST /device/scenes
//     Factory-defined animated light shows ("Sunrise", "Aurora", "Rainbow", …).
//     Capability:    devices.capabilities.dynamic_scene / lightScene
//     Control value: { paramId: number, id: number }
//
//   DIY / Snapshot scenes  — POST /device/diy-scenes
//     User-created scenes, covering both the "DIY" and "Snapshot" categories
//     visible in the Govee app.  Both appear here under the user's own names.
//     Capability:    devices.capabilities.diy_color_setting / diyScene
//     Control value: integer (scene ID assigned by Govee)
//
// Both catalogs are fetched per device and merged into a single name-keyed map.
// DIY/Snapshot scenes take precedence over dynamic scenes on name collision.
//
// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------
//
// Discovery + catalog fetches are expensive (~2-5 s per device).  Results are
// persisted to data/govee-cache.json after each successful init().
//
// Default behaviour:   cache is loaded on startup if present; API is not called.
// Bypass the cache:    init(apiKey, { forceRefresh: true })
// Clear manually:      clearCache()  — or delete data/govee-cache.json
//
// TODO(pre-launch): add a TTL so the cache auto-refreshes after e.g. 24 h.
//   For now it is indefinite; the "Discover Devices" PI button should call
//   init(apiKey, { forceRefresh: true }) when the user wants a live refresh.
//
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
//
//   init(apiKey, { forceRefresh?: boolean })
//     Builds device + scene cache (from disk or network).
//
//   activateScene(apiKey, sceneName, allowlist?)
//     Fires sceneName on all cached devices (or allowlisted subset).
//
//   getDiscoveredDevices()
//     Returns [{ id, name }] snapshot for the property inspector.
//
//   clearCache()
//     Clears the in-memory cache and deletes data/govee-cache.json.
//
//   CACHE_PATH  (exported constant)
//     Absolute path of the on-disk cache file.

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { PLUGIN_DATA_DIR } from './setup.js';

const API_BASE  = 'https://openapi.api.govee.com/router/api/v1';

/** Absolute path of the on-disk discovery/scene cache file.
 *  Lives in the platform app-support directory, not the repo tree.
 *    macOS:   ~/Library/Application Support/com.rig.profiles/govee-cache.json
 *    Windows: %APPDATA%\com.rig.profiles\govee-cache.json
 */
export const CACHE_PATH = resolve(PLUGIN_DATA_DIR, 'govee-cache.json');

// ---------------------------------------------------------------------------
// Module-level in-memory cache
// ---------------------------------------------------------------------------

/**
 * Map of deviceId → { sku: string, deviceName: string, sceneMap: SceneMap }
 *
 * SceneMap: sceneName → { type, instance, value }
 * Populated by init(); empty until then.
 */
let deviceCache = new Map();

// ---------------------------------------------------------------------------
// Internal helpers — network
// ---------------------------------------------------------------------------

/**
 * Fetch all devices linked to the API key.
 *
 * @param {string} apiKey
 * @returns {Promise<Array<{device: string, sku: string, deviceName: string}>>}
 */
async function discoverDevices(apiKey) {
  const res = await fetch(`${API_BASE}/user/devices`, {
    headers: { 'Govee-API-Key': apiKey },
  });
  if (!res.ok) throw new Error(`[govee] Device discovery failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  return body.data ?? [];
}

/**
 * Fetch one scene catalog endpoint for a device and return a name → capability map.
 *
 * Works for both:
 *   endpoint = 'device/scenes'      (factory dynamic scenes)
 *   endpoint = 'device/diy-scenes'  (user-created DIY + Snapshot scenes)
 *
 * Both endpoints share the same response shape:
 *   body.payload.capabilities[].parameters.options[] = [{ name, value }, …]
 *
 * Non-fatal on HTTP errors — returns {} so one bad endpoint won't abort init().
 *
 * @param {string} apiKey
 * @param {string} device    Device ID
 * @param {string} sku       Device model SKU
 * @param {string} endpoint  Path segment, e.g. 'device/scenes'
 * @returns {Promise<Record<string, {type: string, instance: string, value: *}>>}
 */
async function fetchSceneCatalog(apiKey, device, sku, endpoint) {
  try {
    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Govee-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), payload: { sku, device } }),
    });
    if (!res.ok) {
      console.warn(`[govee] ${endpoint} fetch failed for ${device}: ${res.status}`);
      return {};
    }
    const body = await res.json();
    const map = {};
    for (const cap of body.payload?.capabilities ?? []) {
      for (const opt of cap?.parameters?.options ?? []) {
        if (opt.name != null) {
          map[opt.name] = { type: cap.type, instance: cap.instance, value: opt.value };
        }
      }
    }
    return map;
  } catch (err) {
    console.warn(`[govee] Could not fetch ${endpoint} for ${device}: ${err.message}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — disk cache
// ---------------------------------------------------------------------------

/** Returns the last 4 chars of the key — enough to detect a change, not enough to expose it. */
function keyHint(apiKey) {
  return apiKey.slice(-4);
}

/**
 * Load device cache from disk into the in-memory Map.
 * Returns true if loaded successfully, false if absent, stale (key mismatch), or corrupt.
 */
function loadCache(apiKey) {
  if (!existsSync(CACHE_PATH)) return false;
  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (data.apiKeyHint !== keyHint(apiKey)) {
      console.log('[govee] API key changed since last cache — refreshing from network.');
      return false;
    }
    deviceCache.clear();
    for (const d of data.devices ?? []) {
      deviceCache.set(d.id, { sku: d.sku, deviceName: d.deviceName, sceneMap: d.sceneMap ?? {} });
    }
    console.log(
      `[govee] Loaded ${deviceCache.size} device(s) from cache (${data.cachedAt}). ` +
      'Use { forceRefresh: true } to bypass.'
    );
    return true;
  } catch (err) {
    console.warn(`[govee] Could not read cache — refreshing from network: ${err.message}`);
    return false;
  }
}

/** Persist the current in-memory cache to disk. */
function saveCache(apiKey) {
  try {
    mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
    const data = {
      cachedAt: new Date().toISOString(),
      apiKeyHint: keyHint(apiKey),
      devices: [...deviceCache.entries()].map(([id, { sku, deviceName, sceneMap }]) => ({
        id, sku, deviceName, sceneMap,
      })),
    };
    writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[govee] Cache saved → ${CACHE_PATH}`);
  } catch (err) {
    console.warn(`[govee] Could not save cache: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all Govee devices and build the scene catalog cache.
 *
 * On first call (or when forceRefresh is true), hits the Govee API:
 *   1. GET  /user/devices          — enumerate linked devices
 *   2. POST /device/scenes         — per device: factory/dynamic scene catalog
 *   3. POST /device/diy-scenes     — per device: user DIY + Snapshot scenes
 * Results are merged (DIY wins on name collision) and saved to data/govee-cache.json.
 *
 * Subsequent calls load from cache unless forceRefresh is set.
 *
 * If apiKey is falsy (Govee not configured), clears the cache and returns.
 *
 * @param {string}  apiKey
 * @param {{ forceRefresh?: boolean }} opts
 */
export async function init(apiKey, { forceRefresh = false } = {}) {
  if (!apiKey) {
    console.log('[govee] No API key configured — Govee integration disabled.');
    deviceCache.clear();
    return;
  }

  if (!forceRefresh && loadCache(apiKey)) return;

  console.log('[govee] Fetching devices and scene catalogs from network...');
  deviceCache.clear();
  const devices = await discoverDevices(apiKey);

  for (const d of devices) {
    // Fetch factory (dynamic) scenes and user DIY/Snapshot scenes in parallel.
    const [dynamicMap, diyMap] = await Promise.all([
      fetchSceneCatalog(apiKey, d.device, d.sku, 'device/scenes'),
      fetchSceneCatalog(apiKey, d.device, d.sku, 'device/diy-scenes'),
    ]);
    // Merge: DIY/Snapshot scenes take precedence over factory scenes on name collision.
    const sceneMap = { ...dynamicMap, ...diyMap };
    deviceCache.set(d.device, { sku: d.sku, deviceName: d.deviceName ?? d.device, sceneMap });
  }

  console.log(
    `[govee] Discovered ${deviceCache.size} device(s): ` +
    [...deviceCache.values()].map(d => d.deviceName).join(', ')
  );
  saveCache(apiKey);
}

/**
 * Activate a named scene on all discovered devices (or a named subset).
 *
 * - `deviceNames` is an optional array of device name strings (as shown in the Govee app
 *   and in `settings.govee_devices` in profiles.yaml).  null/empty = all devices.
 * - Devices whose merged scene catalog does not contain `sceneName` are skipped with a warning.
 * - Uses Promise.allSettled — one device failure does not cancel the others.
 * - Logs a rejection summary after all settle.
 *
 * If the cache is empty (init() not called or no devices found), logs a warning and returns.
 *
 * @param {string}        apiKey
 * @param {string}        sceneName    Exact scene name as it appears in the Govee app.
 * @param {string[]|null} deviceNames  Optional device name allowlist. null = all devices.
 */
export async function activateScene(apiKey, sceneName, deviceNames = null) {
  if (deviceCache.size === 0) {
    console.warn('[govee] activateScene called but device cache is empty — was init() called?');
    return;
  }

  // Translate device names → IDs using the current cache.
  // Unrecognised names are warned and ignored rather than aborting the whole call.
  let targets;
  if (!deviceNames || deviceNames.length === 0) {
    targets = [...deviceCache.entries()];
  } else {
    const nameSet = new Set(deviceNames);
    targets = [...deviceCache.entries()].filter(([, { deviceName }]) => nameSet.has(deviceName));
    const foundNames = targets.map(([, { deviceName }]) => deviceName);
    const missing = deviceNames.filter(n => !foundNames.includes(n));
    for (const n of missing) {
      console.warn(`[govee] Device "${n}" not found in cache — check the name matches the Govee app.`);
    }
  }

  const results = await Promise.allSettled(
    targets.map(async ([deviceId, { sku, deviceName, sceneMap }]) => {
      const scene = sceneMap[sceneName];
      if (!scene) {
        console.warn(`[govee] Scene "${sceneName}" not found on ${deviceName} (${deviceId}) — skipping.`);
        return;
      }
      const res = await fetch(`${API_BASE}/device/control`, {
        method: 'POST',
        headers: { 'Govee-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: randomUUID(),
          payload: { sku, device: deviceId, capability: scene },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    })
  );

  // Log any rejections — device-level failures that did not abort others.
  const failed = results.filter(r => r.status === 'rejected');
  for (const r of failed) {
    console.error(`[govee] Device control error: ${r.reason?.message ?? r.reason}`);
  }
}

/**
 * Return a snapshot of cached devices for display in the property inspector.
 *
 * @returns {Array<{id: string, name: string}>}
 */
export function getDiscoveredDevices() {
  return [...deviceCache.entries()].map(([id, { deviceName }]) => ({ id, name: deviceName }));
}

/**
 * Clear the in-memory device cache and delete the on-disk cache file.
 * The next init() call will hit the network.
 */
export function clearCache() {
  deviceCache.clear();
  rmSync(CACHE_PATH, { force: true });
  console.log('[govee] Cache cleared.');
}
