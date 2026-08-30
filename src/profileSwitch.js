// profileSwitch.js — applies a profile across every configured provider.
//
// Design rules, in priority order:
//
//   1. One provider failing never aborts the others. A dead Govee bridge must
//      not stop the wheelbase being dialled down.
//   2. The button renders from the AGGREGATE result, never from "we sent it".
//   3. The Stream Deck profile switch runs last — it changes which keys are
//      on screen, so it must not race the other providers' renders.

import { getProvider, supportsContext, reportsState, isReversible, providerIdOf } from './providers/index.js';
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

async function runOne(providerId, cfg, ctx, modeName = null) {
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

  // Naming the mode matters once the same provider can appear twice: two
  // "Apps & Scripts" lines with no way to tell which ran what is worse than one.
  const base = {
    providerId,
    label: modeName ? `${provider.label} (mode "${modeName}")` : provider.label,
    ...(modeName ? { scene: modeName } : {}),
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
 * A profile's own providers run first, then anything its referenced Modes
 * contribute. That ordering is the whole conflict rule: where both configure
 * the same provider, the Mode runs last and therefore wins, which is what you
 * want from lighting. Where they are additive — a profile's script preparing
 * SimHub and a Mode's script starting a playlist — both simply run.
 *
 * An earlier version deduplicated instead, dropping the Mode's entry to
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

  const fromModes = [];
  const byId = new Map((ctx.modes ?? ctx.scenes ?? []).map((sc) => [sc.id, sc]));
  for (const ref of profile?.modes ?? profile?.scenes ?? []) {
    const mode = byId.get(ref);
    if (!mode) {
      ctx.log?.(`[profileSwitch] profile "${profile?.id}" references missing mode "${ref}"`);
      continue;
    }
    for (const [id, cfg] of Object.entries(mode.providers ?? {})) {
      if (getProvider(id) && !supportsContext(id, 'mode')) {
        ctx.log?.(`[profileSwitch] mode "${ref}" configures ${id}, which is not available to a mode`);
        continue;
      }
      fromModes.push({ id, cfg, mode: mode.name ?? ref });
    }
  }
  return { own, fromModes };
}

/**
 * Apply every provider configured on `profile`.
 *
 * Also used for Modes, which are the same shape without the identity: a
 * record with a `providers` map is all this needs.
 *
 * @param {object} profile              profile record with a `providers` map
 * @param {object} [ctx]                passed through to providers
 * @param {object[]} [ctx.modes]        Mode records, for resolving references
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
  const { own, fromModes } = plan(profile, ctx);
  if (!own.length && !fromModes.length) {
    return { status: STATUS.SKIPPED, results: [] };
  }

  const report = (r) => {
    ctx.onResult?.(r);
    return r;
  };

  const results = [];
  // Two waves, so a Mode genuinely runs after the profile rather than racing it.
  for (const wave of [own, fromModes]) {
    if (!wave.length) continue;
    const concurrent = wave.filter((e) => !DEFERRED.has(providerIdOf(e.id)));
    const deferred = wave.filter((e) => DEFERRED.has(providerIdOf(e.id)));

    results.push(
      ...(await Promise.all(concurrent.map((e) => runOne(e.id, e.cfg, ctx, e.mode).then(report)))),
    );
    // Sequential, after everything else in this wave has settled.
    for (const e of deferred) {
      results.push(report(await runOne(e.id, e.cfg, ctx, e.mode)));
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

/**
 * Is this Mode currently on?
 *
 * The verdict comes only from providers that can answer. Lighting and
 * throwaway scripts sit in a Mode without a vote, which is what lets one button
 * set a flag, change the lights and run a script while still reporting
 * honestly — a provider that cannot know must not be counted as agreement.
 *
 *   every reporting provider says yes  -> true
 *   any says no                        -> false
 *   none can report                    -> null, and the key claims nothing
 *
 * A provider that throws counts as no. Unreadable state is not active state,
 * and pressing the key again re-applies and recovers.
 */
export async function readModeState(mode, ctx = {}) {
  const asked = [];
  for (const [id, cfg] of Object.entries(mode?.providers ?? {})) {
    const provider = getProvider(id);
    if (!reportsState(provider)) continue;
    asked.push(
      Promise.resolve()
        .then(() => provider.isActive(cfg, ctx))
        .then(Boolean)
        .catch((err) => {
          ctx.log?.(`[mode] ${id} could not report state: ${err.message}`);
          return false;
        }),
    );
  }
  if (!asked.length) return null;
  return (await Promise.all(asked)).every(Boolean);
}

/**
 * Switch a Mode off.
 *
 * Only providers that declared they can be reversed are touched. One that
 * cannot does nothing, which is the correct behaviour rather than a gap:
 * turning VR off should not re-run or attempt to undo a throwaway script.
 */
export async function unapplyMode(mode, ctx = {}) {
  ctx = { ...ctx, profileId: mode?.id, profile: mode, settings: ctx.settings ?? {} };
  const results = [];
  for (const [id, cfg] of Object.entries(mode?.providers ?? {})) {
    const provider = getProvider(id);
    if (!isReversible(provider)) continue;
    try {
      await provider.unapply(cfg, ctx);
      results.push({ providerId: id, label: provider.label, status: STATUS.VERIFIED, detail: 'switched off' });
    } catch (err) {
      results.push({ providerId: id, label: provider.label, status: STATUS.FAILED, detail: err.message });
    }
  }
  return { status: results.length ? worstOf(results) : STATUS.SKIPPED, results };
}
