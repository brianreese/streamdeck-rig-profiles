// providers/stateFlag.js — set named boolean flags describing the rig's setup.
//
// This is the provider that makes a Mode stateful. It turns one or more named
// flags on, reports whether they are all on, and turns them off again when the
// Mode is switched off. The motivating case is a "VR Mode" key that other
// software can notice.
//
// Flags are BOOLEAN, and the value is not configurable. An earlier version let
// you set a flag to an arbitrary string — display=vr — which read well until
// you tried to switch it off: there was no answer to what it should become.
// Restoring the previous value would mean remembering it, and it may have
// changed meanwhile. A boolean has an unambiguous off.
//
// One flag per instance, and a Mode may hold several instances. A list on a
// single instance was tried first and could not express the obvious case: one
// switch that turns one flag on and another off, since the invert applies to
// the instance rather than to each name. Instances also mix and match later
// without the config shape changing again.
//
// It does not start a runtime, change lighting, or run anything. A Mode that
// should also do those things adds the providers that do them; they ride along
// without a vote in whether the Mode reads as active, because they cannot
// honestly answer that question.

import { readFlag, writeFlag } from '../rigState.js';
import { STATUS } from './status.js';

/** Flag names are shared with other software, so keep them plain. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const clean = (raw) => String(raw ?? '').trim();

export default {
  id: 'state-flag',
  label: 'Rig State Flag',
  // Answers about itself by reading the flags back.
  verifiable: true,
  contexts: ['profile', 'mode'],
  // A Mode routinely asserts more than one fact, and they may point in
  // different directions.
  repeatable: true,

  schema() {
    return [
      {
        key: 'flag',
        label: 'Flag',
        type: 'text',
        placeholder: 'vr',
        help: 'The name other software looks for. Add this provider again for a second flag — a Mode can assert several, pointing different ways.',
      },
      {
        key: 'whenOff',
        label: 'Active when off',
        type: 'boolean',
        help: 'Invert it: this Mode asserts the flags are OFF, and reads as active when they are. Use it for a "Flatscreen" key sitting next to a "VR" one.',
      },
    ];
  },

  validate(cfg) {
    const flag = clean(cfg?.flag);
    if (!flag) return ['state flag needs a name'];
    return NAME.test(flag) ? [] : ['flag name must be letters, numbers, dashes or underscores'];
  },

  describe(cfg) {
    const flag = clean(cfg?.flag);
    if (!flag) return 'flag (not configured)';
    return `${cfg?.whenOff ? 'clears' : 'sets'} ${flag}`;
  },

  async apply(cfg) {
    const problems = this.validate(cfg);
    if (problems.length) throw new Error(problems[0]);
    writeFlag(clean(cfg.flag), !cfg?.whenOff);
  },

  /**
   * Reverse: set the flags to the opposite of what this Mode asserts.
   *
   * Unambiguous precisely because the value is boolean. This is what the
   * configurable-value version could not answer.
   */
  async unapply(cfg) {
    const flag = clean(cfg?.flag);
    if (flag) writeFlag(flag, Boolean(cfg?.whenOff));
  },

  /**
   * Are all of this Mode's flags in the state it asserts?
   *
   * Answerable cold, with no preceding apply — which is what a Mode key needs
   * at startup. A missing flag reads as false rather than as an error:
   * unreadable state is not active state, and pressing the key writes it and
   * recovers.
   */
  async isActive(cfg) {
    const flag = clean(cfg?.flag);
    if (!flag) return false;
    return (readFlag(flag) === true) === !cfg?.whenOff;
  },

  async verify(cfg) {
    const flag = clean(cfg?.flag);
    const want = !cfg?.whenOff;
    const landed = (readFlag(flag) === true) === want;
    return landed
      ? { status: STATUS.VERIFIED, detail: `${flag} ${want ? 'on' : 'off'}` }
      : { status: STATUS.MISMATCH, detail: `${flag} did not go ${want ? 'on' : 'off'}` };
  },
};
