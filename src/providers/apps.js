// providers/apps.js — run apps and scripts when a profile is activated.
//
// Modelled on Playnite's script hooks: "switch to flight sim" should be able to
// open MOZA Cockpit and start eye tracking, none of which involves a wheelbase.
// This is the provider that proves the registry is genuinely modular — it
// shares no assumptions with the hardware providers at all.
//
// Commands are the user's own, entered in their own property inspector, and run
// with their own privileges — the same trust model as a desktop shortcut. They
// are never sourced from anywhere but the profile config.

import { spawn } from 'child_process';
import { STATUS } from './status.js';

/** Results of the last run, per profile-ish key, for verify() to report on. */
const lastRun = new Map();

/** One command per line. Blank lines and # comments are ignored. */
export function parseCommands(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Launch one command.
 *
 * `wait` decides the contract: a script we wait on can be verified by its exit
 * code; an app we fire and forget can only be reported as launched.
 */
function run(command, { wait, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      // shell:true so a line can be a plain path, an exe with arguments, or a
      // shell one-liner — matching what a user would type into Run.
      child = spawnFn(command, {
        shell: true,
        detached: !wait,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      return resolve({ command, ok: false, detail: err.message });
    }

    child.on('error', (err) => resolve({ command, ok: false, detail: err.message }));

    if (!wait) {
      // Let it outlive the plugin; a launched app must not die with us.
      child.unref?.();
      return resolve({ command, ok: true, detail: 'launched' });
    }

    child.on('exit', (code) =>
      resolve(
        code === 0
          ? { command, ok: true, detail: 'exited 0' }
          : { command, ok: false, detail: `exited ${code}` },
      ),
    );
  });
}

export default {
  id: 'apps',
  label: 'Apps & Scripts',
  verifiable: true,

  schema() {
    return [
      {
        key: 'commands',
        label: 'Commands',
        type: 'textarea',
        placeholder: '"C:\\Program Files (x86)\\MOZA Pit House\\MOZA Pit House.exe"\n# lines starting with # are ignored',
        help: 'One per line. Runs when this profile is activated.',
      },
      {
        key: 'wait',
        label: 'Wait for exit',
        type: 'boolean',
        help: 'Wait for each command and check its exit code. Leave off for apps you just want opened.',
      },
    ];
  },

  validate(cfg) {
    return parseCommands(cfg?.commands).length ? [] : ['apps & scripts is enabled but has no commands'];
  },

  describe(cfg) {
    const n = parseCommands(cfg?.commands).length;
    return n ? `${n} command${n === 1 ? '' : 's'}` : 'no commands';
  },

  async apply(cfg, ctx = {}) {
    const commands = parseCommands(cfg?.commands);
    const key = ctx.profileId ?? 'default';
    if (!commands.length) {
      lastRun.set(key, []);
      return;
    }

    const wait = Boolean(cfg?.wait);
    const results = [];
    // Sequential: these often depend on each other (start the service, then the
    // app that talks to it). Parallel would be faster and wrong.
    for (const command of commands) {
      results.push(await run(command, { wait, spawnFn: ctx.spawnFn }));
    }
    lastRun.set(key, results);
  },

  async verify(cfg, ctx = {}) {
    const results = lastRun.get(ctx.profileId ?? 'default') ?? [];
    if (!results.length) {
      return { status: STATUS.SKIPPED, detail: 'no commands configured' };
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return {
        status: STATUS.FAILED,
        detail: `${failed[0].command}: ${failed[0].detail}`,
      };
    }

    // Fire-and-forget tells us the process started, never that it did its job.
    if (!cfg?.wait) {
      return {
        status: STATUS.APPLIED_UNVERIFIED,
        detail: `launched ${results.length}, not waiting for them`,
      };
    }
    return { status: STATUS.VERIFIED, detail: `${results.length} command(s) exited 0` };
  },
};

export function _resetForTesting() {
  lastRun.clear();
}
