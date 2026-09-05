// rigState.js — named flags describing how the rig is set up right now.
//
// Deliberately a separate file from active-profile.json. That one means exactly
// one thing — which human is at the rig — and a companion plugin reads it to
// decide what a child may launch. Mixing an orthogonal axis into it would put a
// display setting in the same sentence as a safety decision.
//
//   %APPDATA%\streamdeck-rig-shared\rig-flags.json
//   ~/Library/Application Support/streamdeck-rig-shared/rig-flags.json
//
//   { "version": 1, "flags": { "vr": true }, "updated": "<ISO-8601>" }
//
// Flag VALUES are booleans, and flag NAMES are chosen by whoever configures the
// provider — `vr` is its placeholder, not a reserved word. An earlier version
// stored arbitrary strings (`display: "vr"`), which read well until you tried
// to switch one off; see providers/stateFlag.js for why that was abandoned.
//
// The point of this file is that NOTHING here knows who reads it, and nothing
// that reads it knows about this plugin. A Playnite plugin that launches VR
// titles differently reads the boolean flag by whatever name was configured;
// if this plugin is not installed, a batch file writing the same JSON works
// identically. The interface is the file, not either program — which is why
// neither imports the other.
//
// Anyone may write it. This plugin is one possible author, not the owner.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { SHARED_STATE_DIR } from './setup.js';

export const FLAGS_PATH = resolve(SHARED_STATE_DIR, 'rig-flags.json');
export const FLAGS_VERSION = 1;

/**
 * Read every flag. Never throws — a missing or corrupt file is simply no flags.
 *
 * "No file" and "flag not set" deliberately collapse to the same answer. A Mode
 * asking whether its flag is set gets `false` either way, which is correct:
 * unreadable state is not active state, and pressing the key again will write
 * the file and recover.
 */
export function readFlags({ path = FLAGS_PATH } = {}) {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed.flags === 'object' && parsed.flags ? parsed.flags : {};
  } catch {
    return {};
  }
}

/** One flag's value, or null. */
export function readFlag(name, opts) {
  const value = readFlags(opts)[name];
  return value === undefined ? null : value;
}

/**
 * Set or clear one flag, leaving the others alone.
 *
 * Written to a temporary file and renamed, so a reader never catches a half
 * written document. Passing `null` removes the flag rather than storing null,
 * because a consumer checking `flags.display` should see absence, not a value
 * that happens to be empty.
 */
export function writeFlag(name, value, { path = FLAGS_PATH } = {}) {
  const flags = readFlags({ path });
  if (value === null || value === undefined) delete flags[name];
  else flags[name] = value;

  const body = JSON.stringify({ version: FLAGS_VERSION, flags, updated: new Date().toISOString() }, null, 2);
  const tmp = `${path}.tmp`;
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(tmp, body, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  return flags;
}
