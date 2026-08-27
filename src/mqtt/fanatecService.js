// mqtt/fanatecService.js — make sure something is listening behind the broker.
//
// The Mosquitto broker Fanatec installs runs as a Windows service and is
// therefore almost always up, but FanatecService.exe — the process that owns
// the hardware and answers on the bus — is not. When it is missing, commands
// publish successfully into a void: nothing applies them and nothing replies,
// which the provider correctly reports as unreachable but which looks to a user
// exactly like a powered-off wheelbase.
//
// FanatecService.exe can be started directly and runs headless, so a profile
// switch can recover from this without opening the Fanatec app or showing a
// window. Confirmed on this rig: starting it brings HW_UI_TuningsSettings_GET
// back within a few seconds.

import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export const SERVICE_EXE = 'FanatecService.exe';

/** Known install locations, most likely first. */
export function servicePaths(env = process.env) {
  return [
    env.FANATEC_SERVICE_EXE,
    join(env.ProgramFiles ?? 'C:\\Program Files', 'Fanatec', 'FanatecService', 'Service', SERVICE_EXE),
    join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Fanatec', 'FanatecService', 'Service', SERVICE_EXE),
  ].filter(Boolean);
}

export function locateService(env = process.env) {
  return servicePaths(env).find((p) => existsSync(p)) ?? null;
}

/** Is FanatecService.exe running? */
export async function isServiceRunning({ exec = run } = {}) {
  try {
    const { stdout } = await exec('tasklist', ['/FI', `IMAGENAME eq ${SERVICE_EXE}`, '/NH']);
    return stdout.toLowerCase().includes(SERVICE_EXE.toLowerCase());
  } catch {
    // If tasklist itself fails, assume it is running rather than launching a
    // second copy on a bad guess.
    return true;
  }
}

/**
 * Ensure FanatecService is running, starting it if not.
 *
 * @returns {Promise<{ started: boolean, ok: boolean, reason?: string }>}
 */
export async function ensureServiceRunning({
  env = process.env,
  exec = run,
  spawnFn = spawn,
  waitMs = 8000,
  pollMs = 500,
} = {}) {
  if (await isServiceRunning({ exec })) return { started: false, ok: true };

  const exe = locateService(env);
  if (!exe) {
    return {
      started: false,
      ok: false,
      reason: `${SERVICE_EXE} not found — install the Fanatec driver package, or set FANATEC_SERVICE_EXE`,
    };
  }

  try {
    // Detached and unref'd: it must outlive this plugin, exactly as it would
    // if the user had started the Fanatec app themselves.
    const child = spawnFn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
  } catch (err) {
    return { started: false, ok: false, reason: `could not start ${SERVICE_EXE}: ${err.message}` };
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await isServiceRunning({ exec })) return { started: true, ok: true };
  }

  return {
    started: true,
    ok: false,
    reason: `started ${SERVICE_EXE} but it did not come up within ${Math.round(waitMs / 1000)}s`,
  };
}
