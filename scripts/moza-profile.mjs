// scripts/moza-profile.mjs — exercise the MOZA provider the way a profile does.
//
// This is the end-to-end check for preset-backed profiles: it runs the real
// provider's apply() and verify(), so what it proves is what a Stream Deck key
// will do, not an approximation of it.
//
//   node scripts/moza-profile.mjs list
//   node scripts/moza-profile.mjs plan  "Brian Brake Hybrid" 24
//   node scripts/moza-profile.mjs apply "Brian Brake Hybrid" 24
//
// `plan` touches no hardware. It prints the curve that would be written, which
// is the honest way to review a change before it reaches a pedal a child is
// about to use.
//
// Verification reads back from the pedal rather than from Pit House. Preset
// files are not live state — "Test Preset Unlinked" reads forcelimit_max 79
// while the pedal sits at 50 — and Pit House re-applies a preset when it
// starts, so opening it to check would overwrite the thing being checked.

import moza from '../src/providers/moza.js';
import { listPresets, findPreset } from '../src/moza/presetStore.js';
import { scaleCurve } from '../src/moza/mbooster.js';

const [mode = 'list', name, peakArg] = process.argv.slice(2);
if (!['list', 'plan', 'apply'].includes(mode)) {
  console.error('Usage: moza-profile.mjs list | plan <preset> [peakKg] | apply <preset> [peakKg]');
  process.exit(1);
}

const presets = listPresets({ deviceType: 'Pedals', device: 'mBooster' });

if (mode === 'list') {
  console.log(`${presets.length} mBooster preset(s):\n`);
  for (const p of presets) {
    const curve = findPreset(p.id)?.deviceParams?.brake_forces_curve;
    const peak = Array.isArray(curve) ? `${curve[curve.length - 1].toFixed(1)}kg peak` : 'no curve';
    console.log(`  ${p.name.padEnd(38).slice(0, 38)}  ${peak}`);
  }
  process.exit(0);
}

if (!name) {
  console.error(`${mode} needs a preset name — run "list" to see them.`);
  process.exit(1);
}

// Names are friendlier than uuids on a command line, but the provider keys on
// the id, which is what the profile stores.
const match = presets.find((p) => p.name.toLowerCase() === name.toLowerCase())
  ?? presets.find((p) => p.name.toLowerCase().includes(name.toLowerCase()));
if (!match) {
  console.error(`No preset matching "${name}". Run "list" to see them.`);
  process.exit(1);
}

const cfg = { preset: match.id };
if (peakArg !== undefined) cfg.peakForceKg = Number(peakArg);

const problems = moza.validate(cfg);
if (problems.length) {
  console.error(`Rejected: ${problems.join('; ')}`);
  process.exit(1);
}

const source = findPreset(match.id).deviceParams;
const curve = peakArg === undefined
  ? source.brake_forces_curve
  : scaleCurve(source.brake_forces_curve, Number(peakArg));

console.log(`${match.name}${peakArg === undefined ? '' : ` scaled to ${peakArg}kg`}\n`);
console.log(`  ${moza.describe(cfg)}\n`);
console.log('  point       force   % of peak');
curve.forEach((kg, i) => {
  const pct = ((kg / curve[curve.length - 1]) * 100).toFixed(1);
  console.log(`    ${i + 1}      ${kg.toFixed(2).padStart(7)} kg   ${pct.padStart(5)}%`);
});
const mm = (v) => Number(v).toFixed(1);
console.log(
  `\n  travel ${mm(source.brake_machinelimit_min)}-${mm(source.brake_machinelimit_max)}mm` +
    `, load cell threshold ${source.force_max_coef}kg`,
);

if (mode === 'plan') {
  console.log('\nNothing was written. Use "apply" to send it to the pedal.');
  process.exit(0);
}

console.log('\napplying ...');
try {
  await moza.apply(cfg, {});
} catch (err) {
  console.error(`apply failed: ${err.message}`);
  process.exit(1);
}

const result = await moza.verify(cfg, {});
console.log(`\n${result.status}: ${result.detail}`);
process.exit(result.status === 'verified' ? 0 : 1);
