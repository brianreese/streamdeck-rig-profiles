#!/usr/bin/env node
// test-fanatec.js — manual smoke-test for src/fanatec.js
//
// Usage (from repo root):
//   node scripts/test-fanatec.js --hotkey <HOTKEY>
//
// Examples:
//   node scripts/test-fanatec.js --hotkey ctrl+alt+f1
//   node scripts/test-fanatec.js --hotkey cmd+shift+1
//
// The script will:
//   1. Parse the hotkey string via parseHotkey().
//   2. Print the normalised key + modifiers so you can verify parsing.
//   3. Fire the hotkey via activatePreset() (calls robotjs.keyTap).
//
// ⚠️  Windows only: FanaLab must be running and focused (or a global hotkey
//     configured) for the keypress to be intercepted.  On macOS you can still
//     run the script to verify hotkey parsing — just make sure some other app
//     with the same shortcut is in focus to confirm robotjs fires correctly.
//
// W-1 checkpoint: run this on the Windows sim rig with FanaLab open to confirm
//     the active tuning preset changes.  See human-implementation-guide.md.

import { parseHotkey, activatePreset } from '../src/fanatec.js';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function argValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

const hotkey = argValue('--hotkey');

if (!hotkey) {
  console.error('Error: --hotkey <KEY_COMBO> is required.');
  console.error('  Examples: ctrl+alt+f1  |  cmd+shift+1  |  alt+f2');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`[test-fanatec] Input:  "${hotkey}"`);

const parsed = parseHotkey(hotkey);
console.log(`[test-fanatec] Parsed: key="${parsed.key}"  mods=[${parsed.mods.join(', ')}]`);
console.log('[test-fanatec] Firing hotkey via robotjs …');

try {
  activatePreset(hotkey);
  console.log('[test-fanatec] Done — check FanaLab for a preset change.');
} catch (err) {
  console.error(`[test-fanatec] robotjs error: ${err.message}`);
  console.error('  If you see a native module error, run: npm rebuild robotjs');
  process.exit(1);
}
