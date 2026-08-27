// scripts/moza-write-test.mjs — the first write to the mBooster.
//
// Deliberately small and reversible:
//
//   1. read max threshold (0xB3) and remember it
//   2. write a LOWER value — softer is the safe direction for a brake
//   3. read it back and check it took
//   4. restore the original and confirm the restore
//
// Only 0xB3 is touched. Max threshold is how much force the pedal demands, so
// lowering it makes the brake easier to press: if anything goes wrong the pedal
// ends up softer, never harder.
//
// Pit House must be closed — it holds COM6.
//
//   node scripts/moza-write-test.mjs [targetKg]

import { SerialPort } from 'serialport';
import {
  readFrame, writeFrame, keepAliveFrame, decodeAll, toBytes,
  force, GROUP, DEVICE,
} from '../src/moza/frame.js';

const BAUD = 115200;
const CMD_MAX_THRESHOLD = 0xb3;
const WIDTH = 4;
const targetKg = Number(process.argv[2] ?? 35);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ports = await SerialPort.list();
const hit = ports.find(
  (p) => (p.vendorId ?? '').toUpperCase() === '346E' && (p.productId ?? '').toUpperCase() === '0008',
);
if (!hit) {
  console.error('No mBooster found (VID 346E PID 0008).');
  process.exit(1);
}

let port;
try {
  port = new SerialPort({ path: hit.path, baudRate: BAUD, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
} catch (err) {
  console.error(`Could not open ${hit.path}: ${err.message}`);
  console.error('Close MOZA Pit House first — it holds the port.');
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

/** Read max threshold in kg, or null. */
async function readMaxThreshold() {
  frames = [];
  port.write(readFrame(CMD_MAX_THRESHOLD, { width: WIDTH }));
  await sleep(700);
  const reply = frames.find(
    (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === CMD_MAX_THRESHOLD,
  );
  const value = reply?.payload.subarray(1);
  if (!value || value.length < WIDTH) return null;
  return force.fromRaw(value.readUInt32BE(0));
}

async function writeMaxThreshold(kg) {
  frames = [];
  const raw = force.toRaw(kg);
  const frame = writeFrame(CMD_MAX_THRESHOLD, toBytes(raw, WIDTH));
  console.log(`    -> ${frame.toString('hex')}   (${kg}kg = raw 0x${raw.toString(16).padStart(8, '0')})`);
  port.write(frame);
  // Calibration writes are flash-backed and settle before flushing, so give it
  // room rather than reading straight back.
  await sleep(1200);
  const ack = frames.find((f) => f.isResponse && f.requestGroup === GROUP.WRITE);
  return ack ? ack.raw.toString('hex') : '(no write acknowledgement)';
}

const original = await readMaxThreshold();
console.log(`original max threshold : ${original === null ? 'unreadable' : original.toFixed(2) + ' kg'}`);
if (original === null) {
  console.error('Cannot read the value, so not writing anything.');
  clearInterval(heartbeat);
  port.close(() => process.exit(1));
}

if (targetKg >= original) {
  console.error(`\nRefusing: ${targetKg}kg is not lower than the current ${original.toFixed(2)}kg.`);
  console.error('This test only ever makes the brake softer.');
  clearInterval(heartbeat);
  port.close(() => process.exit(1));
}

console.log(`\nwriting ${targetKg} kg ...`);
console.log(`  ack: ${await writeMaxThreshold(targetKg)}`);
const afterWrite = await readMaxThreshold();
console.log(`  read back            : ${afterWrite === null ? 'unreadable' : afterWrite.toFixed(2) + ' kg'}`);
const wrote = afterWrite !== null && Math.abs(afterWrite - targetKg) < 0.5;
console.log(`  ${wrote ? 'WRITE CONFIRMED' : 'write did NOT take'}`);

console.log(`\nrestoring ${original.toFixed(2)} kg ...`);
console.log(`  ack: ${await writeMaxThreshold(original)}`);
const afterRestore = await readMaxThreshold();
console.log(`  read back            : ${afterRestore === null ? 'unreadable' : afterRestore.toFixed(2) + ' kg'}`);
const restored = afterRestore !== null && Math.abs(afterRestore - original) < 0.5;
console.log(`  ${restored ? 'RESTORED' : 'RESTORE FAILED — set it by hand in Pit House'}`);

clearInterval(heartbeat);
await new Promise((res) => port.close(() => res()));
process.exit(wrote && restored ? 0 : 1);
