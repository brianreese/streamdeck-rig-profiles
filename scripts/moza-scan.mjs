// scripts/moza-scan.mjs — sweep every command id and record what the pedal says.
//
// Reads only. The point is to find out which command a Pit House control writes
// to, without capturing serial traffic: take a snapshot, change one thing in
// Pit House, take another, and diff them. Whatever moved is the command.
//
// Pit House holds the port, so the sequence is:
//
//   1. set the control in Pit House, close it
//   2. node scripts/moza-scan.mjs before
//   3. reopen Pit House, change the one control, close it
//   4. node scripts/moza-scan.mjs after
//   5. node scripts/moza-scan.mjs --diff before after
//
// Snapshots land in scripts/scans/<label>.json.

import { SerialPort } from 'serialport';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFrame, keepAliveFrame, decodeAll, GROUP } from '../src/moza/frame.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCANS = join(HERE, 'scans');
const BAUD = 115200;

// Ask for four bytes: the reply carries its own length, so this discovers the
// width rather than assuming it.
const WIDTH = 4;
const SETTLE_MS = 110;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);

// ------------------------------------------------------------------- diff
if (args[0] === '--diff') {
  const [, a, b] = args;
  const load = (name) => {
    const p = join(SCANS, `${name}.json`);
    if (!existsSync(p)) {
      console.error(`No scan called "${name}" (${p})`);
      process.exit(1);
    }
    return JSON.parse(readFileSync(p, 'utf8'));
  };
  const before = load(a);
  const after = load(b);

  const ids = new Set([...Object.keys(before.values), ...Object.keys(after.values)]);
  const changed = [];
  for (const id of ids) {
    const x = before.values[id];
    const y = after.values[id];
    if (x !== y) changed.push({ id, from: x ?? '(absent)', to: y ?? '(absent)' });
  }

  console.log(`${a} -> ${b}\n`);
  if (!changed.length) {
    console.log('Nothing changed. Either the control writes host-side only, or');
    console.log('the value lives behind a selector this sweep did not send.');
  } else {
    console.log(`${changed.length} command(s) changed:\n`);
    for (const c of changed.sort((m, n) => Number(m.id) - Number(n.id))) {
      const hex = `0x${Number(c.id).toString(16).padStart(2, '0')}`;
      console.log(`  ${hex}  ${String(c.from).padEnd(14)} ->  ${c.to}`);
    }
  }
  process.exit(0);
}

// ------------------------------------------------------------------- scan
const label = args[0];
if (!label) {
  console.error('Usage: moza-scan.mjs <label>   |   moza-scan.mjs --diff <a> <b>');
  process.exit(1);
}

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

const values = {};
process.stdout.write(`scanning 0x00-0xff on ${hit.path} `);

for (let id = 0x00; id <= 0xff; id++) {
  frames = [];
  port.write(readFrame(id, { width: WIDTH }));
  await sleep(SETTLE_MS);

  const reply = frames.find(
    (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === id,
  );
  if (reply) {
    const value = reply.payload.subarray(1);
    // Store hex: we do not know the encoding yet, and raw bytes diff cleanly.
    if (value.length) values[id] = value.toString('hex');
  }
  if (id % 32 === 31) process.stdout.write('.');
}

clearInterval(heartbeat);
await new Promise((res) => port.close(() => res()));

mkdirSync(SCANS, { recursive: true });
const out = { label, when: new Date().toISOString(), values };
writeFileSync(join(SCANS, `${label}.json`), JSON.stringify(out, null, 1));

console.log(`\n\n${Object.keys(values).length} commands answered with a value.`);
console.log(`saved -> scripts/scans/${label}.json`);
process.exit(0);
