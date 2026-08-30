// scripts/moza-find-device.mjs — which device id answers on a given port?
//
// Read only. Writes nothing.
//
// Every command in this codebase is addressed to device 0x12, the mBooster,
// because that is the only device whose protocol has been worked out. Sweeping
// the AB9's port with that id returned nothing at all — not because the AB9 is
// silent, but because a device ignores frames addressed to somebody else.
//
// So before any command can be found, the device id has to be. This sweeps ids
// against a few command ids and reports which combinations answer.
//
//   node scripts/moza-find-device.mjs COM12

import { SerialPort } from 'serialport';
import { encode, readFrame, keepAliveFrame, decodeAll, GROUP, swapNibbles } from '../src/moza/frame.js';

const path = process.argv[2];
if (!path) {
  console.error('Usage: moza-find-device.mjs <COM port>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));

let buffer = Buffer.alloc(0);
let frames = [];
port.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const { frames: got, rest } = decodeAll(buffer);
  buffer = rest;
  frames.push(...got);
});

const beat = setInterval(() => port.write(keepAliveFrame()), 500);
await sleep(400);

// Phase 1 — who acknowledges a keepalive at all.
console.log(`sweeping device ids on ${path}\n`);
const alive = [];
for (let dev = 0x00; dev <= 0x3f; dev++) {
  frames = [];
  port.write(encode({ group: GROUP.KEEPALIVE, device: dev, payload: [] }));
  await sleep(45);
  const want = swapNibbles(dev);
  if (frames.some((f) => f.isResponse && f.device === want)) alive.push(dev);
}
console.log(`answer a keepalive: ${alive.length ? alive.map((d) => '0x' + d.toString(16)).join(' ') : 'none'}`);

// Phase 2 — a keepalive echo proves very little; a read that returns data is
// what says the device has settings we can address.
console.log('\nprobing reads against every id (a few command ids each):\n');
const COMMANDS = [0x84, 0x85, 0xab, 0xb3, 0x01, 0x02, 0x10, 0x20, 0x30, 0x40];
const answered = new Map();

for (let dev = 0x00; dev <= 0x3f; dev++) {
  for (const cmd of COMMANDS) {
    frames = [];
    port.write(readFrame(cmd, { device: dev, width: 4 }));
    await sleep(45);
    const reply = frames.find(
      (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === cmd,
    );
    if (reply && reply.payload.length > 1) {
      if (!answered.has(dev)) answered.set(dev, []);
      answered.get(dev).push(`0x${cmd.toString(16)}=${reply.payload.subarray(1).toString('hex')}`);
    }
  }
  if (dev % 16 === 15) process.stdout.write('.');
}

console.log('\n');
if (!answered.size) {
  console.log('No device id returned data for any of those commands.');
  console.log('Either this device uses a different command space entirely, or it');
  console.log('answers only ids outside the range swept.');
} else {
  for (const [dev, hits] of answered) {
    console.log(`device 0x${dev.toString(16)}: ${hits.join('  ')}`);
  }
}

clearInterval(beat);
await new Promise((r) => port.close(() => r()));
process.exit(0);
