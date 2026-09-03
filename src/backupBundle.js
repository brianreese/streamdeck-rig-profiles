// backupBundle.js — the file a person downloads, keeps, and drops back in.
//
// Distinct from the mirror in settingsBackup.js, which is machinery: written
// automatically, read only at startup, never seen. This is the artifact — one
// file, portable, inspectable, and the thing that answers "I would like a copy
// of this before I change it".
//
// It is also distinct from the YAML export, and the split is deliberate. The
// YAML is a config DOCUMENT: human-readable, editable, safe to commit, and
// necessarily partial because avatars are binary. This is a SNAPSHOT: complete
// enough to restore a machine, which means carrying the image bytes.
//
// What it never carries is a credential. Not by filtering on the way out — the
// settings blob it copies simply does not contain one, because secrets live in
// secrets.json. See src/secrets.js. What is recorded instead is the NAME of any
// secret that was set, so a restore can say "re-enter your Govee API key"
// rather than leaving someone to find out when the lights do not come on.
//
// Avatars are inlined as data URIs. They are profile pictures — tens of KB —
// and base64's third is worth paying to keep this a single file that survives
// being emailed to yourself.

import { readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { AVATAR_DIR, loadAvatarDataUri, saveAvatar } from './avatars.js';
import { secretsSet } from './secrets.js';
import { allSettingsFields } from './providers/index.js';
import { convertConfig } from './migrate.js';

export const BUNDLE_KIND = 'rig-profiles-backup';
export const BUNDLE_VERSION = 1;

/** Modes have lived under two keys; read either, as everything else does. */
function storedModes(globals) {
  return globals?.modes ?? globals?.scenes ?? [];
}

/**
 * Build a bundle from the current state.
 *
 * @param {object} globals the global settings blob
 */
export function buildBundle(globals, { avatarDir = AVATAR_DIR, now = () => new Date(), version = '1.0.0' } = {}) {
  const avatars = {};
  try {
    for (const file of existsSync(avatarDir) ? readdirSync(avatarDir) : []) {
      const uri = loadAvatarDataUri(file, { dir: avatarDir });
      if (uri) avatars[file] = uri;
    }
  } catch {
    // A backup without images beats no backup. The restore preview reports the
    // count, so a bundle that quietly has none is visible rather than silent.
  }

  // Names and labels only, never values.
  const set = new Set(secretsSet());
  const secretsOmitted = allSettingsFields()
    .filter((f) => f.type === 'secret')
    .map((f) => ({ key: f.key, label: f.label, wasSet: set.has(f.key) }));

  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    savedAt: now().toISOString(),
    app: { plugin: 'com.rig.profiles', version },
    settings: globals ?? {},
    avatars,
    secretsOmitted,
  };
}

/** A filename that sorts and reads well in a downloads folder. */
export function bundleFilename(now = () => new Date()) {
  return `rig-backup-${now().toISOString().slice(0, 10)}.json`;
}

function countsOf(settings) {
  return {
    profiles: settings?.profiles?.length ?? 0,
    modes: storedModes(settings).length,
  };
}

/**
 * Work out what a dropped file is, and what restoring it would do.
 *
 * Never throws, and never writes. Everything a person needs to decide with is
 * in the return value, because a restore that cannot be previewed is a restore
 * nobody should be asked to confirm.
 *
 * @returns {{ok: boolean, error?: string, kind?: 'bundle'|'yaml', summary?: object, parsed?: object}}
 */
export function inspectRestore(content) {
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: 'The file was empty.' };

  // JSON first: a bundle is the thing this format is for.
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'That is not a file this can read — the JSON is malformed.' };
    }
    if (parsed?.kind !== BUNDLE_KIND) {
      return { ok: false, error: 'That JSON file is not a rig-profiles backup.' };
    }
    if (Number(parsed.version) > BUNDLE_VERSION) {
      return {
        ok: false,
        error: `That backup was written by a newer version of the plugin (format ${parsed.version}).`,
      };
    }
    if (!parsed.settings?.profiles?.length && !storedModes(parsed.settings).length) {
      return { ok: false, error: 'That backup contains no profiles or Modes.' };
    }

    const counts = countsOf(parsed.settings);
    return {
      ok: true,
      kind: 'bundle',
      parsed,
      summary: {
        ...counts,
        avatars: Object.keys(parsed.avatars ?? {}).length,
        savedAt: parsed.savedAt ?? null,
        // Only the ones that were actually set are worth mentioning; listing a
        // key nobody had configured is noise dressed as a warning.
        secretsToReenter: (parsed.secretsOmitted ?? []).filter((s) => s.wasSet).map((s) => s.label),
      },
    };
  }

  // Otherwise treat it as a YAML config export.
  let doc;
  try {
    doc = yaml.load(text);
  } catch (err) {
    return { ok: false, error: `That YAML could not be parsed: ${err.message}` };
  }
  if (!doc?.profiles?.length) {
    return { ok: false, error: 'That YAML file has no profiles in it.' };
  }
  return {
    ok: true,
    kind: 'yaml',
    parsed: doc,
    summary: {
      profiles: doc.profiles.length,
      modes: (doc.modes ?? doc.scenes ?? []).length,
      avatars: 0,
      savedAt: null,
      secretsToReenter: [],
      // Said plainly in the preview: a YAML is a config document and was never
      // going to carry images. Restoring one leaves the existing avatars alone
      // rather than deleting what it cannot replace.
      partial: true,
    },
  };
}

/**
 * Write a bundle's avatars back to disk.
 *
 * Restores under the bundle's own filenames, because the profiles reference
 * them by name. Failures are collected rather than thrown: a missing image
 * degrades to the initial fallback on a key, and losing the profiles because
 * one PNG was malformed would be a much worse trade.
 */
export function restoreAvatars(avatars, { dir = AVATAR_DIR, save = saveAvatar } = {}) {
  const written = [];
  const failed = [];
  for (const [filename, uri] of Object.entries(avatars ?? {})) {
    const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(String(uri));
    if (!m) {
      failed.push(filename);
      continue;
    }
    try {
      // saveAvatar owns naming, so hand it the bundle's basename as the owner
      // and let it rebuild the same filename with its own rules.
      const owner = filename.replace(/\.[^.]+$/, '').replace(/^mode-/, '');
      const kind = filename.startsWith('mode-') ? 'mode' : 'profile';
      save(owner, m[1], filename, { dir, kind });
      written.push(filename);
    } catch {
      failed.push(filename);
    }
  }
  return { written, failed };
}

/** The settings blob a restore should store, given what was dropped in. */
export function settingsFromRestore(inspected, current) {
  if (inspected.kind === 'bundle') {
    // importedFrom rides along deliberately. Without it the next start sees
    // profiles present but the YAML hash not matching, and re-imports
    // profiles.yaml straight over the restore — a restore that undoes itself
    // on the next restart.
    return { ...inspected.parsed.settings };
  }

  // A YAML carries what a YAML can carry. Everything it does not describe is
  // kept, not cleared: it is a partial document, and treating silence as
  // deletion is how an import once wiped the Govee key and every Mode.
  const doc = inspected.parsed;
  const converted = convertConfig(doc);

  // A restore must never introduce a credential, even from a hand-edited YAML
  // that happens to contain one. Secrets are entered by a person, in the
  // Hardware pane, on the machine they belong to — never carried by a document
  // that has been moved around.
  const settings = { ...current?.settings, ...converted.settings };
  for (const key of allSettingsFields().filter((f) => f.type === 'secret').map((f) => f.key)) {
    delete settings[key];
  }

  return {
    ...current,
    profiles: converted.profiles,
    modes: doc.modes ?? doc.scenes ?? storedModes(current),
    settings,
  };
}
