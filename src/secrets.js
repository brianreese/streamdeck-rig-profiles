// secrets.js — credentials, kept out of everything that travels.
//
//   %APPDATA%\com.rig.profiles\secrets.json      { "goveeApiKey": "..." }
//
// The rule this file exists to make true: a backup in the wrong hands must not
// contain a credential. The obvious way to get there is to strip secrets on the
// way out, and it is the wrong way — the guarantee would only ever be as strong
// as the stripper, and every future path that serialises settings (an export, a
// debug dump, a log line) would have to remember. Forgetting exactly that kind
// of thing is why docs/BACKLOG.md §8 exists.
//
// So secrets never enter the global settings blob at all. The backup mirrors
// that blob verbatim and CANNOT contain a secret, because there is not one
// there to omit. Nothing has to remember anything.
//
// A second property falls out of this for free, and it is a good one: this file
// is on disk and was never in Stream Deck's memory, so it survives the exact
// failure that lost everything else twice. A force-kill takes the profiles; the
// key is still here when the plugin comes back.
//
// This is not a vault and does not pretend to be. It is a lighting API key kept
// out of documents that get emailed around, protected by %APPDATA% being
// per-user. If a provider ever wants to store something that deserves more,
// that is the moment to revisit it — not before.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { PLUGIN_DATA_DIR } from './setup.js';

/**
 * Where secrets live — except under test, where they emphatically do not.
 *
 * The suite drives saveSettings end to end, so without this every run wrote its
 * fixture values ("key", "abc123") straight into the real store. It did exactly
 * that once before this line existed, and a plugin reading a test fixture as
 * its Govee key fails in a way that looks like the credential was revoked.
 *
 * Redirecting rather than refusing, because the round trip is worth exercising:
 * tests get a real file with real atomic writes, just not this user's one. Per
 * process, so parallel workers cannot collide.
 */
export const SECRETS_PATH = process.env.VITEST
  ? resolve(tmpdir(), `rig-secrets-test-${process.pid}.json`)
  : resolve(PLUGIN_DATA_DIR, 'secrets.json');
export const SECRETS_VERSION = 1;

/** Every stored secret. Never throws — missing or corrupt is simply none. */
export function readSecrets({ path = SECRETS_PATH } = {}) {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed.secrets === 'object' && parsed.secrets ? parsed.secrets : {};
  } catch {
    return {};
  }
}

/** One secret's value, or null. */
export function readSecret(name, opts) {
  const value = readSecrets(opts)[name];
  return typeof value === 'string' && value ? value : null;
}

/** Which secrets are set, without revealing any of them. */
export function secretsSet(opts) {
  return Object.entries(readSecrets(opts))
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k]) => k);
}

/**
 * Set or clear one secret.
 *
 * `null` or an empty string removes it. Callers must decide *before* getting
 * here whether an empty field means "clear" or "leave alone" — for a masked
 * input that the page never receives a value for, it always means leave alone,
 * and passing the empty string through would clear a working key every time
 * someone saved an unrelated setting.
 */
export function writeSecret(name, value, { path = SECRETS_PATH } = {}) {
  const secrets = readSecrets({ path });
  if (value === null || value === undefined || value === '') delete secrets[name];
  else secrets[name] = String(value);

  const body = JSON.stringify(
    { version: SECRETS_VERSION, secrets, updated: new Date().toISOString() },
    null,
    2,
  );
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
  return secrets;
}

/** Drop every stored secret. Test-only; the redirected path makes it safe. */
export function _resetForTesting({ path = SECRETS_PATH } = {}) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best effort */
  }
}

/**
 * Overlay secrets onto a settings blob to make a provider context.
 *
 * Providers read `ctx.settings.goveeApiKey` and always have. Keeping that
 * contract means the secret store is invisible to them: the value arrives under
 * the name it always had, and no provider needs to know it now comes from
 * somewhere else. The overlaid object is ephemeral and is never stored.
 */
export function withSecrets(settings, opts) {
  return { ...(settings ?? {}), ...readSecrets(opts) };
}

/**
 * Move any declared secret out of a settings blob and into the store.
 *
 * Called on the way in to every global-settings write, which is what turns "we
 * do not put secrets in settings" from a convention into something the code
 * enforces. It also performs the one-time migration of the Govee key with no
 * separate migration step: the first write after this ships harvests it.
 *
 * @param {object} blob the settings object about to be stored
 * @param {string[]} keys secret field names, from the provider registry
 * @returns {{ blob: object, harvested: string[] }} blob with the secrets removed
 */
export function harvestSecrets(blob, keys, opts) {
  const inner = blob?.settings;
  if (!inner || !keys?.length) return { blob, harvested: [] };

  const harvested = [];
  const cleaned = { ...inner };
  for (const key of keys) {
    if (!(key in cleaned)) continue;
    const value = cleaned[key];
    delete cleaned[key];
    // An empty value is not a secret to keep, but it IS worth removing from the
    // blob so the key stops appearing in exports as an empty string.
    if (typeof value === 'string' && value) {
      writeSecret(key, value, opts);
      harvested.push(key);
    }
  }

  if (!harvested.length && Object.keys(cleaned).length === Object.keys(inner).length) {
    return { blob, harvested: [] };
  }
  return { blob: { ...blob, settings: cleaned }, harvested };
}
