// scripts/moza-pressure-test.mjs — verify that 0x24 (pressure_weight) is the
// control that actually changes how hard the pedal is to press.
//
// Identified by diffing a device scan either side of moving Pit House's
// right-hand "Pedal Feel" slider: 0x24 was the only command that changed, and
// its value matches `pressure_weight` in the saved preset to four decimals.
// The force curve rescaled in the preset file without any curve command
// changing on the device, so the pedal derives the curve from this scalar.
//
// Writes a LOWER value than current — softer is the safe direction for a brake
// — then restores. Nothing else is touched.
//
//   node scripts/moza-pressure-test.mjs [value]

import { SerialPort } from 'serialport';
import { readFrame, writeFrame, keepAliveFrame, decodeAll, GROUP } from '../src/moza/frame.js';

const CMD = 0x24;
const WIDTH = 4;
const target = Number(process.argv[2] ?? 1.0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const floatBytes = (v) => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v);
  return [...b];
};

const ports = await SerialPort.list();
const hit = ports.find(
  (p) => (p.vendorId ?? '').toUpperCase() === '346E' && (p.productId ?? '').toUpperCase() === '0008',
);
if (!hit) {
  console.error('mBooster not found.');
  process.exit(1);
}

let port;
try {
  port = new SerialPort({ path: hit.path, baudRate: 115200, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
} catch (err) {
  console.error(`Could not open ${hit.path}: ${err.message}`);
  console.error('Close MOZA Pit House — it holds the port, and its X button only hides it.');
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

async function read() {
  frames = [];
  port.write(readFrame(CMD, { width: WIDTH }));
  await sleep(700);
  const reply = frames.find(
    (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === CMD,
  );
  const v = reply?.payload.subarray(1);
  return v && v.length >= 4 ? v.readFloatBE(0) : null;
}

async function write(value) {
  frames = [];
  const frame = writeFrame(CMD, floatBytes(value));
  console.log(`    -> ${frame.toString('hex')}`);
  port.write(frame);
  await sleep(1200);
  return frames.some((f) => f.isResponse && f.requestGroup === GROUP.WRITE);
}

const original = await read();
console.log(`pressure_weight now : ${original === null ? 'unreadable' : original.toFixed(4)}`);
if (original === null) {
  clearInterval(heartbeat);
  port.close(() => process.exit(1));
}
if (target >= original) {
  console.error(`\nRefusing: ${target} is not lower than ${original.toFixed(4)}.`);
  console.error('This test only ever makes the pedal softer.');
  clearInterval(heartbeat);
  port.close(() => process.exit(1));
}

console.log(`\nwriting ${target} ...`);
console.log(`  acknowledged: ${await write(target)}`);
const after = await read();
console.log(`  read back    : ${after === null ? 'unreadable' : after.toFixed(4)}`);
console.log(`  ${after !== null && Math.abs(after - target) < 0.01 ? 'WRITE CONFIRMED' : 'write did not take'}`);

console.log('\n>>> PRESS THE PEDAL NOW — it should feel noticeably softer. <<<');
console.log('    (restoring in 25 seconds)');
await sleep(25000);

console.log(`\nrestoring ${original.toFixed(4)} ...`);
console.log(`  acknowledged: ${await write(original)}`);
const restored = await read();
console.log(`  read back    : ${restored === null ? 'unreadable' : restored.toFixed(4)}`);

clearInterval(heartbeat);
await new Promise((res) => port.close(() => res()));
process.exit(0);
