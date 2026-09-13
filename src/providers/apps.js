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
/**
 * How long a fire-and-forget command gets to prove it did not die on the spot.
 *
 * Long enough that cmd.exe has reported a parse error, short enough to be
 * unnoticeable next to the rest of a profile switch.
 */
export const GRACE_MS = 600;

function run(command, { wait, spawnFn = spawn, graceMs = GRACE_MS }) {
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

      // But give it a moment to fall over first.
      //
      // "Launched" used to be resolved the instant spawn returned, which is true
      // of the SHELL and says nothing about the command. A mistyped path or a
      // line cmd.exe cannot parse starts a shell that exits non-zero
      // milliseconds later, and the key reported success every time.
      //
      // A process still alive after the grace period is the most a
      // fire-and-forget command can honestly claim. One that is already dead
      // with a non-zero code did not start, and saying so is the whole point.
      // The delay is paid once per command and is invisible beside a profile
      // switch that talks to a wheelbase.
      const settled = setTimeout(() => {
        resolve({ command, ok: true, detail: 'launched' });
      }, graceMs);
      settled.unref?.();

      child.on('exit', (code) => {
        clearTimeout(settled);
        resolve(
          code === 0
            // Exited cleanly and at once: a launcher that handed off, which is
            // a success and not worth alarming anybody about.
            ? { command, ok: true, detail: 'launched' }
            : { command, ok: false, detail: `failed immediately (exit ${code})` },
        );
      });
      return undefined;
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
  // Both: a profile may need to prepare sim software, and a scene may want to
  // start a playlist. Neither claim is about the other.
  contexts: ['profile', 'mode'],

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
    const commands = parseCommands(cfg?.commands);
    if (!commands.length) return ['apps & scripts is enabled but has no commands'];

    // A leading shell operator cannot work, and fails in a way nobody sees.
    //
    // Commands run through `spawn(..., { shell: true })`, and on Windows that
    // shell is cmd.exe. In PowerShell `&` is the call operator and a quoted path
    // needs it; in cmd it is the command SEPARATOR, so `& thing.bat` asks cmd to
    // run an empty command and it answers "& was unexpected at this time" with
    // exit 1.
    //
    // This is not hypothetical. The AI Mode key ran
    // `& C:\Users\brian\Development\pc-mode\ai-mode.bat` for days and reported
    // "launched 1" every time while nothing happened — cmd started, cmd failed,
    // and a fire-and-forget command was not watching. Structural rather than
    // environmental, so it belongs here where the editor shows it, not in
    // apply() where only the log would.
    const bad = commands.filter((c) => /^[&|;]/.test(c));
    if (bad.length) {
      return [
        `"${bad[0].slice(0, 40)}" starts with "${bad[0][0]}", which cmd.exe reads as a `
        + 'command separator rather than a call. Remove it — a path on its own line is enough.',
      ];
    }
    return [];
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
      results.push(await run(command, { wait, spawnFn: ctx.spawnFn, graceMs: ctx.graceMs }));
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
