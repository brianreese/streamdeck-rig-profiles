// providers/moza.js — MOZA mBooster pedal, over its own serial protocol.
//
// Sets pedal parameters directly on the hardware and reads them back to
// confirm. No Pit House game binding, no stand-in process, and no requirement
// that no game be running — all of which the previous approach needed.
//
// The wire format is documented by Boxflat and AZOM; every command and scaling
// used here has been read from, written to and restored on a real mBooster.
// Only parameters confirmed that way are exposed: friction (0xAE) and end-stop
// stiffness (0xB2) respond but their units do not match what Pit House stores,
// so they are left out rather than guessed at.
//
// One trade: the serial port is exclusive, so Pit House must not be running.
// It can be closed automatically, but only if the user opts in — killing an
// application because a button was pressed should never be a silent default.

import { PARAMS, withDevice, closePitHouse, reopenPitHouse, isPitHouseRunning } from '../moza/mbooster.js';
import { STATUS } from './status.js';

/** How close a read-back must be to count as applied. */
const TOLERANCE = { maxForceKg: 0.5, travelStartMm: 0.2, travelEndMm: 0.2 };

/**
 * Which parameters the profile actually sets.
 *
 * The blank check matters: `Number('')` is 0, which is finite, so treating an
 * empty field as a value would silently write 0 — a travel end of 0mm on a
 * brake pedal. A field left empty means "leave this alone".
 */
function configured(cfg) {
  return Object.keys(PARAMS).filter((k) => {
    const raw = cfg?.[k];
    if (raw === undefined || raw === null || String(raw).trim() === '') return false;
    return Number.isFinite(Number(raw));
  });
}

export default {
  id: 'moza',
  label: 'MOZA mBooster',
  // Values are read back from the pedal itself.
  verifiable: true,

  schema() {
    return Object.entries(PARAMS).map(([key, spec]) => ({
      key,
      label: `${spec.label} (${spec.unit})`,
      type: 'text',
      placeholder: `${spec.min}–${spec.max}`,
      help: spec.help,
    }));
  },

  validate(cfg) {
    const problems = [];
    const set = configured(cfg);
    if (!set.length) problems.push('MOZA is enabled but no pedal setting is filled in');

    for (const [key, spec] of Object.entries(PARAMS)) {
      const raw = cfg?.[key];
      if (raw === undefined || raw === '' || raw === null) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        problems.push(`MOZA ${spec.label.toLowerCase()} must be a number`);
      } else if (value < spec.min || value > spec.max) {
        problems.push(
          `MOZA ${spec.label.toLowerCase()} must be ${spec.min}-${spec.max}${spec.unit}`,
        );
      }
    }
    return problems;
  },

  describe(cfg) {
    const parts = configured(cfg).map((k) => `${PARAMS[k].label.toLowerCase()} ${cfg[k]}${PARAMS[k].unit}`);
    return parts.length ? `pedal ${parts.join(', ')}` : 'pedal (not configured)';
  },

  async apply(cfg, ctx = {}) {
    const problems = this.validate(cfg);
    if (problems.length) throw new Error(problems[0]);

    // Opt-in only. Default is to fail with a clear message instead.
    if (ctx.settings?.mozaClosePitHouse) {
      const result = await closePitHouse();
      if (result.wasRunning && !result.closed) {
        throw new Error(`could not close Pit House: ${result.reason ?? 'still running'}`);
      }
      if (result.closed && ctx.settings?.mozaReopenPitHouse) {
        ctx._reopenPitHouse = true;
      }
    }

    try {
      await withDevice(async (session) => {
        for (const key of configured(cfg)) {
          const acknowledged = await session.write(key, Number(cfg[key]));
          if (!acknowledged) {
            throw new Error(`${PARAMS[key].label} was not acknowledged by the pedal`);
          }
        }
      }, ctx);
    } finally {
      if (ctx._reopenPitHouse) reopenPitHouse();
    }
  },

  async verify(cfg, ctx = {}) {
    const wanted = configured(cfg);
    if (!wanted.length) return { status: STATUS.SKIPPED, detail: 'nothing configured' };

    let readings;
    try {
      readings = await withDevice(async (session) => {
        const out = {};
        for (const key of wanted) out[key] = await session.read(key);
        return out;
      }, ctx);
    } catch (err) {
      return { status: STATUS.UNREACHABLE, detail: err.message };
    }

    const wrong = [];
    for (const key of wanted) {
      const got = readings[key];
      const want = Number(cfg[key]);
      if (got === null || Math.abs(got - want) > (TOLERANCE[key] ?? 0.5)) {
        wrong.push(`${PARAMS[key].label} is ${got === null ? 'unreadable' : got.toFixed(2)}, wanted ${want}`);
      }
    }

    if (wrong.length) {
      return { status: STATUS.MISMATCH, detail: wrong.join('; ') };
    }
    const summary = wanted.map((k) => `${PARAMS[k].label.toLowerCase()} ${readings[k].toFixed(2)}${PARAMS[k].unit}`);
    return { status: STATUS.VERIFIED, detail: `pedal confirmed ${summary.join(', ')}` };
  },

  async health() {
    if (await isPitHouseRunning()) {
      return {
        ok: false,
        reason: 'MOZA Pit House is running and holds the pedal\'s serial port — close it, or enable "Close Pit House when switching"',
      };
    }
    return { ok: true, reason: 'pedal reachable' };
  },
};
