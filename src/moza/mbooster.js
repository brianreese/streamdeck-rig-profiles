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
  travel, force, GROUP, DEVICE, swapNibbles,
} from './frame.js';

const run = promisify(execFile);

export const BAUD = 115200;
export const VENDOR_ID = '346E';
export const PRODUCT_ID = '0008';
export const PIT_HOUSE_EXE = 'MOZA Pit House.exe';

/**
 * Parameters we have confirmed on real hardware.
 *
 * Encoding note: these values are a 16-bit fraction of 65536 scaled to the
 * parameter's range, which is why an early reading of friction and stiffness
 * as plain integers looked wrong. Confirmed against the live pedal:
 *   0xAE 0x2666 -> 0.15 -> friction 15%
 *   0xB2 0x4CCD -> 0.30 -> stiffness 3 of 10
 *   0xB7 0x4000 -> 0.25 -> damping 25%
 *
 * A caution about what these do NOT change: the pedal's physical resistance
 * comes from a force-vs-travel curve (forces_curve, 7 points, paired with
 * stroke_curve, 6 points) that nobody has mapped — AZOM lists it as an open
 * question. 0xB3 sets the load at which output reaches 100%, so lowering it
 * means full braking needs less pressure, while the pedal feels exactly as
 * stiff as before. For a child that is arguably the more useful control, but
 * it is not the same thing as a softer pedal.
 *
 * Only these are exposed. Friction (0xAE) and end-stop stiffness (0xB2) read
 * back cleanly with a selector byte, but their units do not line up with what
 * Pit House stores, so they are deliberately left out rather than guessed at.
 */
export const PARAMS = {
  maxForceKg: {
    label: 'Load cell threshold',
    command: 0xb3,
    width: 4,
    unit: 'kg',
    min: 5,
    max: 200,
    step: 1,
    toRaw: force.toRaw,
    fromRaw: force.fromRaw,
    // Pit House calls this "Maximum threshold for pressure sensors". It does
    // nothing at all when brake_press_combine is 0, because the output then
    // comes from pedal angle and the load cell contributes nothing — which is
    // why MOZA's own child preset can carry an inherited 200kg here without
    // being broken. press_combine is not writable yet; see BACKLOG section 9.
    help: 'Pressure that counts as 100% braking. Has no effect while the pedal is set to angle-based output. To make the pedal lighter, set the peak force instead.',
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

/**
 * The pedal's serial port, or null when it is not connected.
 *
 * COM numbers move between reboots and USB ports, so nothing is hardcoded — the
 * port is found by vendor and product id every time. `346E:0008` is the
 * mBooster specifically; the wheelbase and flight stick enumerate under
 * different product ids and are never candidates.
 *
 * Ambiguity is refused rather than guessed. Windows reports a port-derived
 * instance id rather than a device serial for this device, so with two
 * mBoosters attached there is nothing here to tell them apart, and picking the
 * first would mean writing a brake curve to whichever one happened to enumerate
 * first.
 */
export async function findPort({ list = () => SerialPort.list() } = {}) {
  const ports = await list();
  const matches = ports.filter(
    (p) =>
      (p.vendorId ?? '').toUpperCase() === VENDOR_ID &&
      (p.productId ?? '').toUpperCase() === PRODUCT_ID,
  );
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} mBooster-class devices found (${matches.map((m) => m.path).join(', ')}). ` +
        'Refusing to guess which one to write to — pass an explicit port.',
    );
  }
  return matches[0]?.path ?? null;
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

  /**
   * Read one force curve point. Command 0xAB is addressed by a 16-bit index,
   * and a request without one answers with zeros rather than an error.
   */
  async readCurvePoint(index, { timeoutMs = 500, attempts = 4 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.frames = [];
      this.port.write(readFrame([CURVE_COMMAND, 0x00, index], { width: 2 }));
      await sleep(timeoutMs);
      const reply = this.frames.find(
        (f) =>
          f.isResponse &&
          f.requestGroup === GROUP.READ &&
          f.device === swapNibbles(DEVICE.MBOOSTER) &&
          f.payload[0] === CURVE_COMMAND &&
          f.payload.length >= 5 &&
          f.payload[2] === index,
      );
      if (reply) return reply.payload.readUInt16BE(3);
    }
    return null;
  }

  /**
   * Write one force curve point, proving it landed by reading it back.
   *
   * An acknowledgement is not enough here. Points quietly fail to take, and on
   * a force curve a partial write is not cosmetic — it leaves a non-monotonic
   * curve, a pedal that gets *lighter* part way down. The read-back is allowed
   * to come back a unit low, because the firmware stores these as floats and
   * truncates on the way out.
   */
  async writeCurvePoint(index, raw, { attempts = 4, settleMs = 250 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.frames = [];
      this.port.write(writeFrame([CURVE_COMMAND, 0x00, index], toBytes(raw, 2)));
      await sleep(settleMs);
      const got = await this.readCurvePoint(index);
      if (got !== null && Math.abs(got - raw) <= 1) return true;
    }
    return false;
  }

  /** The seven force points, in kg, or null for any that would not answer. */
  async readCurve() {
    const out = [];
    for (const index of CURVE_POINTS) {
      const raw = await this.readCurvePoint(index);
      out.push(raw === null ? null : curveKg(raw));
    }
    return out;
  }

  /**
   * Write all seven force points.
   *
   * Written low to high so that an interrupted write leaves the pedal lighter
   * than intended rather than heavier — the safe direction to fail in when a
   * child is about to use it.
   */
  async writeCurve(forcesKg) {
    if (forcesKg.length !== CURVE_POINTS.length) {
      throw new Error(`force curve needs ${CURVE_POINTS.length} points, got ${forcesKg.length}`);
    }
    const failed = [];
    for (let i = 0; i < CURVE_POINTS.length; i++) {
      const ok = await this.writeCurvePoint(CURVE_POINTS[i], curveRaw(forcesKg[i]));
      if (!ok) failed.push(i + 1);
    }
    return failed;
  }

  async close() {
    clearInterval(this._heartbeat);
    await new Promise((resolve) => this.port.close(() => resolve()));
  }
}

/**
 * Confirm the thing on the other end really is an mBooster.
 *
 * Vendor and product id say what Windows thinks is plugged in. This asks the
 * device itself, and it is the check that matters, because being wrong here
 * means writing brake calibration into something that is not a brake.
 *
 * The fingerprint is the curve's travel axis: seven fixed values the firmware
 * holds at indices 0-6, near `i × 65536/7`. They are not exactly even — the
 * firmware stores them as floats and reads back truncated, so observed steps
 * run 9361-9364 — hence the tolerance. Six values each landing in a narrow band
 * is not something another device answers by chance, and unlike a serial number
 * it verifies the table layout we are about to write into.
 */
export const CURVE_COMMAND = 0xab;
export const CURVE_POINTS = [8, 9, 10, 11, 12, 13, 14];
export const CURVE_AXIS = [0, 1, 2, 3, 4, 5, 6].map((i) => Math.round((i * 65536) / 7));
const AXIS_TOLERANCE = 32;

/** The curve's force points are a 16-bit fraction of this range, in kg. */
export const CURVE_FULL_SCALE_KG = 200;

/**
 * The lowest peak the pedal can hold smoothly.
 *
 * Pit House's slider stops here; the firmware does not. A lower peak writes and
 * reads back perfectly and feels stepped, because the motor cannot hold a force
 * that small without its cogging becoming detents you can feel. At 12kg it is
 * unmistakable. Only the peak is clamped — the points below it are meant to be
 * smaller, and MOZA's own 24kg preset starts at 8.6kg.
 */
export const CURVE_MIN_PEAK_KG = 24;

export const curveKg = (raw) => (raw * CURVE_FULL_SCALE_KG) / 65536;
export const curveRaw = (kg) =>
  Math.max(0, Math.min(65535, Math.round((kg * 65536) / CURVE_FULL_SCALE_KG)));

/**
 * Scale a curve's shape to a new peak.
 *
 * This is what Pit House's right-hand slider does: all seven points move
 * together so the pedal gets lighter through the whole travel, rather than
 * merely saturating earlier. Scaling linearly reproduces MOZA's own presets to
 * within half a kilogram against their factory 24kg curve.
 */
export function scaleCurve(forcesKg, peakKg) {
  const peak = forcesKg[forcesKg.length - 1];
  if (!(peak > 0)) throw new Error('curve has no positive peak to scale from');
  return forcesKg.map((kg) => (kg / peak) * peakKg);
}

export async function identify(session, { indices = [1, 3, 6] } = {}) {
  for (const index of indices) {
    const got = await session.readCurvePoint(index);
    if (got === null) {
      return { ok: false, reason: `no answer for curve axis point ${index}` };
    }
    if (Math.abs(got - CURVE_AXIS[index]) > AXIS_TOLERANCE) {
      return {
        ok: false,
        reason: `curve axis point ${index} reads ${got}, expected about ${CURVE_AXIS[index]}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Open the pedal, run `fn` with a session, and always close the port.
 *
 * @param {(session: Session) => Promise<any>} fn
 */
export async function withDevice(fn, { path = null, PortClass = SerialPort, list, verify = true } = {}) {
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
    if (verify) {
      const check = await identify(session);
      if (!check.ok) {
        throw new Error(
          `${target} did not answer as an mBooster (${check.reason}). Nothing was written.`,
        );
      }
    }
    return await fn(session);
  } finally {
    await session.close();
  }
}
