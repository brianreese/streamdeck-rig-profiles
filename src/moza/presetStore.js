// moza/presetStore.js — read MOZA Pit House's preset library from disk.
//
// Pit House keeps presets as plain JSON under the user's Documents folder:
//
//   Documents\MOZA Pit House\Presets\
//     config.ini                  [LastUsedPreset] <deviceId>=<presetUuid>
//                                 [IsAutoLoadPreset] MBoost=true
//     Pedals\{uuid}.json          one file per preset
//     Motor\{uuid}.json
//     Steering Wheel\{uuid}.json
//
// A preset is { id, name, deviceType, devices, deviceParams, ... } where
// deviceParams is a flat map of ~90 device settings (brake_forcelimit_max,
// brake_damping_press, and so on).
//
// Note this is Pit House's store, NOT `Documents\MOZA Cockpit\PresetLibrary`,
// which is a separate library belonging to the Cockpit app and contains
// different presets.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const DEVICE_TYPES = ['Pedals', 'Motor', 'Steering Wheel'];

/**
 * Locate the Pit House data directory.
 *
 * Documents is commonly redirected into OneDrive, so the plain
 * USERPROFILE\Documents path is not safe to assume.
 */
export function resolvePitHouseDir({ home = homedir(), env = process.env } = {}) {
  const candidates = [
    env.MOZA_PITHOUSE_DIR,
    join(home, 'Documents', 'MOZA Pit House'),
    join(home, 'OneDrive', 'Documents', 'MOZA Pit House'),
    env.OneDrive ? join(env.OneDrive, 'Documents', 'MOZA Pit House') : null,
  ].filter(Boolean);

  return candidates.find((dir) => existsSync(join(dir, 'Presets'))) ?? null;
}

/** Minimal INI parser — enough for Pit House's flat section/key files. */
export function parseIni(text) {
  const out = {};
  let section = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(trimmed);
    if (header) {
      section = header[1];
      out[section] = out[section] ?? {};
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[section] = out[section] ?? {};
    out[section][trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * List presets, newest first.
 *
 * @param {object} [opts]
 * @param {string} [opts.deviceType] 'Pedals' | 'Motor' | 'Steering Wheel'
 * @param {string} [opts.device]     e.g. 'mBooster' — filters on the preset's
 *                                   own `devices` list, so a CRP2 preset does
 *                                   not show up for an mBooster.
 * @returns {Array<{id,name,deviceType,devices,isOfficial,lastModified,paramCount}>}
 */
export function listPresets({ dir = resolvePitHouseDir(), deviceType = 'Pedals', device = null } = {}) {
  if (!dir) return [];
  const folder = join(dir, 'Presets', deviceType);
  if (!existsSync(folder)) return [];

  const presets = [];
  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(folder, file), 'utf8'));
    } catch {
      continue; // a malformed preset must not break the whole list
    }
    if (!parsed?.name) continue;

    const devices = Array.isArray(parsed.devices) ? parsed.devices : [];
    if (device && devices.length && !devices.some((d) => sameDevice(d, device))) continue;

    presets.push({
      id: parsed.id ?? file.replace(/\.json$/, ''),
      name: parsed.name,
      deviceType: parsed.deviceType ?? deviceType,
      devices,
      isOfficial: Boolean(parsed.isOfficial),
      lastModified: Number(parsed.lastModified ?? 0),
      paramCount: Object.keys(parsed.deviceParams ?? {}).length,
    });
  }

  // Your own presets first, then official ones; newest first within each.
  return presets.sort(
    (a, b) => Number(a.isOfficial) - Number(b.isOfficial) || b.lastModified - a.lastModified,
  );
}

/** MOZA spells the same pedal "mBooster" and "MBoost" in different files. */
function sameDevice(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** Read one preset in full, including its deviceParams. */
export function readPreset(id, { dir = resolvePitHouseDir(), deviceType = 'Pedals' } = {}) {
  if (!dir) return null;
  const path = join(dir, 'Presets', deviceType, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Which preset Pit House last applied, per device id.
 * @returns {{ lastUsed: Record<string,string>, autoLoad: Record<string,boolean> }}
 */
export function readSelection({ dir = resolvePitHouseDir() } = {}) {
  const empty = { lastUsed: {}, autoLoad: {} };
  if (!dir) return empty;
  const path = join(dir, 'Presets', 'config.ini');
  if (!existsSync(path)) return empty;

  let ini;
  try {
    ini = parseIni(readFileSync(path, 'utf8'));
  } catch {
    return empty;
  }

  const autoLoad = {};
  for (const [k, v] of Object.entries(ini.IsAutoLoadPreset ?? {})) {
    autoLoad[k] = String(v).toLowerCase() === 'true';
  }
  return { lastUsed: { ...(ini.LastUsedPreset ?? {}) }, autoLoad };
}

/** True when any device currently reports the given preset id as loaded. */
export function isPresetSelected(presetId, opts) {
  return Object.values(readSelection(opts).lastUsed).includes(presetId);
}
