// moza/standIn.js — make Pit House think a game started.
//
// Pit House watches for a fixed set of game executables (the names are compiled
// into its binary; GameConfigInfo.xml is only display metadata) and applies
// whichever preset you have bound to that game. Matching is on the process NAME
// alone — no path check, no signature check — so a harmless process with the
// right name is enough.
//
// That gives per-profile MOZA switching without touching the device protocol:
// bind a preset to a game you will never launch, then briefly run a stand-in
// named after it.
//
// The stand-in is a copy of Windows' own waitfor.exe, which idles silently and
// exits on its own. Nothing is installed, and no MOZA file is modified.
//
// The applied preset is sticky — it survives the process exiting — so the
// stand-in only has to live long enough to be noticed.

import { copyFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { PLUGIN_DATA_DIR } from '../setup.js';

/** Where stand-in copies are staged. */
export const STANDIN_DIR = join(PLUGIN_DATA_DIR, 'moza-standins');

/** Long enough for Pit House's ProcessMonitor to notice; it polls. */
export const DEFAULT_LINGER_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A benign, always-present Windows binary that simply waits. */
function sourceBinary(env = process.env) {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'waitfor.exe');
}

/** Reject anything that is not a plain executable file name. */
export function validateExeName(name) {
  const value = String(name ?? '').trim();
  if (!value) return 'no trigger executable set';
  if (!/^[A-Za-z0-9 _.\-]+\.exe$/i.test(value)) {
    return `"${value}" is not a plain .exe name (no paths or special characters)`;
  }
  return null;
}

/**
 * Run a stand-in process with the given executable name, then stop it.
 *
 * @param {string} exeName            e.g. "TokyoXtremeRacer.exe"
 * @param {object} [opts]
 * @param {number} [opts.lingerMs]    how long to leave it running
 * @param {Function} [opts.spawnFn]   injected for tests
 * @returns {Promise<{ pid: number|null, path: string }>}
 */
export async function runStandIn(exeName, { lingerMs = DEFAULT_LINGER_MS, spawnFn = spawn, env = process.env, dir = STANDIN_DIR } = {}) {
  const problem = validateExeName(exeName);
  if (problem) throw new Error(problem);

  const source = sourceBinary(env);
  if (!existsSync(source)) throw new Error(`cannot find ${source} to copy as a stand-in`);

  mkdirSync(dir, { recursive: true });
  const target = join(dir, exeName.trim());
  copyFileSync(source, target);

  // waitfor exits by itself, so a missed kill cannot leave a process behind.
  const child = spawnFn(target, ['RigProfileStandIn', '/t', String(Math.ceil(lingerMs / 1000) + 5)], {
    stdio: 'ignore',
    windowsHide: true,
  });

  await sleep(lingerMs);
  try {
    child.kill();
  } catch {
    /* already gone */
  }

  return { pid: child.pid ?? null, path: target };
}

/** Remove staged copies. Best effort: Windows holds the image briefly. */
export async function cleanUp({ dir = STANDIN_DIR } = {}) {
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}
