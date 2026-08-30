// scripts/moza-find-arrays.mjs — find indexed (array) settings on the pedal.
//
// Read only. Writes nothing.
//
// The original command sweep missed the force curve entirely, because 0xAB is
// addressed by a 16-bit index and a bare read of it answers with zeros. Every
// setting still unmapped is also an array — brake_stroke_curve has six points,
// brake_nonlinear1..5 has five — so they are almost certainly indexed too, and
// invisible to the same sweep for the same reason.
//
// The preset file is the oracle. It says exactly what those arrays hold for the
// preset currently loaded, so instead of changing a setting in Pit House and
// diffing (which needs a human at the rig), we can search the command space for
// a command whose indexed reads match values we already know.
//
// Two phases, because 256 commands x 16 indices is too slow to be useful:
//
//   1. Read index 0 and index 1 of every command. An array answers differently
//      at the two; a scalar or an absent command does not.
//   2. Deep-probe only the survivors, and match them against the oracle.
//
//   node scripts/moza-find-arrays.mjs

import { SerialPort } from 'serialport';
import { readFrame, keepAliveFrame, decodeAll, GROUP } from '../src/moza/frame.js';
import { findPort } from '../src/moza/mbooster.js';
import { readSelection, readPreset } from '../src/moza/presetStore.js';

const SETTLE_MS = 60;
const DEEP_INDICES = 16;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The scalings the device is known to use, so a match can be reported in units.
const AS = {
  mm: (raw) => (raw * 53.5) / 65536,
  kg: (raw) => (raw * 200) / 65536,
  pct: (raw) => (raw * 100) / 65536,
};

const port = new SerialPort({ path: await findPort(), baudRate: 115200, autoOpen: false });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));

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

async function readAt(command, index, settle = SETTLE_MS) {
  frames = [];
  port.write(readFrame([command, 0x00, index], { width: 2 }));
  await sleep(settle);
  const reply = frames.find(
    (f) =>
      f.isResponse &&
      f.requestGroup === GROUP.READ &&
      f.payload[0] === command &&
      f.payload.length >= 5 &&
      f.payload[2] === index,
  );
  return reply ? reply.payload.readUInt16BE(3) : null;
}

// ---------------------------------------------------------------- phase one
process.stdout.write('phase 1 — probing every command at index 0 and 1 ');
const candidates = [];
for (let cmd = 0; cmd <= 0xff; cmd++) {
  const a = await readAt(cmd, 0);
  const b = await readAt(cmd, 1);
  // An array answers both and answers differently. A scalar repeats itself; an
  // absent command answers nothing.
  if (a !== null && b !== null && a !== b) candidates.push(cmd);
  if (cmd % 32 === 31) process.stdout.write('.');
}
console.log(`\n  ${candidates.length} look indexed: ${candidates.map((c) => '0x' + c.toString(16)).join(' ')}\n`);

// ---------------------------------------------------------------- phase two
const tables = new Map();
for (const cmd of candidates) {
  const values = [];
  for (let i = 0; i < DEEP_INDICES; i++) values.push(await readAt(cmd, i, 120));
  tables.set(cmd, values);
}

// ------------------------------------------------------------- the oracle
const selection = readSelection();
const preset = readPreset(Object.values(selection.lastUsed)[0]);
const params = preset?.deviceParams ?? {};
console.log(`oracle: "${preset?.name}"\n`);

const targets = [
  { key: 'brake_stroke_curve', want: params.brake_stroke_curve ?? [], unit: 'mm' },
  {
    key: 'brake_nonlinear1..5',
    want: [1, 2, 3, 4, 5].map((n) => params[`brake_nonlinear${n}`]).filter((v) => v !== undefined),
    unit: 'pct',
  },
  { key: 'brake_forces_curve', want: params.brake_forces_curve ?? [], unit: 'kg' },
];

/** Does this command's table contain the wanted run, at any offset? */
function findRun(values, want, unit, tolerance) {
  if (!want.length) return null;
  for (let start = 0; start + want.length <= values.length; start++) {
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      const raw = values[start + i];
      if (raw === null || Math.abs(AS[unit](raw) - want[i]) > tolerance) {
        ok = false;
        break;
      }
    }
    if (ok) return start;
  }
  return null;
}

for (const { key, want, unit } of targets) {
  if (!want.length) {
    console.log(`${key}: not in this preset, skipped`);
    continue;
  }
  const tol = unit === 'pct' ? 1.5 : unit === 'mm' ? 0.3 : 0.5;
  let found = false;
  for (const [cmd, values] of tables) {
    const at = findRun(values, want, unit, tol);
    if (at !== null) {
      console.log(`${key}  ->  command 0x${cmd.toString(16)}, indices ${at}..${at + want.length - 1}`);
      console.log(`   wanted ${want.map((v) => Number(v).toFixed(2)).join(', ')}`);
      console.log(
        `   read   ${values.slice(at, at + want.length).map((r) => AS[unit](r).toFixed(2)).join(', ')}`,
      );
      found = true;
    }
  }
  if (!found) console.log(`${key}: no command matched`);
  console.log('');
}

console.log('--- every indexed command found, for reference ---');
for (const [cmd, values] of tables) {
  const shown = values.map((v) => (v === null ? '--' : v)).join(' ');
  console.log(`0x${cmd.toString(16).padStart(2, '0')}  ${shown}`);
}

clearInterval(heartbeat);
await new Promise((res) => port.close(() => res()));
process.exit(0);
