// actions/modeKey.js — "Rig Mode" action.
//
// A Mode is a named bundle of provider configs you switch on with a button. It
// may or may not be able to tell you whether it is currently on: that depends
// entirely on whether any provider inside it can answer, which is not something
// this action decides. One button can set a shared flag, change the lights and
// run a script, and only the flag has a vote in whether the key reads as on.
//
// This is where Scenes ended up. They were a separate concept for exactly one
// release, until it became clear that "is this thing stateful" is a property of
// what is inside it rather than something the entity should assert — the same
// realisation that moved outcome reporting into providers and put contexts on
// them. A Mode with nothing that reports state behaves precisely as a Scene
// did: press it, it runs, it is over.
//
// How it differs from a profile, and why they stay separate:
//
//   * A profile says WHO IS AT THE RIG. It is exclusive, it persists, and it
//     mirrors to a shared file a companion plugin reads to decide what a child
//     may launch. A Mode writes none of that — turning the lights blue must
//     never change who the rig thinks is driving.
//   * A profile can be gated behind a deliberate hold so a stray press cannot
//     reach full force feedback. A Mode has no such gate, which is why it is
//     safe inside a Multi Action and a profile is not.
//
// The hold gesture here means something different from the profile's: a long
// press switches the Mode OFF. It is not a safety gate, so it is shorter, and
// a Mode with nothing reversible ignores it and simply activates.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { applyProfile, readModeState, unapplyMode, summarise } from '../profileSwitch.js';
import { renderModeKey } from '../buttonRenderer.js';
import { notify } from '../notify.js';
import { isProblem, getProvider, isReversible } from '../providers/index.js';
import { loadAvatarDataUri } from '../avatars.js';

export const MANIFEST_ID = 'com.rig.profiles.mode';

/** Long enough to be deliberate, short enough not to feel broken. */
export const OFF_HOLD_MS = 600;

/** Frame interval while a Mode runs, matching the profile key's dots. */
const DOT_MS = 220;

/**
 * How often a Mode key re-reads its own state.
 *
 * Nothing tells us when a flag changes — a script, or the software reading it,
 * may move it at any time. A slow poll is the honest default. A provider with a
 * real push source can do better on its own; that belongs to the provider, not
 * here.
 */
export const POLL_MS = 10_000;

/** Every visible Mode key, so the poll knows what to refresh. */
const visible = new Map(); // action.id -> { action, modeId }
let poll = null;

function findMode(settings, id) {
  const list = settings?.modes ?? settings?.scenes ?? [];
  const mode = list.find((m) => m.id === id) ?? null;
  if (!mode?.avatar) return mode;
  return { ...mode, avatarDataUri: loadAvatarDataUri(mode.avatar) ?? undefined };
}

/** Can a long press do anything to this Mode? */
function canSwitchOff(mode) {
  return Object.keys(mode?.providers ?? {}).some((id) => isReversible(getProvider(id)));
}

export class ModeKey extends SingletonAction {
  manifestId = MANIFEST_ID;
  #holds = new Map();

  async onWillAppear(ev) {
    visible.set(ev.action.id, { action: ev.action, modeId: ev.payload?.settings?.modeId });
    await this.#paint(ev.action, ev.payload?.settings?.modeId);
    this.#startPolling();
  }

  onWillDisappear(ev) {
    visible.delete(ev.action.id);
    this.#clearHold(ev.action.id);
    if (!visible.size && poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  async onDidReceiveSettings(ev) {
    visible.set(ev.action.id, { action: ev.action, modeId: ev.payload?.settings?.modeId });
    await this.#paint(ev.action, ev.payload?.settings?.modeId);
  }

  #startPolling() {
    if (poll) return;
    poll = setInterval(() => {
      // Refreshing a key that is mid-run would fight its own animation.
      for (const { action, modeId } of visible.values()) {
        if (this.#holds.has(action.id)) continue;
        this.#paint(action, modeId).catch(() => {});
      }
    }, POLL_MS);
    poll.unref?.();
  }

  async #paint(action, modeId, { running = false, dotFrame = null } = {}) {
    const settings = await streamDeck.settings.getGlobalSettings();
    const mode = findMode(settings, modeId);
    const active = running || !mode ? null : await readModeState(mode, { settings: settings?.settings ?? {} });
    await action.setImage(renderModeKey({ mode, active, running, dotFrame }));
  }

  #clearHold(id) {
    const held = this.#holds.get(id);
    if (!held) return;
    clearTimeout(held.timer);
    this.#holds.delete(id);
  }

  /**
   * The hold clock starts synchronously, before any await.
   *
   * Fetching global settings is a websocket round trip, and starting the timer
   * after it meant a genuine hold released before the timer had run — the same
   * bug the profile key's gate had, and it reads as a dead key.
   */
  onKeyDown(ev) {
    const held = { fired: false };
    held.timer = setTimeout(() => {
      held.fired = true;
      this.#switchOff(ev).catch((err) =>
        streamDeck.logger.error(`[modeKey] switch off failed: ${err.stack ?? err.message}`),
      );
    }, OFF_HOLD_MS);
    this.#holds.set(ev.action.id, held);
  }

  async onKeyUp(ev) {
    const held = this.#holds.get(ev.action.id);
    // The long press already handled it; releasing must not then switch it on
    // again, which would leave the Mode exactly as it started.
    if (held?.fired) return;
    this.#clearHold(ev.action.id);
    await this.#switchOn(ev);
  }

  async #resolve(ev) {
    const settings = await streamDeck.settings.getGlobalSettings();
    const modeId = ev.payload?.settings?.modeId;
    return { settings, modeId, mode: findMode(settings, modeId) };
  }

  async #switchOff(ev) {
    const { settings, mode } = await this.#resolve(ev);
    if (!mode) return;

    if (!canSwitchOff(mode)) {
      // Nothing in it can be reversed, so a hold has no meaning. Fall through
      // to activating rather than doing nothing, which would read as broken.
      this.#clearHold(ev.action.id);
      await this.#switchOn(ev);
      return;
    }

    streamDeck.logger.info(`[modeKey] switching off ${mode.name}`);
    const outcome = await unapplyMode(mode, {
      settings: settings?.settings ?? {},
      log: (m) => streamDeck.logger.info(m),
    });

    if (isProblem(outcome.status)) {
      await ev.action.showAlert();
      const why = summarise(outcome);
      streamDeck.logger.warn(`[modeKey] ${mode.name}: ${why}`);
      notify(`${mode.name} — could not switch off`, why, { logger: streamDeck.logger });
    } else {
      await ev.action.showOk();
    }
    this.#clearHold(ev.action.id);
    await this.#paint(ev.action, mode.id);
  }

  async #switchOn(ev) {
    const { settings, modeId, mode } = await this.#resolve(ev);
    streamDeck.logger.info(
      `[modeKey] keyUp key=${ev.action.id} modeId=${JSON.stringify(modeId)} ` +
        `resolved=${mode ? mode.name : 'NONE'}`,
    );

    if (!mode) {
      // An unassigned key that silently does nothing is how a dropdown left on
      // its placeholder went unnoticed until someone pressed it.
      await ev.action.showAlert();
      return;
    }

    let frame = 0;
    const dots = setInterval(() => {
      frame += 1;
      this.#paint(ev.action, mode.id, { running: true, dotFrame: frame }).catch(() => {});
    }, DOT_MS);
    await this.#paint(ev.action, mode.id, { running: true, dotFrame: 0 });

    let outcome;
    try {
      outcome = await applyProfile(mode, {
        settings: settings?.settings ?? {},
        // Declares which half of the plugin this is, so a provider that only
        // offers itself to profiles cannot be reached through a Mode even if a
        // hand-edited config names it.
        context: 'mode',
        log: (m) => streamDeck.logger.info(m),
        onResult: (r) =>
          streamDeck.logger.info(`[modeKey] ${mode.name} · ${r.label}: ${r.status} — ${r.detail}`),
      });
    } catch (err) {
      // applyProfile does not normally throw, but a Mode must never take the
      // plugin down or leave its key spinning.
      streamDeck.logger.error(`[modeKey] ${mode.name} failed: ${err.stack ?? err.message}`);
      outcome = { status: 'failed', results: [], error: err.message };
    } finally {
      clearInterval(dots);
    }

    const why = outcome.error ?? summarise(outcome);
    if (isProblem(outcome.status)) {
      await ev.action.showAlert();
      streamDeck.logger.warn(`[modeKey] ${mode.name}: ${why}`);
      notify(`${mode.name} — mode failed`, why, { logger: streamDeck.logger });
    } else {
      await ev.action.showOk();
      streamDeck.logger.info(`[modeKey] ${mode.name}: ${why}`);
    }

    // Deliberately no profile state written and no profile key repainted: a
    // Mode has no bearing on who is at the rig, and saying otherwise would
    // corrupt the one thing the shared profile file means.
    await this.#paint(ev.action, mode.id);
  }
}

export function _resetForTesting() {
  visible.clear();
  if (poll) clearInterval(poll);
  poll = null;
}
