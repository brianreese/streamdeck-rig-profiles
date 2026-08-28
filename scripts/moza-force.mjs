// scripts/moza-force.mjs — set the mBooster's brake force from the command line.
//
// This is Pit House's right-hand Pedal Feel slider, found by capturing what it
// writes: command 0xAB, addressed by a 16-bit point index, value in the same
// kg/200 scaling as 0xB3.
//
//   idx 0-6   travel axis, evenly spaced at 65536/7 — fixed, never written
//   idx 8-14  the seven force points, in kg; the last one IS forcelimit_max
//
// Moving the slider rewrites all seven points at once, keeping the curve's
// shape and scaling its height. That is what `set` does here, which is why the
// pedal gets genuinely lighter rather than just saturating earlier — the thing
// 0xB3 could never do.
//
//   node scripts/moza-force.mjs read
//   node scripts/moza-force.mjs set 12
//   node scripts/moza-force.mjs restore
//
// The curve found on the first run is saved to scripts/scans/force-curve.json,
// so restore works across runs and repeated `set`s scale from that baseline
// rather than compounding rounding errors.

import { SerialPort } from 'serialport';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFrame, writeFrame, keepAliveFrame, decodeAll, toBytes, GROUP } from '../src/moza/frame.js';
import { findPort, CURVE_AXIS } from '../src/moza/mbooster.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, 'scans', 'force-curve.json');
const POINTS = [8, 9, 10, 11, 12, 13, 14];
const MAX_KG = 200;

/**
 * The lowest peak the pedal can actually hold.
 *
 * Pit House's slider stops here and the firmware does not, so a lower value
 * writes and reads back happily while feeling stepped — the motor cannot hold a
 * force this small smoothly, and its cogging stops being a rounding error and
 * starts being detents you can feel through the pedal. 12kg was unmistakable.
 *
 * Only the peak is clamped. Points below it are meant to be smaller: MOZA's own
 * 24kg preset starts at 8.6kg.
 */
const MIN_KG = 24;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kg = (raw) => (raw * MAX_KG) / 65536;
const raw = (v) => Math.max(0, Math.min(65535, Math.round((v * 65536) / MAX_KG)));

const [mode = 'read', arg] = process.argv.slice(2);
if (!['read', 'set', 'restore', 'dump'].includes(mode)) {
  console.error('Usage: moza-force.mjs read | set <kg> | restore | dump <label>');
  process.exit(1);
}
if (mode === 'dump' && !arg) {
  console.error('dump needs a label, e.g. `dump pithouse-12kg`.');
  process.exit(1);
}
const target = mode === 'set' ? Number(arg) : null;
if (mode === 'set' && (!Number.isFinite(target) || target < MIN_KG || target > MAX_KG)) {
  console.error(`set needs a force in kg, ${MIN_KG}-${MAX_KG}.`);
  if (Number.isFinite(target) && target > 0 && target < MIN_KG) {
    console.error(
      `${target}kg is below what the pedal can hold smoothly. It will write and read\n` +
        'back correctly and feel stepped, because the motor cannot maintain a force\n' +
        `that low. Pit House will not go below ${MIN_KG}kg either.`,
    );
  }
  process.exit(1);
}

// findPort refuses to guess when two mBooster-class devices are attached, which
// matters here because this script writes.
let portPath;
try {
  portPath = await findPort();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (!portPath) {
  console.error('mBooster not found.');
  process.exit(1);
}

let port;
try {
  port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
} catch (err) {
  console.error(`Could not open ${portPath}: ${err.message}`);
  console.error('Quit Pit House properly — its X button only hides it to the tray.');
  process.exit(1);
}

let buffer = Buffer.alloc(0);
let frames = [];
port.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const { frames: got, rest } = decodeAll(buffer);
  buffer = rest;
  frames.push(...got);
});
const heartbeat = setInterval(() => port.write(keepAliveFrame()), 500);
port.write(keepAliveFrame());
await sleep(400);

/** Individual reads drop answers now and then, so each one gets a few goes. */
async function readPoint(idx) {
  for (let attempt = 0; attempt < 6; attempt++) {
    frames = [];
    port.write(readFrame([0xab, 0x00, idx], { width: 2 }));
    await sleep(220 + attempt * 180);
    const reply = frames.find(
      (f) =>
        f.isResponse &&
        f.requestGroup === GROUP.READ &&
        f.payload[0] === 0xab &&
        f.payload.length >= 5 &&
        f.payload[2] === idx,
    );
    if (reply) return reply.payload.readUInt16BE(3);
  }
  return null;
}

/**
 * Write one point and prove it landed by reading it back.
 *
 * A bare write with a fixed wait is not enough: some points quietly do not take,
 * which leaves a non-monotonic curve — a pedal that gets lighter partway down.
 * The value is allowed to come back one off, since kg -> raw -> kg rounds.
 */
async function writePoint(idx, value) {
  for (let attempt = 0; attempt < 4; attempt++) {
    frames = [];
    port.write(writeFrame([0xab, 0x00, idx], toBytes(value, 2)));
    await sleep(250);
    const got = await readPoint(idx);
    if (got !== null && Math.abs(got - value) <= 1) return true;
  }
  return false;
}

/**
 * Refuse to write until the device proves it is an mBooster.
 *
 * Vendor and product id only say what Windows thinks is plugged in. The curve's
 * travel axis is a fixed fingerprint the firmware holds at indices 0-6, so
 * reading it back confirms the table layout we are about to write into.
 */
async function assertIsMBooster() {
  for (const index of [1, 3, 6]) {
    const got = await readPoint(index);
    if (got === null || Math.abs(got - CURVE_AXIS[index]) > 32) {
      console.error(
        `${portPath} did not answer as an mBooster (axis point ${index} read ${got}, ` +
          `expected about ${CURVE_AXIS[index]}). Nothing was written.`,
      );
      clearInterval(heartbeat);
      await new Promise((res) => port.close(() => res()));
      process.exit(1);
    }
  }
}

async function readCurve() {
  const out = [];
  for (const idx of POINTS) out.push(await readPoint(idx));
  return out;
}

function show(label, curve) {
  console.log(label);
  const last = curve[curve.length - 1];
  for (let i = 0; i < POINTS.length; i++) {
    const v = curve[i];
    console.log(
      `  point ${i + 1}  idx ${String(POINTS[i]).padStart(2)}  ` +
        (v === null ? 'unreadable' : `${kg(v).toFixed(2).padStart(7)} kg   ${((v / last) * 100).toFixed(1).padStart(5)}% of peak`),
    );
  }
  if (last !== null) console.log(`  peak force: ${kg(last).toFixed(2)} kg`);
}

async function applyCurve(values) {
  let acked = 0;
  for (let i = 0; i < POINTS.length; i++) {
    const ok = await writePoint(POINTS[i], values[i]);
    if (ok) acked++;
    else console.log(`  point ${i + 1} (idx ${POINTS[i]}) would not take`);
  }
  return acked;
}

await assertIsMBooster();

const current = await readCurve();

// The baseline is the shape everything scales from, captured before the first
// change so `restore` always has somewhere honest to go back to.
if (!existsSync(BASELINE) && current.every((v) => v !== null)) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ when: new Date().toISOString(), points: POINTS, values: current }, null, 1));
  console.log(`saved the current curve as the baseline -> scripts/scans/force-curve.json\n`);
}

if (mode === 'dump') {
  // The whole neighbourhood, not just the seven force points. Writing the
  // curve ourselves produced a pedal that felt stepped, so the question is what
  // else Pit House touches that we do not — and that only shows up in a diff.
  const table = {};
  console.log(`dumping table 2 as "${arg}" ...`);
  for (let idx = 0; idx <= 23; idx++) {
    const v = await readPoint(idx);
    table[idx] = v;
    console.log(
      `  idx ${String(idx).padStart(2)}  ` +
        (v === null ? 'no reply' : `${String(v).padStart(6)}   ${kg(v).toFixed(3).padStart(8)} kg`),
    );
  }
  mkdirSync(dirname(BASELINE), { recursive: true });
  const out = join(dirname(BASELINE), `table-${arg}.json`);
  writeFileSync(out, JSON.stringify({ label: arg, when: new Date().toISOString(), table }, null, 1));
  console.log(`\nsaved -> ${out}`);
} else if (mode === 'read') {
  show('current brake force curve:', current);
} else if (mode === 'restore') {
  if (!existsSync(BASELINE)) {
    console.error('No baseline saved — nothing to restore.');
  } else {
    const saved = JSON.parse(readFileSync(BASELINE, 'utf8')).values;
    console.log('restoring the baseline curve ...');
    const acked = await applyCurve(saved);
    show(`\n${acked}/${POINTS.length} acknowledged. now reads:`, await readCurve());
  }
} else {
  if (!existsSync(BASELINE)) {
    console.error('Could not read the whole curve, so there is no baseline to scale. Aborting.');
  } else {
    const shape = JSON.parse(readFileSync(BASELINE, 'utf8')).values;
    const peak = shape[shape.length - 1];
    const wanted = shape.map((v) => raw((kg(v) / kg(peak)) * target));

    show('before:', current);
    console.log(`\nscaling the baseline shape to a ${target} kg peak ...`);
    const acked = await applyCurve(wanted);
    show(`\n${acked}/${POINTS.length} acknowledged. now reads:`, await readCurve());
    console.log('\nPress the pedal. Put it back with: node scripts/moza-force.mjs restore');
  }
}

clearInterval(heartbeat);
await new Promise((res) => port.close(() => res()));
process.exit(0);
