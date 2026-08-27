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
    const timer = this.#timers.get(ev.action.id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(ev.action.id);
  }

  async onKeyDown(ev) {
    const settings = await streamDeck.settings.getGlobalSettings();
    const profile = findProfile(settings, ev.payload.settings?.profileId);
    if (!profile) return ev.action.showAlert();

    if (!profile.restricted) return this.#switch(ev, profile, settings);

    // Restricted: only a deliberate hold counts.
    this.#timers.set(
      ev.action.id,
      setTimeout(() => {
        this.#timers.delete(ev.action.id);
        this.#switch(ev, profile, settings);
      }, HOLD_MS),
    );
  }

  async onKeyUp(ev) {
    const timer = this.#timers.get(ev.action.id);
    if (timer) {
      // Released before the hold completed — nothing was applied.
      clearTimeout(timer);
      this.#timers.delete(ev.action.id);
      await ev.action.showAlert();
    }
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
