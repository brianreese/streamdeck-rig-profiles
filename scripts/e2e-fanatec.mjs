// Manual integration check: drives the real wheelbase through the provider
// stack. Not part of `npm test` — it needs hardware.
//   node scripts/e2e-fanatec.mjs
import { applyProfile, summarise } from '../src/profileSwitch.js';
import { getBus } from '../src/mqtt/fanatecBus.js';
import { currentSlot } from '../src/providers/fanatecBase.js';

const bus = getBus({ log: () => {} });
const before = await bus.readState({ timeoutMs: 8000 });
const baseline = currentSlot(before);
console.log('baseline slot:', baseline ?? '(unreadable)');

for (const slot of [2, baseline ?? 1]) {
  const profile = { id: 'test', name: 'Test', providers: { 'fanatec-base': { setup: slot } } };
  const out = await applyProfile(profile, { bus });
  console.log(`-> S${slot}: ${out.status.padEnd(20)} | ${summarise(out)}`);
}
await bus.close();
process.exit(0);
