// providers/moza.js — MOZA preset switching (experimental).
//
// HOW THIS WORKS, AND WHY IT IS ODD
// ---------------------------------
// MOZA's SDK cannot apply presets for pedals (its whole pedal surface is seven
// output settings, while an mBooster preset carries ~91 parameters), and the
// device protocol has not been reverse engineered. See docs/BACKLOG.md §6.
//
// What does work is Pit House's own "apply a preset when this game launches"
// feature. It matches on process NAME alone, so briefly running a harmless
// stand-in with a game's executable name makes Pit House apply the preset bound
// to that game. The change sticks after the process exits.
//
// So a profile switch here is: run a fake game, let Pit House do the work.
//
// This is a workaround and is labelled experimental. It applies equally to any
// MOZA peripheral — wheelbase, pedals, wheel — because the trigger has nothing
// to do with the device; Pit House decides what to apply from its own binding.
//
// HARD LIMITATION: NO GAME MAY BE RUNNING
// ---------------------------------------
// Tested: while ANY game Pit House knows is running, it ignores further game
// starts for preset purposes. A trigger fired mid-session does nothing — the
// switch is silently dropped, not delayed.
//
// So the workable order is: switch the profile first, then launch the game.
// And the games actually played must have NO default preset set, or starting
// one overrides whatever the profile just applied. An unbound game was
// confirmed to leave the pedal alone.
//
// verify() catches the mid-session case, so it fails loudly rather than
// leaving a key claiming success over an unchanged pedal.
//
// SETUP, which is unavoidably manual
// ----------------------------------
//   1. In Pit House, bind the preset to a game you will never launch AND use
//      "Set as Game Default Preset". The binding alone is not enough: many
//      presets can claim one game, and Pit House applies whichever is that
//      game's default. It warns when you replace an existing default.
//   2. Put that game's executable name in this provider's Trigger field.
// The game list is compiled into Pit House and cannot be extended, so the name
// must be one it already knows.

import { listAllPresets, findPreset, readSelection, resolvePitHouseDir } from '../moza/presetStore.js';
import { runStandIn, validateExeName, DEFAULT_LINGER_MS } from '../moza/standIn.js';
import { STATUS } from './status.js';

function presetOptions(deps = {}) {
  return listAllPresets(deps).map((p) => ({
    value: p.id,
    // Star marks your own presets; the type disambiguates same-named ones.
    label: `${p.isOfficial ? '' : '★ '}${p.name} [${p.deviceType}]`,
  }));
}

export default {
  id: 'moza',
  label: 'MOZA (experimental)',
  // Pit House records what it applied, so this can genuinely be checked.
  verifiable: true,

  schema() {
    return [
      {
        key: 'presetId',
        label: 'Preset',
        type: 'select',
        options: presetOptions(),
        help: 'The preset you set as a game default in Pit House. ★ marks your own.',
      },
      {
        key: 'triggerExe',
        label: 'Trigger',
        type: 'text',
        placeholder: 'TokyoXtremeRacer.exe',
        help:
          'Executable of that game. A stand-in with this name runs briefly so Pit ' +
          'House applies the preset. Must be a game Pit House already knows — its ' +
          'list is compiled in and cannot be extended.',
      },
    ];
  },

  validate(cfg) {
    const problems = [];
    if (!cfg?.presetId) problems.push('MOZA is enabled but no preset is selected');
    const exeProblem = validateExeName(cfg?.triggerExe);
    if (exeProblem) problems.push(`MOZA trigger: ${exeProblem}`);
    return problems;
  },

  describe(cfg) {
    const preset = findPreset(cfg?.presetId);
    const name = preset?.name ?? cfg?.presetId;
    return name ? `MOZA preset "${name}" via ${cfg?.triggerExe ?? '?'}` : 'MOZA (not configured)';
  },

  async options(deps = {}) {
    return presetOptions(deps);
  },

  async apply(cfg, ctx = {}) {
    const problems = this.validate(cfg);
    if (problems.length) throw new Error(problems[0]);

    if (!resolvePitHouseDir()) {
      throw new Error('MOZA Pit House preset library not found — is Pit House installed?');
    }

    // Pit House must be running to notice the process at all.
    await runStandIn(cfg.triggerExe, { lingerMs: ctx.lingerMs ?? DEFAULT_LINGER_MS, ...ctx });
  },

  async verify(cfg, ctx = {}) {
    const preset = findPreset(cfg?.presetId, ctx);
    const name = preset?.name ?? cfg?.presetId;
    const { lastUsed } = readSelection(ctx);
    const appliedId = Object.values(lastUsed)[0];
    const appliedName = appliedId ? (findPreset(appliedId, ctx)?.name ?? appliedId) : null;

    if (Object.values(lastUsed).includes(cfg?.presetId)) {
      return { status: STATUS.VERIFIED, detail: `Pit House applied "${name}"` };
    }

    // Naming what DID get applied matters here: the usual cause is that the
    // preset is bound to the game but is not that game's default, and Pit House
    // silently applies the default instead.
    return {
      status: STATUS.MISMATCH,
      detail:
        `Pit House applied ${appliedName ? `"${appliedName}"` : 'something else'} ` +
        `instead of "${name}" — in Pit House use "Set as Game Default Preset" ` +
        `for the game behind ${cfg?.triggerExe}; binding alone is not enough`,
    };
  },

  health() {
    if (!resolvePitHouseDir()) {
      return { ok: false, reason: 'MOZA Pit House preset library not found' };
    }
    return { ok: true, reason: `${listAllPresets().length} presets available` };
  },
};
