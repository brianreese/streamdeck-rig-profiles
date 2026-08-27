import { describe, it, expect } from 'vitest';
import {
  checksum, encode, decode, decodeAll, readFrame, keepAliveFrame,
  swapNibbles, travel, force, GROUP, DEVICE, START,
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
    expect(travel.toRaw(53.5)).toBe(0); // 65536 wraps to 0 in 16 bits
    expect(travel.toRaw(26.75)).toBe(32768);
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
