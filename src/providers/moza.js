// providers/moza.js — MOZA mBooster pedal, over its own serial protocol.
//
// A profile points at one of Pit House's own presets by name and may override
// individual settings on top of it. That is the shape the hardware already
// thinks in: the grown-up preset defines the curve's shape, and a child's
// profile reuses it at a lower peak force rather than describing a pedal from
// scratch.
//
// Sets parameters directly on the hardware and reads them back to confirm. No
// Pit House game binding and no stand-in process.
//
// Two things it deliberately does not do:
//
//   * It never reports which preset is "currently active". Preset files are not
//     live state — "Test Preset Unlinked" read forcelimit_max 79 while the
//     pedal sat at 50, because the slider had been moved without saving. What
//     the plugin can honestly report is what it applied and what it read back.
//   * It cannot apply a preset in full. brake_stroke_curve, forcelimit_min,
//     press_combine and the input mapping curve have no known command yet —
//     BACKLOG section 9 lists them and how to find them.
//
// The serial port is exclusive, so Pit House must not be running. It can be
// closed automatically, but only if the user opts in — killing an application
// because a button was pressed should never be a silent default.

import {
  PARAMS,
  withDevice,
  closePitHouse,
  reopenPitHouse,
  isPitHouseRunning,
  scaleCurve,
  CURVE_MIN_PEAK_KG,
  CURVE_FULL_SCALE_KG,
} from '../moza/mbooster.js';
import { listPresets, findPreset } from '../moza/presetStore.js';
import { STATUS } from './status.js';

/** How close a read-back must be to count as applied. */
const TOLERANCE = { peakForceKg: 0.5, maxForceKg: 0.5, travelStartMm: 0.2, travelEndMm: 0.2 };

const lastOf = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined);

/** Preset fields this provider knows how to push to the pedal. */
const FROM_PRESET = {
  peakForceKg: (p) => lastOf(p.brake_forces_curve),
  maxForceKg: (p) => p.force_max_coef,
  travelStartMm: (p) => p.brake_machinelimit_min,
  travelEndMm: (p) => p.brake_machinelimit_max,
};

/**
 * Whether a config field holds a value.
 *
 * The blank check matters: `Number('')` is 0, which is finite, so treating an
 * empty field as a value would silently write 0 — a travel end of 0mm on a
 * brake pedal. A field left empty means "leave this alone".
 */
function filled(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  return Number.isFinite(Number(raw));
}

/** Which of the directly-writable parameters the profile overrides. */
function overrides(cfg) {
  return Object.keys(PARAMS).filter((k) => filled(cfg?.[k]));
}

/**
 * Work out what should end up on the pedal.
 *
 * The preset supplies the baseline and the profile's own fields win over it, so
 * "Brian's preset, but 24kg" is expressible without copying a curve around.
 */
function resolve(cfg, { preset = null } = {}) {
  const params = preset?.deviceParams ?? null;
  const plan = { curve: null, values: {}, presetName: preset?.name ?? null };

  if (params) {
    for (const [key, pick] of Object.entries(FROM_PRESET)) {
      const value = pick(params);
      if (Number.isFinite(value)) plan.values[key] = value;
    }
    if (Array.isArray(params.brake_forces_curve) && params.brake_forces_curve.length === 7) {
      plan.curve = params.brake_forces_curve.slice();
    }
  }

  for (const key of Object.keys(FROM_PRESET)) {
    if (filled(cfg?.[key])) plan.values[key] = Number(cfg[key]);
  }

  // The peak is the curve's last point, so an override rescales the whole shape
  // rather than moving one end of it. Only an actual override rescales: passing
  // the preset's own peak back through the scaling would multiply by 1 and
  // leave float dust on every point, which then reads back as a mismatch.
  if (plan.curve && filled(cfg?.peakForceKg)) {
    plan.curve = scaleCurve(plan.curve, Number(cfg.peakForceKg));
  }
  if (plan.curve) plan.values.peakForceKg = lastOf(plan.curve);

  return plan;
}

export default {
  id: 'moza',
  label: 'MOZA mBooster',
  // Values are read back from the pedal itself.
  verifiable: true,
  // Profile-only, for the same reason as the wheelbase: pedal force is a
  // safety setting, not an ambience one.
  contexts: ['profile'],

  /**
   * Installation-wide, not per profile. See fanatecBase for why these are
   * declared rather than hardcoded in the editor and the exporter.
   */
  settingsSchema() {
    return [
      {
        key: 'mozaClosePitHouse',
        label: 'Close Pit House when switching',
        type: 'boolean',
        default: true,
        help: 'Pit House holds the serial port, so the pedal cannot be written while it is open.',
      },
      {
        key: 'mozaReopenPitHouse',
        label: 'Reopen Pit House afterwards',
        type: 'boolean',
        default: false,
        help: 'Off by default: reopening re-applies its own preset over the one just written.',
      },
    ];
  },

  schema() {
    return [
      {
        key: 'preset',
        label: 'Pit House preset',
        type: 'select',
        // Filled from disk via options(); empty means "no preset, overrides only".
        options: [],
        help: 'The preset this profile starts from. Anything below overrides it.',
      },
      {
        key: 'peakForceKg',
        label: 'Peak force (kg)',
        type: 'range',
        min: CURVE_MIN_PEAK_KG,
        max: CURVE_FULL_SCALE_KG,
        step: 1,
        unit: 'kg',
        help: `How hard the pedal pushes back at full travel — the setting that makes it lighter for a child. Needs a preset, which supplies the curve shape. The pedal cannot hold less than ${CURVE_MIN_PEAK_KG}kg smoothly.`,
      },
      ...Object.entries(PARAMS).map(([key, spec]) => ({
        key,
        label: `${spec.label} (${spec.unit})`,
        type: 'range',
        min: spec.min,
        max: spec.max,
        step: spec.step ?? 1,
        unit: spec.unit,
        help: spec.help,
      })),
    ];
  },

  /** Pit House's own pedal presets, so a profile picks a name rather than a uuid. */
  async options() {
    return listPresets({ deviceType: 'Pedals', device: 'mBooster' }).map((p) => ({
      value: p.id,
      label: p.name,
    }));
  },

  /**
   * Is this configuration well formed?
   *
   * Deliberately NOT "does the preset still exist". That is environmental, not
   * structural: Pit House can delete or repackage a preset without the config
   * changing, and treating it as a validation error meant one profile pointing
   * at a missing preset blocked saving *every* profile — with no way to change
   * the value, because the dropdown had no option for it. A Pit House upgrade
   * hit exactly that.
   *
   * A missing preset is caught in apply(), where it stops the switch and says
   * so, and shown in the editor, which greys the block and offers to remove it.
   */
  validate(cfg) {
    const problems = [];
    const hasPreset = Boolean(cfg?.preset);
    const changed = overrides(cfg);

    if (!hasPreset && !changed.length && !filled(cfg?.peakForceKg)) {
      problems.push('MOZA is enabled but no preset or pedal setting is chosen');
    }

    // Scaling a curve needs a curve. Reading the live one instead would make the
    // result depend on whichever profile ran last, which is exactly the kind of
    // surprise a child's brake pedal should not have.
    if (filled(cfg?.peakForceKg) && !hasPreset) {
      problems.push('MOZA peak force needs a preset to take its curve shape from');
    }
    if (filled(cfg?.peakForceKg)) {
      const peak = Number(cfg.peakForceKg);
      if (peak < CURVE_MIN_PEAK_KG || peak > CURVE_FULL_SCALE_KG) {
        problems.push(
          `MOZA peak force must be ${CURVE_MIN_PEAK_KG}-${CURVE_FULL_SCALE_KG}kg — below ` +
            `${CURVE_MIN_PEAK_KG}kg the pedal feels stepped rather than light`,
        );
      }
    }

    for (const key of changed) {
      const spec = PARAMS[key];
      const value = Number(cfg[key]);
      if (value < spec.min || value > spec.max) {
        problems.push(`MOZA ${spec.label.toLowerCase()} must be ${spec.min}-${spec.max}${spec.unit}`);
      }
    }
    return problems;
  },

  describe(cfg) {
    const preset = cfg?.preset ? findPreset(cfg.preset) : null;
    const parts = [];
    if (preset) parts.push(`preset "${preset.name}"`);
    else if (cfg?.preset) parts.push(`preset "${cfg.preset}" (missing)`);
    if (filled(cfg?.peakForceKg)) parts.push(`peak force ${Number(cfg.peakForceKg)}kg`);
    for (const key of overrides(cfg)) {
      parts.push(`${PARAMS[key].label.toLowerCase()} ${Number(cfg[key])}${PARAMS[key].unit}`);
    }
    return parts.length ? `pedal ${parts.join(', ')}` : 'pedal (not configured)';
  },

  async apply(cfg, ctx = {}) {
    const problems = this.validate(cfg);
    if (problems.length) throw new Error(problems[0]);

    const preset = cfg?.preset ? findPreset(cfg.preset) : null;
    if (cfg?.preset && !preset) {
      // Caught here rather than in validate(), because whether a preset still
      // exists is environmental and can change without the config changing.
      // Failing beats quietly applying the overrides without the curve they
      // were meant to modify: "Brian's shape at 24kg" silently becoming "24kg
      // of whatever is already loaded" is the wrong surprise on a brake pedal.
      throw new Error(
        `preset "${cfg.preset}" is not in Pit House's library — pick another in the editor`,
      );
    }
    const plan = resolve(cfg, { preset });

    // On by default, matching Fanatec's auto-start. Pit House holds the serial
    // port exclusively, so leaving this off means a profile switch fails
    // whenever Pit House happens to be open — which, since it launches with
    // Windows, is most of the time. Closing it is also recoverable in a way the
    // failure is not: reopening restores whatever preset it wants.
    //
    // Reopening afterwards stays opt-in and off, deliberately: Pit House
    // re-applies a preset on start and would undo the switch that just ran.
    if (ctx.settings?.mozaClosePitHouse !== false) {
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
        if (plan.curve) {
          const failed = await session.writeCurve(plan.curve);
          if (failed.length) {
            throw new Error(
              `force curve point${failed.length > 1 ? 's' : ''} ${failed.join(', ')} would not ` +
                'take — the pedal may be left with an uneven curve, so apply the profile again',
            );
          }
        }
        for (const key of Object.keys(PARAMS)) {
          if (!Number.isFinite(plan.values[key])) continue;
          const acknowledged = await session.write(key, plan.values[key]);
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
    const preset = cfg?.preset ? findPreset(cfg.preset) : null;
    const plan = resolve(cfg, { preset });
    const wanted = Object.keys(PARAMS).filter((k) => Number.isFinite(plan.values[k]));
    if (!wanted.length && !plan.curve) {
      return { status: STATUS.SKIPPED, detail: 'nothing configured' };
    }

    let readings;
    try {
      readings = await withDevice(async (session) => {
        const out = { params: {} };
        if (plan.curve) out.curve = await session.readCurve();
        for (const key of wanted) out.params[key] = await session.read(key);
        return out;
      }, ctx);
    } catch (err) {
      return { status: STATUS.UNREACHABLE, detail: err.message };
    }

    const wrong = [];
    const summary = [];

    if (plan.curve) {
      const got = readings.curve ?? [];
      const unreadable = got.filter((v) => v === null).length;
      if (unreadable) {
        wrong.push(`${unreadable} of ${plan.curve.length} force curve points unreadable`);
      } else {
        // Every point is checked, not just the peak: a partial write leaves a
        // curve that peaks correctly but sags in the middle.
        const off = got.filter((v, i) => Math.abs(v - plan.curve[i]) > TOLERANCE.peakForceKg);
        if (off.length) {
          wrong.push(`${off.length} force curve point(s) differ from the profile`);
        } else {
          summary.push(`peak force ${lastOf(got).toFixed(2)}kg`);
        }
      }
    }

    for (const key of wanted) {
      const got = readings.params[key];
      const want = plan.values[key];
      if (got === null || Math.abs(got - want) > (TOLERANCE[key] ?? 0.5)) {
        wrong.push(
          `${PARAMS[key].label} is ${got === null ? 'unreadable' : got.toFixed(2)}, wanted ${want}`,
        );
      } else {
        summary.push(`${PARAMS[key].label.toLowerCase()} ${got.toFixed(2)}${PARAMS[key].unit}`);
      }
    }

    if (wrong.length) return { status: STATUS.MISMATCH, detail: wrong.join('; ') };
    const from = plan.presetName ? ` from "${plan.presetName}"` : '';
    return { status: STATUS.VERIFIED, detail: `pedal confirmed${from} ${summary.join(', ')}` };
  },

  async health() {
    if (await isPitHouseRunning()) {
      return {
        ok: false,
        reason:
          'MOZA Pit House is running and holds the pedal\'s serial port — close it, or enable "Close Pit House when switching"',
      };
    }
    return { ok: true, reason: 'pedal reachable' };
  },
};
