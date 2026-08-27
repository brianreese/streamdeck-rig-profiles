// actions/profileKey.js — "Rig Profile" direct action.
//
// One key bound to one profile. Press it and you get that profile; there is no
// cycling to overshoot and no current state to read first. Three keys side by
// side, one lit, is legible to someone who cannot read the labels.
//
// Restricted profiles (yours, at full torque) require a deliberate hold rather
// than a tap, so the dangerous direction cannot be reached by a stray press.
//
// Note: no `@action` decorator. The SDK's decorator does nothing but set a
// `manifestId` field, and V8 has no native decorator support — using a plain
// class field keeps this buildless, which is how the rest of the plugin runs.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { applyProfile, summarise } from '../profileSwitch.js';
import { renderProfileKey } from '../buttonRenderer.js';
import { STATUS } from '../providers/index.js';
import { readState, writeState } from '../state.js';

export const MANIFEST_ID = 'com.rig.profiles.key';
export const HOLD_MS = 1000;

/**
 * Every visible key, so they all repaint together when the active profile
 * changes — pressing "Kai" must visibly extinguish "Brian".
 */
const visible = new Map(); // action.id -> { action, profileId }

let activeProfileId = null;
let activeStatus = STATUS.SKIPPED;
let hydrated = false;

function findProfile(settings, id) {
  return (settings?.profiles ?? []).find((p) => p.id === id) ?? null;
}

async function repaintAll(settings) {
  await Promise.all(
    [...visible.values()].map(({ action, profileId }) => {
      const profile = findProfile(settings, profileId);
      if (!profile) return Promise.resolve();
      return action.setImage(
        renderProfileKey({
          profile,
          active: profile.id === activeProfileId,
          status: activeStatus,
          unknown: activeProfileId === null,
        }),
      );
    }),
  );
}

export class ProfileKey extends SingletonAction {
  manifestId = MANIFEST_ID;
  #timers = new Map();

  async onWillAppear(ev) {
    const settings = await streamDeck.settings.getGlobalSettings();
    const profileId = ev.payload.settings?.profileId;
    visible.set(ev.action.id, { action: ev.action, profileId });

    if (!hydrated) {
      hydrated = true;
      // Restore the last known profile so the deck is not blank after a
      // restart — but mark it unverified, because we have not talked to the
      // hardware yet this run and must not imply that we have.
      activeProfileId = readState()?.activeProfile ?? null;
      activeStatus = activeProfileId ? STATUS.APPLIED_UNVERIFIED : STATUS.SKIPPED;
    }
    await repaintAll(settings);
  }

  onWillDisappear(ev) {
    visible.delete(ev.action.id);
    this.#clear(ev.action.id);
  }

  /**
   * Note the ordering here: the hold clock starts SYNCHRONOUSLY, before any
   * await. Fetching global settings is a websocket round-trip, and starting
   * the timer after it meant a genuine one-second hold released before the
   * timer had run its course — the key looked dead.
   */
  onKeyDown(ev) {
    const held = { cancelled: false };
    this.#timers.set(ev.action.id, held);

    const startedAt = Date.now();
    const settingsPromise = streamDeck.settings.getGlobalSettings();

    // Paint the hold filling up so the gate reads as deliberate, not broken.
    held.tick = setInterval(async () => {
      if (held.cancelled) return;
      const profile = findProfile(await settingsPromise, ev.payload.settings?.profileId);
      if (!profile) return;
      const progress = Math.min(1, (Date.now() - startedAt) / HOLD_MS);
      await ev.action.setImage(renderProfileKey({ profile, active: false, holdProgress: progress }));
    }, 100);

    (async () => {
      const settings = await settingsPromise;
      const profile = findProfile(settings, ev.payload.settings?.profileId);

      if (!profile) {
        this.#clear(ev.action.id);
        return ev.action.showAlert();
      }

      if (!profile.restricted) {
        this.#clear(ev.action.id);
        return this.#switch(ev, profile, settings);
      }

      const remaining = Math.max(0, HOLD_MS - (Date.now() - startedAt));
      held.timer = setTimeout(() => {
        if (held.cancelled) return;
        this.#clear(ev.action.id);
        this.#switch(ev, profile, settings);
      }, remaining);
    })();
  }

  async onKeyUp(ev) {
    const held = this.#timers.get(ev.action.id);
    if (!held) return; // already fired
    // Released before the hold completed — nothing was applied.
    this.#clear(ev.action.id);
    await ev.action.showAlert();

    const settings = await streamDeck.settings.getGlobalSettings();
    await repaintAll(settings);
  }

  #clear(id) {
    const held = this.#timers.get(id);
    if (!held) return;
    held.cancelled = true;
    clearInterval(held.tick);
    clearTimeout(held.timer);
    this.#timers.delete(id);
  }

  async #switch(ev, profile, settings) {
    activeProfileId = profile.id;
    activeStatus = STATUS.APPLIED_UNVERIFIED;
    await ev.action.setImage(renderProfileKey({ profile, active: true, switching: true }));

    const outcome = await applyProfile(profile, {
      log: (m) => streamDeck.logger.info(m),
    });

    activeStatus = outcome.status;
    writeState(profile.id);

    if (outcome.status === STATUS.VERIFIED) {
      await ev.action.showOk();
    } else {
      await ev.action.showAlert();
      streamDeck.logger.warn(`[profileKey] ${profile.name}: ${summarise(outcome)}`);
    }
    await repaintAll(settings);
  }
}

export function _resetForTesting() {
  visible.clear();
  activeProfileId = null;
  activeStatus = STATUS.SKIPPED;
  hydrated = false;
}
