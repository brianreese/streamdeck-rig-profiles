// moza/frame.js — MOZA serial wire format.
//
//   7E │ LEN │ GRP │ DEV │ PAYLOAD… │ CHK
//
//   LEN  length of PAYLOAD only — it excludes GRP and DEV
//   GRP  request group: 0x23 read, 0x24 write for mBooster calibration
//   DEV  device id: 0x12 a lone mBooster
//   CHK  (sum of every preceding byte, including the 0x7E, + 0x0D) & 0xFF
//
// Multi-byte values are big-endian.
//
// The 0x0D in the checksum is not arbitrary — it compensates for USB framing
// the devices expect. It is confirmed by AZOM's documented keepalive frame,
// which is used as a test vector: 7e 00 00 12 9d, where
// 0x7E + 0x00 + 0x00 + 0x12 = 0x90, and 0x90 + 0x0D = 0x9D.
//
// A response mirrors the request with the group raised by 0x80 and the device
// id's nibbles swapped, so a read of group 0x23 from device 0x12 comes back as
// group 0xA3 from 0x21. That swap is how a reply is matched to its request.
//
// Sources: Boxflat's moza-protocol.md (general framing, checksum) and AZOM's
// docs/protocol/devices/mbooster.md (mBooster groups, device ids, commands).
// Both are read as protocol documentation; no code is taken from either, since
// AZOM is GPL-3.0 and this project is not.

export const START = 0x7e;
export const CHECKSUM_MAGIC = 0x0d;

/** Request groups. */
export const GROUP = {
  READ: 0x23, // 35
  WRITE: 0x24, // 36
  KEEPALIVE: 0x00,
};

/** A response carries the request group raised by this. */
export const RESPONSE_FLAG = 0x80;

/** Device ids. */
export const DEVICE = {
  MBOOSTER: 0x12,
  MBOOSTER_BRAKE: 0x1d, // only in a multi-unit chain
  MBOOSTER_CLUTCH: 0x1e,
};

/** Sum of the given bytes plus the framing constant. */
export function checksum(bytes) {
  let sum = CHECKSUM_MAGIC;
  for (const b of bytes) sum += b;
  return sum & 0xff;
}

/** Devices treat 0x7E as a frame start, so it cannot appear raw in a body. */
export function needsEscaping(bytes) {
  return bytes.some((b) => b === START);
}

/**
 * Build a frame.
 *
 * @param {object} opts
 * @param {number} opts.group    GROUP.READ / GROUP.WRITE
 * @param {number} opts.device   DEVICE.*
 * @param {number[]} opts.payload command id followed by any values
 * @returns {Buffer}
 */
export function encode({ group, device, payload = [] }) {
  const body = [START, payload.length, group, device, ...payload];
  return Buffer.from([...body, checksum(body)]);
}

/**
 * A read request.
 *
 * The request must reserve space for the answer: sending only the command id
 * gets a well-formed reply with no value bytes back. Appending `width` zero
 * bytes makes the device fill them in. This is why command tables carry a byte
 * width per parameter — it is part of the request, not just documentation.
 *
 * @param {number|number[]} commandId  id, optionally followed by a selector
 * @param {object} [opts]
 * @param {number} [opts.width]  expected value size in bytes
 */
export function readFrame(commandId, { device = DEVICE.MBOOSTER, width = 0 } = {}) {
  const id = Array.isArray(commandId) ? commandId : [commandId];
  return encode({ group: GROUP.READ, device, payload: [...id, ...new Array(width).fill(0)] });
}

/**
 * A write request.
 *
 * @param {number|number[]} commandId  id, optionally followed by a selector
 * @param {number[]|Buffer} value      big-endian value bytes
 */
export function writeFrame(commandId, value = [], { device = DEVICE.MBOOSTER } = {}) {
  const id = Array.isArray(commandId) ? commandId : [commandId];
  return encode({ group: GROUP.WRITE, device, payload: [...id, ...value] });
}

/** Big-endian bytes for a value of the given width. */
export function toBytes(value, width) {
  const out = [];
  for (let i = width - 1; i >= 0; i--) out.push((value >>> (i * 8)) & 0xff);
  return out;
}

/** The keepalive the device expects roughly twice a second. */
export function keepAliveFrame({ device = DEVICE.MBOOSTER } = {}) {
  return encode({ group: GROUP.KEEPALIVE, device, payload: [] });
}

/** Swap a device id's nibbles, as responses do (0x12 -> 0x21). */
export function swapNibbles(byte) {
  return ((byte << 4) & 0xf0) | ((byte >> 4) & 0x0f);
}

/**
 * Parse one frame from the head of a buffer.
 *
 * @returns {{ frame: object|null, consumed: number }}
 *   `frame` is null when the buffer holds no complete valid frame yet;
 *   `consumed` says how many bytes to drop (resynchronising past junk).
 */
export function decode(buf) {
  const start = buf.indexOf(START);
  if (start < 0) return { frame: null, consumed: buf.length };
  // Need at least start, len, group, device, checksum.
  if (buf.length - start < 5) return { frame: null, consumed: start };

  const len = buf[start + 1];
  const total = 5 + len; // 7E LEN GRP DEV + payload + CHK
  if (buf.length - start < total) return { frame: null, consumed: start };

  const body = buf.subarray(start, start + total - 1);
  const expected = checksum(body);
  const actual = buf[start + total - 1];
  if (expected !== actual) {
    // Bad checksum: step past this 0x7E and let the caller resynchronise.
    return { frame: null, consumed: start + 1 };
  }

  const group = buf[start + 2];
  const device = buf[start + 3];
  return {
    frame: {
      group,
      device,
      isResponse: (group & RESPONSE_FLAG) !== 0,
      requestGroup: group & ~RESPONSE_FLAG,
      payload: Buffer.from(buf.subarray(start + 4, start + total - 1)),
      raw: Buffer.from(buf.subarray(start, start + total)),
    },
    consumed: start + total,
  };
}

/** Pull every complete frame out of a stream buffer. */
export function decodeAll(buf) {
  const frames = [];
  let rest = buf;
  for (;;) {
    const { frame, consumed } = decode(rest);
    if (frame) frames.push(frame);
    if (consumed <= 0) break;
    rest = rest.subarray(consumed);
    if (!frame && rest.length < 5) break;
  }
  return { frames, rest };
}

// ---------------------------------------------------------------------------
// Value encodings, from AZOM's documented scaling
// ---------------------------------------------------------------------------

/** Travel positions: millimetres over a 53.5mm range, as a 16-bit int. */
export const travel = {
  toRaw: (mm) => Math.round((mm * 65536) / 53.5) & 0xffff,
  fromRaw: (raw) => (raw * 53.5) / 65536,
};

/** Max threshold: kilograms over a 200kg range, as a 32-bit int. */
export const force = {
  toRaw: (kg) => Math.round((kg * 65536) / 200) >>> 0,
  fromRaw: (raw) => (raw * 200) / 65536,
};

export function readU16(buf, offset = 0) {
  return buf.readUInt16BE(offset);
}

export function readU32(buf, offset = 0) {
  return buf.readUInt32BE(offset);
}
