// profileSwitch.js — applies a profile across every configured provider.
//
// Design rules, in priority order:
//
//   1. One provider failing never aborts the others. A dead Govee bridge must
//      not stop the wheelbase being dialled down.
//   2. The button renders from the AGGREGATE result, never from "we sent it".
//   3. The Stream Deck profile switch runs last — it changes which keys are
//      on screen, so it must not race the other providers' renders.

import { getProvider, supportsContext } from './providers/index.js';
import { worstOf, STATUS } from './providers/status.js';

/** Providers deferred to the end because they change what is on screen. */
const DEFERRED = new Set(['streamdeck']);

/**
 * @typedef {object} ProviderResult
 * @property {string} providerId
 * @property {string} label
 * @property {string} status
 * @property {string} detail
 */

async function runOne(providerId, cfg, ctx, sceneName = null) {
  const provider = getProvider(providerId);

  // Unknown ids warn but never throw: config outlives code, and a profile
  // naming hardware this build does not know about must still switch the rest.
  if (!provider) {
    ctx.log?.(`[profileSwitch] unknown provider "${providerId}" — skipping`);
    return {
      providerId,
      label: providerId,
      status: STATUS.SKIPPED,
      detail: 'no such provider in this build',
    };
  }

  // Naming the scene matters once the same provider can appear twice: two
  // "Apps & Scripts" lines with no way to tell which ran what is worse than one.
  const base = {
    providerId,
    label: sceneName ? `${provider.label} (scene "${sceneName}")` : provider.label,
    ...(sceneName ? { scene: sceneName } : {}),
  };

  try {
    await provider.apply(cfg, ctx);
  } catch (err) {
    return { ...base, status: STATUS.FAILED, detail: err.message };
  }

  // The provider owns its own verdict. This used to short-circuit on a
  // `verifiable: false` flag and stamp applied-unverified without asking,
  // which meant a provider could not define what success meant for it: Govee
  // has no way to read a lamp, but it does know whether the command reached
  // the device, and that is its bar. Deciding that here put the judgement in
  // the one place with the least information.
  if (typeof provider.verify !== 'function') {
    return {
      ...base,
      status: STATUS.APPLIED_UNVERIFIED,
      detail: 'applied; this provider does not report an outcome',
    };
  }

  try {
    const { status, detail } = await provider.verify(cfg, ctx);
    return { ...base, status, detail };
  } catch (err) {
    return { ...base, status: STATUS.UNREACHABLE, detail: err.message };
  }
}

/**
 * Work out what runs, and in what order.
 *
 * A profile's own providers run first, then anything its referenced scenes
 * contribute. That ordering is the whole conflict rule: where both configure
 * the same provider, the scene runs last and therefore wins, which is what you
 * want from lighting. Where they are additive — a profile's script preparing
 * SimHub and a scene's script starting a playlist — both simply run.
 *
 * An earlier version deduplicated instead, dropping the scene's entry to
 * protect the profile's. That was wrong: it silently discarded half of a
 * perfectly reasonable pair of scripts.
 *
 * Providers that do not declare the context are dropped rather than trusted.
 */
function plan(profile, ctx) {
  const context = ctx.context ?? 'profile';
  const own = [];
  for (const [id, cfg] of Object.entries(profile?.providers ?? {})) {
    // An unknown id passes through so runOne can report it as skipped; only a
    // provider that exists and declines this context is dropped here.
    if (getProvider(id) && !supportsContext(id, context)) {
      ctx.log?.(`[profileSwitch] ${id} is not available to a ${context} — skipping`);
      continue;
    }
    own.push({ id, cfg });
  }

  const fromScenes = [];
  const byId = new Map((ctx.scenes ?? []).map((sc) => [sc.id, sc]));
  for (const ref of profile?.scenes ?? []) {
    const scene = byId.get(ref);
    if (!scene) {
      ctx.log?.(`[profileSwitch] profile "${profile?.id}" references missing scene "${ref}"`);
      continue;
    }
    for (const [id, cfg] of Object.entries(scene.providers ?? {})) {
      if (getProvider(id) && !supportsContext(id, 'scene')) {
        ctx.log?.(`[profileSwitch] scene "${ref}" configures ${id}, which is not available to a scene`);
        continue;
      }
      fromScenes.push({ id, cfg, scene: scene.name ?? ref });
    }
  }
  return { own, fromScenes };
}

/**
 * Apply every provider configured on `profile`.
 *
 * Also used for scenes, which are the same shape without the identity: a
 * record with a `providers` map is all this needs.
 *
 * @param {object} profile              profile record with a `providers` map
 * @param {object} [ctx]                passed through to providers
 * @param {object[]} [ctx.scenes]       scene records, for resolving references
 * @param {(r: ProviderResult) => void} [ctx.onResult] progress callback
 * @returns {Promise<{ status: string, results: ProviderResult[] }>}
 */
export async function applyProfile(profile, ctx = {}) {
  // Providers receive the profile id (so per-profile state can be keyed) and
  // the global settings blob (API keys and the like) alongside their own slice.
  //
  // The settings half was documented here but never actually passed, so any
  // provider needing a credential failed with "no API key set" however the key
  // was configured. Callers hand it in as ctx.settings.
  ctx = { ...ctx, profileId: profile?.id, profile, settings: ctx.settings ?? {} };
  const { own, fromScenes } = plan(profile, ctx);
  if (!own.length && !fromScenes.length) {
    return { status: STATUS.SKIPPED, results: [] };
  }

  const report = (r) => {
    ctx.onResult?.(r);
    return r;
  };

  const results = [];
  // Two waves, so a scene genuinely runs after the profile rather than racing it.
  for (const wave of [own, fromScenes]) {
    if (!wave.length) continue;
    const concurrent = wave.filter((e) => !DEFERRED.has(e.id));
    const deferred = wave.filter((e) => DEFERRED.has(e.id));

    results.push(
      ...(await Promise.all(concurrent.map((e) => runOne(e.id, e.cfg, ctx, e.scene).then(report)))),
    );
    // Sequential, after everything else in this wave has settled.
    for (const e of deferred) {
      results.push(report(await runOne(e.id, e.cfg, ctx, e.scene)));
    }
  }

  return { status: worstOf(results), results };
}

/** One-line summary naming the worst offender, for the button and logs. */
export function summarise({ status, results }) {
  if (status === STATUS.VERIFIED) return 'all hardware confirmed';
  const culprit = results.find((r) => r.status === status);
  return culprit ? `${culprit.label}: ${culprit.detail}` : status;
}
