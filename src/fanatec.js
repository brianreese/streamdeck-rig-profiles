// fanatec.js — FanaLab hotkey bridge using robotjs.
//
// Prerequisites:
//   - FanaLab must be running on the same machine.
//   - A matching hotkey must be configured inside FanaLab for each profile preset.
//   - robotjs requires a native build; run `npm rebuild robotjs` after any Node
//     version change or OS-level reinstall.
//
// Public API:
//   activatePreset(hotkeyStr)  — fires the hotkey; no-op if hotkeyStr is falsy.
//
// Internal (exported for testing):
//   parseHotkey(str)           — 'ctrl+alt+f1' → { mods: ['control', 'alt'], key: 'f1' }

import robot from 'robotjs';

// ---------------------------------------------------------------------------
// Modifier name normalisation
// ---------------------------------------------------------------------------

/** Map shorthand modifier names → robotjs canonical names. */
const MOD_ALIASES = {
  ctrl:    'control',
  cmd:     'command',
  win:     'command',  // Windows key — robotjs calls it 'command' on all platforms
  opt:     'alt',
  option:  'alt',
};

/**
 * Parse a hotkey string into a robotjs-compatible descriptor.
 *
 * Examples:
 *   'ctrl+alt+f1'   → { mods: ['control', 'alt'], key: 'f1' }
 *   'cmd+shift+p'   → { mods: ['command', 'shift'], key: 'p' }
 *   'f2'            → { mods: [], key: 'f2' }
 *
 * @param {string} str
 * @returns {{ mods: string[], key: string }}
 */
export function parseHotkey(str) {
  const parts = str.toLowerCase().split('+').map(s => s.trim());
  const key   = parts.pop();
  const mods  = parts.map(m => MOD_ALIASES[m] ?? m);
  return { mods, key };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire the FanaLab hotkey for the given hotkey string.
 *
 * If `hotkeyStr` is null, undefined, or empty, returns silently (no-op).
 * This lets callers pass `profile.fanatec_preset_hotkey` directly without
 * checking whether Fanatec integration is configured for a given profile.
 *
 * @param {string|null|undefined} hotkeyStr  e.g. 'ctrl+alt+f1'
 * @param {object} [options]
 * @param {object} [options._robot]  robotjs instance override (for testing only).
 */
export function activatePreset(hotkeyStr, { _robot = robot } = {}) {
  if (!hotkeyStr) return;

  const { mods, key } = parseHotkey(hotkeyStr);
  // robotjs.keyTap(key, modifiers[])
  // Passing an empty array for modifiers is fine.
  _robot.keyTap(key, mods);
}
