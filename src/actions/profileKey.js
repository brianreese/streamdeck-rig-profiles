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
import { loadAvatarDataUri } from '../avatars.js';
import { handlePiRequest } from '../piBridge.js';

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

/** Avatar bytes, keyed by filename. Cheap to hold, expensive to re-read. */
const avatarCache = new Map();

function findProfile(settings, id) {
  const profile = (settings?.profiles ?? []).find((p) => p.id === id) ?? null;
  if (!profile?.avatar) return profile;

  if (!avatarCache.has(profile.avatar)) {
    avatarCache.set(profile.avatar, loadAvatarDataUri(profile.avatar));
  }
  // A missing file degrades to the initial fallback rather than breaking the key.
  return { ...profile, avatarDataUri: avatarCache.get(profile.avatar) ?? undefined };
}

async function repaintAll(settings) {
  await Promise.all(
    [...visible.values()].map(({ action, profileId }) => {
      const profile = findProfile(settings, profileId);
      // Paint unassigned keys too — leaving the manifest icon in place makes
      // an unconfigured key look identical to a working one.
      if (!profile) return action.setImage(renderProfileKey({ profile: null, active: false }));
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
    streamDeck.logger.info(
      `[profileKey] willAppear key=${ev.action.id} profileId=${JSON.stringify(profileId)} ` +
        `knownProfiles=${(settings?.profiles ?? []).map((p) => p.id).join(',') || 'none'}`,
    );

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
   * Keep the visible-key cache in step with the property inspector.
   *
   * Without this, a key registered at willAppear with no profile keeps that
   * stale binding for the rest of the session: pressing it works (the event
   * payload carries live settings) but every repaint afterwards falls back to
   * the unassigned image.
   */
  async onDidReceiveSettings(ev) {
    const profileId = ev.payload.settings?.profileId;
    visible.set(ev.action.id, { action: ev.action, profileId });
    streamDeck.logger.info(
      `[profileKey] didReceiveSettings key=${ev.action.id} profileId=${JSON.stringify(profileId)}`,
    );
    await repaintAll(await streamDeck.settings.getGlobalSettings());
  }

  /**
   * Property inspector requests: live hardware options, saves, avatars.
   *
   * Replies go through streamDeck.ui, NOT ev.action — the action object has no
   * sendToPropertyInspector. Calling it there threw after the work had already
   * been done, so saves landed but the inspector never heard back and sat
   * waiting forever on a reply that could not arrive.
   */
  async onSendToPlugin(ev) {
    const request = ev.payload?.request;
    // Logged before any await: a later log line cannot distinguish "never
    // arrived" from "arrived and hung part-way through".
    streamDeck.logger.info(
      `[pi] <- ${request} (${JSON.stringify(ev.payload ?? {}).length} bytes)`,
    );
    try {
      const reply = await handlePiRequest(ev.payload, {
        settings: streamDeck.settings,
        logger: streamDeck.logger,
      });
      await streamDeck.ui.sendToPropertyInspector(reply);
      streamDeck.logger.info(`[pi] ${request} -> ${JSON.stringify(reply).slice(0, 200)}`);

      // A save or avatar change alters what the keys should look like.
      if (['saveProfiles', 'uploadAvatar', 'deleteAvatar'].includes(request)) {
        avatarCache.clear();
        await repaintAll(await streamDeck.settings.getGlobalSettings());
      }
    } catch (err) {
      // Never leave the inspector hanging: it awaits a reply per request.
      streamDeck.logger.error(`[pi] ${request} failed: ${err.stack ?? err.message}`);
      await streamDeck.ui
        .sendToPropertyInspector({ request, ok: false, error: err.message })
        .catch(() => {});
    }
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

    // The key event carries live settings; trust them over anything cached.
    visible.set(ev.action.id, { action: ev.action, profileId: ev.payload.settings?.profileId });

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
      const wanted = ev.payload.settings?.profileId;
      const profile = findProfile(settings, wanted);

      streamDeck.logger.info(
        `[profileKey] keyDown key=${ev.action.id} profileId=${JSON.stringify(wanted)} ` +
          `resolved=${profile ? profile.name : 'NONE'} restricted=${profile?.restricted ?? '-'}`,
      );

      if (!profile) {
        this.#clear(ev.action.id);
        streamDeck.logger.warn(
          `[profileKey] this key has no profile assigned — pick one in the property inspector`,
        );
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
    streamDeck.logger.info(
      `[profileKey] keyUp key=${ev.action.id} pending=${Boolean(held)}`,
    );
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
      // Global settings hold credentials (the Govee key) and device
      // allowlists; providers need them alongside their own config slice.
      settings: settings?.settings ?? {},
      log: (m) => streamDeck.logger.info(m),
      // Log every provider as it lands, not just the aggregate. The button
      // shows the worst status, so a failing wheelbase was hiding whether
      // the lights or the pedal did anything at all.
      onResult: (r) =>
        streamDeck.logger.info(
          `[profileKey] ${profile.name} · ${r.label}: ${r.status} — ${r.detail}`,
        ),
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
