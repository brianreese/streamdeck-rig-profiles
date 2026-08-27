// moza/applier.js — the boundary between "which preset" and "push it to the
// pedal".
//
// Everything else in the MOZA provider is complete and tested: finding the
// preset library, listing presets, reading which one Pit House has loaded.
// This file is the one piece that cannot be finished yet, and it is isolated
// here deliberately so that finishing it touches nothing else.
//
// WHAT IS KNOWN
// -------------
// MOZA ships an official SDK (https://mozaracing.com/pages/sdk) with native C
// and C# libraries, and its device support explicitly includes mBooster pedal
// parameters. The community plugin d-b-c-e/moza-streamdeck-plugin bundles
// MOZA_API_C.dll / MOZA_API_CSharp.dll / MOZA_SDK.dll and applies motor presets
// by replaying a preset's deviceParams through the SDK, ~50ms apart.
//
// Its C# wrapper imports namespace `mozaAPI` and calls installMozaSDK() /
// removeMozaSDK() around getters and setters named after the parameter, e.g.
// getMotorFfbStrength(), setPedalBrakeOutDir().
//
// WHAT IS MISSING
// ---------------
// The SDK is not installed on this machine, and the community wrapper only
// exposes pedal *output direction* — not the ~90 brake_* parameters an
// mBooster preset actually carries. Writing FFI bindings now would mean
// inventing function names, so this deliberately reports itself unavailable
// rather than pretending.
//
// TO FINISH
// ---------
//  1. Install the MOZA SDK and point MOZA_SDK_DIR at it (or drop the DLLs in
//     one of the searched locations below).
//  2. Read its header for the pedal parameter API. Two shapes are plausible:
//     a generic setter keyed by parameter name, or one setter per parameter.
//     A preset's deviceParams keys (brake_forcelimit_max, brake_damping_press,
//     …) are the names to map onto.
//  3. Bind MOZA_API_C.dll with koffi (prebuilt; no compiler needed) and
//     implement applyParams() below.

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
      `Found ${SDK_DLL} but the pedal parameter bindings are not written yet — ` +
      'the SDK header is needed to map preset deviceParams onto SDK calls.',
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
