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
//   label       human name for the property inspector
//   verifiable  boolean — if false, the UI may NEVER show this as confirmed
//   options(ctx)         -> [{ value, label }]  live enumeration for PI dropdowns
//   apply(cfg, ctx)      -> void                perform the change
//   verify(cfg, ctx)     -> { status, detail }  read back from the hardware
//   describe(cfg)        -> string              for logs and the PI summary
//
// `verify` is not optional decoration. Publishing a command and having the
// hardware act on it are different events, and the gap between them is exactly
// the failure a kid must never hit: a green button over an un-dialled-down
// wheel. A provider that cannot read back its own state must declare
// verifiable:false so the UI can be honest about it.

import fanatecBase from './fanatecBase.js';
import govee from './govee.js';
import apps from './apps.js';
import moza from './moza.js';

export { STATUS, worstOf, isConfirmed } from './status.js';

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
