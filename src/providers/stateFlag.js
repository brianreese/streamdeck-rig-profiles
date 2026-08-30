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
// More than one flag per Mode is allowed, because one switch legitimately
// changes several facts at once, and the editor deliberately does not let a
// provider be added to a Mode twice.
//
// It does not start a runtime, change lighting, or run anything. A Mode that
// should also do those things adds the providers that do them; they ride along
// without a vote in whether the Mode reads as active, because they cannot
// honestly answer that question.

import { readFlag, writeFlag } from '../rigState.js';
import { STATUS } from './status.js';

/** Flag names are shared with other software, so keep them plain. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** One per line, blanks and duplicates dropped. */
export function parseFlags(raw) {
  const seen = new Set();
  for (const line of String(raw ?? '').split(/[\n,]/)) {
    const name = line.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

export default {
  id: 'state-flag',
  label: 'Rig State Flag',
  // Answers about itself by reading the flags back.
  verifiable: true,
  contexts: ['profile', 'mode'],

  schema() {
    return [
      {
        key: 'flags',
        label: 'Flags',
        type: 'textarea',
        placeholder: 'vr',
        help: 'One flag name per line. Switching this Mode on sets them all; switching it off clears them. Other software reads these — a Playnite plugin might check "vr" to launch the VR version of a game.',
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
    const flags = parseFlags(cfg?.flags);
    if (!flags.length) return ['state flag needs at least one flag name'];
    const bad = flags.filter((f) => !NAME.test(f));
    return bad.length
      ? [`flag name must be letters, numbers, dashes or underscores: ${bad.join(', ')}`]
      : [];
  },

  describe(cfg) {
    const flags = parseFlags(cfg?.flags);
    if (!flags.length) return 'flags (not configured)';
    return `${cfg?.whenOff ? 'clears' : 'sets'} ${flags.join(', ')}`;
  },

  async apply(cfg) {
    const problems = this.validate(cfg);
    if (problems.length) throw new Error(problems[0]);
    const value = !cfg?.whenOff;
    for (const flag of parseFlags(cfg.flags)) writeFlag(flag, value);
  },

  /**
   * Reverse: set the flags to the opposite of what this Mode asserts.
   *
   * Unambiguous precisely because the value is boolean. This is what the
   * configurable-value version could not answer.
   */
  async unapply(cfg) {
    const value = Boolean(cfg?.whenOff);
    for (const flag of parseFlags(cfg?.flags)) writeFlag(flag, value);
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
    const flags = parseFlags(cfg?.flags);
    if (!flags.length) return false;
    const want = !cfg?.whenOff;
    return flags.every((flag) => (readFlag(flag) === true) === want);
  },

  async verify(cfg) {
    const flags = parseFlags(cfg?.flags);
    const want = !cfg?.whenOff;
    const wrong = flags.filter((flag) => (readFlag(flag) === true) !== want);
    if (!wrong.length) {
      return { status: STATUS.VERIFIED, detail: `${flags.join(', ')} ${want ? 'on' : 'off'}` };
    }
    return { status: STATUS.MISMATCH, detail: `${wrong.join(', ')} did not go ${want ? 'on' : 'off'}` };
  },
};
