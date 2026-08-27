// scripts/moza-feel-test.mjs — do the confirmed resistance parameters change
// how the pedal feels?
//
// forcelimit_max, the slider that obviously works in Pit House, is not readable
// from the device and did not appear in a 458-value sweep. But three parameters
// that ARE confirmed all describe resistance:
//
//   0xAE natural friction       15%
//   0xB2 end-stop stiffness     3 of 10
//   0xB7 segmented damping      25%
//
// If lowering them softens the pedal, they are usable controls for a child even
// without the force limit. If nothing changes, they are not what they sound
// like and the force curve really is the only lever.
//
// Lowers all three, holds for a feel test, then restores. Softer is the safe
// direction; nothing is raised.
//
//   node scripts/moza-feel-test.mjs

import { SerialPort } from 'serialport';
import { readFrame, writeFrame, keepAliveFrame, decodeAll, GROUP } from '../src/moza/frame.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Confirmed resistance parameters, read as a 16-bit fraction of 65536. */
const PARAMS = [
  { id: 0xae, name: 'natural friction', scale: 100, unit: '%', soft: 0 },
  { id: 0xb2, name: 'end-stop stiffness', scale: 10, unit: '/10', soft: 1 },
  { id: 0xb7, name: 'segmented damping', scale: 100, unit: '%', soft: 0 },
];

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
  console.error('Quit Pit House properly — the X button only hides it to the tray.');
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

async function readRaw(id) {
  frames = [];
  port.write(readFrame(id, { width: 4 }));
  await sleep(500);
  const reply = frames.find(
    (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === id,
  );
  const v = reply?.payload.subarray(1);
  return v && v.length >= 4 ? Buffer.from(v.subarray(0, 4)) : null;
}

/** Write back the same four bytes with only the 16-bit value changed. */
async function writeValue(id, fraction) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(0, 0);
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(fraction * 65536))), 2);
  frames = [];
  port.write(writeFrame(id, [...buf]));
  await sleep(900);
  return frames.some((f) => f.isResponse && f.requestGroup === GROUP.WRITE);
}

const originals = {};
console.log('current resistance settings:');
for (const p of PARAMS) {
  const raw = await readRaw(p.id);
  originals[p.id] = raw;
  const shown = raw ? (raw.readUInt16BE(2) / 65536) * p.scale : null;
  console.log(`  0x${p.id.toString(16)} ${p.name.padEnd(20)} ${shown === null ? 'unreadable' : shown.toFixed(2) + p.unit}`);
}

console.log('\nlowering all three to their softest ...');
for (const p of PARAMS) {
  if (!originals[p.id]) continue;
  const ok = await writeValue(p.id, p.soft / p.scale);
  const now = await readRaw(p.id);
  const shown = now ? (now.readUInt16BE(2) / 65536) * p.scale : null;
  console.log(`  0x${p.id.toString(16)} ${p.name.padEnd(20)} -> ${shown?.toFixed(2)}${p.unit}   ${ok ? 'acked' : 'NOT acked'}`);
}

console.log('\n>>> PRESS THE PEDAL NOW. Does it feel softer? <<<');
console.log('    restoring in 30 seconds');
await sleep(30000);

console.log('\nrestoring ...');
for (const p of PARAMS) {
  const raw = originals[p.id];
  if (!raw) continue;
  const ok = await writeValue(p.id, raw.readUInt16BE(2) / 65536);
  const now = await readRaw(p.id);
  const shown = now ? (now.readUInt16BE(2) / 65536) * p.scale : null;
  console.log(`  0x${p.id.toString(16)} ${p.name.padEnd(20)} -> ${shown?.toFixed(2)}${p.unit}   ${ok ? 'acked' : 'NOT acked'}`);
}

clearInterval(heartbeat);
await new Promise((res) => port.close(() => res()));
process.exit(0);
