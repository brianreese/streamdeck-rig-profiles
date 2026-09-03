// vitest.setup.js — runs once per worker, before any test file is imported.
//
// Its only job is to stop parallel workers fighting over the Stream Deck SDK's
// log file.
//
// `@elgato/streamdeck` builds a FileTarget the moment it is imported, and both
// the directory and the filename come from `process.cwd()`:
//
//     dest:     path.join(cwd(), "logs")
//     fileName: path.basename(cwd())        // -> streamdeck-rig-profiles
//
// Constructing it re-indexes the existing logs, renaming `.0.log` to `.1.log`.
// Several workers importing the SDK at once therefore race on the same rename,
// and the loser dies with:
//
//     ENOENT: no such file or directory, rename '...0.log' -> '...1.log'
//
// It surfaced as an occasional whole-file failure with no assertion attached —
// roughly one run in twenty, in whichever file happened to import the SDK
// second. Nothing to do with the code under test, which is exactly what made it
// worth removing rather than living with.
//
// The fix is to let the SDK initialise while cwd points somewhere private to
// this worker, then put cwd back. Module registries are per worker and modules
// are cached, so every later `import '@elgato/streamdeck'` gets this instance,
// with its log target already pointed at the scratch directory — and the tests
// themselves run with the real cwd, which several of them rely on.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const original = process.cwd();
const scratch = mkdtempSync(resolve(tmpdir(), `rig-sdk-logs-${process.pid}-`));

process.chdir(scratch);
try {
  // Imported for the side effect of constructing the logger, nothing else.
  await import('@elgato/streamdeck');
} finally {
  process.chdir(original);
}

// ---------------------------------------------------------------------------
// A clean secret store and backup tree for every test.
//
// Both redirect to per-process temp paths under VITEST, which stops the suite
// touching the user's real files — but a worker runs many test files in turn
// against the SAME temp path, so state still leaks between them.
//
// It bit exactly once and was worth chasing: migrate's fixture YAML carries
// `govee_api_key: "abc123"`, so importing it harvested that value into the
// shared store. A later file asserting that a provider context defaults to `{}`
// then saw `{ goveeApiKey: 'abc123' }` overlaid onto it and failed — in a file
// that had never mentioned secrets, roughly one run in twelve, depending on
// which worker happened to pick up which files.
//
// Resetting after every test kills the whole class rather than that instance.
// Tests that need state set it up themselves, so nothing depends on it
// surviving.
import { afterEach } from 'vitest';
import { _resetForTesting as resetSecrets } from './src/secrets.js';
import { _resetForTesting as resetBackups } from './src/settingsBackup.js';

afterEach(() => {
  resetSecrets();
  resetBackups();
});
