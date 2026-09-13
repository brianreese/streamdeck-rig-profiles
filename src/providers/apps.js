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
    return parseCommands(cfg?.commands).length ? [] : ['apps & scripts is enabled but has no commands'];
  },

  /**
   * Advice, not a verdict. Nothing here can stop a save.
   *
   * A leading shell operator almost certainly does not do what was intended:
   * commands run through `spawn(..., { shell: true })`, and on Windows that
   * shell is cmd.exe, where `&` is the command SEPARATOR rather than
   * PowerShell's call operator. `& thing.bat` asks cmd to run an empty command
   * and gets "& was unexpected at this time", exit 1.
   *
   * This was briefly a validate() rule and that was wrong twice over. It blocked
   * the ENTIRE save — profiles and Modes are saved as one document, so one bad
   * line in Flatscreen mode stopped AI Mode being fixed, which is the same shape
   * as the stale MOZA preset that once blocked saving every profile. And it
   * asserted certainty this provider does not have: a shell is whatever the OS
   * says it is, a line may be doing something clever, and refusing to store a
   * string is a strong move to make on a guess.
   *
   * The real safety net is at runtime, where apply() reports
   * "failed immediately (exit N)" instead of claiming a launch. This just gets
   * the news to whoever is typing, sooner.
   */
  warn(cfg) {
    const bad = parseCommands(cfg?.commands).filter((c) => /^[&|;]/.test(c));
    if (!bad.length) return [];
    return [
      `"${bad[0].slice(0, 44)}" starts with "${bad[0][0]}". Commands run through `
      + 'cmd.exe, which reads that as a command separator rather than a call, and answers '
      + '"& was unexpected at this time". If you copied this from PowerShell, drop the leading '
      + 'character — a path on its own line is enough.',
    ];
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
