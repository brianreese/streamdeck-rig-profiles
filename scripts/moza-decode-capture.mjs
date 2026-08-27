// scripts/moza-decode-capture.mjs — decode a USBPcap capture into MOZA frames.
//
// The point of capturing is to see what Pit House writes that we cannot read
// back. Because the wire format is already implemented, a capture turns
// straight into command ids rather than needing analysis.
//
//   node scripts/moza-decode-capture.mjs <capture.pcap> [--all]
//
// By default only writes (group 0x24) are listed, since those are what a slider
// move produces. --all includes reads, replies and keepalives.

import { readFileSync, existsSync } from 'fs';
import { decodeAll, GROUP, travel, force } from '../src/moza/frame.js';

const [file, ...flags] = process.argv.slice(2);
const showAll = flags.includes('--all');

if (!file || !existsSync(file)) {
  console.error('Usage: moza-decode-capture.mjs <capture.pcap> [--all]');
  process.exit(1);
}

const buf = readFileSync(file);

// ------------------------------------------------------------- pcap header
const magic = buf.readUInt32LE(0);
const swapped = magic === 0xd4c3b2a1;
if (magic !== 0xa1b2c3d4 && !swapped) {
  console.error('Not a pcap file (bad magic). If this is pcapng, save as pcap instead.');
  process.exit(1);
}
const u16 = (o) => (swapped ? buf.readUInt16BE(o) : buf.readUInt16LE(o));
const u32 = (o) => (swapped ? buf.readUInt32BE(o) : buf.readUInt32LE(o));
const linkType = u32(20);

// 249 = DLT_USBPCAP
if (linkType !== 249) {
  console.warn(`Warning: link type ${linkType}, expected 249 (USBPcap). Continuing anyway.`);
}

// --------------------------------------------------------------- packets
const payloads = [];
let off = 24;
let packets = 0;
while (off + 16 <= buf.length) {
  const inclLen = u32(off + 8);
  const start = off + 16;
  const end = start + inclLen;
  if (end > buf.length) break;
  packets++;

  const pkt = buf.subarray(start, end);
  if (pkt.length >= 27) {
    // USBPCAP_BUFFER_PACKET_HEADER: headerLen tells us where the data starts,
    // which avoids hardcoding the header layout.
    const headerLen = swapped ? pkt.readUInt16BE(0) : pkt.readUInt16LE(0);
    const dataLength = swapped ? pkt.readUInt32BE(23) : pkt.readUInt32LE(23);
    const endpoint = pkt[21];
    if (headerLen > 0 && headerLen < pkt.length && dataLength > 0) {
      const data = pkt.subarray(headerLen, headerLen + dataLength);
      if (data.length) payloads.push({ endpoint, data });
    }
  }
  off = end;
}

console.log(`${packets} packet(s), ${payloads.length} with data\n`);

// ---------------------------------------------------------------- frames
const seen = [];
for (const { endpoint, data } of payloads) {
  const { frames } = decodeAll(data);
  for (const f of frames) seen.push({ endpoint, frame: f });
}

const writes = seen.filter((s) => !s.frame.isResponse && s.frame.group === GROUP.WRITE);
const reads = seen.filter((s) => !s.frame.isResponse && s.frame.group === GROUP.READ);
const replies = seen.filter((s) => s.frame.isResponse);

console.log(`${seen.length} MOZA frame(s): ${writes.length} write, ${reads.length} read, ${replies.length} reply\n`);

/** Best-effort interpretation of a value, to make a command recognisable. */
function interpret(payload) {
  const v = payload.subarray(1);
  if (!v.length) return '';
  const hints = [];
  if (v.length >= 2) {
    const raw16 = v.readUInt16BE(0);
    hints.push(`u16 ${raw16}`, `as-mm ${travel.fromRaw(raw16).toFixed(2)}`);
  }
  if (v.length >= 4) {
    const raw32 = v.readUInt32BE(0);
    hints.push(`u32 ${raw32}`, `as-kg ${force.fromRaw(raw32).toFixed(2)}`, `float ${v.readFloatBE(0).toFixed(3)}`);
  }
  return hints.join('  ');
}

const list = showAll ? seen : writes;
if (!list.length) {
  console.log('No writes found. Either the capture missed the moment, or the');
  console.log('wrong device was selected. Try --all to see whether ANY MOZA');
  console.log('frames were captured at all.');
  process.exit(0);
}

// Collapse repeats: a slider drag sends the same command many times.
const byCommand = new Map();
for (const { frame } of list) {
  const cmd = frame.payload[0];
  const key = `${frame.group}.${frame.device}.${cmd}`;
  if (!byCommand.has(key)) byCommand.set(key, { frame, cmd, count: 0, values: new Set() });
  const entry = byCommand.get(key);
  entry.count++;
  entry.values.add(frame.payload.subarray(1).toString('hex'));
  entry.frame = frame; // keep the last one
}

console.log('commands seen (most distinct values first):\n');
const rows = [...byCommand.values()].sort((a, b) => b.values.size - a.values.size);
for (const r of rows) {
  console.log(
    `  0x${r.cmd.toString(16).padStart(2, '0')}  group 0x${r.frame.group.toString(16)}  dev 0x${r.frame.device.toString(16)}  ` +
      `sent ${String(r.count).padStart(4)}x  ${r.values.size} distinct value(s)`,
  );
  for (const v of [...r.values].slice(0, 6)) {
    console.log(`        ${v.padEnd(16)} ${interpret(Buffer.from(`00${v}`, 'hex'))}`);
  }
}

console.log('\nA slider drag should show one command with many distinct values.');
