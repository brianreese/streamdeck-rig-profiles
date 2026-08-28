import { describe, it, expect } from 'vitest';
import {
  checksum, encode, decode, decodeAll, readFrame, keepAliveFrame,
  swapNibbles, travel, force, GROUP, DEVICE, START, writeFrame, toBytes,
} from './frame.js';

const hex = (buf) => buf.toString('hex');

describe('checksum', () => {
  it('matches AZOM\'s documented keepalive frame', () => {
    // 7e 00 00 12 9d — the one frame we have with a known-good checksum, and
    // therefore the anchor for the whole codec.
    expect(checksum([0x7e, 0x00, 0x00, 0x12])).toBe(0x9d);
  });

  it('wraps at a byte', () => {
    expect(checksum([0xff, 0xff])).toBe((0xff + 0xff + 0x0d) & 0xff);
  });

  it('is the framing constant for an empty body', () => {
    expect(checksum([])).toBe(0x0d);
  });
});

describe('encode', () => {
  it('reproduces the keepalive frame exactly', () => {
    expect(hex(keepAliveFrame())).toBe('7e0000129d');
  });

  it('puts the payload length in LEN, excluding group and device', () => {
    const frame = encode({ group: GROUP.WRITE, device: DEVICE.MBOOSTER, payload: [0xb1, 1, 2, 3] });
    expect(frame[0]).toBe(START);
    expect(frame[1]).toBe(4); // payload only
    expect(frame[2]).toBe(GROUP.WRITE);
    expect(frame[3]).toBe(DEVICE.MBOOSTER);
  });

  it('reproduces the documented motor-command shape', () => {
    // 7e 09 24 12 b1 EF EN 00 P1 FH FL AH AL CK — nine payload bytes.
    const frame = encode({
      group: GROUP.WRITE,
      device: DEVICE.MBOOSTER,
      payload: [0xb1, 0x01, 0x01, 0x00, 0x32, 0x00, 0x14, 0x00, 0x50],
    });
    expect(frame[1]).toBe(0x09);
    expect(frame.subarray(0, 4).toString('hex')).toBe('7e092412');
    expect(frame.length).toBe(14);
  });

  it('ends with a checksum over everything before it', () => {
    const frame = encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [0x84] });
    expect(frame.at(-1)).toBe(checksum([...frame.subarray(0, -1)]));
  });
});

describe('readFrame', () => {
  it('builds a read request for a single command id', () => {
    const frame = readFrame(0x84);
    expect(frame[2]).toBe(GROUP.READ);
    expect(frame[4]).toBe(0x84);
  });

  it('accepts a multi-byte command id', () => {
    const frame = readFrame([0x00, 0x1a]);
    expect(frame[1]).toBe(2);
    expect([frame[4], frame[5]]).toEqual([0x00, 0x1a]);
  });
});

describe('decode', () => {
  it('round-trips a frame it encoded', () => {
    const sent = encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [0x84, 0x12, 0x34] });
    const { frame } = decode(sent);
    expect(frame.group).toBe(GROUP.READ);
    expect(frame.device).toBe(DEVICE.MBOOSTER);
    expect([...frame.payload]).toEqual([0x84, 0x12, 0x34]);
  });

  it('recognises a response by its raised group and reports the request group', () => {
    const reply = encode({ group: GROUP.READ | 0x80, device: 0x21, payload: [0x84, 0x00, 0x10] });
    const { frame } = decode(reply);
    expect(frame.isResponse).toBe(true);
    expect(frame.requestGroup).toBe(GROUP.READ);
  });

  it('rejects a frame whose checksum is wrong', () => {
    const bad = Buffer.from(encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [1] }));
    bad[bad.length - 1] ^= 0xff;
    expect(decode(bad).frame).toBeNull();
  });

  it('skips leading junk to find the start byte', () => {
    const good = encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [0x84] });
    const { frame } = decode(Buffer.concat([Buffer.from([0x00, 0xff, 0xaa]), good]));
    expect([...frame.payload]).toEqual([0x84]);
  });

  it('waits for more bytes rather than parsing a partial frame', () => {
    const full = encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [0x84, 0, 0] });
    expect(decode(full.subarray(0, 4)).frame).toBeNull();
  });

  it('resynchronises past a corrupt frame instead of stalling', () => {
    const bad = Buffer.from(encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [1] }));
    bad[bad.length - 1] ^= 0xff;
    const { consumed } = decode(bad);
    expect(consumed).toBeGreaterThan(0);
  });
});

describe('decodeAll', () => {
  it('pulls several frames out of one buffer', () => {
    const a = encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [0x84] });
    const b = encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [0x85] });
    const { frames } = decodeAll(Buffer.concat([a, b]));
    expect(frames.map((f) => f.payload[0])).toEqual([0x84, 0x85]);
  });

  it('keeps a trailing partial frame for the next read', () => {
    const a = encode({ group: GROUP.READ, device: DEVICE.MBOOSTER, payload: [0x84] });
    const partial = a.subarray(0, 3);
    const { frames, rest } = decodeAll(Buffer.concat([a, partial]));
    expect(frames).toHaveLength(1);
    expect(rest.length).toBeGreaterThan(0);
  });
});

describe('device id nibble swap', () => {
  it('maps a request device onto its response form', () => {
    expect(swapNibbles(0x12)).toBe(0x21);
    expect(swapNibbles(0x1d)).toBe(0xd1);
  });
});

describe('value scaling', () => {
  it('encodes travel as millimetres over the 53.5mm range', () => {
    expect(travel.toRaw(0)).toBe(0);
    expect(travel.toRaw(26.75)).toBe(32768);
  });

  it('clamps full scale instead of wrapping it round to zero', () => {
    // Full scale is 65536, which does not fit 16 bits. Wrapping turned the top
    // of the range into the bottom: a 200kg threshold, the value MOZA's own
    // child preset carries, was written as 0x00010000 and read back as 0.00kg.
    expect(travel.toRaw(53.5)).toBe(0xffff);
    expect(force.toRaw(200)).toBe(0xffff);
    expect(force.fromRaw(force.toRaw(200))).toBeCloseTo(200, 2);
    // Nothing below the top changes.
    expect(force.toRaw(50)).toBe(16384);
  });

  it('round-trips a travel value close enough to be recognisable', () => {
    expect(travel.fromRaw(travel.toRaw(20))).toBeCloseTo(20, 3);
  });

  it('encodes force as kilograms over the 200kg range', () => {
    expect(force.toRaw(0)).toBe(0);
    expect(force.toRaw(100)).toBe(32768);
  });

  it('round-trips a force value', () => {
    expect(force.fromRaw(force.toRaw(88))).toBeCloseTo(88, 3);
  });
});

describe('write frames', () => {
  it('uses the write group', () => {
    const frame = writeFrame(0xb3, toBytes(force.toRaw(35), 4));
    expect(frame[2]).toBe(GROUP.WRITE);
    expect(frame[3]).toBe(DEVICE.MBOOSTER);
  });

  it('reproduces a real max-threshold write for 50kg', () => {
    // 50kg is the value the hardware read back as 0x00004000, so a write of
    // the same value must produce those bytes.
    const frame = writeFrame(0xb3, toBytes(force.toRaw(50), 4));
    expect(frame.subarray(4).toString('hex')).toBe('b300004000' + frame.at(-1).toString(16).padStart(2, '0'));
  });

  it('carries a selector when one is given', () => {
    const frame = writeFrame([0xae, 0x01], toBytes(20, 2));
    expect([...frame.subarray(4, 7)]).toEqual([0xae, 0x01, 0x00]);
  });
});

describe('toBytes', () => {
  it('encodes big-endian at the requested width', () => {
    expect(toBytes(0x1234, 2)).toEqual([0x12, 0x34]);
    expect(toBytes(0x4000, 4)).toEqual([0x00, 0x00, 0x40, 0x00]);
  });
});

describe('readFrame width', () => {
  it('reserves space for the answer', () => {
    // Without this the device replies with no value bytes at all.
    const frame = readFrame(0x84, { width: 2 });
    expect(frame[1]).toBe(3); // command id + two placeholders
    expect([...frame.subarray(4, 7)]).toEqual([0x84, 0x00, 0x00]);
  });
});

// Every vector below is real traffic captured from the pedal. 0x7E marks the
// start of a frame, so the device escapes any other 0x7E by doubling it, and
// checksums the escaped bytes. Missing this cost a day: a value encoding to
// 08 7E was silently ignored on write, and swallowed the reply behind it.
describe('0x7E escaping', () => {
  it('leaves frames without a 0x7E byte exactly as they were', () => {
    // The documented keepalive is the regression guard for the whole scheme.
    expect(keepAliveFrame().toString('hex')).toBe('7e0000129d');
    expect(readFrame([0xab, 0x00, 8], { width: 2 }).toString('hex')).toBe('7e052312ab0008000078');
  });

  it('doubles a 0x7E inside a value, and checksums the escaped bytes', () => {
    // 2174 encodes to 08 7E. The device accepted this exact frame.
    const frame = writeFrame([0xab, 0x00, 9], toBytes(2174, 2));
    expect(frame.toString('hex')).toBe('7e052412ab0009087e7e7e7e');
  });

  it('decodes a reply whose value contains an escaped 0x7E', () => {
    // Captured: force curve point 9 reading 2174.
    const { frames } = decodeAll(Buffer.from('7e05a321ab0009087e7e0c', 'hex'));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload[2]).toBe(9);
    expect(frames[0].payload.readUInt16BE(3)).toBe(2174);
  });

  it('decodes a reply whose checksum itself lands on 0x7E', () => {
    // Captured: point 10 reading 6747, checksum 0x7e, therefore doubled.
    const { frames } = decodeAll(Buffer.from('7e05a321ab000a1a5b7e7e', 'hex'));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.readUInt16BE(3)).toBe(6747);
  });

  it('does not lose the frame queued behind an escaped one', () => {
    // The original bug: everything after the escape was swallowed.
    const { frames } = decodeAll(
      Buffer.from('7e05a321ab000a1a5b7e7e' + '7e0080212c' + '7e05a321ab000b1e456d', 'hex'),
    );
    expect(frames).toHaveLength(3);
    expect(frames[0].payload.readUInt16BE(3)).toBe(6747);
    expect(frames[2].payload.readUInt16BE(3)).toBe(7749);
  });

  it('round-trips any value, including ones full of start bytes', () => {
    for (const value of [0x7e7e, 0x007e, 0x7e00, 2174, 0, 0xffff]) {
      const { frames } = decodeAll(writeFrame([0xab, 0x00, 9], toBytes(value, 2)));
      expect(frames).toHaveLength(1);
      expect(frames[0].payload.readUInt16BE(3)).toBe(value);
    }
  });

  it('steps over a stray start byte instead of waiting for 126 bytes', () => {
    // A lone 0x7E is not a header. Read as one it claims a payload that never
    // arrives, and the decoder stalls holding every frame behind it.
    const { frames } = decodeAll(Buffer.from('7e' + '7e0000129d', 'hex'));
    expect(frames).toHaveLength(1);
    expect(frames[0].group).toBe(GROUP.KEEPALIVE);
  });
});
