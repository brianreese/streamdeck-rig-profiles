/**
 * Reload the plugin so it runs the code on disk right now.
 *
 * `streamdeck restart <uuid>` prints "Restarted" and, for a linked plugin, does
 * nothing: the process keeps its pid and goes on running whatever it started
 * with. That cost a debugging session here too — hours of a fix being correct
 * while the key kept reporting the old failure.
 *
 * So this kills the plugin's own node process and lets Stream Deck respawn it,
 * then checks the new process actually started AFTER the newest source file was
 * written. Reporting "reloaded" without that check would repeat the original
 * mistake in a friendlier voice.
 *
 * Adapted from `streamdeck-race-launcher/tools/reload.js`, which had it first.
 * The difference is that this plugin is BUILDLESS — the manifest's CodePath is
 * `src/plugin.js`, with no bundle step — so there is no single artifact whose
 * mtime means "the current code". The newest file under src/ and ui/ is that,
 * and it is what a respawn has to be newer than.
 *
 * WHAT THIS CANNOT DO: pick up a manifest change. Actions, their names and their
 * property inspectors are read by the Stream Deck APPLICATION when it loads the
 * plugin, so editing manifest.json needs the app restarted, not the process.
 * This says so rather than claiming a reload that did half the job.
 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** Where the code the plugin actually runs lives. */
const WATCHED = ['src', 'ui'];

/** Enough of the plugin's path to tell its node process from any other. */
const MATCH = 'rig.profiles';

const ps = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The newest mtime under the watched directories.
 *
 * Test files are excluded deliberately: editing a test does not change what the
 * plugin runs, and counting it would make an otherwise healthy reload look
 * stale for no reason.
 */
function newestSourceMtime(dirs = WATCHED, root = ROOT) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a watched directory that does not exist is not an error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (!/\.test\.[cm]?js$/.test(entry.name)) {
        try {
          newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
          /* vanished mid-walk; nothing to learn from it */
        }
      }
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  return newest;
}

/**
 * Plugin processes as `pid startedEpochMs`, one per line.
 *
 * The epoch conversion is explicit about UTC because `Get-Date -UFormat %s`
 * treats a local DateTime as though it were already UTC — in the sibling repo
 * that made every process look four hours old, and the script duly reported
 * healthy reloads as stale. A clock bug in the staleness check is worse than no
 * check, because it teaches you to ignore the check.
 */
const LIST = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*${MATCH}*' } |
  ForEach-Object { "$($_.ProcessId) $([int64](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds))" }`;

const listProcesses = async () =>
  (await ps(LIST))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, started] = l.split(/\s+/);
      return { pid: Number(pid), started: Number(started) };
    });

async function main() {
  const sourceMtime = newestSourceMtime();
  if (!sourceMtime) {
    console.error('found no source under src/ or ui/ — is this the right directory?');
    process.exitCode = 1;
    return;
  }

  const before = await listProcesses();
  if (before.length === 0) {
    console.log('plugin not running; Stream Deck will start it when it next loads the plugin');
    return;
  }

  for (const p of before) {
    console.log(`stopping pid ${p.pid}`);
    await ps(`Stop-Process -Id ${p.pid} -Force`);
  }

  // Stream Deck notices the exit and respawns; it is not instant.
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const now = await listProcesses();
    const fresh = now.filter((p) => !before.some((b) => b.pid === p.pid));
    if (fresh.length === 0) continue;

    // Two seconds of slack: the respawn and the file write are measured by
    // different clocks, and a reload that is right should not be called wrong
    // over milliseconds.
    const stale = fresh.filter((p) => p.started < sourceMtime - 2000);
    if (stale.length) {
      console.error(`respawned pid ${stale[0].pid} predates your newest source file — it is running old code`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `reloaded: pid ${fresh.map((p) => p.pid).join(', ')} `
      + `(source as of ${new Date(sourceMtime).toLocaleTimeString()})`,
    );
    console.log('note: manifest.json changes need the Stream Deck app restarted, not just this.');
    return;
  }

  console.error('plugin did not come back. Restart the Stream Deck application.');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
