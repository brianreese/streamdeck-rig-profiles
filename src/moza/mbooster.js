// moza/mbooster.js — talk to the mBooster over its USB CDC serial port.
//
// Every value here is confirmed against the hardware: read, written, read back
// and restored. See scripts/moza-probe.mjs and scripts/moza-write-test.mjs.
//
// The port is exclusive, so MOZA Pit House must not be running. That is the
// trade for not depending on it at runtime — Pit House becomes the place you
// author settings, not something that has to be up for a profile to switch.

import { SerialPort } from 'serialport';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
  readFrame, writeFrame, keepAliveFrame, decodeAll, toBytes,
  travel, force, GROUP,
} from './frame.js';

const run = promisify(execFile);

export const BAUD = 115200;
export const VENDOR_ID = '346E';
export const PRODUCT_ID = '0008';
export const PIT_HOUSE_EXE = 'MOZA Pit House.exe';

/**
 * Parameters we have confirmed on real hardware.
 *
 * Only these are exposed. Friction (0xAE) and end-stop stiffness (0xB2) read
 * back cleanly with a selector byte, but their units do not line up with what
 * Pit House stores, so they are deliberately left out rather than guessed at.
 */
export const PARAMS = {
  maxForceKg: {
    label: 'Max force',
    command: 0xb3,
    width: 4,
    unit: 'kg',
    min: 5,
    max: 200,
    step: 1,
    toRaw: force.toRaw,
    fromRaw: force.fromRaw,
    help: 'How hard the pedal must be pressed. Lower is easier.',
  },
  travelStartMm: {
    label: 'Travel start',
    command: 0x84,
    width: 2,
    unit: 'mm',
    min: 0,
    max: 53.5,
    step: 0.1,
    toRaw: travel.toRaw,
    fromRaw: travel.fromRaw,
    help: 'Where pedal travel begins.',
  },
  travelEndMm: {
    label: 'Travel end',
    command: 0x85,
    width: 2,
    unit: 'mm',
    min: 0,
    max: 53.5,
    step: 0.1,
    toRaw: travel.toRaw,
    fromRaw: travel.fromRaw,
    help: 'Where pedal travel ends.',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function isPitHouseRunning({ exec = run } = {}) {
  try {
    const { stdout } = await exec('tasklist', ['/FI', `IMAGENAME eq ${PIT_HOUSE_EXE}`, '/NH']);
    return stdout.toLowerCase().includes('moza pit house');
  } catch {
    return false;
  }
}

/** Close Pit House so the serial port is free. Opt-in; never automatic. */
export async function closePitHouse({ exec = run, waitMs = 4000 } = {}) {
  if (!(await isPitHouseRunning({ exec }))) return { closed: false, wasRunning: false };
  try {
    await exec('taskkill', ['/IM', PIT_HOUSE_EXE, '/F']);
  } catch (err) {
    return { closed: false, wasRunning: true, reason: err.message };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(300);
    if (!(await isPitHouseRunning({ exec }))) return { closed: true, wasRunning: true };
  }
  return { closed: false, wasRunning: true, reason: 'Pit House did not exit' };
}

/** Start Pit House again, detached. Best effort. */
export function reopenPitHouse({ env = process.env, spawnFn = spawn } = {}) {
  const exe = `${env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\MOZA Pit House\\MOZA Pit House.exe`;
  try {
    spawnFn(exe, [], { detached: true, stdio: 'ignore' }).unref?.();
    return true;
  } catch {
    return false;
  }
}

export async function findPort({ list = () => SerialPort.list() } = {}) {
  const ports = await list();
  const hit = ports.find(
    (p) =>
      (p.vendorId ?? '').toUpperCase() === VENDOR_ID &&
      (p.productId ?? '').toUpperCase() === PRODUCT_ID,
  );
  return hit?.path ?? null;
}

/**
 * An open connection to the pedal.
 *
 * The device wants a heartbeat roughly twice a second or it stops answering,
 * so the session owns a timer for its lifetime.
 */
class Session {
  constructor(port) {
    this.port = port;
    this.frames = [];
    this._buffer = Buffer.alloc(0);
    port.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      const { frames, rest } = decodeAll(this._buffer);
      this._buffer = rest;
      this.frames.push(...frames);
    });
    this._heartbeat = setInterval(() => this.port.write(keepAliveFrame()), 500);
    this.port.write(keepAliveFrame());
  }

  /** Read one parameter, returning its decoded value or null. */
  async read(name, { timeoutMs = 700 } = {}) {
    const spec = PARAMS[name];
    if (!spec) throw new Error(`unknown mBooster parameter "${name}"`);
    this.frames = [];
    this.port.write(readFrame(spec.command, { width: spec.width }));
    await sleep(timeoutMs);

    const reply = this.frames.find(
      (f) => f.isResponse && f.requestGroup === GROUP.READ && f.payload[0] === spec.command,
    );
    const value = reply?.payload.subarray(1);
    if (!value || value.length < spec.width) return null;
    const raw = spec.width === 4 ? value.readUInt32BE(0) : value.readUInt16BE(0);
    return spec.fromRaw(raw);
  }

  /** Write one parameter. Returns true when the device acknowledges it. */
  async write(name, value, { settleMs = 1200 } = {}) {
    const spec = PARAMS[name];
    if (!spec) throw new Error(`unknown mBooster parameter "${name}"`);
    if (!Number.isFinite(value)) throw new Error(`${name}: value must be a number`);
    if (value < spec.min || value > spec.max) {
      throw new Error(`${name}: ${value}${spec.unit} is outside ${spec.min}-${spec.max}${spec.unit}`);
    }

    this.frames = [];
    this.port.write(writeFrame(spec.command, toBytes(spec.toRaw(value), spec.width)));
    // Calibration writes are flash-backed and settle before flushing, so do not
    // read straight back.
    await sleep(settleMs);
    return this.frames.some((f) => f.isResponse && f.requestGroup === GROUP.WRITE);
  }

  async close() {
    clearInterval(this._heartbeat);
    await new Promise((resolve) => this.port.close(() => resolve()));
  }
}

/**
 * Open the pedal, run `fn` with a session, and always close the port.
 *
 * @param {(session: Session) => Promise<any>} fn
 */
export async function withDevice(fn, { path = null, PortClass = SerialPort, list } = {}) {
  const target = path ?? (await findPort(list ? { list } : {}));
  if (!target) throw new Error('mBooster not found — is it connected?');

  const port = new PortClass({ path: target, baudRate: BAUD, autoOpen: false });
  try {
    await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  } catch (err) {
    if (/access denied/i.test(err.message)) {
      throw new Error(
        `${target} is in use — MOZA Pit House holds it. Close Pit House, or turn on ` +
          '"Close Pit House when switching" in Hardware settings.',
      );
    }
    throw new Error(`could not open ${target}: ${err.message}`);
  }

  const session = new Session(port);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
