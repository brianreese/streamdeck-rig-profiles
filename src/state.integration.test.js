// state.integration.test.js — Integration test for src/state.js.
//
// Uses Node's built-in assert module.  No test framework required.
// Excluded from `npm test` (vitest) by naming convention — only *.test.js
// files are collected.  Run directly with:
//
//   node src/state.integration.test.js
//

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { readState, writeState } from './state.js';

// ---------------------------------------------------------------------------
// Minimal test runner (no framework)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

/**
 * Runs a single test inside a fresh temp directory.
 * Prints ✓ or ✗ and accumulates the pass/fail count.
 *
 * @param {string}   name  - Human-readable test description.
 * @param {Function} fn    - Synchronous test body.  Throw (or let assert throw)
 *                           to fail the test.
 */
function test(name, fn) {
  // Each test gets its own isolated temp directory.
  const tmpDir    = join(tmpdir(), `rig-state-test-${randomBytes(4).toString('hex')}`);
  const localPath = join(tmpDir, 'local',  'state.json');
  const sharedPath = join(tmpDir, 'shared', 'active-profile.json');
  mkdirSync(join(tmpDir, 'local'),  { recursive: true });
  mkdirSync(join(tmpDir, 'shared'), { recursive: true });

  try {
    fn({ localPath, sharedPath });
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`       ${err.message}`);
    failed++;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\nstate.js — integration tests\n');

// --- Round-trip ---------------------------------------------------------------

test('writeState + readState: activeProfile is preserved', ({ localPath, sharedPath }) => {
  writeState('brian', { localPath, sharedPath });
  const state = readState({ localPath });
  assert.equal(state.activeProfile, 'brian');
});

test('writeState + readState: lastSwitched is a valid ISO timestamp', ({ localPath, sharedPath }) => {
  const before = new Date();
  writeState('kai', { localPath, sharedPath });
  const after  = new Date();

  const state = readState({ localPath });
  assert.ok(typeof state.lastSwitched === 'string', 'lastSwitched should be a string');

  const ts = new Date(state.lastSwitched);
  assert.ok(!isNaN(ts.getTime()), 'lastSwitched should parse as a valid date');
  assert.ok(ts >= before && ts <= after, 'lastSwitched should fall within the test window');
});

test('writeState: both files contain identical contents', ({ localPath, sharedPath }) => {
  writeState('riley', { localPath, sharedPath });
  const local  = readState({ localPath });
  const shared = readState({ localPath: sharedPath });

  assert.equal(local.activeProfile,  'riley');
  assert.equal(shared.activeProfile, 'riley');
  assert.equal(local.lastSwitched,   shared.lastSwitched);
});

test('successive writes overwrite — last write wins', ({ localPath, sharedPath }) => {
  writeState('brian', { localPath, sharedPath });
  writeState('kai',   { localPath, sharedPath });

  const state = readState({ localPath });
  assert.equal(state.activeProfile, 'kai');
});

// --- Graceful fallback: missing file ------------------------------------------

test('readState returns { activeProfile: null } when local file is absent', ({ localPath }) => {
  // localPath has not been written yet
  const state = readState({ localPath });
  assert.equal(state.activeProfile, null);
});

// --- Graceful fallback: malformed JSON ----------------------------------------

test('readState returns { activeProfile: null } on malformed JSON', ({ localPath }) => {
  writeFileSync(localPath, '{ this is not valid JSON !!', 'utf8');
  const state = readState({ localPath });
  assert.equal(state.activeProfile, null);
});

test('readState returns { activeProfile: null } on empty file', ({ localPath }) => {
  writeFileSync(localPath, '', 'utf8');
  const state = readState({ localPath });
  assert.equal(state.activeProfile, null);
});

test('readState returns { activeProfile: null } when JSON lacks activeProfile key', ({ localPath }) => {
  writeFileSync(localPath, JSON.stringify({ something: 'else' }), 'utf8');
  const state = readState({ localPath });
  assert.equal(state.activeProfile, null);
});

// --- Type coercion ------------------------------------------------------------

test('readState coerces non-string activeProfile to null', ({ localPath }) => {
  writeFileSync(localPath, JSON.stringify({ activeProfile: 123, lastSwitched: 'ts' }), 'utf8');
  const state = readState({ localPath });
  assert.equal(state.activeProfile, null);
});

test('readState coerces non-string lastSwitched to undefined', ({ localPath }) => {
  writeFileSync(localPath, JSON.stringify({ activeProfile: 'brian', lastSwitched: 999 }), 'utf8');
  const state = readState({ localPath });
  assert.equal(state.activeProfile, 'brian');
  assert.equal(state.lastSwitched, undefined);
});

// --- Atomic write: no leftover .tmp -------------------------------------------

test('no leftover .tmp files after a successful write', ({ localPath, sharedPath }) => {
  writeState('brian', { localPath, sharedPath });
  assert.ok(!existsSync(`${localPath}.tmp`),  'local .tmp file should not exist after write');
  assert.ok(!existsSync(`${sharedPath}.tmp`), 'shared .tmp file should not exist after write');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
