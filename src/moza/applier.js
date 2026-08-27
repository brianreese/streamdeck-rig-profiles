// moza/applier.js — the boundary between "which preset" and "push it to the
// pedal".
//
// Everything else in the MOZA provider is complete and tested: finding the
// preset library, listing presets, reading which one Pit House has loaded.
// This file is the one piece that cannot be finished yet, and it is isolated
// here deliberately so that finishing it touches nothing else.
//
// THE OFFICIAL SDK CANNOT DO THIS — checked against SDK 1.0.1.8
// ------------------------------------------------------------
// MOZA's SDK page advertises pedal support "including mBooster", which is
// misleading. `mozaAPI.h` declares 119 functions, of which the *entire* pedal
// surface is seven settable values:
//
//   setPedalBrakeOutDir      setPedalBrakeNonLinear   setPedalBrakePressCombine
//   setPedalAccOutDir        setPedalAccNonLinear
//   setPedalClutchOutDir     setPedalClutchNonLinear
//   (+ calibration start/finish)
//
// An mBooster preset carries ~91 parameters — brake_forcelimit_max,
// brake_damping_press, brake_abs_amp, brake_forces_curve, brake_stroke_curve
// and so on. None of them are reachable. There is no generic set-by-name
// function, and the string "mBooster" does not appear in any header.
//
// This also explains the community plugin: it applies *motor* presets only.
// Not an oversight — the SDK simply cannot carry pedal presets.
//
// WHAT PIT HOUSE ACTUALLY DOES (observed via moza-watch.mjs)
// ---------------------------------------------------------
// On applying a pedal preset it rewrites, within the same second:
//   LocalParameters\MBoost\<serial>.json   every changed value
//   Presets\config.ini                     [LastUsedPreset] <deviceId>=<uuid>
//
// LocalParameters entries are plain `{ enabled, value }` — a mirror of applied
// state, carrying no register or address information, so it is not a shortcut
// into the wire protocol.
//
// The parameters must therefore reach the pedal over MOZA's own device
// protocol, which runs on the per-device USB serial port (mBooster is
// VID_346E PID_0008, serial 3f003d001951343132393730).
//
// TO FINISH
// ---------
// Capture the COM traffic while a preset is applied by hand in Pit House, and
// reproduce the frames. That is the same method that cracked the Fanatec
// wheelbase, and it is the only route left — Boxflat (open source, Linux) is
// the best existing reference for MOZA's serial framing.

import { existsSync } from 'fs';
import { join } from 'path';

/** Places the SDK might reasonably live, in priority order. */
export function sdkSearchPaths(env = process.env) {
  return [
    env.MOZA_SDK_DIR,
    join(env.ProgramFiles ?? 'C:\\Program Files', 'MOZA', 'SDK'),
    join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'MOZA', 'SDK'),
    join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'MOZA Pit House', 'bin'),
  ].filter(Boolean);
}

export const SDK_DLL = 'MOZA_API_C.dll';

/** Full path to the SDK library, or null when it is not installed. */
export function locateSdk(env = process.env) {
  for (const dir of sdkSearchPaths(env)) {
    const candidate = join(dir, SDK_DLL);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether a preset can actually be pushed to the hardware right now.
 * @returns {{ available: boolean, reason: string, sdkPath: string|null }}
 */
export function backendStatus(env = process.env) {
  const sdkPath = locateSdk(env);
  if (!sdkPath) {
    return {
      available: false,
      sdkPath: null,
      reason:
        `MOZA SDK not found (looked for ${SDK_DLL}). Install it from ` +
        'mozaracing.com/pages/sdk, or set MOZA_SDK_DIR to its folder.',
    };
  }
  return {
    available: false,
    sdkPath,
    reason:
      `Found ${SDK_DLL}, but its pedal API exposes only output direction, ` +
      'non-linearity and pressure-combine — none of the ~91 mBooster preset ' +
      'parameters. The SDK cannot apply pedal presets; the device serial ' +
      'protocol is required.',
  };
}

/** Delay between parameter writes; the community plugin uses 50ms. */
export const PARAM_DELAY_MS = 50;

/**
 * Push a preset's deviceParams to the pedal.
 * Throws while the backend is unavailable, so the provider reports the reason
 * rather than silently doing nothing.
 */
export async function applyParams(deviceParams, { env = process.env } = {}) {
  const status = backendStatus(env);
  if (!status.available) throw new Error(status.reason);
  // Intentionally unreachable until the bindings above are implemented.
  throw new Error('MOZA SDK bindings not implemented');
}
