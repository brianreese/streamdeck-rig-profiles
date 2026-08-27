// scripts/moza-probe.mjs — read-only validation of the MOZA frame codec
// against the real mBooster.
//
// Sends READ requests only (group 0x23). Nothing is written, so no setting can
// be changed by running this. The point is to prove three things before any
// write is attempted:
//
//   1. The port opens and the device answers at all.
//   2. Our checksum and framing are right — a reply parses as a valid frame.
//   3. The values coming back match what Pit House believes, which is how we
//      confirm a command id really is the parameter we think it is.
//
// Pit House holds COM6 open, so it must be closed first.
//
//   node scripts/moza-probe.mjs

import { SerialPort } from 'serialport';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  readFrame, keepAliveFrame, decodeAll, swapNibbles,
  travel, force, DEVICE, GROUP,
} from '../src/moza/frame.js';

const BAUD = 115200;
const MBOOSTER = { vendorId: '346E', productId: '0008' };

/** Command ids from AZOM's mBooster protocol documentation. */
const COMMANDS = [
  { id: 0x84, name: 'travel start', bytes: 2, decode: (b) => `${travel.fromRaw(b.readUInt16BE(0)).toFixed(2)} mm` },
  { id: 0x85, name: 'travel end', bytes: 2, decode: (b) => `${travel.fromRaw(b.readUInt16BE(0)).toFixed(2)} mm` },
  { id: 0xb3, name: 'max threshold', bytes: 4, decode: (b) => `${force.fromRaw(b.readUInt32BE(0)).toFixed(2)} kg` },
  { id: 0xae, name: 'friction [sel 0]', bytes: 2, sel: 0x00, decode: (b) => `${b.readUInt16BE(0)}` },
  { id: 0xae, name: 'friction [sel 1]', bytes: 2, sel: 0x01, decode: (b) => `${b.readUInt16BE(0)}` },
  { id: 0xb2, name: 'stiffness [sel 0]', bytes: 2, sel: 0x00, decode: (b) => `${b.readUInt16BE(0)}` },
  { id: 0xb2, name: 'stiffness [sel 1]', bytes: 2, sel: 0x01, decode: (b) => `${b.readUInt16BE(0)}` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What Pit House currently believes, for comparison. */
function pitHouseValues() {
  const dir = join(homedir(), 'Documents', 'MOZA Pit House', 'LocalParameters', 'MBoost');
  if (!existsSync(dir)) return {};
  const file = readdirSync(dir).find((f) => f.endsWith('.json'));
  if (!file) return {};
  try {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v?.value]));
  } catch {
    return {};
  }
}

async function findPort() {
  const ports = await SerialPort.list();
  const hit = ports.find(
    (p) =>
      (p.vendorId ?? '').toUpperCase() === MBOOSTER.vendorId &&
      (p.productId ?? '').toUpperCase() === MBOOSTER.productId,
  );
  return hit?.path ?? null;
}

const known = pitHouseValues();
console.log('Pit House currently reports:');
for (const k of ['brake_machinelimit_min', 'brake_machinelimit_max', 'brake_forcelimit_max',
  'brake_friction_press', 'brake_softlimit_hardness_press']) {
  if (known[k] !== undefined) console.log(`  ${k.padEnd(32)} ${known[k]}`);
}

const path = await findPort();
if (!path) {
  console.error('\nNo mBooster serial port found (VID 346E PID 0008). Is it connected?');
  process.exit(1);
}
console.log(`\nmBooster on ${path}\n`);

let port;
try {
  port = new SerialPort({ path, baudRate: BAUD, autoOpen: false });
  await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));
} catch (err) {
  console.error(`Could not open ${path}: ${err.message}`);
  console.error('\nMOZA Pit House holds this port open — close it and try again.');
  process.exit(1);
}

let buffer = Buffer.alloc(0);
const frames = [];
let rawSeen = Buffer.alloc(0);
port.on('data', (chunk) => {
  rawSeen = Buffer.concat([rawSeen, chunk]);
  buffer = Buffer.concat([buffer, chunk]);
  const { frames: got, rest } = decodeAll(buffer);
  buffer = rest;
  frames.push(...got);
});

// The device expects a heartbeat; without it, it may stop answering.
const heartbeat = setInterval(() => port.write(keepAliveFrame()), 500);
port.write(keepAliveFrame());
await sleep(500);

const expectedDevice = swapNibbles(DEVICE.MBOOSTER);
console.log(`asking for ${COMMANDS.length} parameters (reads only)\n`);

for (const cmd of COMMANDS) {
  frames.length = 0;
  rawSeen = Buffer.alloc(0);
  const req = cmd.sel === undefined ? [cmd.id] : [cmd.id, cmd.sel];
  port.write(readFrame([...req, ...new Array(cmd.bytes).fill(0)]));
  await sleep(700);

  const reply = frames.find(
    (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === cmd.id,
  );
  const anyResponse = frames.find((f) => f.isResponse);

  if (reply) {
    const value = reply.payload.subarray(cmd.sel === undefined ? 1 : 2);
    let shown = value.length ? value.toString('hex') : '(no value bytes)';
    try {
      if (value.length >= cmd.bytes) shown = `${cmd.decode(value)}   raw=${value.subarray(0, cmd.bytes).toString('hex')}`;
    } catch {
      /* fall back to hex */
    }
    // Always show the whole frame: a short or empty value is itself a finding,
    // and the raw bytes are the only way to tell why.
    console.log(
      `  0x${cmd.id.toString(16)} ${cmd.name.padEnd(20)} ${shown.padEnd(30)} frame=${reply.raw.toString('hex')}`,
    );
  } else if (anyResponse) {
    console.log(
      `  0x${cmd.id.toString(16)} ${cmd.name.padEnd(20)} replied, but not for this command: ${anyResponse.raw.toString('hex')}`,
    );
  } else {
    const raw = rawSeen.length ? rawSeen.toString('hex') : '(silence)';
    console.log(`  0x${cmd.id.toString(16)} ${cmd.name.padEnd(20)} no parsed reply — raw: ${raw}`);
  }
}

clearInterval(heartbeat);
await new Promise((resolve) => port.close(() => resolve()));

console.log(
  `\nDevice byte expected on replies: 0x${expectedDevice.toString(16)} ` +
    `(request 0x${DEVICE.MBOOSTER.toString(16)} with nibbles swapped)`,
);
console.log('Compare the values above with what Pit House reported at the top.');
process.exit(0);
