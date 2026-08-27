// scripts/moza-feel-test.mjs — do the confirmed resistance parameters change
// how the pedal feels?
//
// forcelimit_max — the Pit House slider that obviously works — is not readable
// from the device and did not appear in a 458-value sweep including selectors.
// But three parameters that ARE confirmed all describe resistance:
//
//   0xAE natural friction
//   0xB2 end-stop stiffness
//   0xB7 segmented damping
//
// If softening them is enough for a child, the force limit stops being on the
// critical path. If nothing changes, they are not what they sound like.
//
// Applies and holds, so there is no countdown to sit through:
//
//   node scripts/moza-feel-test.mjs soft      make it as soft as it goes
//   node scripts/moza-feel-test.mjs hard      the other extreme, for contrast
//   node scripts/moza-feel-test.mjs restore   put back what was there
//   node scripts/moza-feel-test.mjs read      just report
//
// The original values are saved to scripts/scans/feel-original.json on the
// first change, so restore works even across runs.

import { SerialPort } from 'serialport';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFrame, writeFrame, keepAliveFrame, decodeAll, GROUP } from '../src/moza/frame.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = join(HERE, 'scans', 'feel-original.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Confirmed resistance parameters; values are a 16-bit fraction of 65536. */
const PARAMS = [
  { id: 0xae, name: 'natural friction', scale: 100, unit: '%', soft: 0, hard: 100 },
  { id: 0xb2, name: 'end-stop stiffness', scale: 10, unit: '/10', soft: 1, hard: 10 },
  { id: 0xb7, name: 'segmented damping', scale: 100, unit: '%', soft: 0, hard: 100 },
];

const mode = (process.argv[2] ?? 'read').toLowerCase();
if (!['soft', 'hard', 'restore', 'read'].includes(mode)) {
  console.error('Usage: moza-feel-test.mjs soft|hard|restore|read');
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

async function readValue(id) {
  frames = [];
  port.write(readFrame(id, { width: 4 }));
  await sleep(500);
  const reply = frames.find(
    (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === id,
  );
  const v = reply?.payload.subarray(1);
  return v && v.length >= 4 ? v.readUInt16BE(2) : null;
}

async function writeValue(id, raw16) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(0, 0);
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(raw16))), 2);
  frames = [];
  port.write(writeFrame(id, [...buf]));
  await sleep(900);
  return frames.some((f) => f.isResponse && f.requestGroup === GROUP.WRITE);
}

const show = async (label) => {
  console.log(label);
  for (const p of PARAMS) {
    const raw = await readValue(p.id);
    console.log(
      `  0x${p.id.toString(16)} ${p.name.padEnd(20)} ` +
        (raw === null ? 'unreadable' : `${((raw / 65536) * p.scale).toFixed(2)}${p.unit}`),
    );
  }
};

if (mode === 'read') {
  await show('current resistance settings:');
} else if (mode === 'restore') {
  if (!existsSync(SAVED)) {
    console.error('No saved originals — nothing to restore.');
  } else {
    const saved = JSON.parse(readFileSync(SAVED, 'utf8'));
    console.log('restoring the values saved before the first change ...');
    for (const p of PARAMS) {
      if (saved[p.id] === undefined) continue;
      await writeValue(p.id, saved[p.id]);
    }
    await show('\nnow:');
  }
} else {
  // Remember the originals once, so restore survives repeated soft/hard runs.
  if (!existsSync(SAVED)) {
    const originals = {};
    for (const p of PARAMS) originals[p.id] = await readValue(p.id);
    mkdirSync(dirname(SAVED), { recursive: true });
    writeFileSync(SAVED, JSON.stringify(originals, null, 1));
    console.log(`saved originals -> ${SAVED}\n`);
  }

  console.log(`setting all three to their ${mode}est ...`);
  for (const p of PARAMS) {
    const target = mode === 'soft' ? p.soft : p.hard;
    const ok = await writeValue(p.id, (target / p.scale) * 65536);
    const now = await readValue(p.id);
    console.log(
      `  0x${p.id.toString(16)} ${p.name.padEnd(20)} -> ` +
        `${now === null ? '?' : ((now / 65536) * p.scale).toFixed(2)}${p.unit}   ${ok ? 'acked' : 'NOT acked'}`,
    );
  }
  console.log('\nLeft in place — press the pedal whenever you are ready.');
  console.log('Compare with:  node scripts/moza-feel-test.mjs hard');
  console.log('Put back with: node scripts/moza-feel-test.mjs restore');
}

clearInterval(heartbeat);
await new Promise((res) => port.close(() => res()));
process.exit(0);
