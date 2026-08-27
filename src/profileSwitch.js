// profileSwitch.js — applies a profile across every configured provider.
//
// Design rules, in priority order:
//
//   1. One provider failing never aborts the others. A dead Govee bridge must
//      not stop the wheelbase being dialled down.
//   2. The button renders from the AGGREGATE result, never from "we sent it".
//   3. The Stream Deck profile switch runs last — it changes which keys are
//      on screen, so it must not race the other providers' renders.

import { getProvider } from './providers/index.js';
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

async function runOne(providerId, cfg, ctx) {
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

  const base = { providerId, label: provider.label };

  try {
    await provider.apply(cfg, ctx);
  } catch (err) {
    return { ...base, status: STATUS.FAILED, detail: err.message };
  }

  if (!provider.verifiable) {
    return {
      ...base,
      status: STATUS.APPLIED_UNVERIFIED,
      detail: 'sent; this provider cannot read back',
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
 * Apply every provider configured on `profile`.
 *
 * @param {object} profile              profile record with a `providers` map
 * @param {object} [ctx]                passed through to providers
 * @param {(r: ProviderResult) => void} [ctx.onResult] progress callback
 * @returns {Promise<{ status: string, results: ProviderResult[] }>}
 */
export async function applyProfile(profile, ctx = {}) {
  const entries = Object.entries(profile?.providers ?? {});
  if (!entries.length) {
    return { status: STATUS.SKIPPED, results: [] };
  }

  const concurrent = entries.filter(([id]) => !DEFERRED.has(id));
  const deferred = entries.filter(([id]) => DEFERRED.has(id));

  const report = (r) => {
    ctx.onResult?.(r);
    return r;
  };

  const results = await Promise.all(
    concurrent.map(([id, cfg]) => runOne(id, cfg, ctx).then(report)),
  );

  // Sequential, after everything else has settled.
  for (const [id, cfg] of deferred) {
    results.push(report(await runOne(id, cfg, ctx)));
  }

  return { status: worstOf(results), results };
}

/** One-line summary naming the worst offender, for the button and logs. */
export function summarise({ status, results }) {
  if (status === STATUS.VERIFIED) return 'all hardware confirmed';
  const culprit = results.find((r) => r.status === status);
  return culprit ? `${culprit.label}: ${culprit.detail}` : status;
}
