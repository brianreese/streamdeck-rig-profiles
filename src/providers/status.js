// providers/status.js — the outcome vocabulary shared by providers and the
// orchestrator.
//
// Lives apart from the registry so providers can import it without creating a
// cycle (registry imports providers; providers import status).

/** Outcome of applying one provider. */
export const STATUS = {
  UNREACHABLE: 'unreachable', // hardware or service not responding
  MISMATCH: 'mismatch', // responded, but not with what we asked for
  FAILED: 'failed', // apply() threw
  APPLIED_UNVERIFIED: 'applied-unverified', // sent, cannot confirm
  VERIFIED: 'verified', // confirmed by the hardware
  SKIPPED: 'skipped', // profile does not configure this provider
};

/** Severity ranking, worst first. `skipped` is neutral and ranks last. */
const SEVERITY = [
  STATUS.UNREACHABLE,
  STATUS.FAILED,
  STATUS.MISMATCH,
  STATUS.APPLIED_UNVERIFIED,
  STATUS.VERIFIED,
  STATUS.SKIPPED,
];

/**
 * Aggregate provider results into the single status the button renders from.
 * Worst wins. An all-skipped profile stays `skipped` rather than becoming
 * `verified` — it did nothing, and claiming success for doing nothing is the
 * exact lie this whole design exists to prevent.
 */
export function worstOf(results) {
  if (!results.length) return STATUS.SKIPPED;
  let worst = STATUS.SKIPPED;
  for (const r of results) {
    if (SEVERITY.indexOf(r.status) < SEVERITY.indexOf(worst)) worst = r.status;
  }
  return worst;
}

/** True only when a status is safe to present as "this profile is on". */
export function isConfirmed(status) {
  return status === STATUS.VERIFIED;
}

/**
 * True when the switch actually went wrong, as opposed to merely unconfirmable.
 *
 * Not the same question as `isConfirmed`. Govee can never be verified — its API
 * acknowledges the call, not the lamps — so treating anything short of verified
 * as a failure made the alert triangle fire on every single switch that touched
 * the lights. An alarm that always sounds is not an alarm.
 */
export function isProblem(status) {
  return status === STATUS.UNREACHABLE || status === STATUS.FAILED || status === STATUS.MISMATCH;
}
