// scripts/moza-scan.mjs — sweep the pedal's command space and record answers.
//
// Reads only. It exists to find which command a Pit House control writes to,
// without capturing serial traffic: snapshot, change one thing in Pit House,
// snapshot again, diff.
//
// Two details learned the hard way:
//
//   * Some commands are live sensor readings, not settings, and drift between
//     reads. 0x24 fooled a whole round of analysis by matching a preset field
//     to four decimals. Every sweep is therefore run twice and anything that
//     moved between passes is discarded.
//   * Some commands need a selector byte and answer a bare read with nothing
//     or zeros, so selectors are swept too.
//
// Pit House holds the port, and its X button only hides it to the tray — it has
// to be properly quit.
//
//   node scripts/moza-scan.mjs <label> [--device=mbooster|ab9|third]
//   node scripts/moza-scan.mjs --diff <a> <b>

import { SerialPort } from 'serialport';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFrame, keepAliveFrame, decodeAll, GROUP } from '../src/moza/frame.js';
import { DEVICES, deviceByKey } from '../src/moza/devices.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCANS = join(HERE, 'scans');
const BAUD = 115200;
const WIDTH = 4; // ask for four bytes; the reply reports its own length
const SETTLE_MS = 60;
const SELECTORS = [null, 0x00, 0x01]; // null = no selector byte

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const hexId = (key) => {
  const [id, sel] = String(key).split('.');
  const base = `0x${Number(id).toString(16).padStart(2, '0')}`;
  return sel === undefined ? base : `${base}[sel ${sel}]`;
};

// -------------------------------------------------------------------- diff
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

  const changed = [];
  for (const key of new Set([...Object.keys(before.values), ...Object.keys(after.values)])) {
    const x = before.values[key];
    const y = after.values[key];
    if (x !== y) changed.push({ key, from: x ?? '(absent)', to: y ?? '(absent)' });
  }

  console.log(`${a} -> ${b}\n`);
  if (!changed.length) {
    console.log('Nothing stable changed. Either the control is host-side only,');
    console.log('or its value sits behind a selector this sweep did not try.');
  } else {
    console.log(`${changed.length} changed:\n`);
    for (const c of changed) {
      const f = Buffer.from(String(c.to).padEnd(8, '0').slice(0, 8), 'hex');
      let hint = '';
      try {
        hint = `  float ${f.readFloatBE(0).toFixed(3)}  u32 ${f.readUInt32BE(0)}  hi16/65536 ${(f.readUInt16BE(0) / 65536).toFixed(4)}`;
      } catch {
        /* not four bytes */
      }
      console.log(`  ${hexId(c.key).padEnd(16)} ${String(c.from).padEnd(10)} -> ${String(c.to).padEnd(10)}${hint}`);
    }
  }
  const drifted = [...new Set([...(before.unstable ?? []), ...(after.unstable ?? [])])];
  if (drifted.length) console.log(`\nignored as live readings: ${drifted.map(hexId).join(' ')}`);
  process.exit(0);
}

// -------------------------------------------------------------------- scan
const label = args[0];

// Which MOZA device to sweep. The mBooster is the default because it is what
// this script was written for, but the AB9 speaks the same protocol and has no
// preset file to check answers against — so for it, a baseline sweep, one
// setting changed by hand, and a second sweep is the only way to attach meaning
// to a value.
const deviceArg = (args.find((a) => a.startsWith('--device=')) ?? '').split('=')[1] ?? 'mbooster';
const wanted = deviceByKey(deviceArg);
if (!wanted) {
  console.error(
    `Unknown --device "${deviceArg}". Known: ` +
      Object.values(DEVICES).map((d) => d.key).join(', '),
  );
  process.exit(1);
}
const wantPid = wanted.productId;
if (!label) {
  console.error('Usage: moza-scan.mjs <label>   |   moza-scan.mjs --diff <a> <b>');
  process.exit(1);
}

const ports = await SerialPort.list();
const hit = ports.find(
  (p) => (p.vendorId ?? '').toUpperCase() === '346E' && (p.productId ?? '').toUpperCase() === wantPid,
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
  console.error('Quit MOZA Pit House properly — its X button only hides it to the tray.');
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

async function sweep() {
  const out = {};
  for (const sel of SELECTORS) {
    for (let id = 0x00; id <= 0xff; id++) {
      const request = sel === null ? [id] : [id, sel];
      frames = [];
      port.write(readFrame(request, { width: WIDTH }));
      await sleep(SETTLE_MS);

      const reply = frames.find(
        (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === id,
      );
      if (!reply) continue;
      const value = reply.payload.subarray(sel === null ? 1 : 2);
      if (value.length) out[sel === null ? `${id}` : `${id}.${sel}`] = value.toString('hex');
      if (id % 64 === 63) process.stdout.write('.');
    }
  }
  return out;
}

process.stdout.write(`pass 1 on ${hit.path} `);
const passA = await sweep();
process.stdout.write('\npass 2 ');
const passB = await sweep();

// Only values that held still across both passes are settings; the rest are
// live readings and would otherwise show up as spurious changes.
const values = {};
const unstable = [];
for (const key of new Set([...Object.keys(passA), ...Object.keys(passB)])) {
  if (passA[key] === passB[key]) values[key] = passA[key];
  else unstable.push(key);
}

clearInterval(heartbeat);
await new Promise((res) => port.close(() => res()));

mkdirSync(SCANS, { recursive: true });
writeFileSync(
  join(SCANS, `${label}.json`),
  JSON.stringify({ label, when: new Date().toISOString(), values, unstable }, null, 1),
);

console.log(`\n\n${Object.keys(values).length} stable value(s).`);
console.log(`${unstable.length} drifted between passes and were dropped as live readings.`);
if (unstable.length) console.log(`  ${unstable.map(hexId).join(' ')}`);
console.log(`saved -> scripts/scans/${label}.json`);
process.exit(0);
