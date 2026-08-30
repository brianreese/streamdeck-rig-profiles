// providers/stateFlag.js — set a named flag describing how the rig is set up.
//
// This is the provider that makes a Mode stateful. It sets one flag to one
// value, reports whether that flag currently holds that value, and clears it
// when the Mode is switched off. That is the whole job — the motivating case is
// a "VR Mode" key that other software can notice.
//
// It does not start a runtime, change lighting, or run anything. A Mode that
// should also do those things adds the providers that do them; they ride along
// without a vote in whether the Mode reads as active, because they cannot
// honestly answer that question.
//
// Two flags with the same name are mutually exclusive for free: VR Mode writes
// display=vr, Flatscreen Mode writes display=flatscreen, and whichever ran last
// is the one that reports itself active. No exclusivity rule is needed in the
// plugin, because the state itself can only hold one value.

import { readFlag, writeFlag } from '../rigState.js';
import { STATUS } from './status.js';

/** Flag and value names are shared with other software, so keep them plain. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const clean = (raw) => String(raw ?? '').trim();

export default {
  id: 'state-flag',
  label: 'Rig State Flag',
  // Answers about itself by reading the file back.
  verifiable: true,
  // A profile may set a flag as part of who is driving; a Mode is the obvious
  // home for one. Not a scene concept — scenes merged into Modes.
  contexts: ['profile', 'mode'],

  schema() {
    return [
      {
        key: 'flag',
        label: 'Flag',
        type: 'text',
        placeholder: 'display',
        help: 'The name other software looks for. Two Modes writing the same flag are mutually exclusive, because it can only hold one value at a time.',
      },
      {
        key: 'value',
        label: 'Value',
        type: 'text',
        placeholder: 'vr',
        help: 'What this Mode sets the flag to. A Playnite plugin might read display=vr and launch the VR version of a game.',
      },
    ];
  },

  validate(cfg) {
    const problems = [];
    const flag = clean(cfg?.flag);
    const value = clean(cfg?.value);
    if (!flag) problems.push('state flag needs a name');
    else if (!NAME.test(flag)) problems.push('flag name must be letters, numbers, dashes or underscores');
    if (!value) problems.push('state flag needs a value');
    else if (!NAME.test(value)) problems.push('flag value must be letters, numbers, dashes or underscores');
    return problems;
  },

  describe(cfg) {
    const flag = clean(cfg?.flag);
    const value = clean(cfg?.value);
    return flag && value ? `sets ${flag} = ${value}` : 'flag (not configured)';
  },

  async apply(cfg) {
    const problems = this.validate(cfg);
    if (problems.length) throw new Error(problems[0]);
    writeFlag(clean(cfg.flag), clean(cfg.value));
  },

  /**
   * Reverse: clear the flag rather than setting it to something else.
   *
   * Removing it means no Mode writing this flag reports itself active, which is
   * the honest reading of "switched off". Setting it to some other value would
   * be inventing an opinion this provider does not have.
   */
  async unapply(cfg) {
    const flag = clean(cfg?.flag);
    if (flag) writeFlag(flag, null);
  },

  /**
   * Is this Mode's flag currently set to this Mode's value?
   *
   * Answerable cold, with no preceding apply — which is what a Mode key needs
   * at startup. A missing or unreadable file reads as false rather than as an
   * error: unreadable state is not active state, and pressing the key writes
   * the file and recovers.
   */
  async isActive(cfg) {
    const flag = clean(cfg?.flag);
    const value = clean(cfg?.value);
    if (!flag || !value) return false;
    return readFlag(flag) === value;
  },

  async verify(cfg) {
    const flag = clean(cfg?.flag);
    const value = clean(cfg?.value);
    const seen = readFlag(flag);
    if (seen === value) return { status: STATUS.VERIFIED, detail: `${flag} = ${value}` };
    return {
      status: STATUS.MISMATCH,
      detail: `${flag} reads ${seen === null ? 'nothing' : seen}, wanted ${value}`,
    };
  },
};
