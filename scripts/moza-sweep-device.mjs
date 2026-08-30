// scripts/moza-sweep-device.mjs — read every command from a given device id.
//
// Read only. Writes nothing.
//
// `moza-scan.mjs` sweeps commands but always addresses device 0x12, the
// mBooster. That is fine for the pedal and useless for anything else: a device
// ignores frames addressed to somebody else, so sweeping the AB9 that way
// returns a flat nothing and looks like a dead device.
//
// Use `moza-find-device.mjs` first to learn which ids answer on a port, then
// this to see what they will tell you.
//
//   node scripts/moza-sweep-device.mjs COM12 0x10 before.json
//
// With no preset file to check answers against — the AB9 has none — a single
// sweep cannot say what any value means. Take one before a setting is changed
// in Pit House and one after, then diff. That needs a person for the length of
// one toggle, rather than a packet capture.

import { SerialPort } from 'serialport';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { readFrame, keepAliveFrame, decodeAll, GROUP } from '../src/moza/frame.js';

const [path, deviceArg, out] = process.argv.slice(2);
if (!path || !deviceArg) {
  console.error('Usage: moza-sweep-device.mjs <COM port> <device id> [out.json]');
  console.error('       moza-sweep-device.mjs --diff <a.json> <b.json>');
  process.exit(1);
}

if (path === '--diff') {
  const [a, b] = [deviceArg, out];
  if (!existsSync(a) || !existsSync(b)) {
    console.error('Both files must exist.');
    process.exit(1);
  }
  const before = JSON.parse(readFileSync(a, 'utf8'));
  const after = JSON.parse(readFileSync(b, 'utf8'));
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = keys.filter((k) => before[k] !== after[k]);

  console.log(`${a} -> ${b}\n`);
  if (!changed.length) {
    console.log('Nothing changed. Either the setting is not stored on this device,');
    console.log('or it is behind an index this sweep does not reach.');
  } else {
    for (const k of changed) {
      console.log(`  ${k.padEnd(10)} ${String(before[k] ?? '(absent)').padEnd(12)} -> ${after[k] ?? '(absent)'}`);
    }
  }
  process.exit(0);
}

const device = Number(deviceArg);
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

process.stdout.write(`sweeping ${path} device 0x${device.toString(16)} `);
const found = {};
for (let cmd = 0x00; cmd <= 0xff; cmd++) {
  frames = [];
  port.write(readFrame(cmd, { device, width: 4 }));
  await sleep(45);
  const reply = frames.find(
    (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === cmd,
  );
  const value = reply?.payload.subarray(1);
  if (value?.length) found[`0x${cmd.toString(16).padStart(2, '0')}`] = value.toString('hex');
  if (cmd % 64 === 63) process.stdout.write('.');
}

const keys = Object.keys(found);
console.log(`\n\n${keys.length} command(s) answered with data\n`);
for (const k of keys) console.log('  ' + k + '  ' + found[k]);
if (out) {
  writeFileSync(out, JSON.stringify(found, null, 1));
  console.log(`\nsaved -> ${out}`);
}

clearInterval(beat);
await new Promise((r) => port.close(() => r()));
process.exit(0);
