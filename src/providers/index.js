// providers/index.js — hardware provider registry.
//
// A provider owns one piece of rig hardware. Profiles carry a `providers` map
// keyed by provider id; each provider only ever sees its own slice of config.
// The core never parses provider-specific keys, so adding hardware later means
// adding a file here and nothing else.
//
// The contract
// ------------
//   id          string, stable, used as the config key
//   label       human name for the editor
//   verifiable  boolean — whether this provider checks its own work at all;
//               a hint for the editor, never a substitute for asking verify()
//   options(ctx)         -> [{ value, label }]  live enumeration for dropdowns
//   apply(cfg, ctx)      -> void                perform the change
//   verify(cfg, ctx)     -> { status, detail }  the provider's own verdict
//   describe(cfg)        -> string              for logs and the editor summary
//   isActive(cfg, ctx)   -> boolean             OPTIONAL: is this in effect now
//   unapply(cfg, ctx)    -> void                OPTIONAL: reverse apply()
//
// The last two are what make a Mode stateful, and they are deliberately
// independent of each other and of `contexts`:
//
//   * `contexts` including 'mode' says the provider may be USED in a Mode.
//   * `isActive` says it CONTRIBUTES to that Mode's on/off verdict. A Mode's
//     state is the aggregate of only the providers that answer — lighting and
//     scripts ride along without a vote, which is what lets one button set a
//     flag, change the lights and run a script while still reporting honestly.
//   * `unapply` says it can be REVERSED when the Mode is switched off. A
//     provider without it does nothing on deactivate, which is correct: turning
//     VR off should not re-run or undo a throwaway script.
//
// `isActive` is not `verify`. `verify` only means anything straight after an
// apply — it answers "did what I just did land?". `isActive` must answer cold,
// with no preceding apply, because a Mode key has to paint itself at startup
// and after a reboot.
//
// `verify` is not optional decoration. Publishing a command and having the
// hardware act on it are different events, and the gap between them is exactly
// the failure a kid must never hit: a green button over an un-dialled-down
// wheel.
//
// A provider owns its own verdict, including what success means for it. This
// registry used to stamp applied-unverified on anything declaring
// verifiable:false and never call verify() at all, which took the judgement
// away from the only code that had the information: Govee cannot read a lamp,
// but it does know whether the command reached the device, and delivery is a
// perfectly good bar for it to hold itself to. What the core still insists on
// is that the `detail` say what was actually confirmed, so a status is never
// read as more than it is.
//
// A provider with no verify() at all is reported applied-unverified, because
// there is nothing to ask.

import fanatecBase from './fanatecBase.js';
import govee from './govee.js';
import apps from './apps.js';
import moza from './moza.js';
import stateFlag from './stateFlag.js';

export { STATUS, worstOf, isConfirmed, isProblem } from './status.js';

const registry = new Map();

export function register(provider) {
  if (!provider?.id) throw new Error('provider must have an id');
  registry.set(provider.id, provider);
  return provider;
}

export function getProvider(id) {
  return registry.get(id) ?? null;
}

/**
 * Whether a provider is willing to be used in a given context.
 *
 * Declared by the provider, never inferred here. A wheelbase setup and a pedal
 * force curve are part of who is driving and are gated accordingly; lighting
 * and scripts are reasonable in either. The registry's job is to ask, not to
 * decide — the same principle that took outcome reporting out of runOne.
 *
 * Absent declaration means profile-only, because that is the safe default for
 * a provider written before contexts existed.
 */
export function supportsContext(id, context) {
  const provider = typeof id === 'string' ? getProvider(id) : id;
  if (!provider) return false;
  return (provider.contexts ?? ['profile']).includes(context);
}

/**
 * Does this provider contribute to a Mode's active/inactive verdict?
 *
 * Derived rather than declared, so a provider cannot claim to report state and
 * then not implement it. Govee is the instructive case: it may be used in a
 * Mode, but its API acknowledges a request rather than reading a lamp, so it
 * has no honest answer and does not implement isActive.
 */
export function reportsState(id) {
  const provider = typeof id === 'string' ? getProvider(id) : id;
  return typeof provider?.isActive === 'function';
}

/** Can this provider be reversed when a Mode is switched off? */
export function isReversible(id) {
  const provider = typeof id === 'string' ? getProvider(id) : id;
  return typeof provider?.unapply === 'function';
}

export function allProviders() {
  return [...registry.values()];
}

/** Reset to the built-in set. Tests register stubs on top of this. */
export function _resetForTesting() {
  registry.clear();
  registerBuiltins();
}

function registerBuiltins() {
  register(fanatecBase);
  register(govee);
  register(apps);
  register(moza);
  register(stateFlag);
}

registerBuiltins();
