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
}

registerBuiltins();
