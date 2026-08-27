// avatars.js — per-profile avatar images.
//
// The property inspector hands over the picked file's bytes; we copy them into
// the plugin data dir and store only the filename on the profile. Copying
// rather than referencing a path means an avatar survives the original being
// moved, renamed, or deleted — the profile keys keep working.
//
// Global settings hold the filename, never the image data: they are synced by
// the Stream Deck app and should stay small.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { resolve, extname } from 'path';
import { PLUGIN_DATA_DIR } from './setup.js';

export const AVATAR_DIR = resolve(PLUGIN_DATA_DIR, 'avatars');

/** Stream Deck keys are 144px; anything past a couple of MB is a mistake. */
export const MAX_BYTES = 2 * 1024 * 1024;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export const ALLOWED_EXTENSIONS = Object.keys(MIME_BY_EXT);

/** Strip anything that could escape the avatar directory. */
function safeName(profileId, ext) {
  const id = String(profileId).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'profile';
  return `${id}${ext}`;
}

/**
 * Store an avatar for a profile.
 *
 * @param {string} profileId
 * @param {string} base64        raw image bytes, base64 encoded
 * @param {string} filename      original name, used only for its extension
 * @param {object} [opts]
 * @returns {{ filename: string }}
 */
export function saveAvatar(profileId, base64, filename, { dir = AVATAR_DIR } = {}) {
  const ext = extname(String(filename ?? '')).toLowerCase();
  if (!MIME_BY_EXT[ext]) {
    throw new Error(`unsupported image type "${ext || '(none)'}" — use ${ALLOWED_EXTENSIONS.join(', ')}`);
  }

  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw new Error('image was empty');
  if (bytes.length > MAX_BYTES) {
    throw new Error(`image is ${(bytes.length / 1024 / 1024).toFixed(1)}MB — limit is 2MB`);
  }

  mkdirSync(dir, { recursive: true });

  // Replace any previous avatar for this profile, whatever its extension.
  for (const existing of listAvatarsFor(profileId, dir)) {
    if (existing !== safeName(profileId, ext)) {
      try {
        unlinkSync(resolve(dir, existing));
      } catch {
        /* best effort */
      }
    }
  }

  const name = safeName(profileId, ext);
  writeFileSync(resolve(dir, name), bytes);
  return { filename: name };
}

function listAvatarsFor(profileId, dir) {
  if (!existsSync(dir)) return [];
  const prefix = String(profileId).replace(/[^a-z0-9_-]/gi, '');
  return readdirSync(dir).filter((f) => f.startsWith(prefix) && MIME_BY_EXT[extname(f).toLowerCase()]);
}

/**
 * Read an avatar back as a data URI for embedding in a rendered key.
 * Returns null when missing — a deleted file must degrade to the initial
 * fallback, not break the key.
 */
export function loadAvatarDataUri(filename, { dir = AVATAR_DIR } = {}) {
  if (!filename) return null;
  const ext = extname(filename).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;

  const path = resolve(dir, filename);
  // Refuse anything that resolved outside the avatar directory.
  if (!path.startsWith(resolve(dir))) return null;
  if (!existsSync(path)) return null;

  try {
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}

export function deleteAvatar(filename, { dir = AVATAR_DIR } = {}) {
  if (!filename) return false;
  const path = resolve(dir, filename);
  if (!path.startsWith(resolve(dir)) || !existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
